const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  PRESETS_DIR,
  readConfig, writeConfig, getActivePresetFile, readPresetDetails,
} = require('../lib/config');

router.get('/presets', (req, res) => {
  try {
    const config = readConfig();
    const activeFilename = config.app?.activePreset || 'Default Preset.json';
    const files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).sort();
    const presets = files.map(f => {
      try {
        const info = readPresetDetails(path.join(PRESETS_DIR, f));
        info.active = (f === activeFilename);
        return info;
      } catch (err) {
        return { filename: f, name: f, error: err.message, active: (f === activeFilename) };
      }
    });
    res.json({ presets, activePreset: activeFilename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/presets', (req, res) => {
  try {
    const content = req.body;
    if (!content.PresetList || !Array.isArray(content.PresetList) || !content.PresetList.length) {
      return res.status(400).json({ error: 'Invalid HandBrake preset file (no PresetList found)' });
    }
    const presetName = content.PresetList[0]?.PresetName || 'Unknown';
    let filename = presetName.replace(/[^a-zA-Z0-9 _\-]/g, '').trim() + '.json';
    if (!filename || filename === '.json') filename = 'preset.json';
    const filePath = path.join(PRESETS_DIR, filename);
    if (fs.existsSync(filePath) && req.query.overwrite !== 'true') {
      return res.status(409).json({ error: 'Preset already exists', filename, exists: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    const config = readConfig();
    if (!config.app) config.app = {};
    const allPresets = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'));
    if (allPresets.length === 1 || !config.app.activePreset) {
      config.app.activePreset = filename;
      writeConfig(config);
    }
    res.json({ ok: true, name: presetName, filename });
  } catch (err) {
    res.status(400).json({ error: 'Invalid JSON file: ' + err.message });
  }
});

router.post('/presets/:filename/activate', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PRESETS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Preset not found' });
  const config = readConfig();
  if (!config.app) config.app = {};
  config.app.activePreset = filename;
  writeConfig(config);
  res.json({ ok: true, activePreset: filename });
});

router.delete('/presets/:filename', (req, res) => {
  const { filename } = req.params;
  const config = readConfig();
  if (filename === (config.app?.activePreset || 'Default Preset.json')) {
    return res.status(400).json({ error: 'Cannot delete the active preset' });
  }
  const filePath = path.join(PRESETS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Preset not found' });
  try { fs.unlinkSync(filePath); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/presets/:filename/download', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(PRESETS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Preset not found' });
  res.download(filePath, filename);
});

// HandBrake info
router.get('/handbrake/encoders', (req, res) => {
  try {
    const output = execSync('HandBrakeCLI --help 2>&1', { timeout: 10000 }).toString();
    const video = [], audio = [];
    const vSection = output.match(/--encoder <string>[\s\S]*?(?=\s+--encoder-preset)/);
    if (vSection) {
      for (const line of vSection[0].split('\n').slice(1)) {
        const trimmed = line.trim();
        if (trimmed && /^[a-zA-Z0-9_]+$/.test(trimmed)) video.push(trimmed);
      }
    }
    const aSection = output.match(/--aencoder <string>[\s\S]*?(?=\s+--audio-copy-mask)/);
    if (aSection) {
      for (const line of aSection[0].split('\n').slice(1)) {
        const trimmed = line.trim();
        if (/^[a-zA-Z0-9_]+$/.test(trimmed) && trimmed !== 'none') audio.push(trimmed);
      }
    }
    let presetEncoder = '', presetAudio = '';
    try {
      const preset = JSON.parse(fs.readFileSync(getActivePresetFile(), 'utf8'));
      presetEncoder = preset.PresetList?.[0]?.VideoEncoder || '';
      presetAudio = preset.PresetList?.[0]?.AudioList?.[0]?.AudioEncoder || '';
    } catch {}
    res.json({ video, audio, presetEncoder, presetAudio, presetEncoderAvailable: video.includes(presetEncoder), presetAudioAvailable: audio.includes(presetAudio) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
