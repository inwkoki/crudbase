const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// สร้างตารางถ้ายังไม่มี (รันตอน server เริ่ม)
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'todo' CHECK (status IN ('todo','in-progress','done')),
      priority TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Database ready');
}

// ── Routes ─────────────────────────────────────────────────

// GET all tasks (with optional filter)
app.get('/api/tasks', async (req, res) => {
  try {
    const { status, priority } = req.query;
    let query = 'SELECT * FROM tasks';
    const params = [];
    const conditions = [];

    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (priority) { params.push(priority); conditions.push(`priority = $${params.length}`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY created_at DESC';

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
    const { title, description = '', priority = 'medium' } = req.body;
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required' });

    const result = await pool.query(
      'INSERT INTO tasks (title, description, priority) VALUES ($1, $2, $3) RETURNING *',
      [title.trim(), description.trim(), priority]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT update task
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const { title, description, status, priority } = req.body;

    // Build dynamic SET clause
    const fields = [];
    const params = [];
    if (title !== undefined)       { params.push(title);       fields.push(`title = $${params.length}`); }
    if (description !== undefined) { params.push(description); fields.push(`description = $${params.length}`); }
    if (status !== undefined)      { params.push(status);      fields.push(`status = $${params.length}`); }
    if (priority !== undefined)    { params.push(priority);    fields.push(`priority = $${params.length}`); }

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

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), db: 'postgresql' }));

// ── Start ──────────────────────────────────────────────────
initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`)))
  .catch(err => { console.error('❌ DB init failed:', err.message); process.exit(1); });
