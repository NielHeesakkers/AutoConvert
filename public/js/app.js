// --- Init ---
initScheduleSelects();
loadAuthStatus();
loadDiskSpace(); loadStatus(); loadDirectories(); loadSchedule(); loadSmtp(); loadPresets(); loadRecipients(); loadReports(); loadBackups(); loadVersion(); loadAppSettings(); loadWatchStatus(); loadPlexStatus(); loadSubsStatus();
setInterval(()=>{ loadStatus(); if(isConvertRunning) loadProgress(); }, 3000);
