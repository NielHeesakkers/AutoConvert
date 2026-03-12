#!/bin/bash
# Daily MKV to MP4 converter
# Scans media directories for MKV files
# Converts to MP4 using HandBrake with the configured preset
# Sends HTML email report with TMDB posters via msmtp
# Writes progress JSON to /tmp/mkv_convert_progress.json for web UI

# Paths - configurable via environment variables
APP_DIR="${APP_DIR:-/app}"
CONFIG_FILE="${CONFIG_FILE:-$APP_DIR/config/config.json}"
PRESET_FILE="${PRESET_FILE:-$APP_DIR/scripts/Niel.json}"
LOGFILE="${LOG_DIR:-$APP_DIR/logs}/daily_convert.log"
REPORT_DIR="/tmp/mkv_convert_report"
export REPORTS_DIR="${REPORTS_DIR:-${LOG_DIR:-$APP_DIR/logs}/reports}"
# Media directories: prefer MEDIA_DIRS (colon-separated), fallback to MEDIA_MOVIES/MEDIA_SERIES
if [ -n "$MEDIA_DIRS" ]; then
  IFS=':' read -ra DIRS <<< "$MEDIA_DIRS"
else
  MEDIA_MOVIES="${MEDIA_MOVIES:-/media/movies}"
  MEDIA_SERIES="${MEDIA_SERIES:-/media/series}"
  DIRS=("$MEDIA_MOVIES" "$MEDIA_SERIES")
fi

# Progress tracking paths
PROGRESS_JSON="/tmp/mkv_convert_progress.json"
HB_LOG="/tmp/mkv_convert_hb.log"

# Create reports dir if needed
mkdir -p "$REPORTS_DIR"

# Clean report dir
rm -rf "$REPORT_DIR"
mkdir -p "$REPORT_DIR"
: > "$REPORT_DIR/converted.txt"
: > "$REPORT_DIR/failed.txt"
: > "$REPORT_DIR/dupes.txt"
echo "0" > "$REPORT_DIR/skipped_empty.txt"

# Clear old progress/hb files
rm -f "$PROGRESS_JSON" "$HB_LOG"

# Helper: write a quick "done" progress so the UI shows feedback
write_quick_done() {
  local msg="$1"
  python3 -c "
import json, datetime
progress = {
    'status': 'done',
    'started': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S'),
    'finished': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S'),
    'total': 0, 'current': 0, 'current_file': '',
    'files': [], 'completed': [],
    'message': '$msg'
}
with open('$PROGRESS_JSON', 'w') as f:
    json.dump(progress, f, indent=2)
" 2>/dev/null
}

# Check if media is available
MEDIA_FOUND=false
for DIR in "${DIRS[@]}"; do
  [ -d "$DIR" ] && MEDIA_FOUND=true
done
if [ "$MEDIA_FOUND" = false ]; then
  echo "$(date) - No media directories available, skipped." >> "$LOGFILE"
  write_quick_done "No media directories available"
  exit 0
fi

# Check if HandBrakeCLI is available
if ! command -v HandBrakeCLI &>/dev/null; then
  echo "$(date) - HandBrakeCLI not found." >> "$LOGFILE"
  write_quick_done "HandBrakeCLI not found"
  exit 1
fi

# Check if already running
LOCKFILE="/tmp/daily_mkv_convert.lock"
if [ -f "$LOCKFILE" ]; then
  PID=$(cat "$LOCKFILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "$(date) - Conversion already running (PID $PID), skipped." >> "$LOGFILE"
    exit 0
  fi
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

export START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S")

echo "" >> "$LOGFILE"
echo "=== Daily conversion started: $(date) ===" >> "$LOGFILE"

# ─── Extract preset name from JSON ───
PRESET_NAME=$(python3 -c "import json; print(json.load(open('$PRESET_FILE'))['PresetList'][0]['PresetName'])" 2>/dev/null)
if [ -z "$PRESET_NAME" ]; then
  echo "$(date) - Could not extract preset name from $PRESET_FILE" >> "$LOGFILE"
  exit 1
fi
echo "Using preset: $PRESET_NAME from $PRESET_FILE" >> "$LOGFILE"

# ─── Detect encoder compatibility ───
# The preset uses vt_h265_10bit (Apple VideoToolbox) and ca_aac (Core Audio)
# which are macOS-only. Detect available encoders and override if needed.
ENCODER_OVERRIDES=""
HB_HELP=$(HandBrakeCLI --help 2>&1 || echo "")
AVAILABLE_VENCODERS=$(echo "$HB_HELP" | sed -n '/--encoder <string>/,/--encoder-preset/p')
AVAILABLE_AENCODERS=$(echo "$HB_HELP" | sed -n '/--aencoder <string>/,/--audio-copy-mask/p')

# Check video encoder
PRESET_VENCODER=$(python3 -c "import json; print(json.load(open('$PRESET_FILE'))['PresetList'][0].get('VideoEncoder',''))" 2>/dev/null)
if [ -n "$PRESET_VENCODER" ] && ! echo "$AVAILABLE_VENCODERS" | grep -q "$PRESET_VENCODER"; then
  # Preset encoder not available, find best fallback
  if echo "$AVAILABLE_VENCODERS" | grep -q "x265_10bit"; then
    ENCODER_OVERRIDES="-e x265_10bit -q 22 --encoder-preset medium"
    echo "  Encoder override: $PRESET_VENCODER → x265_10bit (CRF 22, medium)" >> "$LOGFILE"
  elif echo "$AVAILABLE_VENCODERS" | grep -q "x265"; then
    ENCODER_OVERRIDES="-e x265 -q 22 --encoder-preset medium"
    echo "  Encoder override: $PRESET_VENCODER → x265 (CRF 22, medium)" >> "$LOGFILE"
  elif echo "$AVAILABLE_VENCODERS" | grep -q "x264"; then
    ENCODER_OVERRIDES="-e x264 -q 20 --encoder-preset medium"
    echo "  Encoder override: $PRESET_VENCODER → x264 (CRF 20, medium)" >> "$LOGFILE"
  fi
else
  echo "  Using preset encoder: ${PRESET_VENCODER:-unknown}" >> "$LOGFILE"
fi

# Check audio encoder
PRESET_AENCODER=$(python3 -c "import json; print(json.load(open('$PRESET_FILE'))['PresetList'][0]['AudioList'][0].get('AudioEncoder',''))" 2>/dev/null)
if [ -n "$PRESET_AENCODER" ] && ! echo "$AVAILABLE_AENCODERS" | grep -q "$PRESET_AENCODER"; then
  if echo "$AVAILABLE_AENCODERS" | grep -q "av_aac"; then
    ENCODER_OVERRIDES="$ENCODER_OVERRIDES -E av_aac"
    echo "  Audio encoder override: $PRESET_AENCODER → av_aac" >> "$LOGFILE"
  elif echo "$AVAILABLE_AENCODERS" | grep -q "fdk_aac"; then
    ENCODER_OVERRIDES="$ENCODER_OVERRIDES -E fdk_aac"
    echo "  Audio encoder override: $PRESET_AENCODER → fdk_aac" >> "$LOGFILE"
  fi
else
  echo "  Using preset audio encoder: ${PRESET_AENCODER:-unknown}" >> "$LOGFILE"
fi

# ─── PASS 1: Scan all directories, remove dupes, count empties, build master list ───
MASTER_LIST="/tmp/daily_mkv_master_list.txt"
: > "$MASTER_LIST"

for DIR in "${DIRS[@]}"; do
  [ ! -d "$DIR" ] && continue
  DIRNAME=$(basename "$DIR")

  # Find all non-empty and empty MKVs
  find "$DIR" -name '*.mkv' ! -empty -print | sort > /tmp/mkv_all_list.txt
  find "$DIR" -name '*.mkv' -empty -print > /tmp/mkv_empty_list.txt

  # Remove MKVs where MP4 already exists (dupes)
  while IFS= read -r mkv <&3; do
    mp4="${mkv%.mkv}.mp4"
    if [ -f "$mp4" ]; then
      rm "$mkv"
      echo "$DIRNAME|$(basename "$mkv")" >> "$REPORT_DIR/dupes.txt"
      echo "  Duplicate removed: $(basename "$mkv")" >> "$LOGFILE"
    fi
  done 3< /tmp/mkv_all_list.txt

  # Count empty MKVs
  EMPTY_COUNT=$(wc -l < /tmp/mkv_empty_list.txt | tr -d ' ')
  CURRENT=$(cat "$REPORT_DIR/skipped_empty.txt")
  echo "$((CURRENT + EMPTY_COUNT))" > "$REPORT_DIR/skipped_empty.txt"

  # Build remaining non-empty MKVs into master list (with section tag)
  find "$DIR" -name '*.mkv' ! -empty -print | sort | while IFS= read -r mkv; do
    echo "${DIRNAME}|${mkv}"
  done >> "$MASTER_LIST"
done

TOTAL_COUNT=$(wc -l < "$MASTER_LIST" | tr -d ' ')
echo "  Total $TOTAL_COUNT MKV files found across all directories" >> "$LOGFILE"

# ─── Apply custom file order if provided ───
if [ -n "$FILE_ORDER" ] && [ "$TOTAL_COUNT" -gt 0 ]; then
  python3 -c "
import sys, os
order_paths = [p.strip() for p in '''$FILE_ORDER'''.strip().split('\n') if p.strip()]
# Read master list entries (section|path)
entries = {}
ordered = []
with open('$MASTER_LIST') as f:
    for line in f:
        line = line.strip()
        if '|' not in line: continue
        section, path = line.split('|', 1)
        entries[path] = (section, path)
# Add ordered files first
for p in order_paths:
    if p in entries:
        s, pa = entries.pop(p)
        ordered.append(f'{s}|{pa}')
# Then remaining files not in order
for path in sorted(entries.keys()):
    s, pa = entries[path]
    ordered.append(f'{s}|{pa}')
with open('$MASTER_LIST', 'w') as f:
    for line in ordered:
        f.write(line + '\n')
" 2>/dev/null && echo "  Applied custom file order" >> "$LOGFILE"
fi

# ─── Build initial progress JSON with complete file list ───
if [ "$TOTAL_COUNT" -gt 0 ]; then
  python3 -c "
import json, subprocess, os

master_file = '$MASTER_LIST'
files = []
with open(master_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        section, path = line.split('|', 1)
        name = os.path.basename(path)
        result = subprocess.run(['du', '-h', path], capture_output=True, text=True)
        size = result.stdout.split()[0] if result.stdout else '?'
        files.append({'section': section, 'name': name, 'size': size, 'path': path})

progress = {
    'status': 'running',
    'started': '$START_TIME',
    'total': len(files),
    'current': 0,
    'current_file': '',
    'files': [{'section': f['section'], 'name': f['name'], 'size': f['size']} for f in files],
    'completed': []
}

with open('$PROGRESS_JSON', 'w') as out:
    json.dump(progress, out, indent=2)

# Also write the path list for bash to iterate
with open('${MASTER_LIST}.paths', 'w') as out:
    for f in files:
        out.write(f['path'] + '\n')

with open('${MASTER_LIST}.sections', 'w') as out:
    for f in files:
        out.write(f['section'] + '\n')
"
fi

# ─── PASS 2: Convert all files from master list ───
if [ "$TOTAL_COUNT" -eq 0 ]; then
  echo "  No MKV files to convert." >> "$LOGFILE"
  # Write a progress JSON so the UI can show "no files" feedback
  python3 -c "
import json
progress = {
    'status': 'done',
    'started': '$START_TIME',
    'finished': '$START_TIME',
    'total': 0,
    'current': 0,
    'current_file': '',
    'files': [],
    'completed': []
}
with open('$PROGRESS_JSON', 'w') as f:
    json.dump(progress, f, indent=2)
"
else
  INDEX=0
  while IFS='|' read -r DIRNAME mkv <&3; do
    dir=$(dirname "$mkv")
    base=$(basename "$mkv" .mkv)
    mp4="${dir}/${base}.mp4"
    filesize=$(du -h "$mkv" | awk '{print $1}')

    echo "  Converting: $(basename "$mkv")" >> "$LOGFILE"

    # Update progress JSON: mark current file
    python3 -c "
import json
with open('$PROGRESS_JSON') as f:
    p = json.load(f)
p['current'] = $INDEX
p['current_file'] = '${base}'
with open('$PROGRESS_JSON', 'w') as f:
    json.dump(p, f, indent=2)
"

    # Clear HandBrake log for this file
    : > "$HB_LOG"

    CONV_START=$(date +%s)
    # shellcheck disable=SC2086
    HandBrakeCLI \
      --preset-import-file "$PRESET_FILE" \
      --preset "$PRESET_NAME" \
      -i "$mkv" \
      -o "$mp4" \
      $ENCODER_OVERRIDES \
      </dev/null \
      &>"$HB_LOG"
    RESULT=$?
    CONV_END=$(date +%s)
    DURATION=$(( (CONV_END - CONV_START) / 60 ))

    if [ $RESULT -eq 0 ] && [ -f "$mp4" ]; then
      newsize=$(du -h "$mp4" | awk '{print $1}')
      if [ "${DELETE_ORIGINALS:-1}" = "1" ]; then
        rm "$mkv"
      fi
      echo "${DIRNAME}|${base}|${filesize}|${newsize}|${DURATION}|${mp4}" >> "$REPORT_DIR/converted.txt"
      echo "    OK" >> "$LOGFILE"
      CONV_STATUS="ok"
      CONV_NEWSIZE="$newsize"
    else
      echo "${DIRNAME}|$(basename "$mkv")|${filesize}" >> "$REPORT_DIR/failed.txt"
      echo "    FAILED" >> "$LOGFILE"
      CONV_STATUS="failed"
      CONV_NEWSIZE=""
    fi

    # Update progress JSON: mark file completed
    python3 -c "
import json
with open('$PROGRESS_JSON') as f:
    p = json.load(f)
entry = {'index': $INDEX, 'status': '$CONV_STATUS', 'duration': $DURATION}
if '$CONV_NEWSIZE':
    entry['new_size'] = '$CONV_NEWSIZE'
p['completed'].append(entry)
with open('$PROGRESS_JSON', 'w') as f:
    json.dump(p, f, indent=2)
"

    INDEX=$((INDEX + 1))
  done 3< "$MASTER_LIST"
fi

SUCCESS=$(wc -l < "$REPORT_DIR/converted.txt" | tr -d ' ')
FAILED=$(wc -l < "$REPORT_DIR/failed.txt" | tr -d ' ')
DUPES=$(wc -l < "$REPORT_DIR/dupes.txt" | tr -d ' ')

export END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S")

# Update progress JSON: mark done
if [ -f "$PROGRESS_JSON" ]; then
  python3 -c "
import json
with open('$PROGRESS_JSON') as f:
    p = json.load(f)
p['status'] = 'done'
p['finished'] = '$END_TIME'
with open('$PROGRESS_JSON', 'w') as f:
    json.dump(p, f, indent=2)
"
fi

echo "=== Done: $(date) | Converted: $SUCCESS | Failed: $FAILED | Dupes removed: $DUPES ===" >> "$LOGFILE"

# Generate report and optionally send email (skip if SKIP_EMAIL=1, email sent by separate cron)
if [ "$SUCCESS" -gt 0 ] || [ "$FAILED" -gt 0 ] || [ "$DUPES" -gt 0 ]; then
  PYTHON_BIN=$(command -v python3)
  if [ "${SKIP_EMAIL:-0}" = "1" ]; then
    # Only generate JSON report, email will be sent by the scheduled email cron
    $PYTHON_BIN "$APP_DIR/scripts/generate_report.py" "$REPORT_DIR" "$CONFIG_FILE" "$REPORTS_DIR" > /dev/null
    echo "  Report saved, email deferred to scheduled time." >> "$LOGFILE"
  else
    MSMTP_BIN=$(command -v msmtp)
    RECIPIENTS=$($PYTHON_BIN -c "import json; print(' '.join(r['email'] for r in json.load(open('$CONFIG_FILE'))['recipients'] if r.get('active', True)))")
    if [ -n "$RECIPIENTS" ]; then
      $PYTHON_BIN "$APP_DIR/scripts/generate_report.py" "$REPORT_DIR" "$CONFIG_FILE" "$REPORTS_DIR" | $MSMTP_BIN $RECIPIENTS
    fi
  fi
else
  echo "  Nothing to report, no email sent." >> "$LOGFILE"
fi
