const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  REPORTS_DIR, APP_DIR, CONFIG_PATH, MSMTP_BIN,
  readConfig, getMediaDirs,
} = require('../lib/config');

function parseSizeToBytes(s) {
  if (!s || typeof s !== 'string') return 0;
  const m = s.trim().match(/^([\d.]+)\s*([KMGT]?)i?B?$/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = (m[2] || '').toUpperCase();
  const mult = { '': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3, 'T': 1024 ** 4 };
  return v * (mult[u] || 1);
}

router.get('/stats', (req, res) => {
  try {
    let files = [];
    try { files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')); } catch {}
    let movies = 0, series = 0, totalOld = 0, totalNew = 0;
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
        for (const c of (r.converted || [])) {
          if (c.section === 'movies') movies++; else series++;
          totalOld += parseSizeToBytes(c.old_size);
          totalNew += parseSizeToBytes(c.new_size);
        }
      } catch (e) { console.warn(`[reports] Failed to parse ${f}: ${e.message}`); }
    }
    res.json({ movies, series, totalOld, totalNew, saved: totalOld - totalNew, reports: files.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/', (req, res) => {
  try {
    let files = [];
    try {
      files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    } catch {}
    const total = files.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
    const page = files.slice(offset, offset + limit);
    const reports = page.map(f => {
      try { return { ...JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')), filename: f }; }
      catch { return { filename: f, error: 'Could not read report' }; }
    });
    res.json({ total, offset, limit, reports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:filename', (req, res) => {
  const { filename } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filepath = path.join(REPORTS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Report not found' });
  try { fs.unlinkSync(filepath); res.json({ ok: true, deleted: filename }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Resend a report email
router.post('/:filename/resend', async (req, res) => {
  const { filename } = req.params;
  const { email } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filepath = path.join(REPORTS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Report not found' });

  const config = readConfig();
  const smtp = config.smtp;
  if (!smtp || !smtp.host) return res.status(400).json({ error: 'SMTP not configured' });

  let recipients;
  if (email) {
    recipients = [email];
  } else {
    recipients = (config.recipients || []).filter(r => r.active !== false).map(r => r.email);
  }
  if (!recipients.length) return res.status(400).json({ error: 'No recipients' });

  try {
    const report = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const tmpDir = '/tmp/mkv_resend_report';
    fs.mkdirSync(tmpDir, { recursive: true });

    const mediaDirs = getMediaDirs();
    const convertedLines = (report.converted || []).map(c => {
      let mp4Path = c.mp4_path || '';
      if (!mp4Path) {
        for (const dir of mediaDirs) {
          const dirName = path.basename(dir);
          if (dirName.toLowerCase() === (c.section || '').toLowerCase()) {
            try {
              const found = execFileSync('find', [dir, '-name', `${c.basename}.mp4`, '-type', 'f'], { timeout: 5000 }).toString().trim().split('\n')[0];
              if (found) { mp4Path = found; break; }
            } catch {}
          }
        }
      }
      const parts = [c.section, c.basename, c.old_size, c.new_size, c.duration];
      if (mp4Path) parts.push(mp4Path);
      return parts.join('|');
    });
    fs.writeFileSync(path.join(tmpDir, 'converted.txt'), convertedLines.join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'failed.txt'), (report.failed || []).map(f => `${f.section}|${f.basename}|${f.size}${f.reason ? '|' + f.reason : ''}`).join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'dupes.txt'), (report.dupes || []).map(d => `${d.section}|${d.name}`).join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'skipped_empty.txt'), String(report.skipped_empty || 0));

    const env = { ...process.env, START_TIME: report.started || '', END_TIME: report.finished || '', RESEND: '1' };
    const result = execFileSync('python3', [
      path.join(APP_DIR, 'scripts', 'generate_report.py'), tmpDir, CONFIG_PATH, REPORTS_DIR,
    ], { env, timeout: 60000 }).toString();

    let emailContent = result;
    emailContent = emailContent.replace(/^Subject:\s*(.+)$/m, (m, subj) => `Subject: ${subj} (resend)`);
    emailContent = emailContent.replace(/^To:\s*(.+)$/m, `To: ${recipients.join(', ')}`);

    const msmtpPath = fs.existsSync(MSMTP_BIN) ? MSMTP_BIN : 'msmtp';
    const emailFile = path.join(tmpDir, 'email.txt');
    fs.writeFileSync(emailFile, emailContent);
    execFileSync(msmtpPath, [...recipients], { input: fs.readFileSync(emailFile), timeout: 30000 });
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

    try {
      const reportData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      reportData.emailed = new Date().toISOString();
      fs.writeFileSync(filepath, JSON.stringify(reportData, null, 2));
    } catch (e) { console.warn(`[reports] Failed to mark ${filename} as emailed: ${e.message}`); }

    res.json({ ok: true, sentTo: recipients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
