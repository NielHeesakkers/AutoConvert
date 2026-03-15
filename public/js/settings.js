// --- Directories ---
async function loadDirectories() {
  try {
    const res = await fetch('/api/directories');
    const data = await res.json();
    const dirs = data.directories || [];
    const container = document.getElementById('dirContainer');
    if (!dirs.length) { container.innerHTML = '<div class="panel" style="color:#555;">No directories configured. Add one below.</div>'; return; }
    container.innerHTML = dirs.map(d => {
      const statusColor = !d.exists ? '#ef4444' : d.fileCount > 0 ? '#4ade80' : '#555';
      const countLabel = d.scanning ? 'Scanning...' : `${d.fileCount} MKV`;
      const removeBtn = `<button class="btn-icon delete" onclick="removeMediaDir('${escAttr(d.path)}')" title="Remove" style="margin-left:auto;font-size:16px;color:#555;background:none;border:none;cursor:pointer;padding:2px 6px;">&times;</button>`;
      return `<div class="dir-header" style="display:flex;align-items:center;"><span class="dir-dot ${d.exists?'exists':'missing'}"></span><span class="dir-name">${escHtml(d.name)}</span><span class="dir-path">${escHtml(d.path)}</span><span class="dir-count" style="color:${statusColor}">${countLabel}</span>${removeBtn}</div>`;
    }).join('');
  } catch { document.getElementById('dirContainer').innerHTML = '<div class="panel" style="color:#555;">Could not load directories.</div>'; }
}

async function addMediaDir() {
  const input = document.getElementById('newMediaDir');
  const dir = input.value.trim();
  if (!dir) { toast('Enter a directory path', true); return; }
  if (!dir.startsWith('/')) { toast('Path must be absolute (start with /)', true); return; }
  try {
    const res = await fetch('/api/media-dirs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) });
    const d = await res.json();
    if (d.ok) { toast('Directory added'); input.value = ''; loadDirectories(); }
    else toast(d.error || 'Error', true);
  } catch { toast('Failed to add directory', true); }
}

async function removeMediaDir(dir) {
  if (!confirm(`Remove "${dir}" from scan list?`)) return;
  try {
    const res = await fetch('/api/media-dirs', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) });
    const d = await res.json();
    if (d.ok) { toast('Directory removed'); loadDirectories(); }
    else toast(d.error || 'Error', true);
  } catch { toast('Failed to remove directory', true); }
}

// --- Schedule ---
function initScheduleSelects() {
  const h=document.getElementById('schedHour'), m=document.getElementById('schedMin');
  for(let i=0;i<24;i++) h.innerHTML+=`<option value="${i}">${String(i).padStart(2,'0')}</option>`;
  for(let i=0;i<60;i+=5) m.innerHTML+=`<option value="${i}">${String(i).padStart(2,'0')}</option>`;
}
async function loadSchedule() {
  try {
    const res=await fetch('/api/schedule'); const d=await res.json();
    document.getElementById('schedHour').value=d.hour;
    const s=Math.round(d.minute/5)*5;
    document.getElementById('schedMin').value=s>=60?55:s;
    document.getElementById('schedScanInterval').value=d.scanInterval||0;
    // Email schedule
    initEmailTimeSelects();
    if(d.emailHour!==''&&d.emailHour!==undefined&&d.emailHour!==null){
      document.getElementById('schedEmailMode').value='scheduled';
      document.getElementById('emailTimeWrap').style.display='inline';
      document.getElementById('schedEmailHour').value=d.emailHour;
      document.getElementById('schedEmailMin').value=Math.round((d.emailMinute||0)/5)*5;
    } else {
      document.getElementById('schedEmailMode').value='immediate';
      document.getElementById('emailTimeWrap').style.display='none';
    }
  } catch {}
}
function initEmailTimeSelects() {
  const eh=document.getElementById('schedEmailHour'), em=document.getElementById('schedEmailMin');
  if(eh.options.length>0) return;
  for(let i=0;i<24;i++){const o=document.createElement('option');o.value=i;o.textContent=String(i).padStart(2,'0');eh.appendChild(o);}
  for(let i=0;i<60;i+=5){const o=document.createElement('option');o.value=i;o.textContent=String(i).padStart(2,'0');em.appendChild(o);}
}
function toggleEmailTime(mode) {
  document.getElementById('emailTimeWrap').style.display=mode==='scheduled'?'inline':'none';
}
async function saveSchedule() {
  const hour=parseInt(document.getElementById('schedHour').value), minute=parseInt(document.getElementById('schedMin').value);
  const scanInterval=parseInt(document.getElementById('schedScanInterval').value)||0;
  const emailMode=document.getElementById('schedEmailMode').value;
  let emailHour='', emailMinute=0;
  if(emailMode==='scheduled'){
    emailHour=parseInt(document.getElementById('schedEmailHour').value);
    emailMinute=parseInt(document.getElementById('schedEmailMin').value)||0;
  }
  try { const res=await fetch('/api/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hour,minute,scanInterval,emailHour,emailMinute})}); const d=await res.json(); if(d.ok) toast('Schedule saved'); else toast(d.error||'Error',true); } catch { toast('Failed to save',true); }
}

// --- Scan ---
async function scanDirectories() {
  const btn=document.getElementById('btnScan');
  btn.disabled=true; btn.textContent='Scanning…';
  try { await fetch('/api/scan',{method:'POST'}); } catch {}
  setTimeout(()=>{btn.disabled=false;btn.textContent='Scan directories';loadConvQueue();},2000);
}

// --- App Settings ---
async function loadAppSettings() {
  try {
    const res=await fetch('/api/app-settings'); const d=await res.json();
    document.getElementById('appPort').value=d.port;
    document.getElementById('appBackupDir').value=d.backupDir||'';
    document.getElementById('appServerUrl').value=d.serverUrl||'';
    document.getElementById('appAdminEmail').value=d.adminEmail||'';
    document.getElementById('downloadNotifyToggle').checked=d.downloadNotify!==false;
    const ad=d.autoDelete!==false;
    document.getElementById('appAutoDelete').checked=ad;
    document.getElementById('autoDeleteWarning').style.display=ad?'block':'none';
  } catch {}
}
async function toggleAutoDelete(on) {
  document.getElementById('autoDeleteWarning').style.display=on?'block':'none';
  try {
    const res=await fetch('/api/app-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoDelete:on})});
    const d=await res.json();
    if(d.ok) toast(on?'Auto-delete enabled':'Auto-delete disabled');
    else toast(d.error||'Error',true);
  } catch { toast('Failed to save',true); }
}
async function saveServerUrl() {
  const serverUrl=document.getElementById('appServerUrl').value.trim();
  try { const res=await fetch('/api/app-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverUrl})}); const d=await res.json(); if(d.ok) toast('Server URL saved'); else toast(d.error||'Error',true); } catch { toast('Failed to save',true); }
}
async function saveAdminEmail() {
  const adminEmail=document.getElementById('appAdminEmail').value.trim();
  try { const res=await fetch('/api/app-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({adminEmail})}); const d=await res.json(); if(d.ok) toast('Admin email saved'); else toast(d.error||'Error',true); } catch { toast('Failed to save',true); }
}
async function saveDownloadNotify() {
  const downloadNotify=document.getElementById('downloadNotifyToggle').checked;
  try { const res=await fetch('/api/app-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({downloadNotify})}); const d=await res.json(); if(d.ok) toast(downloadNotify?'Download notifications enabled':'Download notifications disabled'); else toast(d.error||'Error',true); } catch { toast('Failed to save',true); }
}
async function saveAppSettings() {
  const port=parseInt(document.getElementById('appPort').value,10);
  if(!port||port<1||port>65535){toast('Port must be between 1 and 65535',true);return;}
  const backupDir=document.getElementById('appBackupDir').value.trim();
  try { const res=await fetch('/api/app-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({port,backupDir})}); const d=await res.json(); if(d.ok){toast('Settings saved');if(d.restart)document.getElementById('appPortRestart').style.display='inline';loadBackups();}else toast(d.error||'Error',true); } catch { toast('Failed to save',true); }
}

async function browseBackupDir() {
  const cur=document.getElementById('appBackupDir').value.trim();
  try {
    const res=await fetch('/api/choose-directory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({default:cur})});
    const d=await res.json();
    if(d.ok&&d.path) {
      document.getElementById('appBackupDir').value=d.path;
      const sv=await fetch('/api/app-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({backupDir:d.path})});
      const r=await sv.json();
      if(r.ok){toast('Backup directory saved');loadBackups();}else toast(r.error||'Error',true);
    }
  } catch { toast('Could not open folder picker',true); }
}

// --- SMTP ---
async function loadSmtp() {
  try { const res=await fetch('/api/smtp'); const d=await res.json(); document.getElementById('smtpHost').value=d.host; document.getElementById('smtpPort').value=d.port; document.getElementById('smtpUser').value=d.user; document.getElementById('smtpPassword').value=d.password; document.getElementById('smtpFrom').value=d.from; document.getElementById('smtpTls').checked=d.tls; document.getElementById('smtpStarttls').checked=d.starttls; } catch {}
}
async function saveSmtp() {
  const smtp={host:document.getElementById('smtpHost').value.trim(),port:parseInt(document.getElementById('smtpPort').value,10),user:document.getElementById('smtpUser').value.trim(),password:document.getElementById('smtpPassword').value,from:document.getElementById('smtpFrom').value.trim(),tls:document.getElementById('smtpTls').checked,starttls:document.getElementById('smtpStarttls').checked};
  if(!smtp.host||!smtp.user||!smtp.from){toast('Enter host, username, and sender',true);return;}
  try { const res=await fetch('/api/smtp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(smtp)}); const d=await res.json(); if(d.ok) toast('Mail server saved'); else toast(d.error||'Error',true); } catch { toast('Failed to save',true); }
}
async function testSmtpConnection() {
  const el=document.getElementById('smtpTestResult');
  el.style.display='inline'; el.style.color='#888'; el.textContent='Testing...';
  try {
    const res=await fetch('/api/test-smtp',{method:'POST'});
    const d=await res.json();
    if(d.ok){el.style.color='#4ade80';el.textContent='Connection OK';}
    else{el.style.color='#ef4444';el.textContent=d.error||'Failed';}
  } catch {el.style.color='#ef4444';el.textContent='Failed';}
  setTimeout(()=>el.style.display='none',4000);
}
async function testSmtp() {
  const email=await openModal('Send test email to:','user@example.com');
  if(!email||!email.trim()) return;
  const el=document.getElementById('smtpTestResult');
  el.style.display='inline'; el.style.color='#888'; el.textContent='Sending...';
  try {
    const res=await fetch('/api/test-email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.trim()})});
    const d=await res.json();
    if(d.ok){el.style.color='#4ade80';el.textContent='Sent!';}
    else{el.style.color='#ef4444';el.textContent=d.error||'Failed';}
  } catch {el.style.color='#ef4444';el.textContent='Failed';}
  setTimeout(()=>el.style.display='none',4000);
}

// --- Recipients ---
let recipients = [];
async function loadRecipients() { try { const res=await fetch('/api/recipients'); const d=await res.json(); recipients=d.recipients; renderRecipients(); } catch {} }
function renderRecipients() {
  document.getElementById('emailList').innerHTML = recipients.map((r,i) =>
    `<li class="${r.active?'':'inactive'}"><label class="toggle"><input type="checkbox" ${r.active?'checked':''} onchange="toggleEmail('${r.email}')"><span class="slider"></span></label><span class="email-addr">${r.email}</span><div class="email-actions"><button class="btn-icon" onclick="testEmail('${r.email}')" title="Test email">&#9993;</button><button class="btn-icon delete" onclick="removeEmail(${i})" title="Delete">&times;</button></div></li>`
  ).join('');
}
async function saveRecipients() { try { const res=await fetch('/api/recipients',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recipients})}); const d=await res.json(); if(!d.ok) toast(d.error||'Error',true); } catch { toast('Failed to save',true); } }
async function addEmail() {
  const input=document.getElementById('newEmail'), email=input.value.trim();
  if(!email) return;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){toast('Invalid email address',true);return;}
  if(recipients.find(r=>r.email===email)){toast('Address already exists',true);return;}
  recipients.push({email,active:true}); renderRecipients(); input.value=''; await saveRecipients(); toast('Recipient added');
}
async function removeEmail(i) { const rm=recipients.splice(i,1)[0]; renderRecipients(); await saveRecipients(); toast(`${rm.email} removed`); }
async function toggleEmail(email) {
  try { const res=await fetch('/api/recipients/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})}); const d=await res.json();
    if(d.ok){const r=recipients.find(r=>r.email===email);if(r)r.active=d.active;renderRecipients();toast(`${email} ${d.active?'activated':'deactivated'}`);}else toast(d.error||'Error',true);
  } catch { toast('Toggle failed',true); }
}
async function testEmail(email) {
  toast(`Sending test email to ${email}...`);
  try { const res=await fetch('/api/test-email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})}); const d=await res.json(); if(d.ok) toast(`Sent to ${email}`); else toast(d.error||'Error',true); } catch { toast('Error',true); }
}
async function testAllActive() {
  const active=recipients.filter(r=>r.active); if(!active.length){toast('No active recipients',true);return;}
  document.getElementById('btnTestAll').disabled=true; let ok=0,fail=0;
  for(const r of active){try{const res=await fetch('/api/test-email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:r.email})});const d=await res.json();if(d.ok)ok++;else fail++;}catch{fail++;}}
  document.getElementById('btnTestAll').disabled=false;
  if(!fail) toast(`Sent to ${ok} recipient(s)`); else toast(`${ok} sent, ${fail} failed`,true);
}

// --- Presets ---
function fmtEncoder(e){const m={'vt_h265_10bit':'H.265 10-bit (VideoToolbox)','vt_h265':'H.265 (VideoToolbox)','vt_h264':'H.264 (VideoToolbox)','x265_10bit':'H.265 10-bit (x265)','x265':'H.265 (x265)','x264':'H.264 (x264)','ca_aac':'AAC (CoreAudio)','av_aac':'AAC','copy:aac':'AAC Passthru','ac3':'AC3','eac3':'E-AC3','copy':'Auto Passthru'};return m[e]||e;}
function fmtFormat(f){const m={'av_mp4':'MP4','av_mkv':'MKV','av_webm':'WebM'};return m[f]||f;}
async function loadPresets() {
  try {
    const res=await fetch('/api/presets'); const d=await res.json();
    const container=document.getElementById('presetList');
    if(!d.presets||!d.presets.length){container.innerHTML='<div style="color:#555;">No presets. Upload a HandBrake preset file.</div>';return;}
    container.innerHTML=d.presets.map(p=>{
      const dt=p.details||{};
      const qualLabel=dt.videoQualityType===2?`Quality: ${dt.videoQuality}`:`Bitrate: ${dt.videoBitrate} kbps`;
      const mod=p.modified?new Date(p.modified).toLocaleString('en-US',{timeZone:'Europe/Amsterdam'}):'';
      const rows=[['Format',fmtFormat(dt.format)],['Video',fmtEncoder(dt.videoEncoder)+(dt.videoPreset?` (${dt.videoPreset})`:'')],['Quality',qualLabel],['Resolution',dt.resolution||'Auto'],['Audio',fmtEncoder(dt.audioEncoder)+` ${dt.audioBitrate}kbps ${dt.audioMixdown}`],['Subtitles',dt.subtitles],['Chapters',dt.chapterMarkers?'Yes':'No'],['Multi-pass',dt.multiPass?'Yes':'No']];
      const grid=rows.map(([k,v])=>`<div class="preset-card-row"><span>${k}</span><span>${escHtml(v)}</span></div>`).join('');
      const actions=[];
      if(!p.active) actions.push(`<button class="btn btn-primary btn-sm" onclick="activatePreset('${escAttr(p.filename)}')">Set as active</button>`);
      if(!p.active) actions.push(`<button class="btn btn-ghost btn-sm" style="color:#ef4444;" onclick="deletePreset('${escAttr(p.filename)}')">Delete</button>`);
      actions.push(`<button class="btn btn-ghost btn-sm" onclick="downloadPreset('${escAttr(p.filename)}')">Download</button>`);
      return `<div class="preset-card${p.active?' active':''}"><div class="preset-card-header"><span class="preset-card-name">${escHtml(p.name)}</span>${p.active?'<span class="preset-card-badge">Active</span>':''}</div>${p.description?`<div style="font-size:12px;color:#888;margin-bottom:8px;">${escHtml(p.description)}</div>`:''}<div style="font-size:11px;color:#555;margin-bottom:10px;">${escHtml(p.filename)}${mod?' &middot; '+mod:''}</div>${grid}<div class="preset-card-actions">${actions.join('')}</div></div>`;
    }).join('');
  } catch { document.getElementById('presetList').innerHTML='<div style="color:#555;">Could not load presets.</div>'; }
}
async function uploadPreset(input) {
  const file=input.files[0]; if(!file) return;
  if(!file.name.endsWith('.json')){toast('Only JSON files',true);input.value='';return;}
  try {
    const text=await file.text(); JSON.parse(text);
    let res=await fetch('/api/presets',{method:'POST',headers:{'Content-Type':'application/json'},body:text});
    let d=await res.json();
    if(d.exists&&confirm(`Preset "${d.filename}" already exists. Overwrite?`)){
      res=await fetch('/api/presets?overwrite=true',{method:'POST',headers:{'Content-Type':'application/json'},body:text});
      d=await res.json();
    }
    if(d.ok){toast(`Preset "${d.name}" uploaded`);loadPresets();}
    else if(!d.exists) toast(d.error||'Error',true);
  } catch { toast('Invalid JSON',true); } input.value='';
}
async function activatePreset(filename) {
  try {
    const res=await fetch(`/api/presets/${encodeURIComponent(filename)}/activate`,{method:'POST'});
    const d=await res.json();
    if(d.ok){toast('Preset activated');loadPresets();}else toast(d.error||'Error',true);
  } catch { toast('Error',true); }
}
async function deletePreset(filename) {
  if(!confirm(`Delete preset "${filename}"?`)) return;
  try {
    const res=await fetch(`/api/presets/${encodeURIComponent(filename)}`,{method:'DELETE'});
    const d=await res.json();
    if(d.ok){toast('Preset deleted');loadPresets();}else toast(d.error||'Error',true);
  } catch { toast('Error',true); }
}
function downloadPreset(filename) { window.open(`/api/presets/${encodeURIComponent(filename)}/download`,'_blank'); }

// --- Backup ---
async function loadBackups() {
  try {
    const res=await fetch('/api/backups'); const d=await res.json(); const list=document.getElementById('backupList');
    if(!d.backups||!d.backups.length){list.innerHTML='<div style="color:#555;font-size:13px;">No backups available.</div>';return;}
    list.innerHTML=d.backups.map(b=>{
      const date=b.created?new Date(b.created).toLocaleString('en-US',{timeZone:'Europe/Amsterdam'}):'';
      return `<div class="backup-item"><span class="backup-name">${date||escHtml(b.filename)}</span><span class="backup-size">${fmtBytes(b.size)}</span><button class="btn btn-ghost btn-sm" onclick="revealBackup('${escAttr(b.filename)}')">Show in Finder</button><button class="btn btn-ghost btn-sm" onclick="restoreBackup('${escAttr(b.filename)}')">Restore</button><button class="btn-icon delete" onclick="deleteBackup('${escAttr(b.filename)}')" style="font-size:18px;">&times;</button></div>`;
    }).join('');
  } catch { document.getElementById('backupList').innerHTML='<div style="color:#555;font-size:13px;">Could not load backups.</div>'; }
}
async function createBackup() {
  try { const res=await fetch('/api/backups',{method:'POST'}); const d=await res.json(); if(d.ok){toast('Backup created');loadBackups();}else toast(d.error||'Error',true); } catch { toast('Backup failed',true); }
}
async function restoreBackup(filename) {
  if(!confirm('Are you sure you want to restore this backup? Current settings will be overwritten.')) return;
  try { const res=await fetch('/api/backups/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename})}); const d=await res.json();
    if(d.ok){toast('Backup restored');loadSmtp();loadSchedule();loadRecipients();loadPresets();}else toast(d.error||'Error',true);
  } catch { toast('Failed to restore',true); }
}
async function revealBackup(filename) {
  try { await fetch('/api/backups/reveal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename})}); } catch { toast('Could not open Finder',true); }
}
async function deleteBackup(filename) {
  if(!confirm('Delete backup?')) return;
  try { const res=await fetch(`/api/backups/${encodeURIComponent(filename)}`,{method:'DELETE'}); const d=await res.json(); if(d.ok){toast('Backup deleted');loadBackups();}else toast(d.error||'Error',true); } catch { toast('Error',true); }
}

// --- Export / Import ---
function exportSettings() { window.open('/api/export','_blank'); }
async function importSettings(input) {
  const file=input.files[0]; if(!file) return;
  try {
    const text=await file.text(); const data=JSON.parse(text);
    if(data.type!=='autoconvert-export'){toast('Invalid export file',true);input.value='';return;}
    if(!confirm('Import settings? Current config will be overwritten.')) {input.value='';return;}
    const res=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:text}); const d=await res.json();
    if(d.ok){toast('Settings imported');loadSmtp();loadSchedule();loadRecipients();loadPresets();}else toast(d.error||'Error',true);
  } catch { toast('Invalid file',true); } input.value='';
}

// --- Version ---
async function loadVersion() {
  try {
    const res=await fetch('/api/version'); const d=await res.json();
    document.getElementById('sidebarVersion').textContent='v'+d.version;
    const aboutVer=document.getElementById('aboutVersion'); if(aboutVer) aboutVer.textContent='v'+d.version;
    const container=document.getElementById('changelogContainer');
    if(!d.history||!d.history.length){container.innerHTML='<div style="color:#555;">No version history.</div>';return;}
    container.innerHTML=d.history.map(v=>`<div class="version-entry"><div class="version-header"><span class="version-tag">v${escHtml(v.version)}</span><span class="version-date">${escHtml(v.date)}</span></div><ul class="version-changes">${(v.changes||[]).map(c=>`<li>${escHtml(c)}</li>`).join('')}</ul></div>`).join('');
  } catch { document.getElementById('changelogContainer').innerHTML='<div style="color:#555;">Could not load version history.</div>'; }
}

// --- Logs ---
async function loadLog() {
  const el=document.getElementById('logContent');
  const meta=document.getElementById('logMeta');
  try {
    const res=await fetch('/api/log?lines=200'); const d=await res.json();
    if(!d.log||!d.log.trim()){el.innerHTML='<span style="color:#555;">Log is empty.</span>';meta.textContent='';return;}
    // Colorize log lines
    const lines=d.log.split('\n').map(line=>{
      if(line.startsWith('===')) return `<span style="color:#818cf8;font-weight:600;">${escHtml(line)}</span>`;
      if(/FAILED|error|Error/i.test(line)) return `<span style="color:#f87171;">${escHtml(line)}</span>`;
      if(/OK$|✓|converted|accepted/i.test(line)) return `<span style="color:#34d399;">${escHtml(line)}</span>`;
      if(/warning|⚠|skipped/i.test(line)) return `<span style="color:#fbbf24;">${escHtml(line)}</span>`;
      return escHtml(line);
    });
    el.innerHTML=lines.join('\n');
    el.scrollTop=el.scrollHeight;
    meta.textContent=`${d.totalLines} total lines`;
  } catch { el.innerHTML='<span style="color:#f87171;">Failed to load log.</span>'; meta.textContent=''; }
}
async function clearLog() {
  const ok=await showConfirm({title:'Clear Log',desc:'The conversion log and all reports will be permanently deleted.',icon:'🗑️',iconBg:'rgba(239,68,68,0.15)',btnText:'Clear all',btnColor:'#ef4444'});
  if(!ok) return;
  try { const res=await fetch('/api/logs',{method:'DELETE'}); const d=await res.json(); if(d.ok){toast('Log cleared');loadLog();loadReports();}else toast(d.error||'Error',true); } catch { toast('Error',true); }
}

async function clearCache() {
  const ok=await showConfirm({title:'Clear Cache',desc:'Library scan cache and TMDB metadata cache will be cleared. Next scan will rebuild from scratch.',icon:'🗑️',iconBg:'rgba(239,68,68,0.15)',btnText:'Clear',btnColor:'#ef4444'});
  if(!ok) return;
  try { const res=await fetch('/api/cache',{method:'DELETE'}); const d=await res.json(); if(d.ok){toast('Cache cleared');}else toast(d.error||'Error',true); } catch { toast('Error',true); }
}

// --- Orphan MKVs ---
async function scanOrphanMkvs() {
  const btn = document.getElementById('btnScanMkvs');
  btn.disabled = true; btn.textContent = 'Scanning...';
  try {
    const res = await fetch('/api/orphan-mkvs');
    const data = await res.json();
    const mkvs = data.mkvs || [];
    const container = document.getElementById('orphanMkvResults');
    const list = document.getElementById('orphanMkvList');
    const status = document.getElementById('orphanMkvStatus');
    const delBtn = document.getElementById('btnDeleteMkvs');
    container.style.display = 'block';

    if (mkvs.length === 0) {
      list.innerHTML = '<div style="color:#4ade80;font-size:13px;">No MKV files found in media directories.</div>';
      delBtn.style.display = 'none';
      status.textContent = '';
      return;
    }

    const withMp4 = mkvs.filter(m => m.hasMatchingMp4);
    const withoutMp4 = mkvs.filter(m => !m.hasMatchingMp4);

    let html = '';
    if (withMp4.length > 0) {
      html += `<div style="font-size:13px;color:#ccc;margin-bottom:8px;font-weight:600;">MKV files with matching MP4 (${withMp4.length})</div>`;
      for (const m of withMp4) {
        html += `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;color:#ccc;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04);">
          <input type="checkbox" class="orphan-mkv-cb" value="${escAttr(m.path)}" checked>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escAttr(m.path)}">${escHtml(m.filename)}</span>
          <span style="color:#888;font-size:12px;flex-shrink:0;">${fmtBytes(m.size)}</span>
          <span style="color:#4ade80;font-size:11px;flex-shrink:0;">MP4 exists</span>
        </label>`;
      }
    }
    if (withoutMp4.length > 0) {
      html += `<div style="font-size:13px;color:#ccc;margin-top:14px;margin-bottom:8px;font-weight:600;">MKV files without MP4 (${withoutMp4.length})</div>`;
      for (const m of withoutMp4) {
        html += `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;color:#ccc;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04);">
          <input type="checkbox" class="orphan-mkv-cb" value="${escAttr(m.path)}">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escAttr(m.path)}">${escHtml(m.filename)}</span>
          <span style="color:#888;font-size:12px;flex-shrink:0;">${fmtBytes(m.size)}</span>
          <span style="color:#f59e0b;font-size:11px;flex-shrink:0;">No MP4</span>
        </label>`;
      }
    }

    list.innerHTML = html;
    const totalSize = mkvs.reduce((s, m) => s + m.size, 0);
    status.textContent = `${mkvs.length} MKV files found (${fmtBytes(totalSize)})`;
    delBtn.style.display = 'inline-block';
  } catch {
    toast('Failed to scan', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Scan for MKVs';
  }
}

async function deleteSelectedMkvs() {
  const checkboxes = document.querySelectorAll('.orphan-mkv-cb:checked');
  const files = Array.from(checkboxes).map(cb => cb.value);
  if (files.length === 0) { toast('No files selected'); return; }

  const ok = await showConfirm({
    title: 'Delete MKV files',
    desc: `This will permanently delete ${files.length} MKV file${files.length > 1 ? 's' : ''}. This cannot be undone.`,
    icon: '🗑️',
    iconBg: 'rgba(239,68,68,0.15)',
    btnText: `Delete ${files.length} file${files.length > 1 ? 's' : ''}`,
    btnColor: '#ef4444'
  });
  if (!ok) return;

  const btn = document.getElementById('btnDeleteMkvs');
  btn.disabled = true; btn.textContent = 'Deleting...';
  try {
    const res = await fetch('/api/delete-mkvs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files })
    });
    const data = await res.json();
    if (data.ok) {
      toast(`${data.deleted} file${data.deleted > 1 ? 's' : ''} deleted`);
      scanOrphanMkvs(); // refresh list
    } else {
      toast(data.error || 'Error', true);
    }
  } catch {
    toast('Error deleting files', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Delete selected';
  }
}

// --- Watch ---
async function loadWatchStatus() {
  try {
    const res = await fetch('/api/watch/status');
    const d = await res.json();
    document.getElementById('watchEnabled').checked = d.enabled;
    document.getElementById('watchStability').value = d.stabilitySeconds || 30;
    const el = document.getElementById('watchStatus');
    if (d.enabled && d.watching) {
      el.style.display = 'block';
      el.style.background = 'rgba(74,222,128,0.08)';
      el.style.border = '1px solid rgba(74,222,128,0.2)';
      el.style.color = '#4ade80';
      let text = `Watching ${d.directories.length} director${d.directories.length === 1 ? 'y' : 'ies'}`;
      if (d.queueLength > 0) text += ` · ${d.queueLength} file${d.queueLength === 1 ? '' : 's'} queued`;
      if (d.pendingFiles > 0) text += ` · ${d.pendingFiles} file${d.pendingFiles === 1 ? '' : 's'} pending`;
      el.textContent = text;
    } else if (d.enabled && !d.watching) {
      el.style.display = 'block';
      el.style.background = 'rgba(245,158,11,0.08)';
      el.style.border = '1px solid rgba(245,158,11,0.2)';
      el.style.color = '#f59e0b';
      el.textContent = 'Enabled but not watching — no valid directories configured';
    } else {
      el.style.display = 'none';
    }
  } catch {}
}
async function toggleWatch(enabled) {
  try {
    const res = await fetch('/api/watch/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    const d = await res.json();
    if (d.ok) {
      toast(enabled ? 'Folder Watch enabled' : 'Folder Watch disabled');
      loadWatchStatus();
    } else toast(d.error || 'Error', true);
  } catch { toast('Failed to toggle watch', true); }
}
async function saveWatchConfig() {
  const stabilitySeconds = parseInt(document.getElementById('watchStability').value, 10) || 30;
  try {
    const res = await fetch('/api/watch/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stabilitySeconds }) });
    const d = await res.json();
    if (d.ok) toast('Watch settings saved');
    else toast(d.error || 'Error', true);
  } catch { toast('Failed to save', true); }
}

// --- Plex ---
async function loadPlexStatus() {
  try {
    const res = await fetch('/api/plex/status');
    const d = await res.json();
    document.getElementById('plexEnabled').checked = d.enabled;
    document.getElementById('plexUrl').value = d.url || 'http://localhost:32400';
    if (d.hasToken) document.getElementById('plexToken').value = '••••••••';
    if (d.libraryIds && d.libraryIds.length > 0) {
      // Mark saved library selections (they'll be rendered on test connection)
      document.getElementById('plexLibraries')._savedIds = d.libraryIds;
    }
  } catch {}
}
async function togglePlex(enabled) {
  try {
    const res = await fetch('/api/plex/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    const d = await res.json();
    if (d.ok) toast(enabled ? 'Plex refresh enabled' : 'Plex refresh disabled');
    else toast(d.error || 'Error', true);
  } catch { toast('Failed to toggle', true); }
}
async function savePlexConfig() {
  const url = document.getElementById('plexUrl').value.trim();
  const token = document.getElementById('plexToken').value;
  const payload = { url };
  if (token && token !== '••••••••') payload.token = token;
  // Gather selected library IDs
  const checks = document.querySelectorAll('#plexLibraryList input[type="checkbox"]');
  if (checks.length > 0) {
    payload.libraryIds = [...checks].filter(c => c.checked).map(c => c.value);
  }
  try {
    const res = await fetch('/api/plex/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await res.json();
    if (d.ok) toast('Plex settings saved');
    else toast(d.error || 'Error', true);
  } catch { toast('Failed to save', true); }
}
async function testPlexConnection() {
  const el = document.getElementById('plexTestResult');
  el.style.display = 'inline'; el.style.color = '#888'; el.textContent = 'Connecting...';
  const url = document.getElementById('plexUrl').value.trim();
  const token = document.getElementById('plexToken').value;
  const payload = {};
  if (url) payload.url = url;
  if (token && token !== '••••••••') payload.token = token;
  try {
    const res = await fetch('/api/plex/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await res.json();
    if (d.ok) {
      el.style.color = '#4ade80';
      el.textContent = `Connected — ${d.libraries.length} librar${d.libraries.length === 1 ? 'y' : 'ies'} found`;
      // Show library checkboxes
      const container = document.getElementById('plexLibraries');
      const savedIds = container._savedIds || [];
      container.style.display = 'block';
      document.getElementById('plexLibraryList').innerHTML = d.libraries.map(lib => {
        const checked = savedIds.includes(lib.id) ? ' checked' : '';
        return `<label style="display:flex;align-items:center;gap:8px;padding:8px 0;font-size:13px;color:#ccc;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;"><input type="checkbox" value="${escAttr(lib.id)}"${checked}> <span>${escHtml(lib.title)}</span> <span style="color:#555;font-size:12px;">${escHtml(lib.type)}</span></label>`;
      }).join('');
    } else {
      el.style.color = '#ef4444'; el.textContent = d.error || 'Failed';
    }
  } catch { el.style.color = '#ef4444'; el.textContent = 'Connection failed'; }
  setTimeout(() => el.style.display = 'none', 5000);
}
async function manualPlexRefresh() {
  try {
    const res = await fetch('/api/plex/refresh', { method: 'POST' });
    const d = await res.json();
    if (d.ok) toast(`Refreshed ${d.refreshed.length} librar${d.refreshed.length === 1 ? 'y' : 'ies'}`);
    else toast(d.error || 'Error', true);
  } catch { toast('Refresh failed', true); }
}

// --- Subtitles ---
async function loadSubsStatus() {
  try {
    const res = await fetch('/api/subtitles/status');
    const d = await res.json();
    document.getElementById('subsEnabled').checked = d.enabled;
    if (d.hasApiKey) document.getElementById('subsApiKey').value = '••••••••';
    // Set language checkboxes
    const langs = d.languages || ['nl', 'en'];
    document.querySelectorAll('.subs-lang').forEach(cb => {
      cb.checked = langs.includes(cb.value);
    });
  } catch {}
}
async function toggleSubtitles(enabled) {
  try {
    const res = await fetch('/api/subtitles/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    const d = await res.json();
    if (d.ok) toast(enabled ? 'Subtitles enabled' : 'Subtitles disabled');
    else toast(d.error || 'Error', true);
  } catch { toast('Failed to toggle', true); }
}
async function saveSubsConfig() {
  const apiKey = document.getElementById('subsApiKey').value;
  const languages = [...document.querySelectorAll('.subs-lang:checked')].map(cb => cb.value);
  const payload = { languages };
  if (apiKey && apiKey !== '••••••••') payload.apiKey = apiKey;
  try {
    const res = await fetch('/api/subtitles/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await res.json();
    if (d.ok) toast('Subtitle settings saved');
    else toast(d.error || 'Error', true);
  } catch { toast('Failed to save', true); }
}
async function testSubsKey() {
  const el = document.getElementById('subsTestResult');
  el.style.display = 'inline'; el.style.color = '#888'; el.textContent = 'Testing...';
  const apiKey = document.getElementById('subsApiKey').value;
  const payload = {};
  if (apiKey && apiKey !== '••••••••') payload.apiKey = apiKey;
  try {
    const res = await fetch('/api/subtitles/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await res.json();
    if (d.ok) { el.style.color = '#4ade80'; el.textContent = 'API key valid'; }
    else { el.style.color = '#ef4444'; el.textContent = d.error || 'Invalid key'; }
  } catch { el.style.color = '#ef4444'; el.textContent = 'Test failed'; }
  setTimeout(() => el.style.display = 'none', 5000);
}

// --- Auth ---
function loadAuthStatus() {
  fetch('/api/auth/status').then(r=>r.json()).then(data=>{
    const setupEl = document.getElementById('authSetup');
    const manageEl = document.getElementById('authManage');
    const logoutBtn = document.getElementById('logoutBtn');
    if (data.authEnabled && data.loggedIn) {
      setupEl.style.display = 'none';
      manageEl.style.display = 'block';
      document.getElementById('authCurrentUser').textContent = data.user;
      if (logoutBtn) logoutBtn.style.display = 'block';
    } else {
      setupEl.style.display = 'block';
      manageEl.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'none';
    }
  }).catch(()=>{});
}
function showAuthMsg(msg, ok) {
  const el = document.getElementById('authMsg');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = ok ? 'rgba(74,222,128,0.1)' : 'rgba(239,68,68,0.1)';
  el.style.border = ok ? '1px solid rgba(74,222,128,0.25)' : '1px solid rgba(239,68,68,0.25)';
  el.style.color = ok ? '#4ade80' : '#ef4444';
  setTimeout(()=>{ el.style.display = 'none'; }, 4000);
}
async function authCreateUser() {
  const u = document.getElementById('authNewUser').value.trim();
  const p = document.getElementById('authNewPass').value;
  if (!u || !p) return showAuthMsg('Fill in both fields', false);
  const r = await fetch('/api/auth/setup', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u,password:p}) });
  const d = await r.json();
  if (!r.ok) return showAuthMsg(d.error, false);
  showAuthMsg('Login enabled! You are now signed in as ' + d.user, true);
  loadAuthStatus();
}
async function authChangePass() {
  const cur = document.getElementById('authCurPass').value;
  const nw = document.getElementById('authChgPass').value;
  if (!cur || !nw) return showAuthMsg('Fill in both fields', false);
  const r = await fetch('/api/auth/change-password', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({currentPassword:cur,newPassword:nw}) });
  const d = await r.json();
  if (!r.ok) return showAuthMsg(d.error, false);
  showAuthMsg('Password updated', true);
  document.getElementById('authCurPass').value = '';
  document.getElementById('authChgPass').value = '';
}
async function authDisable() {
  const p = document.getElementById('authDelPass').value;
  if (!p) return showAuthMsg('Enter your password to confirm', false);
  const r = await fetch('/api/auth/delete-user', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:p}) });
  const d = await r.json();
  if (!r.ok) return showAuthMsg(d.error, false);
  showAuthMsg('Authentication disabled', true);
  document.getElementById('authDelPass').value = '';
  loadAuthStatus();
}
async function doLogout() {
  await fetch('/api/auth/logout', { method:'POST' });
  window.location.href = '/';
}
