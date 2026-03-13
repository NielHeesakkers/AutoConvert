const router = require('express').Router();
const libraryScan = require('../lib/library-scan');

// GET /api/library/stats
router.get('/stats', async (req, res) => {
  let stats = libraryScan.getCachedStats();
  if (!stats) {
    // Trigger scan if no cache exists
    stats = await libraryScan.scan();
    if (!stats) return res.json({ scanning: true });
  }
  res.json(stats);
});

// POST /api/library/scan
router.post('/scan', (req, res) => {
  const status = libraryScan.getScanStatus();
  if (status.scanning) {
    return res.json({ ok: true, already: true, ...status });
  }
  // Start scan in background
  libraryScan.scan().catch(err => {
    console.error(`[library] Scan error: ${err.message}`);
  });
  res.json({ ok: true, scanning: true });
});

// GET /api/library/scan/status
router.get('/scan/status', (req, res) => {
  res.json(libraryScan.getScanStatus());
});

// POST /api/library/scan/cancel
router.post('/scan/cancel', (req, res) => {
  const cancelled = libraryScan.cancelScan();
  res.json({ ok: true, cancelled });
});

module.exports = router;
