const https = require('https');

const TMDB_API_KEY = '08a78191b56b49e8c66ed4ff0beff5e8';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w300';
const TMDB_CACHE_MAX = 2000;
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
    const req = https.get(url, { headers: { 'User-Agent': 'AutoConvert/2.1' } }, res => {
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
          id: r.id, media_type: 'movie',
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
              id: series.id, media_type: 'tv',
              title: series.name || title, year: (series.first_air_date || '').slice(0, 4),
              rating: ep.vote_average || 0, overview: (ep.overview || '').slice(0, 150),
              poster: still || seriesPoster,
              ep_label: `S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`,
              ep_name: ep.name || '',
            };
          } catch {}
        }
        return {
          id: series.id, media_type: 'tv',
          title: series.name || title, year: (series.first_air_date || '').slice(0, 4),
          rating: series.vote_average || 0, overview: (series.overview || '').slice(0, 150),
          poster: seriesPoster,
          ep_label: (season != null && episode != null) ? `S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : '',
        };
      }
    }
  } catch {}
  return { id: null, media_type: type || 'movie', title, year: year || '', rating: 0, overview: '', poster: null };
}

function getCacheKey(parsed) {
  return `${parsed.title.toLowerCase()}_${parsed.year || ''}_${parsed.season || ''}_${parsed.episode || ''}`;
}

async function lookupFile(filename) {
  const parsed = parseTitleYear(filename.replace(/\.\w{2,4}$/, ''));
  const key = getCacheKey(parsed);
  if (tmdbCache.has(key)) return tmdbCache.get(key);
  const result = await fetchTmdb(parsed);
  // Evict oldest entries when cache exceeds limit
  if (tmdbCache.size >= TMDB_CACHE_MAX) {
    const firstKey = tmdbCache.keys().next().value;
    tmdbCache.delete(firstKey);
  }
  tmdbCache.set(key, result);
  return result;
}

module.exports = { parseTitleYear, fetchTmdb, lookupFile, tmdbCache, getCacheKey, TMDB_API_KEY, TMDB_IMG_BASE };
