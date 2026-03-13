# AutoConvert v2: Full Refactor + New Features

**Date:** 2026-03-13
**Status:** Approved

## Overview

Full codebase refactor of AutoConvert (server.js ~1600 lines, index.html ~1900 lines) into a modular architecture, plus four new features: Folder Watch, Subtitle Fetch, Plex Refresh, and Library Overview.

## Goals

1. Split monolithic server.js into thin router + feature modules
2. Split monolithic index.html into separate JS/CSS files
3. Add Folder Watch: realtime MKV detection with auto-conversion
4. Add Subtitle Fetch: OpenSubtitles integration for automatic .srt downloads
5. Add Plex Refresh: trigger Plex library scan after conversion
6. Add Library Overview: dashboard with media library statistics and charts

## Constraints

- No frontend framework or build step — vanilla JS with separate `<script>` files
- No new frontend dependencies — charts built with pure CSS/SVG
- One new backend dependency: `chokidar` for reliable file watching
- Zero breaking changes to existing functionality
- All new features are opt-in via Settings toggles
- Never push/build/release without explicit user permission

---

## Architecture: Server-side

### Current State

`server.js` is a single 1600+ line file containing Express setup, middleware, auth, cron scheduling, email logic, conversion orchestration, report management, preset CRUD, backup/restore, debug endpoints, and directory scanning.

### New Structure

```
server.js                    <- Thin entry: Express setup, middleware, auth, mount routes
lib/
  config.js                  <- readConfig(), writeConfig(), getMediaDirs(), getBackupDir(),
                                path resolution (APP_MODE, APP_SUPPORT, CONFIG_PATH, PRESETS_DIR,
                                LOG_DIR, REPORTS_DIR, etc.), DEFAULT_CONFIG, deep merge with defaults
  cron.js                    <- setupCron(), setupScanCron(), setupEmailCron(), sendDailyReportEmail()
  email.js                   <- writeMsmtprc(), sendTestEmail(), msmtp pipe helpers
  convert.js                 <- runConvertScript(), isRunning(), checkDiskSpaceWarnings(),
                                post-conversion hooks (subtitles, plex refresh)
  watcher.js                 <- NEW: FSWatcher with chokidar, stability check, auto-trigger
  subtitles.js               <- NEW: OpenSubtitles API client, .srt download per language
  plex.js                    <- NEW: Plex refresh API calls after conversion
  library-scan.js            <- NEW: ffprobe scan, stats calculation, result caching
routes/
  auth.js                    <- /api/auth/*: status, setup, login, logout, change-password, delete-user, reset
  convert.js                 <- /api/convert, /api/convert/stop, /api/convert/progress, /api/convert/progress/clear,
                                /api/status, /api/scan, /api/find-mp4, /api/download, /api/tmdb/lookup
  reports.js                 <- /api/reports, /api/reports/stats, /api/reports/:filename (DELETE),
                                /api/reports/:filename/resend
  settings.js                <- /api/app-settings (GET/POST), /api/schedule (GET/POST),
                                /api/recipients (GET/POST), /api/recipients/toggle,
                                /api/smtp (GET/POST), /api/test-email, /api/test-smtp,
                                /api/media-dirs (GET/POST/DELETE), /api/directories,
                                /api/disk-space, /api/choose-directory,
                                /api/log (GET), /api/logs (DELETE), /api/version
  presets.js                 <- /api/presets (GET/POST), /api/presets/:filename/activate,
                                /api/presets/:filename (DELETE), /api/presets/:filename/download,
                                /api/handbrake/encoders
  library.js                 <- NEW: /api/library/stats, /api/library/scan, /api/library/scan/status,
                                /api/library/scan/cancel
  watch.js                   <- NEW: /api/watch/status, /api/watch/toggle, /api/watch/config
  subtitles.js               <- NEW: /api/subtitles/status, /api/subtitles/config, /api/subtitles/test
  plex.js                    <- NEW: /api/plex/status, /api/plex/config, /api/plex/test, /api/plex/refresh
  debug.js                   <- /api/debug/hblog, /api/debug/paths
  backup.js                  <- /api/backups (GET/POST), /api/backups/:filename (DELETE),
                                /api/backups/reveal, /api/backups/restore,
                                /api/export, /api/import
```

**All existing endpoint paths are preserved exactly.** No URL changes, no breaking changes to the frontend.

### server.js (thin entry point)

Responsibilities:
- Express app creation and middleware (session, JSON, static)
- Authentication middleware
- Rate limiting
- Mount all route modules
- Start HTTP server
- Call `setupCron()` and `watcher.init()` on startup

### Shared module pattern

Each `lib/` module exports functions. Each `routes/` module exports an Express Router. Example:

```javascript
// lib/config.js
const readConfig = () => { ... };
const writeConfig = (config) => { ... };
module.exports = { readConfig, writeConfig, getMediaDirs, ... };

// routes/convert.js
const router = require('express').Router();
const { runConvertScript, isRunning } = require('../lib/convert');
router.post('/', (req, res) => { ... });
module.exports = router;

// server.js
app.use('/api/convert', require('./routes/convert'));
app.use('/api/reports', require('./routes/reports'));
```

---

## Architecture: Frontend

### Current State

`index.html` is a single 1900+ line file containing all HTML, CSS, and JavaScript.

### New Structure

```
public/
  index.html              <- HTML structure only (tabs, modals, layout)
  css/
    style.css             <- All styles extracted from index.html
  js/
    app.js                <- Init, theme toggle, auth, tab navigation, toast notifications
    convert.js            <- Conversion tab: start/stop, progress, queue management
    reports.js            <- Reports tab: list, delete, resend, fail detail modal
    settings.js           <- Settings tabs: all config panels
    library.js            <- NEW: Library Overview tab with SVG/CSS charts
    modals.js             <- Shared modal system (confirm, resend, fail detail)
    utils.js              <- Shared helpers (formatBytes, formatDuration, debounce, etc.)
```

All JS files loaded via `<script>` tags in index.html (no ES modules, no bundler). Functions remain global — consistent with existing pattern. Load order: utils.js, modals.js, app.js, then feature files.

### Key function-to-file mapping

**utils.js**: `formatBytes()`, `formatDuration()`, `escapeHtml()`, `debounce()`, `toast()`
**modals.js**: `showConfirm()`, `resolveConfirm()`, `showResendModal()`, `closeResendModal()`, `confirmResend()`, `showFailDetail()`, `closeFailDetail()`
**app.js**: `init()`, `switchTab()`, `loadStatus()`, `checkAuth()`, `login()`, `logout()`, `toggleTheme()`, `loadVersion()`
**convert.js**: `startConvert()`, `stopConvert()`, `loadProgress()`, `pollProgress()`, `loadConvQueue()`, `renderTmdbCard()`, `renderQueueItem()`, `toggleExclude()`, `moveQueueItem()`
**reports.js**: `loadReports()`, `loadReportStats()`, `deleteReport()`, `deleteAllLogs()`, `resendReport()`, `renderReportItem()`, `loadMoreReports()`
**settings.js**: `loadSettings()`, `saveSettings()`, `loadRecipients()`, `addRecipient()`, `toggleRecipient()`, `loadSmtp()`, `saveSmtp()`, `testEmail()`, `testSmtp()`, `loadSchedule()`, `saveSchedule()`, `loadPresets()`, `uploadPreset()`, `activatePreset()`, `deletePreset()`, `loadLog()`, `clearLog()`, `loadMediaDirs()`, `addMediaDir()`, `removeMediaDir()`, `loadBackups()`, `createBackup()`, `restoreBackup()`, `loadDiskSpace()`, `loadAppSettings()`, `saveAppSettings()`, `loadWatchSettings()`, `saveWatchSettings()`, `loadSubtitleSettings()`, `saveSubtitleSettings()`, `loadPlexSettings()`, `savePlexSettings()`, `testPlexConnection()`
**library.js**: `loadLibrary()`, `scanLibrary()`, `renderCharts()`, `renderDonut()`, `renderBarChart()`, `renderLineChart()`, `pollScanProgress()`

### New UI Elements

**Library tab** (new top-level tab alongside Convert / Reports / Recipients / Settings):
- Summary cards row: total files, total size, MKV vs MP4 ratio, avg file size
- Disk usage per directory: horizontal CSS bar chart
- Format distribution (MKV/MP4/other): SVG donut chart
- Codec breakdown (H.264/H.265/other): SVG donut chart
- Resolution distribution (720p/1080p/4K): SVG donut chart
- Conversion history: SVG polyline chart — aggregated per day, last 30 days, from existing report JSON files
- "Scan Library" button with progress indicator

**Charts implementation:** Pure CSS/SVG, zero external dependencies:
- Donut charts: SVG `<circle>` with `stroke-dasharray` and `stroke-dashoffset`
- Bar charts: CSS flexbox with percentage widths
- Line chart: SVG `<polyline>` with data points

**Settings sub-tabs (new):**
- **Watch**: enable/disable toggle, stability wait time (seconds), status indicator ("Watching 2 directories" / "Disabled")
- **Subtitles**: OpenSubtitles API key field, language checkboxes (NL, EN, DE, FR, ES, PT), enable/disable toggle
- **Plex**: Plex URL field (default: http://localhost:32400), Plex token field, enable/disable toggle, "Test Connection" button, auto-detected library list with checkboxes

---

## Feature: Folder Watch

### Implementation: `lib/watcher.js`

Uses `chokidar` npm package for reliable cross-platform file watching (handles macOS FSEvents properly, unlike raw `fs.watch`).

### Behavior

1. On startup (if enabled): start watching all configured media directories recursively
2. Filter: only `.mkv` files trigger the watcher
3. On new file detected: start stability check
   - Check file size every 10 seconds
   - After 30 seconds of stable size (configurable): file is ready
4. Check `isRunning()`:
   - If conversion already running: add file to internal queue
   - If idle: call `runConvertScript()` with just this file
5. On conversion complete: check queue, process next if any
6. Watcher restarts when media directories change in Settings

### Configuration

```json
{
  "watch": {
    "enabled": false,
    "stabilitySeconds": 30
  }
}
```

### API Endpoints

- `GET /api/watch/status` — returns `{ enabled, watching, directories, queueLength }`
- `POST /api/watch/toggle` — enable/disable watcher
- `POST /api/watch/config` — update stability seconds

### Edge Cases

- File deleted before stability check completes: remove from tracking, log warning
- Very large file still copying: 30s default handles most cases; user can increase
- Watcher disabled while files in queue: queue is cleared, logged
- Media directory unmounted: chokidar handles gracefully, logs error, continues watching other dirs

### Relationship with Scan Interval

The existing "scan interval" cron feature (`setupScanCron`) and Folder Watch serve similar purposes. When Folder Watch is enabled, scan interval is automatically disabled (and greyed out in the UI) since realtime watching supersedes periodic polling. If Folder Watch is disabled, scan interval works as before. Both cannot trigger duplicate conversions because `isRunning()` guards all conversion starts.

---

## Feature: Subtitle Fetch

### Implementation: `lib/subtitles.js`

Integrates with OpenSubtitles REST API (v2, requires free API key).

### Behavior

1. After the conversion batch completes and generate_report.py has run:
2. `lib/convert.js` reads the latest report JSON (which contains TMDB IDs from generate_report.py)
3. For each successfully converted file with a TMDB ID:
   - Search OpenSubtitles API by TMDB ID (supported by their v2 API)
   - For each configured language: download best-rated .srt
   - Save next to MP4: `Movie Name (2024).nl.srt`, `Movie Name (2024).en.srt`
4. Skip if .srt for that language already exists in the directory
5. Update report JSON per item: `"subtitles": ["nl", "en"]`

### Integration Point

Called from `lib/convert.js` in the `child.on('exit')` handler, after the bash script has finished (which includes the generate_report.py step that fetches TMDB data). This is a post-conversion hook — the same place where Plex refresh is triggered.

Flow: bash script exits → `lib/convert.js` reads latest report JSON → calls `subtitles.fetchForReport(reportPath)` → calls `plex.refreshIfEnabled()` → done.

Note: generate_report.py fetches TMDB IDs (not IMDB IDs). OpenSubtitles API v2 supports search by `tmdb_id` directly, so no extra IMDB lookup is needed.

**Required change to generate_report.py:** The current `fetch_tmdb()` function does not include the TMDB numeric ID in the returned dict or report JSON. A one-line addition is needed: add `"id": r.get("id")` (movies) and `"id": series.get("id")` (TV) to the return dicts in `fetch_tmdb()`, and propagate to the report JSON `tmdb` object. This gives `lib/subtitles.js` the TMDB ID it needs for OpenSubtitles lookup.

### Configuration

```json
{
  "subtitles": {
    "enabled": false,
    "apiKey": "",
    "languages": ["nl", "en"]
  }
}
```

### API Endpoints

- `GET /api/subtitles/status` — returns config status
- `POST /api/subtitles/config` — update API key + languages
- `POST /api/subtitles/test` — test API key validity

### Error Handling

- API down or timeout (10s): log warning, skip subtitles, conversion report unaffected
- No match found: log "no subtitles found for <title> (<lang>)", continue
- Invalid API key: return clear error on test, disable auto-fetch with warning
- Rate limiting: OpenSubtitles allows 5 req/sec on free tier; requests are serialized with 250ms delay between each. For a batch of 20 files with 2 languages each, that's ~60 requests taking ~15 seconds total — acceptable as post-conversion background work

---

## Feature: Plex Refresh

### Implementation: `lib/plex.js`

Simple HTTP client for Plex Media Server API.

### Behavior

1. After conversion batch completes (all files done):
2. `GET {plexUrl}/library/sections?X-Plex-Token={token}` — list all libraries
3. Match libraries to media directories by path comparison
4. `GET {plexUrl}/library/sections/{id}/refresh?X-Plex-Token={token}` — trigger scan per matched library
5. Log which libraries were refreshed

### Configuration

```json
{
  "plex": {
    "enabled": false,
    "url": "http://localhost:32400",
    "token": "",
    "libraryIds": []
  }
}
```

`libraryIds` is auto-populated when user clicks "Test Connection" — shows discovered libraries with checkboxes. If empty, refreshes all libraries.

### API Endpoints

- `GET /api/plex/status` — returns config + connection status
- `POST /api/plex/config` — update URL + token
- `POST /api/plex/test` — test connection, return discovered libraries
- `POST /api/plex/refresh` — manual refresh trigger

### Error Handling

- Plex unreachable (5s timeout): log error, don't block conversion completion
- Invalid token: clear error on test, log warning on auto-refresh
- Library not found: log warning, skip that library

---

## Feature: Library Overview

### Implementation: `lib/library-scan.js`

Scans all media directories using `ffprobe` (if available) for detailed codec/resolution info, falls back to file extension + size only.

### Behavior

1. On "Scan Library" click or cache expired (1 hour):
2. Walk all media directories recursively
3. Per video file: run `ffprobe -v quiet -print_format json -show_streams -show_format <file>`
4. Extract: codec name, resolution, bitrate, duration, file size, container format
5. If ffprobe unavailable: use file extension + `fs.stat` for size only
6. Aggregate into stats object
7. Cache to `APP_SUPPORT/library_cache.json` (or `__dirname/library_cache.json` in dev mode) with timestamp — survives reboots unlike /tmp
8. Conversion history chart data: aggregated from existing report JSON files

### Stats Object

```json
{
  "scannedAt": "2026-03-13T10:00:00Z",
  "totalFiles": 342,
  "totalSizeBytes": 1843200000000,
  "byFormat": { "mp4": 280, "mkv": 58, "avi": 4 },
  "byCodec": { "hevc": 200, "h264": 130, "other": 12 },
  "byResolution": { "2160p": 45, "1080p": 250, "720p": 40, "other": 7 },
  "byDirectory": [
    { "name": "Movies", "path": "/Volumes/Media/Movies", "files": 200, "sizeBytes": 1200000000000 },
    { "name": "Series", "path": "/Volumes/Media/Series", "files": 142, "sizeBytes": 643200000000 }
  ],
  "conversionHistory": [
    { "date": "2026-03-01", "converted": 5, "failed": 1 },
    { "date": "2026-03-07", "converted": 12, "failed": 0 }
  ]
}
```

### API Endpoints

- `GET /api/library/stats` — return cached stats (or trigger scan if no cache)
- `POST /api/library/scan` — force rescan, returns immediately with `{ scanning: true }`
- `GET /api/library/scan/status` — poll scan progress `{ scanning: bool, progress: "45/342" }`

### Performance

- Large libraries (1000+ files): scan runs in background, frontend polls progress
- ffprobe called with 5s timeout per file; if it hangs, skip that file
- Scan is cancellable via `POST /api/library/scan/cancel`
- Results cached for 1 hour to avoid repeated expensive scans

---

## Configuration Changes

### New config.json fields

```json
{
  "watch": {
    "enabled": false,
    "stabilitySeconds": 30
  },
  "subtitles": {
    "enabled": false,
    "apiKey": "",
    "languages": ["nl", "en"]
  },
  "plex": {
    "enabled": false,
    "url": "http://localhost:32400",
    "token": "",
    "libraryIds": []
  }
}
```

All new features default to disabled. Existing configs without these fields work unchanged — `readConfig()` performs a deep merge with `DEFAULT_CONFIG` so missing keys get defaults without overwriting existing values. The merge is implemented in `lib/config.js`:

```javascript
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
```

---

## Error Handling Pattern

All lib modules follow the same pattern:

1. Each module logs with its own prefix: `[watch]`, `[subs]`, `[plex]`, `[library]`
2. No module crash stops the main application
3. API endpoints always return JSON: `{ error: "message" }` on failure
4. External service failures (OpenSubtitles, Plex) are logged but never block conversion
5. Settings validation: "Test Connection" buttons for Plex and OpenSubtitles before enabling

---

## Migration Path

1. Refactor server.js into lib/ and routes/ modules (zero behavior change, verify manually)
2. Refactor index.html into separate JS/CSS files (zero behavior change, verify manually)
3. Add Folder Watch (self-contained, no external API dependency)
4. Add Plex Refresh (simple HTTP calls, easy to test with running Plex)
5. Add Library Overview (ffprobe scan, charts — most UI work)
6. Add Subtitle Fetch (external API, most complex integration — last)

Each step is independently deployable and testable. No automated test suite exists; verification is manual via the web UI and console logs.
