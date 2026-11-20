/**
 * server.js —— 后端入口文件
 *
 * 职责说明（按执行顺序）：
 *   1. 加载依赖与环境变量，创建 Express 应用；
 *   2. 注册全局中间件：请求体解析、安全响应头、操作日志；
 *   3. 定义工具函数：统一响应 send()、错误兜底 wrap()、鉴权 requireAuth()；
 *   4. 挂载全部 REST 路由：账号、简历、职位、投递、面试、消息、收藏、
 *      企业资料与人才库、推荐、管理端统计与导出、文件上传与下载；
 *   5. 启动时先初始化数据库（建表 + 种子数据），成功后再监听端口。
 *
 * 路由分组索引（搜索关键字即可定位）：
 *   【账号】  /api/register /api/login /api/logout /api/me /api/auth/*
 *   【简历】  /api/resumes*            —— 多份简历、默认简历、开放度、历史
 *   【职位】  /api/jobs*               —— 发布/编辑/上下架/刷新/置顶/急招/详情/相似
 *   【投递】  /api/jobs/:id/apply /api/applications*
 *   【面试】  /api/interviews*         —— 邀约、确认、改约、拒绝
 *   【消息】  /api/messages* /api/messages/threads
 *   【收藏关注】 /api/favorites* /api/follows*
 *   【联系】  /api/contact/requests*
 *   【企业】  /api/company/* /api/talent /api/recommend/talent
 *   【推荐】  /api/recommend/jobs /api/jobs/:id/similar
 *   【管理】  /api/admin/*             —— 看板、日志、企业审核、用户状态、CSV 导出
 *   【文件】  POST /api/files/* 上传，GET /uploads/:file 下载（需登录）
 *   【运维】  GET /healthz             —— 健康检查（数据库连通性 + 运行时长）
 */

const express = require('express');
const path = require('path');
const { pool, init, hashPassword, verifyPassword, needsRehash, newToken } = require('./db');
const { putFile, getFile, MODE: FILE_MODE } = require('./storage');
const { matchScore } = require('./match');
const { createMeeting } = require('./meeting');

const app = express();
const PORT = process.env.PORT || 3000;

// 安全响应头：禁止 MIME 嗅探、禁止被 iframe 嵌入、限制资源来源
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // PDF / 图片 / 文档等文件响应不能带 CSP，否则浏览器会认为内嵌插件被禁止，直接变成下载而不是预览
  const isFile = req.path.startsWith('/uploads/') || /^\/api\/applications\/\d+\/attachment$/.test(req.path) ||
    /\.(pdf|png|jpe?g|gif|webp|docx?|xlsx?|zip)$/i.test(req.path);
  if (!isFile) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // 允许同源 iframe 预览
    // 前端大量使用内联 onclick，script-src 必须允许 'unsafe-inline'，否则按钮全部失效
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'self'; frame-src 'self'; base-uri 'none'");
  }
  next();
});

// 操作日志：记录所有写操作，供管理员审计
app.use((req, res, next) => {
  if (!['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method) || !req.path.startsWith('/api/')) return next(); // 只记写操作
  res.on('finish', () => {
    pool.query(
      'INSERT INTO operation_logs (user_id, role, method, path, status, ip) VALUES (?,?,?,?,?,?)',
      [req.user ? req.user.id : null, req.user ? req.user.role : null, req.method, req.path, res.statusCode,
       (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 60)]
    ).catch(() => {}); // 日志失败不影响主流程
  });
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 上传文件名的白名单字符：不允许出现 / \ .. 等可用于目录穿越的字符
const SAFE_FILE = /^[A-Za-z0-9._\-\u4e00-\u9fa5]+$/;

async function canReadFile(user, file) {
  if (user.role === 'admin') return true;
  const [owners] = await pool.query(
    'SELECT id, avatar_path, license_path FROM users WHERE avatar_path = ? OR license_path = ?', [file, file]
  );
  if (owners.some((owner) => owner.id === user.id)) return true;
  if (owners.some((owner) => owner.license_path === file)) return false;
  if (owners.some((owner) => owner.avatar_path === file)) return true;
  const [resumes] = await pool.query(
    `SELECT r.user_id, r.visibility, u.status,
       EXISTS(SELECT 1 FROM applications a WHERE a.resume_id = r.id AND a.company_id = ?) AS applied
     FROM resumes r JOIN users u ON u.id = r.user_id WHERE r.attachment_path = ?`, [user.id, file]
  );
  return resumes.some((resume) => resume.user_id === user.id ||
    (user.role === 'company' && resume.status === 'active' &&
      (resume.visibility === 'public' || (resume.visibility === 'targeted' && resume.applied))));
}

function sendFile(res, file, buffer, download = false) {
  res.type(path.extname(file).toLowerCase() || 'bin');
  const asciiName = file.replace(/[^\x20-\x7E]/g, '_');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
}

app.get('/uploads/:file', requireAuth(), wrap(async (req, res) => {
  const file = String(req.params.file || '');
  if (!SAFE_FILE.test(file) || file.includes('..')) return send(res, false, '文件名不合法', 400);
  if (!(await canReadFile(req.user, file))) return send(res, false, '文件不存在或无权访问', 403);
  const buffer = await getFile(file);
  if (!buffer) return send(res, false, '文件不存在', 404);
  sendFile(res, file, buffer);
}));

// BizError：可安全回显给前端的业务异常
class BizError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// send：统一响应，可指定 HTTP 状态码（400 参数错误 / 401 未登录 / 403 无权限 / 500 服务器错误）
function send(res, ok, data, status) {
  res.status(status || (ok ? 200 : 400)).json({ ok, data });
}

// wrap：捕获异步异常；业务异常原样回显，系统异常只记日志并返回通用文案
function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (err && (err.status || err instanceof BizError)) {
        return send(res, false, err.message, err.status || 400); // 业务异常，允许回显
      }
      console.error('[server-error]', req.method, req.originalUrl, err && err.message); // 细节只进服务端日志
      send(res, false, '服务器内部错误，请稍后重试', 500); // 不向前端暴露内部错误
    });
  };
}

// parseCookies：解析 Cookie 头，取出会话令牌
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

// sessionUser：按会话令牌取用户，并校验会话未过期、账号仍为可用状态
async function sessionUser(token) {
  if (!token) return null;
  const [rows] = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > NOW()`,
    [token]
  ); // 联表查询会话与用户
  const user = rows[0];
  if (!user) return null; // 会话不存在或已过期
  if (user.status !== 'active') return null; // 账号被停用/待审核时，旧令牌立即失效
  return user;
}

// currentUser：优先取 Authorization 头，其次取 HttpOnly Cookie
async function currentUser(req) {
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const cookie = parseCookies(req).sid || '';
  return sessionUser(header || cookie);
}

// requireAuth：校验登录态与角色，未登录返回 401，越权返回 403
function requireAuth(roles) {
  return wrap(async (req, res, next) => {
    const user = await currentUser(req);
    if (!user) return send(res, false, '请先登录', 401);
    if (roles && !roles.includes(user.role)) return send(res, false, '无权限访问', 403);
    req.user = user;
    next();
  });
}

// notify：写入一条站内通知（面试、审核、投递状态等统一走这里）
async function notify(userId, type, message, db = pool) {
  await db.query('INSERT INTO notifications (user_id, type, message) VALUES (?,?,?)', [userId, type, message]);
}

async function transaction(fn) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const result = await fn(db);
    await db.commit();
    return result;
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

function futureTime(value) {
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    throw new BizError('请选择有效的未来面试时间');
  }
  return date;
}

// 各类上传的大小上限（字节）
const MAX_IMAGE = 2 * 1024 * 1024; // 头像 2MB
const MAX_DOC = 5 * 1024 * 1024; // 简历附件、许可证 5MB

// 文件头（魔数）校验：防止把 exe 等文件改名后上传
function magicOk(buffer, ext) {
  const b = buffer;
  const startsWith = (bytes) => bytes.every((v, i) => b[i] === v); // 逐字节比对
  if (ext === 'pdf') return startsWith([0x25, 0x50, 0x44, 0x46]); // %PDF
  if (ext === 'png') return startsWith([0x89, 0x50, 0x4e, 0x47]); // PNG
  if (ext === 'jpg' || ext === 'jpeg') return startsWith([0xff, 0xd8, 0xff]); // JPEG
  if (ext === 'gif') return startsWith([0x47, 0x49, 0x46, 0x38]); // GIF8
  if (ext === 'webp') return startsWith([0x52, 0x49, 0x46, 0x46]) && b.slice(8, 12).toString() === 'WEBP'; // RIFF....WEBP
  if (ext === 'docx') return startsWith([0x50, 0x4b, 0x03, 0x04]); // ZIP 头
  if (ext === 'doc') return startsWith([0xd0, 0xcf, 0x11, 0xe0]); // OLE 复合文档
  return false; // 未知类型一律拒绝
}

// saveBase64：校验扩展名、大小与文件头后写入存储层
async function saveBase64(name, base64, allowed, maxBytes, label, prefix) {
  if (!name) return null; // 未选择文件则跳过
  const ext = (name.split('.').pop() || '').toLowerCase(); // 取扩展名
  if (!allowed.includes(ext)) throw new BizError(`${label}格式不支持`, 400); // 扩展名白名单
  let buffer;
  try { buffer = Buffer.from(String(base64), 'base64'); } catch (e) { throw new BizError(`${label}内容无法解析`, 400); } // Base64 解码
  if (!buffer.length) throw new BizError(`${label}内容为空`, 400); // 空文件
  if (buffer.length > maxBytes) throw new BizError(`${label}不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`, 400); // 大小限制
  if (!magicOk(buffer, ext)) throw new BizError(`${label}内容与扩展名不符`, 400); // 文件头校验
  const safe = name.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_'); // 过滤非法文件名字符
  const file = `${newToken()}-${prefix}${safe.slice(-180)}`;
  return putFile(file, buffer); // 写入存储层（磁盘或数据库）
}

// 允许上传的头像格式
const AVATAR_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

// saveImage：保存头像（≤2MB，校验文件头）
function saveImage(name, base64) {
  return saveBase64(name, base64, AVATAR_EXT, MAX_IMAGE, '头像', '');
}

// 简历附件允许的格式：PDF 与 Word
const ALLOWED_EXT = ['pdf', 'doc', 'docx'];

// saveAttachment：保存简历附件（≤5MB，校验文件头）
function saveAttachment(name, base64) {
  return saveBase64(name, base64, ALLOWED_EXT, MAX_DOC, '简历附件', '');
}

// 企业经营许可证允许的格式：PDF、Word 与图片
const LICENSE_EXT = ['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg'];

// saveLicense：保存经营许可证（≤5MB，校验文件头）
function saveLicense(name, base64) {
  return saveBase64(name, base64, LICENSE_EXT, MAX_DOC, '经营许可证', 'license-');
}

// POST /api/register：注册（求职者直接可用，企业需管理员审核）
app.post('/api/register', wrap(async (req, res) => {
  // 解析注册参数：用户名、密码、角色、姓名、企业名、电话、头像、经营许可证
  const { username, password, role, name, companyName, phone, avatarName, avatarBase64, licenseName, licenseBase64 } = req.body || {};
  // 必填项校验：用户名、密码、姓名不能为空
  if (!username || !password || !name) return send(res, false, '用户名、密码、姓名必填');
  // 密码长度校验：4~8 位之间
  if (password.length < 4 || password.length > 8) return send(res, false, '密码需为 4~8 位');
  // 弱口令拦截：避免 1234、abcd 这类几乎等于没有的密码
  const WEAK = ['1234', '123456', '0000', '1111', '6666', '8888', '4321', 'abcd', 'qwer', 'admin', 'root'];
  if (WEAK.includes(String(password).toLowerCase())) return send(res, false, '密码过于简单，请更换更复杂的密码');
  // 角色校验：只允许求职者或企业
  if (!['seeker', 'company'].includes(role)) return send(res, false, '角色不合法');
  // 手机号改为可选：填了才校验格式与唯一性（用于后续找回密码）
  const phoneVal = String(phone || '').trim();
  if (phoneVal && !/^1\d{10}$/.test(phoneVal)) return send(res, false, '手机号格式不正确');
  if (phoneVal) {
    const [phoneDup] = await pool.query('SELECT id FROM users WHERE phone = ?', [phoneVal]); // 手机号唯一
    if (phoneDup.length) return send(res, false, '该手机号已被使用'); // 重复提示
  }
  // 企业注册必须填写企业名称，否则无法区分招聘主体
  if (role === 'company' && !String(companyName || '').trim()) return send(res, false, '请填写企业名称');
  // 查询用户名是否已存在
  const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
  if (rows.length) return send(res, false, '用户名已存在');
  // 企业注册需管理员审核，求职者注册后直接可用
  const status = role === 'company' ? 'pending' : 'active';
  // 保存头像（可选）
  let avatarPath = null;
  if (avatarBase64) {
    try {
      avatarPath = await saveImage(avatarName, avatarBase64); // 等待头像写入存储层完成
    } catch (e) {
      return send(res, false, e.message);
    }
  }
  // 保存企业经营许可证（可选，仅企业角色）
  let licensePath = null;
  if (role === 'company' && licenseBase64) {
    try {
      licensePath = await saveLicense(licenseName, licenseBase64); // 等待许可证写入存储层完成
    } catch (e) {
      return send(res, false, e.message);
    }
  }
  // 插入用户记录
  const [info] = await pool.query(
    `INSERT INTO users (username, password, role, name, company_name, phone, status, avatar_path, license_path)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [username, hashPassword(password), role, name, companyName || null, phoneVal || null, status, avatarPath, licensePath]
  );
  // 查询新用户信息返回给前端
  const [users] = await pool.query(
    'SELECT id, username, role, name, company_name, phone, status, avatar_path, license_path FROM users WHERE id = ?',
    [info.insertId]
  );
  // 返回注册结果提示：企业需要等待管理员审核，求职者可直接登录
  send(res, true, { user: users[0], message: role === 'company' ? '注册成功，请等待管理员审核' : '注册成功，请登录' });
}));

// 登录失败计数：同一用户名 5 分钟内失败 5 次后临时锁定，防止暴力破解
const loginFails = new Map();
const LOGIN_WINDOW = 5 * 60 * 1000; // 统计窗口 5 分钟
const LOGIN_MAX = 5; // 允许的最大失败次数

// POST /api/login：登录，校验密码后创建会话并下发 Cookie
app.post('/api/login', wrap(async (req, res) => {
  // 登录接口：校验用户名密码并签发登录令牌
  const { username, password } = req.body || {}; // 解析登录参数
  const key = String(username || '').toLowerCase(); // 归一化用户名，作为计数键
  const rec = loginFails.get(key); // 取出该用户名的失败记录
  if (rec && rec.count >= LOGIN_MAX && Date.now() - rec.first < LOGIN_WINDOW) {
    return send(res, false, '密码错误次数过多，请 5 分钟后再试'); // 触发锁定
  }
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username || '']); // 按用户名查询用户
  const user = rows[0]; // 取查询结果
  if (!user || !verifyPassword(password || '', user.password)) { // 校验密码（兼容旧哈希）
    const now = Date.now();
    loginFails.set(key, rec && now - rec.first < LOGIN_WINDOW ? { first: rec.first, count: rec.count + 1 } : { first: now, count: 1 }); // 累计失败次数
    return send(res, false, '用户名或密码错误');
  }
  loginFails.delete(key); // 登录成功清除失败记录
  if (user.status === 'pending') return send(res, false, '账号待管理员审核，暂不能登录');
  if (user.role === 'company' && user.status !== 'active' && user.reject_reason) {
    return send(res, false, `企业审核未通过：${user.reject_reason}。请联系管理员补交资料。`, 403);
  }
  if (user.status !== 'active') return send(res, false, '账号已被停用', 403);
  if (needsRehash(user.password)) { // 旧版固定盐哈希，登录成功后自动升级
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashPassword(password), user.id]);
  }
  const token = newToken(); // 生成登录令牌
  await pool.query(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))',
    [user.id, token]
  ); // 令牌写入会话表，7 天有效，多设备可并存
  res.cookie('sid', token, { // 同时写入 HttpOnly Cookie，前端脚本读不到
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    path: '/'
  });
  const { password: _p, password_hash: _ph, token: _t, token_expires_at: _e, license_path: _l, ...safe } = user; // 去掉敏感字段
  send(res, true, { user: safe, token }); // 返回用户信息与令牌
}));

// POST /api/logout：退出登录，删除当前会话记录
app.post('/api/logout', requireAuth(), wrap(async (req, res) => {
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); // 取请求头令牌
  const token = header || parseCookies(req).sid || ''; // 或取 Cookie 令牌
  if (token) await pool.query('DELETE FROM sessions WHERE token = ?', [token]); // 只注销当前会话，其他设备不受影响
  res.clearCookie('sid', { path: '/' }); // 清除 Cookie
  send(res, true, null); // 返回成功
}));

// GET /api/me：返回当前登录用户信息（前端刷新后恢复登录态）
app.get('/api/me', requireAuth(), wrap(async (req, res) => {
  const { password, token, token_expires_at, ...safe } = req.user; // 去掉敏感字段
  send(res, true, safe); // 返回当前用户信息
}));

// 获取当前求职者的简历
app.get('/api/resume/mine', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM resumes WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1', [req.user.id]); // 取主简历
  send(res, true, rows[0] || null); // 返回简历或 null
}));

// 保存/更新简历（含可选附件上传）
app.post('/api/resume', requireAuth(['seeker']), wrap(async (req, res) => {
  // 解析简历字段与附件信息
  const { name, skills, experience, education, attachmentName, attachmentBase64 } = req.body || {};
  let attachmentPath = null; // 附件保存路径
  if (attachmentBase64) { // 若上传了附件
    try {
      attachmentPath = await saveAttachment(attachmentName, attachmentBase64); // 等待附件写入存储层完成
    } catch (e) {
      return send(res, false, e.message); // 保存失败返回错误
    }
  }
  const [existing] = await pool.query('SELECT id FROM resumes WHERE user_id = ?', [req.user.id]); // 查询是否已有简历
  if (existing.length) { // 已有简历则更新
    await pool.query(
      `UPDATE resumes SET name=?, skills=?, experience=?, education=?,
       attachment_name=COALESCE(?, attachment_name),
       attachment_path=COALESCE(?, attachment_path) WHERE user_id=?`,
      [name, skills, experience, education, attachmentName || null, attachmentPath, req.user.id]
    );
  } else { // 没有简历则新建
    await pool.query(
      `INSERT INTO resumes (user_id, name, skills, experience, education, attachment_name, attachment_path)
       VALUES (?,?,?,?,?,?,?)`,
      [req.user.id, name, skills, experience, education, attachmentName || null, attachmentPath]
    );
  }
  send(res, true, '简历已保存'); // 返回保存成功
}));

// 搜索职位：支持关键词、地点、薪资、学历、经验筛选，仅返回已发布职位
app.get('/api/jobs', wrap(async (req, res) => {
  // 支持关键词、地点、薪资、学历、经验筛选，并分页返回
  const { keyword, location, minSalary, maxSalary, education, experience, sort } = req.query; // 解析筛选与排序条件
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.pageSize || 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    return send(res, false, '分页参数不合法');
  }
  if (sort && !['latest', 'salaryAsc', 'salaryDesc', 'match'].includes(sort)) return send(res, false, '排序方式不合法');
  for (const value of [minSalary, maxSalary]) {
    if (value !== undefined && value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      return send(res, false, '薪资筛选条件不合法');
    }
  }
  const viewer = sort === 'match' ? await currentUser(req) : null;
  const where = []; // 动态条件集合
  const args = []; // 条件参数集合
  if (keyword) { where.push('(j.title LIKE ? OR j.requirements LIKE ?)'); args.push(`%${keyword}%`, `%${keyword}%`); } // 关键词匹配职位或要求
  if (location) { where.push('j.location = ?'); args.push(location); } // 按地点筛选
  if (minSalary) { where.push('j.salary_max >= ?'); args.push(+minSalary); } // 期望下限：职位上限不低于期望
  if (maxSalary) { where.push('j.salary_min <= ?'); args.push(+maxSalary); } // 期望上限：职位下限不高于期望，形成区间重叠
  if (education) { where.push('j.education = ?'); args.push(education); } // 按学历筛选
  if (experience) { where.push('j.experience = ?'); args.push(experience); } // 按经验筛选
  const base = `FROM jobs j JOIN users u ON u.id = j.company_id WHERE j.status = 'published' AND u.status = 'active' AND u.role = 'company'`
    + (where.length ? ' AND ' + where.join(' AND ') : ''); // 公共 FROM 与 WHERE
  const [countRows] = await pool.query(`SELECT COUNT(*) AS total ${base}`, args); // 统计总数用于分页
  const total = countRows[0].total; // 总条数
  if (sort === 'match' && viewer && viewer.role === 'seeker') {
    const [resumes] = await pool.query('SELECT * FROM resumes WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1', [viewer.id]);
    const resume = resumes[0];
    if (resume) {
      const [all] = await pool.query(
        `SELECT j.*, u.company_name AS company, u.verified ${base} ORDER BY j.is_top DESC, j.id DESC`, args
      ); // 先取候选集
      const scored = all.map((j) => ({ ...j, match: matchScore(resume, j) })) // 计算匹配度
        .sort((a, b) => (b.is_top - a.is_top) || (b.match.score - a.match.score)); // 置顶优先，其次匹配度
      const slice = scored.slice((page - 1) * pageSize, page * pageSize); // 分页
      return send(res, true, { list: slice, total: scored.length, page, pageSize, pages: Math.max(1, Math.ceil(scored.length / pageSize)) });
    }
  }
  const order = {
    salaryAsc: 'j.salary_min IS NULL, j.salary_min ASC, j.id DESC',
    salaryDesc: 'j.salary_max IS NULL, j.salary_max DESC, j.id DESC'
  }[sort] || 'COALESCE(j.refreshed_at, j.created_at) DESC, j.id DESC';
  const [rows] = await pool.query(
    `SELECT j.*, u.company_name AS company, u.verified,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS apply_count
     ${base} ORDER BY j.is_top DESC, ${order} LIMIT ? OFFSET ?`,
    [...args, pageSize, (page - 1) * pageSize]
  ); // 分页查询当前页数据（置顶优先、刷新时间排序）
  send(res, true, { list: rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) }); // 返回列表与分页信息
}));

// GET /api/jobs/mine：企业查询自己发布的全部职位
app.get('/api/jobs/mine', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT j.*, (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS apply_count
     FROM jobs j WHERE j.company_id = ? ORDER BY j.id DESC LIMIT 200`, [req.user.id]
  );
  send(res, true, rows); // 返回职位列表
}));

// 企业端：发布新职位，直接进入职位库（按最新需求，发布无需管理员审核）
// GET /api/jobs/:id：职位详情（浏览数 +1）
app.get('/api/jobs/:id', wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return send(res, false, '职位不存在'); // 只接受数字 ID
  const [rows] = await pool.query(
    `SELECT j.*, u.company_name AS company, u.verified, u.company_intro, u.company_size, u.company_industry
     FROM jobs j JOIN users u ON u.id = j.company_id
     WHERE j.id = ? AND j.status = 'published' AND u.status = 'active' AND u.role = 'company'`, [req.params.id]
  );
  if (!rows.length) return send(res, false, '职位不存在'); // 不存在直接返回
  await pool.query('UPDATE jobs SET view_count = view_count + 1 WHERE id = ?', [req.params.id]); // 浏览数累加
  send(res, true, rows[0]); // 返回详情
}));

// POST /api/jobs：企业发布职位（含敏感词校验与类型/福利字段）
app.post('/api/jobs', requireAuth(['company']), wrap(async (req, res) => {
  const { title, requirements, location, salaryMin, salaryMax, education, experience,
    jobType, benefits } = req.body || {}; // 解析职位参数
  if (!title) return send(res, false, '职位标题必填'); // 标题必填校验
  const banned = hasBannedWord(title + ' ' + (requirements || '') + ' ' + (benefits || '')); // 敏感词检查
  if (banned) return send(res, false, `内容包含违规词「${banned}」，请修改后再发布`); // 命中则拒绝
  if (salaryMin && salaryMax && Number(salaryMin) > Number(salaryMax)) return send(res, false, '最低薪资不能高于最高薪资'); // 薪资区间校验
  const [info] = await pool.query(
    `INSERT INTO jobs (company_id, title, requirements, location, salary_min, salary_max, education, experience,
       job_type, benefits, status)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'published')`,
    [req.user.id, title, requirements || '', location || '', salaryMin || null, salaryMax || null, education || '', experience || '',
     ['fulltime', 'parttime', 'intern', 'remote'].includes(jobType) ? jobType : 'fulltime', String(benefits || '').slice(0, 255)]
  ); // 插入职位，状态直接为已发布
  send(res, true, { id: info.insertId, message: '职位已发布' }); // 返回提示
}));

// 企业端：编辑职位，修改后立即生效（无需重新审核）
app.patch('/api/jobs/:id', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]); // 查询职位
  const job = rows[0]; // 取职位
  if (!job || job.company_id !== req.user.id) return send(res, false, '职位不存在或无权限'); // 校验归属
  // 下架职位同样允许编辑，修改后可一键重新上架
  await pool.query('INSERT INTO job_history (job_id, actor_id, snapshot) VALUES (?,?,?)',
    [job.id, req.user.id, JSON.stringify(job)]); // 保存修改前快照
  const { title, requirements, location, salaryMin, salaryMax, education, experience,
    jobType, benefits } = req.body || {}; // 解析修改内容
  if (!title) return send(res, false, '职位标题必填'); // 标题必填
  const bannedEdit = hasBannedWord(title + ' ' + (requirements || '') + ' ' + (benefits || '')); // 敏感词检查
  if (bannedEdit) return send(res, false, `内容包含违规词「${bannedEdit}」，请修改后再保存`); // 命中则拒绝
  if (salaryMin && salaryMax && Number(salaryMin) > Number(salaryMax)) return send(res, false, '最低薪资不能高于最高薪资'); // 薪资区间校验
  await pool.query(
    `UPDATE jobs SET title=?, requirements=?, location=?, salary_min=?, salary_max=?, education=?, experience=?,
       job_type=?, benefits=? WHERE id=?`,
    [title, requirements || '', location || '', salaryMin || null, salaryMax || null, education || '', experience || '',
     ['fulltime', 'parttime', 'intern', 'remote'].includes(jobType) ? jobType : 'fulltime', String(benefits || '').slice(0, 255),
     req.params.id]
  ); // 更新职位内容，状态保持不变（下架职位改完再上架）
  send(res, true, '职位已更新'); // 返回提示
}));

// 企业端：下架职位
app.patch('/api/jobs/:id/unpublish', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]); // 查询职位
  const job = rows[0]; // 取职位
  if (!job || job.company_id !== req.user.id) return send(res, false, '职位不存在或无权限'); // 校验归属
  await pool.query("UPDATE jobs SET status='offline' WHERE id=?", [req.params.id]); // 置为已下架（统一使用 offline）
  send(res, true, '职位已下架'); // 返回提示
}));

// 求职者：投递职位，计算匹配分并生成匹配理由
app.post('/api/jobs/:id/apply', requireAuth(['seeker']), wrap(async (req, res) => {
  const [jobRows] = await pool.query(
    `SELECT j.* FROM jobs j JOIN users u ON u.id = j.company_id
     WHERE j.id = ? AND u.status = 'active' AND u.role = 'company'`, [req.params.id]
  );
  const job = jobRows[0];
  if (!job || job.status !== 'published') return send(res, false, '职位不存在、已下架或企业已停用'); // 校验职位状态
  let resume;
  if (req.body && req.body.resumeId) { // 指定了某一份简历
    const [rows] = await pool.query('SELECT * FROM resumes WHERE id = ? AND user_id = ?', [req.body.resumeId, req.user.id]);
    resume = rows[0];
  } else { // 未指定则使用主简历
    const [rows] = await pool.query('SELECT * FROM resumes WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1', [req.user.id]);
    resume = rows[0];
  }
  if (!resume) return send(res, false, '请先创建简历后再投递');
  if (resume.visibility === 'hidden') return send(res, false, '请先将简历设为公开或仅投递可见，再进行投递');
  const { score, reasons } = matchScore(resume, job); // 计算匹配分与理由
  // 原子 upsert：首次投递插入，重复投递在原记录上累加次数并刷新状态（唯一索引保证并发安全）
  await pool.query(
    `INSERT INTO applications (resume_id, job_id, seeker_id, company_id, status, match_score, match_reasons, apply_count, deleted)
     VALUES (?,?,?,?,'submitted',?,?,1,0)
     ON DUPLICATE KEY UPDATE resume_id = VALUES(resume_id), status = 'submitted', match_score = VALUES(match_score),
       match_reasons = VALUES(match_reasons), apply_count = applications.apply_count + 1, deleted = 0, updated_at = NOW()`,
    [resume.id, job.id, req.user.id, job.company_id, score, reasons]
  ); // 写入或累加
  const [saved] = await pool.query('SELECT id, apply_count FROM applications WHERE seeker_id = ? AND job_id = ?', [req.user.id, job.id]); // 读取最新记录
  const appId = saved[0].id; // 投递 ID
  const applyCount = Number(saved[0].apply_count); // 当前投递次数
  const firstTime = applyCount === 1; // 是否首次投递
  await notify(job.company_id, 'application',
    firstTime ? `收到新简历：${resume.name} 投递了「${job.title}」（匹配分 ${score}）`
              : `${resume.name} 再次投递了「${job.title}」（第 ${applyCount} 次，匹配分 ${score}）`); // 通知企业
  await pool.query(
    'INSERT INTO app_events (application_id, actor_id, action, detail) VALUES (?,?,?,?)',
    [appId, req.user.id, firstTime ? 'submitted' : 'resubmitted',
     firstTime ? `投递简历「${resume.title || '我的简历'}」，匹配分 ${score}` : `第 ${applyCount} 次投递，匹配分 ${score}`]
  ); // 记录轨迹
  send(res, true, { id: appId, score, reasons, applyCount });
}));

// 求职者：查看我的投递记录（关联职位与企业信息）
app.get('/api/applications/mine', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, j.title AS job_title, j.location, j.salary_min, j.salary_max,
            u.company_name AS company_name
     FROM applications a JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = a.company_id
     WHERE a.seeker_id = ? ORDER BY a.id DESC LIMIT 200`,
    [req.user.id]
  ); // 查询当前求职者的投递列表
  send(res, true, rows); // 返回投递记录
}));

// 企业端：查看收到的简历（关联候选人简历信息）
app.get('/api/applications/received', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, r.name AS candidate, r.skills, r.experience, r.education,
            r.attachment_name, r.attachment_path, r.visibility, u.status AS seeker_status,
            j.title AS job_title
     FROM applications a JOIN resumes r ON r.id = a.resume_id
     JOIN users u ON u.id = r.user_id JOIN jobs j ON j.id = a.job_id
     WHERE a.company_id = ? AND a.deleted = 0${['submitted','viewed','interview','accepted','rejected'].includes(String(req.query.status || '')) ? ' AND a.status = ?' : ''}
     ORDER BY a.id DESC LIMIT 200`,
    String(req.query.status || '') ? [req.user.id, String(req.query.status)] : [req.user.id]
  );
  for (const row of rows) {
    if (row.visibility === 'hidden' || row.seeker_status !== 'active') {
      row.candidate = '简历不可见';
      for (const key of ['skills', 'experience', 'education', 'attachment_name', 'attachment_path', 'match_reasons']) row[key] = null;
    }
  }
  if (FILE_MODE === 'db') { // 数据库存储模式：核对文件是否还在
    const names = rows.map((r) => r.attachment_path).filter(Boolean); // 取出附件名
    if (names.length) {
      const [files] = await pool.query(
        `SELECT name FROM files WHERE name IN (${names.map(() => '?').join(',')})`, names
      ); // 查询存在的文件
      const set = new Set(files.map((f) => f.name)); // 转成集合
      rows.forEach((r) => { r.attachment_exists = r.attachment_path ? set.has(r.attachment_path) : false; }); // 标记是否存在
    }
  }
  send(res, true, rows); // 返回投递列表
}));

app.get('/api/applications/:id/attachment', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, r.attachment_path FROM applications a JOIN resumes r ON r.id = a.resume_id
     WHERE a.id = ? AND a.company_id = ?`, [req.params.id, req.user.id]
  );
  const application = rows[0];
  if (!application || !application.attachment_path) return send(res, false, '附件不存在或无权访问', 403);
  const file = application.attachment_path;
  if (!SAFE_FILE.test(file) || file.includes('..') || !(await canReadFile(req.user, file))) {
    return send(res, false, '附件不存在或无权访问', 403);
  }
  const buffer = await getFile(file);
  if (!buffer) return send(res, false, '附件不存在', 404);
  const download = req.query.download === '1';
  await transaction(async (db) => {
    await db.query('SELECT id FROM applications WHERE id = ? FOR UPDATE', [application.id]);
    const action = download ? 'downloaded' : 'viewed';
    const [events] = await db.query('SELECT id FROM app_events WHERE application_id = ? AND actor_id = ? AND action = ? LIMIT 1',
      [application.id, req.user.id, action]);
    if (!events.length) {
      await db.query('INSERT INTO app_events (application_id, actor_id, action, detail) VALUES (?,?,?,?)',
        [application.id, req.user.id, action, download ? '企业下载了简历附件' : '企业查看了简历附件']);
    }
    await db.query("UPDATE applications SET status='viewed' WHERE id=? AND status='submitted'", [application.id]);
  });
  sendFile(res, file, buffer, download);
}));

// 企业端：更新投递状态（已查看/邀面试/录用/不通过）
app.patch('/api/applications/:id/status', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM applications WHERE id = ?', [req.params.id]); // 查询投递记录
  const app_ = rows[0]; // 取投递记录
  if (!app_ || app_.company_id !== req.user.id) return send(res, false, '投递记录不存在或无权限'); // 校验归属
  const { status } = req.body || {}; // 解析目标状态
  const allowed = ['viewed', 'interview', 'accepted', 'rejected']; // 合法状态集合
  if (!allowed.includes(status)) return send(res, false, '状态不合法'); // 校验状态合法性
  await pool.query("UPDATE applications SET status=?, updated_at=NOW() WHERE id=?", [status, req.params.id]); // 更新状态
  const [jobRows] = await pool.query('SELECT title FROM jobs WHERE id=?', [app_.job_id]); // 查询职位标题
  const title = jobRows[0].title; // 取职位标题
  await pool.query(
    'INSERT INTO app_events (application_id, actor_id, action, detail) VALUES (?,?,?,?)',
    [app_.id, req.user.id, status, `企业将状态更新为「${{ viewed: '已查看', interview: '邀面试', accepted: '已录用', rejected: '未通过' }[status]}」`]
  ); // 记录状态变更轨迹
  await notify(app_.seeker_id, 'application', `「${title}」投递状态更新为：${{ viewed: '已查看', interview: '邀面试', accepted: '已录用', rejected: '未通过' }[status]}`); // 通知求职者
  send(res, true, '状态已更新'); // 返回提示
}));

// 企业端：发送面试邀约，生成会议链接并通知求职者
app.post('/api/applications/:id/interview', requireAuth(['company']), wrap(async (req, res) => {
  const body = req.body || {};
  const scheduled = futureTime(body.scheduledAt);
  const note = String(body.note || '').trim().slice(0, 120);
  const meeting = await transaction(async (db) => {
    const [rows] = await db.query('SELECT * FROM applications WHERE id = ? AND company_id = ? FOR UPDATE', [req.params.id, req.user.id]);
    const application = rows[0];
    if (!application) throw new BizError('投递记录不存在或无权限', 403);
    if (['accepted', 'rejected'].includes(application.status)) throw new BizError('该投递已结束，不能继续邀请面试', 409);
    const [pending] = await db.query("SELECT id FROM interviews WHERE application_id = ? AND status IN ('pending','rescheduled') LIMIT 1", [application.id]);
    if (pending.length) throw new BizError('请先处理已有的待确认面试', 409);
    const result = createMeeting({ provider: body.provider || 'tencent', topic: '面试邀约', userId: application.seeker_id });
    const link = body.mode === 'offline' ? null : result.url;
    await db.query("UPDATE applications SET status='interview', meeting_link=?, updated_at=NOW() WHERE id=?", [link, application.id]);
    const [info] = await db.query(
      `INSERT INTO interviews (application_id, job_id, seeker_id, company_id, scheduled_at, mode, link, company_note, status)
       VALUES (?,?,?,?,?,?,?,?, 'pending')`,
      [application.id, application.job_id, application.seeker_id, application.company_id, scheduled, body.mode === 'offline' ? 'offline' : 'online', link, note]
    );
    await db.query('INSERT INTO app_events (application_id, actor_id, action, detail) VALUES (?,?,?,?)',
      [application.id, req.user.id, 'interview', `面试 #${info.insertId}：邀请于 ${scheduled.toISOString()}，${note}`]);
    const [jobs] = await db.query('SELECT title FROM jobs WHERE id = ?', [application.job_id]);
    await notify(application.seeker_id, 'interview', `收到「${jobs[0].title}」面试邀约，请在我的面试确认时间与备注`, db);
    return result;
  });
  send(res, true, meeting);
}));

// 发起交换联系方式请求
app.post('/api/contact/request', requireAuth(), wrap(async (req, res) => {
  const { toUserId, jobId } = req.body || {}; // 解析请求参数
  if (!Number.isSafeInteger(Number(toUserId)) || Number(toUserId) <= 0 || Number(toUserId) === req.user.id) {
    return send(res, false, '请选择有效的接收方');
  }
  const [target] = await pool.query("SELECT id, role FROM users WHERE id = ? AND status = 'active'", [toUserId]);
  if (!target.length || !['seeker', 'company'].includes(req.user.role) ||
      target[0].role !== (req.user.role === 'company' ? 'seeker' : 'company')) {
    return send(res, false, '接收方不存在或不可联系');
  }
  const [dup] = await pool.query(
    'SELECT id FROM contact_requests WHERE from_user_id=? AND to_user_id=? AND status=?',
    [req.user.id, toUserId, 'pending']
  ); // 查询是否有待处理的重复请求
  if (dup.length) return send(res, false, '已有待处理的请求，请等待回复'); // 重复请求提示
  await pool.query('INSERT INTO contact_requests (from_user_id, to_user_id, job_id) VALUES (?,?,?)', [req.user.id, toUserId, jobId || null]); // 插入请求
  await notify(toUserId, 'contact', `${req.user.name} 请求交换联系方式`); // 通知接收方
  send(res, true, '联系方式交换请求已发送');
}));

// 查看联系方式请求（收到的待处理 + 已发送）
app.get('/api/contact/requests', requireAuth(), wrap(async (req, res) => {
  const [mine] = await pool.query(
    `SELECT cr.*, u.name AS user_name, u.company_name, u.role,
       CASE WHEN cr.status = 'accepted' AND u.status = 'active' THEN u.phone ELSE NULL END AS peer_phone
     FROM contact_requests cr JOIN users u ON u.id = cr.from_user_id
     WHERE cr.to_user_id = ? ORDER BY cr.id DESC LIMIT 100`,
    [req.user.id]
  ); // 查询收到的待处理请求
  const [sent] = await pool.query(
    `SELECT cr.*, u.name AS user_name, u.company_name, u.role,
       CASE WHEN cr.status = 'accepted' AND u.status = 'active' THEN u.phone ELSE NULL END AS peer_phone
     FROM contact_requests cr JOIN users u ON u.id = cr.to_user_id
     WHERE cr.from_user_id = ? ORDER BY cr.id DESC LIMIT 100`,
    [req.user.id]
  ); // 查询已发送的请求
  send(res, true, { received: mine, sent }); // 返回两组数据
}));

// 回复联系方式请求（同意/拒绝）
// ===================== 消息会话列表（含未读数） =====================

// GET /api/messages/threads：我的会话列表与未读数
app.get('/api/messages/threads', requireAuth(), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.peer_id, u.name AS peer_name, u.company_name, t.last_at, t.unread
     FROM (
       SELECT IF(from_user_id = ?, to_user_id, from_user_id) AS peer_id,
              MAX(created_at) AS last_at,
              SUM(CASE WHEN to_user_id = ? AND is_read = 0 THEN 1 ELSE 0 END) AS unread
       FROM messages WHERE from_user_id = ? OR to_user_id = ?
       GROUP BY peer_id
     ) t JOIN users u ON u.id = t.peer_id
     ORDER BY t.last_at DESC LIMIT 50`,
    [req.user.id, req.user.id, req.user.id, req.user.id]
  ); // 按对方聚合，统计未读
  send(res, true, rows); // 返回会话列表
}));

// 站内聊天：读取与某人的会话记录（同时把对方发来的消息标记为已读）
// GET /api/messages/contacts：聊天联系人列表（左侧会话列表）
// 返回每个联系人的最后一条消息、未读数量与资料，供聊天面板使用
app.get('/api/messages/contacts', requireAuth(), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT m.*, 
            IF(m.from_user_id = ?, m.to_user_id, m.from_user_id) AS peer_id,
            u.name AS peer_name, u.company_name AS peer_company, u.role AS peer_role,
            u.avatar_path AS peer_avatar
     FROM messages m JOIN users u ON u.id = IF(m.from_user_id = ?, m.to_user_id, m.from_user_id)
     WHERE (m.from_user_id = ? OR m.to_user_id = ?)
     ORDER BY m.id DESC LIMIT 800`,
    [req.user.id, req.user.id, req.user.id, req.user.id]
  ); // 拉取与我相关的消息（倒序，便于取最新一条）
  const map = new Map(); // 以对方 ID 聚合
  for (const m of rows) {
    const key = m.peer_id; // 对方用户 ID
    if (!map.has(key)) { // 首次出现即最后一条
      map.set(key, {
        peer_id: key, peer_name: m.peer_name, peer_company: m.peer_company,
        peer_role: m.peer_role, peer_avatar: m.peer_avatar,
        last_content: m.content, last_at: m.created_at, unread: 0, // 最后一条与未读数
      });
    }
    if (m.to_user_id === req.user.id && !m.is_read) map.get(key).unread += 1; // 统计未读
  }
  send(res, true, [...map.values()]); // 返回联系人列表
}));

app.get('/api/messages/:userId', requireAuth(), wrap(async (req, res) => {
  const peerId = Number(req.params.userId);
  const limit = Number(req.query.limit || 50);
  const before = req.query.before === undefined ? null : Number(req.query.before);
  if (!Number.isSafeInteger(peerId) || peerId < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (before !== null && (!Number.isSafeInteger(before) || before < 1))) return send(res, false, '消息分页参数不合法');
  const [peer] = await pool.query('SELECT id, name, company_name, role FROM users WHERE id = ?', [peerId]);
  if (!peer.length) return send(res, false, '对方不存在', 404);
  const [rows] = await pool.query(
    `SELECT id, from_user_id, to_user_id, content, created_at, is_read FROM messages
     WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
       ${before === null ? '' : 'AND id < ?'} ORDER BY id DESC LIMIT ?`,
    [req.user.id, peerId, peerId, req.user.id, ...(before === null ? [] : [before]), limit + 1]
  );
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).reverse();
  const unread = messages.filter((message) => message.to_user_id === req.user.id && !message.is_read).map((message) => message.id);
  if (unread.length) {
    await pool.query(`UPDATE messages SET is_read = 1 WHERE to_user_id = ? AND id IN (${unread.map(() => '?').join(',')})`, [req.user.id, ...unread]);
    messages.forEach((message) => { if (message.to_user_id === req.user.id) message.is_read = 1; });
  }
  send(res, true, { peer: peer[0], messages, hasMore, nextBefore: hasMore ? messages[0].id : null });
}));

// 站内聊天：发送消息
app.post('/api/messages', requireAuth(), limitBy('message', 30, 60 * 1000), wrap(async (req, res) => {
  const { toUserId, content, jobId } = req.body || {}; // 解析接收方、内容与关联职位
  const text = String(content || '').trim(); // 去掉首尾空白
  if (!toUserId) return send(res, false, '请选择接收方'); // 接收方必填
  if (!text) return send(res, false, '请输入消息内容'); // 内容必填
  if (text.length > 500) return send(res, false, '消息过长（最多 500 字）'); // 长度限制
  const bannedMsg = hasBannedWord(text); // 敏感词检查
  if (bannedMsg) return send(res, false, '消息包含违规内容，请修改后再发送'); // 命中则拒绝
  if (!Number.isSafeInteger(Number(toUserId)) || Number(toUserId) <= 0 || Number(toUserId) === req.user.id) return send(res, false, '接收方不合法');
  const [peer] = await pool.query("SELECT id, name FROM users WHERE id = ? AND status = 'active'", [toUserId]);
  if (!peer.length) return send(res, false, '对方不存在或账号不可用');
  const [info] = await pool.query(
    'INSERT INTO messages (from_user_id, to_user_id, job_id, content) VALUES (?,?,?,?)',
    [req.user.id, toUserId, jobId || null, text]
  ); // 写入消息
  await notify(toUserId, 'message', `${req.user.name}${req.user.company_name ? '（' + req.user.company_name + '）' : ''} 给你发来一条消息`); // 站内通知对方
  const [rows] = await pool.query('SELECT id, from_user_id, to_user_id, content, created_at FROM messages WHERE id = ?', [info.insertId]); // 取回新消息
  send(res, true, rows[0]); // 返回新消息
}));

// POST /api/contact/requests/:id/respond：对方同意或拒绝交换联系方式
app.post('/api/contact/requests/:id/respond', requireAuth(), wrap(async (req, res) => {
  const accept = req.body && req.body.accept;
  if (typeof accept !== 'boolean') return send(res, false, '请选择同意或拒绝');
  const result = await transaction(async (db) => {
    const [rows] = await db.query('SELECT * FROM contact_requests WHERE id = ? AND to_user_id = ? FOR UPDATE', [req.params.id, req.user.id]);
    const request = rows[0];
    if (!request) throw new BizError('请求不存在或无权限', 403);
    if (request.status !== 'pending') throw new BizError('该请求已处理', 409);
    const [users] = await db.query("SELECT name, phone FROM users WHERE id = ? AND status = 'active'", [request.from_user_id]);
    if (!users.length) throw new BizError('对方账号不可用');
    await db.query('UPDATE contact_requests SET status = ? WHERE id = ?', [accept ? 'accepted' : 'rejected', request.id]);
    if (accept) {
      await notify(request.from_user_id, 'contact', `${req.user.name} 已同意交换联系方式，请在联系与沟通中查看`, db);
      await notify(req.user.id, 'contact', `已与 ${users[0].name} 交换联系方式，请在联系与沟通中查看`, db);
    }
    return { message: accept ? '已同意，双方可查看对方联系方式' : '已拒绝该请求', phone: accept ? users[0].phone : null };
  });
  send(res, true, result);
}));

// 查看当前用户的通知列表
app.get('/api/notifications', requireAuth(), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', [req.user.id]); // 查询通知
  const [unread] = await pool.query('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]); // 未读数量
  send(res, true, { list: rows, unread: unread[0].c }); // 返回通知列表与未读数
}));

// 通知：全部标记为已读
app.post('/api/notifications/read', requireAuth(), wrap(async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [req.user.id]); // 批量置为已读
  send(res, true, '已全部标记为已读'); // 返回提示
}));

// 企业端：重新上架已下架职位
app.patch('/api/jobs/:id/republish', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]); // 查询职位
  const job = rows[0]; // 取职位
  if (!job || job.company_id !== req.user.id) return send(res, false, '职位不存在或无权限', 403); // 校验归属
  if (job.status === 'published') return send(res, false, '该职位已经是发布状态'); // 幂等提示
  await pool.query("UPDATE jobs SET status='published' WHERE id=?", [req.params.id]); // 置为已发布
  send(res, true, '职位已重新上架'); // 返回提示
}));

// 管理员：查看企业注册列表
app.get('/api/admin/companies', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, username, name, company_name, phone, status, reject_reason, license_path, avatar_path, created_at FROM users WHERE role='company' ORDER BY id DESC LIMIT 200"
  ); // 查询所有企业用户
  send(res, true, rows); // 返回企业列表
}));

// 管理员：通过企业注册审核
app.post('/api/admin/companies/:id/approve', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM users WHERE id=? AND role='company'", [req.params.id]); // 查询企业用户
  if (!rows.length) return send(res, false, '企业不存在'); // 校验存在性
  await transaction(async (db) => {
    await db.query("UPDATE users SET status='active', verified=1, reject_reason=NULL WHERE id=?", [req.params.id]);
    await notify(req.params.id, 'approve', '企业注册已通过审核，可以登录并发布职位', db);
  });
  send(res, true, '企业注册已通过'); // 返回提示
}));

// 管理员：查看全部用户
app.get('/api/admin/users', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, username, role, name, company_name, phone, status, created_at FROM users ORDER BY id DESC LIMIT 200'
  ); // 查询所有用户（上限 200 条）
  send(res, true, rows); // 返回用户列表
}));

// 管理员：更新用户状态（启用/停用等）
app.patch('/api/admin/users/:id/status', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]); // 查询用户
  const user = rows[0]; // 取用户
  if (!user || user.role === 'admin') return send(res, false, '用户不存在或不能修改管理员'); // 管理员不可修改
  const { status } = req.body || {}; // 解析目标状态
  if (!['active', 'pending', 'banned'].includes(status)) return send(res, false, '状态不合法'); // 校验状态合法性
  if (status !== 'active') await pool.query('DELETE FROM sessions WHERE user_id = ?', [req.params.id]); // 停用账号立即吊销会话
  await pool.query('UPDATE users SET status=? WHERE id=?', [status, req.params.id]); // 更新用户状态
  send(res, true, '用户状态已更新'); // 返回提示
}));

// ===================== 求职者端：多份简历 / 结构化字段 / 开放度 =====================

// pickResumeFields：从请求体里取简历字段，统一做长度与数值处理
function pickResumeFields(b) {
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v)); // 数值字段允许为空
  return {
    title: String(b.title || '').trim().slice(0, 64), // 简历名称
    name: String(b.name || '').trim().slice(0, 64), // 姓名
    skills: String(b.skills || '').slice(0, 2000), // 技能标签
    experience: String(b.experience || '').slice(0, 2000), // 工作经历
    education: String(b.education || '').slice(0, 32), // 学历
    expected_salary_min: num(b.expectedSalaryMin), // 期望薪资下限
    expected_salary_max: num(b.expectedSalaryMax), // 期望薪资上限
    expected_city: String(b.expectedCity || '').trim().slice(0, 64), // 期望城市
    available_time: String(b.availableTime || '').trim().slice(0, 32), // 到岗时间
    job_status: ['open', 'looking', 'closed'].includes(b.jobStatus) ? b.jobStatus : 'open', // 求职状态
    self_eval: String(b.selfEval || '').slice(0, 2000), // 自我评价
    project_exp: String(b.projectExp || '').slice(0, 4000), // 项目经历
    edu_exp: String(b.eduExp || '').slice(0, 2000), // 教育经历
    visibility: ['public', 'hidden', 'targeted'].includes(b.visibility) ? b.visibility : 'public' // 开放度
  };
}

// GET /api/resumes：我的简历列表
app.get('/api/resumes', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM resumes WHERE user_id = ? ORDER BY is_default DESC, id DESC',
    [req.user.id]
  ); // 主简历排在最前
  send(res, true, rows); // 返回列表
}));

// POST /api/resumes：新建一份简历
app.post('/api/resumes', requireAuth(['seeker']), wrap(async (req, res) => {
  const f = pickResumeFields(req.body || {}); // 取字段
  if (!f.name) return send(res, false, '请填写姓名'); // 姓名必填
  if (f.expected_salary_min && f.expected_salary_max && f.expected_salary_min > f.expected_salary_max) {
    return send(res, false, '期望薪资下限不能高于上限'); // 区间校验
  }
  let attachmentPath = null, attachmentName = null;
  if (req.body && req.body.attachmentBase64) {
    attachmentName = req.body.attachmentName || 'resume.pdf'; // 附件名
    attachmentPath = await saveAttachment(attachmentName, req.body.attachmentBase64); // 保存附件
  }
  const [count] = await pool.query('SELECT COUNT(*) AS c FROM resumes WHERE user_id = ?', [req.user.id]); // 已有简历数
  const isDefault = count[0].c === 0 ? 1 : 0; // 第一份自动设为主简历
  const [info] = await pool.query(
    `INSERT INTO resumes (user_id, title, name, skills, experience, education,
      expected_salary_min, expected_salary_max, expected_city, available_time, job_status,
      self_eval, project_exp, edu_exp, visibility, is_default, attachment_name, attachment_path)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user.id, f.title || '我的简历', f.name, f.skills, f.experience, f.education,
     f.expected_salary_min, f.expected_salary_max, f.expected_city, f.available_time, f.job_status,
     f.self_eval, f.project_exp, f.edu_exp, f.visibility, isDefault, attachmentName, attachmentPath]
  ); // 写入简历
  send(res, true, { id: info.insertId, message: '简历已创建' }); // 返回结果
}));

// PATCH /api/resumes/:id：更新简历（保存修改前快照用于历史）
app.patch('/api/resumes/:id', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM resumes WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]); // 校验归属
  const old = rows[0];
  if (!old) return send(res, false, '简历不存在或无权限', 403); // 越权保护
  const f = pickResumeFields(req.body || {}); // 新字段
  if (!f.name) return send(res, false, '请填写姓名'); // 姓名必填
  if (f.expected_salary_min && f.expected_salary_max && f.expected_salary_min > f.expected_salary_max) {
    return send(res, false, '期望薪资下限不能高于上限'); // 区间校验
  }
  await pool.query('INSERT INTO resume_history (resume_id, user_id, snapshot) VALUES (?,?,?)',
    [old.id, req.user.id, JSON.stringify(old)]); // 保存修改前快照
  let attachmentName = null, attachmentPath = null;
  if (req.body && req.body.attachmentBase64) {
    attachmentName = req.body.attachmentName || 'resume.pdf'; // 新附件名
    attachmentPath = await saveAttachment(attachmentName, req.body.attachmentBase64); // 保存新附件
  }
  await pool.query(
    `UPDATE resumes SET title=?, name=?, skills=?, experience=?, education=?,
       expected_salary_min=?, expected_salary_max=?, expected_city=?, available_time=?, job_status=?,
       self_eval=?, project_exp=?, edu_exp=?, visibility=?,
       attachment_name=COALESCE(?, attachment_name), attachment_path=COALESCE(?, attachment_path)
     WHERE id=?`,
    [f.title || old.title || '我的简历', f.name, f.skills, f.experience, f.education,
     f.expected_salary_min, f.expected_salary_max, f.expected_city, f.available_time, f.job_status,
     f.self_eval, f.project_exp, f.edu_exp, f.visibility, attachmentName, attachmentPath, old.id]
  ); // 更新简历
  send(res, true, '简历已更新'); // 返回结果
}));

// DELETE /api/resumes/:id：删除简历（被投递引用时禁止删除）
app.delete('/api/resumes/:id', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM resumes WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]); // 校验归属
  const resume = rows[0];
  if (!resume) return send(res, false, '简历不存在或无权限', 403);
  const [used] = await pool.query('SELECT COUNT(*) AS c FROM applications WHERE resume_id = ?', [resume.id]); // 是否已被投递引用
  if (used[0].c) return send(res, false, '该简历已用于投递，不能删除'); // 保护历史数据
  await pool.query('DELETE FROM resume_history WHERE resume_id = ?', [resume.id]); // 清理历史
  await pool.query('DELETE FROM resumes WHERE id = ?', [resume.id]); // 删除简历
  if (resume.is_default) {
    await pool.query('UPDATE resumes SET is_default = 1 WHERE user_id = ? ORDER BY id DESC LIMIT 1', [req.user.id]); // 重新指定主简历
  }
  send(res, true, '简历已删除'); // 返回结果
}));

// POST /api/resumes/:id/default：设为主简历
app.post('/api/resumes/:id/default', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM resumes WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]); // 校验归属
  if (!rows.length) return send(res, false, '简历不存在或无权限', 403);
  await pool.query('UPDATE resumes SET is_default = 0 WHERE user_id = ?', [req.user.id]); // 先清空
  await pool.query('UPDATE resumes SET is_default = 1 WHERE id = ?', [req.params.id]); // 再设置
  send(res, true, '已设为主简历'); // 返回结果
}));

// GET /api/resumes/:id/history：简历修改历史
app.get('/api/resumes/:id/history', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT id, created_at FROM resume_history WHERE resume_id = ? AND user_id = ? ORDER BY id DESC LIMIT 20', [req.params.id, req.user.id]); // 只返回时间，避免传输大文本
  send(res, true, rows); // 返回历史列表
}));

// ===================== 收藏职位 / 关注企业 =====================

// GET /api/favorites：我收藏的职位
app.get('/api/favorites', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT f.id AS fav_id, j.*, u.company_name AS company, u.status AS company_status
     FROM favorites f JOIN jobs j ON j.id = f.job_id JOIN users u ON u.id = j.company_id
     WHERE f.user_id = ? ORDER BY f.id DESC LIMIT 200`, [req.user.id]
  );
  rows.forEach((row) => { if (row.company_status !== 'active') row.status = 'offline'; });
  send(res, true, rows);
}));

// POST /api/favorites/:jobId：收藏/取消收藏（切换）
app.post('/api/favorites/:jobId', requireAuth(['seeker']), wrap(async (req, res) => {
  const [job] = await pool.query('SELECT id FROM jobs WHERE id = ?', [req.params.jobId]); // 校验职位
  if (!job.length) return send(res, false, '职位不存在');
  const [exist] = await pool.query('SELECT id FROM favorites WHERE user_id = ? AND job_id = ?', [req.user.id, req.params.jobId]); // 是否已收藏
  if (exist.length) {
    await pool.query('DELETE FROM favorites WHERE id = ?', [exist[0].id]); // 取消收藏
    return send(res, true, { favorited: false }); // 返回状态
  }
  await pool.query('INSERT INTO favorites (user_id, job_id) VALUES (?,?)', [req.user.id, req.params.jobId]); // 收藏
  send(res, true, { favorited: true }); // 返回状态
}));

// POST /api/follows/:companyId：关注/取消关注企业
app.post('/api/follows/:companyId', requireAuth(['seeker']), wrap(async (req, res) => {
  const [exist] = await pool.query('SELECT id FROM follows WHERE user_id = ? AND company_id = ?', [req.user.id, req.params.companyId]); // 是否已关注
  if (exist.length) {
    await pool.query('DELETE FROM follows WHERE id = ?', [exist[0].id]); // 取消关注
    return send(res, true, { followed: false });
  }
  await pool.query('INSERT INTO follows (user_id, company_id) VALUES (?,?)', [req.user.id, req.params.companyId]); // 关注
  send(res, true, { followed: true });
}));

// ===================== 投递轨迹 / 面试确认 =====================

// GET /api/applications/:id/events：投递轨迹（求职者本人或该企业可看）
app.get('/api/applications/:id/events', requireAuth(), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM applications WHERE id = ?', [req.params.id]); // 查询投递
  const app_ = rows[0];
  if (!app_) return send(res, false, '投递记录不存在');
  const mine = app_.seeker_id === req.user.id || app_.company_id === req.user.id; // 只有当事双方可看
  if (!mine) return send(res, false, '无权限访问', 403);
  const [events] = await pool.query('SELECT * FROM app_events WHERE application_id = ? ORDER BY id ASC', [req.params.id]); // 轨迹列表
  send(res, true, events); // 返回轨迹
}));

app.get('/api/interviews/mine', requireAuth(['seeker', 'company']), wrap(async (req, res) => {
  const owner = req.user.role === 'company' ? 'i.company_id' : 'i.seeker_id';
  const [rows] = await pool.query(
    `SELECT i.*, j.title AS job_title, u.company_name AS company, s.name AS candidate
     FROM interviews i LEFT JOIN jobs j ON j.id = i.job_id
     LEFT JOIN users u ON u.id = i.company_id LEFT JOIN users s ON s.id = i.seeker_id
     WHERE ${owner} = ? ORDER BY i.id DESC LIMIT 100`, [req.user.id]
  );
  send(res, true, rows);
}));

app.post('/api/interviews/:id/respond', requireAuth(['seeker']), wrap(async (req, res) => {
  const { action, newTime } = req.body || {};
  const note = String((req.body || {}).note || '').trim().slice(0, 120);
  if (!['confirm', 'decline', 'reschedule'].includes(action)) return send(res, false, '操作不合法');
  const proposed = action === 'reschedule' ? futureTime(newTime) : null;
  await transaction(async (db) => {
    const [rows] = await db.query('SELECT * FROM interviews WHERE id = ? AND seeker_id = ? FOR UPDATE', [req.params.id, req.user.id]);
    const interview = rows[0];
    if (!interview) throw new BizError('面试邀约不存在或无权限', 403);
    const allowed = { pending: ['confirm', 'decline', 'reschedule'], confirmed: ['decline', 'reschedule'], rescheduled: ['decline'] };
    if (!(allowed[interview.status] || []).includes(action)) throw new BizError('当前面试状态不允许此操作', 409);
    if (action === 'confirm') futureTime(new Date(interview.scheduled_at).toISOString());
    const status = { confirm: 'confirmed', decline: 'declined', reschedule: 'rescheduled' }[action];
    await db.query('UPDATE interviews SET status=?, proposed_at=?, seeker_note=? WHERE id=?', [status, proposed, note, interview.id]);
    const time = new Date(interview.scheduled_at).toISOString();
    const detail = action === 'reschedule' ? `申请从 ${time} 改约至 ${proposed.toISOString()}` : `${action === 'confirm' ? '确认' : '拒绝'} ${time}`;
    await db.query('INSERT INTO app_events (application_id, actor_id, action, detail) VALUES (?,?,?,?)',
      [interview.application_id, req.user.id, 'interview_' + action, `面试 #${interview.id}：${detail}，${note}`]);
    await notify(interview.company_id, 'interview', `${req.user.name} 对面试 #${interview.id} ${detail}，请在面试管理查看`, db);
  });
  send(res, true, '已提交');
}));

app.post('/api/interviews/:id/review', requireAuth(['company']), wrap(async (req, res) => {
  const { action } = req.body || {};
  const note = String((req.body || {}).note || '').trim().slice(0, 120);
  if (!['accept', 'reject'].includes(action)) return send(res, false, '操作不合法');
  await transaction(async (db) => {
    const [rows] = await db.query('SELECT * FROM interviews WHERE id = ? AND company_id = ? FOR UPDATE', [req.params.id, req.user.id]);
    const interview = rows[0];
    if (!interview) throw new BizError('面试邀约不存在或无权限', 403);
    if (interview.status !== 'rescheduled' || !interview.proposed_at) throw new BizError('没有待处理的改约申请', 409);
    const scheduled = futureTime(new Date(action === 'accept' ? interview.proposed_at : interview.scheduled_at).toISOString());
    await db.query('UPDATE interviews SET status=?, scheduled_at=?, proposed_at=NULL, company_note=? WHERE id=?',
      [action === 'accept' ? 'confirmed' : 'pending', scheduled, note, interview.id]);
    const detail = `${action === 'accept' ? '接受' : '拒绝'}改约（${new Date(interview.scheduled_at).toISOString()} → ${new Date(interview.proposed_at).toISOString()}）`;
    await db.query('INSERT INTO app_events (application_id, actor_id, action, detail) VALUES (?,?,?,?)',
      [interview.application_id, req.user.id, 'interview_review', `面试 #${interview.id}：${detail}，${note}`]);
    await notify(interview.seeker_id, 'interview', `${req.user.company_name} ${detail}，请在我的面试查看`, db);
  });
  send(res, true, '改约申请已处理');
}));

// 没有真实身份验证通道时必须关闭找回，不能用回显验证码代替身份验证。
app.post(['/api/auth/code', '/api/auth/forgot', '/api/auth/reset'], (req, res) => {
  send(res, false, '短信验证与自助找回尚未启用，请联系平台管理员核验身份', 503);
});

// ===================== 企业资料与认证 =====================

// GET /api/company/profile：企业资料
app.get('/api/company/profile', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, username, name, company_name, phone, avatar_path, license_path, verified,
            company_intro, company_industry, company_size, company_address
     FROM users WHERE id = ?`, [req.user.id]
  ); // 只取企业资料相关字段
  send(res, true, rows[0]); // 返回资料
}));

// PATCH /api/company/profile：企业修改自身资料
app.patch('/api/company/profile', requireAuth(['company']), wrap(async (req, res) => {
  const b = req.body || {}; // 请求体
  const companyName = String(b.companyName || '').trim().slice(0, 128); // 公司名
  if (!companyName) return send(res, false, '公司名称不能为空');
  const phone = String(b.phone || '').trim();
  if (phone && !/^1\d{10}$/.test(phone)) return send(res, false, '手机号格式不正确');
  if (phone) {
    const [duplicate] = await pool.query('SELECT id FROM users WHERE phone = ? AND id <> ?', [phone, req.user.id]);
    if (duplicate.length) return send(res, false, '该手机号已被使用');
  }
  let avatarPath = null;
  if (b.avatarBase64) avatarPath = await saveImage(b.avatarName || 'avatar.png', b.avatarBase64); // 可选头像
  await pool.query(
    `UPDATE users SET company_name=?, name=?, phone=?, company_intro=?, company_industry=?,
       company_size=?, company_address=?, avatar_path=COALESCE(?, avatar_path) WHERE id=?`,
    [companyName, String(b.contact || '').trim().slice(0, 64), phone || null,
     String(b.intro || '').slice(0, 2000), String(b.industry || '').slice(0, 32),
     String(b.size || '').slice(0, 32), String(b.address || '').slice(0, 64), avatarPath, req.user.id]
  ); // 更新资料
  send(res, true, '企业资料已更新'); // 返回结果
}));



// ===================== 企业招聘看板 =====================

// GET /api/company/dashboard：企业自己的招聘漏斗
app.get('/api/company/dashboard', requireAuth(['company']), wrap(async (req, res) => {
  const [[jobs]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(status='published') AS published,
            COALESCE(SUM(view_count),0) AS views, COALESCE(SUM(is_urgent=1),0) AS urgent
     FROM jobs WHERE company_id = ?`, [req.user.id]
  ); // 职位与曝光
  const [[apps]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(status='viewed') AS viewed,
            SUM(status='interview') AS interview,
            SUM(status='accepted') AS accepted,
            SUM(status='rejected') AS rejected
     FROM applications WHERE company_id = ?`, [req.user.id]
  ); // 投递漏斗
  const [[itv]] = await pool.query(
    'SELECT COUNT(*) AS total, COALESCE(SUM(status=\'pending\'),0) AS pending FROM interviews WHERE company_id = ?', [req.user.id]
  ); // 面试状态
  const total = apps.total || 0; // 投递总数
  send(res, true, {
    jobs, apps, interviews: itv,
    conversion: {
      viewToApply: jobs.views > 0 ? Math.min(100, Math.round((total / jobs.views) * 100)) : 0, // 浏览→投递（历史数据可能没有浏览量，封顶 100）
      applyToInterview: total > 0 ? Math.min(100, Math.round(((apps.interview || 0) + (apps.accepted || 0)) / total * 100)) : 0, // 投递→面试
      interviewToHire: (apps.interview || 0) + (apps.accepted || 0) > 0
        ? Math.round((apps.accepted || 0) / ((apps.interview || 0) + (apps.accepted || 0)) * 100) : 0 // 面试→录用
    }
  }); // 返回看板数据
}));

// POST /api/admin/companies/:id/reject：驳回企业注册并说明原因
app.post('/api/admin/companies/:id/reject', requireAuth(['admin']), wrap(async (req, res) => {
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200); // 驳回理由
  if (!reason) return send(res, false, '请填写驳回理由'); // 理由必填
  const [rows] = await pool.query("SELECT id FROM users WHERE id = ? AND role = 'company'", [req.params.id]); // 校验企业
  if (!rows.length) return send(res, false, '企业不存在');
  await transaction(async (db) => {
    await db.query("UPDATE users SET status='banned', verified=0, reject_reason=? WHERE id=?", [reason, req.params.id]);
    await db.query('DELETE FROM sessions WHERE user_id = ?', [req.params.id]);
    await notify(req.params.id, 'approve', `企业注册未通过审核，原因：${reason}。请联系管理员补交资料后重新审核。`, db);
  });
  send(res, true, '已驳回并通知企业'); // 返回结果
}));

// GET /api/company/reject-reason：企业查看自己被驳回的原因
app.get('/api/company/reject-reason', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT status, reject_reason FROM users WHERE id = ?', [req.user.id]); // 查询自身状态
  send(res, true, rows[0] || {}); // 返回状态与理由
}));

// GET /api/company/:id：企业主页（求职者可见的公开信息）
app.get('/api/company/:id', requireAuth(), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, company_name, company_intro, company_industry, company_size, company_address, verified, name
     FROM users WHERE id = ? AND role = 'company' AND status = 'active'`, [req.params.id]
  ); // 只返回公开字段
  if (!rows.length) return send(res, false, '企业不存在');
  const [jobs] = await pool.query(
    `SELECT id, title, location, salary_min, salary_max, is_urgent, is_top FROM jobs
     WHERE company_id = ? AND status = 'published' ORDER BY is_top DESC, id DESC LIMIT 50`, [req.params.id]
  ); // 该企业在招职位
  send(res, true, { company: rows[0], jobs }); // 返回企业主页数据
}));

// ===================== 人才库与双向推荐 =====================

// GET /api/talent：企业按条件搜索全站公开简历
app.get('/api/talent', requireAuth(['company']), wrap(async (req, res) => {
  const { skills, city, education, minExp, minSalary, keyword } = req.query; // 筛选条件
  const where = ["r.visibility = 'public'", "u.role = 'seeker'", "u.status = 'active'"]; // 只搜公开且有效的简历
  const args = []; // 参数
  if (skills) { // 技能需全部命中
    String(skills).split(/[,，]/).filter(Boolean).forEach((s) => {
      where.push('r.skills LIKE ?'); args.push(`%${s.trim()}%`);
    });
  }
  if (city) { where.push('r.expected_city LIKE ?'); args.push(`%${city}%`); } // 期望城市模糊匹配
  if (education) { where.push('r.education = ?'); args.push(education); } // 学历
  if (minExp) { where.push("(r.experience IS NULL OR r.experience <> '')"); } // 有经验描述即可
  if (minSalary) { where.push('(r.expected_salary_max IS NULL OR r.expected_salary_max >= ?)'); args.push(+minSalary); } // 期望上限
  if (keyword) { where.push('(r.self_eval LIKE ? OR r.project_exp LIKE ? OR r.name LIKE ?)'); args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); } // 关键词
  const [rows] = await pool.query(
    `SELECT r.id, r.user_id, r.title, r.name, r.skills, r.experience, r.education, r.expected_city,
            r.expected_salary_min, r.expected_salary_max, r.available_time, r.job_status, r.self_eval
     FROM resumes r JOIN users u ON u.id = r.user_id
     WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 100`, args
  ); // 查询公开简历
  send(res, true, rows); // 返回人才列表
}));

// GET /api/recommend/jobs：给求职者推荐职位（按主简历与职位的匹配分排序）
app.get('/api/recommend/jobs', requireAuth(['seeker']), wrap(async (req, res) => {
  const [resumes] = await pool.query('SELECT * FROM resumes WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1', [req.user.id]); // 主简历
  const resume = resumes[0];
  if (!resume) return send(res, true, []); // 没有简历就没有推荐
  const [jobs] = await pool.query(
    `SELECT j.*, u.company_name AS company, u.verified FROM jobs j JOIN users u ON u.id = j.company_id
     WHERE j.status = 'published' AND u.status = 'active' AND u.role = 'company' ORDER BY j.id DESC LIMIT 200`
  ); // 取候选职位
  const scored = jobs.map((j) => ({ ...j, match: matchScore(resume, j) })) // 逐个打分
    .sort((a, b) => b.match.score - a.match.score) // 按分数降序
    .slice(0, 12); // 只取前 12 条
  send(res, true, scored); // 返回推荐列表
}));

// GET /api/recommend/talent：给企业推荐候选人（按职位要求与简历的匹配分排序）
app.get('/api/recommend/talent', requireAuth(['company']), wrap(async (req, res) => {
  const [jobs] = await pool.query("SELECT * FROM jobs WHERE company_id = ? AND status = 'published' ORDER BY id DESC LIMIT 1", [req.user.id]); // 取最近发布的职位作为参照
  const job = jobs[0];
  if (!job) return send(res, true, []); // 没有职位则无推荐
  const [resumes] = await pool.query(
    `SELECT r.*, u.name AS seeker_name FROM resumes r JOIN users u ON u.id = r.user_id
     WHERE r.visibility = 'public' AND u.status = 'active' ORDER BY r.id DESC LIMIT 200`
  ); // 取公开简历
  const scored = resumes.map((r) => ({ ...r, match: matchScore(r, job) })) // 打分
    .sort((a, b) => b.match.score - a.match.score).slice(0, 10); // 取前 10
  send(res, true, scored); // 返回推荐
}));

// GET /api/jobs/:id/similar：相似职位（同地点或技能重合）
app.get('/api/jobs/:id/similar', wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT j.* FROM jobs j JOIN users u ON u.id = j.company_id
     WHERE j.id = ? AND j.status = 'published' AND u.status = 'active' AND u.role = 'company'`, [req.params.id]
  );
  const job = rows[0];
  if (!job) return send(res, false, '职位不存在');
  const [list] = await pool.query(
    `SELECT j.*, u.company_name AS company FROM jobs j JOIN users u ON u.id = j.company_id
     WHERE j.status = 'published' AND u.status = 'active' AND u.role = 'company' AND j.id <> ? AND (j.location = ? OR j.title LIKE ?)
     ORDER BY j.id DESC LIMIT 6`,
    [job.id, job.location || '', `%${(job.title || '').slice(0, 2)}%`]
  ); // 同城或标题相近的职位
  send(res, true, list); // 返回相似职位
}));

// ===================== 职位运营：刷新 / 置顶 / 急招 / 批量下架 =====================

// POST /api/jobs/:id/refresh：刷新职位（排到前面）
app.post('/api/jobs/:id/refresh', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ? AND company_id = ?', [req.params.id, req.user.id]); // 校验归属
  if (!rows.length) return send(res, false, '职位不存在或无权限', 403);
  await pool.query('UPDATE jobs SET refreshed_at = NOW() WHERE id = ?', [req.params.id]); // 记录刷新时间
  send(res, true, '职位已刷新'); // 返回结果
}));

// POST /api/jobs/:id/top：置顶 / 取消置顶
app.post('/api/jobs/:id/top', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ? AND company_id = ?', [req.params.id, req.user.id]); // 校验归属
  if (!rows.length) return send(res, false, '职位不存在或无权限', 403);
  const next = rows[0].is_top ? 0 : 1; // 切换状态
  await pool.query('UPDATE jobs SET is_top = ? WHERE id = ?', [next, req.params.id]);
  send(res, true, next ? '已置顶' : '已取消置顶'); // 返回结果
}));

// POST /api/jobs/:id/urgent：标记 / 取消急招
app.post('/api/jobs/:id/urgent', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ? AND company_id = ?', [req.params.id, req.user.id]); // 校验归属
  if (!rows.length) return send(res, false, '职位不存在或无权限', 403);
  const next = rows[0].is_urgent ? 0 : 1; // 切换状态
  await pool.query('UPDATE jobs SET is_urgent = ? WHERE id = ?', [next, req.params.id]);
  send(res, true, next ? '已标记为急招' : '已取消急招'); // 返回结果
}));

// POST /api/jobs/batch-offline：批量下架
app.post('/api/jobs/batch-offline', requireAuth(['company']), wrap(async (req, res) => {
  const ids = (req.body && Array.isArray(req.body.ids)) ? req.body.ids.map(Number).filter(Boolean) : []; // 职位 ID 列表
  if (!ids.length) return send(res, false, '请选择要下架的职位');
  const [result] = await pool.query(
    `UPDATE jobs SET status = 'offline' WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [req.user.id, ...ids]
  ); // 只允许下架自己的职位
  send(res, true, `已下架 ${result.affectedRows} 个职位`); // 返回结果
}));

// ===================== 管理员：看板 / 日志 / 导出 =====================

// GET /api/admin/dashboard：运营数据看板
app.get('/api/admin/dashboard', requireAuth(['admin']), wrap(async (req, res) => {
  const [[users]] = await pool.query("SELECT COUNT(*) AS total, SUM(status='active') AS active, SUM(role='company') AS company, SUM(role='seeker') AS seeker FROM users"); // 用户统计
  const [[jobs]] = await pool.query("SELECT COUNT(*) AS total, SUM(status='published') AS published, SUM(is_urgent=1) AS urgent FROM jobs"); // 职位统计
  const [[apps]] = await pool.query('SELECT COUNT(*) AS total, SUM(status=\'interview\') AS interview, SUM(status=\'accepted\') AS accepted FROM applications'); // 投递统计
  const [[recent]] = await pool.query('SELECT COUNT(*) AS c FROM applications WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'); // 近 7 天投递
  send(res, true, { users, jobs, apps, recentApplications: recent.c }); // 返回统计
}));

// GET /api/admin/logs：操作日志
app.get('/api/admin/logs', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT l.*, u.username FROM operation_logs l LEFT JOIN users u ON u.id = l.user_id
     ORDER BY l.id DESC LIMIT 200`
  ); // 最近 200 条
  send(res, true, rows); // 返回日志
}));

// GET /api/admin/export：导出 CSV（Excel 可直接打开）
app.get('/api/admin/export', requireAuth(['admin']), wrap(async (req, res) => {
  const type = String(req.query.type || 'applications'); // 导出类型
  const map = { // 类型到 SQL 的映射
    applications: `SELECT a.id, j.title AS job, u.company_name AS company, s.name AS seeker,
                     a.status, a.match_score, a.created_at
                   FROM applications a JOIN jobs j ON j.id = a.job_id
                   JOIN users u ON u.id = a.company_id JOIN users s ON s.id = a.seeker_id ORDER BY a.id DESC`,
    jobs: `SELECT j.id, j.title, j.location, j.salary_min, j.salary_max, j.status, u.company_name AS company, j.created_at
           FROM jobs j JOIN users u ON u.id = j.company_id ORDER BY j.id DESC`,
    users: `SELECT id, username, role, name, company_name, phone, status, created_at FROM users ORDER BY id DESC`
  };
  if (!map[type]) return send(res, false, '导出类型不支持');
  const [rows] = await pool.query(map[type]); // 查询数据
  const headers = rows.length ? Object.keys(rows[0]) : []; // 表头
  const cell = (value) => {
    let text = String(value ?? '');
    if (typeof value === 'string' && (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = '\uFEFF' + [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n'); // 加 BOM 便于 Excel 识别中文
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="addwork-${type}.csv"`);
  res.send(csv); // 输出 CSV
}));

// ===================== 内容审核 / 限频 / 健康检查 =====================

// 敏感词表：职位、简历、消息等自由文本提交前做一次基础过滤
const BANNED_WORDS = ['代开发票', '刷单', '赌博', '色情', '办证', '包过', '传销'];

// hasBannedWord：命中敏感词返回该词，否则返回 null
function hasBannedWord(text) {
  const s = String(text || ''); // 统一转字符串
  return BANNED_WORDS.find((w) => s.includes(w)) || null; // 返回命中的词
}

// 简单内存限频：同一 key 在窗口期内最多 N 次
const rateBuckets = new Map();
// rateLimit：滑动窗口限频计数，返回本次是否放行
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const rec = rateBuckets.get(key);
  if (!rec || now - rec.start > windowMs) { // 窗口过期则重置
    rateBuckets.set(key, { start: now, count: 1 });
    return true;
  }
  rec.count += 1; // 累计次数
  return rec.count <= max; // 超限返回 false
}

// 限频中间件工厂
function limitBy(scope, max, windowMs) {
  return (req, res, next) => {
    const id = (req.ip || '') + ':' + scope; // 以 IP + 场景为键
    if (!rateLimit(id, max, windowMs)) return send(res, false, '操作过于频繁，请稍后再试', 429); // 超限拒绝
    next();
  };
}

// GET /healthz：健康检查（供平台探活与监控）
app.get('/healthz', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT 1 AS ok'); // 探活数据库
  res.json({ ok: true, db: rows[0].ok === 1, uptime: Math.round(process.uptime()) }); // 返回运行状态
}));


// ===================== 紧急修复批：重复投递 / 企业归档 / 聊天联系人 / 管理端 CRUD =====================

// DELETE /api/applications/:id：企业端删除收到的简历（软删除，保留审计）
app.delete('/api/applications/:id', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM applications WHERE id = ? AND company_id = ?', [req.params.id, req.user.id]); // 校验归属
  if (!rows.length) return send(res, false, '投递记录不存在'); // 不存在或无权
  await pool.query('UPDATE applications SET deleted = 1 WHERE id = ?', [req.params.id]); // 软删除
  await pool.query(
    'INSERT INTO app_events (application_id, actor_id, action, detail) VALUES (?,?,?,?)',
    [req.params.id, req.user.id, 'deleted', '企业端删除该投递记录']
  ); // 记录操作轨迹
  send(res, true, '已删除'); // 返回结果
}));

// GET /api/applications/received/stats：企业端各状态的归档数量
app.get('/api/applications/received/stats', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) AS c FROM applications
     WHERE company_id = ? AND deleted = 0 GROUP BY status`, [req.user.id]
  ); // 按状态分组统计
  const counts = { all: 0, submitted: 0, viewed: 0, interview: 0, accepted: 0, rejected: 0 }; // 默认值
  rows.forEach((r) => { counts[r.status] = Number(r.c); counts.all += Number(r.c); }); // 累加
  send(res, true, counts); // 返回计数
}));

// ===================== 管理端：用户 / 企业 / 职位的增删改查 =====================

// GET /api/admin/users/manage：用户管理列表（支持关键字与角色筛选）
app.get('/api/admin/users/manage', requireAuth(['admin']), wrap(async (req, res) => {
  const kw = String(req.query.keyword || '').trim(); // 关键字
  const role = String(req.query.role || '').trim(); // 角色筛选
  const where = ['1=1']; // 条件
  const args = []; // 参数
  if (kw) { where.push('(username LIKE ? OR name LIKE ? OR company_name LIKE ?)'); const like = `%${kw}%`; args.push(like, like, like); }
  if (['seeker', 'company', 'admin'].includes(role)) { where.push('role = ?'); args.push(role); }
  const [rows] = await pool.query(
    `SELECT id, username, role, name, company_name, phone, status, verified, created_at
     FROM users WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 200`, args
  ); // 查询用户
  send(res, true, rows); // 返回列表
}));

// PATCH /api/admin/users/:id：修改用户资料或状态（管理员不可被修改）
app.patch('/api/admin/users/:id', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]); // 查询用户
  if (!rows.length) return send(res, false, '用户不存在');
  if (rows[0].role === 'admin') return send(res, false, '不能修改管理员账号'); // 保护管理员
  const { status, name, role, verified } = req.body || {}; // 可改字段
  if (status && !['active', 'pending', 'banned'].includes(status)) return send(res, false, '状态不合法'); // 校验状态
  if (role && !['seeker', 'company'].includes(role)) return send(res, false, '角色不合法'); // 校验角色
  await pool.query(
    'UPDATE users SET status = COALESCE(?, status), name = COALESCE(?, name), role = COALESCE(?, role), verified = COALESCE(?, verified) WHERE id = ?',
    [status || null, name || null, role || null, verified === undefined ? null : (verified ? 1 : 0), req.params.id]
  ); // 更新字段
  if (status && status !== 'active') await pool.query('DELETE FROM sessions WHERE user_id = ?', [req.params.id]); // 停用即刻下线
  send(res, true, '用户已更新');
}));

// DELETE /api/admin/users/:id：删除用户及其关联数据
app.delete('/api/admin/users/:id', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT id, role FROM users WHERE id = ?', [req.params.id]); // 查询用户
  if (!rows.length) return send(res, false, '用户不存在');
  if (rows[0].role === 'admin') return send(res, false, '不能删除管理员账号'); // 保护管理员
  const uid = req.params.id; // 目标用户
  await transaction(async (db) => {
    await db.query('DELETE FROM app_events WHERE application_id IN (SELECT id FROM applications WHERE seeker_id = ? OR company_id = ?)', [uid, uid]); // 轨迹
    await db.query('DELETE FROM applications WHERE seeker_id = ? OR company_id = ?', [uid, uid]); // 投递
    await db.query('DELETE FROM interviews WHERE seeker_id = ? OR company_id = ?', [uid, uid]); // 面试
    await db.query('DELETE FROM favorites WHERE user_id = ?', [uid]); // 收藏
    await db.query('DELETE FROM follows WHERE user_id = ? OR company_id = ?', [uid, uid]); // 关注
    await db.query('DELETE FROM contact_requests WHERE from_user_id = ? OR to_user_id = ?', [uid, uid]); // 联系请求
    await db.query('DELETE FROM messages WHERE from_user_id = ? OR to_user_id = ?', [uid, uid]); // 消息
    await db.query('DELETE FROM notifications WHERE user_id = ?', [uid]); // 通知
    await db.query('DELETE FROM sessions WHERE user_id = ?', [uid]); // 会话
    await db.query('DELETE FROM resumes WHERE user_id = ?', [uid]); // 简历
    await db.query('DELETE FROM jobs WHERE company_id = ?', [uid]); // 职位（仅企业有）
    await db.query('DELETE FROM users WHERE id = ?', [uid]); // 用户本体
  });
  send(res, true, '用户已删除');
}));

// GET /api/admin/jobs/manage：职位管理列表（关键字与状态筛选）
app.get('/api/admin/jobs/manage', requireAuth(['admin']), wrap(async (req, res) => {
  const kw = String(req.query.keyword || '').trim(); // 关键字
  const status = String(req.query.status || '').trim(); // 状态
  const where = ['1=1']; const args = [];
  if (kw) { where.push('(j.title LIKE ? OR u.company_name LIKE ?)'); const like = `%${kw}%`; args.push(like, like); }
  if (['published', 'offline'].includes(status)) { where.push('j.status = ?'); args.push(status); }
  const [rows] = await pool.query(
    `SELECT j.id, j.title, j.location, j.salary_min, j.salary_max, j.status, j.is_top, j.is_urgent,
            j.view_count, j.created_at, u.company_name,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.deleted = 0) AS apply_count
     FROM jobs j JOIN users u ON u.id = j.company_id
     WHERE ${where.join(' AND ')} ORDER BY j.id DESC LIMIT 200`, args
  ); // 查询职位
  send(res, true, rows);
}));

// PATCH /api/admin/jobs/:id：管理员改职位状态或置顶/急招
app.patch('/api/admin/jobs/:id', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]); // 校验职位
  if (!rows.length) return send(res, false, '职位不存在');
  const { status, isTop, isUrgent } = req.body || {}; // 可改字段
  if (status && !['published', 'offline'].includes(status)) return send(res, false, '状态不合法');
  await pool.query(
    'UPDATE jobs SET status = COALESCE(?, status), is_top = COALESCE(?, is_top), is_urgent = COALESCE(?, is_urgent) WHERE id = ?',
    [status || null, isTop === undefined ? null : (isTop ? 1 : 0), isUrgent === undefined ? null : (isUrgent ? 1 : 0), req.params.id]
  ); // 更新
  send(res, true, '职位已更新');
}));

// DELETE /api/admin/jobs/:id：管理员删除职位及其投递记录
app.delete('/api/admin/jobs/:id', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM jobs WHERE id = ?', [req.params.id]); // 校验职位
  if (!rows.length) return send(res, false, '职位不存在');
  const jid = req.params.id;
  await transaction(async (db) => {
    await db.query('DELETE FROM app_events WHERE application_id IN (SELECT id FROM applications WHERE job_id = ?)', [jid]);
    await db.query('DELETE FROM applications WHERE job_id = ?', [jid]);
    await db.query('DELETE FROM interviews WHERE job_id = ?', [jid]);
    await db.query('DELETE FROM favorites WHERE job_id = ?', [jid]);
    await db.query('DELETE FROM jobs WHERE id = ?', [jid]);
  });
  send(res, true, '职位已删除');
}));

if (require.main === module) {
  init().then(() => {
    app.listen(PORT, () => {
      console.log(`add-work 招聘系统已启动： http://localhost:${PORT}`);
      console.log(`上传文件存储模式： ${FILE_MODE}`);
    });
  }).catch((err) => {
    console.error('数据库初始化失败：', err.message);
    process.exit(1);
  });
}

module.exports = app;
