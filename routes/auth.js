const router = require('express').Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { APP_MODE, APP_SUPPORT, APP_DIR, readUsers, writeUsers } = require('../lib/config');

// --- Rate Limiting ---
const loginAttempts = new Map();
const RATE_LIMIT = { maxAttempts: 5, windowMs: 60 * 1000, lockoutMs: 5 * 60 * 1000 };

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.lockedUntil && now < entry.lockedUntil) {
    const remaining = Math.ceil((entry.lockedUntil - now) / 1000);
    return { allowed: false, remaining };
  }
  if (now - entry.firstAttempt > RATE_LIMIT.windowMs) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT.maxAttempts) {
    entry.lockedUntil = now + RATE_LIMIT.lockoutMs;
    const remaining = Math.ceil(RATE_LIMIT.lockoutMs / 1000);
    return { allowed: false, remaining };
  }
  return { allowed: true };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, firstAttempt: now };
  entry.count++;
  loginAttempts.set(ip, entry);
}

function clearFailedLogins(ip) { loginAttempts.delete(ip); }

// Clean up old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.firstAttempt > RATE_LIMIT.lockoutMs + RATE_LIMIT.windowMs) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);

router.get('/status', (req, res) => {
  const users = readUsers();
  res.json({
    authEnabled: users.length > 0,
    loggedIn: !!(req.session && req.session.user),
    user: req.session?.user || null,
  });
});

router.post('/setup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const users = readUsers();
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'User already exists' });
  const hash = bcrypt.hashSync(password, 12);
  users.push({ username, hash, createdAt: new Date().toISOString() });
  writeUsers(users);
  req.session.user = username;
  res.json({ ok: true, user: username });
});

router.post('/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return res.status(429).json({ error: `Too many login attempts. Try again in ${limit.remaining} seconds.` });
  }
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const users = readUsers();
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.hash)) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  clearFailedLogins(ip);
  req.session.user = username;
  res.json({ ok: true, user: username });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ac.sid');
    res.json({ ok: true });
  });
});

router.post('/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const users = readUsers();
  const user = users.find(u => u.username === req.session.user);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!bcrypt.compareSync(currentPassword, user.hash)) return res.status(401).json({ error: 'Current password is incorrect' });
  user.hash = bcrypt.hashSync(newPassword, 12);
  writeUsers(users);
  res.json({ ok: true });
});

router.post('/delete-user', (req, res) => {
  const { username, password } = req.body;
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  let users = readUsers();
  const user = users.find(u => u.username === (username || req.session.user));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!bcrypt.compareSync(password, user.hash)) return res.status(401).json({ error: 'Password is incorrect' });
  users = users.filter(u => u.username !== user.username);
  writeUsers(users);
  if (user.username === req.session.user) {
    req.session.destroy(() => {});
  }
  res.json({ ok: true, authDisabled: users.length === 0 });
});

// Reset endpoint — accepts a token written by the macOS menu bar app
router.post('/reset', (req, res) => {
  const { token, newUsername, newPassword } = req.body;
  const tokenPath = APP_MODE
    ? path.join(APP_SUPPORT, '.reset-token')
    : path.join(APP_DIR, '.reset-token');
  try {
    const storedToken = fs.readFileSync(tokenPath, 'utf8').trim();
    if (!token || token !== storedToken) return res.status(403).json({ error: 'Invalid reset token' });
    fs.unlinkSync(tokenPath); // one-time use
  } catch {
    return res.status(403).json({ error: 'No reset token found' });
  }
  if (!newUsername || !newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Username and password (min 4 chars) required' });
  }
  const hash = bcrypt.hashSync(newPassword, 12);
  writeUsers([{ username: newUsername, hash, createdAt: new Date().toISOString() }]);
  res.json({ ok: true });
});

module.exports = router;
