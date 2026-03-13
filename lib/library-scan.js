const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { readConfig, getMediaDirs, APP_MODE, APP_SUPPORT, APP_DIR, REPORTS_DIR } = require('./config');

const CACHE_PATH = APP_MODE
  ? path.join(APP_SUPPORT, 'library_cache.json')
  : path.join(APP_DIR, 'library_cache.json');
const CACHE_MAX_AGE = 60 * 60 * 1000; // 1 hour

let scanning = false;
let scanProgress = { current: 0, total: 0 };
let cancelRequested = false;

function hasFfprobe() {
  try {
    execSync('which ffprobe', { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function ffprobeFile(filePath) {
  try {
    const out = execSync(
      `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath.replace(/"/g, '\\"')}"`,
      { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString();
    return JSON.parse(out);
  } catch { return null; }
}

function walkDir(dirPath, files = []) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walkDir(full, files);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm'].includes(ext)) {
          files.push(full);
        }
      }
    }
  } catch {}
  return files;
}

function getResolutionLabel(height) {
  if (!height) return 'other';
  if (height >= 2100) return '4K';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  if (height >= 460) return '480p';
  return 'other';
}

function getCodecLabel(codec) {
  if (!codec) return 'other';
  const c = codec.toLowerCase();
  if (c.includes('hevc') || c.includes('h265') || c.includes('hev1')) return 'hevc';
  if (c.includes('h264') || c.includes('avc') || c.includes('x264')) return 'h264';
  if (c.includes('av1')) return 'av1';
  if (c.includes('vp9')) return 'vp9';
  return 'other';
}

async function scan() {
  if (scanning) return { error: 'Scan already in progress' };

  scanning = true;
  cancelRequested = false;
  scanProgress = { current: 0, total: 0 };

  const mediaDirs = getMediaDirs();
  const useFfprobe = hasFfprobe();
  console.log(`[library] Starting scan (ffprobe: ${useFfprobe ? 'yes' : 'no'})`);

  const stats = {
    scannedAt: new Date().toISOString(),
    totalFiles: 0,
    totalSizeBytes: 0,
    byFormat: {},
    byCodec: {},
    byResolution: {},
    byDirectory: [],
    conversionHistory: [],
  };

  // Collect all files
  const allFiles = [];
  for (const dir of mediaDirs) {
    const dirFiles = walkDir(dir);
    const dirStat = { name: path.basename(dir), path: dir, files: dirFiles.length, sizeBytes: 0 };
    for (const f of dirFiles) {
      try {
        const s = fs.statSync(f);
        dirStat.sizeBytes += s.size;
      } catch {}
    }
    stats.byDirectory.push(dirStat);
    allFiles.push(...dirFiles);
  }

  scanProgress.total = allFiles.length;
  stats.totalFiles = allFiles.length;

  // Process each file
  for (let i = 0; i < allFiles.length; i++) {
    if (cancelRequested) {
      console.log('[library] Scan cancelled');
      scanning = false;
      return null;
    }

    const filePath = allFiles[i];
    scanProgress.current = i + 1;

    try {
      const fstat = fs.statSync(filePath);
      stats.totalSizeBytes += fstat.size;
    } catch {}

    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    stats.byFormat[ext] = (stats.byFormat[ext] || 0) + 1;

    if (useFfprobe) {
      const probe = ffprobeFile(filePath);
      if (probe) {
        const videoStream = (probe.streams || []).find(s => s.codec_type === 'video');
        if (videoStream) {
          const codec = getCodecLabel(videoStream.codec_name);
          stats.byCodec[codec] = (stats.byCodec[codec] || 0) + 1;

          const height = videoStream.height || parseInt(videoStream.coded_height) || 0;
          const res = getResolutionLabel(height);
          stats.byResolution[res] = (stats.byResolution[res] || 0) + 1;
        }
      }
    }
  }

  // Conversion history from report files
  stats.conversionHistory = loadConversionHistory();

  // Cache results
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(stats, null, 2));
    console.log(`[library] Scan complete: ${stats.totalFiles} files`);
  } catch (err) {
    console.error(`[library] Failed to write cache: ${err.message}`);
  }

  scanning = false;
  return stats;
}

function loadConversionHistory() {
  const history = [];
  try {
    const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort();
    const dayMap = new Map();

    for (const file of files) {
      try {
        const report = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, file), 'utf8'));
        const date = (report.date || '').split('T')[0];
        if (!date) continue;

        if (!dayMap.has(date)) dayMap.set(date, { converted: 0, failed: 0 });
        const day = dayMap.get(date);

        const results = report.results || [];
        for (const r of results) {
          if (r.status === 'done' || r.status === 'ok') day.converted++;
          else if (r.status === 'failed' || r.status === 'error') day.failed++;
        }
      } catch {}
    }

    for (const [date, counts] of dayMap) {
      history.push({ date, ...counts });
    }
  } catch {}
  return history.slice(-30); // last 30 days
}

function getCachedStats() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    const age = Date.now() - new Date(data.scannedAt).getTime();
    if (age > CACHE_MAX_AGE) return null;
    return data;
  } catch { return null; }
}

function getScanStatus() {
  return {
    scanning,
    progress: scanning ? `${scanProgress.current}/${scanProgress.total}` : null,
    current: scanProgress.current,
    total: scanProgress.total,
  };
}

function cancelScan() {
  if (scanning) {
    cancelRequested = true;
    return true;
  }
  return false;
}

module.exports = { scan, getCachedStats, getScanStatus, cancelScan };
