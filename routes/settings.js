const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const {
  LOG_PATH, REPORTS_DIR, MSMTP_BIN, DEFAULT_BACKUP_DIR, VERSION_FILE,
  readConfig, writeConfig, getMediaDirs,
} = require('../lib/config');
const { writeMsmtprc } = require('../lib/email');
const { setupCron } = require('../lib/cron');
const { scanDirectories, clearDirCache } = require('../lib/directories');
const watcher = require('../lib/watcher');

// Recipients
router.get('/recipients', (req, res) => {
  const config = readConfig();
  res.json({ recipients: config.recipients });
});

router.post('/recipients', (req, res) => {
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

router.post('/recipients/toggle', (req, res) => {
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
router.get('/smtp', (req, res) => {
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

router.post('/smtp', (req, res) => {
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
router.post('/test-email', async (req, res) => {
  const { email } = req.body;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  const config = readConfig();
  const smtp = config.smtp;
  if (!smtp || !smtp.host) {
    return res.status(400).json({ error: 'SMTP not configured' });
  }
  const from = smtp.from || 'noreply@autoconvert.local';
  const now = new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' });
  try {
    const emailContent = [
      `Content-Type: text/html; charset=utf-8`,
      `Subject: AutoConvert Test - ${now}`,
      `From: ${from}`,
      `To: ${email}`,
      ``,
      `<html><body style="font-family:-apple-system,Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">`,
      `<div style="background:#fff;border-radius:12px;padding:30px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">`,
      `<h2 style="color:#6366f1;margin:0 0 10px;">AutoConvert Test</h2>`,
      `<p>This is a test email sent on <strong>${now}</strong>.</p>`,
      `<p style="color:#888;">If you receive this email, the email configuration is working correctly.</p>`,
      `</div></body></html>`
    ].join('\n');
    const msmtpPath = fs.existsSync(MSMTP_BIN) ? MSMTP_BIN : 'msmtp';
    execFileSync(msmtpPath, [email], { input: emailContent, timeout: 30000 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test SMTP connection
router.post('/test-smtp', (req, res) => {
  const config = readConfig();
  const smtp = config.smtp;
  if (!smtp || !smtp.host || !smtp.port) {
    return res.status(400).json({ error: 'SMTP not configured' });
  }
  const socket = new net.Socket();
  socket.setTimeout(5000);
  socket.on('connect', () => { socket.destroy(); res.json({ ok: true }); });
  socket.on('timeout', () => { socket.destroy(); res.status(500).json({ error: 'Connection timed out' }); });
  socket.on('error', (err) => { res.status(500).json({ error: err.message }); });
  socket.connect(smtp.port, smtp.host);
});

// Schedule
router.get('/schedule', (req, res) => {
  const config = readConfig();
  res.json({
    hour: config.schedule?.hour ?? 3,
    minute: config.schedule?.minute ?? 0,
    scanInterval: config.schedule?.scanInterval ?? 0,
    emailHour: config.schedule?.emailHour ?? '',
    emailMinute: config.schedule?.emailMinute ?? 0,
  });
});

router.post('/schedule', (req, res) => {
  const { hour, minute, scanInterval, emailHour, emailMinute } = req.body;
  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  const si = parseInt(scanInterval, 10) || 0;
  if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59) {
    return res.status(400).json({ error: 'Invalid time' });
  }
  const config = readConfig();
  config.schedule = { hour: h, minute: m, scanInterval: si };
  if (emailHour !== undefined && emailHour !== '') {
    const eh = parseInt(emailHour, 10);
    const em = parseInt(emailMinute, 10) || 0;
    if (!isNaN(eh) && eh >= 0 && eh <= 23) {
      config.schedule.emailHour = eh;
      config.schedule.emailMinute = em;
    }
  } else {
    delete config.schedule.emailHour;
    delete config.schedule.emailMinute;
  }
  writeConfig(config);
  setupCron();
  res.json({ ok: true });
});

// Log
router.get('/log', (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 200;
    if (!fs.existsSync(LOG_PATH)) return res.json({ log: '' });
    const full = fs.readFileSync(LOG_PATH, 'utf8');
    const arr = full.split('\n');
    const tail = arr.slice(-lines).join('\n');
    res.json({ log: tail, totalLines: arr.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/logs', (req, res) => {
  try {
    fs.writeFileSync(LOG_PATH, '');
    try {
      const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) fs.unlinkSync(path.join(REPORTS_DIR, f));
    } catch {}
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disk Space
function getDiskSpace(dirPath) {
  try {
    const output = execFileSync('df', ['-k', dirPath], { timeout: 5000 }).toString();
    const lines = output.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].trim().split(/\s+/);
    if (parts.length < 4) return null;
    const totalKB = parseInt(parts[1], 10);
    const usedKB = parseInt(parts[2], 10);
    const availKB = parseInt(parts[3], 10);
    if (isNaN(totalKB) || isNaN(availKB)) return null;
    const freeBytes = availKB * 1024;
    const totalBytes = totalKB * 1024;
    return {
      path: dirPath,
      freeBytes,
      totalBytes,
      freeGB: (freeBytes / (1024 ** 3)).toFixed(1),
      totalGB: (totalBytes / (1024 ** 3)).toFixed(1),
    };
  } catch {
    return null;
  }
}

router.get('/disk-space', (req, res) => {
  try {
    const mediaDirs = getMediaDirs();
    const directories = [];
    for (const dirPath of mediaDirs) {
      const info = getDiskSpace(dirPath);
      if (info) {
        directories.push(info);
      } else {
        directories.push({ path: dirPath, error: 'Could not read disk space', freeBytes: 0, totalBytes: 0, freeGB: '0', totalGB: '0' });
      }
    }
    const freeValues = directories.map(d => parseFloat(d.freeGB)).filter(v => !isNaN(v));
    const minFreeGB = freeValues.length > 0 ? Math.min(...freeValues) : 0;
    res.json({ directories, minFreeGB });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// App Settings
router.get('/app-settings', (req, res) => {
  const config = readConfig();
  res.json({
    port: config.app?.port || 3742,
    backupDir: config.app?.backupDir || DEFAULT_BACKUP_DIR,
    autoDelete: config.app?.autoDelete !== false,
    serverUrl: config.serverUrl || '',
    adminEmail: config.app?.adminEmail || '',
    downloadNotify: config.app?.downloadNotify !== false,
  });
});

router.post('/app-settings', (req, res) => {
  const { port, backupDir, autoDelete } = req.body;
  const config = readConfig();
  if (!config.app) config.app = {};
  let restart = false;
  if (port !== undefined) {
    const p = parseInt(port, 10);
    if (isNaN(p) || p < 1 || p > 65535) return res.status(400).json({ error: 'Port must be between 1 and 65535' });
    config.app.port = p;
    restart = true;
  }
  if (backupDir !== undefined) {
    const d = backupDir.trim();
    if (d) {
      try { fs.mkdirSync(d, { recursive: true }); } catch (e) { return res.status(400).json({ error: 'Cannot create directory: ' + e.message }); }
      config.app.backupDir = d;
    } else {
      delete config.app.backupDir;
    }
  }
  if (autoDelete !== undefined) {
    config.app.autoDelete = !!autoDelete;
  }
  if (req.body.serverUrl !== undefined) {
    config.serverUrl = req.body.serverUrl.trim().replace(/\/+$/, '');
  }
  if (req.body.adminEmail !== undefined) {
    config.app.adminEmail = req.body.adminEmail.trim();
  }
  if (req.body.downloadNotify !== undefined) {
    config.app.downloadNotify = !!req.body.downloadNotify;
  }
  writeConfig(config);
  res.json({ ok: true, restart });
});

// Media Directories
router.get('/media-dirs', (req, res) => {
  res.json({ dirs: getMediaDirs() });
});

router.post('/media-dirs', (req, res) => {
  const { dir } = req.body;
  if (!dir || typeof dir !== 'string' || !dir.trim()) return res.status(400).json({ error: 'Directory path is required' });
  const cleaned = dir.trim().replace(/\/+$/, '');
  const config = readConfig();
  if (!config.mediaDirs) config.mediaDirs = getMediaDirs();
  if (config.mediaDirs.includes(cleaned)) return res.status(409).json({ error: 'Directory already exists' });
  config.mediaDirs.push(cleaned);
  writeConfig(config);
  clearDirCache();
  scanDirectories();
  watcher.restart();
  res.json({ ok: true, dirs: config.mediaDirs });
});

router.delete('/media-dirs', (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: 'Directory path is required' });
  const config = readConfig();
  if (!config.mediaDirs) config.mediaDirs = getMediaDirs();
  const idx = config.mediaDirs.indexOf(dir);
  if (idx === -1) return res.status(404).json({ error: 'Directory not found' });
  config.mediaDirs.splice(idx, 1);
  writeConfig(config);
  clearDirCache();
  scanDirectories();
  watcher.restart();
  res.json({ ok: true, dirs: config.mediaDirs });
});

// Choose directory (macOS)
router.post('/choose-directory', (req, res) => {
  const def = req.body.default || '';
  const choose = def
    ? `POSIX path of (choose folder with prompt "Select folder" default location POSIX file "${def}")`
    : `POSIX path of (choose folder with prompt "Select folder")`;
  try {
    const result = execFileSync('osascript', [
      '-e', 'tell application "System Events" to activate',
      '-e', choose,
    ], { timeout: 60000 }).toString().trim();
    res.json({ ok: true, path: result });
  } catch (err) {
    if (err.status === 1 || err.stderr?.toString().includes('User canceled')) return res.json({ ok: false, canceled: true });
    res.status(500).json({ error: err.message });
  }
});

// Version
router.get('/version', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'))); }
  catch { res.json({ version: '1.0', history: [] }); }
});

module.exports = router;
