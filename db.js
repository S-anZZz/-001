const mysql = require('mysql2/promise');
const crypto = require('crypto');

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'addwork',
  password: process.env.DB_PASSWORD || 'AddWork@2026',
  database: process.env.DB_NAME || 'add_work',
  connectionLimit: 10,
  charset: 'utf8mb4'
};

const pool = mysql.createPool(DB_CONFIG);

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(16) NOT NULL,
      name VARCHAR(64) NOT NULL,
      company_name VARCHAR(128),
      phone VARCHAR(32),
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      token VARCHAR(128),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS resumes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(64),
      skills TEXT,
      experience TEXT,
      education VARCHAR(32),
      attachment_name VARCHAR(255),
      attachment_path VARCHAR(255),
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_resume_user (user_id)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL,
      title VARCHAR(128) NOT NULL,
      requirements TEXT,
      location VARCHAR(64),
      salary_min INT,
      salary_max INT,
      education VARCHAR(32),
      experience VARCHAR(32),
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_job_company (company_id),
      KEY idx_job_status (status)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      resume_id INT NOT NULL,
      job_id INT NOT NULL,
      seeker_id INT NOT NULL,
      company_id INT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'submitted',
      match_score INT,
      match_reasons TEXT,
      meeting_link VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_app_resume (resume_id),
      KEY idx_app_job (job_id)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      from_user_id INT NOT NULL,
      to_user_id INT NOT NULL,
      job_id INT,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      type VARCHAR(32) NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

  await seed();
}

function hashPassword(pwd) {
  return crypto.scryptSync(pwd, 'add-work-salt', 32).toString('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}
async function seed() {
  const [admins] = await pool.query("SELECT id FROM users WHERE username = ?", ['admin']);
  if (!admins.length) {
    await pool.query(
      "INSERT INTO users (username, password, role, name, status) VALUES (?, ?, 'admin', ?, 'active')",
      ['admin', hashPassword('root123456'), '系统管理员']
    );
  }

  const [companies] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE role = 'company'");
  if (!companies[0].c) {
    await pool.query(
      `INSERT INTO users (username, password, role, name, company_name, phone, status)
       VALUES (?, ?, 'company', ?, ?, ?, 'active')`,
      ['techco', hashPassword('123456'), '张经理', '星辰科技有限公司', '13800000001']
    );
  }

  const [seekers] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE role = 'seeker'");
  if (!seekers[0].c) {
    await pool.query(
      `INSERT INTO users (username, password, role, name, phone, status)
       VALUES (?, ?, 'seeker', ?, ?, 'active')`,
      ['lilei', hashPassword('123456'), '李雷', '13900000001']
    );
  }

  const [jobs] = await pool.query('SELECT COUNT(*) AS c FROM jobs');
  if (!jobs[0].c) {
    const [tc] = await pool.query("SELECT id FROM users WHERE username = 'techco'");
    const companyId = tc[0].id;
    await pool.query(
      `INSERT INTO jobs (company_id, title, requirements, location, salary_min, salary_max, education, experience, status)
       VALUES (?, '前端开发工程师', 'JavaScript,React,Vue,前端工程化', '上海', 15000, 25000, '本科', '3-5年', 'published')`,
      [companyId]
    );
    await pool.query(
      `INSERT INTO jobs (company_id, title, requirements, location, salary_min, salary_max, education, experience, status)
       VALUES (?, '后端开发工程师', 'Node.js,Python,Java,数据库,接口设计', '北京', 18000, 30000, '本科', '3-5年', 'published')`,
      [companyId]
    );
  }

  const [resume] = await pool.query('SELECT COUNT(*) AS c FROM resumes');
  if (!resume[0].c) {
    const [li] = await pool.query("SELECT id FROM users WHERE username = 'lilei'");
    await pool.query(
      `INSERT INTO resumes (user_id, name, skills, experience, education)
       VALUES (?, ?, ?, ?, ?)`,
      [li[0].id, '李雷', 'JavaScript,React,Vue', '5年前端开发经验', '本科']
    );
  }
}

module.exports = { pool, init, hashPassword, newToken };
