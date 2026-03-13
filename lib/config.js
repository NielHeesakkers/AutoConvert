const fs = require('fs');
const path = require('path');

// --- Mode & Paths ---
const APP_MODE = process.env.AUTOCONVERT_APP === 'true';
const APP_SUPPORT = APP_MODE
  ? path.join(process.env.HOME, 'Library', 'Application Support', 'AutoConvert')
  : null;
const APP_DIR = path.join(__dirname, '..');

const CONFIG_PATH = APP_MODE
  ? path.join(APP_SUPPORT, 'config.json')
  : path.join(APP_DIR, 'config.json');
const SCRIPT_PATH = path.join(APP_DIR, 'scripts', 'daily_mkv_convert.sh');
const LOG_DIR = APP_MODE ? APP_SUPPORT : APP_DIR;
const LOG_PATH = path.join(LOG_DIR, 'daily_convert.log');
const REPORTS_DIR = path.join(LOG_DIR, 'reports');
const PRESETS_DIR = APP_MODE
  ? path.join(APP_SUPPORT, 'presets')
  : path.join(APP_DIR, 'scripts', 'presets');
const LOCK_FILE = '/tmp/daily_mkv_convert.lock';
const PROGRESS_FILE = '/tmp/mkv_convert_progress.json';
const HB_LOG_FILE = '/tmp/mkv_convert_hb.log';
const MSMTP_BIN = APP_MODE
  ? path.join(APP_DIR, '..', 'Resources', 'msmtp')
  : '/opt/homebrew/bin/msmtp';
const MSMTPRC_PATH = path.join(process.env.HOME, '.msmtprc');
const DEFAULT_BACKUP_DIR = APP_MODE
  ? path.join(APP_SUPPORT, 'backups')
  : path.join(APP_DIR, 'backups');
const VERSION_FILE = path.join(APP_DIR, 'version.json');

// --- Users ---
const USERS_PATH = APP_MODE
  ? path.join(APP_SUPPORT, 'users.json')
  : path.join(APP_DIR, 'users.json');

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); } catch {}
  return [];
}
function writeUsers(users) {
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), { mode: 0o600 });
}
function isAuthEnabled() { return readUsers().length > 0; }

// --- Config ---
const DEFAULT_CONFIG = {
  recipients: [],
  smtp: { host: '', port: 587, user: '', password: '', from: '', tls: true, starttls: true },
  schedule: { hour: 3, minute: 0, scanInterval: 0 },
  watch: { enabled: false, stabilitySeconds: 30 },
  subtitles: { enabled: false, apiKey: '', languages: ['nl', 'en'] },
  plex: { enabled: false, url: 'http://localhost:32400', token: '', libraryIds: [] },
};

function deepMerge(target, defaults) {
  for (const key of Object.keys(defaults)) {
    if (!(key in target)) {
      target[key] = defaults[key];
    } else if (typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
      deepMerge(target[key], defaults[key]);
    }
  }
  return target;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return deepMerge(config, DEFAULT_CONFIG);
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

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

// --- Backup & Presets ---
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

module.exports = {
  APP_MODE, APP_SUPPORT, APP_DIR,
  CONFIG_PATH, SCRIPT_PATH, LOG_DIR, LOG_PATH, REPORTS_DIR, PRESETS_DIR,
  LOCK_FILE, PROGRESS_FILE, HB_LOG_FILE, MSMTP_BIN, MSMTPRC_PATH, VERSION_FILE,
  DEFAULT_BACKUP_DIR, USERS_PATH, DEFAULT_CONFIG,
  readConfig, writeConfig, getMediaDirs, getBackupDir,
  getActivePresetFile, readPresetDetails, deepMerge,
  readUsers, writeUsers, isAuthEnabled,
};
