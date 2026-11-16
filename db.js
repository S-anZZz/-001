// db.js：MySQL 数据库连接与建表、初始化种子数据
const mysql = require('mysql2/promise'); // mysql2 异步驱动，提供 Promise 版查询接口
const crypto = require('crypto'); // 加密工具，用于生成密码哈希与登录令牌

// 是否启用 TLS：云数据库（TiDB Cloud 等）要求加密连接，本地 MySQL 默认关闭
const DB_SSL = String(process.env.DB_SSL || '').toLowerCase() === 'true';

// 数据库连接配置，默认使用 AGENTS.md 指定的 root 账号
const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1', // 主机地址，默认本机
  port: Number(process.env.DB_PORT || 3306), // 端口，默认 3306
  user: process.env.DB_USER || 'root', // 用户名，默认 root
  password: process.env.DB_PASSWORD || '808080', // 密码，默认 808080
  database: process.env.DB_NAME || 'add_work', // 数据库名，默认 add_work
  connectionLimit: 10, // 连接池最大连接数
  charset: 'utf8mb4' // 字符集，支持中文
};

// 需要加密时补充 ssl 选项，最低 TLS 1.2（TiDB Cloud 只接受 1.2 / 1.3）
if (DB_SSL) DB_CONFIG.ssl = { minVersion: 'TLSv1.2' };

// 创建 MySQL 连接池，供所有路由复用（连接是懒建立的，此时不会真正联网）
const pool = mysql.createPool(DB_CONFIG);

// ensureDatabase：连接时先不指定库名，确认目标库存在，不存在就建
// 云数据库首次使用时通常只有 test 库，这一步省去手工建库
async function ensureDatabase() {
  const { database, ...bareConfig } = DB_CONFIG; // 去掉 database 字段，先连到服务器而非具体库
  const conn = await mysql.createConnection(bareConfig); // 建立一条临时连接
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci` // 建库语句，存在则跳过
    );
  } finally {
    await conn.end(); // 无论成功与否都关闭这条临时连接
  }
}

// 初始化函数：建库、建表并写入演示数据
async function init() {
  await ensureDatabase(); // 先确保目标数据库存在，否则后续建表会失败

  // users 表：用户表，区分求职者/企业/管理员三种角色
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
      avatar_path VARCHAR(255),
      license_path VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

  // resumes 表：简历表，存放技能标签、经历与附件
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

  // jobs 表：职位表，企业发布职位
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

  // applications 表：投递表，记录投递与匹配分
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

  // contact_requests 表：联系方式交换请求
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      from_user_id INT NOT NULL,
      to_user_id INT NOT NULL,
      job_id INT,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

  // notifications 表：系统通知，如投递动态、面试邀约、审核结果
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      type VARCHAR(32) NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

  // files 表：上传文件表，存头像与简历附件（FILE_STORAGE=db 时使用，避免实例重启丢文件）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      name VARCHAR(255) PRIMARY KEY,
      mime VARCHAR(128),
      size INT,
      data LONGBLOB,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

  // 兼容旧库：若 users 表缺少头像字段，则补充
  await ensureColumn('users', 'avatar_path', "ADD COLUMN avatar_path VARCHAR(255)");
  // 兼容旧库：若 users 表缺少经营许可证字段，则补充
  await ensureColumn('users', 'license_path', "ADD COLUMN license_path VARCHAR(255)");

  await seed(); // 写入演示数据
}

// ensureColumn：检查列是否存在，不存在则执行 ALTER 语句（用于增量升级旧表）
async function ensureColumn(table, column, ddl) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (!rows[0].c) await pool.query(`ALTER TABLE ${table} ${ddl}`);
}

// hashPassword：使用 scrypt 加盐哈希密码，避免明文存储
function hashPassword(pwd) {
  return crypto.scryptSync(pwd, 'add-work-salt', 32).toString('hex');
}

// newToken：生成随机登录令牌，用于登录态校验
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}
// seed：写入管理员、演示企业、演示求职者、演示职位与简历
async function seed() {
  // 管理员账号：admin / root123456
  const [admins] = await pool.query('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!admins.length) {
    await pool.query(
      "INSERT INTO users (username, password, role, name, status) VALUES (?, ?, 'admin', ?, 'active')",
      ['admin', hashPassword('root123456'), '系统管理员']
    );
  }

  // 演示企业：techco / 123456
  const [companies] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE role = 'company'");
  if (!companies[0].c) {
    await pool.query(
      `INSERT INTO users (username, password, role, name, company_name, phone, status)
       VALUES (?, ?, 'company', ?, ?, ?, 'active')`,
      ['techco', hashPassword('123456'), '张经理', '星辰科技有限公司', '13800000001']
    );
  }

  // 演示求职者：lilei / 123456
  const [seekers] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE role = 'seeker'");
  if (!seekers[0].c) {
    await pool.query(
      `INSERT INTO users (username, password, role, name, phone, status)
       VALUES (?, ?, 'seeker', ?, ?, 'active')`,
      ['lilei', hashPassword('123456'), '李雷', '13900000001']
    );
  }

  // 演示职位：前端开发工程师（上海）、后端开发工程师（北京）
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

  // 演示简历：李雷的前端简历
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

// 导出连接池与工具函数，供 server.js 使用
module.exports = { pool, init, hashPassword, newToken };
