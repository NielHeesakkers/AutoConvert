const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { readConfig, writeConfig, getMediaDirs } = require('./config');
const { runConvertScript, isRunning } = require('./convert');

let watcher = null;
let watchedDirs = [];
let pendingFiles = new Map(); // filePath → { size, checks, timer }
let queue = [];
let processing = false;

function getConfig() {
  const config = readConfig();
  return config.watch || { enabled: false, stabilitySeconds: 30 };
}

function init() {
  const cfg = getConfig();
  if (cfg.enabled) start();
}

function start() {
  stop(); // clean up any existing watcher

  const dirs = getMediaDirs();
  const validDirs = dirs.filter(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });

  if (validDirs.length === 0) {
    console.log('[watch] No valid directories to watch');
    return;
  }

  console.log(`[watch] Starting watcher on ${validDirs.length} directories`);
  watchedDirs = validDirs;

  watcher = chokidar.watch(validDirs, {
    persistent: true,
    ignoreInitial: true,
    depth: 20,
    awaitWriteFinish: false, // we do our own stability check
    ignored: [
      /(^|[/\\])\../, // dotfiles
      /node_modules/,
    ],
  });

  watcher.on('add', filePath => {
    if (!filePath.toLowerCase().endsWith('.mkv')) return;
    console.log(`[watch] New MKV detected: ${path.basename(filePath)}`);
    startStabilityCheck(filePath);
  });

  watcher.on('error', err => {
    console.error(`[watch] Watcher error: ${err.message}`);
  });
}

function stop() {
  if (watcher) {
    watcher.close().catch(() => {});
    watcher = null;
  }
  // Clear all pending stability checks
  for (const [, entry] of pendingFiles) {
    clearInterval(entry.timer);
  }
  pendingFiles.clear();

  if (queue.length > 0) {
    console.log(`[watch] Cleared ${queue.length} queued files`);
    queue = [];
  }
  watchedDirs = [];
  processing = false;
}

function startStabilityCheck(filePath) {
  const cfg = getConfig();
  const stabilitySeconds = cfg.stabilitySeconds || 30;
  const requiredChecks = Math.ceil(stabilitySeconds / 10); // check every 10s

  let lastSize = -1;
  let stableCount = 0;

  const timer = setInterval(() => {
    try {
      const stat = fs.statSync(filePath);
      const currentSize = stat.size;

      if (currentSize === lastSize) {
        stableCount++;
        if (stableCount >= requiredChecks) {
          clearInterval(timer);
          pendingFiles.delete(filePath);
          console.log(`[watch] File stable: ${path.basename(filePath)} (${(currentSize / (1024*1024)).toFixed(0)} MB)`);
          enqueue(filePath);
        }
      } else {
        stableCount = 0;
        lastSize = currentSize;
      }
    } catch {
      // File was deleted or moved before stable
      console.log(`[watch] File removed during stability check: ${path.basename(filePath)}`);
      clearInterval(timer);
      pendingFiles.delete(filePath);
    }
  }, 10000);

  // Initial size read
  try {
    lastSize = fs.statSync(filePath).size;
  } catch {
    clearInterval(timer);
    return;
  }

  pendingFiles.set(filePath, { timer });
}

function enqueue(filePath) {
  queue.push(filePath);
  processQueue();
}

function processQueue() {
  if (processing || queue.length === 0) return;
  if (isRunning()) {
    console.log(`[watch] Conversion already running, ${queue.length} file(s) queued`);
    return;
  }

  processing = true;
  const filePath = queue.shift();
  console.log(`[watch] Auto-converting: ${path.basename(filePath)}`);

  // Use file order to convert just this file (pass it as the first in order)
  runConvertScript([], [filePath]);

  // Poll for completion
  const pollTimer = setInterval(() => {
    if (!isRunning()) {
      clearInterval(pollTimer);
      processing = false;
      console.log(`[watch] Conversion finished for: ${path.basename(filePath)}`);
      if (queue.length > 0) {
        console.log(`[watch] Processing next queued file (${queue.length} remaining)`);
        processQueue();
      }
    }
  }, 5000);
}

function status() {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    watching: watcher !== null,
    directories: watchedDirs,
    pendingFiles: pendingFiles.size,
    queueLength: queue.length,
    stabilitySeconds: cfg.stabilitySeconds || 30,
  };
}

function toggle(enabled) {
  const config = readConfig();
  if (!config.watch) config.watch = {};
  config.watch.enabled = enabled;
  writeConfig(config);

  if (enabled) {
    start();
    console.log('[watch] Watcher enabled');
  } else {
    stop();
    console.log('[watch] Watcher disabled');
  }
}

function updateConfig({ stabilitySeconds }) {
  const config = readConfig();
  if (!config.watch) config.watch = {};
  if (stabilitySeconds != null) {
    config.watch.stabilitySeconds = Math.max(10, Math.min(300, Number(stabilitySeconds) || 30));
  }
  writeConfig(config);

  // Restart watcher if running to pick up changes
  if (watcher) {
    console.log('[watch] Config updated, restarting watcher');
    start();
  }
}

function restart() {
  if (getConfig().enabled) {
    console.log('[watch] Restarting watcher (directories changed)');
    start();
  }
}

module.exports = { init, start, stop, restart, status, toggle, updateConfig };
