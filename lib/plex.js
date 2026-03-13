const http = require('http');
const https = require('https');
const { readConfig, writeConfig, getMediaDirs } = require('./config');

function getConfig() {
  const config = readConfig();
  return config.plex || { enabled: false, url: 'http://localhost:32400', token: '', libraryIds: [] };
}

function plexRequest(plexUrl, plexToken, apiPath, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const base = plexUrl.replace(/\/+$/, '');
    const separator = apiPath.includes('?') ? '&' : '?';
    const fullUrl = `${base}${apiPath}${separator}X-Plex-Token=${plexToken}`;
    const parsed = new URL(fullUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.get(fullUrl, {
      headers: { Accept: 'application/json' },
      timeout,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 204) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else if (res.statusCode === 401) {
          reject(new Error('Plex token is invalid or expired. Check your token in Plex settings.'));
        } else {
          reject(new Error(`Plex returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Plex connection timed out — is Plex running?')); });
    req.on('error', err => {
      if (err.code === 'ECONNREFUSED') reject(new Error('Cannot connect to Plex — is the server running?'));
      else reject(new Error(`Plex connection error: ${err.message}`));
    });
  });
}

async function testConnection(url, token) {
  if (!url || !token) throw new Error('Plex URL and token are required');
  const data = await plexRequest(url, token, '/library/sections');
  const dirs = data?.MediaContainer?.Directory || [];
  return dirs.map(d => ({
    id: String(d.key),
    title: d.title,
    type: d.type,
    locations: (d.Location || []).map(l => l.path),
  }));
}

async function refreshLibraries(url, token, libraryIds) {
  const refreshed = [];
  for (const id of libraryIds) {
    try {
      await plexRequest(url, token, `/library/sections/${id}/refresh`);
      refreshed.push(id);
      console.log(`[plex] Refreshed library ${id}`);
    } catch (err) {
      console.warn(`[plex] Failed to refresh library ${id}: ${err.message}`);
    }
  }
  return refreshed;
}

async function refreshIfEnabled() {
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.url || !cfg.token) return;

  try {
    let ids = cfg.libraryIds || [];

    // If no specific libraries configured, discover and refresh all
    if (ids.length === 0) {
      const libraries = await testConnection(cfg.url, cfg.token);
      ids = libraries.map(l => l.id);
    }

    if (ids.length === 0) {
      console.log('[plex] No libraries found to refresh');
      return;
    }

    const refreshed = await refreshLibraries(cfg.url, cfg.token, ids);
    console.log(`[plex] Refreshed ${refreshed.length} librar${refreshed.length === 1 ? 'y' : 'ies'}`);
  } catch (err) {
    console.error(`[plex] Auto-refresh failed: ${err.message}`);
  }
}

function saveConfig({ url, token, libraryIds }) {
  const config = readConfig();
  if (!config.plex) config.plex = {};
  if (url !== undefined) config.plex.url = url.replace(/\/+$/, '');
  if (token !== undefined) config.plex.token = token;
  if (libraryIds !== undefined) config.plex.libraryIds = libraryIds;
  writeConfig(config);
}

function toggle(enabled) {
  const config = readConfig();
  if (!config.plex) config.plex = {};
  config.plex.enabled = enabled;
  writeConfig(config);
}

module.exports = { getConfig, testConnection, refreshLibraries, refreshIfEnabled, saveConfig, toggle };
