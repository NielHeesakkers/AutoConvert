// --- Modal (text input) ---
let _modalResolve=null;
function openModal(title,placeholder){
  document.getElementById('modalTitle').textContent=title;
  const inp=document.getElementById('modalInput');
  inp.value='';inp.placeholder=placeholder||'';
  const ov=document.getElementById('modalOverlay');
  ov.style.display='flex';
  inp.focus();
  return new Promise(r=>{_modalResolve=r;});
}
function closeModal(val){
  document.getElementById('modalOverlay').style.display='none';
  if(_modalResolve){_modalResolve(val);_modalResolve=null;}
}

// --- Confirm dialog ---
let _confirmResolve=null;
function showConfirm({title,desc,icon,iconBg,btnText,btnColor}){
  document.getElementById('confirmTitle').textContent=title;
  document.getElementById('confirmDesc').textContent=desc||'';
  const ic=document.getElementById('confirmIcon'); ic.textContent=icon||'⚠️'; ic.style.background=iconBg||'rgba(239,68,68,0.15)';
  const ab=document.getElementById('confirmActionBtn'); ab.textContent=btnText||'Confirm'; ab.style.background=btnColor||'#ef4444'; ab.style.color='#fff';
  document.getElementById('confirmModal').style.display='flex';
  return new Promise(r=>{_confirmResolve=r;});
}
function resolveConfirm(val){document.getElementById('confirmModal').style.display='none';if(_confirmResolve)_confirmResolve(val);_confirmResolve=null;}
document.getElementById('confirmModal').addEventListener('click',e=>{if(e.target.id==='confirmModal')resolveConfirm(false);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('confirmModal').style.display==='flex')resolveConfirm(false);});

// --- Fail detail modal ---
function showFailDetail(item){
  const tmdb=item.tmdb||{};
  const title=tmdb.title||item.basename||'Unknown';
  const year=tmdb.year?` (${tmdb.year})`:'';
  document.getElementById('failDetailTitle').textContent=title+year;
  const meta=[];
  if(item.section) meta.push(item.section==='movies'?'Movie':'Series');
  if(item.size) meta.push(item.size);
  if(item.basename) meta.push(item.basename);
  document.getElementById('failDetailMeta').textContent=meta.join(' · ');
  document.getElementById('failDetailReason').textContent=item.reason||'No error details available. The conversion may have failed silently or the log was not captured.';
  document.getElementById('failDetailModal').style.display='flex';
}
document.getElementById('failDetailModal').addEventListener('click',e=>{if(e.target.id==='failDetailModal')e.target.style.display='none';});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('failDetailModal').style.display==='flex')document.getElementById('failDetailModal').style.display='none';});

// --- Resend modal ---
let _resendId=null, _resendBtn=null;
function resendReport(id, btn) {
  _resendId=id; _resendBtn=btn;
  document.getElementById('resendEmail').value='';
  const modal=document.getElementById('resendModal');
  modal.style.display='flex';
  setTimeout(()=>document.getElementById('resendEmail').focus(),50);
}
function closeResendModal() { document.getElementById('resendModal').style.display='none'; _resendId=null; _resendBtn=null; }
document.getElementById('resendModal').addEventListener('click',e=>{if(e.target.id==='resendModal')closeResendModal();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('resendModal').style.display==='flex')closeResendModal();});
async function confirmResend() {
  if(!_resendId) return;
  const id=_resendId, btn=_resendBtn;
  const email=document.getElementById('resendEmail').value.trim();
  closeResendModal();
  if(btn){btn.textContent='…';btn.disabled=true;}
  try {
    const body=email?{email}:{};
    const res=await fetch(`/api/reports/${encodeURIComponent(id)}/resend`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await res.json();
    if(d.ok) {
      toast(`✓ Report sent to ${d.sentTo.join(', ')}`, false, 5000);
      if(btn){btn.textContent='✓';btn.style.color='#22c55e';setTimeout(()=>{btn.textContent='✉';btn.style.color='';btn.disabled=false;},3000);}
    } else {
      toast(d.error||'Failed to send report',true);
      if(btn){btn.textContent='✉';btn.disabled=false;}
    }
  } catch {
    toast('Failed to send report',true);
    if(btn){btn.textContent='✉';btn.disabled=false;}
  }
}
