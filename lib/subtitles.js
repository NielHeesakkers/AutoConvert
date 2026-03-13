const fs = require('fs');
const path = require('path');
const https = require('https');
const { readConfig, writeConfig, REPORTS_DIR } = require('./config');

const API_BASE = 'https://api.opensubtitles.com/api/v1';
const DELAY_MS = 250; // rate limit: max 5 req/sec

function getConfig() {
  const config = readConfig();
  return config.subtitles || { enabled: false, apiKey: '', languages: ['nl', 'en'] };
}

function resolveUrl(baseUrl, location) {
  // Handle relative redirect URLs (e.g. /api/v1/subtitles?...)
  if (location.startsWith('http://') || location.startsWith('https://')) return location;
  const base = new URL(baseUrl);
  return `${base.protocol}//${base.host}${location}`;
}

function apiRequest(endpoint, apiKey, params = {}) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams(params).toString();
    const url = `${API_BASE}${endpoint}${query ? '?' + query : ''}`;
    const headers = {
      'Api-Key': apiKey,
      'User-Agent': 'AutoConvert v2.1',
      Accept: 'application/json',
    };

    const doGet = (reqUrl, redirectCount = 0) => {
      if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
      const req = https.get(reqUrl, { headers, timeout: 10000 }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const nextUrl = resolveUrl(reqUrl, res.headers.location);
          doGet(nextUrl, redirectCount + 1);
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode === 200) resolve(json);
            else reject(new Error(json.message || `HTTP ${res.statusCode}`));
          } catch { reject(new Error(`Invalid response (HTTP ${res.statusCode}): ${data.slice(0, 200)}`)); }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.on('error', reject);
    };
    doGet(url);
  });
}

function downloadRequest(fileId, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ file_id: fileId });
    const parsed = new URL(`${API_BASE}/download`);

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'User-Agent': 'AutoConvert v2.1',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 10000,
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect as GET, resolve relative URLs
        const redirectUrl = resolveUrl(`${parsed.protocol}//${parsed.host}${parsed.pathname}`, res.headers.location);
        const getReq = https.get(redirectUrl, {
          headers: { 'Api-Key': apiKey, 'User-Agent': 'AutoConvert v2.1', Accept: 'application/json' },
          timeout: 10000,
        }, res2 => {
          let data = '';
          res2.on('data', chunk => data += chunk);
          res2.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (res2.statusCode === 200) resolve(json);
              else reject(new Error(json.message || `HTTP ${res2.statusCode}`));
            } catch { reject(new Error(`Download response error: ${res2.statusCode}`)); }
          });
        });
        getReq.on('timeout', () => { getReq.destroy(); reject(new Error('Download redirect timed out')); });
        getReq.on('error', reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200) resolve(json);
          else reject(new Error(json.message || `HTTP ${res.statusCode}`));
        } catch { reject(new Error(`Download response error: ${res.statusCode}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, { timeout: 30000 }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        const nextUrl = resolveUrl(url, res.headers.location);
        downloadFile(nextUrl, destPath).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => {
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testApiKey(apiKey) {
  if (!apiKey) throw new Error('API key is required');
  // Search for a known movie to test the key
  const result = await apiRequest('/subtitles', apiKey, { tmdb_id: 550, languages: 'en' });
  return { ok: true, totalCount: result.total_count || 0 };
}

async function fetchForReport(reportPath) {
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.apiKey || !cfg.languages.length) return;

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    console.error(`[subs] Failed to read report: ${err.message}`);
    return;
  }

  const converted = report.converted || [];
  let fetched = 0;

  for (const item of converted) {
    const tmdb = item.tmdb || {};
    const tmdbId = tmdb.id;
    if (!tmdbId) {
      console.log(`[subs] No TMDB ID for ${item.basename}, skipping`);
      continue;
    }

    const mp4Path = item.mp4_path;
    if (!mp4Path || !fs.existsSync(mp4Path)) continue;

    const dir = path.dirname(mp4Path);
    const base = path.basename(mp4Path, path.extname(mp4Path));

    for (const lang of cfg.languages) {
      const srtPath = path.join(dir, `${base}.${lang}.srt`);
      if (fs.existsSync(srtPath)) {
        console.log(`[subs] Already exists: ${path.basename(srtPath)}`);
        continue;
      }

      try {
        await sleep(DELAY_MS);
        const searchParams = {
          tmdb_id: tmdbId,
          languages: lang,
        };
        if (tmdb.media_type === 'tv' && tmdb.ep_label) {
          const m = tmdb.ep_label.match(/S(\d+)E(\d+)/);
          if (m) {
            searchParams.season_number = parseInt(m[1]);
            searchParams.episode_number = parseInt(m[2]);
          }
        }

        const result = await apiRequest('/subtitles', cfg.apiKey, searchParams);
        const subs = (result.data || []).filter(s => s.attributes?.files?.length > 0);

        if (subs.length === 0) {
          console.log(`[subs] No ${lang} subtitles found for ${tmdb.title || item.basename}`);
          continue;
        }

        // Pick best rated subtitle
        subs.sort((a, b) => (b.attributes.download_count || 0) - (a.attributes.download_count || 0));
        const fileId = subs[0].attributes.files[0].file_id;

        await sleep(DELAY_MS);
        const dlResult = await downloadRequest(fileId, cfg.apiKey);
        if (!dlResult.link) {
          console.warn(`[subs] No download link for ${tmdb.title} (${lang})`);
          continue;
        }

        await downloadFile(dlResult.link, srtPath);
        console.log(`[subs] Downloaded: ${path.basename(srtPath)}`);
        fetched++;

        // Track in report
        if (!item.subtitles) item.subtitles = [];
        item.subtitles.push(lang);
      } catch (err) {
        console.warn(`[subs] Failed to fetch ${lang} for ${tmdb.title || item.basename}: ${err.message}`);
      }
    }
  }

  // Update report with subtitle info
  if (fetched > 0) {
    try {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`[subs] Updated report with ${fetched} subtitle(s)`);
    } catch {}
  }

  console.log(`[subs] Done: ${fetched} subtitle(s) downloaded`);
}

function getLatestReportPath() {
  try {
    const files = fs.readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();
    if (files.length === 0) return null;
    return path.join(REPORTS_DIR, files[files.length - 1]);
  } catch { return null; }
}

async function fetchForLatestReport() {
  const reportPath = getLatestReportPath();
  if (!reportPath) {
    console.log('[subs] No report found');
    return;
  }
  await fetchForReport(reportPath);
}

function saveConfig({ apiKey, languages, enabled }) {
  const config = readConfig();
  if (!config.subtitles) config.subtitles = {};
  if (apiKey !== undefined) config.subtitles.apiKey = apiKey;
  if (languages !== undefined) config.subtitles.languages = languages;
  if (enabled !== undefined) config.subtitles.enabled = enabled;
  writeConfig(config);
}

module.exports = { getConfig, testApiKey, fetchForReport, fetchForLatestReport, saveConfig };
