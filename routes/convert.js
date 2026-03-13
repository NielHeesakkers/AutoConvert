const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const {
  LOG_PATH, LOCK_FILE, PROGRESS_FILE, HB_LOG_FILE, MSMTP_BIN,
  readConfig, getMediaDirs, getActivePresetFile,
} = require('../lib/config');
const { runConvertScript, isRunning, checkDiskSpaceWarnings } = require('../lib/convert');
const { scanDirectories, getDirCache, clearDirCache } = require('../lib/directories');

// Status
router.get('/status', (req, res) => {
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
router.get('/convert/progress', (req, res) => {
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

router.post('/convert/progress/clear', (req, res) => {
  try { fs.unlinkSync(PROGRESS_FILE); } catch {}
  res.json({ ok: true });
});

// Manual scan
router.post('/scan', (req, res) => {
  clearDirCache();
  scanDirectories();
  res.json({ ok: true });
});

// Directories
router.get('/directories', (req, res) => {
  const cache = getDirCache();
  if (cache) {
    res.json(cache);
  } else {
    const dirs = getMediaDirs();
    res.json({
      directories: dirs.map(d => ({ path: d, name: path.basename(d), exists: true, fileCount: 0, files: [], scanning: true })),
      scanning: true,
    });
  }
  if (!cache || Date.now() - cache.scannedAt > 300000) scanDirectories();
});

// Force convert
router.post('/convert', (req, res) => {
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
router.post('/convert/stop', (req, res) => {
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

// Find MP4 path (for old reports without mp4_path)
router.post('/find-mp4', (req, res) => {
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

// File Download
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

router.get('/download', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Missing path parameter' });

  const resolved = path.resolve(filePath);
  if (resolved !== filePath && !filePath.startsWith('/')) {
    return res.status(403).json({ error: 'Invalid path' });
  }

  if (path.extname(resolved).toLowerCase() !== '.mp4') {
    return res.status(403).json({ error: 'Only MP4 files can be downloaded' });
  }

  const mediaDirs = getMediaDirs();
  const isAllowed = mediaDirs.some(dir => resolved.startsWith(path.resolve(dir) + '/'));
  if (!isAllowed) {
    return res.status(403).json({ error: 'File is not within a media directory' });
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const filename = path.basename(resolved);
  const stat = fs.statSync(resolved);

  const clientIp = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || '';
  const userAgent = req.headers['user-agent'] || '';
  const range = req.headers.range;
  if (!range) {
    setImmediate(() => sendDownloadNotification(filename, stat.size, clientIp, userAgent));
  }

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

router.post('/tmdb/lookup', async (req, res) => {
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

module.exports = router;
