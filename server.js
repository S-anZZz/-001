const express = require('express');
const path = require('path');
const fs = require('fs');
const { pool, init, hashPassword, newToken } = require('./db');
const { matchScore } = require('./match');
const { createMeeting } = require('./meeting');

const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

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
app.post('/api/register', wrap(async (req, res) => {
  const { username, password, role, name, companyName, phone } = req.body || {};
  if (!username || !password || !name) return send(res, false, '用户名、密码、姓名必填');
  if (!['seeker', 'company'].includes(role)) return send(res, false, '角色不合法');
  const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
  if (rows.length) return send(res, false, '用户名已存在');
  const status = role === 'company' ? 'pending' : 'active';
  const [info] = await pool.query(
    `INSERT INTO users (username, password, role, name, company_name, phone, status)
     VALUES (?,?,?,?,?,?,?)`,
    [username, hashPassword(password), role, name, companyName || null, phone || null, status]
  );
  const [users] = await pool.query(
    'SELECT id, username, role, name, company_name, phone, status FROM users WHERE id = ?',
    [info.insertId]
  );
  send(res, true, { user: users[0], message: role === 'company' ? '注册成功，等待管理员审核' : '注册成功，请登录' });
}));

app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username || '']);
  const user = rows[0];
  if (!user || user.password !== hashPassword(password || '')) return send(res, false, '用户名或密码错误');
  if (user.status === 'pending') return send(res, false, '账号待管理员审核，暂不能登录');
  if (user.status !== 'active') return send(res, false, '账号已被停用');
  const token = newToken();
  await pool.query('UPDATE users SET token = ? WHERE id = ?', [token, user.id]);
  const { password: _p, password_hash: _ph, ...safe } = user;
  send(res, true, { user: safe, token });
}));

app.post('/api/logout', requireAuth(), wrap(async (req, res) => {
  await pool.query('UPDATE users SET token = NULL WHERE id = ?', [req.user.id]);
  send(res, true, null);
}));

app.get('/api/me', requireAuth(), wrap(async (req, res) => {
  const { password, token, ...safe } = req.user;
  send(res, true, safe);
}));
const ALLOWED_EXT = ['pdf', 'doc', 'docx'];

function saveAttachment(name, base64) {
  if (!name) return null;
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw Object.assign(new Error('仅支持 PDF / Word 附件'), { status: 400 });
  const safe = name.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_');
  const file = `${Date.now()}-${safe}`;
  fs.writeFileSync(path.join(uploadsDir, file), Buffer.from(base64, 'base64'));
  return file;
}

app.get('/api/resume/mine', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM resumes WHERE user_id = ?', [req.user.id]);
  send(res, true, rows[0] || null);
}));

app.post('/api/resume', requireAuth(['seeker']), wrap(async (req, res) => {
  const { name, skills, experience, education, attachmentName, attachmentBase64 } = req.body || {};
  let attachmentPath = null;
  if (attachmentBase64) {
    try {
      attachmentPath = saveAttachment(attachmentName, attachmentBase64);
    } catch (e) {
      return send(res, false, e.message);
    }
  }
  const [existing] = await pool.query('SELECT id FROM resumes WHERE user_id = ?', [req.user.id]);
  if (existing.length) {
    await pool.query(
      `UPDATE resumes SET name=?, skills=?, experience=?, education=?,
       attachment_name=?, attachment_path=COALESCE(?, attachment_path) WHERE user_id=?`,
      [name, skills, experience, education, attachmentName || null, attachmentPath, req.user.id]
    );
  } else {
    await pool.query(
      `INSERT INTO resumes (user_id, name, skills, experience, education, attachment_name, attachment_path)
       VALUES (?,?,?,?,?,?,?)`,
      [req.user.id, name, skills, experience, education, attachmentName || null, attachmentPath]
    );
  }
  send(res, true, '简历已保存');
}));
app.get('/api/jobs', wrap(async (req, res) => {
  const { keyword, location, minSalary, education, experience } = req.query;
  let sql = `SELECT j.*, u.name AS company_name, u.company_name AS company
             FROM jobs j JOIN users u ON u.id = j.company_id WHERE j.status = 'published'`;
  const where = [];
  const args = [];
  if (keyword) { where.push('(j.title LIKE ? OR j.requirements LIKE ?)'); args.push(`%${keyword}%`, `%${keyword}%`); }
  if (location) { where.push('j.location = ?'); args.push(location); }
  if (minSalary) { where.push('j.salary_max >= ?'); args.push(+minSalary); }
  if (education) { where.push('j.education = ?'); args.push(education); }
  if (experience) { where.push('j.experience = ?'); args.push(experience); }
  if (where.length) sql += ' AND ' + where.join(' AND ');
  sql += ' ORDER BY j.id DESC';
  const [rows] = await pool.query(sql, args);
  send(res, true, rows);
}));

app.get('/api/jobs/mine', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE company_id = ? ORDER BY id DESC', [req.user.id]);
  send(res, true, rows);
}));

app.post('/api/jobs', requireAuth(['company']), wrap(async (req, res) => {
  const { title, requirements, location, salaryMin, salaryMax, education, experience } = req.body || {};
  if (!title) return send(res, false, '职位标题必填');
  const [info] = await pool.query(
    `INSERT INTO jobs (company_id, title, requirements, location, salary_min, salary_max, education, experience, status)
     VALUES (?,?,?,?,?,?,?,?, 'pending')`,
    [req.user.id, title, requirements || '', location || '', salaryMin || null, salaryMax || null, education || '', experience || '']
  );
  send(res, true, { id: info.insertId, message: '职位已提交，等待管理员审核' });
}));

app.patch('/api/jobs/:id', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
  const job = rows[0];
  if (!job || job.company_id !== req.user.id) return send(res, false, '职位不存在或无权限');
  if (['pending', 'rejected'].includes(job.status)) return send(res, false, '职位处于审核中或未通过，不能修改');
  const { title, requirements, location, salaryMin, salaryMax, education, experience } = req.body || {};
  await pool.query(
    `UPDATE jobs SET title=?, requirements=?, location=?, salary_min=?, salary_max=?, education=?, experience=?, status='pending'
     WHERE id=?`,
    [title, requirements || '', location || '', salaryMin || null, salaryMax || null, education || '', experience || '', req.params.id]
  );
  send(res, true, '职位已更新，重新进入审核');
}));

app.patch('/api/jobs/:id/unpublish', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
  const job = rows[0];
  if (!job || job.company_id !== req.user.id) return send(res, false, '职位不存在或无权限');
  await pool.query("UPDATE jobs SET status='unpublished' WHERE id=?", [req.params.id]);
  send(res, true, '职位已下架');
}));

app.post('/api/jobs/:id/approve', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
  if (!rows[0]) return send(res, false, '职位不存在');
  if (rows[0].status !== 'pending') return send(res, false, '该职位当前无需审核');
  await pool.query("UPDATE jobs SET status='published' WHERE id=?", [req.params.id]);
  send(res, true, '职位已通过审核并发布');
}));

app.post('/api/jobs/:id/reject', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
  if (!rows[0]) return send(res, false, '职位不存在');
  await pool.query("UPDATE jobs SET status='rejected' WHERE id=?", [req.params.id]);
  send(res, true, '职位未通过审核');
}));
app.post('/api/jobs/:id/apply', requireAuth(['seeker']), wrap(async (req, res) => {
  const [jobRows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
  const job = jobRows[0];
  if (!job || job.status !== 'published') return send(res, false, '职位不存在或未发布');
  const [resumeRows] = await pool.query('SELECT * FROM resumes WHERE user_id = ?', [req.user.id]);
  const resume = resumeRows[0];
  if (!resume) return send(res, false, '请先创建简历后再投递');
  const [dup] = await pool.query('SELECT id FROM applications WHERE resume_id=? AND job_id=?', [resume.id, job.id]);
  if (dup.length) return send(res, false, '已投递过该职位');
  const { score, reasons } = matchScore(resume, job);
  const [info] = await pool.query(
    `INSERT INTO applications (resume_id, job_id, seeker_id, company_id, status, match_score, match_reasons)
     VALUES (?,?,?,?,'submitted',?,?)`,
    [resume.id, job.id, req.user.id, job.company_id, score, reasons]
  );
  await notify(job.company_id, 'application', `收到新简历：${resume.name} 投递了「${job.title}」（匹配分 ${score}）`);
  send(res, true, { id: info.insertId, score, reasons });
}));

app.get('/api/applications/mine', requireAuth(['seeker']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, j.title AS job_title, j.location, j.salary_min, j.salary_max,
            u.company_name AS company_name
     FROM applications a JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = a.company_id
     WHERE a.seeker_id = ? ORDER BY a.id DESC`,
    [req.user.id]
  );
  send(res, true, rows);
}));

app.get('/api/applications/received', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, r.name AS candidate, r.skills, r.experience, r.education,
            j.title AS job_title
     FROM applications a JOIN resumes r ON r.id = a.resume_id
     JOIN jobs j ON j.id = a.job_id
     WHERE a.company_id = ? ORDER BY a.id DESC`,
    [req.user.id]
  );
  send(res, true, rows);
}));

app.patch('/api/applications/:id/status', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM applications WHERE id = ?', [req.params.id]);
  const app_ = rows[0];
  if (!app_ || app_.company_id !== req.user.id) return send(res, false, '投递记录不存在或无权限');
  const { status } = req.body || {};
  const allowed = ['viewed', 'interview', 'accepted', 'rejected'];
  if (!allowed.includes(status)) return send(res, false, '状态不合法');
  await pool.query("UPDATE applications SET status=?, updated_at=NOW() WHERE id=?", [status, req.params.id]);
  const [jobRows] = await pool.query('SELECT title FROM jobs WHERE id=?', [app_.job_id]);
  const title = jobRows[0].title;
  await notify(app_.seeker_id, 'application', `「${title}」投递状态更新为：${{ viewed: '已查看', interview: '邀面试', accepted: '已录用', rejected: '未通过' }[status]}`);
  send(res, true, '状态已更新');
}));

app.post('/api/applications/:id/interview', requireAuth(['company']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM applications WHERE id = ?', [req.params.id]);
  const app_ = rows[0];
  if (!app_ || app_.company_id !== req.user.id) return send(res, false, '投递记录不存在或无权限');
  const meeting = createMeeting({ provider: req.body.provider || 'tencent', topic: '面试邀约', userId: app_.seeker_id });
  await pool.query("UPDATE applications SET status='interview', meeting_link=?, updated_at=NOW() WHERE id=?", [meeting.url, req.params.id]);
  const [jobRows] = await pool.query('SELECT title FROM jobs WHERE id=?', [app_.job_id]);
  const title = jobRows[0].title;
  await notify(app_.seeker_id, 'interview', `收到「${title}」面试邀约，会议平台：${meeting.providerName}，入会链接：${meeting.url}`);
  send(res, true, meeting);
}));
app.post('/api/contact/request', requireAuth(), wrap(async (req, res) => {
  const { toUserId, jobId } = req.body || {};
  if (!toUserId) return send(res, false, '请选择接收方');
  const [target] = await pool.query('SELECT * FROM users WHERE id = ?', [toUserId]);
  if (!target.length) return send(res, false, '接收方不存在');
  const [dup] = await pool.query(
    'SELECT id FROM contact_requests WHERE from_user_id=? AND to_user_id=? AND status=?',
    [req.user.id, toUserId, 'pending']
  );
  if (dup.length) return send(res, false, '已有待处理的请求，请等待回复');
  await pool.query('INSERT INTO contact_requests (from_user_id, to_user_id, job_id) VALUES (?,?,?)', [req.user.id, toUserId, jobId || null]);
  await notify(toUserId, 'contact', `${req.user.name} 请求交换联系方式`);
  send(res, true, '联系方式交换请求已发送');
}));

app.get('/api/contact/requests', requireAuth(), wrap(async (req, res) => {
  const [mine] = await pool.query(
    `SELECT cr.*, u.name AS user_name, u.company_name, u.role
     FROM contact_requests cr JOIN users u ON u.id = cr.from_user_id
     WHERE cr.to_user_id = ? AND cr.status = 'pending' ORDER BY cr.id DESC`,
    [req.user.id]
  );
  const [sent] = await pool.query(
    `SELECT cr.*, u.name AS user_name, u.company_name, u.role
     FROM contact_requests cr JOIN users u ON u.id = cr.to_user_id
     WHERE cr.from_user_id = ? ORDER BY cr.id DESC`,
    [req.user.id]
  );
  send(res, true, { received: mine, sent });
}));

app.post('/api/contact/requests/:id/respond', requireAuth(), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM contact_requests WHERE id = ?', [req.params.id]);
  const reqRow = rows[0];
  if (!reqRow || reqRow.to_user_id !== req.user.id) return send(res, false, '请求不存在或无权限');
  const accept = req.body && req.body.accept;
  const [from] = await pool.query('SELECT name, phone, company_name FROM users WHERE id=?', [reqRow.from_user_id]);
  const fromUser = from[0];
  await pool.query("UPDATE contact_requests SET status=? WHERE id=?", [accept ? 'accepted' : 'rejected', req.params.id]);
  if (accept) {
    const msg = `联系方式已交换：${fromUser.name}${fromUser.company_name ? '（' + fromUser.company_name + '）' : ''}，电话 ${fromUser.phone || '未填写'}`;
    await notify(reqRow.from_user_id, 'contact', msg);
    send(res, true, { message: '已同意，联系方式已告知对方' });
  } else {
    send(res, true, '已拒绝该请求');
  }
}));

app.get('/api/notifications', requireAuth(), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', [req.user.id]);
  send(res, true, rows);
}));

app.get('/api/admin/companies', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, username, name, company_name, phone, status, created_at FROM users WHERE role='company' ORDER BY id DESC"
  );
  send(res, true, rows);
}));

app.post('/api/admin/companies/:id/approve', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM users WHERE id=? AND role='company'", [req.params.id]);
  if (!rows.length) return send(res, false, '企业不存在');
  await pool.query("UPDATE users SET status='active' WHERE id=?", [req.params.id]);
  await notify(req.params.id, 'approve', '企业注册已通过审核，可以登录并发布职位');
  send(res, true, '企业注册已通过');
}));

app.get('/api/admin/jobs', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT j.*, u.name AS company_name, u.company_name AS company
     FROM jobs j JOIN users u ON u.id = j.company_id WHERE j.status != 'published' ORDER BY j.id DESC`
  );
  send(res, true, rows);
}));

app.get('/api/admin/users', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, username, role, name, company_name, phone, status, created_at FROM users ORDER BY id DESC'
  );
  send(res, true, rows);
}));

app.patch('/api/admin/users/:id/status', requireAuth(['admin']), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  const user = rows[0];
  if (!user || user.role === 'admin') return send(res, false, '用户不存在或不能修改管理员');
  const { status } = req.body || {};
  if (!['active', 'pending', 'banned'].includes(status)) return send(res, false, '状态不合法');
  await pool.query('UPDATE users SET status=? WHERE id=?', [status, req.params.id]);
  send(res, true, '用户状态已更新');
}));

init().then(() => {
  app.listen(PORT, () => {
    console.log(`add-work 招聘系统已启动： http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('数据库初始化失败：', err.message);
  process.exit(1);
});
