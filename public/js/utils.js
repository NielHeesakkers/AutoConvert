// --- Theme ---
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = theme === 'light' ? '&#127769; Dark mode' : '&#9728;&#65039; Light mode';
}
function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  const next = current === 'light' ? 'dark' : 'light';
  applyTheme(next);
  localStorage.setItem('autoconvert_theme', next);
}
(function initTheme() {
  const saved = localStorage.getItem('autoconvert_theme');
  if (saved) { applyTheme(saved); }
  else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) { applyTheme('light'); }
  else { applyTheme('dark'); }
})();

// --- Navigation ---
const TITLES = { convert:'Conversion', reports:'Reports', recipients:'Recipients', library:'Library', settings:'Settings', changelog:'Version History' };

function navigateTo(section) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
  const sec = document.getElementById('sec-' + section);
  const nav = document.querySelector(`.sidebar-nav a[data-section="${section}"]`);
  if (sec) sec.classList.add('active');
  if (nav) nav.classList.add('active');
  document.getElementById('pageTitle').textContent = TITLES[section] || section;
  localStorage.setItem('autoconvert_section', section);
  if (section === 'reports') loadDiskSpace();
  if (section === 'library') loadLibrary();
  closeSidebar();
}
document.getElementById('sidebarNav').addEventListener('click', e => {
  const a = e.target.closest('a[data-section]'); if (a) navigateTo(a.dataset.section);
});
const saved = localStorage.getItem('autoconvert_section');
if (saved && document.getElementById('sec-' + saved)) navigateTo(saved);

// Settings tabs
document.getElementById('settingsTabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab'); if (!tab) return;
  document.querySelectorAll('#settingsTabs .tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('#sec-settings .tab-content').forEach(c => c.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById(tab.dataset.tab).classList.add('active');
  if (tab.dataset.tab === 'tab-logs') loadLog();
});

function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); document.getElementById('sidebarOverlay').classList.toggle('show'); }
function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebarOverlay').classList.remove('show'); }

// --- Helpers ---
function toast(msg, error=false, duration=3500) { const el=document.getElementById('toast'); el.textContent=msg; el.className='toast show'+(error?' error':''); clearTimeout(el._tid); el._tid=setTimeout(()=>el.className='toast',duration); }
function escHtml(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtBytes(b) { if(!b||b<=0)return '0 B'; const u=['B','KB','MB','GB','TB']; let i=0,s=b; while(s>=1024&&i<u.length-1){s/=1024;i++;} return s.toFixed(i===0?0:1)+' '+u[i]; }

// --- Shared TMDB card renderer ---
function renderTmdbCard(f, options = {}) {
  const t = f.tmdb || {};
  const poster = t.poster
    ? `<img src="${escAttr(t.poster)}" style="width:50px;border-radius:6px;display:block;" alt="" loading="lazy">`
    : '<div style="width:50px;height:75px;background:#1e2130;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#444;">No img</div>';
  const title = t.title || (f.name || '').replace(/\.mkv$/i, '');
  const year = t.year ? ` (${escHtml(t.year)})` : '';
  const epLabel = t.ep_label ? `<span class="tmdb-ep">${escHtml(t.ep_label)}</span>` : '';
  const epName = t.ep_name ? ` — ${escHtml(t.ep_name)}` : '';
  const rating = t.rating > 0 ? `<span class="tmdb-rating" style="color:${t.rating>=7?'#f5c518':t.rating>=5?'#ff9800':'#e53935'}">★ ${t.rating.toFixed(1)}</span>` : '';
  const sectionBadge = f.section ? `<span class="tmdb-badge" style="background:${f.section==='movies'?'#1a2332':'#2a1a32'};color:${f.section==='movies'?'#4a9eff':'#c084fc'}">${escHtml(f.section)}</span>` : '';
  const overview = t.overview ? `<div class="tmdb-overview">${escHtml(t.overview)}...</div>` : '';
  const cls = options.cls || '';
  let meta = '';
  if (options.sizeCompare) {
    const cmpCls = options.failed ? ' failed' : '';
    meta = `<div class="tmdb-size-compare${cmpCls}">${options.sizeCompare}</div>`;
  } else {
    const sizeStr = typeof f.size === 'number' ? (f.size > 0 ? fmtBytes(f.size) : '') : (f.size || '');
    meta = sizeStr ? `<div class="tmdb-meta">${escHtml(sizeStr)}</div>` : '';
  }
  let progressHtml = '';
  if (options.progress != null) {
    const eta = options.eta ? ` — ETA ${escHtml(options.eta)}` : '';
    progressHtml = `<div class="tmdb-progress"><div class="tmdb-progress-fill" style="width:${options.progress}%"></div></div><div class="tmdb-progress-label">${options.progress.toFixed(1)}%${eta}</div>`;
  }
  return `<div class="tmdb-card ${cls}">
    <div class="tmdb-poster">${poster}</div>
    <div class="tmdb-info">
      <div class="tmdb-badges">${sectionBadge}${epLabel}${rating}</div>
      <div class="tmdb-title">${escHtml(title)}${year}${epName}</div>
      ${overview}
      ${meta}
      ${progressHtml}
    </div>
  </div>`;
}

// --- Disk Space ---
async function loadDiskSpace() {
  try {
    const res = await fetch('/api/disk-space');
    const data = await res.json();
    const el = document.getElementById('diskSpaceWarning');
    const dirs = data.directories || [];
    if (dirs.length === 0) { el.style.display = 'none'; return; }

    // Deduplicate by mount point (dirs on same volume show same free space)
    const seen = new Map();
    dirs.forEach(d => {
      const key = d.freeGB + '|' + d.totalGB;
      if (!seen.has(key)) seen.set(key, d);
    });
    const unique = [...seen.values()];

    const isLow = data.minFreeGB != null && data.minFreeGB < 10;
    const isRed = data.minFreeGB != null && data.minFreeGB < 2;

    let bgColor, borderColor, textColor, icon;
    if (isRed) {
      bgColor = 'rgba(239,68,68,0.12)'; borderColor = 'rgba(239,68,68,0.35)'; textColor = '#ef4444'; icon = '\u26A0\uFE0F';
    } else if (isLow) {
      bgColor = 'rgba(245,158,11,0.12)'; borderColor = 'rgba(245,158,11,0.35)'; textColor = '#f59e0b'; icon = '\u26A0\uFE0F';
    } else {
      bgColor = 'rgba(74,158,255,0.06)'; borderColor = 'rgba(74,158,255,0.15)'; textColor = '#888'; icon = '\uD83D\uDCBE';
    }

    const parts = unique.map(d => {
      const freeNum = parseFloat(d.freeGB);
      const totalNum = parseFloat(d.totalGB);
      const freeLabel = freeNum >= 1024 ? (freeNum / 1024).toFixed(1) + ' TB' : freeNum.toFixed(1) + ' GB';
      const totalLabel = totalNum >= 1024 ? (totalNum / 1024).toFixed(1) + ' TB' : totalNum.toFixed(0) + ' GB';
      return freeLabel + ' free of ' + totalLabel;
    });

    el.className = 'panel';
    el.style.display = 'block';
    el.style.background = bgColor;
    el.style.border = '1px solid ' + borderColor;
    el.style.color = textColor;
    el.style.marginBottom = '16px';
    el.style.fontSize = '13px';
    el.innerHTML = icon + ' ' + parts.join(' &bull; ');
  } catch { document.getElementById('diskSpaceWarning').style.display = 'none'; }
}
