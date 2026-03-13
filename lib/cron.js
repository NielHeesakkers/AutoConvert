const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  readConfig, getMediaDirs,
  REPORTS_DIR, APP_DIR, CONFIG_PATH, LOG_DIR, MSMTP_BIN,
} = require('./config');
const { runConvertScript, isRunning } = require('./convert');
const { writeMsmtprc } = require('./email');

let cronJob = null, scanJob = null, emailJob = null;

function setupCron() {
  const config = readConfig();
  const hour = config.schedule?.hour ?? 3;
  const minute = config.schedule?.minute ?? 0;
  if (cronJob) cronJob.stop();
  cronJob = cron.schedule(`${minute} ${hour} * * *`, () => {
    console.log(`[cron] Conversion started at ${new Date().toISOString()}`);
    runConvertScript();
  });
  console.log(`[cron] Scheduled at ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`);
  setupScanCron(config);
  setupEmailCron(config);
}

function setupEmailCron(config) {
  if (emailJob) emailJob.stop();
  const eh = config.schedule?.emailHour;
  const em = config.schedule?.emailMinute;
  if (eh === undefined || eh === null || eh === '') return;
  const emailHour = parseInt(eh, 10);
  const emailMinute = parseInt(em, 10) || 0;
  if (isNaN(emailHour) || emailHour < 0 || emailHour > 23) return;
  emailJob = cron.schedule(`${emailMinute} ${emailHour} * * *`, () => {
    console.log(`[email-cron] Sending daily report email at ${new Date().toISOString()}`);
    sendDailyReportEmail();
  });
  console.log(`[email-cron] Email scheduled at ${String(emailHour).padStart(2,'0')}:${String(emailMinute).padStart(2,'0')}`);
}

async function sendDailyReportEmail() {
  // Only send email for new reports that haven't been emailed yet
  try {
    const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    if (!files.length) { console.log('[email-cron] No reports found'); return; }

    // Find the most recent report that has conversions and hasn't been emailed yet
    let latestReport = null;
    for (const f of files) {
      const m = f.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.json$/);
      if (!m) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
        if (data.emailed) continue; // already sent
        if (!(data.converted || []).length && !(data.failed || []).length) continue; // nothing to report
        latestReport = f;
        break;
      } catch { continue; }
    }
    if (!latestReport) { console.log('[email-cron] No new reports to email'); return; }

    const config = readConfig();
    const smtp = config.smtp;
    if (!smtp || !smtp.host) { console.log('[email-cron] SMTP not configured'); return; }
    const recipients = (config.recipients || []).filter(r => r.active !== false).map(r => r.email);
    if (!recipients.length) { console.log('[email-cron] No active recipients'); return; }

    // Reuse the resend logic
    const report = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, latestReport), 'utf8'));
    const tmpDir = '/tmp/mkv_email_cron_report';
    fs.mkdirSync(tmpDir, { recursive: true });

    const mediaDirs = getMediaDirs();
    const convertedLines = (report.converted || []).map(c => {
      let mp4Path = c.mp4_path || '';
      if (!mp4Path) {
        for (const dir of mediaDirs) {
          const dirName = path.basename(dir);
          if (dirName.toLowerCase() === (c.section || '').toLowerCase()) {
            try {
              const found = execSync(`find "${dir}" -name "${c.basename.replace(/"/g, '')}.mp4" -type f 2>/dev/null | head -1`, { timeout: 5000 }).toString().trim();
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
    const result = execSync(
      `python3 "${path.join(APP_DIR, 'scripts', 'generate_report.py')}" "${tmpDir}" "${CONFIG_PATH}" "${REPORTS_DIR}"`,
      { env, timeout: 60000 }
    ).toString();

    // Send via msmtp (same as original conversion emails)
    const msmtpPath = fs.existsSync(MSMTP_BIN) ? MSMTP_BIN : 'msmtp';
    const emailFile = path.join(tmpDir, 'email.txt');
    fs.writeFileSync(emailFile, result);
    execSync(`cat "${emailFile}" | ${msmtpPath} ${recipients.join(' ')}`, { timeout: 30000 });
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    // Mark report as emailed so we don't send it again
    try {
      const reportData = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, latestReport), 'utf8'));
      reportData.emailed = new Date().toISOString();
      fs.writeFileSync(path.join(REPORTS_DIR, latestReport), JSON.stringify(reportData, null, 2));
    } catch {}
    console.log(`[email-cron] Report emailed to ${recipients.join(', ')}`);
  } catch (err) {
    console.error(`[email-cron] Error: ${err.message}`);
  }
}

function setupScanCron(config) {
  if (scanJob) scanJob.stop();
  const interval = config.schedule?.scanInterval || 0;
  if (interval > 0) {
    scanJob = cron.schedule(`*/${interval} * * * *`, () => {
      if (!isRunning()) {
        console.log(`[scan] Auto-conversion triggered by scan interval`);
        runConvertScript();
      }
    });
    console.log(`[scan] Scan interval: every ${interval} minutes`);
  }
}

module.exports = { setupCron, setupEmailCron, setupScanCron, sendDailyReportEmail };
