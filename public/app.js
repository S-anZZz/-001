// user：当前登录用户对象
let user = null;
// token：登录令牌，只保存在内存中；持久化由服务端 HttpOnly Cookie 负责，避免 XSS 窃取
let token = null;

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

// fileLink：把 /uploads 下的文件名渲染成可点击的附件链接（自动处理中文与空格）
function fileLink(name, path) {
  if (!path) return '<span class="match">未上传</span>'; // 没有附件
  const label = esc(name || path); // 展示用的文件名
  return `<a class="file" href="/uploads/${encodeURIComponent(path)}" target="_blank" rel="noopener">📎 ${label}</a>`;
}

// timeFmt：把后端返回的 ISO 时间转成本地可读格式（避免直接显示 UTC 的 T 格式）
function timeFmt(v) {
  if (!v) return ''; // 空值直接返回
  const d = new Date(v); // 按浏览器时区解析
  if (isNaN(d.getTime())) return String(v).replace('T', ' ').slice(0, 16); // 解析失败时兜底
  const p = (n) => String(n).padStart(2, '0'); // 补零
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// jobPage / jobSort：职位列表的分页与排序状态
let jobPage = 1;
let jobSort = 'latest';

// showMsg：在认证区域显示提示信息
function showMsg(text, isErr) {
  const el = document.getElementById('authMsg'); // 取提示容器
  if (!el) return;
  el.textContent = ''; // 清空旧内容
  if (!text) return; // 无内容直接返回
  const box = document.createElement('div'); // 新建提示节点
  box.className = 'msg' + (isErr ? ' err' : ''); // 设置样式
  box.textContent = String(text); // 以纯文本写入，杜绝 HTML 注入
  el.appendChild(box);
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
    token = d.token; user = d.user; // 仅在内存中保存令牌与用户
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
  token = null; user = null; // 清空内存中的登录状态
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
  const list = await api('/api/resumes'); // 拉取我的简历列表
  p.innerHTML = `
    <div class="card">
      <div class="card-head">我的简历 <button class="tiny" onclick="openResumeForm()">新建简历</button></div>
      <div class="card-body">
        <div id="resumeMsg"></div>
        ${list.length ? `
        <table class="grid">
          <tr><th>简历名称</th><th>姓名</th><th>期望岗位城市</th><th>期望薪资</th><th>开放度</th><th>更新时间</th><th>操作</th></tr>
          ${list.map((r) => `
            <tr>
              <td><b>${esc(r.title || '我的简历')}</b>${r.is_default ? ' <span class="badge">主简历</span>' : ''}</td>
              <td>${esc(r.name)}</td>
              <td>${esc(r.expected_city || '-')}</td>
              <td>${r.expected_salary_min || '-'}-${r.expected_salary_max || '-'}</td>
              <td>${esc(visibilityLabel(r.visibility))}</td>
              <td>${timeFmt(r.updated_at)}</td>
              <td>
                <button class="tiny" onclick="openResumeForm(${r.id})">编辑</button>
                ${r.is_default ? '' : `<button class="tiny ghost" onclick="setDefaultResume(${r.id})">设为主简历</button>`}
                <button class="tiny ghost" onclick="showResumeHistory(${r.id})">历史</button>
                <button class="tiny ghost" onclick="deleteResume(${r.id})">删除</button>
              </td>
            </tr>`).join('')}
        </table>` : '<div class="empty">还没有简历，点右上角“新建简历”创建第一份吧</div>'}
        <div id="resumeEditor"></div>
      </div>
    </div>`;
};

// visibilityLabel：简历开放度的中文说明
function visibilityLabel(v) {
  return { public: '公开', hidden: '隐藏', targeted: '仅投递可见' }[v] || '公开';
}

// openResumeForm：打开新建/编辑表单
async function openResumeForm(id) {
  const box = document.getElementById('resumeEditor');
  let r = null;
  if (id) {
    const list = await api('/api/resumes'); // 取列表后定位当前简历
    r = list.find((x) => x.id === id) || null;
  }
  window.__editingResumeId = id || null; // 记录当前编辑的简历
  box.innerHTML = `
    <h4>${id ? '编辑简历' : '新建简历'}</h4>
    <form class="form" onsubmit="saveResumeForm(event)">
      <div class="row">
        <div><label>简历名称</label><input type="text" id="rTitle" value="${esc(r && r.title)}" placeholder="如：前端开发简历"></div>
        <div><label>姓名</label><input type="text" id="rName" value="${esc(r && r.name)}" required></div>
      </div>
      <div class="row">
        <div><label>学历</label><input type="text" id="rEdu" value="${esc(r && r.education)}" placeholder="如：本科"></div>
        <div><label>求职状态</label>
          <select id="rJobStatus">
            <option value="open" ${r && r.job_status === 'open' ? 'selected' : ''}>在职-考虑机会</option>
            <option value="looking" ${r && r.job_status === 'looking' ? 'selected' : ''}>离职-随时到岗</option>
            <option value="closed" ${r && r.job_status === 'closed' ? 'selected' : ''}>暂不考虑</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div><label>期望城市</label><input type="text" id="rCity" value="${esc(r && r.expected_city)}" placeholder="如：郑州"></div>
        <div><label>到岗时间</label><input type="text" id="rAvailable" value="${esc(r && r.available_time)}" placeholder="如：一周内 / 一个月内"></div>
      </div>
      <div class="row">
        <div><label>期望薪资下限（元）</label><input type="number" id="rSalMin" min="0" value="${r && r.expected_salary_min ? r.expected_salary_min : ''}"></div>
        <div><label>期望薪资上限（元）</label><input type="number" id="rSalMax" min="0" value="${r && r.expected_salary_max ? r.expected_salary_max : ''}"></div>
      </div>
      <div class="row">
        <div><label>简历开放度</label>
          <select id="rVisibility">
            <option value="public" ${r && r.visibility === 'public' ? 'selected' : ''}>公开（企业可搜索到）</option>
            <option value="targeted" ${r && r.visibility === 'targeted' ? 'selected' : ''}>仅投递可见</option>
            <option value="hidden" ${r && r.visibility === 'hidden' ? 'selected' : ''}>隐藏</option>
          </select>
        </div>
        <div><label>附件（PDF / Word）</label><input type="file" id="rFile" accept=".pdf,.doc,.docx"></div>
      </div>
      <label>技能标签</label>
      <input type="text" id="rSkills" value="${esc(r && r.skills)}" placeholder="逗号分隔，如：JavaScript,React,Vue">
      <label>工作经历</label>
      <textarea id="rExp" placeholder="如：2021.07-2024.06 某某公司 前端开发">${esc(r && r.experience)}</textarea>
      <label>项目经历</label>
      <textarea id="rProject" placeholder="项目名称、职责、技术栈、成果">${esc(r && r.project_exp)}</textarea>
      <label>教育经历</label>
      <textarea id="rEduExp" placeholder="学校、专业、起止时间">${esc(r && r.edu_exp)}</textarea>
      <label>自我评价</label>
      <textarea id="rSelf" placeholder="优势、方向、期望">${esc(r && r.self_eval)}</textarea>
      ${r && r.attachment_name ? `<p class="match">当前附件：${fileLink(r.attachment_name, r.attachment_path)}（重新选择将替换）</p>` : ''}
      <p><button type="submit">${id ? '保存修改' : '创建简历'}</button>
        <button type="button" class="tiny ghost" onclick="document.getElementById('resumeEditor').innerHTML=''">取消</button></p>
    </form>`;
}

// saveResumeForm：提交简历表单
async function saveResumeForm(e) {
  e.preventDefault();
  const body = {
    title: document.getElementById('rTitle').value,
    name: document.getElementById('rName').value,
    education: document.getElementById('rEdu').value,
    jobStatus: document.getElementById('rJobStatus').value,
    expectedCity: document.getElementById('rCity').value,
    availableTime: document.getElementById('rAvailable').value,
    expectedSalaryMin: document.getElementById('rSalMin').value,
    expectedSalaryMax: document.getElementById('rSalMax').value,
    visibility: document.getElementById('rVisibility').value,
    skills: document.getElementById('rSkills').value,
    experience: document.getElementById('rExp').value,
    projectExp: document.getElementById('rProject').value,
    eduExp: document.getElementById('rEduExp').value,
    selfEval: document.getElementById('rSelf').value
  };
  const file = document.getElementById('rFile').files[0]; // 附件（可选）
  if (file) {
    body.attachmentName = file.name;
    body.attachmentBase64 = await readFileAsBase64(file);
  }
  try {
    const id = window.__editingResumeId;
    if (id) await api(`/api/resumes/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    else await api('/api/resumes', { method: 'POST', body: JSON.stringify(body) });
    await openTab('resume'); // 刷新列表
  } catch (err) { document.getElementById('resumeMsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
}

// setDefaultResume / deleteResume / showResumeHistory：简历的其它操作
async function setDefaultResume(id) {
  try { await api(`/api/resumes/${id}/default`, { method: 'POST' }); await openTab('resume'); }
  catch (err) { alert(err.message); }
}

async function deleteResume(id) {
  if (!confirm('确定删除这份简历吗？')) return;
  try { await api(`/api/resumes/${id}`, { method: 'DELETE' }); await openTab('resume'); }
  catch (err) { alert(err.message); }
}

async function showResumeHistory(id) {
  const rows = await api(`/api/resumes/${id}/history`);
  alert(rows.length ? '该简历共保存过 ' + rows.length + ' 个历史版本：\n' + rows.map((h) => timeFmt(h.created_at)).join('\n') : '暂无历史版本');
}

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
          <div><label>期望最低（元）</label><input type="number" id="fSal" min="0"></div>
          <div><label>期望最高（元）</label><input type="number" id="fSalMax" min="0"></div>
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

async function searchJobs(page) {
  jobPage = page || jobPage || 1; // 保持当前页
  const q = new URLSearchParams();
  const kw = document.getElementById('fKeyword').value.trim();
  if (kw) q.set('keyword', kw);
  const loc = document.getElementById('fLoc').value.trim();
  if (loc) q.set('location', loc);
  const sal = document.getElementById('fSal').value;
  if (sal) q.set('minSalary', sal);
  const salMax = document.getElementById('fSalMax').value;
  if (salMax) q.set('maxSalary', salMax);
  const edu = document.getElementById('fEdu').value;
  if (edu) q.set('education', edu);
  const exp = document.getElementById('fExp').value;
  if (exp) q.set('experience', exp);
  if (jobSort !== 'latest') q.set('sort', jobSort); // 排序参数
  q.set('page', jobPage); // 页码
  q.set('pageSize', 10); // 每页 10 条
  let d;
  try {
    d = await api('/api/jobs?' + q.toString()); // 请求分页数据
  } catch (err) {
    document.getElementById('jobsTable').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; // 请求失败提示
    return;
  }
  const t = document.getElementById('jobsTable');
  const jobs = d.list || [];
  if (!jobs.length) {
    t.innerHTML = '<div class="empty">没有符合条件的职位，换个关键词试试</div>'; // 空结果提示
    return;
  }
  t.innerHTML = `
    <div class="list-bar">
      <span class="match">共 ${d.total} 个职位 · 第 ${d.page}/${d.pages} 页</span>
      <select onchange="jobSort=this.value;searchJobs(1)">
        <option value="latest" ${jobSort === 'latest' ? 'selected' : ''}>最新发布</option>
        <option value="salaryDesc" ${jobSort === 'salaryDesc' ? 'selected' : ''}>薪资从高到低</option>
        <option value="salaryAsc" ${jobSort === 'salaryAsc' ? 'selected' : ''}>薪资从低到高</option>
      </select>
    </div>
    <table class="grid">
      <tr><th>职位</th><th>企业</th><th>地点</th><th>薪资</th><th>学历</th><th>经验</th><th>要求</th><th>操作</th></tr>
      ${jobs.map((j) => `
        <tr>
          <td><b>${esc(j.title)}</b><div class="match">${timeFmt(j.created_at)}</div></td>
          <td>${esc(j.company || j.company_name)}</td>
          <td>${esc(j.location)}</td>
          <td>${j.salary_min || 0}-${j.salary_max || '不限'}</td>
          <td>${esc(j.education)}</td>
          <td>${esc(j.experience)}</td>
          <td class="match">${esc(j.requirements)}</td>
          <td>${user.role === 'seeker'
            ? `<button class="tiny" onclick="applyJob(${j.id}, this)">投递</button>
               <button class="tiny ghost" onclick="toggleFavorite(${j.id})">收藏</button>`
            : '<span class="match">企业端</span>'}</td>
        </tr>`).join('')}
    </table>
    <div class="pager">
      <button class="tiny ghost" ${d.page <= 1 ? 'disabled' : ''} onclick="searchJobs(${d.page - 1})">上一页</button>
      <span class="match">${d.page} / ${d.pages}</span>
      <button class="tiny ghost" ${d.page >= d.pages ? 'disabled' : ''} onclick="searchJobs(${d.page + 1})">下一页</button>
    </div>`;
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
  const apps = await api('/api/applications/mine'); // 拉取投递记录
  window.__apps = apps; // 缓存给筛选使用
  p.innerHTML = `
    <div class="card">
      <div class="card-head">我的投递</div>
      <div class="card-body">
        <div class="filters">
          <div><label>状态</label>
            <select id="appStatus">
              <option value="">全部</option>
              <option value="submitted">已投递</option>
              <option value="viewed">已查看</option>
              <option value="interview">面试中</option>
              <option value="accepted">已录用</option>
              <option value="rejected">未通过</option>
            </select>
          </div>
          <div><label>关键词</label><input type="search" id="appKeyword" placeholder="职位或企业名"></div>
          <div><label>排序</label>
            <select id="appSort"><option value="time">按投递时间</option><option value="score">按匹配分</option></select>
          </div>
          <div><button onclick="renderApplications()">筛选</button></div>
        </div>
        <div id="appsTable"></div>
      </div>
    </div>`;
  renderApplications(); // 首次渲染
};

// renderApplications：按筛选条件渲染投递列表
function renderApplications() {
  const status = document.getElementById('appStatus').value;
  const kw = document.getElementById('appKeyword').value.trim().toLowerCase();
  const sort = document.getElementById('appSort').value;
  let rows = (window.__apps || []).filter((a) => {
    const okStatus = !status || a.status === status; // 状态筛选
    const okKw = !kw || String(a.job_title || '').toLowerCase().includes(kw) || String(a.company_name || '').toLowerCase().includes(kw); // 关键词
    return okStatus && okKw;
  });
  rows.sort(sort === 'score' ? (a, b) => b.match_score - a.match_score : (a, b) => b.id - a.id); // 排序
  const t = document.getElementById('appsTable');
  if (!rows.length) { t.innerHTML = '<div class="empty">没有符合条件的投递记录</div>'; return; }
  t.innerHTML = `
    <table class="grid">
      <tr><th>职位</th><th>企业</th><th>地点</th><th>薪资</th><th>匹配分</th><th>状态</th><th>投递时间</th><th>操作</th></tr>
      ${rows.map((a) => `
        <tr>
          <td><b>${esc(a.job_title)}</b></td>
          <td>${esc(a.company_name)}</td>
          <td>${esc(a.location)}</td>
          <td>${a.salary_min || 0}-${a.salary_max || '不限'}</td>
          <td><b>${a.match_score}</b></td>
          <td><span class="badge">${statusLabel(a.status)}</span></td>
          <td>${timeFmt(a.created_at)}</td>
          <td><button class="tiny ghost" onclick="showEvents(${a.id})">轨迹</button></td>
        </tr>`).join('')}
    </table>`;
}

// showEvents：查看投递轨迹（谁在什么时候看了/改了状态）
async function showEvents(id) {
  try {
    const rows = await api(`/api/applications/${id}/events`);
    if (!rows.length) return alert('暂无轨迹记录');
    alert(rows.map((e) => `${timeFmt(e.created_at)}  ${e.detail || e.action}`).join('\n'));
  } catch (err) { alert(err.message); }
}

PANELS.interviews = async (p) => {
  const list = await api('/api/interviews/mine'); // 我的面试邀约
  p.innerHTML = `
    <div class="card">
      <div class="card-head">我的面试</div>
      <div class="card-body">
        ${list.length ? `
        <table class="grid">
          <tr><th>职位</th><th>企业</th><th>面试时间</th><th>方式</th><th>状态</th><th>操作</th></tr>
          ${list.map((i) => `
            <tr>
              <td><b>${esc(i.job_title || '-')}</b></td>
              <td>${esc(i.company || '-')}</td>
              <td>${timeFmt(i.scheduled_at)}</td>
              <td>${i.mode === 'offline' ? '线下' : `线上 ${i.link ? `<a class="file" href="${esc(i.link)}" target="_blank" rel="noopener">入会</a>` : ''}`}</td>
              <td><span class="badge">${interviewLabel(i.status)}</span></td>
              <td>
                ${['pending', 'rescheduled'].includes(i.status) ? `
                  <button class="tiny" onclick="respondInterview(${i.id},'confirm')">确认</button>
                  <button class="tiny ghost" onclick="rescheduleInterview(${i.id})">改约</button>
                  <button class="tiny ghost" onclick="respondInterview(${i.id},'decline')">拒绝</button>` : '<span class="match">已处理</span>'}
              </td>
            </tr>`).join('')}
        </table>` : '<div class="empty">还没有面试邀约</div>'}
      </div>
    </div>`;
};

// interviewLabel：面试状态文案
function interviewLabel(s) {
  return { pending: '待确认', confirmed: '已确认', declined: '已拒绝', rescheduled: '申请改约' }[s] || s;
}

// respondInterview：确认或拒绝面试
async function respondInterview(id, action) {
  const note = action === 'decline' ? (prompt('请填写拒绝原因（可留空）') || '') : '';
  try {
    await api(`/api/interviews/${id}/respond`, { method: 'POST', body: JSON.stringify({ action, note }) });
    await openTab('interviews');
  } catch (err) { alert(err.message); }
}

// rescheduleInterview：申请改约时间
async function rescheduleInterview(id) {
  const t = prompt('请输入希望改约的时间，格式 2026-11-20 15:00');
  if (!t) return;
  try {
    await api(`/api/interviews/${id}/respond`, {
      method: 'POST',
      body: JSON.stringify({ action: 'reschedule', newTime: t.replace(' ', 'T'), note: '候选人申请改约' })
    });
    await openTab('interviews');
  } catch (err) { alert(err.message); }
}

PANELS.favorites = async (p) => {
  const list = await api('/api/favorites'); // 收藏的职位
  p.innerHTML = `
    <div class="card">
      <div class="card-head">我的收藏</div>
      <div class="card-body">
        ${list.length ? `
        <table class="grid">
          <tr><th>职位</th><th>企业</th><th>地点</th><th>薪资</th><th>收藏时间</th><th>操作</th></tr>
          ${list.map((j) => `
            <tr>
              <td><b>${esc(j.title)}</b></td>
              <td>${esc(j.company)}</td>
              <td>${esc(j.location)}</td>
              <td>${j.salary_min || 0}-${j.salary_max || '不限'}</td>
              <td>${timeFmt(j.created_at)}</td>
              <td>
                <button class="tiny" onclick="applyJob(${j.id}, this)">投递</button>
                <button class="tiny ghost" onclick="toggleFavorite(${j.id})">取消收藏</button>
              </td>
            </tr>`).join('')}
        </table>` : '<div class="empty">还没有收藏职位，去「搜索职位」看看</div>'}
      </div>
    </div>`;
};

// askInterview：企业发起面试邀约（填写时间与方式）
async function askInterview(id) {
  const t = prompt('请输入面试时间，格式 2026-11-20 15:00');
  if (!t) return; // 取消则不发起
  const online = confirm('点击“确定”为线上面试，点“取消”为线下面试');
  try {
    await api(`/api/applications/${id}/interview`, {
      method: 'POST',
      body: JSON.stringify({ scheduledAt: t.trim().replace(' ', 'T'), mode: online ? 'online' : 'offline' })
    });
    alert('面试邀约已发送，等待候选人确认');
    await openTab('apps');
  } catch (err) { alert(err.message); }
}

// toggleFavorite：收藏/取消收藏职位
async function toggleFavorite(jobId) {
  try {
    const d = await api(`/api/favorites/${jobId}`, { method: 'POST' });
    alert(d.favorited ? '已收藏' : '已取消收藏');
    if (typeof openTab === 'function') await openTab('favorites');
  } catch (err) { alert(err.message); }
}

function statusLabel(s) {
  return { submitted: '已投递', viewed: '已查看', interview: '面试中', accepted: '已录用', rejected: '未通过' }[s] || s;
}

// ---------------------------------------------------------------- 站内聊天
// chatPeerId：当前会话的对方用户主键
let chatPeerId = null;

// 组装企业联系方式文本，供“发布联系方式”时预填
function contactText() {
  const lines = ['【联系方式】'];
  lines.push((user.company_name || user.name || '') + (user.company_name ? ' · 联系人：' + (user.name || '') : '')); // 企业名与联系人
  lines.push('电话：' + (user.phone || '未填写')); // 联系电话
  return lines.join('\n');
}

// openChat：打开与某人的聊天窗口（peerName 仅用于标题，prefill 为预填内容）
async function openChat(peerId, peerName, prefill) {
  if (!peerId) return; // 参数保护
  chatPeerId = Number(peerId); // 记住当前会话对象
  const old = document.getElementById('chatMask');
  if (old) old.remove(); // 关闭已有窗口，避免叠加
  const mask = document.createElement('div');
  mask.className = 'chat-mask';
  mask.id = 'chatMask';
  mask.innerHTML = `
    <div class="chat-box">
      <div class="chat-head">
        <b>与 ${esc(peerName || '对方')} 的会话</b>
        <button class="tiny ghost" onclick="closeChat()">关闭</button>
      </div>
      <div class="chat-body" id="chatBody"><p class="match">加载中…</p></div>
      <div class="chat-foot">
        <textarea id="chatInput" rows="3" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
        <button onclick="sendChat()">发送</button>
      </div>
      <div id="chatMsg"></div>
    </div>`;
  document.body.appendChild(mask); // 挂到页面上
  if (prefill) document.getElementById('chatInput').value = prefill; // 预填联系方式
  await loadChat(); // 拉取历史消息
  const input = document.getElementById('chatInput');
  input.focus(); // 自动聚焦输入框
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } // 回车发送
  });
}

// closeChat：关闭聊天窗口
function closeChat() {
  const mask = document.getElementById('chatMask');
  if (mask) mask.remove(); // 从页面移除
  chatPeerId = null; // 清空会话对象
}

// loadChat：拉取并渲染当前会话的消息
async function loadChat() {
  const box = document.getElementById('chatBody');
  if (!box) return;
  try {
    const d = await api('/api/messages/' + chatPeerId); // 请求会话记录
    const msgs = d.messages || [];
    if (!msgs.length) {
      box.innerHTML = '<div class="empty">还没有消息，发出第一条联系方式吧</div>'; // 空会话提示
      return;
    }
    box.innerHTML = msgs.map((m) => `
      <div class="chat-line ${m.from_user_id === user.id ? 'me' : 'peer'}">
        <div class="chat-bubble">${esc(m.content).replace(/\n/g, '<br>')}</div>
        <div class="chat-time">${esc(String(m.created_at || '').replace('T', ' ').slice(0, 16))}</div>
      </div>`).join(''); // 自己的消息靠右、对方靠左
    box.scrollTop = box.scrollHeight; // 滚动到最新一条
  } catch (err) {
    box.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; // 加载失败提示
  }
}

// sendChat：发送当前输入框里的消息
async function sendChat() {
  const input = document.getElementById('chatInput');
  const tip = document.getElementById('chatMsg');
  const content = input.value.trim(); // 取输入内容
  if (!content) { tip.innerHTML = '<div class="msg err">请输入消息内容</div>'; return; } // 空内容拦截
  try {
    await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ toUserId: chatPeerId, content }) // 提交接收方与内容
    });
    input.value = ''; // 清空输入框
    tip.innerHTML = ''; // 清除提示
    await loadChat(); // 重新拉取会话
  } catch (err) {
    tip.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; // 发送失败提示
  }
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
        <button class="tiny ghost" onclick="openChat(${r.from_user_id}, '${esc(r.user_name)}')">聊天</button>
        ${user.role === 'company' ? `<button class="tiny" onclick="openChat(${r.from_user_id}, '${esc(r.user_name)}', contactText())">发布联系方式</button>` : ''}
      </td></tr>`).join(''));
  }
  const sentRows = d.sent.map((r) => `
    <tr><td>${esc(r.user_name)}</td><td>${r.role === 'company' ? '企业' : '求职者'}</td>
    <td>${esc(r.company_name || '-')}</td>
    <td><span class="badge">${r.status === 'pending' ? '待回复' : r.status === 'accepted' ? '已同意' : '已拒绝'}</span>
      <button class="tiny ghost" onclick="openChat(${r.to_user_id}, '${esc(r.user_name)}')">聊天</button>
      ${user.role === 'company' ? `<button class="tiny" onclick="openChat(${r.to_user_id}, '${esc(r.user_name)}', contactText())">发布联系方式</button>` : ''}
    </td></tr>`).join('');
  p.innerHTML = `
    <div class="card">
      <div class="card-head">交换联系方式</div>
      <div class="card-body">
        <div id="contactMsg"></div>
        ${d.received.length ? `<h4>待处理请求</h4><table class="grid">${rows.join('')}</table>` : '<p class="match">暂无待处理的请求。</p>'}
        ${d.sent.length ? `<h4>已发送请求</h4><table class="grid"><tr><th>对方</th><th>角色</th><th>企业</th><th>状态 / 聊天</th></tr>${sentRows}</table>` : ''}
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
  let d;
  try {
    d = await api('/api/notifications'); // 拉取通知与未读数
  } catch (err) {
    p.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; // 请求失败提示
    return;
  }
  const list = d.list || [];
  p.innerHTML = `
    <div class="card">
      <div class="card-head">通知</div>
      <div class="card-body">
        ${d.unread ? `<div class="list-bar"><span class="match">${d.unread} 条未读</span>
          <button class="tiny" onclick="readAllNotify()">全部已读</button></div>` : ''}
        ${list.length ? list.map((n) => `
          <div class="msg ${n.is_read ? '' : 'unread'}" style="border-left:4px solid #000;margin-bottom:8px">
            <b>${{ application: '投递动态', interview: '面试邀约', contact: '联系方式', approve: '审核结果', message: '站内消息' }[n.type] || n.type}</b>
            <span class="match"> · ${timeFmt(n.created_at)}</span>
            <div>${esc(n.message)}</div>
          </div>`).join('') : '<div class="empty">暂无通知</div>'}
      </div>
    </div>`;
};

// readAllNotify：一键把通知标记为已读
async function readAllNotify() {
  try {
    await api('/api/notifications/read', { method: 'POST' }); // 调用批量已读接口
    await openTab('notify'); // 刷新面板
  } catch (err) { alert(err.message); }
}
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
          <td><span class="badge">${{ offline: '已下架', published: '已发布' }[j.status] || j.status}</span></td>
          <td>
            <button class="tiny" onclick="editJob(${j.id})">编辑</button>
            ${j.status === 'offline'
              ? `<button class="tiny" onclick="republishJob(${j.id})">重新上架</button>`
              : `<button class="tiny ghost" onclick="unpublishJob(${j.id})">下架</button>`}
          </td>
        </tr>`).join('')}
    </table>`;
}

// republishJob：把已下架职位重新上架
async function republishJob(id) {
  try {
    await api(`/api/jobs/${id}/republish`, { method: 'PATCH' }); // 调用重新上架接口
    await openTab('jobs'); // 刷新列表
  } catch (err) { alert(err.message); }
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
          <tr><th>候选人</th><th>投递职位</th><th>简历附件</th><th>技能标签</th><th>经验</th><th>学历</th><th>匹配分</th><th>匹配理由</th><th>状态</th><th>操作</th></tr>
          ${apps.map((a) => `
            <tr>
              <td><b>${esc(a.candidate)}</b></td>
              <td>${esc(a.job_title)}</td>
              <td>${fileLink(a.attachment_name, a.attachment_path)}</td>
              <td>${esc(a.skills)}</td>
              <td>${esc(a.experience)}</td>
              <td>${esc(a.education)}</td>
              <td><b>${a.match_score}</b></td>
              <td class="match">${esc(a.match_reasons)}</td>
              <td><span class="badge">${statusLabel(a.status)}</span></td>
              <td>
                <button class="tiny" onclick="setAppStatus(${a.id},'viewed')">已查看</button>
                <button class="tiny" onclick="askInterview(${a.id})">邀面试</button>
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
          <tr><th>企业名称</th><th>联系人</th><th>用户名</th><th>电话</th><th>经营许可证</th><th>状态</th><th>操作</th></tr>
          ${list.map((c) => `
            <tr>
              <td><b>${esc(c.company_name)}</b></td>
              <td>${esc(c.name)}</td>
              <td>${esc(c.username)}</td>
              <td>${esc(c.phone)}</td>
              <td>${fileLink('查看许可证', c.license_path)}</td>
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
  try {
    user = await api('/api/me'); // 依靠服务端 HttpOnly Cookie 恢复登录态
    enterDashboard();
  } catch (e) {
    token = null; // 未登录则停留在登录页
  }
})();

