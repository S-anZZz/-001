// user：当前登录用户对象
let user = null;
// token：登录令牌，持久化在 localStorage
let token = localStorage.getItem('token') || null;

// api：统一的后端请求封装，自动携带登录令牌
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }; // 组装请求头
  if (token) headers['Authorization'] = 'Bearer ' + token; // 携带令牌
  const res = await fetch(path, { ...options, headers }); // 发起请求
  const data = await res.json().catch(() => ({})); // 解析响应
  if (!res.ok || !data.ok) {
    // 后端错误统一放在 data.data 里（字符串），优先展示它，避免只看到“请求失败”
    const msg = typeof data.data === 'string' ? data.data : (data.message || '请求失败');
    throw new Error(msg);
  }
  return data.data; // 返回数据
}

// showMsg：在认证区域显示提示信息
function showMsg(text, isErr) {
  const el = document.getElementById('authMsg'); // 取提示容器
  if (!el) return;
  el.innerHTML = text ? `<div class="msg ${isErr ? 'err' : ''}">${text}</div>` : ''; // 渲染提示
}

// esc：转义 HTML 特殊字符，防止注入
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// login：登录处理，成功后进入工作台
async function login(e) {
  e.preventDefault(); // 阻止表单默认提交
  try {
    const d = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: loginUser.value, password: loginPwd.value }) // 组装登录参数
    });
    token = d.token; user = d.user; // 保存令牌与用户
    localStorage.setItem('token', token); // 持久化令牌
    enterDashboard(); // 进入工作台
  } catch (err) { showMsg(err.message, true); } // 错误提示
}

// toggleCompanyFields：选择角色后显示或隐藏企业专属字段
function toggleCompanyFields() {
  const isCompany = document.getElementById('regRole').value === 'company'; // 是否选择了企业
  document.getElementById('companyFields').style.display = isCompany ? 'flex' : 'none'; // 企业名称与电话
  document.getElementById('licenseField').style.display = isCompany ? 'flex' : 'none'; // 经营许可证上传
}

// register：注册处理，校验密码后提交注册
async function register(e) {
  e.preventDefault(); // 阻止表单默认提交
  const role = regRole.value; // 获取注册角色
  // 密码长度校验：4~8 位
  if (regPwd.value.length < 4 || regPwd.value.length > 8) {
    showMsg('密码需为 4~8 位', true);
    return;
  }
  // 两次密码确认校验
  if (regPwd.value !== regPwd2.value) {
    showMsg('两次输入的密码不一致', true);
    return;
  }
  try {
    // 读取头像文件并转为 base64（可选）
    let avatarBase64 = null, avatarName = null;
    const avatarFile = document.getElementById('regAvatar').files[0]; // 获取头像文件
    if (avatarFile) {
      avatarName = avatarFile.name; // 记录文件名
      avatarBase64 = await readFileAsBase64(avatarFile); // 转 base64
    }
    // 读取企业经营许可证并转为 base64（可选，仅企业角色）
    let licenseBase64 = null, licenseName = null;
    const licenseFile = document.getElementById('regLicense').files[0]; // 获取许可证文件
    if (role === 'company' && licenseFile) {
      licenseName = licenseFile.name; // 记录文件名
      licenseBase64 = await readFileAsBase64(licenseFile); // 转 base64
    }
    const d = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        username: regUser.value, password: regPwd.value, role,
        name: regName.value,
        companyName: role === 'company' ? regCompany.value : null, // 企业角色传企业名
        phone: regPhone.value,
        avatarName, avatarBase64, // 传递头像
        licenseName, licenseBase64 // 传递经营许可证
      })
    });
    if (role === 'company') {
      // 企业账号需管理员审核，停留在当前页并提示等待审核
      showMsg(d.message || '注册成功，请等待管理员审核', false);
      return;
    }
    showMsg(d.message + '，请登录', false); // 求职者注册成功，提示登录
    setTimeout(() => switchAuth('login'), 1200); // 切换回登录页
  } catch (err) { showMsg(err.message, true); } // 错误提示
}

// logout：退出登录，清除令牌并回到登录页
async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
  token = null; user = null; // 清空登录状态
  localStorage.removeItem('token'); // 移除持久化令牌
  document.getElementById('authWrap').style.display = 'block'; // 显示登录区
  document.getElementById('dashWrap').style.display = 'none'; // 隐藏工作台
  document.getElementById('userBox').style.display = 'none'; // 隐藏用户信息
}

// switchAuth：切换登录/注册页签
function switchAuth(mode) {
  document.getElementById('tabLogin').classList.toggle('active', mode === 'login'); // 切换登录页签高亮
  document.getElementById('tabReg').classList.toggle('active', mode === 'register'); // 切换注册页签高亮
  document.getElementById('loginForm').style.display = mode === 'login' ? 'block' : 'none'; // 显示对应表单
  document.getElementById('regForm').style.display = mode === 'register' ? 'block' : 'none'; // 显示对应表单
}

function enterDashboard() {
  document.getElementById('authWrap').style.display = 'none'; // 隐藏登录区
  document.getElementById('dashWrap').style.display = 'block'; // 显示工作台
  document.getElementById('userBox').style.display = 'flex'; // 显示用户信息
  // 若有头像则展示，否则隐藏
  const avatar = document.getElementById('userAvatar');
  avatar.style.display = user.avatar_path ? 'block' : 'none';
  avatar.src = user.avatar_path ? '/uploads/' + user.avatar_path : '';
  document.getElementById('userLabel').textContent =
    `${user.name}（${{ seeker: '求职者', company: '企业', admin: '管理员' }[user.role]}）`; // 显示用户信息
  renderTabs(); // 渲染页签
  openTab('home'); // 打开首页
}

const ROLE_TABS = {
  seeker: [
    { id: 'home', name: '工作台' },
    { id: 'resume', name: '我的简历' },
    { id: 'jobs', name: '搜索职位' },
    { id: 'applications', name: '投递记录' },
    { id: 'contact', name: '联系方式' },
    { id: 'notify', name: '通知' }
  ],
  company: [
    { id: 'home', name: '工作台' },
    { id: 'jobs', name: '职位管理' },
    { id: 'apps', name: '收到的简历' },
    { id: 'contact', name: '联系方式' },
    { id: 'notify', name: '通知' }
  ],
  admin: [
    { id: 'home', name: '工作台' },
    { id: 'companies', name: '企业审核' },
    { id: 'users', name: '用户管理' }
  ]
};

function renderTabs() {
  const tabs = document.getElementById('dashTabs');
  tabs.innerHTML = ROLE_TABS[user.role].map((t) =>
    `<button data-t="${t.id}" onclick="openTab('${t.id}')">${t.name}</button>`).join('');
}

async function openTab(id) {
  document.querySelectorAll('#dashTabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.t === id));
  const panel = document.getElementById('dashPanels');
  panel.innerHTML = '<div class="card"><div class="empty">加载中…</div></div>';
  const fn = PANELS[id] || PANELS.home;
  try { await fn(panel); } catch (err) {
    panel.innerHTML = `<div class="card"><div class="card-body"><div class="msg err">${esc(err.message)}</div></div></div>`;
  }
}

const PANELS = {};
PANELS.home = async (p) => {
  p.innerHTML = `
    <div class="card">
      <div class="card-head">工作台</div>
      <div class="card-body">
        <p>欢迎，<b>${esc(user.name)}</b>。当前角色：<b>${
          { seeker: '求职者', company: '企业', admin: '管理员' }[user.role]}</b>。</p>
        ${user.role === 'seeker' ? '<p class="match">提示：先完善简历，再搜索职位并投递，系统会按技能标签给出匹配分与匹配理由。</p>' : ''}
        ${user.role === 'company' ? '<p class="match">提示：企业注册通过审核后即可登录；职位发布与修改无需管理员审核，提交后立即进入职位库。</p>' : ''}
        ${user.role === 'admin' ? '<p class="match">提示：审核企业注册申请，管理用户账号。</p>' : ''}
      </div>
    </div>`;
};

PANELS.resume = async (p) => {
  const r = await api('/api/resume/mine');
  p.innerHTML = `
    <div class="card">
      <div class="card-head">我的简历</div>
      <div class="card-body">
        <div id="resumeMsg"></div>
        <form class="form" onsubmit="saveResume(event)">
          <div class="row">
            <div><label>姓名</label><input type="text" id="rName" value="${esc(r && r.name)}" required></div>
            <div><label>学历</label><input type="text" id="rEdu" value="${esc(r && r.education)}" placeholder="如：本科 / 硕士"></div>
          </div>
          <label>技能标签</label>
          <input type="text" id="rSkills" value="${esc(r && r.skills)}" placeholder="用逗号分隔，如：JavaScript,React,Vue">
          <label>工作经历</label>
          <textarea id="rExp" placeholder="如：5年前端开发经验">${esc(r && r.experience)}</textarea>
          <label>附件（PDF / Word）</label>
          <input type="file" id="rFile" accept=".pdf,.doc,.docx">
          ${r && r.attachment_name ? `<p class="match">已上传附件：${esc(r.attachment_name)}，重新选择文件将替换。</p>` : ''}
          <p><button type="submit">保存简历</button></p>
        </form>
      </div>
    </div>`;
};

async function saveResume(e) {
  e.preventDefault();
  let base64 = null, fname = null;
  const f = document.getElementById('rFile').files[0];
  if (f) {
    if (!/\.(pdf|doc|docx)$/i.test(f.name)) return alert('仅支持 PDF / Word 附件');
    base64 = await readFileAsBase64(f);
    fname = f.name;
  }
  try {
    await api('/api/resume', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('rName').value,
        skills: document.getElementById('rSkills').value,
        experience: document.getElementById('rExp').value,
        education: document.getElementById('rEdu').value,
        attachmentName: fname, attachmentBase64: base64
      })
    });
    document.getElementById('resumeMsg').innerHTML = '<div class="msg">简历已保存</div>';
    await openTab('resume');
  } catch (err) { document.getElementById('resumeMsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function seekerJobs(p) {
  p.innerHTML = `
    <div class="card">
      <div class="card-head">搜索职位</div>
      <div class="card-body">
        <div class="filters">
          <div><label>关键词</label><input type="search" id="fKeyword"></div>
          <div><label>地点</label><input type="text" id="fLoc" placeholder="如：上海"></div>
          <div><label>最低薪资（元）</label><input type="number" id="fSal" min="0"></div>
          <div><label>学历</label>
            <select id="fEdu"><option value="">不限</option><option>大专</option><option>本科</option><option>硕士</option></select>
          </div>
          <div><label>经验</label>
            <select id="fExp"><option value="">不限</option><option>应届生</option><option>1-3年</option><option>3-5年</option><option>5-10年</option></select>
          </div>
          <div><button onclick="searchJobs()">筛选</button></div>
        </div>
        <div id="jobsTable"></div>
      </div>
    </div>`;
  await searchJobs();
};

async function searchJobs() {
  const q = new URLSearchParams();
  const kw = document.getElementById('fKeyword').value.trim();
  if (kw) q.set('keyword', kw);
  const loc = document.getElementById('fLoc').value.trim();
  if (loc) q.set('location', loc);
  const sal = document.getElementById('fSal').value;
  if (sal) q.set('minSalary', sal);
  const edu = document.getElementById('fEdu').value;
  if (edu) q.set('education', edu);
  const exp = document.getElementById('fExp').value;
  if (exp) q.set('experience', exp);
  const jobs = await api('/api/jobs?' + q.toString());
  const t = document.getElementById('jobsTable');
  if (!jobs.length) { t.innerHTML = '<div class="empty">没有符合条件的职位</div>'; return; }
  t.innerHTML = `
    <table class="grid">
      <tr><th>职位</th><th>企业</th><th>地点</th><th>薪资</th><th>学历</th><th>经验</th><th>要求</th><th>操作</th></tr>
      ${jobs.map((j) => `
        <tr>
          <td><b>${esc(j.title)}</b></td>
          <td>${esc(j.company || j.company_name)}</td>
          <td>${esc(j.location)}</td>
          <td>${j.salary_min || 0}-${j.salary_max || '不限'}</td>
          <td>${esc(j.education)}</td>
          <td>${esc(j.experience)}</td>
          <td class="match">${esc(j.requirements)}</td>
          <td>${user.role === 'seeker'
            ? `<button class="tiny" onclick="applyJob(${j.id}, this)">投递</button>`
            : '<span class="match">企业端</span>'}</td>
        </tr>`).join('')}
    </table>`;
}

async function applyJob(id, btn) {
  btn.disabled = true;
  try {
    const d = await api(`/api/jobs/${id}/apply`, { method: 'POST' });
    btn.textContent = `已投递（${d.score}分）`;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '投递';
    alert(err.message);
  }
}
PANELS.applications = async (p) => {
  const apps = await api('/api/applications/mine');
  p.innerHTML = `
    <div class="card">
      <div class="card-head">我的投递</div>
      <div class="card-body">
        ${apps.length ? `
        <table class="grid">
          <tr><th>职位</th><th>企业</th><th>地点</th><th>薪资</th><th>匹配分</th><th>匹配理由</th><th>状态</th></tr>
          ${apps.map((a) => `
            <tr>
              <td><b>${esc(a.job_title)}</b></td>
              <td>${esc(a.company_name)}</td>
              <td>${esc(a.location)}</td>
              <td>${a.salary_min || 0}-${a.salary_max || '不限'}</td>
              <td><b>${a.match_score}</b></td>
              <td class="match">${esc(a.match_reasons)}</td>
              <td><span class="badge">${statusLabel(a.status)}</span></td>
            </tr>`).join('')}
        </table>` : '<div class="empty">还没有投递记录，去「搜索职位」投递吧</div>'}
      </div>
    </div>`;
};

function statusLabel(s) {
  return { submitted: '已投递', viewed: '已查看', interview: '面试中', accepted: '已录用', rejected: '未通过' }[s] || s;
}

PANELS.contact = async (p) => {
  const d = await api('/api/contact/requests');
  const rows = [];
  if (d.received.length) {
    rows.push('<tr><th>来自</th><th>角色</th><th>企业</th><th>操作</th></tr>');
    rows.push(d.received.map((r) => `
      <tr><td>${esc(r.user_name)}</td><td>${r.role === 'company' ? '企业' : '求职者'}</td>
      <td>${esc(r.company_name || '-')}</td>
      <td>
        <button class="tiny" onclick="respondContact(${r.id}, true, this)">同意</button>
        <button class="tiny ghost" onclick="respondContact(${r.id}, false, this)">拒绝</button>
      </td></tr>`).join(''));
  }
  const sentRows = d.sent.map((r) => `
    <tr><td>${esc(r.user_name)}</td><td>${r.role === 'company' ? '企业' : '求职者'}</td>
    <td>${esc(r.company_name || '-')}</td>
    <td><span class="badge">${r.status === 'pending' ? '待回复' : r.status === 'accepted' ? '已同意' : '已拒绝'}</span></td></tr>`).join('');
  p.innerHTML = `
    <div class="card">
      <div class="card-head">交换联系方式</div>
      <div class="card-body">
        <div id="contactMsg"></div>
        ${d.received.length ? `<h4>待处理请求</h4><table class="grid">${rows.join('')}</table>` : '<p class="match">暂无待处理的请求。</p>'}
        ${d.sent.length ? `<h4>已发送请求</h4><table class="grid"><tr><th>对方</th><th>角色</th><th>企业</th><th>状态</th></tr>${sentRows}</table>` : ''}
      </div>
    </div>`;
};

async function respondContact(id, accept, btn) {
  try {
    const d = await api(`/api/contact/requests/${id}/respond`, {
      method: 'POST', body: JSON.stringify({ accept })
    });
    document.getElementById('contactMsg').innerHTML = `<div class="msg">${esc(d.message)}</div>`;
    await openTab('contact');
  } catch (err) { alert(err.message); }
}

PANELS.notify = async (p) => {
  const list = await api('/api/notifications');
  p.innerHTML = `
    <div class="card">
      <div class="card-head">通知</div>
      <div class="card-body">
        ${list.length ? list.map((n) => `
          <div class="msg" style="border-left:4px solid #000;margin-bottom:8px">
            <b>${{ application: '投递动态', interview: '面试邀约', contact: '联系方式', approve: '审核结果' }[n.type] || n.type}</b>
            <span class="match"> · ${esc(n.created_at)}</span>
            <div>${esc(n.message)}</div>
          </div>`).join('') : '<div class="empty">暂无通知</div>'}
      </div>
    </div>`;
};
async function companyJobs(p) {
  const jobs = await api('/api/jobs/mine');
  p.innerHTML = `
    <div class="card">
      <div class="card-head">职位管理</div>
      <div class="card-body">
        <div id="jobMsg"></div>
        <button onclick="toggleJobForm()">＋ 发布新职位</button>
        <div class="card" id="jobForm" style="display:none;margin-top:12px">
          <div class="card-body">
            <form class="form" onsubmit="saveJob(event)">
              <label>职位标题</label><input type="text" id="jTitle" required>
              <label>职位要求（技能标签用逗号分隔）</label>
              <textarea id="jReq" placeholder="如：JavaScript,React,Vue,前端工程化"></textarea>
              <div class="row">
                <div><label>地点</label><input type="text" id="jLoc"></div>
                <div><label>最低薪资</label><input type="number" id="jSalMin" min="0"></div>
                <div><label>最高薪资</label><input type="number" id="jSalMax" min="0"></div>
              </div>
              <div class="row">
                <div><label>学历要求</label>
                  <select id="jEdu"><option value="">不限</option><option>大专</option><option>本科</option><option>硕士</option></select>
                </div>
                <div><label>经验要求</label>
                  <select id="jExp"><option value="">不限</option><option>应届生</option><option>1-3年</option><option>3-5年</option><option>5-10年</option></select>
                </div>
              </div>
              <p><button type="submit" id="jobSubmit">发布职位</button></p>
            </form>
          </div>
        </div>
        <div id="jobsTable"></div>
      </div>
    </div>`;
  renderJobsTable(jobs);
};

function toggleJobForm() {
  document.getElementById('jobForm').style.display =
    document.getElementById('jobForm').style.display === 'none' ? 'block' : 'none';
}

let editingJobId = null;

async function saveJob(e) {
  e.preventDefault();
  const body = {
    title: document.getElementById('jTitle').value,
    requirements: document.getElementById('jReq').value,
    location: document.getElementById('jLoc').value,
    salaryMin: document.getElementById('jSalMin').value,
    salaryMax: document.getElementById('jSalMax').value,
    education: document.getElementById('jEdu').value,
    experience: document.getElementById('jExp').value
  };
  try {
    if (editingJobId) {
      await api(`/api/jobs/${editingJobId}`, { method: 'PATCH', body: JSON.stringify(body) });
      document.getElementById('jobMsg').innerHTML = '<div class="msg">职位已更新</div>';
    } else {
      const d = await api('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
      document.getElementById('jobMsg').innerHTML = `<div class="msg">${esc(d.message)}</div>`;
    }
    editingJobId = null;
    await openTab('jobs');
  } catch (err) { document.getElementById('jobMsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
}

function editJob(id) {
  fetch('/api/jobs/mine', { headers: { 'Authorization': 'Bearer ' + token } })
    .then((r) => r.json()).then((d) => {
      const job = d.data.find((j) => j.id === id);
      editingJobId = id;
      document.getElementById('jTitle').value = job.title;
      document.getElementById('jReq').value = job.requirements || '';
      document.getElementById('jLoc').value = job.location || '';
      document.getElementById('jSalMin').value = job.salary_min || '';
      document.getElementById('jSalMax').value = job.salary_max || '';
      document.getElementById('jEdu').value = job.education || '';
      document.getElementById('jExp').value = job.experience || '';
      document.getElementById('jobSubmit').textContent = '保存修改';
      toggleJobForm();
    });
}

function renderJobsTable(jobs) {
  const t = document.getElementById('jobsTable');
  if (!jobs.length) { t.innerHTML = '<div class="empty">还没有发布职位</div>'; return; }
  t.innerHTML = `
    <table class="grid">
      <tr><th>职位</th><th>地点</th><th>薪资</th><th>状态</th><th>操作</th></tr>
      ${jobs.map((j) => `
        <tr>
          <td><b>${esc(j.title)}</b></td>
          <td>${esc(j.location)}</td>
          <td>${j.salary_min || 0}-${j.salary_max || '不限'}</td>
          <td><span class="badge">${{ unpublished: '已下架', published: '已发布' }[j.status] || j.status}</span></td>
          <td>
            <button class="tiny" onclick="editJob(${j.id})">编辑</button>
            <button class="tiny ghost" onclick="unpublishJob(${j.id})">下架</button>
          </td>
        </tr>`).join('')}
    </table>`;
}

async function unpublishJob(id) {
  try {
    await api(`/api/jobs/${id}/unpublish`, { method: 'PATCH' });
    await openTab('jobs');
  } catch (err) { alert(err.message); }
}

PANELS.jobs = (p) => user.role === 'seeker' ? seekerJobs(p) : companyJobs(p);
PANELS.apps = async (p) => {
  const apps = await api('/api/applications/received');
  p.innerHTML = `
    <div class="card">
      <div class="card-head">收到的简历</div>
      <div class="card-body">
        <div id="appsMsg"></div>
        ${apps.length ? `
        <table class="grid">
          <tr><th>候选人</th><th>投递职位</th><th>技能标签</th><th>经验</th><th>学历</th><th>匹配分</th><th>匹配理由</th><th>状态</th><th>操作</th></tr>
          ${apps.map((a) => `
            <tr>
              <td><b>${esc(a.candidate)}</b></td>
              <td>${esc(a.job_title)}</td>
              <td>${esc(a.skills)}</td>
              <td>${esc(a.experience)}</td>
              <td>${esc(a.education)}</td>
              <td><b>${a.match_score}</b></td>
              <td class="match">${esc(a.match_reasons)}</td>
              <td><span class="badge">${statusLabel(a.status)}</span></td>
              <td>
                <button class="tiny" onclick="setAppStatus(${a.id},'viewed')">已查看</button>
                <button class="tiny" onclick="setAppStatus(${a.id},'interview')">邀面试</button>
                <button class="tiny ghost" onclick="setAppStatus(${a.id},'accepted')">录用</button>
                <button class="tiny ghost" onclick="setAppStatus(${a.id},'rejected')">不通过</button>
                <button class="tiny ghost" onclick="requestContact(${a.seeker_id})">交换联系方式</button>
              </td>
            </tr>`).join('')}
        </table>` : '<div class="empty">暂无收到的简历</div>'}
      </div>
    </div>`;
};

async function setAppStatus(id, status) {
  try {
    await api(`/api/applications/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    await openTab('apps');
  } catch (err) { alert(err.message); }
}

async function requestContact(toUserId) {
  try {
    const d = await api('/api/contact/request', {
      method: 'POST', body: JSON.stringify({ toUserId })
    });
    document.getElementById('appsMsg').innerHTML = `<div class="msg">${esc(d.message)}</div>`;
  } catch (err) { alert(err.message); }
}

PANELS.companies = async (p) => {
  const list = await api('/api/admin/companies');
  p.innerHTML = `
    <div class="card">
      <div class="card-head">企业注册审核</div>
      <div class="card-body">
        ${list.length ? `
        <table class="grid">
          <tr><th>企业名称</th><th>联系人</th><th>用户名</th><th>电话</th><th>状态</th><th>操作</th></tr>
          ${list.map((c) => `
            <tr>
              <td><b>${esc(c.company_name)}</b></td>
              <td>${esc(c.name)}</td>
              <td>${esc(c.username)}</td>
              <td>${esc(c.phone)}</td>
              <td><span class="badge">${c.status === 'pending' ? '待审核' : c.status === 'active' ? '已通过' : '已停用'}</span></td>
              <td>${c.status === 'pending'
                ? `<button class="tiny" onclick="approveCompany(${c.id})">通过</button>
                   <button class="tiny ghost" onclick="toggleUserStatus(${c.id},'banned')">拒绝</button>`
                : `<button class="tiny ghost" onclick="toggleUserStatus(${c.id},'active')">启用</button>
                   <button class="tiny ghost" onclick="toggleUserStatus(${c.id},'banned')">停用</button>`}</td>
            </tr>`).join('')}
        </table>` : '<div class="empty">暂无企业注册申请</div>'}
      </div>
    </div>`;
};

async function approveCompany(id) {
  try {
    await api(`/api/admin/companies/${id}/approve`, { method: 'POST' });
    await openTab('companies');
  } catch (err) { alert(err.message); }
}

PANELS.users = async (p) => {
  const list = await api('/api/admin/users');
  p.innerHTML = `
    <div class="card">
      <div class="card-head">用户管理</div>
      <div class="card-body">
        <table class="grid">
          <tr><th>用户名</th><th>角色</th><th>姓名</th><th>企业</th><th>电话</th><th>状态</th><th>操作</th></tr>
          ${list.map((u) => `
            <tr>
              <td><b>${esc(u.username)}</b></td>
              <td>${{ seeker: '求职者', company: '企业', admin: '管理员' }[u.role]}</td>
              <td>${esc(u.name)}</td>
              <td>${esc(u.company_name || '-')}</td>
              <td>${esc(u.phone || '-')}</td>
              <td><span class="badge">${{ active: '正常', pending: '待审核', banned: '已停用' }[u.status] || u.status}</span></td>
              <td>${u.role !== 'admin'
                ? `<button class="tiny ghost" onclick="toggleUserStatus(${u.id},'active')">启用</button>
                   <button class="tiny ghost" onclick="toggleUserStatus(${u.id},'banned')">停用</button>`
                : '<span class="match">-</span>'}</td>
            </tr>`).join('')}
        </table>
      </div>
    </div>`;
};

async function toggleUserStatus(id, status) {
  try {
    await api(`/api/admin/users/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    const active = document.querySelector('#dashTabs button.active');
    await openTab(active ? active.dataset.t : 'companies');
  } catch (err) { alert(err.message); }
}

(async function init() {
  if (token) {
    try {
      user = await api('/api/me');
      enterDashboard();
    } catch (e) {
      token = null; localStorage.removeItem('token');
    }
  }
})();

