const express = require('express');
const path = require('path');
const { pool, init, hashPassword, newToken } = require('./db');
const { putFile, getFile, MODE: FILE_MODE } = require('./storage');
const { matchScore } = require('./match');
const { createMeeting } = require('./meeting');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 上传文件访问路由：按文件名从存储层取内容，磁盘模式与数据库模式走同一入口
app.get('/uploads/:file', (req, res) => {
  getFile(req.params.file).then((buffer) => { // 从存储层读取文件内容
    if (!buffer) return res.status(404).send('文件不存在'); // 未命中直接返回 404
    res.type(path.extname(req.params.file) || 'bin'); // 按扩展名设置 Content-Type，浏览器才会正确渲染图片
    res.send(buffer); // 输出文件二进制内容
  }).catch(() => res.status(500).send('读取失败')); // 读取出错返回 500
});

function send(res, ok, data) {
  res.status(ok ? 200 : 400).json({ ok, data });
}

function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(err);
      send(res, false, '服务器错误：' + (err.message || err));
    });
  };
}

async function currentUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const [rows] = await pool.query('SELECT * FROM users WHERE token = ?', [token]);
  return rows[0] || null;
}

function requireAuth(roles) {
  return wrap(async (req, res, next) => {
    const user = await currentUser(req);
    if (!user) return send(res, false, '请先登录');
    if (roles && !roles.includes(user.role)) return send(res, false, '无权限');
    req.user = user;
    next();
  });
}

async function notify(userId, type, message) {
  await pool.query('INSERT INTO notifications (user_id, type, message) VALUES (?,?,?)', [userId, type, message]);
}

// 允许上传的头像格式
const AVATAR_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

// saveImage：把前端传来的 base64 头像写入存储层，返回文件名
async function saveImage(name, base64) {
  if (!name) return null; // 未选择头像则跳过
  const ext = (name.split('.').pop() || '').toLowerCase(); // 取文件扩展名
  if (!AVATAR_EXT.includes(ext)) throw Object.assign(new Error('头像仅支持 png/jpg/gif/webp'), { status: 400 });
  const safe = name.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_'); // 过滤非法文件名字符
  const file = `${Date.now()}-${safe}`; // 生成唯一文件名，避免覆盖
  return putFile(file, Buffer.from(base64, 'base64')); // 写入存储层（磁盘或数据库）
}

app.post('/api/register', wrap(async (req, res) => {
  // 解析注册参数：用户名、密码、角色、姓名、企业名、电话、头像、经营许可证
  const { username, password, role, name, companyName, phone, avatarName, avatarBase64, licenseName, licenseBase64 } = req.body || {};
  // 必填项校验：用户名、密码、姓名不能为空
  if (!username || !password || !name) return send(res, false, '用户名、密码、姓名必填');
  // 密码长度校验：4~8 位之间
  if (password.length < 4 || password.length > 8) return send(res, false, '密码需为 4~8 位');
  // 角色校验：只允许求职者或企业
  if (!['seeker', 'company'].includes(role)) return send(res, false, '角色不合法');
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

app.post('/api/login', wrap(async (req, res) => {
  // 登录接口：校验用户名密码并签发登录令牌
  const { username, password } = req.body || {}; // 解析登录参数
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username || '']); // 按用户名查询用户
  const user = rows[0]; // 取查询结果
  if (!user || user.password !== hashPassword(password || '')) return send(res, false, '用户名或密码错误'); // 校验密码
  if (user.status === 'pending') return send(res, false, '账号待管理员审核，暂不能登录'); // 企业待审核不可登录
  if (user.status !== 'active') return send(res, false, '账号已被停用'); // 停用账号不可登录
  const token = newToken(); // 生成登录令牌
  await pool.query('UPDATE users SET token = ? WHERE id = ?', [token, user.id]); // 保存令牌
  const { password: _p, password_hash: _ph, ...safe } = user; // 去掉密码字段
  send(res, true, { user: safe, token }); // 返回用户信息与令牌
}));

app.post('/api/logout', requireAuth(), wrap(async (req, res) => {
  await pool.query('UPDATE users SET token = NULL WHERE id = ?', [req.user.id]); // 清空登录令牌
  send(res, true, null); // 返回成功
}));

app.get('/api/me', requireAuth(), wrap(async (req, res) => {
  const { password, token, ...safe } = req.user; // 去掉敏感字段
  send(res, true, safe); // 返回当前用户信息
}));

// 简历附件允许的格式：PDF 与 Word
const ALLOWED_EXT = ['pdf', 'doc', 'docx'];

// saveAttachment：保存简历附件并返回文件名
async function saveAttachment(name, base64) {
  if (!name) return null; // 未选择附件则跳过
  const ext = (name.split('.').pop() || '').toLowerCase(); // 取文件扩展名
  if (!ALLOWED_EXT.includes(ext)) throw Object.assign(new Error('仅支持 PDF / Word 附件'), { status: 400 });
  const safe = name.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_'); // 过滤非法文件名字符
  const file = `${Date.now()}-${safe}`; // 生成唯一文件名
  return putFile(file, Buffer.from(base64, 'base64')); // 写入存储层（磁盘或数据库）
}

// 企业经营许可证允许的格式：PDF、Word 与图片
const LICENSE_EXT = ['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg'];

// saveLicense：保存企业注册时上传的经营许可证并返回文件名
async function saveLicense(name, base64) {
  if (!name) return null; // 未上传许可证则跳过
  const ext = (name.split('.').pop() || '').toLowerCase(); // 取文件扩展名
  if (!LICENSE_EXT.includes(ext)) throw Object.assign(new Error('经营许可证仅支持 PDF / Word / 图片'), { status: 400 });
  const safe = name.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_'); // 过滤非法文件名字符
  const file = `${Date.now()}-license-${safe}`; // 生成唯一文件名，避免覆盖
  return putFile(file, Buffer.from(base64, 'base64')); // 写入存储层（磁盘或数据库）
}

// 获取当前求职者的简历
app.get('/api/resume/mine', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM resumes WHERE user_id = ?', [req.user.id]); // 查询当前用户简历
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
       attachment_name=?, attachment_path=COALESCE(?, attachment_path) WHERE user_id=?`,
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
  const { keyword, location, minSalary, education, experience } = req.query; // 解析筛选条件
  let sql = `SELECT j.*, u.name AS company_name, u.company_name AS company
             FROM jobs j JOIN users u ON u.id = j.company_id WHERE j.status = 'published'`; // 查询已发布职位
  const where = []; // 动态条件集合
  const args = []; // 条件参数集合
  if (keyword) { where.push('(j.title LIKE ? OR j.requirements LIKE ?)'); args.push(`%${keyword}%`, `%${keyword}%`); } // 关键词匹配职位或要求
  if (location) { where.push('j.location = ?'); args.push(location); } // 按地点筛选
  if (minSalary) { where.push('j.salary_max >= ?'); args.push(+minSalary); } // 按最低薪资筛选
  if (education) { where.push('j.education = ?'); args.push(education); } // 按学历筛选
  if (experience) { where.push('j.experience = ?'); args.push(experience); } // 按经验筛选
  if (where.length) sql += ' AND ' + where.join(' AND '); // 拼接动态条件
  sql += ' ORDER BY j.id DESC'; // 按最新排序
  const [rows] = await pool.query(sql, args); // 执行查询
  send(res, true, rows); // 返回职位列表
}));

// 企业端：查看自己发布的职位
app.get('/api/jobs/mine', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE company_id = ? ORDER BY id DESC', [req.user.id]); // 查询该企业的职位
  send(res, true, rows); // 返回职位列表
}));

// 企业端：发布新职位，直接进入职位库（按最新需求，发布无需管理员审核）
app.post('/api/jobs', requireAuth(['company']), wrap(async (req, res) => {
  const { title, requirements, location, salaryMin, salaryMax, education, experience } = req.body || {}; // 解析职位参数
  if (!title) return send(res, false, '职位标题必填'); // 标题必填校验
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
  if (job.status === 'unpublished') return send(res, false, '职位已下架，请先重新上架后再修改'); // 已下架职位不可直接修改
  const { title, requirements, location, salaryMin, salaryMax, education, experience } = req.body || {}; // 解析修改内容
  await pool.query(
    `UPDATE jobs SET title=?, requirements=?, location=?, salary_min=?, salary_max=?, education=?, experience=?, status='published'
     WHERE id=?`,
    [title, requirements || '', location || '', salaryMin || null, salaryMax || null, education || '', experience || '', req.params.id]
  ); // 更新职位内容并保持已发布状态
  send(res, true, '职位已更新'); // 返回提示
}));

// 企业端：下架职位
app.patch('/api/jobs/:id/unpublish', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]); // 查询职位
  const job = rows[0]; // 取职位
  if (!job || job.company_id !== req.user.id) return send(res, false, '职位不存在或无权限'); // 校验归属
  await pool.query("UPDATE jobs SET status='unpublished' WHERE id=?", [req.params.id]); // 置为已下架
  send(res, true, '职位已下架'); // 返回提示
}));

// 求职者：投递职位，计算匹配分并生成匹配理由
app.post('/api/jobs/:id/apply', requireAuth(['seeker']), wrap(async (req, res) => {
  const [jobRows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]); // 查询职位
  const job = jobRows[0]; // 取职位
  if (!job || job.status !== 'published') return send(res, false, '职位不存在或未发布'); // 校验职位状态
  const [resumeRows] = await pool.query('SELECT * FROM resumes WHERE user_id = ?', [req.user.id]); // 查询当前用户简历
  const resume = resumeRows[0]; // 取简历
  if (!resume) return send(res, false, '请先创建简历后再投递'); // 无简历不可投递
  const [dup] = await pool.query('SELECT id FROM applications WHERE resume_id=? AND job_id=?', [resume.id, job.id]); // 查重
  if (dup.length) return send(res, false, '已投递过该职位'); // 重复投递提示
  const { score, reasons } = matchScore(resume, job); // 计算匹配分与理由
  const [info] = await pool.query(
    `INSERT INTO applications (resume_id, job_id, seeker_id, company_id, status, match_score, match_reasons)
     VALUES (?,?,?,?,'submitted',?,?)`,
    [resume.id, job.id, req.user.id, job.company_id, score, reasons]
  ); // 插入投递记录
  await notify(job.company_id, 'application', `收到新简历：${resume.name} 投递了「${job.title}」（匹配分 ${score}）`);
  send(res, true, { id: info.insertId, score, reasons });
}));

// 求职者：查看我的投递记录（关联职位与企业信息）
app.get('/api/applications/mine', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, j.title AS job_title, j.location, j.salary_min, j.salary_max,
            u.company_name AS company_name
     FROM applications a JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = a.company_id
     WHERE a.seeker_id = ? ORDER BY a.id DESC`,
    [req.user.id]
  ); // 查询当前求职者的投递列表
  send(res, true, rows); // 返回投递记录
}));

// 企业端：查看收到的简历（关联候选人简历信息）
app.get('/api/applications/received', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, r.name AS candidate, r.skills, r.experience, r.education,
            j.title AS job_title
     FROM applications a JOIN resumes r ON r.id = a.resume_id
     JOIN jobs j ON j.id = a.job_id
     WHERE a.company_id = ? ORDER BY a.id DESC`,
    [req.user.id]
  ); // 查询企业收到的投递
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
  await notify(app_.seeker_id, 'application', `「${title}」投递状态更新为：${{ viewed: '已查看', interview: '邀面试', accepted: '已录用', rejected: '未通过' }[status]}`); // 通知求职者
  send(res, true, '状态已更新'); // 返回提示
}));

// 企业端：发送面试邀约，生成会议链接并通知求职者
app.post('/api/applications/:id/interview', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM applications WHERE id = ?', [req.params.id]); // 查询投递记录
  const app_ = rows[0]; // 取投递记录
  if (!app_ || app_.company_id !== req.user.id) return send(res, false, '投递记录不存在或无权限'); // 校验归属
  const meeting = createMeeting({ provider: req.body.provider || 'tencent', topic: '面试邀约', userId: app_.seeker_id }); // 生成会议链接
  await pool.query("UPDATE applications SET status='interview', meeting_link=?, updated_at=NOW() WHERE id=?", [meeting.url, req.params.id]); // 保存会议链接并更新状态
  const [jobRows] = await pool.query('SELECT title FROM jobs WHERE id=?', [app_.job_id]); // 查询职位标题
  const title = jobRows[0].title; // 取职位标题
  await notify(app_.seeker_id, 'interview', `收到「${title}」面试邀约，会议平台：${meeting.providerName}，入会链接：${meeting.url}`); // 通知求职者
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
     WHERE cr.to_user_id = ? AND cr.status = 'pending' ORDER BY cr.id DESC`,
    [req.user.id]
  ); // 查询收到的待处理请求
  const [sent] = await pool.query(
    `SELECT cr.*, u.name AS user_name, u.company_name, u.role
     FROM contact_requests cr JOIN users u ON u.id = cr.to_user_id
     WHERE cr.from_user_id = ? ORDER BY cr.id DESC`,
    [req.user.id]
  ); // 查询已发送的请求
  send(res, true, { received: mine, sent }); // 返回两组数据
}));

// 回复联系方式请求（同意/拒绝）
// 站内聊天：读取与某人的会话记录（同时把对方发来的消息标记为已读）
app.get('/api/messages/:userId', requireAuth(), wrap(async (req, res) => {
  const peerId = Number(req.params.userId); // 对方用户主键
  if (!peerId) return send(res, false, '对方不存在'); // 参数校验
  const [peer] = await pool.query('SELECT id, name, company_name, phone, role FROM users WHERE id = ?', [peerId]); // 查询对方信息
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
  send(res, true, rows); // 返回通知列表
}));

// 管理员：查看企业注册列表
app.get('/api/admin/companies', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, username, name, company_name, phone, status, created_at FROM users WHERE role='company' ORDER BY id DESC"
  ); // 查询所有企业用户
  send(res, true, rows); // 返回企业列表
}));

// 管理员：通过企业注册审核
app.post('/api/admin/companies/:id/approve', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM users WHERE id=? AND role='company'", [req.params.id]); // 查询企业用户
  if (!rows.length) return send(res, false, '企业不存在'); // 校验存在性
  await pool.query("UPDATE users SET status='active' WHERE id=?", [req.params.id]); // 置为已通过
  await notify(req.params.id, 'approve', '企业注册已通过审核，可以登录并发布职位'); // 通知企业
  send(res, true, '企业注册已通过'); // 返回提示
}));

// 管理员：查看全部用户
app.get('/api/admin/users', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, username, role, name, company_name, phone, status, created_at FROM users ORDER BY id DESC'
  ); // 查询所有用户
  send(res, true, rows); // 返回用户列表
}));

// 管理员：更新用户状态（启用/停用等）
app.patch('/api/admin/users/:id/status', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]); // 查询用户
  const user = rows[0]; // 取用户
  if (!user || user.role === 'admin') return send(res, false, '用户不存在或不能修改管理员'); // 管理员不可修改
  const { status } = req.body || {}; // 解析目标状态
  if (!['active', 'pending', 'banned'].includes(status)) return send(res, false, '状态不合法'); // 校验状态合法性
  await pool.query('UPDATE users SET status=? WHERE id=?', [status, req.params.id]); // 更新用户状态
  send(res, true, '用户状态已更新'); // 返回提示
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
