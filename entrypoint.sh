#!/bin/bash

# Copy default preset to config volume if it doesn't exist
if [ ! -f /app/config/Niel.json ] && [ -f /app/scripts/Niel.json ]; then
  cp /app/scripts/Niel.json /app/config/Niel.json
  echo "[init] Copied default preset to /app/config/Niel.json"
fi

# Mount Synology NAS via CIFS if credentials are provided
if [ -n "$NAS_IP" ] && [ -n "$NAS_USER" ] && [ -n "$NAS_PASS" ]; then
  NAS_MOVIES_SHARE="${NAS_MOVIES_SHARE:-/Media/Movies}"
  NAS_SERIES_SHARE="${NAS_SERIES_SHARE:-/Media/Series}"

  echo "[mount] Mounting //${NAS_IP}${NAS_MOVIES_SHARE} → /media/movies"
  mount -t cifs "//${NAS_IP}${NAS_MOVIES_SHARE}" /media/movies \
    -o "username=${NAS_USER},password=${NAS_PASS},uid=1000,gid=1000,vers=3.0" 2>&1 || \
    echo "[mount] WARNING: Failed to mount movies"

  echo "[mount] Mounting //${NAS_IP}${NAS_SERIES_SHARE} → /media/series"
  mount -t cifs "//${NAS_IP}${NAS_SERIES_SHARE}" /media/series \
    -o "username=${NAS_USER},password=${NAS_PASS},uid=1000,gid=1000,vers=3.0" 2>&1 || \
    echo "[mount] WARNING: Failed to mount series"
fi

exec "$@"
