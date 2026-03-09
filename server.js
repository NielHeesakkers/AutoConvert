const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const cron = require('node-cron');

const DOCKER = process.env.DOCKER === 'true';
const APP_DIR = DOCKER ? '/app' : __dirname;

const app = express();
app.use(express.json());
app.use(express.static(path.join(APP_DIR, 'public')));

const CONFIG_PATH = DOCKER
  ? '/app/config/config.json'
  : path.join(__dirname, 'config.json');
const SCRIPT_PATH = path.join(APP_DIR, 'scripts', 'daily_mkv_convert.sh');
const LOG_DIR = DOCKER ? '/app/logs' : path.join(__dirname);
const LOG_PATH = path.join(LOG_DIR, 'daily_convert.log');
const LOCK_FILE = '/tmp/daily_mkv_convert.lock';
const MSMTP_BIN = DOCKER ? '/usr/bin/msmtp' : '/opt/homebrew/bin/msmtp';
const MSMTPRC_PATH = DOCKER ? '/root/.msmtprc' : path.join(process.env.HOME, '.msmtprc');

// macOS-only
const PLIST_PATH = '/Users/server/Library/LaunchAgents/com.niel.daily-mkv-convert.plist';

// --- Cron scheduler (Docker mode) ---
let cronJob = null;

function setupCron() {
  if (!DOCKER) return;
  const config = readConfig();
  const hour = config.schedule?.hour ?? 3;
  const minute = config.schedule?.minute ?? 0;
  if (cronJob) cronJob.stop();
  cronJob = cron.schedule(`${minute} ${hour} * * *`, () => {
    console.log(`[cron] Conversie gestart om ${new Date().toISOString()}`);
    runConvertScript();
  });
  console.log(`[cron] Gepland op ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`);
}

function runConvertScript() {
  const env = {
    ...process.env,
    APP_DIR,
    CONFIG_FILE: CONFIG_PATH,
    LOG_DIR,
    PATH: '/usr/local/bin:/usr/bin:/bin',
  };
  const child = spawn('/bin/bash', [SCRIPT_PATH], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  return child.pid;
}

// --- Helpers ---

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function writeMsmtprc(smtp) {
  const lines = [
    'account default',
    `host ${smtp.host}`,
    `port ${smtp.port}`,
    'auth on',
    `user ${smtp.user}`,
    `password ${smtp.password}`,
    `tls ${smtp.tls ? 'on' : 'off'}`,
    `tls_starttls ${smtp.starttls ? 'on' : 'off'}`,
    `from ${smtp.from}`,
    '',
  ];
  fs.writeFileSync(MSMTPRC_PATH, lines.join('\n'), { mode: 0o600 });
}

function isRunning() {
  if (!fs.existsSync(LOCK_FILE)) return false;
  try {
    const pid = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

// Ensure log file exists
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
if (!fs.existsSync(LOG_PATH)) {
  fs.writeFileSync(LOG_PATH, '');
}

// Write msmtprc from config on startup
try {
  const config = readConfig();
  if (config.smtp) writeMsmtprc(config.smtp);
} catch {}

// --- API Routes ---

// Status
app.get('/api/status', (req, res) => {
  const running = isRunning();
  let lastLine = '';
  try {
    const log = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = log.trim().split('\n').filter(l => l.trim());
    lastLine = lines[lines.length - 1] || '';
  } catch {}
  res.json({ running, lastLine });
});

// Recipients
app.get('/api/recipients', (req, res) => {
  const config = readConfig();
  res.json({ recipients: config.recipients });
});

app.post('/api/recipients', (req, res) => {
  const { recipients } = req.body;
  if (!Array.isArray(recipients)) {
    return res.status(400).json({ error: 'recipients must be an array' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const r of recipients) {
    if (!r.email || !emailRegex.test(r.email)) {
      return res.status(400).json({ error: `Ongeldig e-mailadres: ${r.email}` });
    }
  }
  const config = readConfig();
  config.recipients = recipients;
  writeConfig(config);
  res.json({ ok: true, recipients });
});

// Toggle recipient active/inactive
app.post('/api/recipients/toggle', (req, res) => {
  const { email } = req.body;
  const config = readConfig();
  const recipient = config.recipients.find(r => r.email === email);
  if (!recipient) {
    return res.status(404).json({ error: 'Ontvanger niet gevonden' });
  }
  recipient.active = !recipient.active;
  writeConfig(config);
  res.json({ ok: true, email, active: recipient.active });
});

// SMTP settings
app.get('/api/smtp', (req, res) => {
  const config = readConfig();
  const smtp = config.smtp || {};
  res.json({
    host: smtp.host || '',
    port: smtp.port || 587,
    user: smtp.user || '',
    password: smtp.password ? '••••••••' : '',
    hasPassword: !!smtp.password,
    from: smtp.from || '',
    tls: smtp.tls !== false,
    starttls: smtp.starttls !== false,
  });
});

app.post('/api/smtp', (req, res) => {
  const { host, port, user, password, from, tls, starttls } = req.body;
  if (!host || !user || !from) {
    return res.status(400).json({ error: 'Host, gebruiker en afzender zijn verplicht' });
  }
  const p = parseInt(port, 10);
  if (isNaN(p) || p < 1 || p > 65535) {
    return res.status(400).json({ error: 'Ongeldige poort' });
  }
  const config = readConfig();
  const prev = config.smtp || {};
  config.smtp = {
    host, port: p, user,
    password: (password && password !== '••••••••') ? password : prev.password || '',
    from, tls: tls !== false, starttls: starttls !== false,
  };
  writeConfig(config);
  writeMsmtprc(config.smtp);
  res.json({ ok: true });
});

// Send test email
app.post('/api/test-email', (req, res) => {
  const { email } = req.body;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ error: 'Ongeldig e-mailadres' });
  }
  const config = readConfig();
  const from = (config.smtp && config.smtp.from) || 'noreply@autoconvert.local';
  const now = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });
  const mailContent = [
    'Content-Type: text/html; charset=utf-8',
    `Subject: AutoConvert Test - ${now}`,
    `From: ${from}`,
    `To: ${email}`,
    '',
    '<html><body style="font-family:-apple-system,Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">',
    '<div style="background:#fff;border-radius:12px;padding:30px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">',
    '<h2 style="color:#6366f1;margin:0 0 10px;">AutoConvert Test</h2>',
    `<p>Dit is een testmail verstuurd op <strong>${now}</strong>.</p>`,
    '<p style="color:#888;">Als je deze mail ontvangt, werkt de e-mailconfiguratie correct.</p>',
    '</div></body></html>',
  ].join('\n');

  const child = spawn(MSMTP_BIN, [email], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  child.stdin.write(mailContent);
  child.stdin.end();
  child.on('close', code => {
    if (code === 0) {
      res.json({ ok: true });
    } else {
      res.status(500).json({ error: stderr.trim() || 'msmtp fout' });
    }
  });
});

// Schedule
app.get('/api/schedule', (req, res) => {
  if (DOCKER) {
    const config = readConfig();
    res.json({ hour: config.schedule?.hour ?? 3, minute: config.schedule?.minute ?? 0 });
  } else {
    try {
      const plist = require('plist');
      const xml = fs.readFileSync(PLIST_PATH, 'utf8');
      const parsed = plist.parse(xml);
      const interval = parsed.StartCalendarInterval || {};
      res.json({ hour: interval.Hour || 0, minute: interval.Minute || 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.post('/api/schedule', (req, res) => {
  const { hour, minute } = req.body;
  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59) {
    return res.status(400).json({ error: 'Ongeldige tijd' });
  }
  if (DOCKER) {
    const config = readConfig();
    config.schedule = { hour: h, minute: m };
    writeConfig(config);
    setupCron();
    res.json({ ok: true, hour: h, minute: m });
  } else {
    try {
      const plist = require('plist');
      const xml = fs.readFileSync(PLIST_PATH, 'utf8');
      const parsed = plist.parse(xml);
      parsed.StartCalendarInterval = { Hour: h, Minute: m };
      fs.writeFileSync(PLIST_PATH, plist.build(parsed));
      try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch {}
      execSync(`launchctl load "${PLIST_PATH}"`);
      res.json({ ok: true, hour: h, minute: m });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

// Force convert
app.post('/api/convert', (req, res) => {
  if (isRunning()) {
    return res.status(409).json({ error: 'Conversie draait al' });
  }
  if (DOCKER) {
    const pid = runConvertScript();
    res.json({ started: true, pid });
  } else {
    const child = spawn('/bin/bash', [
      '/Users/server/Scripts/daily_mkv_convert.sh',
    ], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
    });
    child.unref();
    res.json({ started: true, pid: child.pid });
  }
});

// Stop convert
app.post('/api/convert/stop', (req, res) => {
  if (!isRunning()) {
    return res.status(404).json({ error: 'Geen conversie actief' });
  }
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    process.kill(-pid, 'SIGTERM');
    res.json({ stopped: true });
  } catch (err) {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      process.kill(pid, 'SIGTERM');
      res.json({ stopped: true });
    } catch (err2) {
      res.status(500).json({ error: err2.message });
    }
  }
});

// Log history
app.get('/api/logs/history', (req, res) => {
  try {
    const log = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = log.split('\n');
    const last = lines.slice(-100).join('\n');
    res.type('text/plain').send(last);
  } catch {
    res.type('text/plain').send('Geen log beschikbaar.');
  }
});

// SSE log stream
app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(':\n\n');

  let fileSize = 0;
  try { fileSize = fs.statSync(LOG_PATH).size; } catch {}

  const sendNew = () => {
    try {
      const newSize = fs.statSync(LOG_PATH).size;
      if (newSize > fileSize) {
        const stream = fs.createReadStream(LOG_PATH, { start: fileSize, encoding: 'utf8' });
        let data = '';
        stream.on('data', chunk => { data += chunk; });
        stream.on('end', () => {
          if (data) res.write(`data: ${JSON.stringify(data)}\n\n`);
          fileSize = newSize;
        });
      } else if (newSize < fileSize) {
        fileSize = 0;
      }
    } catch {}
  };

  let watcher;
  try { watcher = fs.watch(LOG_PATH, () => sendNew()); } catch {}
  const interval = setInterval(sendNew, 3000);

  req.on('close', () => {
    if (watcher) watcher.close();
    clearInterval(interval);
  });
});

// --- Start ---
const PORT = process.env.PORT || 3742;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AutoConvert draait op http://localhost:${PORT}`);
  if (DOCKER) setupCron();
});
