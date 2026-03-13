const router = require('express').Router();
const plex = require('../lib/plex');

// GET /api/plex/status
router.get('/status', (req, res) => {
  const cfg = plex.getConfig();
  res.json({
    enabled: cfg.enabled,
    url: cfg.url || 'http://localhost:32400',
    hasToken: !!cfg.token,
    libraryIds: cfg.libraryIds || [],
  });
});

// POST /api/plex/config
router.post('/config', (req, res) => {
  const { url, token, libraryIds } = req.body;
  plex.saveConfig({ url, token, libraryIds });
  res.json({ ok: true });
});

// POST /api/plex/toggle
router.post('/toggle', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }
  plex.toggle(enabled);
  res.json({ ok: true, enabled });
});

// POST /api/plex/test
router.post('/test', async (req, res) => {
  const cfg = plex.getConfig();
  const url = req.body.url || cfg.url;
  const token = req.body.token || cfg.token;
  try {
    const libraries = await plex.testConnection(url, token);
    res.json({ ok: true, libraries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/plex/refresh
router.post('/refresh', async (req, res) => {
  const cfg = plex.getConfig();
  if (!cfg.url || !cfg.token) {
    return res.status(400).json({ error: 'Plex not configured' });
  }
  try {
    const ids = cfg.libraryIds?.length ? cfg.libraryIds : (await plex.testConnection(cfg.url, cfg.token)).map(l => l.id);
    const refreshed = await plex.refreshLibraries(cfg.url, cfg.token, ids);
    res.json({ ok: true, refreshed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
