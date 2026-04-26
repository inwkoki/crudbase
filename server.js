const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
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
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline DATE;`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignees TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;`);
  console.log('✅ Database ready');
}

// GET all tasks
app.get('/api/tasks', async (req, res) => {
  try {
    const { status, priority } = req.query;
    let query = 'SELECT * FROM tasks';
    const params = [];
    const conditions = [];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (priority) { params.push(priority); conditions.push(`priority = $${params.length}`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY sort_order ASC, created_at DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows, total: result.rowCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET single task
app.get('/api/tasks/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST create task
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description = '', priority = 'medium', deadline = null, assignees = '' } = req.body;
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required' });
    const result = await pool.query(
      'INSERT INTO tasks (title, description, priority, deadline, assignees) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title.trim(), description.trim(), priority, deadline || null, assignees]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT update task
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const { title, description, status, priority, deadline, assignees } = req.body;
    const fields = [];
    const params = [];
    if (title !== undefined)       { params.push(title);            fields.push(`title = $${params.length}`); }
    if (description !== undefined) { params.push(description);      fields.push(`description = $${params.length}`); }
    if (status !== undefined)      { params.push(status);           fields.push(`status = $${params.length}`); }
    if (priority !== undefined)    { params.push(priority);         fields.push(`priority = $${params.length}`); }
    if (deadline !== undefined)    { params.push(deadline || null); fields.push(`deadline = $${params.length}`); }
    if (assignees !== undefined)   { params.push(assignees);        fields.push(`assignees = $${params.length}`); }
    if (!fields.length) return res.status(400).json({ success: false, message: 'No fields to update' });
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH reorder (drag & drop)
app.patch('/api/tasks/reorder', async (req, res) => {
  try {
    const { ids } = req.body;
    for (let i = 0; i < ids.length; i++) {
      await pool.query('UPDATE tasks SET sort_order = $1 WHERE id = $2', [i, ids[i]]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE task
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, message: 'Task deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), db: 'postgresql' }));

initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`)))
  .catch(err => { console.error('❌ DB init failed:', err.message); process.exit(1); });
