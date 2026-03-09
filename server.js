const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const cron = require('node-cron');

const DOCKER = process.env.DOCKER === 'true';
const APP_DIR = DOCKER ? '/app' : __dirname;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(APP_DIR, 'public')));

const CONFIG_PATH = DOCKER
  ? '/app/config/config.json'
  : path.join(__dirname, 'config.json');
const SCRIPT_PATH = path.join(APP_DIR, 'scripts', 'daily_mkv_convert.sh');
const LOG_DIR = DOCKER ? '/app/logs' : path.join(__dirname);
const LOG_PATH = path.join(LOG_DIR, 'daily_convert.log');
const REPORTS_DIR = path.join(LOG_DIR, 'reports');
const PRESET_DIR = DOCKER ? '/app/config' : path.join(__dirname, 'scripts');
const PRESET_FILE = path.join(PRESET_DIR, 'Niel.json');
const LOCK_FILE = '/tmp/daily_mkv_convert.lock';
const PROGRESS_FILE = '/tmp/mkv_convert_progress.json';
const HB_LOG_FILE = '/tmp/mkv_convert_hb.log';
const MSMTP_BIN = DOCKER ? '/usr/bin/msmtp' : '/opt/homebrew/bin/msmtp';
const MSMTPRC_PATH = DOCKER ? '/root/.msmtprc' : path.join(process.env.HOME, '.msmtprc');
const MEDIA_MOVIES = process.env.MEDIA_MOVIES || (DOCKER ? '/media/movies' : '/Volumes/Media/movies');
const MEDIA_SERIES = process.env.MEDIA_SERIES || (DOCKER ? '/media/series' : '/Volumes/Media/series');
const BACKUP_DIR = DOCKER ? '/backup' : path.join(__dirname, 'backups');
const VERSION_FILE = path.join(APP_DIR, 'version.json');

// macOS-only
const PLIST_PATH = '/Users/server/Library/LaunchAgents/com.niel.daily-mkv-convert.plist';

// --- Cron scheduler (Docker mode) ---
let cronJob = null;
let scanJob = null;

function setupCron() {
  if (!DOCKER) return;
  const config = readConfig();
  const hour = config.schedule?.hour ?? 3;
  const minute = config.schedule?.minute ?? 0;
  if (cronJob) cronJob.stop();
  cronJob = cron.schedule(`${minute} ${hour} * * *`, () => {
    console.log(`[cron] Conversion started at ${new Date().toISOString()}`);
    runConvertScript();
  });
  console.log(`[cron] Scheduled at ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`);

  // Scan interval cron
  setupScanCron(config);
}

function setupScanCron(config) {
  if (!DOCKER) return;
  if (scanJob) scanJob.stop();
  const interval = config.schedule?.scanInterval || 0; // in minutes, 0 = disabled
  if (interval > 0) {
    scanJob = cron.schedule(`*/${interval} * * * *`, () => {
      if (!isRunning()) {
        console.log(`[scan] Auto-conversion triggered by scan interval`);
        runConvertScript();
      }
    });
    console.log(`[scan] Scan interval: every ${interval} minutes`);
  }
}

function runConvertScript() {
  const env = {
    ...process.env,
    APP_DIR,
    CONFIG_FILE: CONFIG_PATH,
    PRESET_FILE,
    LOG_DIR,
    REPORTS_DIR,
    MEDIA_MOVIES,
    MEDIA_SERIES,
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

const DEFAULT_CONFIG = {
  recipients: [],
  smtp: { host: '', port: 587, user: '', password: '', from: '', tls: true, starttls: true },
  schedule: { hour: 3, minute: 0, scanInterval: 0 },
};

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }
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

// Ensure directories exist
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(REPORTS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch {}
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

// Conversion progress
app.get('/api/convert/progress', (req, res) => {
  if (!isRunning()) {
    return res.json({ status: 'idle' });
  }
  let progress = { status: 'running' };
  try {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {}

  // Parse HandBrake progress from log
  try {
    const buf = Buffer.alloc(4096);
    const fd = fs.openSync(HB_LOG_FILE, 'r');
    const stat = fs.fstatSync(fd);
    const readStart = Math.max(0, stat.size - 4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, readStart);
    fs.closeSync(fd);
    const tail = buf.toString('utf8', 0, bytesRead);
    const parts = tail.split(/[\r\n]/);
    for (let i = parts.length - 1; i >= 0; i--) {
      const match = parts[i].match(/Encoding:.*?(\d+\.\d+)\s*%/);
      if (match) {
        progress.hb_progress = parseFloat(match[1]);
        const etaMatch = parts[i].match(/ETA\s+(\d+h\d+m\d+s)/);
        if (etaMatch) progress.hb_eta = etaMatch[1];
        break;
      }
    }
  } catch {}

  res.json(progress);
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
      return res.status(400).json({ error: `Invalid email address: ${r.email}` });
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
    return res.status(404).json({ error: 'Recipient not found' });
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
    return res.status(400).json({ error: 'Host, username, and sender are required' });
  }
  const p = parseInt(port, 10);
  if (isNaN(p) || p < 1 || p > 65535) {
    return res.status(400).json({ error: 'Invalid port' });
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
    return res.status(400).json({ error: 'Invalid email address' });
  }
  const config = readConfig();
  const from = (config.smtp && config.smtp.from) || 'noreply@autoconvert.local';
  const now = new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' });
  const mailContent = [
    'Content-Type: text/html; charset=utf-8',
    `Subject: AutoConvert Test - ${now}`,
    `From: ${from}`,
    `To: ${email}`,
    '',
    '<html><body style="font-family:-apple-system,Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">',
    '<div style="background:#fff;border-radius:12px;padding:30px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">',
    '<h2 style="color:#6366f1;margin:0 0 10px;">AutoConvert Test</h2>',
    `<p>This is a test email sent on <strong>${now}</strong>.</p>`,
    '<p style="color:#888;">If you receive this email, the email configuration is working correctly.</p>',
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
      res.status(500).json({ error: stderr.trim() || 'msmtp error' });
    }
  });
});

// Schedule
app.get('/api/schedule', (req, res) => {
  if (DOCKER) {
    const config = readConfig();
    res.json({
      hour: config.schedule?.hour ?? 3,
      minute: config.schedule?.minute ?? 0,
      scanInterval: config.schedule?.scanInterval ?? 0,
    });
  } else {
    try {
      const plist = require('plist');
      const xml = fs.readFileSync(PLIST_PATH, 'utf8');
      const parsed = plist.parse(xml);
      const interval = parsed.StartCalendarInterval || {};
      const config = readConfig();
      res.json({
        hour: interval.Hour || 0,
        minute: interval.Minute || 0,
        scanInterval: config.schedule?.scanInterval ?? 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.post('/api/schedule', (req, res) => {
  const { hour, minute, scanInterval } = req.body;
  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  const si = parseInt(scanInterval, 10) || 0;
  if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59) {
    return res.status(400).json({ error: 'Invalid time' });
  }
  if (DOCKER) {
    const config = readConfig();
    config.schedule = { hour: h, minute: m, scanInterval: si };
    writeConfig(config);
    setupCron();
    res.json({ ok: true, hour: h, minute: m, scanInterval: si });
  } else {
    try {
      const plist = require('plist');
      const xml = fs.readFileSync(PLIST_PATH, 'utf8');
      const parsed = plist.parse(xml);
      parsed.StartCalendarInterval = { Hour: h, Minute: m };
      fs.writeFileSync(PLIST_PATH, plist.build(parsed));
      try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch {}
      execSync(`launchctl load "${PLIST_PATH}"`);
      // Save scan interval in config
      const config = readConfig();
      if (!config.schedule) config.schedule = {};
      config.schedule.scanInterval = si;
      writeConfig(config);
      res.json({ ok: true, hour: h, minute: m, scanInterval: si });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

// Force convert
app.post('/api/convert', (req, res) => {
  if (isRunning()) {
    return res.status(409).json({ error: 'Conversion already running' });
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
    return res.status(404).json({ error: 'No conversion active' });
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

// Reports (JSON)
app.get('/api/reports', (req, res) => {
  try {
    let files = [];
    try {
      files = fs.readdirSync(REPORTS_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();
    } catch {}

    const total = files.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
    const page = files.slice(offset, offset + limit);

    const reports = page.map(f => {
      try {
        const content = fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8');
        return { filename: f, ...JSON.parse(content) };
      } catch {
        return { filename: f, error: 'Could not read report' };
      }
    });

    res.json({ total, offset, limit, reports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reports/:filename', (req, res) => {
  const { filename } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filepath = path.join(REPORTS_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    fs.unlinkSync(filepath);
    res.json({ ok: true, deleted: filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all reports + log
app.delete('/api/logs', (req, res) => {
  try {
    fs.writeFileSync(LOG_PATH, '');
    try {
      const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        fs.unlinkSync(path.join(REPORTS_DIR, f));
      }
    } catch {}
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Directories
app.get('/api/directories', (req, res) => {
  const basePaths = [MEDIA_MOVIES, MEDIA_SERIES];

  const directories = basePaths.map(dirPath => {
    const exists = fs.existsSync(dirPath);
    let files = [];
    if (exists) {
      try {
        const findMkv = (dir, rel) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              findMkv(full, relPath);
            } else if (entry.isFile() && entry.name.endsWith('.mkv')) {
              try {
                const stat = fs.statSync(full);
                files.push({
                  name: entry.name,
                  path: relPath,
                  size: stat.size,
                  modified: stat.mtime,
                });
              } catch {}
            }
          }
        };
        findMkv(dirPath, '');
      } catch {}
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      path: dirPath,
      name: path.basename(dirPath),
      exists,
      fileCount: files.length,
      files,
    };
  });

  res.json({ directories });
});

// Preset info
app.get('/api/preset', (req, res) => {
  try {
    const content = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8'));
    const presets = content.PresetList || [];
    const name = presets[0]?.PresetName || 'Unknown';
    const desc = presets[0]?.PresetDescription || '';
    const stat = fs.statSync(PRESET_FILE);
    res.json({
      name,
      description: desc,
      filename: path.basename(PRESET_FILE),
      size: stat.size,
      modified: stat.mtime,
    });
  } catch (err) {
    res.json({ name: 'No preset', filename: '', error: err.message });
  }
});

// Upload preset
app.post('/api/preset', express.raw({ type: 'application/json', limit: '5mb' }), (req, res) => {
  try {
    const content = JSON.parse(req.body.toString());
    if (!content.PresetList || !Array.isArray(content.PresetList)) {
      return res.status(400).json({ error: 'Invalid HandBrake preset file (no PresetList found)' });
    }
    const presetName = content.PresetList[0]?.PresetName || 'Unknown';
    if (fs.existsSync(PRESET_FILE)) {
      fs.copyFileSync(PRESET_FILE, PRESET_FILE + '.bak');
    }
    fs.writeFileSync(PRESET_FILE, JSON.stringify(content, null, 2));
    res.json({ ok: true, name: presetName });
  } catch (err) {
    res.status(400).json({ error: 'Invalid JSON file: ' + err.message });
  }
});

// Download current preset
app.get('/api/preset/download', (req, res) => {
  if (!fs.existsSync(PRESET_FILE)) {
    return res.status(404).json({ error: 'No preset available' });
  }
  res.download(PRESET_FILE, 'Niel.json');
});

// --- Backup ---
app.get('/api/backups', (req, res) => {
  try {
    let files = [];
    try {
      files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();
    } catch {}
    const backups = files.map(f => {
      try {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { filename: f, size: stat.size, created: stat.mtime };
      } catch {
        return { filename: f };
      }
    });
    res.json({ backups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backups', (req, res) => {
  try {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `backup_${ts}.json`;

    // Gather data
    let config = {};
    try { config = readConfig(); } catch {}

    let preset = null;
    try { preset = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8')); } catch {}

    let reports = [];
    try {
      const reportFiles = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort();
      for (const f of reportFiles) {
        try {
          reports.push({ filename: f, ...JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')) });
        } catch {}
      }
    } catch {}

    const backup = {
      created: now.toISOString(),
      version: '1.0',
      config,
      preset,
      reports,
    };

    fs.writeFileSync(path.join(BACKUP_DIR, filename), JSON.stringify(backup, null, 2));
    res.json({ ok: true, filename, size: JSON.stringify(backup).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/backups/:filename', (req, res) => {
  const { filename } = req.params;
  if (!/^backup_[\w-]+\.json$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  try {
    fs.unlinkSync(filepath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backups/restore', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'No file specified' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  try {
    const backup = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    // Restore config
    if (backup.config) {
      writeConfig(backup.config);
      if (backup.config.smtp) writeMsmtprc(backup.config.smtp);
      if (DOCKER) setupCron();
    }
    // Restore preset
    if (backup.preset) {
      fs.writeFileSync(PRESET_FILE, JSON.stringify(backup.preset, null, 2));
    }
    // Restore reports
    if (backup.reports && Array.isArray(backup.reports)) {
      for (const r of backup.reports) {
        if (r.filename) {
          const { filename: fn, ...data } = r;
          fs.writeFileSync(path.join(REPORTS_DIR, fn), JSON.stringify(data, null, 2));
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Export / Import ---
app.get('/api/export', (req, res) => {
  try {
    let config = {};
    try { config = readConfig(); } catch {}
    let preset = null;
    try { preset = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8')); } catch {}

    const data = {
      exported: new Date().toISOString(),
      type: 'autoconvert-export',
      config,
      preset,
    };
    res.setHeader('Content-Disposition', 'attachment; filename="autoconvert-export.json"');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import', (req, res) => {
  try {
    const data = req.body;
    if (data.type !== 'autoconvert-export') {
      return res.status(400).json({ error: 'Invalid export file' });
    }
    if (data.config) {
      writeConfig(data.config);
      if (data.config.smtp) writeMsmtprc(data.config.smtp);
      if (DOCKER) setupCron();
    }
    if (data.preset) {
      if (fs.existsSync(PRESET_FILE)) {
        fs.copyFileSync(PRESET_FILE, PRESET_FILE + '.bak');
      }
      fs.writeFileSync(PRESET_FILE, JSON.stringify(data.preset, null, 2));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Version ---
app.get('/api/version', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    res.json(data);
  } catch {
    res.json({ version: '1.0', history: [] });
  }
});

// --- Start ---
const PORT = process.env.PORT || 3742;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AutoConvert running on http://localhost:${PORT}`);
  if (DOCKER) setupCron();
});
