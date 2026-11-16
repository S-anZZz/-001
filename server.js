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
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'");
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

// 上传文件访问：必须登录，且文件名只能是存储层里的合法名字
app.get('/uploads/:file', requireAuth(), wrap(async (req, res) => {
  const file = String(req.params.file || '');
  if (!SAFE_FILE.test(file) || file.includes('..')) return res.status(400).send('文件名不合法'); // 拒绝目录穿越
  const buffer = await getFile(file); // 从存储层读取文件内容
  if (!buffer) return res.status(404).send('文件不存在'); // 未命中直接返回 404
  const ext = path.extname(file).toLowerCase(); // 取扩展名
  res.type(ext || 'bin'); // 按扩展名设置 Content-Type
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file)}`); // 支持中文文件名
  res.setHeader('Cache-Control', 'private, max-age=600'); // 个人资料不进入共享缓存
  res.send(buffer); // 输出文件二进制内容
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

async function notify(userId, type, message) {
  await pool.query('INSERT INTO notifications (user_id, type, message) VALUES (?,?,?)', [userId, type, message]);
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
  const file = `${Date.now()}-${prefix}${safe}`; // 生成唯一文件名
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
  // 手机号与验证码校验：没有验证码不允许注册
  if (!/^1\d{10}$/.test(String(phone || ''))) return send(res, false, '请输入正确的手机号');
  const codeOk = await checkCode(phone, 'register', req.body.code); // 校验注册验证码
  if (!codeOk) return send(res, false, '手机验证码错误或已过期');
  const [phoneDup] = await pool.query('SELECT id FROM users WHERE phone = ?', [phone]); // 手机号唯一
  if (phoneDup.length) return send(res, false, '该手机号已注册');
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
    [username, hashPassword(password), role, name, companyName || null, phone || null, status, avatarPath, licensePath]
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
  if (user.status === 'pending') return send(res, false, '账号待管理员审核，暂不能登录'); // 企业待审核不可登录
  if (user.status !== 'active') return send(res, false, '账号已被停用'); // 停用账号不可登录
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

app.post('/api/logout', requireAuth(), wrap(async (req, res) => {
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); // 取请求头令牌
  const token = header || parseCookies(req).sid || ''; // 或取 Cookie 令牌
  if (token) await pool.query('DELETE FROM sessions WHERE token = ?', [token]); // 只注销当前会话，其他设备不受影响
  res.clearCookie('sid', { path: '/' }); // 清除 Cookie
  send(res, true, null); // 返回成功
}));

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
  const page = Math.max(1, Number(req.query.page) || 1); // 页码，最小为 1
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 10)); // 每页条数，限制 1~50
  const where = []; // 动态条件集合
  const args = []; // 条件参数集合
  if (keyword) { where.push('(j.title LIKE ? OR j.requirements LIKE ?)'); args.push(`%${keyword}%`, `%${keyword}%`); } // 关键词匹配职位或要求
  if (location) { where.push('j.location = ?'); args.push(location); } // 按地点筛选
  if (minSalary) { where.push('j.salary_max >= ?'); args.push(+minSalary); } // 期望下限：职位上限不低于期望
  if (maxSalary) { where.push('j.salary_min <= ?'); args.push(+maxSalary); } // 期望上限：职位下限不高于期望，形成区间重叠
  if (education) { where.push('j.education = ?'); args.push(education); } // 按学历筛选
  if (experience) { where.push('j.experience = ?'); args.push(experience); } // 按经验筛选
  const base = `FROM jobs j JOIN users u ON u.id = j.company_id WHERE j.status = 'published'`
    + (where.length ? ' AND ' + where.join(' AND ') : ''); // 公共 FROM 与 WHERE
  const [countRows] = await pool.query(`SELECT COUNT(*) AS total ${base}`, args); // 统计总数用于分页
  const total = countRows[0].total; // 总条数
  if (sort === 'match' && req.user && req.user.role === 'seeker') {
    // 相关度排序：取有主简历的求职者，按匹配分排序后再分页
    const [resumes] = await pool.query('SELECT * FROM resumes WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1', [req.user.id]);
    const resume = resumes[0];
    if (resume) {
      const [all] = await pool.query(
        `SELECT j.*, u.company_name AS company, u.verified ${base} ORDER BY j.is_top DESC, j.id DESC LIMIT 300`, args
      ); // 先取候选集
      const scored = all.map((j) => ({ ...j, match: matchScore(resume, j) })) // 计算匹配度
        .sort((a, b) => (b.is_top - a.is_top) || (b.match.score - a.match.score)); // 置顶优先，其次匹配度
      const slice = scored.slice((page - 1) * pageSize, page * pageSize); // 分页
      return send(res, true, { list: slice, total: scored.length, page, pageSize, pages: Math.max(1, Math.ceil(scored.length / pageSize)) });
    }
  }
  const [rows] = await pool.query(
    `SELECT j.*, u.company_name AS company, u.verified,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS apply_count
     ${base} ORDER BY j.is_top DESC, COALESCE(j.refreshed_at, j.created_at) DESC, j.id DESC LIMIT ? OFFSET ?`,
    [...args, pageSize, (page - 1) * pageSize]
  ); // 分页查询当前页数据（置顶优先、刷新时间排序）
  send(res, true, { list: rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) }); // 返回列表与分页信息
}));

app.get('/api/jobs/mine', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE company_id = ? ORDER BY id DESC LIMIT 200', [req.user.id]); // 查询该企业的职位（上限 200 条）
  send(res, true, rows); // 返回职位列表
}));

// 企业端：发布新职位，直接进入职位库（按最新需求，发布无需管理员审核）
app.post('/api/jobs', requireAuth(['company']), wrap(async (req, res) => {
  const { title, requirements, location, salaryMin, salaryMax, education, experience } = req.body || {}; // 解析职位参数
  if (!title) return send(res, false, '职位标题必填'); // 标题必填校验
  if (salaryMin && salaryMax && Number(salaryMin) > Number(salaryMax)) return send(res, false, '最低薪资不能高于最高薪资'); // 薪资区间校验
  const [info] = await pool.query(
    `INSERT INTO jobs (company_id, title, requirements, location, salary_min, salary_max, education, experience, status)
     VALUES (?,?,?,?,?,?,?,?, 'published')`,
    [req.user.id, title, requirements || '', location || '', salaryMin || null, salaryMax || null, education || '', experience || '']
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
  const { title, requirements, location, salaryMin, salaryMax, education, experience } = req.body || {}; // 解析修改内容
  if (!title) return send(res, false, '职位标题必填'); // 标题必填
  if (salaryMin && salaryMax && Number(salaryMin) > Number(salaryMax)) return send(res, false, '最低薪资不能高于最高薪资'); // 薪资区间校验
  await pool.query(
    `UPDATE jobs SET title=?, requirements=?, location=?, salary_min=?, salary_max=?, education=?, experience=?
     WHERE id=?`,
    [title, requirements || '', location || '', salaryMin || null, salaryMax || null, education || '', experience || '', req.params.id]
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
  const [jobRows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]); // 查询职位
  const job = jobRows[0]; // 取职位
  if (!job || job.status !== 'published') return send(res, false, '职位不存在或未发布'); // 校验职位状态
  let resume;
  if (req.body && req.body.resumeId) { // 指定了某一份简历
    const [rows] = await pool.query('SELECT * FROM resumes WHERE id = ? AND user_id = ?', [req.body.resumeId, req.user.id]);
    resume = rows[0];
  } else { // 未指定则使用主简历
    const [rows] = await pool.query('SELECT * FROM resumes WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1', [req.user.id]);
    resume = rows[0];
  }
  if (!resume) return send(res, false, '请先创建简历后再投递'); // 无简历不可投递
  const [dup] = await pool.query('SELECT id FROM applications WHERE resume_id=? AND job_id=?', [resume.id, job.id]); // 查重
  if (dup.length) return send(res, false, '已投递过该职位'); // 重复投递提示
  const { score, reasons } = matchScore(resume, job); // 计算匹配分与理由
  let info;
  try {
    [info] = await pool.query(
      `INSERT INTO applications (resume_id, job_id, seeker_id, company_id, status, match_score, match_reasons)
       VALUES (?,?,?,?,'submitted',?,?)`,
      [resume.id, job.id, req.user.id, job.company_id, score, reasons]
    ); // 插入投递记录
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return send(res, false, '已投递过该职位'); // 并发重复投递由唯一索引拦截
    throw e; // 其他异常继续上抛
  }
  await notify(job.company_id, 'application', `收到新简历：${resume.name} 投递了「${job.title}」（匹配分 ${score}）`);
  await pool.query(
    'INSERT INTO app_events (application_id, actor_id, action, detail) VALUES (?,?,?,?)',
    [info.insertId, req.user.id, 'submitted', `投递简历「${resume.title || '我的简历'}」，匹配分 ${score}`]
  ); // 记录投递轨迹
  send(res, true, { id: info.insertId, score, reasons });
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
            r.attachment_name, r.attachment_path,
            j.title AS job_title
     FROM applications a JOIN resumes r ON r.id = a.resume_id
     JOIN jobs j ON j.id = a.job_id
     WHERE a.company_id = ? ORDER BY a.id DESC LIMIT 200`,
    [req.user.id]
  ); // 查询企业收到的投递（上限 200 条）
  send(res, true, rows); // 返回投递列表
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
  const [rows] = await pool.query('SELECT * FROM applications WHERE id = ?', [req.params.id]); // 查询投递记录
  const app_ = rows[0]; // 取投递记录
  if (!app_ || app_.company_id !== req.user.id) return send(res, false, '投递记录不存在或无权限'); // 校验归属
  const { scheduledAt, mode, note } = req.body || {}; // 面试时间、方式、备注
  if (!scheduledAt) return send(res, false, '请选择面试时间'); // 时间必填
  const meeting = createMeeting({ provider: req.body.provider || 'tencent', topic: '面试邀约', userId: app_.seeker_id }); // 生成会议链接
  await pool.query("UPDATE applications SET status='interview', meeting_link=?, updated_at=NOW() WHERE id=?", [meeting.url, req.params.id]); // 保存会议链接并更新状态
  await pool.query(
    `INSERT INTO interviews (application_id, job_id, seeker_id, company_id, scheduled_at, mode, link, status)
     VALUES (?,?,?,?,?,?,?, 'pending')`,
    [app_.id, app_.job_id, app_.seeker_id, app_.company_id, new Date(scheduledAt), mode === 'offline' ? 'offline' : 'online', meeting.url]
  ); // 创建待确认的面试邀约
  await pool.query(
    'INSERT INTO app_events (application_id, actor_id, action, detail) VALUES (?,?,?,?)',
    [app_.id, req.user.id, 'interview', `发起面试邀约：${String(scheduledAt).replace('T', ' ')}`]
  ); // 记录轨迹
  const [jobRows] = await pool.query('SELECT title FROM jobs WHERE id=?', [app_.job_id]); // 查询职位标题
  const title = jobRows[0].title; // 取职位标题
  await notify(app_.seeker_id, 'interview',
    `收到「${title}」面试邀约，时间 ${String(scheduledAt).replace('T', ' ')}，${mode === 'offline' ? '线下面试' : '会议平台：' + meeting.providerName + '，入会链接：' + meeting.url}${note ? '，备注：' + note : ''}`); // 通知求职者
  send(res, true, meeting); // 返回会议信息
}));

// 发起交换联系方式请求
app.post('/api/contact/request', requireAuth(), wrap(async (req, res) => {
  const { toUserId, jobId } = req.body || {}; // 解析请求参数
  if (!toUserId) return send(res, false, '请选择接收方'); // 接收方必填
  const [target] = await pool.query('SELECT * FROM users WHERE id = ?', [toUserId]); // 查询接收方
  if (!target.length) return send(res, false, '接收方不存在'); // 校验接收方存在
  const [dup] = await pool.query(
    'SELECT id FROM contact_requests WHERE from_user_id=? AND to_user_id=? AND status=?',
    [req.user.id, toUserId, 'pending']
  ); // 查询是否有待处理的重复请求
  if (dup.length) return send(res, false, '已有待处理的请求，请等待回复'); // 重复请求提示
  await pool.query('INSERT INTO contact_requests (from_user_id, to_user_id, job_id) VALUES (?,?,?)', [req.user.id, toUserId, jobId || null]); // 插入请求
  await notify(toUserId, 'contact', `${req.user.name} 请求交换联系方式`); // 通知接收方
  send(res, true, '联系方式交换请求已发送'); // 返回提示
}));

// 查看联系方式请求（收到的待处理 + 已发送）
app.get('/api/contact/requests', requireAuth(), wrap(async (req, res) => {
  const [mine] = await pool.query(
    `SELECT cr.*, u.name AS user_name, u.company_name, u.role
     FROM contact_requests cr JOIN users u ON u.id = cr.from_user_id
     WHERE cr.to_user_id = ? AND cr.status = 'pending' ORDER BY cr.id DESC LIMIT 100`,
    [req.user.id]
  ); // 查询收到的待处理请求
  const [sent] = await pool.query(
    `SELECT cr.*, u.name AS user_name, u.company_name, u.role
     FROM contact_requests cr JOIN users u ON u.id = cr.to_user_id
     WHERE cr.from_user_id = ? ORDER BY cr.id DESC LIMIT 100`,
    [req.user.id]
  ); // 查询已发送的请求
  send(res, true, { received: mine, sent }); // 返回两组数据
}));

// 回复联系方式请求（同意/拒绝）
// 站内聊天：读取与某人的会话记录（同时把对方发来的消息标记为已读）
app.get('/api/messages/:userId', requireAuth(), wrap(async (req, res) => {
  const peerId = Number(req.params.userId); // 对方用户主键
  if (!peerId) return send(res, false, '对方不存在'); // 参数校验
  const [peer] = await pool.query('SELECT id, name, company_name, role FROM users WHERE id = ?', [peerId]); // 只取公开信息，手机号不随会话返回
  if (!peer.length) return send(res, false, '对方不存在'); // 校验对方存在
  const [rows] = await pool.query(
    `SELECT id, from_user_id, to_user_id, content, created_at
     FROM messages
     WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
     ORDER BY id ASC LIMIT 200`,
    [req.user.id, peerId, peerId, req.user.id]
  ); // 查询双向会话，按时间正序
  await pool.query('UPDATE messages SET is_read = 1 WHERE to_user_id = ? AND from_user_id = ?', [req.user.id, peerId]); // 进入会话即标记已读
  send(res, true, { peer: peer[0], messages: rows }); // 返回对方信息与消息列表
}));

// 站内聊天：发送消息
app.post('/api/messages', requireAuth(), wrap(async (req, res) => {
  const { toUserId, content, jobId } = req.body || {}; // 解析接收方、内容与关联职位
  const text = String(content || '').trim(); // 去掉首尾空白
  if (!toUserId) return send(res, false, '请选择接收方'); // 接收方必填
  if (!text) return send(res, false, '请输入消息内容'); // 内容必填
  if (text.length > 500) return send(res, false, '消息过长（最多 500 字）'); // 长度限制
  const [peer] = await pool.query('SELECT id, name FROM users WHERE id = ?', [toUserId]); // 查询接收方
  if (!peer.length) return send(res, false, '对方不存在'); // 校验接收方存在
  const [info] = await pool.query(
    'INSERT INTO messages (from_user_id, to_user_id, job_id, content) VALUES (?,?,?,?)',
    [req.user.id, toUserId, jobId || null, text]
  ); // 写入消息
  await notify(toUserId, 'message', `${req.user.name}${req.user.company_name ? '（' + req.user.company_name + '）' : ''} 给你发来一条消息`); // 站内通知对方
  const [rows] = await pool.query('SELECT id, from_user_id, to_user_id, content, created_at FROM messages WHERE id = ?', [info.insertId]); // 取回新消息
  send(res, true, rows[0]); // 返回新消息
}));

app.post('/api/contact/requests/:id/respond', requireAuth(), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM contact_requests WHERE id = ?', [req.params.id]); // 查询请求
  const reqRow = rows[0]; // 取请求
  if (!reqRow || reqRow.to_user_id !== req.user.id) return send(res, false, '请求不存在或无权限'); // 校验归属
  const accept = req.body && req.body.accept; // 解析是否同意
  const [from] = await pool.query('SELECT name, phone, company_name FROM users WHERE id=?', [reqRow.from_user_id]); // 查询请求发起方信息
  const fromUser = from[0]; // 取发起方
  await pool.query("UPDATE contact_requests SET status=? WHERE id=?", [accept ? 'accepted' : 'rejected', req.params.id]); // 更新请求状态
  if (accept) { // 同意时交换联系方式
    const msg = `联系方式已交换：${fromUser.name}${fromUser.company_name ? '（' + fromUser.company_name + '）' : ''}，电话 ${fromUser.phone || '未填写'}`; // 组装交换信息
    await notify(reqRow.from_user_id, 'contact', msg); // 通知发起方
    send(res, true, { message: '已同意，联系方式已告知对方' }); // 返回提示
  } else { // 拒绝
    send(res, true, '已拒绝该请求'); // 返回提示
  }
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
    "SELECT id, username, name, company_name, phone, status, license_path, avatar_path, created_at FROM users WHERE role='company' ORDER BY id DESC LIMIT 200"
  ); // 查询所有企业用户
  send(res, true, rows); // 返回企业列表
}));

// 管理员：通过企业注册审核
app.post('/api/admin/companies/:id/approve', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM users WHERE id=? AND role='company'", [req.params.id]); // 查询企业用户
  if (!rows.length) return send(res, false, '企业不存在'); // 校验存在性
  await pool.query("UPDATE users SET status='active', verified=1 WHERE id=?", [req.params.id]); // 置为已通过并打认证标记
  await notify(req.params.id, 'approve', '企业注册已通过审核，可以登录并发布职位'); // 通知企业
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
    `SELECT f.id AS fav_id, j.*, u.company_name AS company
     FROM favorites f JOIN jobs j ON j.id = f.job_id JOIN users u ON u.id = j.company_id
     WHERE f.user_id = ? ORDER BY f.id DESC LIMIT 200`, [req.user.id]
  ); // 联表取职位信息
  send(res, true, rows); // 返回收藏列表
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

// GET /api/interviews/mine：求职者的面试邀约
app.get('/api/interviews/mine', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT i.*, j.title AS job_title, u.company_name AS company
     FROM interviews i LEFT JOIN jobs j ON j.id = i.job_id LEFT JOIN users u ON u.id = i.company_id
     WHERE i.seeker_id = ? ORDER BY i.id DESC LIMIT 100`, [req.user.id]
  ); // 联表取职位与企业名
  send(res, true, rows); // 返回面试列表
}));

// POST /api/interviews/:id/respond：求职者确认 / 拒绝 / 改约
app.post('/api/interviews/:id/respond', requireAuth(['seeker']), wrap(async (req, res) => {
  const { action, note, newTime } = req.body || {}; // 动作、备注、改约时间
  const [rows] = await pool.query('SELECT * FROM interviews WHERE id = ? AND seeker_id = ?', [req.params.id, req.user.id]); // 校验归属
  const itv = rows[0];
  if (!itv) return send(res, false, '面试邀约不存在或无权限', 403);
  if (!['confirm', 'decline', 'reschedule'].includes(action)) return send(res, false, '操作不合法'); // 动作白名单
  const map = { confirm: 'confirmed', decline: 'declined', reschedule: 'rescheduled' }; // 状态映射
  if (action === 'reschedule') {
    if (!newTime) return send(res, false, '请选择改约时间'); // 改约必须给时间
    await pool.query('UPDATE interviews SET status=?, scheduled_at=?, seeker_note=? WHERE id=?',
      [map[action], new Date(newTime), note || null, itv.id]); // 更新为新时间
  } else {
    await pool.query('UPDATE interviews SET status=?, seeker_note=? WHERE id=?', [map[action], note || null, itv.id]);
  }
  await pool.query('INSERT INTO app_events (application_id, actor_id, action, detail) VALUES (?,?,?,?)',
    [itv.application_id, req.user.id, 'interview_' + action, note || '']); // 记录轨迹
  const text = { confirm: '已确认', decline: '已拒绝', reschedule: '申请改约至 ' + String(newTime || '').replace('T', ' ') }[action]; // 通知文案
  await notify(itv.company_id, 'interview', `候选人${text}`); // 通知企业
  send(res, true, '已提交'); // 返回结果
}));

// ===================== 账号体系：手机验证码 / 找回密码 =====================

// genCode：生成 6 位数字验证码
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// saveCode：把验证码写入 sms_codes，5 分钟有效
async function saveCode(phone, purpose) {
  const code = genCode(); // 生成验证码
  await pool.query(
    'INSERT INTO sms_codes (phone, code, purpose, expires_at) VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
    [phone, code, purpose]
  ); // 落库
  return code; // 返回验证码（演示环境直接回显）
}

// checkCode：校验验证码并标记已用
async function checkCode(phone, purpose, code) {
  const [rows] = await pool.query(
    `SELECT id FROM sms_codes WHERE phone = ? AND purpose = ? AND code = ? AND used = 0 AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    [phone, purpose, String(code || '')]
  ); // 查未使用且未过期的验证码
  if (!rows.length) return false; // 校验失败
  await pool.query('UPDATE sms_codes SET used = 1 WHERE id = ?', [rows[0].id]); // 标记已用，防止重放
  return true; // 校验通过
}

// POST /api/auth/code：发送验证码（演示环境不下发短信，直接把验证码返回给前端）
app.post('/api/auth/code', wrap(async (req, res) => {
  const { phone, purpose } = req.body || {}; // 手机号与用途
  if (!/^1\d{10}$/.test(String(phone || ''))) return send(res, false, '请输入正确的手机号'); // 格式校验
  if (!['register', 'reset'].includes(purpose)) return send(res, false, '用途不合法'); // 用途白名单
  if (purpose === 'register') { // 注册时要保证手机号没被占用
    const [dup] = await pool.query('SELECT id FROM users WHERE phone = ?', [phone]);
    if (dup.length) return send(res, false, '该手机号已注册');
  }
  const code = await saveCode(phone, purpose); // 生成并保存
  send(res, true, { phone, code, tip: '演示环境未接入短信网关，验证码直接返回' }); // 返回验证码
}));

// POST /api/auth/forgot：忘记密码，给注册手机号发送验证码
app.post('/api/auth/forgot', wrap(async (req, res) => {
  const { username } = req.body || {}; // 用户名
  const [rows] = await pool.query('SELECT id, phone FROM users WHERE username = ?', [username || '']); // 查用户
  const user = rows[0];
  if (!user || !user.phone) return send(res, false, '该账号未绑定手机号，请联系管理员重置'); // 没有手机号无法自助找回
  const code = await saveCode(user.phone, 'reset'); // 生成重置验证码
  const masked = String(user.phone).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'); // 手机号脱敏
  send(res, true, { phone: masked, code, tip: '演示环境未接入短信网关，验证码直接返回' }); // 返回验证码
}));

// POST /api/auth/reset：用验证码重置密码
app.post('/api/auth/reset', wrap(async (req, res) => {
  const { username, code, newPassword } = req.body || {}; // 参数
  if (!newPassword || newPassword.length < 4 || newPassword.length > 8) {
    return send(res, false, '密码需为 4~8 位'); // 长度校验
  }
  const [rows] = await pool.query('SELECT id, phone FROM users WHERE username = ?', [username || '']); // 查用户
  const user = rows[0];
  if (!user) return send(res, false, '账号不存在'); // 账号校验
  if (!(await checkCode(user.phone, 'reset', code))) return send(res, false, '验证码错误或已过期'); // 验证码校验
  await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashPassword(newPassword), user.id]); // 更新密码
  await pool.query('DELETE FROM sessions WHERE user_id = ?', [user.id]); // 吊销所有旧会话
  send(res, true, '密码已重置，请重新登录'); // 返回结果
}));

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
  if (!companyName) return send(res, false, '公司名称不能为空'); // 必填
  let avatarPath = null;
  if (b.avatarBase64) avatarPath = await saveImage(b.avatarName || 'avatar.png', b.avatarBase64); // 可选头像
  await pool.query(
    `UPDATE users SET company_name=?, name=?, phone=?, company_intro=?, company_industry=?,
       company_size=?, company_address=?, avatar_path=COALESCE(?, avatar_path) WHERE id=?`,
    [companyName, String(b.contact || '').trim().slice(0, 64), String(b.phone || '').trim().slice(0, 32),
     String(b.intro || '').slice(0, 2000), String(b.industry || '').slice(0, 32),
     String(b.size || '').slice(0, 32), String(b.address || '').slice(0, 64), avatarPath, req.user.id]
  ); // 更新资料
  send(res, true, '企业资料已更新'); // 返回结果
}));

// GET /api/company/:id：企业主页（求职者可见的公开信息）
app.get('/api/company/:id', requireAuth(), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, company_name, company_intro, company_industry, company_size, company_address, verified, name
     FROM users WHERE id = ? AND role = 'company'`, [req.params.id]
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
     WHERE j.status = 'published' ORDER BY j.id DESC LIMIT 200`
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
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]); // 当前职位
  const job = rows[0];
  if (!job) return send(res, false, '职位不存在');
  const [list] = await pool.query(
    `SELECT j.*, u.company_name AS company FROM jobs j JOIN users u ON u.id = j.company_id
     WHERE j.status = 'published' AND j.id <> ? AND (j.location = ? OR j.title LIKE ?)
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
  const cell = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`; // CSV 转义
  const csv = '\uFEFF' + [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n'); // 加 BOM 便于 Excel 识别中文
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="addwork-${type}.csv"`);
  res.send(csv); // 输出 CSV
}));

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

// 服务启动：先初始化数据库与种子数据，再监听端口
init().then(() => {
  app.listen(PORT, () => {
    console.log(`add-work 招聘系统已启动： http://localhost:${PORT}`); // 输出启动地址
    console.log(`上传文件存储模式： ${FILE_MODE}`); // 输出当前存储模式，便于排查文件丢失问题
  });
}).catch((err) => {
  console.error('数据库初始化失败：', err.message); // 输出初始化错误
  process.exit(1); // 初始化失败则退出进程
});
