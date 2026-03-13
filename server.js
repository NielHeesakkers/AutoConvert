const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');

const {
  APP_MODE, APP_SUPPORT, APP_DIR,
  LOG_DIR, LOG_PATH, REPORTS_DIR, PRESETS_DIR,
  readConfig, isAuthEnabled,
} = require('./lib/config');
const { writeMsmtprc } = require('./lib/email');
const { setupCron } = require('./lib/cron');
const watcher = require('./lib/watcher');

const app = express();
app.use(express.json({ limit: '10mb' }));

// --- Session ---
const SECRET_PATH = APP_MODE
  ? path.join(APP_SUPPORT, '.session-secret')
  : path.join(APP_DIR, '.session-secret');
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

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (req.path.startsWith('/auth/')) return next();
  if (req.path === '/download') return next();
  if (!isAuthEnabled()) return next();
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}
app.use('/api', requireAuth);

// Serve login page for unauthenticated users
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (!isAuthEnabled()) return next();
  if (req.session && req.session.user) return next();
  return res.sendFile(path.join(APP_DIR, 'public', 'login.html'));
});

app.use(express.static(path.join(APP_DIR, 'public')));

// --- Init ---
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(REPORTS_DIR, { recursive: true }); } catch {}
try {
  const { getBackupDir } = require('./lib/config');
  fs.mkdirSync(getBackupDir(), { recursive: true });
} catch {}
if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '');

// Migrate default preset if needed
try {
  if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });
  const defaultPreset = path.join(PRESETS_DIR, 'Default Preset.json');
  if (!fs.existsSync(defaultPreset)) {
    const legacyPreset = path.join(APP_DIR, 'scripts', 'Niel.json');
    if (fs.existsSync(legacyPreset)) {
      fs.copyFileSync(legacyPreset, defaultPreset);
    }
  }
} catch {}

// Write msmtprc from config if smtp configured
try {
  const config = readConfig();
  if (config.smtp && config.smtp.host) {
    writeMsmtprc(config.smtp);
  }
} catch {}

// --- Mount routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/debug', require('./routes/debug'));
// Flat-mounted routers at /api
app.use('/api', require('./routes/convert'));
app.use('/api', require('./routes/settings'));
app.use('/api', require('./routes/presets'));
app.use('/api', require('./routes/backup'));
app.use('/api/watch', require('./routes/watch'));
app.use('/api/plex', require('./routes/plex'));
app.use('/api/library', require('./routes/library'));
app.use('/api/subtitles', require('./routes/subtitles'));

// --- Start ---
const PORT = process.env.PORT || readConfig().app?.port || 3742;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AutoConvert running on http://localhost:${PORT}`);
  setupCron();
  watcher.init();
});
