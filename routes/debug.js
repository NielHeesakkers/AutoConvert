const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  APP_DIR, APP_MODE, LOG_DIR, HB_LOG_FILE, LOCK_FILE,
  CONFIG_PATH, PRESETS_DIR, getActivePresetFile,
} = require('../lib/config');

router.get('/hblog', (req, res) => {
  const results = {};
  try { results.hbLog = fs.readFileSync(HB_LOG_FILE, 'utf8').slice(-4000); } catch (e) { results.hbLog = e.message; }
  try { results.stderr = fs.readFileSync(path.join(LOG_DIR, 'convert_stderr.log'), 'utf8').slice(-2000); } catch (e) { results.stderr = e.message; }
  try { results.lockfile = fs.readFileSync(LOCK_FILE, 'utf8').trim(); } catch (e) { results.lockfile = e.message; }
  try { results.ps = execSync('ps aux | grep -i handbrake | grep -v grep', { timeout: 5000 }).toString().trim(); } catch (e) { results.ps = 'no handbrake process'; }
  res.json(results);
});

router.get('/paths', (req, res) => {
  res.json({
    APP_DIR, APP_MODE, __dirname,
    cwd: process.cwd(),
    publicDir: path.join(APP_DIR, 'public'),
    publicExists: fs.existsSync(path.join(APP_DIR, 'public')),
    indexExists: fs.existsSync(path.join(APP_DIR, 'public', 'index.html')),
    CONFIG_PATH, PRESETS_DIR, activePreset: getActivePresetFile(), LOG_DIR,
  });
});

module.exports = router;
