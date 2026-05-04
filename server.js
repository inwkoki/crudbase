const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
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

  // Add columns for existing DBs
  const cols = ['deadline DATE', 'assignees TEXT DEFAULT \'\'', 'quadrant TEXT DEFAULT \'q2\'', 'sort_order INTEGER DEFAULT 0'];
  for (const col of cols) {
    const name = col.split(' ')[0];
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ${col};`).catch(() => {});
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS avatars (
      name TEXT PRIMARY KEY,
      image_data TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('✅ Database ready');
}

// ── Tasks ──────────────────────────────────────

app.get('/api/tasks', async (req, res) => {
  try {
    const { status, priority, quadrant } = req.query;
    let query = 'SELECT * FROM tasks';
    const params = [], conditions = [];
    if (status)   { params.push(status);   conditions.push(`status = $${params.length}`); }
    if (priority) { params.push(priority); conditions.push(`priority = $${params.length}`); }
    if (quadrant) { params.push(quadrant); conditions.push(`quadrant = $${params.length}`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY sort_order ASC, created_at DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows, total: result.rowCount });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/tasks/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/tasks', async (req, res) => {
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

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const { title, description, status, priority, deadline, assignees, quadrant } = req.body;
    const fields = [], params = [];
    if (title !== undefined)       { params.push(title);           fields.push(`title=$${params.length}`); }
    if (description !== undefined) { params.push(description);     fields.push(`description=$${params.length}`); }
    if (status !== undefined)      { params.push(status);          fields.push(`status=$${params.length}`); }
    if (priority !== undefined)    { params.push(priority);        fields.push(`priority=$${params.length}`); }
    if (deadline !== undefined)    { params.push(deadline||null);  fields.push(`deadline=$${params.length}`); }
    if (assignees !== undefined)   { params.push(assignees);       fields.push(`assignees=$${params.length}`); }
    if (quadrant !== undefined)    { params.push(quadrant);        fields.push(`quadrant=$${params.length}`); }
    if (!fields.length) return res.status(400).json({ success: false, message: 'No fields to update' });
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE tasks SET ${fields.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.patch('/api/tasks/reorder', async (req, res) => {
  try {
    const { ids } = req.body;
    for (let i = 0; i < ids.length; i++)
      await pool.query('UPDATE tasks SET sort_order=$1 WHERE id=$2', [i, ids[i]]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, message: 'Task deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Avatars ────────────────────────────────────

app.get('/api/avatars', async (req, res) => {
  try {
    const result = await pool.query('SELECT name, image_data FROM avatars ORDER BY name');
    const map = {};
    result.rows.forEach(r => { map[r.name] = r.image_data; });
    res.json({ success: true, data: map });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/avatars', async (req, res) => {
  try {
    const { name, image_data } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Name required' });
    if (!image_data) return res.status(400).json({ success: false, message: 'Image data required' });
    await pool.query(
      'INSERT INTO avatars (name, image_data) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET image_data=$2, updated_at=NOW()',
      [name.trim().toLowerCase(), image_data]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/avatars/:name', async (req, res) => {
  try {
    await pool.query('DELETE FROM avatars WHERE name=$1', [req.params.name.toLowerCase()]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), db: 'postgresql' }));

initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`)))
  .catch(err => { console.error('❌ DB init failed:', err.message); process.exit(1); });
