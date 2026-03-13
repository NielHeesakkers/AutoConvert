// --- Library Overview ---
let libPollTimer = null;

async function loadLibrary() {
  try {
    const res = await fetch('/api/library/stats');
    const data = await res.json();
    if (data.scanning) {
      pollLibraryScan();
      return;
    }
    if (!data.totalFiles && data.totalFiles !== 0) return;
    renderLibrary(data);
  } catch {}
}

function renderLibrary(data) {
  // Summary cards
  document.getElementById('libSummary').style.display = 'block';
  document.getElementById('libTotalFiles').textContent = data.totalFiles.toLocaleString();
  document.getElementById('libTotalSize').textContent = fmtBytes(data.totalSizeBytes);
  document.getElementById('libMp4Count').textContent = (data.byFormat.mp4 || 0).toLocaleString();
  document.getElementById('libMkvCount').textContent = (data.byFormat.mkv || 0).toLocaleString();

  // Scan info
  if (data.scannedAt) {
    const ago = timeSince(new Date(data.scannedAt));
    document.getElementById('libScanInfo').textContent = `Last scan: ${ago}`;
  }

  // Directory bars
  const dirs = data.byDirectory || [];
  if (dirs.length > 0) {
    document.getElementById('libDirChart').style.display = 'block';
    const maxSize = Math.max(...dirs.map(d => d.sizeBytes), 1);
    document.getElementById('libDirBars').innerHTML = dirs.map(d => {
      const pct = (d.sizeBytes / maxSize * 100).toFixed(1);
      return `<div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
          <span style="color:#ccc;">${escHtml(d.name)}</span>
          <span style="color:#888;">${d.files} files · ${fmtBytes(d.sizeBytes)}</span>
        </div>
        <div style="height:8px;background:rgba(99,102,241,0.1);border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:#6366f1;border-radius:4px;transition:width .5s;"></div>
        </div>
      </div>`;
    }).join('');
  }

  // Donut charts
  const charts = document.getElementById('libCharts');
  charts.style.display = 'grid';

  renderDonut('libChartFormat', data.byFormat, {
    mp4: '#4ade80', mkv: '#f59e0b', avi: '#ef4444', mov: '#818cf8', m4v: '#c084fc', webm: '#22d3ee'
  });
  renderDonut('libChartCodec', data.byCodec, {
    hevc: '#4ade80', h264: '#4a9eff', av1: '#c084fc', vp9: '#f59e0b', other: '#555'
  });
  renderDonut('libChartResolution', data.byResolution, {
    '4K': '#c084fc', '1080p': '#4a9eff', '720p': '#4ade80', '480p': '#f59e0b', other: '#555'
  });

  // Conversion history
  const history = data.conversionHistory || [];
  if (history.length > 0) {
    document.getElementById('libHistory').style.display = 'block';
    renderHistoryChart('libHistoryChart', history);
  }
}

function renderDonut(containerId, dataObj, colors) {
  const container = document.getElementById(containerId);
  const entries = Object.entries(dataObj || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    container.innerHTML = '<div style="color:#555;font-size:13px;padding:20px;">No data</div>';
    return;
  }
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const size = 120;
  const cx = size / 2, cy = size / 2, r = 44, strokeWidth = 16;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const segments = entries.map(([key, val]) => {
    const pct = val / total;
    const dashLen = circumference * pct;
    const color = colors[key] || '#555';
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-dasharray="${dashLen} ${circumference - dashLen}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
    offset += dashLen;
    return seg;
  });

  const legend = entries.map(([key, val]) => {
    const pct = (val / total * 100).toFixed(0);
    const color = colors[key] || '#555';
    return `<div style="display:flex;align-items:center;gap:6px;font-size:12px;">
      <span style="width:8px;height:8px;border-radius:2px;background:${color};flex-shrink:0;"></span>
      <span style="color:#ccc;">${escHtml(key)}</span>
      <span style="color:#555;margin-left:auto;">${val} (${pct}%)</span>
    </div>`;
  }).join('');

  container.innerHTML = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="margin:8px auto;display:block;">
      ${segments.join('')}
      <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" fill="#e0e0e0" font-size="16" font-weight="700">${total}</text>
    </svg>
    <div style="display:flex;flex-direction:column;gap:4px;padding:0 8px;">${legend}</div>
  `;
}

function renderHistoryChart(containerId, history) {
  const container = document.getElementById(containerId);
  if (!history.length) { container.innerHTML = ''; return; }

  const maxVal = Math.max(...history.map(h => h.converted + h.failed), 1);
  const barWidth = Math.max(8, Math.floor((container.clientWidth || 500) / history.length) - 4);

  container.innerHTML = `<div style="display:flex;align-items:flex-end;gap:3px;height:100%;padding-top:8px;">
    ${history.map(h => {
      const convH = (h.converted / maxVal * 90).toFixed(0);
      const failH = (h.failed / maxVal * 90).toFixed(0);
      const dateLabel = h.date.slice(5); // MM-DD
      return `<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0;" title="${h.date}: ${h.converted} converted, ${h.failed} failed">
        <div style="display:flex;flex-direction:column;gap:1px;width:${barWidth}px;align-items:center;">
          ${h.failed > 0 ? `<div style="width:100%;height:${failH}px;background:#ef4444;border-radius:2px 2px 0 0;"></div>` : ''}
          <div style="width:100%;height:${convH}px;background:#6366f1;border-radius:${h.failed > 0 ? '0 0 2px 2px' : '2px'};min-height:2px;"></div>
        </div>
        <div style="font-size:9px;color:#555;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;text-align:center;">${dateLabel}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function timeSince(date) {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

async function startLibraryScan() {
  document.getElementById('btnLibScan').disabled = true;
  document.getElementById('btnLibScan').textContent = 'Scanning...';
  document.getElementById('btnLibCancel').style.display = 'inline-block';
  document.getElementById('libProgress').style.display = 'block';
  try {
    await fetch('/api/library/scan', { method: 'POST' });
    pollLibraryScan();
  } catch {
    toast('Failed to start scan', true);
    document.getElementById('btnLibScan').disabled = false;
    document.getElementById('btnLibScan').textContent = 'Scan Library';
  }
}

function pollLibraryScan() {
  if (libPollTimer) clearInterval(libPollTimer);
  document.getElementById('libProgress').style.display = 'block';
  document.getElementById('btnLibScan').disabled = true;
  document.getElementById('btnLibScan').textContent = 'Scanning...';
  document.getElementById('btnLibCancel').style.display = 'inline-block';

  libPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/library/scan/status');
      const d = await res.json();
      if (d.scanning) {
        const pct = d.total > 0 ? (d.current / d.total * 100) : 0;
        document.getElementById('libProgressBar').style.width = pct.toFixed(1) + '%';
        document.getElementById('libProgressLabel').textContent = `${d.current} / ${d.total} files`;
      } else {
        clearInterval(libPollTimer);
        libPollTimer = null;
        document.getElementById('libProgress').style.display = 'none';
        document.getElementById('btnLibScan').disabled = false;
        document.getElementById('btnLibScan').textContent = 'Scan Library';
        document.getElementById('btnLibCancel').style.display = 'none';
        loadLibrary();
      }
    } catch {}
  }, 1000);
}

async function cancelLibraryScan() {
  try {
    await fetch('/api/library/scan/cancel', { method: 'POST' });
    toast('Scan cancelled');
  } catch {}
}
