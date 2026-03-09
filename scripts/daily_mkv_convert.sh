#!/bin/bash
# Daily MKV to MP4 converter
# Scans media directories for MKV files
# Converts to MP4 using HandBrake with the "Niel" preset
# Sends HTML email report with TMDB posters via msmtp

# Paths - configurable via environment variables
APP_DIR="${APP_DIR:-/app}"
CONFIG_FILE="${CONFIG_FILE:-$APP_DIR/config/config.json}"
PRESET_FILE="${PRESET_FILE:-$APP_DIR/scripts/Niel.json}"
LOGFILE="${LOG_DIR:-$APP_DIR/logs}/daily_convert.log"
REPORT_DIR="/tmp/mkv_convert_report"
MEDIA_MOVIES="${MEDIA_MOVIES:-/media/movies}"
MEDIA_SERIES="${MEDIA_SERIES:-/media/series}"
DIRS=("$MEDIA_MOVIES" "$MEDIA_SERIES")

# Clean report dir
rm -rf "$REPORT_DIR"
mkdir -p "$REPORT_DIR"
: > "$REPORT_DIR/converted.txt"
: > "$REPORT_DIR/failed.txt"
: > "$REPORT_DIR/dupes.txt"
echo "0" > "$REPORT_DIR/skipped_empty.txt"

# Check if media is available
MEDIA_FOUND=false
for DIR in "${DIRS[@]}"; do
  [ -d "$DIR" ] && MEDIA_FOUND=true
done
if [ "$MEDIA_FOUND" = false ]; then
  echo "$(date) - Geen media mappen beschikbaar, overgeslagen." >> "$LOGFILE"
  exit 0
fi

# Check if HandBrakeCLI is available
if ! command -v HandBrakeCLI &>/dev/null; then
  echo "$(date) - HandBrakeCLI niet gevonden." >> "$LOGFILE"
  exit 1
fi

# Check if already running
LOCKFILE="/tmp/daily_mkv_convert.lock"
if [ -f "$LOCKFILE" ]; then
  PID=$(cat "$LOCKFILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "$(date) - Conversie draait al (PID $PID), overgeslagen." >> "$LOGFILE"
    exit 0
  fi
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

echo "" >> "$LOGFILE"
echo "=== Dagelijkse conversie gestart: $(date) ===" >> "$LOGFILE"

for DIR in "${DIRS[@]}"; do
  [ ! -d "$DIR" ] && continue
  DIRNAME=$(basename "$DIR")

  # Step 1: Remove MKVs where MP4 already exists
  find "$DIR" -name '*.mkv' ! -empty -print | sort > /tmp/mkv_all_list.txt
  find "$DIR" -name '*.mkv' -empty -print > /tmp/mkv_empty_list.txt

  while IFS= read -r mkv <&3; do
    mp4="${mkv%.mkv}.mp4"
    if [ -f "$mp4" ]; then
      rm "$mkv"
      echo "$DIRNAME|$(basename "$mkv")" >> "$REPORT_DIR/dupes.txt"
      echo "  Duplicaat verwijderd: $(basename "$mkv")" >> "$LOGFILE"
    fi
  done 3< /tmp/mkv_all_list.txt

  # Count empty MKVs
  EMPTY_COUNT=$(wc -l < /tmp/mkv_empty_list.txt | tr -d ' ')
  CURRENT=$(cat "$REPORT_DIR/skipped_empty.txt")
  echo "$((CURRENT + EMPTY_COUNT))" > "$REPORT_DIR/skipped_empty.txt"

  # Step 2: Build list of non-empty MKVs to convert
  FILELIST="/tmp/daily_mkv_filelist.txt"
  find "$DIR" -name '*.mkv' ! -empty -print | sort > "$FILELIST"
  COUNT=$(wc -l < "$FILELIST" | tr -d ' ')

  if [ "$COUNT" -eq 0 ]; then
    echo "  Geen MKV's te converteren in $DIR" >> "$LOGFILE"
    continue
  fi

  echo "  $COUNT MKV's gevonden in $DIR" >> "$LOGFILE"

  # Step 3: Convert
  while IFS= read -r mkv <&3; do
    dir=$(dirname "$mkv")
    base=$(basename "$mkv" .mkv)
    mp4="${dir}/${base}.mp4"
    filesize=$(du -h "$mkv" | awk '{print $1}')

    echo "  Bezig met: $(basename "$mkv")" >> "$LOGFILE"

    START_TIME=$(date +%s)
    HandBrakeCLI \
      --preset-import-file "$PRESET_FILE" \
      --preset "Niel" \
      -i "$mkv" \
      -o "$mp4" \
      </dev/null \
      2>/dev/null
    RESULT=$?
    END_TIME=$(date +%s)
    DURATION=$(( (END_TIME - START_TIME) / 60 ))

    if [ $RESULT -eq 0 ] && [ -f "$mp4" ]; then
      newsize=$(du -h "$mp4" | awk '{print $1}')
      rm "$mkv"
      echo "${DIRNAME}|${base}|${filesize}|${newsize}|${DURATION}" >> "$REPORT_DIR/converted.txt"
      echo "    OK" >> "$LOGFILE"
    else
      echo "${DIRNAME}|$(basename "$mkv")|${filesize}" >> "$REPORT_DIR/failed.txt"
      echo "    FOUT" >> "$LOGFILE"
    fi
  done 3< "$FILELIST"
done

SUCCESS=$(wc -l < "$REPORT_DIR/converted.txt" | tr -d ' ')
FAILED=$(wc -l < "$REPORT_DIR/failed.txt" | tr -d ' ')
DUPES=$(wc -l < "$REPORT_DIR/dupes.txt" | tr -d ' ')

echo "=== Klaar: $(date) | Geconverteerd: $SUCCESS | Mislukt: $FAILED | Dupes verwijderd: $DUPES ===" >> "$LOGFILE"

# Generate and send HTML email report with TMDB info (only if something happened)
if [ "$SUCCESS" -gt 0 ] || [ "$FAILED" -gt 0 ] || [ "$DUPES" -gt 0 ]; then
  MSMTP_BIN=$(command -v msmtp)
  PYTHON_BIN=$(command -v python3)
  RECIPIENTS=$($PYTHON_BIN -c "import json; print(' '.join(r['email'] for r in json.load(open('$CONFIG_FILE'))['recipients'] if r.get('active', True)))")
  if [ -n "$RECIPIENTS" ]; then
    $PYTHON_BIN "$APP_DIR/scripts/generate_report.py" "$REPORT_DIR" "$CONFIG_FILE" | $MSMTP_BIN $RECIPIENTS
  fi
else
  echo "  Niets te rapporteren, geen mail verstuurd." >> "$LOGFILE"
fi
