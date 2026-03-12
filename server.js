const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const cron = require('node-cron');
const https = require('https');
const net = require('net');
const bcrypt = require('bcryptjs');
const session = require('express-session');

// --- Mode & Paths ---
const APP_MODE = process.env.AUTOCONVERT_APP === 'true';
const APP_SUPPORT = APP_MODE
  ? path.join(process.env.HOME, 'Library', 'Application Support', 'AutoConvert')
  : null;
const APP_DIR = __dirname;

const app = express();
app.use(express.json({ limit: '10mb' }));

// --- Rate Limiting ---
const loginAttempts = new Map(); // IP -> { count, firstAttempt, lockedUntil }
const RATE_LIMIT = { maxAttempts: 5, windowMs: 60 * 1000, lockoutMs: 5 * 60 * 1000 };

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.lockedUntil && now < entry.lockedUntil) {
    const remaining = Math.ceil((entry.lockedUntil - now) / 1000);
    return { allowed: false, remaining };
  }
  if (now - entry.firstAttempt > RATE_LIMIT.windowMs) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT.maxAttempts) {
    entry.lockedUntil = now + RATE_LIMIT.lockoutMs;
    const remaining = Math.ceil(RATE_LIMIT.lockoutMs / 1000);
    return { allowed: false, remaining };
  }
  return { allowed: true };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, firstAttempt: now };
  entry.count++;
  loginAttempts.set(ip, entry);
}

function clearFailedLogins(ip) { loginAttempts.delete(ip); }

// Clean up old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.firstAttempt > RATE_LIMIT.lockoutMs + RATE_LIMIT.windowMs) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);

// --- Auth: Session & Users ---
const USERS_PATH = APP_MODE
  ? path.join(APP_SUPPORT, 'users.json')
  : path.join(__dirname, 'users.json');

// Generate or load persistent session secret
const SECRET_PATH = APP_MODE
  ? path.join(APP_SUPPORT, '.session-secret')
  : path.join(__dirname, '.session-secret');
function getSessionSecret() {
  try { return fs.readFileSync(SECRET_PATH, 'utf8').trim(); } catch {}
  const secret = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

app.use(session({
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
  name: 'ac.sid',
}));

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); } catch {}
  return [];
}
function writeUsers(users) {
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), { mode: 0o600 });
}
function isAuthEnabled() { return readUsers().length > 0; }

// Auth middleware — protects all /api/* except auth endpoints
function requireAuth(req, res, next) {
  // Auth endpoints are always accessible (path is relative to mount point /api)
  if (req.path.startsWith('/auth/')) return next();
  // Download endpoint is public (secured by path validation + media dir check)
  if (req.path === '/download') return next();
  // If no users configured, skip auth
  if (!isAuthEnabled()) return next();
  // Check session
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}
app.use('/api', requireAuth);

// Auth API endpoints
app.get('/api/auth/status', (req, res) => {
  const users = readUsers();
  res.json({
    authEnabled: users.length > 0,
    loggedIn: !!(req.session && req.session.user),
    user: req.session?.user || null,
  });
});

app.post('/api/auth/setup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const users = readUsers();
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'User already exists' });
  const hash = bcrypt.hashSync(password, 12);
  users.push({ username, hash, createdAt: new Date().toISOString() });
  writeUsers(users);
  req.session.user = username;
  res.json({ ok: true, user: username });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return res.status(429).json({ error: `Too many login attempts. Try again in ${limit.remaining} seconds.` });
  }
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const users = readUsers();
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.hash)) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  clearFailedLogins(ip);
  req.session.user = username;
  res.json({ ok: true, user: username });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ac.sid');
    res.json({ ok: true });
  });
});

app.post('/api/auth/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const users = readUsers();
  const user = users.find(u => u.username === req.session.user);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!bcrypt.compareSync(currentPassword, user.hash)) return res.status(401).json({ error: 'Current password is incorrect' });
  user.hash = bcrypt.hashSync(newPassword, 12);
  writeUsers(users);
  res.json({ ok: true });
});

app.post('/api/auth/delete-user', (req, res) => {
  const { username, password } = req.body;
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  let users = readUsers();
  const user = users.find(u => u.username === (username || req.session.user));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!bcrypt.compareSync(password, user.hash)) return res.status(401).json({ error: 'Password is incorrect' });
  users = users.filter(u => u.username !== user.username);
  writeUsers(users);
  if (user.username === req.session.user) {
    req.session.destroy(() => {});
  }
  res.json({ ok: true, authDisabled: users.length === 0 });
});

// Reset endpoint — accepts a token written by the macOS menu bar app
app.post('/api/auth/reset', (req, res) => {
  const { token, newUsername, newPassword } = req.body;
  const tokenPath = APP_MODE
    ? path.join(APP_SUPPORT, '.reset-token')
    : path.join(__dirname, '.reset-token');
  try {
    const storedToken = fs.readFileSync(tokenPath, 'utf8').trim();
    if (!token || token !== storedToken) return res.status(403).json({ error: 'Invalid reset token' });
    fs.unlinkSync(tokenPath); // one-time use
  } catch {
    return res.status(403).json({ error: 'No reset token found' });
  }
  if (!newUsername || !newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Username and password (min 4 chars) required' });
  }
  const hash = bcrypt.hashSync(newPassword, 12);
  writeUsers([{ username: newUsername, hash, createdAt: new Date().toISOString() }]);
  res.json({ ok: true });
});

// Serve login page for unauthenticated users
app.use((req, res, next) => {
  // API requests handled above, this is for static files
  if (req.path.startsWith('/api/')) return next();
  // If auth not enabled, serve normally
  if (!isAuthEnabled()) return next();
  // If logged in, serve normally
  if (req.session && req.session.user) return next();
  // Serve login page
  return res.sendFile(path.join(APP_DIR, 'public', 'login.html'));
});

app.use(express.static(path.join(APP_DIR, 'public')));

const CONFIG_PATH = APP_MODE
  ? path.join(APP_SUPPORT, 'config.json')
  : path.join(__dirname, 'config.json');
const SCRIPT_PATH = path.join(APP_DIR, 'scripts', 'daily_mkv_convert.sh');
const LOG_DIR = APP_MODE ? APP_SUPPORT : __dirname;
const LOG_PATH = path.join(LOG_DIR, 'daily_convert.log');
const REPORTS_DIR = path.join(LOG_DIR, 'reports');
const PRESETS_DIR = APP_MODE
  ? path.join(APP_SUPPORT, 'presets')
  : path.join(__dirname, 'scripts', 'presets');
const LOCK_FILE = '/tmp/daily_mkv_convert.lock';
const PROGRESS_FILE = '/tmp/mkv_convert_progress.json';
const HB_LOG_FILE = '/tmp/mkv_convert_hb.log';
const MSMTP_BIN = '/opt/homebrew/bin/msmtp';
const MSMTPRC_PATH = path.join(process.env.HOME, '.msmtprc');
const DEFAULT_BACKUP_DIR = APP_MODE
  ? path.join(APP_SUPPORT, 'backups')
  : path.join(__dirname, 'backups');
function getBackupDir() {
  try { const d = readConfig().app?.backupDir; if (d) return d; } catch {}
  return DEFAULT_BACKUP_DIR;
}
function getActivePresetFile() {
  try { const f = readConfig().app?.activePreset; if (f) return path.join(PRESETS_DIR, f); } catch {}
  return path.join(PRESETS_DIR, 'Default Preset.json');
}
function readPresetDetails(filePath) {
  const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const p = (content.PresetList || [])[0] || {};
  const stat = fs.statSync(filePath);
  return {
    name: p.PresetName || 'Unknown',
    description: p.PresetDescription || '',
    filename: path.basename(filePath),
    size: stat.size,
    modified: stat.mtime,
    details: {
      format: p.FileFormat || '', videoEncoder: p.VideoEncoder || '', videoPreset: p.VideoPreset || '',
      videoQuality: p.VideoQualitySlider ?? '', videoQualityType: p.VideoQualityType ?? '',
      videoBitrate: p.VideoAvgBitrate ?? '',
      resolution: (p.PictureWidth && p.PictureHeight) ? `${p.PictureWidth}x${p.PictureHeight}` : '',
      audioEncoder: p.AudioList?.[0]?.AudioEncoder || '', audioBitrate: p.AudioList?.[0]?.AudioBitrate || '',
      audioMixdown: p.AudioList?.[0]?.AudioMixdown || '',
      subtitles: p.SubtitleTrackSelectionBehavior || 'none',
      chapterMarkers: !!p.ChapterMarkers, multiPass: !!p.VideoMultiPass,
    }
  };
}
const VERSION_FILE = path.join(APP_DIR, 'version.json');

// --- Media Directories ---
function getMediaDirs() {
  try {
    const config = readConfig();
    if (config.mediaDirs && config.mediaDirs.length > 0) {
      return config.mediaDirs;
    }
  } catch {}
  return ['/Volumes/Media/Movies', '/Volumes/Media/Series'];
}

// --- Cron Scheduler ---
let cronJob = null;
let scanJob = null;
let emailJob = null;

function setupCron() {
  const config = readConfig();
  const hour = config.schedule?.hour ?? 3;
  const minute = config.schedule?.minute ?? 0;
  if (cronJob) cronJob.stop();
  cronJob = cron.schedule(`${minute} ${hour} * * *`, () => {
    console.log(`[cron] Conversion started at ${new Date().toISOString()}`);
    runConvertScript();
  });
  console.log(`[cron] Scheduled at ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`);
  setupScanCron(config);
  setupEmailCron(config);
}

function setupEmailCron(config) {
  if (emailJob) emailJob.stop();
  const eh = config.schedule?.emailHour;
  const em = config.schedule?.emailMinute;
  if (eh === undefined || eh === null || eh === '') return;
  const emailHour = parseInt(eh, 10);
  const emailMinute = parseInt(em, 10) || 0;
  if (isNaN(emailHour) || emailHour < 0 || emailHour > 23) return;
  emailJob = cron.schedule(`${emailMinute} ${emailHour} * * *`, () => {
    console.log(`[email-cron] Sending daily report email at ${new Date().toISOString()}`);
    sendDailyReportEmail();
  });
  console.log(`[email-cron] Email scheduled at ${String(emailHour).padStart(2,'0')}:${String(emailMinute).padStart(2,'0')}`);
}

async function sendDailyReportEmail() {
  // Find the most recent report from the last 24 hours
  try {
    const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    if (!files.length) { console.log('[email-cron] No reports found'); return; }

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    let latestReport = null;
    for (const f of files) {
      const m = f.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.json$/);
      if (!m) continue;
      const fileDate = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), parseInt(m[4]), parseInt(m[5]), parseInt(m[6]));
      if (fileDate >= yesterday) { latestReport = f; break; }
    }
    if (!latestReport) { console.log('[email-cron] No recent reports to email'); return; }

    const config = readConfig();
    const smtp = config.smtp;
    if (!smtp || !smtp.host) { console.log('[email-cron] SMTP not configured'); return; }
    const recipients = (config.recipients || []).filter(r => r.active !== false).map(r => r.email);
    if (!recipients.length) { console.log('[email-cron] No active recipients'); return; }

    // Reuse the resend logic
    const report = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, latestReport), 'utf8'));
    const tmpDir = '/tmp/mkv_email_cron_report';
    fs.mkdirSync(tmpDir, { recursive: true });

    const mediaDirs = getMediaDirs();
    const convertedLines = (report.converted || []).map(c => {
      let mp4Path = c.mp4_path || '';
      if (!mp4Path) {
        for (const dir of mediaDirs) {
          const dirName = path.basename(dir);
          if (dirName.toLowerCase() === (c.section || '').toLowerCase()) {
            try {
              const found = execSync(`find "${dir}" -name "${c.basename.replace(/"/g, '')}.mp4" -type f 2>/dev/null | head -1`, { timeout: 5000 }).toString().trim();
              if (found) { mp4Path = found; break; }
            } catch {}
          }
        }
      }
      const parts = [c.section, c.basename, c.old_size, c.new_size, c.duration];
      if (mp4Path) parts.push(mp4Path);
      return parts.join('|');
    });
    fs.writeFileSync(path.join(tmpDir, 'converted.txt'), convertedLines.join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'failed.txt'), (report.failed || []).map(f => `${f.section}|${f.basename}|${f.size}`).join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'dupes.txt'), (report.dupes || []).map(d => `${d.section}|${d.name}`).join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'skipped_empty.txt'), String(report.skipped_empty || 0));

    const env = { ...process.env, START_TIME: report.started || '', END_TIME: report.finished || '', RESEND: '1' };
    const result = execSync(
      `python3 "${path.join(APP_DIR, 'scripts', 'generate_report.py')}" "${tmpDir}" "${CONFIG_PATH}" "${REPORTS_DIR}"`,
      { env, timeout: 60000 }
    ).toString();

    // Send via msmtp (same as original conversion emails)
    const msmtpPath = fs.existsSync(MSMTP_BIN) ? MSMTP_BIN : 'msmtp';
    const emailFile = path.join(tmpDir, 'email.txt');
    fs.writeFileSync(emailFile, result);
    execSync(`cat "${emailFile}" | ${msmtpPath} ${recipients.join(' ')}`, { timeout: 30000 });
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    console.log(`[email-cron] Report emailed to ${recipients.join(', ')}`);
  } catch (err) {
    console.error(`[email-cron] Error: ${err.message}`);
  }
}

function setupScanCron(config) {
  if (scanJob) scanJob.stop();
  const interval = config.schedule?.scanInterval || 0;
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

function checkDiskSpaceWarnings(mediaDirs) {
  const MIN_FREE_GB = 5;
  const warnings = [];
  for (const dirPath of mediaDirs) {
    try {
      const output = execSync('df -k "' + dirPath + '"', { timeout: 5000 }).toString();
      const lines = output.trim().split('\n');
      if (lines.length < 2) continue;
      const parts = lines[1].trim().split(/\s+/);
      if (parts.length < 4) continue;
      const availKB = parseInt(parts[3], 10);
      if (isNaN(availKB)) continue;
      const freeGB = availKB / (1024 * 1024);
      if (freeGB < MIN_FREE_GB) {
        warnings.push(`${dirPath} has only ${freeGB.toFixed(1)} GB free (minimum recommended: ${MIN_FREE_GB} GB)`);
      }
    } catch {}
  }
  return warnings;
}

function runConvertScript(excludeFiles = [], fileOrder = []) {
  const mediaDirs = getMediaDirs();
  const config = readConfig();
  const autoDelete = config.app?.autoDelete !== false;

  // Pre-conversion disk space check
  const diskWarnings = checkDiskSpaceWarnings(mediaDirs);
  if (diskWarnings.length > 0) {
    for (const w of diskWarnings) {
      console.warn(`[convert] WARNING: Low disk space - ${w}`);
    }
  }

  const env = {
    ...process.env,
    APP_DIR,
    CONFIG_FILE: CONFIG_PATH,
    PRESET_FILE: getActivePresetFile(),
    LOG_DIR,
    REPORTS_DIR,
    MEDIA_DIRS: mediaDirs.join(':'),
    DELETE_ORIGINALS: autoDelete ? '1' : '0',
    SKIP_EMAIL: (config.schedule?.emailHour !== undefined && config.schedule?.emailHour !== null && config.schedule?.emailHour !== '') ? '1' : '0',
    EXCLUDE_FILES: excludeFiles.join('\n'),
    FILE_ORDER: fileOrder.join('\n'),
    PATH: `${path.join(APP_DIR, '..')}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    DYLD_LIBRARY_PATH: APP_MODE ? path.join(APP_DIR, '..', '..', 'Frameworks') : '',
  };
  console.log(`[convert] Starting script: ${SCRIPT_PATH}`);
  console.log(`[convert] Media dirs: ${mediaDirs.join(', ')}`);
  const logStream = fs.openSync(path.join(LOG_DIR, 'convert_stderr.log'), 'a');
  const child = spawn('/bin/bash', [SCRIPT_PATH], {
    detached: true,
    stdio: ['ignore', 'ignore', logStream],
    env,
  });
  child.on('error', (err) => {
    console.error(`[convert] Spawn error: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    console.log(`[convert] Script exited with code=${code}, signal=${signal}`);
    try { fs.closeSync(logStream); } catch {}
  });
  child.unref();
  console.log(`[convert] Script spawned with PID ${child.pid}`);
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

// --- Init ---
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(REPORTS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(getBackupDir(), { recursive: true }); } catch {}
if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '');

// Init presets directory and migrate
try { fs.mkdirSync(PRESETS_DIR, { recursive: true }); } catch {}
const _presetsInDir = (() => { try { return fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')); } catch { return []; } })();
if (_presetsInDir.length === 0) {
  // Migrate old single preset or copy default
  const oldPreset = path.join(APP_MODE ? APP_SUPPORT : path.join(__dirname, 'scripts'), 'Niel.json');
  const defaultPreset = path.join(APP_DIR, 'scripts', 'Niel.json');
  const src = fs.existsSync(oldPreset) ? oldPreset : (fs.existsSync(defaultPreset) ? defaultPreset : null);
  if (src) {
    fs.copyFileSync(src, path.join(PRESETS_DIR, 'Default Preset.json'));
    console.log(`[init] Copied preset to ${PRESETS_DIR}/Default Preset.json`);
  }
  const _cfg = readConfig(); if (!_cfg.app) _cfg.app = {};
  if (!_cfg.app.activePreset) { _cfg.app.activePreset = 'Default Preset.json'; writeConfig(_cfg); }
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
    try {
      const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      if (progress.status === 'done' && progress.finished) {
        return res.json(progress);
      }
    } catch {}
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
      const match = parts[i].match(/Encoding:.*?(\d+(?:\.\d+)?)\s*%/);
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

app.post('/api/convert/progress/clear', (req, res) => {
  try { fs.unlinkSync(PROGRESS_FILE); } catch {}
  res.json({ ok: true });
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
app.post('/api/test-email', async (req, res) => {
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
    const tmpFile = '/tmp/autoconvert_test_email.txt';
    fs.writeFileSync(tmpFile, emailContent);
    execSync(`cat "${tmpFile}" | ${msmtpPath} ${email}`, { timeout: 30000 });
    try { fs.unlinkSync(tmpFile); } catch {}
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resend a report email
app.post('/api/reports/:filename/resend', async (req, res) => {
  const { filename } = req.params;
  const { email } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filepath = path.join(REPORTS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Report not found' });

  const config = readConfig();
  const smtp = config.smtp;
  if (!smtp || !smtp.host) return res.status(400).json({ error: 'SMTP not configured' });

  // Determine recipients
  let recipients;
  if (email) {
    recipients = [email];
  } else {
    recipients = (config.recipients || []).filter(r => r.active !== false).map(r => r.email);
  }
  if (!recipients.length) return res.status(400).json({ error: 'No recipients' });

  try {
    // Recreate the report data files from JSON for the Python report generator
    const report = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const tmpDir = '/tmp/mkv_resend_report';
    fs.mkdirSync(tmpDir, { recursive: true });

    // Write converted.txt — reconstruct mp4_path for old reports
    const mediaDirs = getMediaDirs();
    const convertedLines = (report.converted || []).map(c => {
      let mp4Path = c.mp4_path || '';
      if (!mp4Path) {
        // Try to find MP4 by searching media dirs for section/basename.mp4
        for (const dir of mediaDirs) {
          const dirName = path.basename(dir);
          if (dirName.toLowerCase() === (c.section || '').toLowerCase()) {
            try {
              const found = execSync(`find "${dir}" -name "${c.basename.replace(/"/g, '')}.mp4" -type f 2>/dev/null | head -1`, { timeout: 5000 }).toString().trim();
              if (found) { mp4Path = found; break; }
            } catch {}
          }
        }
      }
      const parts = [c.section, c.basename, c.old_size, c.new_size, c.duration];
      if (mp4Path) parts.push(mp4Path);
      return parts.join('|');
    });
    fs.writeFileSync(path.join(tmpDir, 'converted.txt'), convertedLines.join('\n'));

    // Write failed.txt
    const failedLines = (report.failed || []).map(f => `${f.section}|${f.basename}|${f.size}`);
    fs.writeFileSync(path.join(tmpDir, 'failed.txt'), failedLines.join('\n'));

    // Write dupes.txt
    const dupeLines = (report.dupes || []).map(d => `${d.section}|${d.name}`);
    fs.writeFileSync(path.join(tmpDir, 'dupes.txt'), dupeLines.join('\n'));

    // Write skipped
    fs.writeFileSync(path.join(tmpDir, 'skipped_empty.txt'), String(report.skipped_empty || 0));

    // Set env vars for the report generator
    const env = {
      ...process.env,
      START_TIME: report.started || '',
      END_TIME: report.finished || '',
      RESEND: '1',
    };

    // Generate full email (with headers) via Python script
    const result = execSync(
      `python3 "${path.join(APP_DIR, 'scripts', 'generate_report.py')}" "${tmpDir}" "${CONFIG_PATH}" "${REPORTS_DIR}"`,
      { env, timeout: 60000 }
    ).toString();

    // Override To header for specific recipient and add (resend) to subject
    let emailContent = result;
    emailContent = emailContent.replace(/^Subject:\s*(.+)$/m, (m, subj) => `Subject: ${subj} (resend)`);
    emailContent = emailContent.replace(/^To:\s*(.+)$/m, `To: ${recipients.join(', ')}`);

    // Send via msmtp (same as original conversion emails)
    const msmtpPath = fs.existsSync(MSMTP_BIN) ? MSMTP_BIN : 'msmtp';
    const emailFile = path.join(tmpDir, 'email.txt');
    fs.writeFileSync(emailFile, emailContent);
    execSync(`cat "${emailFile}" | ${msmtpPath} ${recipients.join(' ')}`, { timeout: 30000 });

    // Clean up tmp
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

    res.json({ ok: true, sentTo: recipients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test SMTP connection
app.post('/api/test-smtp', (req, res) => {
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
app.get('/api/schedule', (req, res) => {
  const config = readConfig();
  res.json({
    hour: config.schedule?.hour ?? 3,
    minute: config.schedule?.minute ?? 0,
    scanInterval: config.schedule?.scanInterval ?? 0,
    emailHour: config.schedule?.emailHour ?? '',
    emailMinute: config.schedule?.emailMinute ?? 0,
  });
});

app.post('/api/schedule', (req, res) => {
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
    // Empty = send immediately after conversion (no separate email schedule)
    delete config.schedule.emailHour;
    delete config.schedule.emailMinute;
  }
  writeConfig(config);
  setupCron();
  res.json({ ok: true });
});

// Manual scan
app.post('/api/scan', (req, res) => {
  dirCache = null;
  scanDirectories();
  res.json({ ok: true });
});

// Force convert
app.post('/api/convert', (req, res) => {
  if (isRunning()) {
    return res.status(409).json({ error: 'Conversion already running' });
  }
  const excludeFiles = Array.isArray(req.body?.exclude) ? req.body.exclude : [];
  const fileOrder = Array.isArray(req.body?.order) ? req.body.order : [];
  const diskWarnings = checkDiskSpaceWarnings(getMediaDirs());
  const pid = runConvertScript(excludeFiles, fileOrder);
  const result = { started: true, pid };
  if (diskWarnings.length > 0) {
    result.diskWarnings = diskWarnings;
  }
  res.json(result);
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

// Reports
// Parse human-readable size strings (e.g. "4.5G", "120M", "500K") to bytes
function parseSizeToBytes(s) {
  if (!s || typeof s !== 'string') return 0;
  const m = s.trim().match(/^([\d.]+)\s*([KMGT]?)i?B?$/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = (m[2] || '').toUpperCase();
  const mult = { '': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3, 'T': 1024 ** 4 };
  return v * (mult[u] || 1);
}

app.get('/api/reports/stats', (req, res) => {
  try {
    let files = [];
    try { files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')); } catch {}
    let movies = 0, series = 0, totalOld = 0, totalNew = 0;
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
        for (const c of (r.converted || [])) {
          if (c.section === 'movies') movies++; else series++;
          totalOld += parseSizeToBytes(c.old_size);
          totalNew += parseSizeToBytes(c.new_size);
        }
      } catch {}
    }
    res.json({ movies, series, totalOld, totalNew, saved: totalOld - totalNew, reports: files.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports', (req, res) => {
  try {
    let files = [];
    try {
      files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    } catch {}
    const total = files.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
    const page = files.slice(offset, offset + limit);
    const reports = page.map(f => {
      try { return { ...JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')), filename: f }; }
      catch { return { filename: f, error: 'Could not read report' }; }
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
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Report not found' });
  try { fs.unlinkSync(filepath); res.json({ ok: true, deleted: filename }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/logs', (req, res) => {
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

// --- Directories (async scan with cache) ---
const fsPromises = fs.promises;
let dirCache = null;
let dirScanRunning = false;

async function findMkvAsync(dir, rel) {
  const files = [];
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const sub = await findMkvAsync(full, relPath);
        files.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith('.mkv')) {
        try {
          const stat = await fsPromises.stat(full);
          files.push({ name: entry.name, path: relPath, size: stat.size, modified: stat.mtime });
        } catch {}
      }
    }
  } catch {}
  return files;
}

async function scanDirectories() {
  if (dirScanRunning) return;
  dirScanRunning = true;
  const basePaths = getMediaDirs();
  try {
    const directories = await Promise.all(basePaths.map(async (dirPath) => {
      let exists = false;
      try { await fsPromises.access(dirPath); exists = true; } catch {}
      let files = [];
      if (exists) {
        files = await findMkvAsync(dirPath, '');
        files.sort((a, b) => a.path.localeCompare(b.path));
      }
      return { path: dirPath, name: path.basename(dirPath), exists, fileCount: files.length, files };
    }));
    dirCache = { directories, scannedAt: Date.now() };
    console.log(`[scan] Directory scan complete: ${directories.map(d => `${d.name}=${d.fileCount}`).join(', ')}`);
  } catch (err) {
    console.error('[scan] Error:', err.message);
  }
  dirScanRunning = false;
}

scanDirectories();

app.get('/api/directories', (req, res) => {
  if (dirCache) {
    res.json(dirCache);
  } else {
    const dirs = getMediaDirs();
    res.json({
      directories: dirs.map(d => ({ path: d, name: path.basename(d), exists: true, fileCount: 0, files: [], scanning: true })),
      scanning: true,
    });
  }
  if (!dirCache || Date.now() - dirCache.scannedAt > 300000) scanDirectories();
});

// --- Debug ---
app.get('/api/debug/hblog', (req, res) => {
  const results = {};
  try { results.hbLog = fs.readFileSync(HB_LOG_FILE, 'utf8').slice(-4000); } catch (e) { results.hbLog = e.message; }
  try { results.stderr = fs.readFileSync(path.join(LOG_DIR, 'convert_stderr.log'), 'utf8').slice(-2000); } catch (e) { results.stderr = e.message; }
  try { results.lockfile = fs.readFileSync(LOCK_FILE, 'utf8').trim(); } catch (e) { results.lockfile = e.message; }
  try { results.ps = execSync('ps aux | grep -i handbrake | grep -v grep', { timeout: 5000 }).toString().trim(); } catch (e) { results.ps = 'no handbrake process'; }
  res.json(results);
});

app.get('/api/debug/paths', (req, res) => {
  res.json({
    APP_DIR, APP_MODE, __dirname,
    cwd: process.cwd(),
    publicDir: path.join(APP_DIR, 'public'),
    publicExists: fs.existsSync(path.join(APP_DIR, 'public')),
    indexExists: fs.existsSync(path.join(APP_DIR, 'public', 'index.html')),
    CONFIG_PATH, PRESETS_DIR, activePreset: getActivePresetFile(), LOG_DIR,
  });
});

// --- Presets ---
app.get('/api/presets', (req, res) => {
  try {
    const config = readConfig();
    const activeFilename = config.app?.activePreset || 'Default Preset.json';
    const files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).sort();
    const presets = files.map(f => {
      try {
        const info = readPresetDetails(path.join(PRESETS_DIR, f));
        info.active = (f === activeFilename);
        return info;
      } catch (err) {
        return { filename: f, name: f, error: err.message, active: (f === activeFilename) };
      }
    });
    res.json({ presets, activePreset: activeFilename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/presets', (req, res) => {
  try {
    const content = req.body;
    if (!content.PresetList || !Array.isArray(content.PresetList) || !content.PresetList.length) {
      return res.status(400).json({ error: 'Invalid HandBrake preset file (no PresetList found)' });
    }
    const presetName = content.PresetList[0]?.PresetName || 'Unknown';
    let filename = presetName.replace(/[^a-zA-Z0-9 _\-]/g, '').trim() + '.json';
    if (!filename || filename === '.json') filename = 'preset.json';
    const filePath = path.join(PRESETS_DIR, filename);
    if (fs.existsSync(filePath) && req.query.overwrite !== 'true') {
      return res.status(409).json({ error: 'Preset already exists', filename, exists: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    const config = readConfig();
    if (!config.app) config.app = {};
    const allPresets = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'));
    if (allPresets.length === 1 || !config.app.activePreset) {
      config.app.activePreset = filename;
      writeConfig(config);
    }
    res.json({ ok: true, name: presetName, filename });
  } catch (err) {
    res.status(400).json({ error: 'Invalid JSON file: ' + err.message });
  }
});

app.post('/api/presets/:filename/activate', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PRESETS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Preset not found' });
  const config = readConfig();
  if (!config.app) config.app = {};
  config.app.activePreset = filename;
  writeConfig(config);
  res.json({ ok: true, activePreset: filename });
});

app.delete('/api/presets/:filename', (req, res) => {
  const { filename } = req.params;
  const config = readConfig();
  if (filename === (config.app?.activePreset || 'Default Preset.json')) {
    return res.status(400).json({ error: 'Cannot delete the active preset' });
  }
  const filePath = path.join(PRESETS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Preset not found' });
  try { fs.unlinkSync(filePath); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/presets/:filename/download', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PRESETS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Preset not found' });
  res.download(filePath, filename);
});

// --- Backup ---
app.get('/api/backups', (req, res) => {
  try {
    let files = [];
    try { files = fs.readdirSync(getBackupDir()).filter(f => f.endsWith('.json')).sort().reverse(); } catch {}
    const backups = files.map(f => {
      try { const stat = fs.statSync(path.join(getBackupDir(), f)); return { filename: f, size: stat.size, created: stat.mtime }; }
      catch { return { filename: f }; }
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
    let config = {}; try { config = readConfig(); } catch {}
    let presets = {};
    try {
      const pfiles = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'));
      for (const f of pfiles) { try { presets[f] = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')); } catch {} }
    } catch {}
    let reports = [];
    try {
      const reportFiles = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort();
      for (const f of reportFiles) {
        try { reports.push({ filename: f, ...JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')) }); } catch {}
      }
    } catch {}
    const backup = { created: now.toISOString(), version: '2.0', config, presets, reports };
    fs.writeFileSync(path.join(getBackupDir(), filename), JSON.stringify(backup, null, 2));
    res.json({ ok: true, filename, size: JSON.stringify(backup).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/backups/:filename', (req, res) => {
  const { filename } = req.params;
  if (!/^backup_[\w-]+\.json$/.test(filename)) return res.status(400).json({ error: 'Invalid filename' });
  const filepath = path.join(getBackupDir(), filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup not found' });
  try { fs.unlinkSync(filepath); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/choose-directory', (req, res) => {
  const def = req.body.default || '';
  const choose = def
    ? `POSIX path of (choose folder with prompt "Select folder" default location POSIX file "${def}")`
    : `POSIX path of (choose folder with prompt "Select folder")`;
  const script = `tell application "System Events" to activate\n${choose}`;
  try {
    const result = execSync(`osascript -e 'tell application "System Events" to activate' -e '${choose}'`, { timeout: 60000 }).toString().trim();
    res.json({ ok: true, path: result });
  } catch (err) {
    if (err.status === 1 || err.stderr?.toString().includes('User canceled')) return res.json({ ok: false, canceled: true });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backups/reveal', (req, res) => {
  const { filename } = req.body;
  const target = filename ? path.join(getBackupDir(), filename) : getBackupDir();
  if (filename && !fs.existsSync(target)) return res.status(404).json({ error: 'File not found' });
  try { execSync(`open -R "${target}"`); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/backups/restore', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'No file specified' });
  const filepath = path.join(getBackupDir(), filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup not found' });
  try {
    const backup = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (backup.config) {
      writeConfig(backup.config);
      if (backup.config.smtp) writeMsmtprc(backup.config.smtp);
      setupCron();
    }
    if (backup.presets && typeof backup.presets === 'object') {
      for (const [fn, content] of Object.entries(backup.presets)) {
        fs.writeFileSync(path.join(PRESETS_DIR, fn), JSON.stringify(content, null, 2));
      }
    } else if (backup.preset) {
      const pname = backup.preset.PresetList?.[0]?.PresetName || 'Default Preset';
      const fn = pname.replace(/[^a-zA-Z0-9 _\-]/g, '').trim() + '.json';
      fs.writeFileSync(path.join(PRESETS_DIR, fn), JSON.stringify(backup.preset, null, 2));
    }
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
    let config = {}; try { config = readConfig(); } catch {}
    let presets = {};
    try {
      const pfiles = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'));
      for (const f of pfiles) { try { presets[f] = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')); } catch {} }
    } catch {}
    const data = { exported: new Date().toISOString(), type: 'autoconvert-export', config, presets };
    res.setHeader('Content-Disposition', 'attachment; filename="autoconvert-export.json"');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import', (req, res) => {
  try {
    const data = req.body;
    if (data.type !== 'autoconvert-export') return res.status(400).json({ error: 'Invalid export file' });
    if (data.config) {
      writeConfig(data.config);
      if (data.config.smtp) writeMsmtprc(data.config.smtp);
      setupCron();
    }
    if (data.presets && typeof data.presets === 'object') {
      for (const [fn, content] of Object.entries(data.presets)) {
        fs.writeFileSync(path.join(PRESETS_DIR, fn), JSON.stringify(content, null, 2));
      }
    } else if (data.preset) {
      const pname = data.preset.PresetList?.[0]?.PresetName || 'Default Preset';
      const fn = pname.replace(/[^a-zA-Z0-9 _\-]/g, '').trim() + '.json';
      fs.writeFileSync(path.join(PRESETS_DIR, fn), JSON.stringify(data.preset, null, 2));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- TMDB Lookup ---
const TMDB_API_KEY = '08a78191b56b49e8c66ed4ff0beff5e8';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w154';
const tmdbCache = new Map();

function parseTitleYear(filename) {
  let m;
  m = filename.match(/^(.+?)\s*\((\d{4})\)\s*-\s*S(\d+)E(\d+)/);
  if (m) return { title: m[1].trim(), year: m[2], type: 'tv', season: +m[3], episode: +m[4] };
  m = filename.match(/^(.+?)\s*-\s*S(\d+)E(\d+)/);
  if (m) return { title: m[1].trim(), year: null, type: 'tv', season: +m[2], episode: +m[3] };
  m = filename.match(/^(.+?)[\.\s]+[Ss](\d+)[Ee](\d+)/);
  if (m) return { title: m[1].replace(/\./g, ' ').trim(), year: null, type: 'tv', season: +m[2], episode: +m[3] };
  m = filename.match(/^(.+?)\s*\((\d{4})\)/);
  if (m) return { title: m[1].trim(), year: m[2], type: 'movie', season: null, episode: null };
  return { title: filename, year: null, type: 'movie', season: null, episode: null };
}

async function tmdbRequest(apiPath, params = {}) {
  params.api_key = TMDB_API_KEY;
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.themoviedb.org/3${apiPath}?${qs}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('TMDB timeout')); }, 8000);
    const req = https.get(url, { headers: { 'User-Agent': 'AutoConvert/1.0' } }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function fetchTmdb(parsed) {
  const { title, year, type, season, episode } = parsed;
  try {
    if (type === 'movie') {
      const params = { query: title };
      if (year) params.year = year;
      const data = await tmdbRequest('/search/movie', params);
      if (data.results && data.results.length) {
        const r = data.results[0];
        return {
          title: r.title || title, year: (r.release_date || '').slice(0, 4),
          rating: r.vote_average || 0, overview: (r.overview || '').slice(0, 150),
          poster: r.poster_path ? `${TMDB_IMG_BASE}${r.poster_path}` : null,
        };
      }
    } else {
      const data = await tmdbRequest('/search/tv', { query: title });
      if (data.results && data.results.length) {
        const series = data.results[0];
        const seriesPoster = series.poster_path ? `${TMDB_IMG_BASE}${series.poster_path}` : null;
        if (season != null && episode != null) {
          try {
            const ep = await tmdbRequest(`/tv/${series.id}/season/${season}/episode/${episode}`);
            const still = ep.still_path ? `${TMDB_IMG_BASE}${ep.still_path}` : null;
            return {
              title: series.name || title, year: (series.first_air_date || '').slice(0, 4),
              rating: ep.vote_average || 0, overview: (ep.overview || '').slice(0, 150),
              poster: still || seriesPoster,
              ep_label: `S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`,
              ep_name: ep.name || '',
            };
          } catch {}
        }
        return {
          title: series.name || title, year: (series.first_air_date || '').slice(0, 4),
          rating: series.vote_average || 0, overview: (series.overview || '').slice(0, 150),
          poster: seriesPoster,
          ep_label: (season != null && episode != null) ? `S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : '',
        };
      }
    }
  } catch {}
  return { title, year: year || '', rating: 0, overview: '', poster: null };
}

app.post('/api/tmdb/lookup', async (req, res) => {
  const { files } = req.body;
  if (!Array.isArray(files)) return res.status(400).json({ error: 'files must be an array' });
  try {
    const results = await Promise.all(files.map(async (f) => {
      const parsed = parseTitleYear(f.name.replace(/\.mkv$/i, ''));
      const cacheKey = `${parsed.title.toLowerCase()}_${parsed.season || ''}_${parsed.episode || ''}`;
      if (tmdbCache.has(cacheKey)) return { ...f, tmdb: tmdbCache.get(cacheKey) };
      const tmdb = await fetchTmdb(parsed);
      tmdbCache.set(cacheKey, tmdb);
      return { ...f, tmdb };
    }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HandBrake info ---
app.get('/api/handbrake/encoders', (req, res) => {
  try {
    const output = execSync('HandBrakeCLI --help 2>&1', { timeout: 10000 }).toString();
    const video = [], audio = [];
    const vSection = output.match(/--encoder <string>[\s\S]*?(?=\s+--encoder-preset)/);
    if (vSection) {
      for (const line of vSection[0].split('\n').slice(1)) {
        const trimmed = line.trim();
        if (trimmed && /^[a-zA-Z0-9_]+$/.test(trimmed)) video.push(trimmed);
      }
    }
    const aSection = output.match(/--aencoder <string>[\s\S]*?(?=\s+--audio-copy-mask)/);
    if (aSection) {
      for (const line of aSection[0].split('\n').slice(1)) {
        const trimmed = line.trim();
        if (/^[a-zA-Z0-9_]+$/.test(trimmed) && trimmed !== 'none') audio.push(trimmed);
      }
    }
    let presetEncoder = '', presetAudio = '';
    try {
      const preset = JSON.parse(fs.readFileSync(getActivePresetFile(), 'utf8'));
      presetEncoder = preset.PresetList?.[0]?.VideoEncoder || '';
      presetAudio = preset.PresetList?.[0]?.AudioList?.[0]?.AudioEncoder || '';
    } catch {}
    res.json({ video, audio, presetEncoder, presetAudio, presetEncoderAvailable: video.includes(presetEncoder), presetAudioAvailable: audio.includes(presetAudio) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- App Settings ---
app.get('/api/app-settings', (req, res) => {
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

app.post('/api/app-settings', (req, res) => {
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

// --- Find MP4 path (for old reports without mp4_path) ---
app.post('/api/find-mp4', (req, res) => {
  const { section, basename } = req.body;
  if (!section || !basename) return res.status(400).json({ error: 'section and basename required' });
  const mediaDirs = getMediaDirs();
  const safeName = basename.replace(/["`$\\]/g, '');
  for (const dir of mediaDirs) {
    const dirName = path.basename(dir);
    if (dirName.toLowerCase() === section.toLowerCase()) {
      try {
        const found = execSync(`find "${dir}" -name "${safeName}.mp4" -type f 2>/dev/null | head -1`, { timeout: 5000 }).toString().trim();
        if (found) return res.json({ mp4_path: found });
      } catch {}
    }
  }
  res.json({ mp4_path: null });
});

// --- File Download ---
function sendDownloadNotification(filename, fileSize, ip, userAgent) {
  try {
    const config = readConfig();
    if (!config.app?.downloadNotify) return;
    const adminEmail = config.app?.adminEmail;
    if (!adminEmail) return;
    const smtp = config.smtp;
    if (!smtp || !smtp.host) return;

    const now = new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' });
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    // Try to identify the downloader from user-agent
    const ua = userAgent || 'Unknown';
    let device = 'Unknown device';
    if (/iPhone/i.test(ua)) device = 'iPhone';
    else if (/iPad/i.test(ua)) device = 'iPad';
    else if (/Android/i.test(ua)) device = 'Android';
    else if (/Mac OS/i.test(ua)) device = 'Mac';
    else if (/Windows/i.test(ua)) device = 'Windows PC';
    else if (/Linux/i.test(ua)) device = 'Linux';

    const emailContent = [
      `Content-Type: text/html; charset=utf-8`,
      `Subject: Download: ${filename}`,
      `From: ${smtp.from || 'noreply@autoconvert.local'}`,
      `To: ${adminEmail}`,
      ``,
      `<html><body style="font-family:-apple-system,Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px;">`,
      `<div style="background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">`,
      `<h3 style="color:#6366f1;margin:0 0 16px;">⬇ File Downloaded</h3>`,
      `<table style="font-size:14px;line-height:1.8;">`,
      `<tr><td style="color:#888;padding-right:12px;">File</td><td><strong>${filename}</strong></td></tr>`,
      `<tr><td style="color:#888;padding-right:12px;">Size</td><td>${sizeMB} MB</td></tr>`,
      `<tr><td style="color:#888;padding-right:12px;">Time</td><td>${now}</td></tr>`,
      `<tr><td style="color:#888;padding-right:12px;">Device</td><td>${device}</td></tr>`,
      `<tr><td style="color:#888;padding-right:12px;">IP</td><td>${ip || 'Unknown'}</td></tr>`,
      `</table>`,
      `</div></body></html>`,
    ].join('\n');
    const msmtpPath = fs.existsSync(MSMTP_BIN) ? MSMTP_BIN : 'msmtp';
    const tmpFile = '/tmp/autoconvert_dl_notify.txt';
    fs.writeFileSync(tmpFile, emailContent);
    execSync(`cat "${tmpFile}" | ${msmtpPath} ${adminEmail}`, { timeout: 15000 });
    try { fs.unlinkSync(tmpFile); } catch {}
    console.log(`[download] Notification sent to ${adminEmail} for ${filename}`);
  } catch (err) {
    console.error(`[download] Notification error: ${err.message}`);
  }
}

app.get('/api/download', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Missing path parameter' });

  // Security: resolve to absolute path and block traversal
  const resolved = path.resolve(filePath);
  if (resolved !== filePath && !filePath.startsWith('/')) {
    return res.status(403).json({ error: 'Invalid path' });
  }

  // Security: only allow .mp4 files
  if (path.extname(resolved).toLowerCase() !== '.mp4') {
    return res.status(403).json({ error: 'Only MP4 files can be downloaded' });
  }

  // Security: path must be within a configured media directory
  const mediaDirs = getMediaDirs();
  const isAllowed = mediaDirs.some(dir => resolved.startsWith(path.resolve(dir) + '/'));
  if (!isAllowed) {
    return res.status(403).json({ error: 'File is not within a media directory' });
  }

  // Check file exists
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const filename = path.basename(resolved);
  const stat = fs.statSync(resolved);

  // Send download notification to admin (async, don't block download)
  const clientIp = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || '';
  const userAgent = req.headers['user-agent'] || '';
  // Only notify on initial request, not range continuations
  const range = req.headers.range;
  if (!range) {
    setImmediate(() => sendDownloadNotification(filename, stat.size, clientIp, userAgent));
  }

  // Support range requests for large files (resume downloads)
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    });
    fs.createReadStream(resolved, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(resolved).pipe(res);
  }
});

// --- Disk Space ---
function getDiskSpace(dirPath) {
  try {
    const output = execSync('df -k "' + dirPath + '"', { timeout: 5000 }).toString();
    const lines = output.trim().split('\n');
    if (lines.length < 2) return null;
    // df -k output columns: Filesystem 1024-blocks Used Available Capacity Mounted
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

app.get('/api/disk-space', (req, res) => {
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

// --- Media Directories ---
app.get('/api/media-dirs', (req, res) => {
  res.json({ dirs: getMediaDirs() });
});

app.post('/api/media-dirs', (req, res) => {
  const { dir } = req.body;
  if (!dir || typeof dir !== 'string' || !dir.trim()) return res.status(400).json({ error: 'Directory path is required' });
  const cleaned = dir.trim().replace(/\/+$/, '');
  const config = readConfig();
  if (!config.mediaDirs) config.mediaDirs = getMediaDirs();
  if (config.mediaDirs.includes(cleaned)) return res.status(409).json({ error: 'Directory already exists' });
  config.mediaDirs.push(cleaned);
  writeConfig(config);
  dirCache = null;
  scanDirectories();
  res.json({ ok: true, dirs: config.mediaDirs });
});

app.delete('/api/media-dirs', (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: 'Directory path is required' });
  const config = readConfig();
  if (!config.mediaDirs) config.mediaDirs = getMediaDirs();
  const idx = config.mediaDirs.indexOf(dir);
  if (idx === -1) return res.status(404).json({ error: 'Directory not found' });
  config.mediaDirs.splice(idx, 1);
  writeConfig(config);
  dirCache = null;
  scanDirectories();
  res.json({ ok: true, dirs: config.mediaDirs });
});

// --- Version ---
app.get('/api/version', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'))); }
  catch { res.json({ version: '1.0', history: [] }); }
});

// --- Start ---
const PORT = process.env.PORT || readConfig().app?.port || 3742;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AutoConvert running on http://localhost:${PORT}`);
  setupCron();
});
