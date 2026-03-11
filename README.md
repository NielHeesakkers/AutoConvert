# AutoConvert

Automatic MKV to MP4 conversion using HandBrakeCLI with a web interface, TMDB-enriched email reports, and a native macOS menu bar app.

## Features

- **Automatic conversion** — Daily scheduled MKV to MP4 conversion with configurable scan intervals
- **Web interface** — Full management UI at `localhost:3742`
- **macOS menu bar app** — Start/stop conversions, check for updates, start at login
- **TMDB integration** — Movie/series posters, ratings, and metadata in the conversion queue and reports
- **Multi-preset support** — Upload, manage, and switch between HandBrake presets
- **Email reports** — HTML email reports with posters and size comparisons after each conversion
- **Report statistics** — Overview of total movies/series converted and disk space saved
- **Backup & restore** — Create, restore, and manage configuration backups
- **Import/export** — Transfer all settings between installations

## Install

1. Download `AutoConvert.dmg` from [Releases](https://github.com/NielHeesakkers/AutoConvert/releases)
2. Open the DMG and drag AutoConvert to Applications
3. Launch AutoConvert — it appears in the menu bar
4. Open the Web UI from the menu bar icon

### Requirements

- macOS 14.0+
- [HandBrakeCLI](https://handbrake.fr) — install via `brew install handbrake`

## Web Interface

Access at **http://localhost:3742** with these sections:

| Section | Description |
|---------|-------------|
| **Conversion** | Start/stop conversions, scan directories, view queue with TMDB info |
| **Reports** | Conversion history with stats overview (movies, series, space saved) |
| **Recipients** | Manage email recipients for conversion reports |
| **Settings** | General, Media, Schedule, Mail Server, HandBrake tabs |

### Settings

- **General** — Auto-delete originals toggle, server port, backup management, import/export
- **Media** — Configure directories to scan for MKV files
- **Schedule** — Daily conversion time and scan interval
- **Mail Server** — SMTP configuration with connection test and test email
- **HandBrake** — Upload and manage presets, view encoder details

## Menu Bar App

The macOS menu bar app provides quick access:

- **Check for Updates** — Downloads new versions from GitHub Releases
- **Open Web UI** — Opens the web interface in your browser
- **Start Conversion** — Triggers a conversion run
- **Start at Login** — Auto-launch on macOS startup

## Building from Source

```bash
cd macos-app
bash build.sh
```

This compiles the Swift app, bundles Node.js and the server, and creates `AutoConvert.dmg`.

## Releasing Updates

```bash
# 1. Bump version in version.json and macos-app/Resources/Info.plist
# 2. Build
cd macos-app && bash build.sh

# 3. Commit & push
git add -A && git commit -m "v1.XX: description" && git push

# 4. Create release
gh release create v1.XX macos-app/build/AutoConvert.dmg --title "v1.XX" --notes "changelog"
```

## Data Locations

| Path | Contents |
|------|----------|
| `~/Library/Application Support/AutoConvert/config.json` | Configuration |
| `~/Library/Application Support/AutoConvert/presets/` | HandBrake presets |
| `~/Library/Application Support/AutoConvert/reports/` | Conversion reports |
| `~/Library/Application Support/AutoConvert/backups/` | Config backups |
