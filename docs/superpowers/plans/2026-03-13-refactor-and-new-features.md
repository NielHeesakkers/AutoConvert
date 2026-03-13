# AutoConvert v2: Refactor + New Features Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor monolithic server.js and index.html into modular architecture, then add Folder Watch, Plex Refresh, Library Overview, and Subtitle Fetch features.

**Architecture:** Extract server.js (1700 lines) into lib/ modules + routes/ routers. Extract index.html JS/CSS into public/js/ and public/css/. New features added as isolated modules. No frontend framework or build step.

**Tech Stack:** Node.js, Express, chokidar (new), vanilla JS, SVG/CSS charts, OpenSubtitles REST API, Plex Media Server API, ffprobe

**Spec:** `docs/superpowers/specs/2026-03-13-refactor-and-new-features-design.md`

**CRITICAL:** Never push, build, or release without explicit user permission.

---

## Chunk 1: Server-side Refactor

### Task 1: Create `lib/config.js` — Config, paths, and shared constants

**Files:**
- Create: `lib/config.js`
- Modify: `server.js`

This is the foundation module — almost every other module depends on it. Extract all path resolution, config read/write, and shared constants.

- [ ] **Step 1: Create `lib/config.js`**

Extract from `server.js`:
- Lines 12-17: APP_MODE, APP_SUPPORT, APP_DIR
- Lines 224-249: CONFIG_PATH, SCRIPT_PATH, LOG_DIR, LOG_PATH, REPORTS_DIR, PRESETS_DIR, LOCK_FILE, PROGRESS_FILE, HB_LOG_FILE, MSMTP_BIN, MSMTPRC_PATH, DEFAULT_BACKUP_DIR, getBackupDir(), getActivePresetFile()
- Lines 250-271: readPresetDetails()
- Lines 272: VERSION_FILE
- Lines 275-283: getMediaDirs()
- Lines 483-499: DEFAULT_CONFIG, readConfig(), writeConfig()

Wrap in module with `deepMerge` added to `readConfig()`:

```javascript
// lib/config.js
const fs = require('fs');
const path = require('path');

const APP_MODE = process.env.AUTOCONVERT_APP === 'true';
const APP_SUPPORT = APP_MODE
  ? path.join(process.env.HOME, 'Library', 'Application Support', 'AutoConvert')
  : null;
const APP_DIR = path.join(__dirname, '..');

// ... all path constants extracted from server.js lines 224-272 ...

const DEFAULT_CONFIG = {
  recipients: [],
  smtp: { host: '', port: 587, user: '', password: '', from: '', tls: true, starttls: true },
  schedule: { hour: 3, minute: 0, scanInterval: 0 },
  watch: { enabled: false, stabilitySeconds: 30 },
  subtitles: { enabled: false, apiKey: '', languages: ['nl', 'en'] },
  plex: { enabled: false, url: 'http://localhost:32400', token: '', libraryIds: [] },
};

function deepMerge(target, defaults) {
  for (const key of Object.keys(defaults)) {
    if (!(key in target)) {
      target[key] = defaults[key];
    } else if (typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
      deepMerge(target[key], defaults[key]);
    }
  }
  return target;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return deepMerge(config, DEFAULT_CONFIG);
}

// ... writeConfig, getMediaDirs, getBackupDir, getActivePresetFile, readPresetDetails ...

// Auth helpers (used by routes/auth.js)
const USERS_PATH = APP_MODE
  ? path.join(APP_SUPPORT, 'users.json')
  : path.join(__dirname, '..', 'users.json');

function readUsers() { try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); } catch { return []; } }
function writeUsers(users) { fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2)); }
function isAuthEnabled() { return readUsers().length > 0; }

module.exports = {
  APP_MODE, APP_SUPPORT, APP_DIR,
  CONFIG_PATH, SCRIPT_PATH, LOG_DIR, LOG_PATH, REPORTS_DIR, PRESETS_DIR,
  LOCK_FILE, PROGRESS_FILE, HB_LOG_FILE, MSMTP_BIN, MSMTPRC_PATH, VERSION_FILE,
  USERS_PATH, DEFAULT_CONFIG,
  readConfig, writeConfig, getMediaDirs, getBackupDir,
  getActivePresetFile, readPresetDetails, deepMerge,
  readUsers, writeUsers, isAuthEnabled,
};
```

- [ ] **Step 2: Verify syntax**

Run: `node -c lib/config.js`
Expected: no errors

- [ ] **Step 3: Update `server.js` to import from `lib/config.js`**

At top of server.js, replace the extracted constants/functions with:
```javascript
const {
  APP_MODE, APP_SUPPORT, APP_DIR,
  CONFIG_PATH, SCRIPT_PATH, LOG_DIR, LOG_PATH, REPORTS_DIR, PRESETS_DIR,
  LOCK_FILE, PROGRESS_FILE, HB_LOG_FILE, MSMTP_BIN, MSMTPRC_PATH, VERSION_FILE,
  DEFAULT_CONFIG, readConfig, writeConfig, getMediaDirs, getBackupDir,
  getActivePresetFile, readPresetDetails,
} = require('./lib/config');
```

Remove the extracted lines (12-17, 224-283, 483-499) from server.js. Keep everything else.

- [ ] **Step 4: Verify server starts**

Run: `node server.js` — verify it starts on port 3742, then Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add lib/config.js server.js
git commit -m "refactor: extract lib/config.js — paths, config read/write, defaults"
```

---

### Task 2: Create `lib/convert.js` — Conversion logic

**Files:**
- Create: `lib/convert.js`
- Modify: `server.js`

- [ ] **Step 1: Create `lib/convert.js`**

Extract from `server.js`:
- Lines 412-431: checkDiskSpaceWarnings()
- Lines 433-479: runConvertScript()
- Lines 517-526: isRunning()

These functions need imports from `lib/config.js`:

```javascript
// lib/convert.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  APP_DIR, APP_MODE, CONFIG_PATH, LOG_DIR, REPORTS_DIR, LOCK_FILE, SCRIPT_PATH,
  readConfig, getMediaDirs, getActivePresetFile,
} = require('./config');

function checkDiskSpaceWarnings(mediaDirs) { /* lines 412-431 */ }
function runConvertScript(excludeFiles = [], fileOrder = []) { /* lines 433-479 */ }
function isRunning() { /* lines 517-526 */ }

module.exports = { runConvertScript, isRunning, checkDiskSpaceWarnings };
```

- [ ] **Step 2: Update `server.js`** — replace extracted functions with import

- [ ] **Step 3: Verify server starts and `/api/status` works**

Run: `node server.js &` then `curl http://localhost:3742/api/status` — should return JSON. Kill server.

- [ ] **Step 4: Commit**

```bash
git add lib/convert.js server.js
git commit -m "refactor: extract lib/convert.js — runConvertScript, isRunning"
```

---

### Task 3: Create `lib/email.js` — Email helpers

**Files:**
- Create: `lib/email.js`
- Modify: `server.js`

- [ ] **Step 1: Create `lib/email.js`**

Extract from `server.js`:
- Lines 501-515: writeMsmtprc()

```javascript
// lib/email.js
const fs = require('fs');
const { MSMTPRC_PATH } = require('./config');

function writeMsmtprc(smtp) { /* lines 501-515 */ }

module.exports = { writeMsmtprc };
```

- [ ] **Step 2: Update `server.js`, verify, commit**

```bash
git add lib/email.js server.js
git commit -m "refactor: extract lib/email.js — writeMsmtprc"
```

---

### Task 4: Create `lib/cron.js` — Scheduling logic

**Files:**
- Create: `lib/cron.js`
- Modify: `server.js`

- [ ] **Step 1: Create `lib/cron.js`**

Extract from `server.js`:
- Lines 285-288: cronJob, scanJob, emailJob variables
- Lines 290-302: setupCron()
- Lines 304-317: setupEmailCron()
- Lines 319-396: sendDailyReportEmail()
- Lines 398-410: setupScanCron()

This module needs: `cron`, `readConfig`, `writeConfig`, `getMediaDirs`, `runConvertScript`, `isRunning`, `REPORTS_DIR`, `APP_DIR`, `CONFIG_PATH`, `LOG_DIR`, `MSMTP_BIN`, `writeMsmtprc`.

```javascript
// lib/cron.js
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  readConfig, writeConfig, getMediaDirs,
  REPORTS_DIR, APP_DIR, CONFIG_PATH, LOG_DIR, MSMTP_BIN,
} = require('./config');
const { runConvertScript, isRunning } = require('./convert');
const { writeMsmtprc } = require('./email');

let cronJob = null, scanJob = null, emailJob = null;

function setupCron() { /* lines 290-302 */ }
function setupEmailCron(config) { /* lines 304-317 */ }
async function sendDailyReportEmail() { /* lines 319-396 */ }
function setupScanCron(config) { /* lines 398-410 */ }

module.exports = { setupCron, setupEmailCron, setupScanCron, sendDailyReportEmail };
```

- [ ] **Step 2: Update `server.js`, verify, commit**

```bash
git add lib/cron.js server.js
git commit -m "refactor: extract lib/cron.js — cron scheduling, daily email"
```

---

### Task 5: Create route modules — Extract all API routes

**Files:**
- Create: `routes/auth.js`, `routes/convert.js`, `routes/reports.js`, `routes/settings.js`, `routes/presets.js`, `routes/debug.js`, `routes/backup.js`
- Modify: `server.js`

This is the largest extraction. Each route file is an Express Router.

**Shared state note:** `scanDirectories()`, `dirCache`, and `dirScanRunning` are shared between `/api/scan` (convert routes) and `/api/directories` (settings routes). Extract these into `lib/directories.js`:
```javascript
// lib/directories.js
const fs = require('fs').promises;
const path = require('path');
const { getMediaDirs } = require('./config');
let dirCache = null, dirScanRunning = false;
async function findMkvAsync(dir, rel) { /* lines 1019-1038 */ }
async function scanDirectories() { /* lines 1040-1061 */ }
function getDirCache() { return dirCache; }
function clearDirCache() { dirCache = null; }
module.exports = { scanDirectories, getDirCache, clearDirCache };
```
Both `routes/convert.js` and `routes/settings.js` import from this shared module.

- [ ] **Step 1: Create `routes/auth.js`**

Extract from `server.js` lines 113-208 (all `/api/auth/*` handlers). Note: the rate limiting functions, session setup, and requireAuth middleware stay in `server.js` since they're middleware, not routes. The auth routes need access to `readUsers()`, `writeUsers()`, `isAuthEnabled()`, `checkRateLimit()`, etc. — pass these as dependencies or import from `lib/config.js`.

```javascript
// routes/auth.js
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
// Auth helper functions (readUsers, writeUsers, isAuthEnabled) either
// imported from lib/config.js or defined here with USERS_PATH from config
router.get('/status', (req, res) => { /* line 113-120 */ });
router.post('/setup', (req, res) => { /* line 122-133 */ });
// ... etc for all auth routes
module.exports = router;
```

- [ ] **Step 2: Create `routes/convert.js`**

Extract: `/api/status` (559-568), `/api/convert/progress` (571-608), `/api/convert/progress/clear` (610-613), `/api/convert` POST (891-904), `/api/convert/stop` (907-924), `/api/scan` (884-888), `/api/find-mp4` (1506-1521), `/api/download` (1574-1636), `/api/tmdb/lookup` (1407-1423).

Also extract: sendDownloadNotification() (1524-1572), TMDB helpers (1327-1405), directory scanning (1014-1076).

```javascript
// routes/convert.js
const router = require('express').Router();
// Mount points in server.js:
// router endpoints use relative paths (/status → GET /api/status when mounted at /api)
module.exports = router;
```

Note: Since these routes don't share a common prefix (some are `/api/convert/*`, others `/api/status`, `/api/scan`, etc.), mount each group separately in server.js, or use a flat router mounted at `/api`.

**Recommended approach:** Use a flat router for mixed-prefix routes. In `server.js`:
```javascript
const convertRoutes = require('./routes/convert');
app.use('/api', convertRoutes);
```

Inside `routes/convert.js`, routes use their full sub-path:
```javascript
router.get('/status', ...);
router.post('/convert', ...);
router.post('/convert/stop', ...);
router.get('/convert/progress', ...);
router.post('/scan', ...);
router.post('/find-mp4', ...);
router.get('/download', ...);
router.post('/tmdb/lookup', ...);
```

- [ ] **Step 3: Create `routes/reports.js`**

Extract: lines 928-986 (parseSizeToBytes, /api/reports/stats, /api/reports GET, /api/reports/:filename DELETE), lines 727-827 (/api/reports/:filename/resend).

```javascript
// routes/reports.js
const router = require('express').Router();
router.get('/stats', ...);    // mounted at /api/reports
router.get('/', ...);
router.delete('/:filename', ...);
router.post('/:filename/resend', ...);
module.exports = router;
```

- [ ] **Step 4: Create `routes/settings.js`**

Extract all settings-related routes:
- /api/app-settings (1457-1503)
- /api/schedule (845-881)
- /api/recipients (616-648)
- /api/smtp (651-685)
- /api/test-email (688-724)
- /api/test-smtp (830-842)
- /api/media-dirs (1686-1716)
- /api/directories (1065-1076)
- /api/disk-space (1665-1683)
- /api/choose-directory (1227-1240)
- /api/log (988-999)
- /api/logs DELETE (1001-1012)
- /api/version (1719-1722)

Mount at `/api`:
```javascript
router.get('/app-settings', ...);
router.post('/app-settings', ...);
router.get('/schedule', ...);
router.post('/schedule', ...);
// etc.
```

- [ ] **Step 5: Create `routes/presets.js`**

Extract lines 1100-1175 (/api/presets CRUD) and 1426-1454 (/api/handbrake/encoders).

- [ ] **Step 6: Create `routes/debug.js`**

Extract lines 1079-1097.

- [ ] **Step 7: Create `routes/backup.js`**

Extract lines 1178-1283 (/api/backups/*) and 1286-1324 (/api/export, /api/import).

- [ ] **Step 8: Update `server.js` to mount all routers**

server.js becomes thin:

```javascript
// server.js — thin entry point
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { APP_DIR, APP_MODE, APP_SUPPORT, LOG_DIR, REPORTS_DIR, PRESETS_DIR, readConfig } = require('./lib/config');
const { writeMsmtprc } = require('./lib/email');
const { setupCron } = require('./lib/cron');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Session + auth middleware (keep inline — ~90 lines)
// ... rate limiting, session setup, requireAuth ...

// Static serving with auth redirect (keep inline)
// ... lines 210-222 ...

// Init (keep inline — ~25 lines)
// ... mkdir, preset migration, msmtprc write ...

// Mount routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/presets', require('./routes/presets'));
app.use('/api/backups', require('./routes/backup'));
app.use('/api/debug', require('./routes/debug'));
// Flat-mounted routers (no prefix conflicts since they use different sub-paths)
// Order matters: more specific routes first
app.use('/api', require('./routes/convert'));
app.use('/api', require('./routes/settings'));

// Start
const PORT = readConfig().app?.port || 3742;
app.listen(PORT, () => {
  console.log(`AutoConvert running on http://localhost:${PORT}`);
  setupCron();
});
```

- [ ] **Step 9: Verify all endpoints work**

Run server, then test key endpoints:
```bash
node server.js &
curl -s http://localhost:3742/api/status | head
curl -s http://localhost:3742/api/version | head
curl -s http://localhost:3742/api/schedule | head
curl -s http://localhost:3742/api/presets | head
curl -s http://localhost:3742/api/debug/paths | head
kill %1
```

- [ ] **Step 10: Commit**

```bash
git add routes/ server.js
git commit -m "refactor: extract all API routes into routes/ modules"
```

---

## Chunk 2: Frontend Refactor

### Task 6: Extract CSS into `public/css/style.css`

**Files:**
- Create: `public/css/style.css`
- Modify: `public/index.html`

- [ ] **Step 1: Create `public/css/style.css`**

Extract everything between `<style>` and `</style>` tags (index.html lines 7-444). Copy verbatim, then add CSS custom properties at the top so new JS code can reference theme-aware colors:

```css
/* Add at the top of style.css, before existing rules */
:root {
  --text: #e4e4e7;
  --muted: #888;
  --accent: #6366f1;
  --success: #4ade80;
  --border: #333;
  --card-bg: #1e1e2e;
  --bg: #111;
}
[data-theme="light"] {
  --text: #18181b;
  --muted: #71717a;
  --accent: #4f46e5;
  --success: #16a34a;
  --border: #d4d4d8;
  --card-bg: #f4f4f5;
  --bg: #fff;
}
```

This allows new dynamically-generated HTML in JS to use `var(--muted)` etc. and respond to theme changes. Existing hardcoded colors in the CSS remain untouched.

- [ ] **Step 2: Replace `<style>` block in `index.html`**

Replace the entire `<style>...</style>` block with:
```html
<link rel="stylesheet" href="/css/style.css">
```

- [ ] **Step 3: Verify in browser**

Open `http://localhost:3742` — all styling should look identical.

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css public/index.html
git commit -m "refactor: extract CSS into public/css/style.css"
```

---

### Task 7: Extract JS into `public/js/` files

**Files:**
- Create: `public/js/utils.js`, `public/js/modals.js`, `public/js/app.js`, `public/js/convert.js`, `public/js/reports.js`, `public/js/settings.js`
- Modify: `public/index.html`

- [ ] **Step 1: Create `public/js/utils.js`**

Extract from index.html:
- `toast()` (line 1006)
- `escHtml()` (line 1007)
- `escAttr()` (line 1008)
- `fmtBytes()` (line 1009)
- `fmtSize()` (line 1768-1773, duplicate — remove, alias to fmtBytes)
- `renderTmdbCard()` (lines 1012-1048)

- [ ] **Step 2: Create `public/js/modals.js`**

Extract from index.html:
- `showConfirm()`, `resolveConfirm()` (lines 1894-1904)
- `showFailDetail()`, close handler (lines 1844-1858)
- `resendReport()`, `closeResendModal()`, `confirmResend()` (lines 1861-1892)
- `openModal()`, `closeModal()` (lines 1611-1623)
- All modal-related global state (`_confirmResolve`, `_resendId`, `_resendBtn`, `_modalResolve`)

- [ ] **Step 3: Create `public/js/app.js`**

Extract from index.html:
- Theme functions (lines 953-969)
- Navigation (lines 972-1003)
- Auth functions (lines 1955-2016)
- `loadStatus()` (lines 1151-1189)
- Init code (lines 2018-2023)

- [ ] **Step 4: Create `public/js/convert.js`**

Extract from index.html:
- Queue state and drag functions (lines 1098-1143)
- `loadConvQueue()`, `renderQueue()` (lines 1191-1271)
- `startConvert()`, `stopConvert()` (lines 1273-1293)
- `loadProgress()` (lines 1296-1437)
- `loadDiskSpace()` (lines 1051-1096)

- [ ] **Step 5: Create `public/js/reports.js`**

Extract from index.html:
- Report loading and rendering (lines 1774-1842)
- Delete functions (lines 1906-1915)
- Report stats (lines 1774-1794)
- Pagination state (`reportsOffset`, etc.)

- [ ] **Step 6: Create `public/js/settings.js`**

Extract from index.html:
- Directory management (lines 1440-1477)
- Schedule (lines 1480-1524)
- App settings (lines 1535-1574)
- Backup dir browser (lines 1576-1588)
- SMTP functions (lines 1591-1636)
- Recipients (lines 1639-1670)
- Presets (lines 1672-1724)
- Backups (lines 1726-1765)
- Logs (lines 1930-1953)
- Version (lines 1918-1927)

- [ ] **Step 7: Replace `<script>` block in `index.html`**

Remove the entire `<script>...</script>` block. Add script tags before `</body>`:

```html
<script src="/js/utils.js"></script>
<script src="/js/modals.js"></script>
<script src="/js/app.js"></script>
<script src="/js/convert.js"></script>
<script src="/js/reports.js"></script>
<script src="/js/settings.js"></script>
```

- [ ] **Step 8: Verify in browser**

Open `http://localhost:3742` — test each tab:
1. Convert tab: queue loads, buttons work
2. Reports tab: reports load, stats show
3. Recipients tab: list loads
4. Settings tab: each sub-tab loads data
5. Theme toggle works
6. Toast notifications work

- [ ] **Step 9: Commit**

```bash
git add public/js/ public/index.html
git commit -m "refactor: extract JavaScript into public/js/ modules"
```

---

## Chunk 3: Feature — Folder Watch

### Task 8: Install chokidar

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install chokidar**

```bash
npm install chokidar
```

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add chokidar for file watching"
```

---

### Task 9: Create `lib/watcher.js`

**Files:**
- Create: `lib/watcher.js`

- [ ] **Step 1: Write `lib/watcher.js`**

```javascript
// lib/watcher.js
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const { readConfig, writeConfig, getMediaDirs } = require('./config');
const { runConvertScript, isRunning } = require('./convert');

let watcher = null;
const pendingFiles = new Map(); // path → { size, stableCount, timer }
const queue = []; // files waiting for current conversion to finish

function init() {
  const config = readConfig();
  if (config.watch?.enabled) start();
}

function start() {
  stop(); // clean up previous watcher
  const dirs = getMediaDirs().filter(d => fs.existsSync(d));
  if (dirs.length === 0) {
    console.log('[watch] No media directories found');
    return;
  }
  watcher = chokidar.watch(dirs, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true, // don't trigger for existing files
    awaitWriteFinish: false, // we handle stability ourselves
    depth: 10,
  });
  watcher.on('add', (filePath) => {
    if (path.extname(filePath).toLowerCase() !== '.mkv') return;
    console.log(`[watch] Detected new MKV: ${filePath}`);
    startStabilityCheck(filePath);
  });
  watcher.on('error', (err) => {
    console.error(`[watch] Watcher error: ${err.message}`);
  });
  console.log(`[watch] Watching ${dirs.length} directories`);
}

function stop() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  // Clear all pending stability checks
  for (const [, info] of pendingFiles) {
    clearInterval(info.timer);
  }
  pendingFiles.clear();
  queue.length = 0;
  console.log('[watch] Stopped');
}

function startStabilityCheck(filePath) {
  const config = readConfig();
  const stabilitySeconds = config.watch?.stabilitySeconds || 30;
  const checkInterval = 10000; // 10s
  const requiredStableChecks = Math.ceil(stabilitySeconds / 10);

  let lastSize = -1;
  let stableCount = 0;

  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(filePath)) {
        console.log(`[watch] File removed during stability check: ${path.basename(filePath)}`);
        clearInterval(timer);
        pendingFiles.delete(filePath);
        return;
      }
      const stat = fs.statSync(filePath);
      if (stat.size === lastSize) {
        stableCount++;
        if (stableCount >= requiredStableChecks) {
          clearInterval(timer);
          pendingFiles.delete(filePath);
          console.log(`[watch] File stable: ${path.basename(filePath)} (${stat.size} bytes)`);
          enqueueFile(filePath);
        }
      } else {
        stableCount = 0;
        lastSize = stat.size;
      }
    } catch (err) {
      console.error(`[watch] Stability check error for ${path.basename(filePath)}: ${err.message}`);
      clearInterval(timer);
      pendingFiles.delete(filePath);
    }
  }, checkInterval);

  pendingFiles.set(filePath, { timer, lastSize: -1, stableCount: 0 });
}

function enqueueFile(filePath) {
  if (isRunning()) {
    console.log(`[watch] Conversion running, queuing: ${path.basename(filePath)}`);
    queue.push(filePath);
    return;
  }
  triggerConversion(filePath);
}

function triggerConversion(filePath) {
  console.log(`[watch] Triggering conversion for: ${path.basename(filePath)}`);
  // Use FILE_ORDER to convert only this file
  const pid = runConvertScript([], [filePath]);
  if (pid) {
    // Poll for completion to process queue
    const pollInterval = setInterval(() => {
      if (!isRunning()) {
        clearInterval(pollInterval);
        processQueue();
      }
    }, 5000);
  }
}

function processQueue() {
  if (queue.length === 0) return;
  const next = queue.shift();
  if (fs.existsSync(next)) {
    console.log(`[watch] Processing queued file: ${path.basename(next)}`);
    triggerConversion(next);
  } else {
    console.log(`[watch] Queued file no longer exists: ${path.basename(next)}`);
    processQueue(); // try next
  }
}

function getStatus() {
  const config = readConfig();
  return {
    enabled: config.watch?.enabled || false,
    watching: watcher !== null,
    directories: getMediaDirs(),
    queueLength: queue.length,
    pendingStability: pendingFiles.size,
  };
}

function toggle(enabled) {
  const config = readConfig();
  if (!config.watch) config.watch = {};
  config.watch.enabled = enabled;
  writeConfig(config);
  if (enabled) start();
  else stop();
}

function updateConfig(stabilitySeconds) {
  const config = readConfig();
  if (!config.watch) config.watch = {};
  config.watch.stabilitySeconds = stabilitySeconds;
  writeConfig(config);
  // Restart if currently watching
  if (watcher) { stop(); start(); }
}

module.exports = { init, start, stop, getStatus, toggle, updateConfig };
```

- [ ] **Step 2: Verify syntax**

Run: `node -c lib/watcher.js`

- [ ] **Step 3: Commit**

```bash
git add lib/watcher.js
git commit -m "feat: add lib/watcher.js — folder watch with stability check"
```

---

### Task 10: Create `routes/watch.js` and wire up

**Files:**
- Create: `routes/watch.js`
- Modify: `server.js`

- [ ] **Step 1: Write `routes/watch.js`**

```javascript
// routes/watch.js
const router = require('express').Router();
const watcher = require('../lib/watcher');

router.get('/status', (req, res) => {
  res.json(watcher.getStatus());
});

router.post('/toggle', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  watcher.toggle(enabled);
  res.json({ ok: true, ...watcher.getStatus() });
});

router.post('/config', (req, res) => {
  const { stabilitySeconds } = req.body;
  if (!stabilitySeconds || stabilitySeconds < 10 || stabilitySeconds > 300) {
    return res.status(400).json({ error: 'stabilitySeconds must be between 10 and 300' });
  }
  watcher.updateConfig(stabilitySeconds);
  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 2: Mount in `server.js`**

Add to server.js route mounting section:
```javascript
app.use('/api/watch', require('./routes/watch'));
```

Add to server startup (after `setupCron()`):
```javascript
require('./lib/watcher').init();
```

- [ ] **Step 3: Verify endpoint**

```bash
curl -s http://localhost:3742/api/watch/status
```
Expected: `{"enabled":false,"watching":false,...}`

- [ ] **Step 4: Commit**

```bash
git add routes/watch.js server.js
git commit -m "feat: add watch routes and wire up watcher init"
```

---

### Task 11: Add Watch settings UI

**Files:**
- Modify: `public/index.html` (add Watch sub-tab HTML)
- Modify: `public/js/settings.js` (add watch functions)

- [ ] **Step 1: Add Watch sub-tab button in Settings**

In the settings tab buttons row in index.html, add after the existing buttons:
```html
<div class="tab" data-tab="tab-watch">Watch</div>
```
Add this inside the `#settingsTabs` container alongside existing tab buttons. The existing delegated click handler at line 993 will handle switching automatically.

- [ ] **Step 2: Add Watch sub-tab content**

```html
<div class="tab-content" id="tab-watch" style="display:none;">
  <h3>Folder Watch</h3>
  <p style="color:#888;margin-bottom:1rem;">Automatically detect new MKV files and start conversion.</p>
  <div class="setting-row" style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem;">
    <label>Enable Folder Watch</label>
    <label class="toggle"><input type="checkbox" id="watchEnabled" onchange="toggleWatch(this.checked)"><span class="slider"></span></label>
    <span id="watchStatus" style="color:#888;font-size:.85rem;"></span>
  </div>
  <div class="setting-row" style="margin-bottom:1rem;">
    <label>Stability wait (seconds)</label>
    <p style="color:#888;font-size:.85rem;margin:.25rem 0 .5rem;">Wait this long after a file stops growing before converting.</p>
    <div style="display:flex;gap:.5rem;align-items:center;">
      <input type="number" id="watchStability" min="10" max="300" value="30" style="width:80px;">
      <button class="btn btn-primary" onclick="saveWatchConfig()">Save</button>
    </div>
  </div>
  <div id="watchQueueInfo" style="color:#888;font-size:.85rem;"></div>
</div>
```

- [ ] **Step 3: Add JS functions in `public/js/settings.js`**

```javascript
async function loadWatchStatus() {
  try {
    const res = await fetch('/api/watch/status');
    const data = await res.json();
    document.getElementById('watchEnabled').checked = data.enabled;
    const statusEl = document.getElementById('watchStatus');
    if (data.watching) {
      statusEl.textContent = `Watching ${data.directories.length} directories`;
      statusEl.style.color = 'var(--success)';
    } else {
      statusEl.textContent = 'Disabled';
      statusEl.style.color = 'var(--muted)';
    }
    const queueEl = document.getElementById('watchQueueInfo');
    if (data.queueLength > 0) {
      queueEl.textContent = `${data.queueLength} files in queue, ${data.pendingStability} checking stability`;
    } else {
      queueEl.textContent = '';
    }
  } catch { /* ignore */ }
}

async function toggleWatch(enabled) {
  try {
    await fetch('/api/watch/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    toast(enabled ? 'Folder Watch enabled' : 'Folder Watch disabled');
    loadWatchStatus();
  } catch { toast('Failed to toggle watch', true); }
}

async function saveWatchConfig() {
  const stabilitySeconds = parseInt(document.getElementById('watchStability').value, 10);
  if (isNaN(stabilitySeconds) || stabilitySeconds < 10 || stabilitySeconds > 300) {
    return toast('Stability must be 10-300 seconds', true);
  }
  try {
    await fetch('/api/watch/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stabilitySeconds }),
    });
    toast('Watch config saved');
  } catch { toast('Failed to save', true); }
}
```

Add `loadWatchStatus()` to the init batch in `public/js/app.js`.

- [ ] **Step 4: Verify in browser**

Open Settings → Watch tab. Toggle on/off, check status updates.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/settings.js public/js/app.js
git commit -m "feat: add Watch settings UI with enable/disable and stability config"
```

---

## Chunk 4: Feature — Plex Refresh

### Task 12: Create `lib/plex.js`

**Files:**
- Create: `lib/plex.js`

- [ ] **Step 1: Write `lib/plex.js`**

```javascript
// lib/plex.js
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { readConfig } = require('./config');

async function plexRequest(endpoint, token, baseUrl) {
  const url = new URL(endpoint, baseUrl);
  url.searchParams.set('X-Plex-Token', token);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url.toString(), { timeout: 5000, headers: { Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Plex request timeout')); });
    req.on('error', reject);
  });
}

async function testConnection() {
  const config = readConfig();
  const { url, token } = config.plex || {};
  if (!url || !token) throw new Error('Plex URL and token required');
  const result = await plexRequest('/library/sections', token, url);
  if (result.status === 401) throw new Error('Invalid Plex token');
  if (result.status !== 200) throw new Error(`Plex returned status ${result.status}`);
  const sections = result.data?.MediaContainer?.Directory || [];
  return sections.map(s => ({
    id: s.key,
    title: s.title,
    type: s.type,
    path: s.Location?.[0]?.path || '',
  }));
}

async function refreshLibraries() {
  const config = readConfig();
  if (!config.plex?.enabled) return;
  const { url, token, libraryIds } = config.plex;
  if (!url || !token) { console.log('[plex] Not configured'); return; }
  try {
    const sections = await testConnection();
    const toRefresh = libraryIds.length > 0
      ? sections.filter(s => libraryIds.includes(s.id))
      : sections;
    for (const section of toRefresh) {
      try {
        await plexRequest(`/library/sections/${section.id}/refresh`, token, url);
        console.log(`[plex] Refreshed library: ${section.title}`);
      } catch (err) {
        console.error(`[plex] Failed to refresh ${section.title}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[plex] Refresh failed: ${err.message}`);
  }
}

module.exports = { testConnection, refreshLibraries };
```

- [ ] **Step 2: Verify syntax**

Run: `node -c lib/plex.js`

- [ ] **Step 3: Commit**

```bash
git add lib/plex.js
git commit -m "feat: add lib/plex.js — Plex library refresh after conversion"
```

---

### Task 13: Create `routes/plex.js` and wire up

**Files:**
- Create: `routes/plex.js`
- Modify: `server.js`
- Modify: `lib/convert.js`

- [ ] **Step 1: Write `routes/plex.js`**

```javascript
// routes/plex.js
const router = require('express').Router();
const { readConfig, writeConfig } = require('../lib/config');
const plex = require('../lib/plex');

router.get('/status', (req, res) => {
  const config = readConfig();
  res.json({
    enabled: config.plex?.enabled || false,
    url: config.plex?.url || 'http://localhost:32400',
    hasToken: !!(config.plex?.token),
    libraryIds: config.plex?.libraryIds || [],
  });
});

router.post('/config', (req, res) => {
  const { url, token, libraryIds } = req.body;
  const config = readConfig();
  if (!config.plex) config.plex = {};
  if (url !== undefined) config.plex.url = url;
  if (token !== undefined) config.plex.token = token;
  if (libraryIds !== undefined) config.plex.libraryIds = libraryIds;
  writeConfig(config);
  res.json({ ok: true });
});

router.post('/test', async (req, res) => {
  try {
    const libraries = await plex.testConnection();
    res.json({ ok: true, libraries });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    await plex.refreshLibraries();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 2: Mount in `server.js`**

```javascript
app.use('/api/plex', require('./routes/plex'));
```

- [ ] **Step 3: Add post-conversion hook in `lib/convert.js`**

In `runConvertScript()`, in the `child.on('exit')` handler, add after logging:

**Note:** This handler will be expanded in Task 20 to also include subtitle fetching. For now, add Plex only:

```javascript
child.on('exit', (code, signal) => {
  console.log(`[convert] Script exited with code=${code}, signal=${signal}`);
  try { fs.closeSync(logStream); } catch {}
  // Post-conversion hooks
  if (code === 0) {
    try { require('./plex').refreshLibraries(); } catch (err) {
      console.error(`[convert] Plex refresh error: ${err.message}`);
    }
  }
});
```

- [ ] **Step 4: Commit**

```bash
git add routes/plex.js server.js lib/convert.js
git commit -m "feat: add Plex refresh routes and post-conversion hook"
```

---

### Task 14: Add Plex settings UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/js/settings.js`

- [ ] **Step 1: Add Plex sub-tab in Settings HTML**

Add tab button inside `#settingsTabs`: `<div class="tab" data-tab="tab-plex">Plex</div>`

Add content pane:
```html
<div class="tab-content" id="tab-plex" style="display:none;">
  <h3>Plex Integration</h3>
  <p style="color:#888;margin-bottom:1rem;">Automatically refresh Plex libraries after conversion.</p>
  <div class="setting-row" style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem;">
    <label>Enable Plex Refresh</label>
    <label class="toggle"><input type="checkbox" id="plexEnabled" onchange="togglePlex(this.checked)"><span class="slider"></span></label>
  </div>
  <div class="setting-row" style="margin-bottom:.75rem;">
    <label>Plex URL</label>
    <input type="text" id="plexUrl" placeholder="http://localhost:32400" style="width:100%;">
  </div>
  <div class="setting-row" style="margin-bottom:.75rem;">
    <label>Plex Token</label>
    <input type="password" id="plexToken" placeholder="Your Plex token" style="width:100%;">
  </div>
  <div style="display:flex;gap:.5rem;margin-bottom:1rem;">
    <button class="btn btn-primary" onclick="savePlexConfig()">Save</button>
    <button class="btn" onclick="testPlexConnection()">Test Connection</button>
    <button class="btn" onclick="manualPlexRefresh()">Refresh Now</button>
  </div>
  <div id="plexLibraries" style="margin-top:1rem;"></div>
</div>
```

- [ ] **Step 2: Add JS functions in `public/js/settings.js`**

```javascript
async function loadPlexStatus() {
  try {
    const res = await fetch('/api/plex/status');
    const data = await res.json();
    document.getElementById('plexEnabled').checked = data.enabled;
    document.getElementById('plexUrl').value = data.url || 'http://localhost:32400';
  } catch {}
}

async function togglePlex(enabled) {
  const config = { enabled };
  if (!enabled) config.libraryIds = [];
  await fetch('/api/plex/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(config) });
  toast(enabled ? 'Plex refresh enabled' : 'Plex refresh disabled');
}

async function savePlexConfig() {
  const url = document.getElementById('plexUrl').value.trim();
  const token = document.getElementById('plexToken').value.trim();
  if (!url) return toast('URL is required', true);
  if (!token) return toast('Token is required', true);
  try {
    await fetch('/api/plex/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ url, token }) });
    toast('Plex config saved');
  } catch { toast('Failed to save', true); }
}

async function testPlexConnection() {
  try {
    const res = await fetch('/api/plex/test', { method: 'POST' });
    const data = await res.json();
    if (data.error) return toast(data.error, true);
    const el = document.getElementById('plexLibraries');
    el.innerHTML = '<h4 style="margin-bottom:.5rem;">Libraries found:</h4>' +
      data.libraries.map(l => `<div style="padding:.25rem 0;"><strong>${escHtml(l.title)}</strong> <span style="color:#888;">(${l.type})</span></div>`).join('');
    toast(`Connected! Found ${data.libraries.length} libraries`);
  } catch { toast('Connection failed', true); }
}

async function manualPlexRefresh() {
  try {
    await fetch('/api/plex/refresh', { method: 'POST' });
    toast('Plex libraries refreshed');
  } catch { toast('Refresh failed', true); }
}
```

Add `loadPlexStatus()` to init batch.

- [ ] **Step 3: Verify in browser, commit**

```bash
git add public/index.html public/js/settings.js public/js/app.js
git commit -m "feat: add Plex settings UI — URL, token, test connection"
```

---

## Chunk 5: Feature — Library Overview

### Task 15: Create `lib/library-scan.js`

**Files:**
- Create: `lib/library-scan.js`

- [ ] **Step 1: Write `lib/library-scan.js`**

```javascript
// lib/library-scan.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { readConfig, getMediaDirs, LOG_DIR, REPORTS_DIR, APP_MODE, APP_SUPPORT } = require('./config');

const CACHE_PATH = APP_MODE
  ? path.join(APP_SUPPORT, 'library_cache.json')
  : path.join(__dirname, '..', 'library_cache.json');
const CACHE_MAX_AGE = 3600000; // 1 hour
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.wmv', '.flv', '.webm']);

let scanning = false;
let scanProgress = { current: 0, total: 0 };
let scanAbort = false;

function getCachedStats() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (Date.now() - new Date(data.scannedAt).getTime() < CACHE_MAX_AGE) return data;
  } catch {}
  return null;
}

function ffprobeFile(filePath) {
  try {
    const out = execSync(
      `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath}"`,
      { timeout: 5000 }
    ).toString();
    const info = JSON.parse(out);
    const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
    return {
      codec: videoStream?.codec_name || 'unknown',
      width: videoStream?.width || 0,
      height: videoStream?.height || 0,
      duration: parseFloat(info.format?.duration) || 0,
      bitrate: parseInt(info.format?.bit_rate) || 0,
    };
  } catch {
    return null; // ffprobe not available or failed
  }
}

function classifyResolution(height) {
  if (height >= 2000) return '2160p';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  if (height >= 400) return '480p';
  return 'other';
}

function walkDir(dir) {
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkDir(full));
      } else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files.push(full);
      }
    }
  } catch {}
  return files;
}

async function scan() {
  if (scanning) return;
  scanning = true;
  scanAbort = false;
  scanProgress = { current: 0, total: 0 };

  const dirs = getMediaDirs();
  const stats = {
    scannedAt: new Date().toISOString(),
    totalFiles: 0,
    totalSizeBytes: 0,
    byFormat: {},
    byCodec: {},
    byResolution: {},
    byDirectory: [],
    conversionHistory: getConversionHistory(),
  };

  // Collect all files first
  const allFiles = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = walkDir(dir);
    const dirStats = { name: path.basename(dir), path: dir, files: files.length, sizeBytes: 0 };
    allFiles.push(...files.map(f => ({ path: f, dir, dirStats })));
    stats.byDirectory.push(dirStats);
  }

  scanProgress.total = allFiles.length;

  for (const file of allFiles) {
    if (scanAbort) break;
    scanProgress.current++;

    const ext = path.extname(file.path).toLowerCase().replace('.', '');
    const fstat = fs.statSync(file.path);

    stats.totalFiles++;
    stats.totalSizeBytes += fstat.size;
    file.dirStats.sizeBytes += fstat.size;
    stats.byFormat[ext] = (stats.byFormat[ext] || 0) + 1;

    // ffprobe for codec/resolution
    const probe = ffprobeFile(file.path);
    if (probe) {
      const codec = probe.codec === 'hevc' ? 'hevc' : probe.codec === 'h264' ? 'h264' : 'other';
      stats.byCodec[codec] = (stats.byCodec[codec] || 0) + 1;
      const res = classifyResolution(probe.height);
      stats.byResolution[res] = (stats.byResolution[res] || 0) + 1;
    } else {
      stats.byCodec['unknown'] = (stats.byCodec['unknown'] || 0) + 1;
      stats.byResolution['unknown'] = (stats.byResolution['unknown'] || 0) + 1;
    }
  }

  // Cache results
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(stats, null, 2)); } catch {}

  scanning = false;
  return stats;
}

function getConversionHistory() {
  const history = [];
  try {
    const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 30);
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
        const date = f.replace(/\.json$/, '').replace(/_/g, ' ').slice(0, 10);
        history.push({
          date,
          converted: (data.converted || []).length,
          failed: (data.failed || []).length,
        });
      } catch {}
    }
  } catch {}
  return history.reverse();
}

function cancelScan() { scanAbort = true; }
function getScanStatus() { return { scanning, progress: `${scanProgress.current}/${scanProgress.total}` }; }

module.exports = { getCachedStats, scan, cancelScan, getScanStatus };
```

- [ ] **Step 2: Verify syntax, commit**

```bash
node -c lib/library-scan.js
git add lib/library-scan.js
git commit -m "feat: add lib/library-scan.js — ffprobe media library scanner"
```

---

### Task 16: Create `routes/library.js` and mount

**Files:**
- Create: `routes/library.js`
- Modify: `server.js`

- [ ] **Step 1: Write `routes/library.js`**

```javascript
// routes/library.js
const router = require('express').Router();
const libScan = require('../lib/library-scan');

router.get('/stats', (req, res) => {
  const cached = libScan.getCachedStats();
  if (cached) return res.json(cached);
  // No cache — trigger scan
  libScan.scan().then(stats => {}).catch(() => {});
  res.json({ scanning: true, ...libScan.getScanStatus() });
});

router.post('/scan', (req, res) => {
  if (libScan.getScanStatus().scanning) {
    return res.json({ scanning: true, ...libScan.getScanStatus() });
  }
  libScan.scan().then(() => {}).catch(() => {});
  res.json({ scanning: true });
});

router.get('/scan/status', (req, res) => {
  const status = libScan.getScanStatus();
  if (!status.scanning) {
    const cached = libScan.getCachedStats();
    if (cached) return res.json({ scanning: false, stats: cached });
  }
  res.json(status);
});

router.post('/scan/cancel', (req, res) => {
  libScan.cancelScan();
  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 2: Mount in `server.js`**

```javascript
app.use('/api/library', require('./routes/library'));
```

- [ ] **Step 3: Commit**

```bash
git add routes/library.js server.js
git commit -m "feat: add library routes — stats, scan, scan status, cancel"
```

---

### Task 17: Add Library tab UI

**Files:**
- Modify: `public/index.html` (add Library tab button + content)
- Create: `public/js/library.js`

- [ ] **Step 1: Add Library tab button in sidebar navigation**

In the sidebar nav section, add before Settings using the existing `data-section` pattern:
```html
<a data-section="library"><span class="nav-icon">📊</span> Library</a>
```
The existing delegated click handler will pick this up automatically.

- [ ] **Step 2: Add Library section HTML**

```html
<section id="sec-library" style="display:none;">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
    <h2>Library Overview</h2>
    <button class="btn btn-primary" id="btnScanLib" onclick="scanLibrary()">Scan Library</button>
  </div>
  <div id="libScanProgress" style="display:none;margin-bottom:1rem;">
    <div style="display:flex;align-items:center;gap:.5rem;">
      <div class="spinner"></div>
      <span id="libScanText">Scanning...</span>
    </div>
  </div>
  <div id="libSummary" class="stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;margin-bottom:2rem;"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:2rem;margin-bottom:2rem;" id="libCharts">
    <div class="panel" style="padding:1.25rem;"><h3 style="margin-bottom:1rem;">Format Distribution</h3><div id="chartFormat"></div></div>
    <div class="panel" style="padding:1.25rem;"><h3 style="margin-bottom:1rem;">Codec Breakdown</h3><div id="chartCodec"></div></div>
    <div class="panel" style="padding:1.25rem;"><h3 style="margin-bottom:1rem;">Resolution</h3><div id="chartResolution"></div></div>
    <div class="panel" style="padding:1.25rem;"><h3 style="margin-bottom:1rem;">Disk Usage</h3><div id="chartDisk"></div></div>
  </div>
  <div class="panel" style="padding:1.25rem;" id="chartHistoryPanel">
    <h3 style="margin-bottom:1rem;">Conversion History (Last 30 days)</h3>
    <div id="chartHistory"></div>
  </div>
</section>
```

- [ ] **Step 3: Write `public/js/library.js`**

Complete file with SVG chart rendering — donut charts, bar chart, and line chart. All pure SVG, no dependencies.

```javascript
// public/js/library.js
let libPollTimer = null;

async function loadLibrary() {
  try {
    const res = await fetch('/api/library/stats');
    const data = await res.json();
    if (data.scanning) { startLibPoll(); return; }
    renderLibrary(data);
  } catch {}
}

async function scanLibrary() {
  document.getElementById('btnScanLib').disabled = true;
  try {
    await fetch('/api/library/scan', { method: 'POST' });
    startLibPoll();
  } catch { toast('Scan failed', true); }
}

function startLibPoll() {
  document.getElementById('libScanProgress').style.display = 'block';
  if (libPollTimer) clearInterval(libPollTimer);
  libPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/library/scan/status');
      const data = await res.json();
      document.getElementById('libScanText').textContent = `Scanning... ${data.progress}`;
      if (!data.scanning) {
        clearInterval(libPollTimer);
        libPollTimer = null;
        document.getElementById('libScanProgress').style.display = 'none';
        document.getElementById('btnScanLib').disabled = false;
        if (data.stats) renderLibrary(data.stats);
      }
    } catch {}
  }, 2000);
}

function renderLibrary(stats) {
  // Summary cards
  const summary = document.getElementById('libSummary');
  const avgSize = stats.totalFiles > 0 ? stats.totalSizeBytes / stats.totalFiles : 0;
  const mkvCount = stats.byFormat?.mkv || 0;
  const mp4Count = stats.byFormat?.mp4 || 0;
  summary.innerHTML = `
    <div class="panel" style="padding:1rem;text-align:center;">
      <div style="font-size:2rem;font-weight:700;">${stats.totalFiles}</div>
      <div style="color:#888;font-size:.85rem;">Total Files</div>
    </div>
    <div class="panel" style="padding:1rem;text-align:center;">
      <div style="font-size:2rem;font-weight:700;">${fmtBytes(stats.totalSizeBytes)}</div>
      <div style="color:#888;font-size:.85rem;">Total Size</div>
    </div>
    <div class="panel" style="padding:1rem;text-align:center;">
      <div style="font-size:2rem;font-weight:700;">${mp4Count} / ${mkvCount}</div>
      <div style="color:#888;font-size:.85rem;">MP4 / MKV</div>
    </div>
    <div class="panel" style="padding:1rem;text-align:center;">
      <div style="font-size:2rem;font-weight:700;">${fmtBytes(avgSize)}</div>
      <div style="color:#888;font-size:.85rem;">Avg File Size</div>
    </div>
  `;

  // Charts
  renderDonut('chartFormat', stats.byFormat, { mp4: '#10b981', mkv: '#f59e0b', avi: '#ef4444' });
  renderDonut('chartCodec', stats.byCodec, { hevc: '#10b981', h264: '#3b82f6', other: '#6b7280', unknown: '#374151' });
  renderDonut('chartResolution', stats.byResolution, { '2160p': '#8b5cf6', '1080p': '#3b82f6', '720p': '#10b981', '480p': '#f59e0b', other: '#6b7280', unknown: '#374151' });
  renderBarChart('chartDisk', stats.byDirectory);
  renderLineChart('chartHistory', stats.conversionHistory || []);
}

function renderDonut(containerId, data, colors) {
  const el = document.getElementById(containerId);
  if (!data || Object.keys(data).length === 0) { el.innerHTML = '<p style="color:#888;">No data</p>'; return; }
  const total = Object.values(data).reduce((a, b) => a + b, 0);
  if (total === 0) { el.innerHTML = '<p style="color:#888;">No data</p>'; return; }

  const radius = 60, cx = 80, cy = 80, circumference = 2 * Math.PI * radius;
  let offset = 0;
  const defaultColors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#6b7280'];
  let colorIdx = 0;

  let circles = '';
  let legend = '';
  for (const [key, count] of Object.entries(data).sort((a, b) => b[1] - a[1])) {
    const pct = count / total;
    const dash = circumference * pct;
    const color = colors?.[key] || defaultColors[colorIdx++ % defaultColors.length];
    circles += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="20" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
    offset += dash;
    legend += `<div style="display:flex;align-items:center;gap:.5rem;"><span style="width:12px;height:12px;border-radius:2px;background:${color};display:inline-block;"></span>${key}: ${count} (${Math.round(pct * 100)}%)</div>`;
  }

  el.innerHTML = `<div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap;">
    <svg width="160" height="160" viewBox="0 0 160 160">${circles}
      <text x="${cx}" y="${cy}" text-anchor="middle" dy=".35em" fill="var(--text)" font-size="18" font-weight="700">${total}</text>
    </svg>
    <div style="font-size:.85rem;display:flex;flex-direction:column;gap:.25rem;">${legend}</div>
  </div>`;
}

function renderBarChart(containerId, dirs) {
  const el = document.getElementById(containerId);
  if (!dirs || dirs.length === 0) { el.innerHTML = '<p style="color:#888;">No data</p>'; return; }
  const maxSize = Math.max(...dirs.map(d => d.sizeBytes));
  el.innerHTML = dirs.map(d => {
    const pct = maxSize > 0 ? (d.sizeBytes / maxSize * 100) : 0;
    return `<div style="margin-bottom:.75rem;">
      <div style="display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:.25rem;">
        <span>${escHtml(d.name)}</span><span style="color:#888;">${fmtBytes(d.sizeBytes)} (${d.files} files)</span>
      </div>
      <div style="background:var(--card-bg);border-radius:4px;height:20px;overflow:hidden;">
        <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#3b82f6,#10b981);border-radius:4px;transition:width .3s;"></div>
      </div>
    </div>`;
  }).join('');
}

function renderLineChart(containerId, history) {
  const el = document.getElementById(containerId);
  if (!history || history.length === 0) { el.innerHTML = '<p style="color:#888;">No conversion history yet</p>'; return; }
  const w = 600, h = 200, pad = 40;
  const maxVal = Math.max(...history.map(d => d.converted + d.failed), 1);
  const xStep = history.length > 1 ? (w - 2 * pad) / (history.length - 1) : 0;

  let convertedPoints = '', failedPoints = '';
  history.forEach((d, i) => {
    const x = pad + i * xStep;
    const yC = h - pad - ((d.converted / maxVal) * (h - 2 * pad));
    const yF = h - pad - ((d.failed / maxVal) * (h - 2 * pad));
    convertedPoints += `${x},${yC} `;
    failedPoints += `${x},${yF} `;
  });

  const xLabels = history.filter((_, i) => i % Math.ceil(history.length / 6) === 0 || i === history.length - 1)
    .map((d, _, arr) => {
      const i = history.indexOf(d);
      return `<text x="${pad + i * xStep}" y="${h - 5}" text-anchor="middle" fill="var(--muted)" font-size="10">${d.date.slice(5)}</text>`;
    }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-height:200px;">
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--border)" />
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="var(--border)" />
    <polyline points="${convertedPoints.trim()}" fill="none" stroke="#10b981" stroke-width="2" />
    <polyline points="${failedPoints.trim()}" fill="none" stroke="#ef4444" stroke-width="2" />
    ${xLabels}
    <text x="${w - pad}" y="${pad - 8}" text-anchor="end" fill="var(--muted)" font-size="10">
      <tspan fill="#10b981">● Converted</tspan>  <tspan fill="#ef4444">● Failed</tspan>
    </text>
  </svg>`;
}
```

- [ ] **Step 4: Add `<script src="/js/library.js">` to `index.html`**

- [ ] **Step 5: Add `navigateTo` case for 'library' section**

In `public/js/app.js`, add 'library' to the TITLES map and ensure `navigateTo('library')` calls `loadLibrary()`.

- [ ] **Step 6: Verify in browser**

Open Library tab. Click "Scan Library". Verify charts render.

- [ ] **Step 7: Commit**

```bash
git add public/js/library.js public/index.html public/js/app.js
git commit -m "feat: add Library Overview tab with SVG/CSS charts"
```

---

## Chunk 6: Feature — Subtitle Fetch

### Task 18: Update `generate_report.py` to include TMDB IDs

**Files:**
- Modify: `scripts/generate_report.py`

- [ ] **Step 1: Add TMDB ID to `fetch_tmdb()` return dicts**

In `fetch_tmdb()`, for movies: add `"id": r.get("id")` to the returned dict.
For TV shows: add `"id": series.get("id")` to the returned dict.

- [ ] **Step 2: Add TMDB ID to report JSON builder**

In `save_json_report()`, include the `id` field from tmdb info in the JSON output for each converted/failed item.

- [ ] **Step 3: Commit**

```bash
git add scripts/generate_report.py
git commit -m "feat: include TMDB ID in report JSON for subtitle lookup"
```

---

### Task 19: Create `lib/subtitles.js`

**Files:**
- Create: `lib/subtitles.js`

- [ ] **Step 1: Write `lib/subtitles.js`**

```javascript
// lib/subtitles.js
const https = require('https');
const fs = require('fs');
const path = require('path');
const { readConfig, REPORTS_DIR } = require('./config');

const API_BASE = 'https://api.opensubtitles.com/api/v1';

function osGet(endpoint, apiKey, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const req = https.get(url.toString(), {
      timeout: 10000,
      headers: { 'Api-Key': apiKey, 'User-Agent': 'AutoConvert v2' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenSubtitles timeout')); });
    req.on('error', reject);
  });
}

function osPost(endpoint, apiKey, body = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    const postData = JSON.stringify(body);
    const req = https.request(url.toString(), {
      method: 'POST', timeout: 10000,
      headers: {
        'Api-Key': apiKey, 'User-Agent': 'AutoConvert v2',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenSubtitles timeout')); });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function testApiKey() {
  const config = readConfig();
  const apiKey = config.subtitles?.apiKey;
  if (!apiKey) throw new Error('No API key configured');
  const result = await osGet('/infos/languages', apiKey);
  if (result.status === 401) throw new Error('Invalid API key');
  if (result.status !== 200) throw new Error(`API returned status ${result.status}`);
  return { ok: true };
}

async function fetchForReport(reportPath) {
  const config = readConfig();
  if (!config.subtitles?.enabled || !config.subtitles?.apiKey) return;
  const languages = config.subtitles.languages || ['nl', 'en'];
  const apiKey = config.subtitles.apiKey;

  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { return; }
  const converted = report.converted || [];
  if (converted.length === 0) return;

  let updated = false;
  for (const item of converted) {
    const tmdbId = item.tmdb?.id;
    if (!tmdbId) {
      console.log(`[subs] No TMDB ID for ${item.basename}, skipping subtitles`);
      continue;
    }
    const mp4Path = item.mp4_path;
    if (!mp4Path || !fs.existsSync(mp4Path)) continue;

    const mp4Dir = path.dirname(mp4Path);
    const mp4Base = path.basename(mp4Path, '.mp4');
    const downloadedLangs = [];

    for (const lang of languages) {
      const srtPath = path.join(mp4Dir, `${mp4Base}.${lang}.srt`);
      if (fs.existsSync(srtPath)) {
        console.log(`[subs] Already exists: ${path.basename(srtPath)}`);
        downloadedLangs.push(lang);
        continue;
      }

      try {
        // Search by TMDB ID
        const isMovie = !item.section?.toLowerCase().includes('series');
        const searchResult = await osGet('/subtitles', apiKey, {
          tmdb_id: tmdbId,
          languages: lang,
          type: isMovie ? 'movie' : 'episode',
        });
        await sleep(250); // rate limiting

        if (searchResult.status !== 200 || !searchResult.data?.data?.length) {
          console.log(`[subs] No subtitles found for ${item.basename} (${lang})`);
          continue;
        }

        // Get download link for best match
        const bestSub = searchResult.data.data[0];
        const fileId = bestSub.attributes?.files?.[0]?.file_id;
        if (!fileId) continue;

        const dlResult = await osPost('/download', apiKey, { file_id: fileId });
        await sleep(250);

        if (dlResult.status !== 200 || !dlResult.data?.link) {
          console.log(`[subs] Could not get download link for ${item.basename} (${lang})`);
          continue;
        }

        await downloadFile(dlResult.data.link, srtPath);
        console.log(`[subs] Downloaded: ${path.basename(srtPath)}`);
        downloadedLangs.push(lang);
      } catch (err) {
        console.error(`[subs] Error fetching ${lang} for ${item.basename}: ${err.message}`);
      }
    }

    if (downloadedLangs.length > 0) {
      item.subtitles = downloadedLangs;
      updated = true;
    }
  }

  // Update report with subtitle info
  if (updated) {
    try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { testApiKey, fetchForReport };
```

- [ ] **Step 2: Verify syntax, commit**

```bash
node -c lib/subtitles.js
git add lib/subtitles.js
git commit -m "feat: add lib/subtitles.js — OpenSubtitles API client"
```

---

### Task 20: Create `routes/subtitles.js`, wire up post-conversion hook

**Files:**
- Create: `routes/subtitles.js`
- Modify: `server.js`
- Modify: `lib/convert.js`

- [ ] **Step 1: Write `routes/subtitles.js`**

```javascript
// routes/subtitles.js
const router = require('express').Router();
const { readConfig, writeConfig } = require('../lib/config');
const subtitles = require('../lib/subtitles');

router.get('/status', (req, res) => {
  const config = readConfig();
  res.json({
    enabled: config.subtitles?.enabled || false,
    hasApiKey: !!(config.subtitles?.apiKey),
    languages: config.subtitles?.languages || ['nl', 'en'],
  });
});

router.post('/config', (req, res) => {
  const { apiKey, languages, enabled } = req.body;
  const config = readConfig();
  if (!config.subtitles) config.subtitles = {};
  if (apiKey !== undefined) config.subtitles.apiKey = apiKey;
  if (languages !== undefined) config.subtitles.languages = languages;
  if (enabled !== undefined) config.subtitles.enabled = enabled;
  writeConfig(config);
  res.json({ ok: true });
});

router.post('/test', async (req, res) => {
  try {
    await subtitles.testApiKey();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 2: Mount and add post-conversion hook**

Mount in `server.js`:
```javascript
app.use('/api/subtitles', require('./routes/subtitles'));
```

In `lib/convert.js`, update `child.on('exit')` to also call subtitles:
```javascript
child.on('exit', (code, signal) => {
  console.log(`[convert] Script exited with code=${code}, signal=${signal}`);
  try { fs.closeSync(logStream); } catch {}
  if (code === 0) {
    // Find latest report JSON
    const reportFiles = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    const latestReport = reportFiles[0] ? path.join(REPORTS_DIR, reportFiles[0]) : null;
    // Post-conversion hooks (async, non-blocking)
    (async () => {
      if (latestReport) {
        try { await require('./subtitles').fetchForReport(latestReport); }
        catch (err) { console.error(`[convert] Subtitle fetch error: ${err.message}`); }
      }
      try { await require('./plex').refreshLibraries(); }
      catch (err) { console.error(`[convert] Plex refresh error: ${err.message}`); }
    })();
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add routes/subtitles.js server.js lib/convert.js
git commit -m "feat: add subtitle routes and post-conversion subtitle/plex hooks"
```

---

### Task 21: Add Subtitles settings UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/js/settings.js`

- [ ] **Step 1: Add Subtitles sub-tab in Settings**

Add tab button inside `#settingsTabs`: `<div class="tab" data-tab="tab-subtitles">Subtitles</div>`

Content:
```html
<div class="tab-content" id="tab-subtitles" style="display:none;">
  <h3>Subtitle Fetch</h3>
  <p style="color:#888;margin-bottom:1rem;">Automatically download subtitles from OpenSubtitles after conversion.</p>
  <div class="setting-row" style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem;">
    <label>Enable Subtitle Fetch</label>
    <label class="toggle"><input type="checkbox" id="subsEnabled" onchange="toggleSubtitles(this.checked)"><span class="slider"></span></label>
  </div>
  <div class="setting-row" style="margin-bottom:.75rem;">
    <label>OpenSubtitles API Key</label>
    <p style="color:#888;font-size:.85rem;margin:.25rem 0 .5rem;">Get a free key at <a href="https://www.opensubtitles.com/consumers" target="_blank" style="color:#6366f1;">opensubtitles.com</a></p>
    <input type="password" id="subsApiKey" placeholder="API key" style="width:100%;">
  </div>
  <div class="setting-row" style="margin-bottom:.75rem;">
    <label>Languages</label>
    <div id="subsLanguages" style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.5rem;">
      <!-- Populated by JS -->
    </div>
  </div>
  <div style="display:flex;gap:.5rem;margin-top:1rem;">
    <button class="btn btn-primary" onclick="saveSubtitlesConfig()">Save</button>
    <button class="btn" onclick="testSubtitlesApi()">Test API Key</button>
  </div>
</div>
```

- [ ] **Step 2: Add JS functions**

```javascript
const SUBTITLE_LANGS = [
  { code: 'nl', name: 'Nederlands' },
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
];

async function loadSubtitlesStatus() {
  try {
    const res = await fetch('/api/subtitles/status');
    const data = await res.json();
    document.getElementById('subsEnabled').checked = data.enabled;
    const langEl = document.getElementById('subsLanguages');
    langEl.innerHTML = SUBTITLE_LANGS.map(l =>
      `<label style="display:flex;align-items:center;gap:.25rem;cursor:pointer;">
        <input type="checkbox" value="${l.code}" ${data.languages.includes(l.code) ? 'checked' : ''}> ${l.name}
      </label>`
    ).join('');
  } catch {}
}

async function toggleSubtitles(enabled) {
  await fetch('/api/subtitles/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled }) });
  toast(enabled ? 'Subtitles enabled' : 'Subtitles disabled');
}

async function saveSubtitlesConfig() {
  const apiKey = document.getElementById('subsApiKey').value.trim();
  const checkboxes = document.querySelectorAll('#subsLanguages input:checked');
  const languages = [...checkboxes].map(c => c.value);
  if (!apiKey) return toast('API key required', true);
  if (languages.length === 0) return toast('Select at least one language', true);
  try {
    await fetch('/api/subtitles/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ apiKey, languages }) });
    toast('Subtitle config saved');
  } catch { toast('Failed to save', true); }
}

async function testSubtitlesApi() {
  try {
    const res = await fetch('/api/subtitles/test', { method: 'POST' });
    const data = await res.json();
    if (data.ok) toast('API key is valid!');
    else toast(data.error || 'Test failed', true);
  } catch { toast('Test failed', true); }
}
```

Add `loadSubtitlesStatus()` to init batch.

- [ ] **Step 3: Verify in browser, commit**

```bash
git add public/index.html public/js/settings.js public/js/app.js
git commit -m "feat: add Subtitles settings UI — API key, languages, test"
```

---

### Task 22: Final verification

- [ ] **Step 1: Start server and verify all tabs**

```bash
node server.js
```

Open `http://localhost:3742` and verify:
1. Convert tab: queue loads, start/stop works
2. Reports tab: reports + stats load
3. Recipients tab: list loads, add/remove works
4. Library tab: scan runs, charts render
5. Settings → General: all settings load/save
6. Settings → Media: directories load
7. Settings → Schedule: times load/save
8. Settings → Mail Server: SMTP config loads
9. Settings → HandBrake: presets load
10. Settings → Logs: log loads
11. Settings → Watch: enable/disable, stability config
12. Settings → Subtitles: API key, language checkboxes
13. Settings → Plex: URL, token, test connection
14. Theme toggle works
15. All modals work (confirm delete, resend, fail detail)

- [ ] **Step 2: Commit final state**

```bash
git add -A
git commit -m "feat: AutoConvert v2 — modular architecture, folder watch, plex, library, subtitles"
```

**Do NOT push, build, or release without explicit user permission.**
