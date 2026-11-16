const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('seeker','company','admin')),
  name TEXT NOT NULL,
  company_name TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT,
  skills TEXT,
  experience TEXT,
  education TEXT,
  attachment_name TEXT,
  attachment_path TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  requirements TEXT,
  location TEXT,
  salary_min INTEGER,
  salary_max INTEGER,
  education TEXT,
  experience TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id INTEGER NOT NULL REFERENCES resumes(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  seeker_id INTEGER NOT NULL REFERENCES users(id),
  company_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'submitted',
  match_score INTEGER,
  match_reasons TEXT,
  meeting_link TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS contact_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER REFERENCES jobs(id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

const crypto = require('crypto');

function hashPassword(pwd) {
  return crypto.scryptSync(pwd, 'add-work-salt', 32).toString('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function seed() {
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    db.prepare(
      `INSERT INTO users (username, password, role, name, status) VALUES (?, ?, 'admin', ?, 'active')`
    ).run('admin', hashPassword('root123456'), '系统管理员');
  }

  const companyCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='company'").get().c;
  if (companyCount === 0) {
    db.prepare(
      `INSERT INTO users (username, password, role, name, company_name, phone, status) VALUES (?,?,'company',?,?,?,'active')`
    ).run('techco', hashPassword('123456'), '张经理', '星辰科技有限公司', '13800000001');
  }

  const seekerCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='seeker'").get().c;
  if (seekerCount === 0) {
    db.prepare(
      `INSERT INTO users (username, password, role, name, phone, status) VALUES (?,?,'seeker',?,?,'active')`
    ).run('lilei', hashPassword('123456'), '李雷', '13900000001');
  }

  const jobCount = db.prepare('SELECT COUNT(*) c FROM jobs').get().c;
  if (jobCount === 0) {
    const techco = db.prepare("SELECT id FROM users WHERE username='techco'").get();
    db.prepare(
      `INSERT INTO jobs (company_id, title, requirements, location, salary_min, salary_max, education, experience, status)
       VALUES (?, '前端开发工程师', 'JavaScript,React,Vue,前端工程化', '上海', 15000, 25000, '本科', '3-5年', 'published')`
    ).run(techco.id);
    db.prepare(
      `INSERT INTO jobs (company_id, title, requirements, location, salary_min, salary_max, education, experience, status)
       VALUES (?, '后端开发工程师', 'Node.js,Python,Java,数据库,接口设计', '北京', 18000, 30000, '本科', '3-5年', 'published')`
    ).run(techco.id);
  }

  const resumeCount = db.prepare('SELECT COUNT(*) c FROM resumes').get().c;
  if (resumeCount === 0) {
    const lilei = db.prepare("SELECT id FROM users WHERE username='lilei'").get();
    db.prepare(
      `INSERT INTO resumes (user_id, name, skills, experience, education) VALUES (?, ?, ?, ?, ?)`
    ).run(lilei.id, '李雷', 'JavaScript,React,Vue', '5年前端开发经验', '本科');
  }
}

seed();

module.exports = { db, hashPassword, newToken };
