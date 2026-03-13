const router = require('express').Router();
const watcher = require('../lib/watcher');

// GET /api/watch/status
router.get('/status', (req, res) => {
  res.json(watcher.status());
});

// POST /api/watch/toggle
router.post('/toggle', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }
  watcher.toggle(enabled);
  res.json({ ok: true, ...watcher.status() });
});

// POST /api/watch/config
router.post('/config', (req, res) => {
  const { stabilitySeconds } = req.body;
  watcher.updateConfig({ stabilitySeconds });
  res.json({ ok: true, ...watcher.status() });
});

module.exports = router;
