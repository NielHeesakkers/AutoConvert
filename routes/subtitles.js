const router = require('express').Router();
const subtitles = require('../lib/subtitles');

// GET /api/subtitles/status
router.get('/status', (req, res) => {
  const cfg = subtitles.getConfig();
  res.json({
    enabled: cfg.enabled,
    hasApiKey: !!cfg.apiKey,
    languages: cfg.languages || ['nl', 'en'],
  });
});

// POST /api/subtitles/config
router.post('/config', (req, res) => {
  const { apiKey, languages, enabled } = req.body;
  subtitles.saveConfig({ apiKey, languages, enabled });
  res.json({ ok: true });
});

// POST /api/subtitles/toggle
router.post('/toggle', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }
  subtitles.saveConfig({ enabled });
  res.json({ ok: true, enabled });
});

// POST /api/subtitles/test
router.post('/test', async (req, res) => {
  const cfg = subtitles.getConfig();
  const apiKey = req.body.apiKey || cfg.apiKey;
  try {
    const result = await subtitles.testApiKey(apiKey);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
