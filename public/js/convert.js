// --- Excluded Files & Queue Order ---
const excludedFiles = new Set();
let queueOrder = []; // array of file paths in custom order

function excludeFile(path) {
  excludedFiles.add(path);
  queueOrder = queueOrder.filter(p => p !== path);
  loadConvQueue();
}

function resetExcluded() {
  excludedFiles.clear();
  queueOrder = [];
  loadConvQueue();
}

let _dragIdx = -1;

function onQueueDragStart(e, idx) {
  _dragIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
  e.target.closest('.queue-item').style.opacity = '0.4';
}

function onQueueDragEnd(e) {
  _dragIdx = -1;
  e.target.closest('.queue-item').style.opacity = '';
  document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('drag-over'));
}

function onQueueDragOver(e, idx) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('drag-over'));
  if (idx !== _dragIdx) e.currentTarget.classList.add('drag-over');
}

function onQueueDrop(e, idx) {
  e.preventDefault();
  document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('drag-over'));
  if (_dragIdx < 0 || _dragIdx === idx) return;
  const item = queueOrder.splice(_dragIdx, 1)[0];
  queueOrder.splice(idx, 0, item);
  _dragIdx = -1;
  renderQueue();
}

let _lastQueueResults = [];

// --- Status ---
let isConvertRunning = false;
let progressTmdbData = null;
let progressTmdbLoading = false;
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const dots = [document.getElementById('statusDot'), document.getElementById('statusDotMain')];
    const text = document.getElementById('statusText');
    const sidebar = document.getElementById('statusTextSidebar');
    isConvertRunning = data.running;
    if (data.running) {
      dots.forEach(d => d.className = 'status-dot running');
      text.textContent = 'Converting...';
      sidebar.textContent = 'Active...';
      document.getElementById('btnStart').disabled = true;
      document.getElementById('btnStop').style.display = '';
      document.getElementById('convQueue').style.display = 'none';
      loadProgress();
    } else {
      dots.forEach(d => d.className = 'status-dot idle');
      text.textContent = 'Idle';
      sidebar.textContent = 'Idle';
      document.getElementById('btnStart').disabled = false;
      document.getElementById('btnStop').style.display = 'none';
      // Check if there's a "done" summary to show before going back to queue
      loadProgress().then(() => {
        const progEl = document.getElementById('convProgress');
        if (progEl.style.display === 'none') {
          // No done summary — show idle queue
          document.getElementById('convQueue').style.display = '';
          progressTmdbData = null;
          progressTmdbLoading = false;
          loadConvQueue();
        } else {
          // Done summary is showing — hide queue
          document.getElementById('convQueue').style.display = 'none';
        }
      });
    }
  } catch {}
}

async function loadConvQueue() {
  try {
    const res = await fetch('/api/directories');
    const data = await res.json();
    const dirs = data.directories || [];
    const el = document.getElementById('convQueue');

    const allFiles = [];
    dirs.forEach(d => {
      (d.files || []).forEach(f => allFiles.push({ name: f.name, path: f.path, size: f.size, section: d.name }));
    });

    if (allFiles.length === 0) {
      const scanning = data.scanning || dirs.some(d => d.scanning);
      el.innerHTML = scanning
        ? '<div class="panel" style="color:#888;">Scanning media directories...</div>'
        : '<div class="panel" style="color:#555;">No MKV files found in media directories.</div>';
      return;
    }

    // Show loading state
    const visibleCount = allFiles.filter(f => !excludedFiles.has(f.path)).length;
    el.innerHTML = `<div class="panel"><div style="font-size:14px;font-weight:600;color:#e0e0e0;margin-bottom:12px;">Ready for conversion <span style="font-weight:400;color:#888;">(${visibleCount} file${visibleCount!==1?'s':''})</span></div><div style="color:#555;padding:12px 0;">Loading media info...</div></div>`;

    // Fetch TMDB info
    let results = allFiles;
    try {
      const tmdbRes = await fetch('/api/tmdb/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: allFiles }),
      });
      const tmdbData = await tmdbRes.json();
      if (tmdbData.results) results = tmdbData.results;
    } catch {}

    _lastQueueResults = results;

    // Initialize queue order if needed (new files or first load)
    const visiblePaths = results.filter(f => !excludedFiles.has(f.path)).map(f => f.path);
    if (queueOrder.length === 0) {
      queueOrder = visiblePaths;
    } else {
      // Add any new files not yet in order, remove stale ones
      const newPaths = visiblePaths.filter(p => !queueOrder.includes(p));
      queueOrder = queueOrder.filter(p => visiblePaths.includes(p)).concat(newPaths);
    }

    renderQueue();
  } catch { document.getElementById('convQueue').innerHTML = ''; }
}

function renderQueue() {
  const results = _lastQueueResults;
  if (!results.length) return;
  const el = document.getElementById('convQueue');
  const resultMap = {};
  results.forEach(f => { resultMap[f.path] = f; });

  // Build ordered filtered list
  const filteredResults = queueOrder.filter(p => resultMap[p]).map(p => resultMap[p]);
  const excludedCount = excludedFiles.size;
  const displayCount = filteredResults.length;

  let html = '';
  if (excludedCount > 0) {
    html += `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;"><span style="font-size:13px;color:#888;background:#1e2130;padding:4px 12px;border-radius:10px;">${excludedCount} file${excludedCount!==1?'s':''} excluded</span><button class="btn btn-ghost btn-sm" onclick="resetExcluded()">Reset</button></div>`;
  }
  html += `<div class="panel"><div style="font-size:14px;font-weight:600;color:#e0e0e0;margin-bottom:16px;">Ready for conversion <span style="font-weight:400;color:#888;">(${displayCount} file${displayCount!==1?'s':''})</span></div>`;

  filteredResults.forEach((f, i) => {
    const filePath = f.path || '';
    html += `<div class="queue-item" draggable="true" ondragstart="onQueueDragStart(event,${i})" ondragend="onQueueDragEnd(event)" ondragover="onQueueDragOver(event,${i})" ondrop="onQueueDrop(event,${i})" style="position:relative;cursor:grab;">`;
    html += `<div class="queue-grip" style="position:absolute;top:50%;left:6px;transform:translateY(-50%);color:#444;font-size:11px;line-height:1;letter-spacing:2px;pointer-events:none;">⠿</div>`;
    html += `<div style="margin-left:4px;">${renderTmdbCard(f)}</div>`;
    html += `<button onclick="excludeFile('${escAttr(filePath)}')" title="Remove from queue" style="position:absolute;top:10px;right:10px;background:none;border:none;color:#555;font-size:18px;cursor:pointer;padding:2px 6px;border-radius:4px;line-height:1;" onmouseover="this.style.color='#ef4444';this.style.background='rgba(239,68,68,0.1)'" onmouseout="this.style.color='#555';this.style.background='none'">&times;</button>`;
    html += `</div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

async function startConvert() {
  try {
    const payload = {};
    if (excludedFiles.size > 0) payload.exclude = [...excludedFiles];
    if (queueOrder.length > 0) payload.order = queueOrder.filter(p => !excludedFiles.has(p));
    const res = await fetch('/api/convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.started) { toast('Conversion started'); excludedFiles.clear(); queueOrder = []; loadStatus(); }
    else toast(data.error || 'Error', true);
  } catch { toast('Failed to start', true); }
}

async function stopConvert() {
  if (!confirm('Are you sure you want to stop the conversion?')) return;
  try {
    const res = await fetch('/api/convert/stop', { method: 'POST' });
    const data = await res.json();
    if (data.stopped) { toast('Conversion stopped'); setTimeout(loadStatus, 1000); }
    else toast(data.error || 'Error', true);
  } catch { toast('Failed to stop', true); }
}

// --- Progress ---
async function loadProgress() {
  try {
    const res = await fetch('/api/convert/progress');
    const p = await res.json();
    if (p.status === 'idle') { document.getElementById('convProgress').style.display = 'none'; progressTmdbData = null; progressTmdbLoading = false; return; }

    // Show "done" summary after conversion finishes
    if (p.status === 'done') {
      document.getElementById('convProgress').style.display = '';
      document.getElementById('convQueue').style.display = 'none';
      const files = p.files || [];
      const completed = p.completed || [];
      const ok = completed.filter(c => c.status === 'ok').length;
      const failed = completed.filter(c => c.status !== 'ok').length;
      const total = p.total || files.length;

      document.getElementById('convBarTotal').style.width = '100%';
      if (total === 0) {
        document.getElementById('convBarTotal').style.background = '#888';
        document.getElementById('convLabelTotal').textContent = p.message || 'No MKV files found to convert';
      } else {
        document.getElementById('convBarTotal').style.background = failed > 0 && ok === 0 ? '#ef4444' : '#4ade80';
        document.getElementById('convLabelTotal').textContent = `Done — ${ok} converted, ${failed} failed`;
      }

      // Render cards immediately (without TMDB), then enrich with TMDB in background
      function renderDoneCards() {
        const completedMap = {};
        completed.forEach(c => { completedMap[c.index] = c; });
        let html = '';
        files.forEach((f, i) => {
          const tmdbFile = (progressTmdbData && progressTmdbData[i]) || f;
          const fileData = { ...tmdbFile, size: f.size, section: f.section, name: f.name };
          if (!fileData.tmdb && tmdbFile.tmdb) fileData.tmdb = tmdbFile.tmdb;
          const c = completedMap[i];
          if (c) {
            const isOk = c.status === 'ok';
            const statusIcon = isOk ? '<span class="tmdb-status-icon" style="color:#4ade80;">&#10003;</span>' : '<span class="tmdb-status-icon" style="color:#ef4444;">&#10007;</span>';
            const sizeCompare = isOk ? `${statusIcon} ${escHtml(f.size || '')} → ${escHtml(c.new_size || '')}` : `${statusIcon} Failed`;
            html += renderTmdbCard(fileData, { cls: isOk ? 'done' : 'failed', sizeCompare, failed: !isOk });
          } else {
            html += renderTmdbCard(fileData, { cls: 'pending' });
          }
        });
        document.getElementById('convFileList').innerHTML = html;
      }

      renderDoneCards();

      // Fetch TMDB in background, re-render when ready
      if (!progressTmdbData && !progressTmdbLoading && files.length > 0) {
        progressTmdbLoading = true;
        fetch('/api/tmdb/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: files.map(f => ({ name: f.name, size: f.size, section: f.section })) }),
        }).then(r => r.json()).then(tmdbData => {
          if (tmdbData.results) { progressTmdbData = tmdbData.results; renderDoneCards(); }
        }).catch(() => {}).finally(() => { progressTmdbLoading = false; });
      }

      // Clear done state after timeout, go back to idle queue
      const doneTimeout = total === 0 ? 10000 : 30000;
      if (!loadProgress._doneTimer) {
        loadProgress._doneTimer = setTimeout(async () => {
          loadProgress._doneTimer = null;
          progressTmdbData = null; progressTmdbLoading = false;
          document.getElementById('convBarTotal').style.background = '';
          try { await fetch('/api/convert/progress/clear', { method: 'POST' }); } catch {}
          loadStatus();
        }, doneTimeout);
      }
      return;
    }

    // Clear done timer if we're running again
    if (loadProgress._doneTimer) { clearTimeout(loadProgress._doneTimer); loadProgress._doneTimer = null; }

    document.getElementById('convProgress').style.display = '';
    const files = p.files || [];
    const completed = p.completed || [];
    const total = p.total || files.length;
    const current = p.current || 0;
    const hbPct = p.hb_progress || 0;
    const hbEta = p.hb_eta || '';

    // Show scanning state when script is starting up (no files yet)
    if (files.length === 0) {
      document.getElementById('convBarTotal').style.width = '0%';
      document.getElementById('convLabelTotal').textContent = 'Scanning media directories...';
      document.getElementById('convFileList').innerHTML = '<div style="color:#888;padding:12px;font-size:13px;">Looking for MKV files to convert...</div>';
      return;
    }

    // Overall bar
    const pctTotal = total > 0 ? Math.round((completed.length / total) * 100) : 0;
    document.getElementById('convBarTotal').style.width = pctTotal + '%';
    document.getElementById('convLabelTotal').textContent = `File ${Math.min(current + 1, total)} of ${total}`;

    // Fetch TMDB data once per conversion run (non-blocking)
    if (!progressTmdbData && !progressTmdbLoading && files.length > 0) {
      progressTmdbLoading = true;
      fetch('/api/tmdb/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: files.map(f => ({ name: f.name, size: f.size, section: f.section })) }),
      }).then(r => r.json()).then(tmdbData => {
        if (tmdbData.results) progressTmdbData = tmdbData.results;
      }).catch(() => {}).finally(() => { progressTmdbLoading = false; });
    }

    // Build completed index for quick lookup
    const completedMap = {};
    completed.forEach(c => { completedMap[c.index] = c; });

    // Render TMDB cards for all files
    let html = '';
    files.forEach((f, i) => {
      const tmdbFile = (progressTmdbData && progressTmdbData[i]) || f;
      const fileData = { ...tmdbFile, size: f.size, section: f.section, name: f.name };
      if (!fileData.tmdb && tmdbFile.tmdb) fileData.tmdb = tmdbFile.tmdb;

      if (completedMap[i]) {
        // Completed file
        const c = completedMap[i];
        const ok = c.status === 'ok';
        const statusIcon = ok ? '<span class="tmdb-status-icon" style="color:#4ade80;">&#10003;</span>' : '<span class="tmdb-status-icon" style="color:#ef4444;">&#10007;</span>';
        const origSize = f.size || '';
        const newSize = c.new_size || '';
        const sizeCompare = ok ? `${statusIcon} ${escHtml(origSize)} → ${escHtml(newSize)}` : `${statusIcon} Failed`;
        html += renderTmdbCard(fileData, { cls: ok ? 'done' : 'failed', sizeCompare, failed: !ok });
      } else if (i === current) {
        // Currently converting
        html += renderTmdbCard(fileData, { cls: 'active', progress: hbPct, eta: hbEta });
      } else {
        // Pending
        html += renderTmdbCard(fileData, { cls: 'pending' });
      }
    });
    document.getElementById('convFileList').innerHTML = html;
  } catch {}
}
