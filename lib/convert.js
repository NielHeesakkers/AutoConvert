const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const {
  APP_DIR, APP_MODE, CONFIG_PATH, LOG_DIR, REPORTS_DIR, LOCK_FILE, SCRIPT_PATH,
  readConfig, getMediaDirs, getActivePresetFile,
} = require('./config');

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
    // Post-conversion hooks
    runPostConversionHooks();
  });
  child.unref();
  console.log(`[convert] Script spawned with PID ${child.pid}`);
  return child.pid;
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

async function runPostConversionHooks() {
  // Subtitle fetch (runs before Plex so subs are available when library refreshes)
  try {
    const subtitles = require('./subtitles');
    await subtitles.fetchForLatestReport();
  } catch (err) {
    console.error(`[convert] Subtitle fetch hook error: ${err.message}`);
  }

  // Plex refresh
  try {
    const plex = require('./plex');
    await plex.refreshIfEnabled();
  } catch (err) {
    console.error(`[convert] Plex refresh hook error: ${err.message}`);
  }
}

module.exports = { runConvertScript, isRunning, checkDiskSpaceWarnings };
