const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const SALT_ROUNDS = 10;
const TOKEN_TTL = '7d';

app.use(cors({ credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ── Auth middleware ────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers?.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('token');
    res.status(401).json({ success: false, message: 'Session expired' });
  }
}

// Serve login page for unauthenticated users
app.use((req, res, next) => {
  const publicPaths = ['/login.html', '/api/auth/login', '/api/auth/register', '/api/auth/forgot-password', '/health'];
  const isPublic = publicPaths.some(p => req.path.startsWith(p));
  const isAsset = req.path.match(/\.(css|js|png|jpg|ico|woff|svg)$/);
  if (isPublic || isAsset) return next();

  // Check token for non-API routes (page navigation)
  if (!req.path.startsWith('/api/')) {
    const token = req.cookies?.token;
    if (!token) return res.redirect('/login.html');
    try { jwt.verify(token, JWT_SECRET); next(); }
    catch { res.clearCookie('token'); res.redirect('/login.html'); }
    return;
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── DB Pool ────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

async function initDB() {
  // Users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Tasks
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'todo' CHECK (status IN ('todo','in-progress','done')),
      priority TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
      deadline DATE,
      assignees TEXT DEFAULT '',
      quadrant TEXT DEFAULT 'q2',
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Avatars
  await pool.query(`
    CREATE TABLE IF NOT EXISTS avatars (
      name TEXT PRIMARY KEY,
      image_data TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Add missing columns for existing DBs
  const taskCols = [
    "deadline DATE",
    "assignees TEXT DEFAULT ''",
    "quadrant TEXT DEFAULT 'q2'",
    "sort_order INTEGER DEFAULT 0"
  ];
  for (const col of taskCols) {
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ${col};`).catch(() => {});
  }

  console.log('✅ Database ready');
}

// ── Auth Routes ────────────────────────────────

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, pin, display_name } = req.body;
    if (!username?.trim()) return res.status(400).json({ success: false, message: 'Username is required' });
    if (!password || password.length < 4) return res.status(400).json({ success: false, message: 'Password must be at least 4 characters' });
    if (!pin || !/^\d{4,6}$/.test(pin)) return res.status(400).json({ success: false, message: 'PIN must be 4–6 digits' });
    if (!display_name?.trim()) return res.status(400).json({ success: false, message: 'Display name is required' });

    const exists = await pool.query('SELECT id FROM users WHERE username=$1', [username.trim().toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ success: false, message: 'Username already taken' });

    const [password_hash, pin_hash] = await Promise.all([
      bcrypt.hash(password, SALT_ROUNDS),
      bcrypt.hash(pin, SALT_ROUNDS)
    ]);

    const result = await pool.query(
      'INSERT INTO users (username, password_hash, pin_hash, display_name) VALUES ($1,$2,$3,$4) RETURNING id, username, display_name, role',
      [username.trim().toLowerCase(), password_hash, pin_hash, display_name.trim()]
    );

    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.status(201).json({ success: true, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });

    const result = await pool.query('SELECT * FROM users WHERE username=$1', [username.trim().toLowerCase()]);
    if (!result.rows.length) return res.status(401).json({ success: false, message: 'Invalid username or password' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid username or password' });

    const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Forgot password — verify PIN then allow reset
app.post('/api/auth/verify-pin', async (req, res) => {
  try {
    const { username, pin } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE username=$1', [username.trim().toLowerCase()]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Username not found' });
    const valid = await bcrypt.compare(pin, result.rows[0].pin_hash);
    if (!valid) return res.status(401).json({ success: false, message: 'Incorrect PIN' });
    // Issue short-lived reset token
    const resetToken = jwt.sign({ id: result.rows[0].id, purpose: 'reset' }, JWT_SECRET, { expiresIn: '15m' });
    res.json({ success: true, reset_token: resetToken });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Reset password using reset token
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { reset_token, new_password } = req.body;
    if (!new_password || new_password.length < 4) return res.status(400).json({ success: false, message: 'Password must be at least 4 characters' });
    let payload;
    try { payload = jwt.verify(reset_token, JWT_SECRET); } catch { return res.status(401).json({ success: false, message: 'Reset link expired, please try again' }); }
    if (payload.purpose !== 'reset') return res.status(401).json({ success: false, message: 'Invalid reset token' });
    const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, payload.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Get current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, display_name, role, created_at FROM users WHERE id=$1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Get all users (for assignees dropdown)
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, display_name FROM users ORDER BY display_name');
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Tasks (all protected) ──────────────────────

app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { status, priority, quadrant } = req.query;
    let query = 'SELECT * FROM tasks';
    const params = [], conditions = [];
    if (status)   { params.push(status);   conditions.push(`status=$${params.length}`); }
    if (priority) { params.push(priority); conditions.push(`priority=$${params.length}`); }
    if (quadrant) { params.push(quadrant); conditions.push(`quadrant=$${params.length}`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY sort_order ASC, created_at DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows, total: result.rowCount });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { title, description = '', priority = 'medium', deadline = null, assignees = '', quadrant = 'q2' } = req.body;
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required' });
    const result = await pool.query(
      'INSERT INTO tasks (title, description, priority, deadline, assignees, quadrant) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [title.trim(), description.trim(), priority, deadline || null, assignees, quadrant]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const { title, description, status, priority, deadline, assignees, quadrant } = req.body;
    const fields = [], params = [];
    if (title !== undefined)       { params.push(title);          fields.push(`title=$${params.length}`); }
    if (description !== undefined) { params.push(description);    fields.push(`description=$${params.length}`); }
    if (status !== undefined)      { params.push(status);         fields.push(`status=$${params.length}`); }
    if (priority !== undefined)    { params.push(priority);       fields.push(`priority=$${params.length}`); }
    if (deadline !== undefined)    { params.push(deadline||null); fields.push(`deadline=$${params.length}`); }
    if (assignees !== undefined)   { params.push(assignees);      fields.push(`assignees=$${params.length}`); }
    if (quadrant !== undefined)    { params.push(quadrant);       fields.push(`quadrant=$${params.length}`); }
    if (!fields.length) return res.status(400).json({ success: false, message: 'No fields to update' });
    params.push(req.params.id);
    const result = await pool.query(`UPDATE tasks SET ${fields.join(',')} WHERE id=$${params.length} RETURNING *`, params);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.patch('/api/tasks/reorder', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    for (let i = 0; i < ids.length; i++)
      await pool.query('UPDATE tasks SET sort_order=$1 WHERE id=$2', [i, ids[i]]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Avatars ────────────────────────────────────

app.get('/api/avatars', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT name, image_data FROM avatars ORDER BY name');
    const map = {};
    result.rows.forEach(r => { map[r.name] = r.image_data; });
    res.json({ success: true, data: map });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/avatars', requireAuth, async (req, res) => {
  try {
    const { name, image_data } = req.body;
    if (!name?.trim() || !image_data) return res.status(400).json({ success: false, message: 'Name and image required' });
    await pool.query(
      'INSERT INTO avatars (name, image_data) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET image_data=$2, updated_at=NOW()',
      [name.trim().toLowerCase(), image_data]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/avatars/:name', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM avatars WHERE name=$1', [req.params.name.toLowerCase()]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), db: 'postgresql' }));

initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`)))
  .catch(err => { console.error('❌ DB init failed:', err.message); process.exit(1); });
