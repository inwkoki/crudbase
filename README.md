# Taskflow — CRUD App (PostgreSQL)

Full-stack CRUD app: **Express.js** + **PostgreSQL (Supabase)** + **Vanilla JS**

## 📁 Structure

```
├── server.js          ← Express REST API + PostgreSQL
├── package.json
└── public/
    └── index.html     ← Frontend
```

## 🚀 Run Locally

```bash
npm install

# ตั้ง environment variable
export DATABASE_URL="postgresql://postgres:[password]@[host]/postgres"

npm start
```

## 🌐 Deploy บน Render

### 1. สร้าง DB ที่ Supabase
1. ไปที่ [supabase.com](https://supabase.com) → New Project
2. ไปที่ **Settings → Database → Connection String (URI)**
3. Copy connection string

### 2. Deploy บน Render
1. Push โค้ดขึ้น GitHub (ไฟล์ต้องอยู่ที่ root ไม่ใช่ใน subfolder)
2. ไปที่ [render.com](https://render.com) → New → Web Service
3. ตั้งค่า:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. ไปที่ **Environment** → Add:
   ```
   DATABASE_URL = postgresql://postgres:[password]@[host]/postgres
   ```
5. Deploy!

> ตารางจะถูกสร้างอัตโนมัติตอน server เริ่มครั้งแรก ไม่ต้องรัน SQL เอง

## 📡 API

| Method | Endpoint | Body |
|--------|----------|------|
| GET | `/api/tasks` | — |
| GET | `/api/tasks/:id` | — |
| POST | `/api/tasks` | `{ title, description?, priority? }` |
| PUT | `/api/tasks/:id` | `{ title?, description?, status?, priority? }` |
| DELETE | `/api/tasks/:id` | — |
| GET | `/health` | — |
