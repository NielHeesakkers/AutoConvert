const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  PRESETS_DIR, REPORTS_DIR,
  readConfig, writeConfig, getBackupDir,
} = require('../lib/config');
const { writeMsmtprc } = require('../lib/email');
const { setupCron } = require('../lib/cron');

router.get('/backups', (req, res) => {
  try {
    let files = [];
    try { files = fs.readdirSync(getBackupDir()).filter(f => f.endsWith('.json')).sort().reverse(); } catch {}
    const backups = files.map(f => {
      try { const stat = fs.statSync(path.join(getBackupDir(), f)); return { filename: f, size: stat.size, created: stat.mtime }; }
      catch { return { filename: f }; }
    });
    res.json({ backups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/backups', (req, res) => {
  try {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `backup_${ts}.json`;
    let config = {}; try { config = readConfig(); } catch {}
    let presets = {};
    try {
      const pfiles = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'));
      for (const f of pfiles) { try { presets[f] = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')); } catch {} }
    } catch {}
    let reports = [];
    try {
      const reportFiles = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort();
      for (const f of reportFiles) {
        try { reports.push({ filename: f, ...JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')) }); } catch {}
      }
    } catch {}
    const backup = { created: now.toISOString(), version: '2.0', config, presets, reports };
    fs.writeFileSync(path.join(getBackupDir(), filename), JSON.stringify(backup, null, 2));
    res.json({ ok: true, filename, size: JSON.stringify(backup).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/backups/:filename', (req, res) => {
  const { filename } = req.params;
  if (!/^backup_[\w-]+\.json$/.test(filename)) return res.status(400).json({ error: 'Invalid filename' });
  const filepath = path.join(getBackupDir(), filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup not found' });
  try { fs.unlinkSync(filepath); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/backups/reveal', (req, res) => {
  const { filename } = req.body;
  const target = filename ? path.join(getBackupDir(), filename) : getBackupDir();
  if (filename && !fs.existsSync(target)) return res.status(404).json({ error: 'File not found' });
  try { execFileSync('open', ['-R', target]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/backups/restore', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'No file specified' });
  const filepath = path.join(getBackupDir(), filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup not found' });
  try {
    const backup = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (backup.config) {
      writeConfig(backup.config);
      if (backup.config.smtp) writeMsmtprc(backup.config.smtp);
      setupCron();
    }
    if (backup.presets && typeof backup.presets === 'object') {
      for (const [fn, content] of Object.entries(backup.presets)) {
        fs.writeFileSync(path.join(PRESETS_DIR, fn), JSON.stringify(content, null, 2));
      }
    } else if (backup.preset) {
      const pname = backup.preset.PresetList?.[0]?.PresetName || 'Default Preset';
      const fn = pname.replace(/[^a-zA-Z0-9 _\-]/g, '').trim() + '.json';
      fs.writeFileSync(path.join(PRESETS_DIR, fn), JSON.stringify(backup.preset, null, 2));
    }
    if (backup.reports && Array.isArray(backup.reports)) {
      for (const r of backup.reports) {
        if (r.filename) {
          const { filename: fn, ...data } = r;
          fs.writeFileSync(path.join(REPORTS_DIR, fn), JSON.stringify(data, null, 2));
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export / Import
router.get('/export', (req, res) => {
  try {
    let config = {}; try { config = readConfig(); } catch {}
    let presets = {};
    try {
      const pfiles = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'));
      for (const f of pfiles) { try { presets[f] = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')); } catch {} }
    } catch {}
    const data = { exported: new Date().toISOString(), type: 'autoconvert-export', config, presets };
    res.setHeader('Content-Disposition', 'attachment; filename="autoconvert-export.json"');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/import', (req, res) => {
  try {
    const data = req.body;
    if (data.type !== 'autoconvert-export') return res.status(400).json({ error: 'Invalid export file' });
    if (data.config) {
      writeConfig(data.config);
      if (data.config.smtp) writeMsmtprc(data.config.smtp);
      setupCron();
    }
    if (data.presets && typeof data.presets === 'object') {
      for (const [fn, content] of Object.entries(data.presets)) {
        fs.writeFileSync(path.join(PRESETS_DIR, fn), JSON.stringify(content, null, 2));
      }
    } else if (data.preset) {
      const pname = data.preset.PresetList?.[0]?.PresetName || 'Default Preset';
      const fn = pname.replace(/[^a-zA-Z0-9 _\-]/g, '').trim() + '.json';
      fs.writeFileSync(path.join(PRESETS_DIR, fn), JSON.stringify(data.preset, null, 2));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
