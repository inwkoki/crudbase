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

  // New tables for dashboard
  await pool.query(`
    CREATE TABLE IF NOT EXISTS habits (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT DEFAULT '✅',
      color TEXT DEFAULT '#7c5cfc',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS habit_logs (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      habit_id UUID REFERENCES habits(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      done BOOLEAN DEFAULT true,
      UNIQUE(habit_id, user_id, date)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS achievements (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      unlocked_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, key)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fit_tokens (
      user_id UUID REFERENCES users(id) ON DELETE CASCADE PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMP
    );
  `);

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

// ── Google Fit OAuth ───────────────────────────
const axios = require('axios');
const GFIT_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GFIT_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GFIT_REDIRECT      = (process.env.APP_URL || 'http://localhost:3000') + '/api/googlefit/callback';
const GFIT_SCOPES = [
  'https://www.googleapis.com/auth/fitness.activity.read',
  'https://www.googleapis.com/auth/fitness.sleep.read',
  'https://www.googleapis.com/auth/fitness.body.read',
].join(' ');

app.get('/api/googlefit/connect', requireAuth, (req, res) => {
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GFIT_CLIENT_ID}&redirect_uri=${encodeURIComponent(GFIT_REDIRECT)}&response_type=code&scope=${encodeURIComponent(GFIT_SCOPES)}&access_type=offline&prompt=consent&state=${req.user.id}`;
  res.redirect(url);
});

app.get('/api/googlefit/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  try {
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      code, client_id: GFIT_CLIENT_ID, client_secret: GFIT_CLIENT_SECRET,
      redirect_uri: GFIT_REDIRECT, grant_type: 'authorization_code'
    });
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);
    await pool.query(`INSERT INTO fit_tokens (user_id,access_token,refresh_token,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET access_token=$2,refresh_token=COALESCE($3,fit_tokens.refresh_token),expires_at=$4`,
      [userId, data.access_token, data.refresh_token||null, expiresAt]);
    res.redirect('/?fit=connected');
  } catch (err) { console.error('Fit OAuth error:', err.message); res.redirect('/?fit=error'); }
});

async function getFitToken(userId) {
  const r = await pool.query('SELECT * FROM fit_tokens WHERE user_id=$1', [userId]);
  if (!r.rows.length) return null;
  let { access_token, refresh_token, expires_at } = r.rows[0];
  if (new Date() >= new Date(expires_at)) {
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: GFIT_CLIENT_ID, client_secret: GFIT_CLIENT_SECRET,
      refresh_token, grant_type: 'refresh_token'
    });
    access_token = data.access_token;
    await pool.query('UPDATE fit_tokens SET access_token=$1, expires_at=$2 WHERE user_id=$3',
      [access_token, new Date(Date.now() + data.expires_in*1000), userId]);
  }
  return access_token;
}

app.delete('/api/googlefit/disconnect', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM fit_tokens WHERE user_id=$1', [req.user.id]);
  res.json({ success: true });
});

app.get('/api/googlefit/today', requireAuth, async (req, res) => {
  try {
    const token = await getFitToken(req.user.id);
    if (!token) return res.json({ success: false, message: 'not_connected' });
    const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
    const body = {
      aggregateBy: [
        { dataTypeName: 'com.google.step_count.delta' },
        { dataTypeName: 'com.google.calories.expended' },
        { dataTypeName: 'com.google.sleep.segment' },
      ],
      bucketByTime: { durationMillis: 86400000 },
      startTimeMillis: startOfDay.getTime(),
      endTimeMillis: Date.now()
    };
    const { data } = await axios.post('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', body, { headers: { Authorization: `Bearer ${token}` } });
    let steps=0, calories=0, sleepMin=0;
    for (const bucket of data.bucket||[]) {
      for (const ds of bucket.dataset||[]) {
        for (const pt of ds.point||[]) {
          if (ds.dataSourceId.includes('step_count'))  steps    += pt.value?.[0]?.intVal||0;
          if (ds.dataSourceId.includes('calories'))    calories += Math.round(pt.value?.[0]?.fpVal||0);
          if (ds.dataSourceId.includes('sleep') && pt.value?.[0]?.intVal===1) sleepMin++;
        }
      }
    }
    res.json({ success: true, data: { steps, calories, sleep_hours: +(sleepMin/60).toFixed(1) } });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// ── Habits ─────────────────────────────────────
async function calcStreak(habitId, userId) {
  const logs = await pool.query('SELECT date FROM habit_logs WHERE habit_id=$1 AND user_id=$2 AND done=true ORDER BY date DESC LIMIT 365', [habitId, userId]);
  if (!logs.rows.length) return 0;
  let streak=0; const d=new Date(); d.setHours(0,0,0,0);
  for (const row of logs.rows) {
    const diff = Math.round((d - new Date(row.date+'T00:00:00')) / 86400000);
    if (diff===streak) streak++; else break;
  }
  return streak;
}

app.get('/api/habits', requireAuth, async (req, res) => {
  try {
    const habits = await pool.query('SELECT * FROM habits WHERE user_id=$1 ORDER BY created_at ASC', [req.user.id]);
    const today = new Date().toISOString().slice(0,10);
    const result = [];
    for (const h of habits.rows) {
      const log = await pool.query('SELECT done FROM habit_logs WHERE habit_id=$1 AND user_id=$2 AND date=$3', [h.id, req.user.id, today]);
      const streak = await calcStreak(h.id, req.user.id);
      result.push({ ...h, done_today: log.rows[0]?.done||false, streak });
    }
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/habits', requireAuth, async (req, res) => {
  try {
    const { name, icon='✅', color='#7c5cfc' } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Name required' });
    const r = await pool.query('INSERT INTO habits (user_id,name,icon,color) VALUES ($1,$2,$3,$4) RETURNING *', [req.user.id, name.trim(), icon, color]);
    res.status(201).json({ success: true, data: { ...r.rows[0], done_today: false, streak: 0 } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/habits/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM habit_logs WHERE habit_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    await pool.query('DELETE FROM habits WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/habits/:id/toggle', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const existing = await pool.query('SELECT done FROM habit_logs WHERE habit_id=$1 AND user_id=$2 AND date=$3', [req.params.id, req.user.id, today]);
    let done;
    if (existing.rows.length) {
      done = !existing.rows[0].done;
      await pool.query('UPDATE habit_logs SET done=$1 WHERE habit_id=$2 AND user_id=$3 AND date=$4', [done, req.params.id, req.user.id, today]);
    } else {
      done = true;
      await pool.query('INSERT INTO habit_logs (habit_id,user_id,date,done) VALUES ($1,$2,$3,true)', [req.params.id, req.user.id, today]);
    }
    const streak = await calcStreak(req.params.id, req.user.id);
    await checkAchievements(req.user.id, streak);
    res.json({ success: true, done, streak });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Achievements ───────────────────────────────
const ACHIEVEMENT_DEFS = [
  { key:'first_habit',   label:'First Step',    icon:'🌱', desc:'Complete your first habit',       color:'#4ade80' },
  { key:'streak_3',      label:'On a Roll',     icon:'🔥', desc:'3-day streak on any habit',       color:'#f5a623' },
  { key:'streak_7',      label:'Week Warrior',  icon:'⚡', desc:'7-day streak on any habit',       color:'#fc5c7d' },
  { key:'streak_30',     label:'Iron Will',     icon:'💎', desc:'30-day streak on any habit',      color:'#7c5cfc' },
  { key:'tasks_done_1',  label:'First Task',    icon:'✅', desc:'Complete your first task',        color:'#4ade80' },
  { key:'tasks_done_10', label:'Productive',    icon:'🚀', desc:'Complete 10 tasks',               color:'#5ba3f5' },
  { key:'tasks_done_50', label:'Task Master',   icon:'🏆', desc:'Complete 50 tasks',               color:'#f5a623' },
  { key:'all_habits_day',label:'Perfect Day',   icon:'⭐', desc:'All habits done in one day',      color:'#fc5c7d' },
  { key:'fit_connected', label:'Health Sync',   icon:'💪', desc:'Connect Google Fit',             color:'#4ade80' },
  { key:'steps_10k',     label:'10K Steps',     icon:'👟', desc:'Walk 10,000 steps in a day',     color:'#5ba3f5' },
];

async function checkAchievements(userId, streak=0) {
  try {
    if (streak>=1)  await unlockAch(userId,'first_habit');
    if (streak>=3)  await unlockAch(userId,'streak_3');
    if (streak>=7)  await unlockAch(userId,'streak_7');
    if (streak>=30) await unlockAch(userId,'streak_30');
    const r = await pool.query("SELECT COUNT(*) FROM tasks WHERE status='done'");
    const n = parseInt(r.rows[0].count);
    if (n>=1)  await unlockAch(userId,'tasks_done_1');
    if (n>=10) await unlockAch(userId,'tasks_done_10');
    if (n>=50) await unlockAch(userId,'tasks_done_50');
  } catch(e){ console.error('ach check error:',e.message); }
}

async function unlockAch(userId, key) {
  await pool.query('INSERT INTO achievements (user_id,key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, key]);
}

app.get('/api/achievements', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT key, unlocked_at FROM achievements WHERE user_id=$1', [req.user.id]);
    const map = {}; r.rows.forEach(row => { map[row.key] = row.unlocked_at; });
    const all = ACHIEVEMENT_DEFS.map(a => ({ ...a, unlocked: !!map[a.key], unlocked_at: map[a.key]||null }));
    res.json({ success: true, data: all });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/achievements/check', requireAuth, async (req, res) => {
  await checkAchievements(req.user.id, req.body.streak||0);
  res.json({ success: true });
});

// ── Weather proxy (Open-Meteo, no API key needed) ──
app.get('/api/weather', requireAuth, async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat||!lon) return res.status(400).json({ success: false, message: 'lat and lon required' });
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=relativehumidity_2m&timezone=auto&forecast_days=1`;
    const { data } = await axios.get(url);
    const w = data.current_weather;
    const humidity = data.hourly?.relativehumidity_2m?.[new Date().getHours()]||0;
    const weatherInfo = (code) => {
      if (code===0)  return {emoji:'☀️',label:'Clear'};
      if (code<=3)   return {emoji:'⛅',label:'Partly cloudy'};
      if (code<=49)  return {emoji:'🌫️',label:'Foggy'};
      if (code<=67)  return {emoji:'🌧️',label:'Rain'};
      if (code<=77)  return {emoji:'❄️',label:'Snow'};
      if (code<=82)  return {emoji:'🌦️',label:'Showers'};
      return {emoji:'⛈️',label:'Storm'};
    };
    const wi = weatherInfo(w.weathercode);
    res.json({ success: true, data: { temp: Math.round(w.temperature), windspeed: Math.round(w.windspeed), humidity, ...wi, is_day: w.is_day===1 } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`)))
  .catch(err => { console.error('❌ DB init failed:', err.message); process.exit(1); });
