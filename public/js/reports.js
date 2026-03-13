// --- Reports ---
function fmtSize(bytes) {
  if(!bytes||bytes<=0) return '0 B';
  const u=['B','KB','MB','GB','TB']; let i=0,s=bytes;
  while(s>=1024&&i<u.length-1){s/=1024;i++;}
  return s.toFixed(i<=1?0:1)+' '+u[i];
}
async function loadReportStats() {
  try {
    const res=await fetch('/api/reports/stats'); const s=await res.json();
    const total=s.movies+s.series;
    if(total===0){document.getElementById('reportStats').style.display='none';return;}
    document.getElementById('reportStats').style.display='';
    document.getElementById('statMovies').textContent=s.movies;
    document.getElementById('statSeries').textContent=s.series;
    document.getElementById('statProcessed').textContent=fmtSize(s.totalOld);
    document.getElementById('statSaved').textContent=fmtSize(s.saved);
    const savedPct=s.totalOld>0?Math.round(((s.totalOld-s.totalNew)/s.totalOld)*100):0;
    document.getElementById('statSavedPct').textContent=savedPct>0?'('+savedPct+'%)':'';
    document.getElementById('statOldSize').textContent=fmtSize(s.totalOld);
    document.getElementById('statNewSize').textContent=fmtSize(s.totalNew);
    const barPct=s.totalOld>0?Math.round((s.totalNew/s.totalOld)*100):0;
    document.getElementById('statBarNew').style.width=barPct+'%';
    const barLabel=document.getElementById('statBarPctLabel');
    if(savedPct>0){barLabel.textContent=fmtSize(s.totalOld)+' → '+fmtSize(s.totalNew)+' ('+savedPct+'% smaller)';barLabel.style.display='';}
    else{barLabel.style.display='none';}
  } catch {}
}
let reportsOffset=0; const REPORTS_LIMIT=10; let reportsHasMore=true;
async function loadReports() { reportsOffset=0; reportsHasMore=true; document.getElementById('reportsContainer').innerHTML=''; loadReportStats(); loadDiskSpace(); await loadMoreReports(); }
async function loadMoreReports() {
  try {
    const res=await fetch(`/api/reports?offset=${reportsOffset}&limit=${REPORTS_LIMIT}`); const d=await res.json(); const reports=d.reports||[];
    if(!reports.length){reportsHasMore=false;document.getElementById('btnLoadMore').style.display='none';if(reportsOffset===0)document.getElementById('reportsContainer').innerHTML='<div class="report-empty">No reports available.</div>';return;}
    const container=document.getElementById('reportsContainer');
    reports.forEach((r,i)=>container.appendChild(renderReportDay(r,!(reportsOffset===0&&i===0))));
    reportsOffset+=reports.length; reportsHasMore=reports.length>=REPORTS_LIMIT;
    document.getElementById('btnLoadMore').style.display=reportsHasMore?'':'none';
  } catch { if(reportsOffset===0)document.getElementById('reportsContainer').innerHTML='<div class="report-empty">Could not load reports.</div>'; document.getElementById('btnLoadMore').style.display='none'; }
}

function renderReportDay(report, collapsed) {
  const div=document.createElement('div'); div.className='report-day'+(collapsed?' collapsed':'');
  const converted=report.converted||[], failed=report.failed||[], dupes=report.dupes||[], date=report.date||'';
  const header=document.createElement('div'); header.className='report-day-header';
  const emailedBadge=report.emailed?`<span class="report-summary-badge" style="background:#dcfce7;color:#16a34a;" title="Sent ${new Date(report.emailed).toLocaleString()}">✓ Sent</span>`:'';
  header.innerHTML=`<span class="report-day-chevron">&#9660;</span><span class="report-day-date">${escHtml(date)}</span><div class="report-day-badges">${emailedBadge}${converted.length?`<span class="report-summary-badge converted">${converted.length} converted</span>`:''}${failed.length?`<span class="report-summary-badge failed">${failed.length} failed</span>`:''}${dupes.length?`<span class="report-summary-badge dupes">${dupes.length} duplicates</span>`:''}</div><button class="report-day-delete" title="Resend email" onclick="event.stopPropagation();resendReport('${escAttr(report.filename||'')}',this)" style="color:#818cf8;">&#9993;</button><button class="report-day-delete" title="Delete" onclick="event.stopPropagation();deleteReport('${escAttr(report.filename||'')}',this)">&#128465;</button>`;
  header.addEventListener('click',e=>{if(!e.target.closest('.report-day-delete'))div.classList.toggle('collapsed');});
  div.appendChild(header);
  const content=document.createElement('div'); content.className='report-day-content';
  if(converted.length){content.innerHTML+='<div class="report-section-label">Converted</div>';converted.forEach(item=>{const el=renderReportItem(item,'converted');content.appendChild(el);if(!item.mp4_path&&item.section&&item.basename){fetch('/api/find-mp4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({section:item.section,basename:item.basename})}).then(r=>r.json()).then(d=>{if(d.mp4_path){const a=document.createElement('a');a.href='/api/download?path='+encodeURIComponent(d.mp4_path);a.className='report-download-btn';a.title='Download MP4';a.textContent='⬇';el.appendChild(a);}}).catch(()=>{});}});}
  if(failed.length){content.innerHTML+='<div class="report-section-label">Failed</div>';failed.forEach(item=>content.appendChild(renderReportItem(item,'failed')));}
  if(dupes.length){content.innerHTML+='<div class="report-section-label">Duplicates</div>';dupes.forEach(item=>{const d=document.createElement('div');d.className='report-dupe-item';const n=item.name||item.filename||JSON.stringify(item);d.innerHTML=`<span class="dupe-name" title="${escAttr(n)}">${escHtml(n)}</span>`;content.appendChild(d);});}
  if(!converted.length&&!failed.length&&!dupes.length) content.innerHTML='<div class="report-empty" style="padding:14px;">No items.</div>';
  div.appendChild(content); return div;
}

function renderReportItem(item, type) {
  const div=document.createElement('div'); div.className='report-item'+(type==='failed'?' failed':'');
  if(type==='failed'){div.style.cursor='pointer';div.title='Click for details';}
  const tmdb=item.tmdb||{};
  const poster=tmdb.poster?`<img class="report-poster" src="${escAttr(tmdb.poster)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'report-poster-placeholder\\'>&#127910;</div>'">`:`<div class="report-poster-placeholder">&#127910;</div>`;
  const title=tmdb.title||item.basename||'Unknown';
  const year=tmdb.year?`<span class="year">(${tmdb.year})</span>`:'';
  let badges='';
  if(item.section){const c=item.section==='movies'?'movies':'series';const l=item.section==='movies'?'Movie':'Series';badges+=`<span class="report-badge ${c}">${l}</span>`;}
  if(tmdb.ep_label) badges+=`<span class="report-badge episode">${escHtml(tmdb.ep_label)}</span>`;
  if(tmdb.rating&&tmdb.rating>0) badges+=`<span class="report-badge rating">${tmdb.rating}</span>`;
  let sizeHtml=''; if(type!=='failed'&&(item.old_size||item.new_size)) sizeHtml=`<div class="report-item-size">${escHtml(item.old_size||'?')} &#8594; ${escHtml(item.new_size||'?')}</div>`;
  let durHtml=''; if(item.duration&&parseInt(item.duration)>0) durHtml=`<span class="report-item-duration">${item.duration} min</span>`;
  let fnHtml=''; if(type==='failed'&&item.basename) fnHtml=`<div class="report-item-filename">${escHtml(item.basename)}</div>`;
  let dlHtml=''; if(type==='converted'&&item.mp4_path) dlHtml=`<a href="/api/download?path=${encodeURIComponent(item.mp4_path)}" class="report-download-btn" title="Download MP4">⬇</a>`;
  div.innerHTML=`${poster}<div class="report-item-info"><div class="report-item-title">${escHtml(title)}${year}</div>${badges?`<div class="report-item-meta">${badges}</div>`:''}${sizeHtml}${durHtml?`<div class="report-item-meta">${durHtml}</div>`:''}${fnHtml}</div>${dlHtml}`;
  if(type==='failed') div.addEventListener('click',()=>showFailDetail(item));
  return div;
}

async function deleteReport(id, btn) {
  const ok=await showConfirm({title:'Delete Report',desc:'This report will be permanently removed.',icon:'🗑️',iconBg:'rgba(239,68,68,0.15)',btnText:'Delete',btnColor:'#ef4444'});
  if(!ok) return;
  try { const res=await fetch(`/api/reports/${encodeURIComponent(id)}`,{method:'DELETE'}); const d=await res.json(); if(d.ok){btn.closest('.report-day').remove();toast('Deleted');}else toast(d.error||'Error',true); } catch { toast('Error',true); }
}
async function deleteAllLogs() {
  const ok=await showConfirm({title:'Clear All Reports',desc:'All reports will be permanently deleted. This cannot be undone.',icon:'⚠️',iconBg:'rgba(239,68,68,0.15)',btnText:'Clear All',btnColor:'#ef4444'});
  if(!ok) return;
  try { const res=await fetch('/api/logs',{method:'DELETE'}); const d=await res.json(); if(d.ok){toast('Reports cleared');loadReports();}else toast(d.error||'Error',true); } catch { toast('Error',true); }
}
