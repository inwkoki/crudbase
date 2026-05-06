# Taskflow

Shared workspace task manager built with **Node.js + PostgreSQL + Vanilla JS**

**Live demo:** `https://crudbase.onrender.com`

---

## Features

- **Eisenhower Matrix** — 4-quadrant task view (Do First / Schedule / Delegate / Eliminate)
- **Auth** — Username + Password login, PIN-based password recovery
- **Shared workspace** — all members see the same tasks
- **Assignees dropdown** — select from registered users
- **Avatars** — upload profile pictures per user
- **Calendar** — Month / Week / Year views with deadline dots
- **Google Calendar** — one-click export per task
- **Drag & drop** — reorder tasks within quadrants
- **Pie chart** — progress score dashboard
- **DB pause detection** — popup with Supabase resume link

---

## Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js, Express |
| Database | PostgreSQL (Supabase free tier) |
| Auth | bcrypt + JWT cookie |
| Frontend | Vanilla JS, Chart.js |
| Hosting | Render (free tier) |

---

## Project Structure

```
├── server.js           ← Express REST API + Auth middleware
├── package.json
└── public/
    ├── login.html      ← Sign in / Register / Forgot password
    └── index.html      ← Main app (protected)
```

---

## Local Setup

```bash
npm install

# Set environment variables
export DATABASE_URL="postgresql://..."
export JWT_SECRET="your-random-secret-min-32-chars"

npm start
# → http://localhost:3000
```

---

## Deploy on Render

### 1. Supabase (Database)

1. Go to [supabase.com](https://supabase.com) → New Project
2. **Settings → Database → Connection Pooler** → copy URI (port 6543)
3. Replace `[YOUR-PASSWORD]` with your DB password

Tables are created automatically on first server start.

### 2. Render (Hosting)

1. Push code to GitHub (files must be at repo root, not in subfolder)
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect GitHub repo, set:

| Field | Value |
|-------|-------|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Plan | Free |

4. **Environment Variables:**

```
DATABASE_URL  = postgresql://postgres.xxxxx:password@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true
JWT_SECRET    = your-random-secret-string-at-least-32-characters
```

5. Deploy → done ✅

---

## API Endpoints

### Auth (public)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| POST | `/api/auth/verify-pin` | Verify PIN for password reset |
| POST | `/api/auth/reset-password` | Set new password |
| GET | `/api/auth/me` | Get current user |

### Tasks (requires login)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List all tasks |
| POST | `/api/tasks` | Create task |
| PUT | `/api/tasks/:id` | Update task |
| PATCH | `/api/tasks/reorder` | Reorder tasks (drag & drop) |
| DELETE | `/api/tasks/:id` | Delete task |

### Users & Avatars (requires login)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users` | List all users (for assignees) |
| GET | `/api/avatars` | Get all avatars |
| POST | `/api/avatars` | Upload avatar |
| DELETE | `/api/avatars/:name` | Remove avatar |

---

## Password Recovery Flow

1. Go to **Forgot** tab on login page
2. Enter username
3. Enter PIN (4–6 digits set during registration)
4. Set new password

PIN is stored as bcrypt hash — cannot be recovered, only verified.

---

## Free Tier Limits

| Service | Free Limit | Notes |
|---------|-----------|-------|
| Render | 750 hrs/month | Sleeps after 15 min idle (~30s wake time) |
| Supabase | 500 MB, 50k rows | Pauses after 7 days inactive |
| Both | No credit card required | — |

---

## Supabase DB Paused?

If the app shows a "Database is paused" popup:

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Select your project
3. Click **Resume**
4. Wait ~30 seconds, then click Retry in the app
