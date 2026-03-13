const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { getMediaDirs } = require('./config');

let dirCache = null;
let dirScanRunning = false;

async function findMkvAsync(dir, rel) {
  const files = [];
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const sub = await findMkvAsync(full, relPath);
        files.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith('.mkv')) {
        try {
          const stat = await fsPromises.stat(full);
          files.push({ name: entry.name, path: relPath, size: stat.size, modified: stat.mtime });
        } catch {}
      }
    }
  } catch {}
  return files;
}

async function scanDirectories() {
  if (dirScanRunning) return;
  dirScanRunning = true;
  const basePaths = getMediaDirs();
  try {
    const directories = await Promise.all(basePaths.map(async (dirPath) => {
      let exists = false;
      try { await fsPromises.access(dirPath); exists = true; } catch {}
      let files = [];
      if (exists) {
        files = await findMkvAsync(dirPath, '');
        files.sort((a, b) => a.path.localeCompare(b.path));
      }
      return { path: dirPath, name: path.basename(dirPath), exists, fileCount: files.length, files };
    }));
    dirCache = { directories, scannedAt: Date.now() };
    console.log(`[scan] Directory scan complete: ${directories.map(d => `${d.name}=${d.fileCount}`).join(', ')}`);
  } catch (err) {
    console.error('[scan] Error:', err.message);
  }
  dirScanRunning = false;
}

function getDirCache() { return dirCache; }
function clearDirCache() { dirCache = null; }

// Initial scan on load
scanDirectories();

module.exports = { scanDirectories, getDirCache, clearDirCache };
