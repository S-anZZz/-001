/**
 * app.js —— 前端单页应用的全部交互逻辑（原生 JS，无框架、无构建步骤）
 *
 * 组织结构：
 *   1. 全局状态与工具函数：user、token、api()、esc()、timeFmt()、showMsg()；
 *   2. 登录与注册：login()、register()、switchAuth()、logout()、init()；
 *   3. 工作台框架：PANELS 面板注册表 + ROLE_TABS 角色页签 + openTab()；
 *   4. 各业务面板：首页看板、简历、职位、投递、面试、收藏、联系、聊天、企业端、
 *      管理端（企业审核、用户管理、操作日志）；
 *   5. 通用弹窗：聊天窗口、职位详情、附件预览、简历打印预览。
 *
 * 关键约定：
 *   - 所有请求统一走 api()，自动带上内存中的 token，并依赖 HttpOnly Cookie 维持会话；
 *   - 所有拼接进 innerHTML 的用户数据都要经过 esc() 转义，避免 XSS；
 *   - 页面不存 localStorage，刷新后通过 /api/me 恢复登录态。
 */

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
function fileLink(name, path, exists) {
  if (!path) return '<span class="match">未上传</span>'; // 没有附件
  if (exists === false) return '<span class="match">附件已失效（早期上传的文件未迁移）</span>'; // 文件不存在
  const label = esc(name || path); // 展示用的文件名
  const isWord = /\.(doc|docx)$/i.test(path); // Word 无法在浏览器内预览
  const tip = isWord ? '点击下载（Word 不支持在线预览）' : '点击在新标签页预览 / 下载';
  return `<a class="file" href="/uploads/${encodeURIComponent(path)}" target="_blank" rel="noopener" title="${tip}">📎 ${label}</a>`;
}

// jobTypeLabel：职位类型文案
function jobTypeLabel(t) {
  return { fulltime: '全职', parttime: '兼职', intern: '实习', remote: '远程' }[t] || '全职';
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

// badge：生成状态徽标，data-s 交给 CSS 按状态区分黑白色阶
function badge(text, tone) {
  return `<span class="badge" data-s="${esc(tone || '')}">${esc(text)}</span>`;
}

// scoreCell：匹配分单元格，80 分以上用黑块强调，60 分以上描边
function scoreCell(score) {
  const n = Number(score) || 0; // 取数值
  const tone = n >= 80 ? 'high' : n >= 60 ? 'mid' : 'low'; // 分档
  return `<b class="score ${tone}">${n}</b>`;
}

// login：登录处理，成功后进入工作台
async function login(e) {
  e.preventDefault(); // 阻止表单默认提交
  const submit = e.currentTarget.querySelector('[type="submit"]');
  const label = submit.innerHTML;
  submit.disabled = true;
  submit.textContent = '正在登录…';
  showMsg('');
  try {
    const d = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: loginUser.value, password: loginPwd.value }) // 组装登录参数
    });
    token = d.token; user = d.user; // 仅在内存中保存令牌与用户
    loginPwd.value = '';
    enterDashboard(); // 进入工作台
  } catch (err) { showMsg(err.message, true); }
  finally {
    submit.disabled = false;
    submit.innerHTML = label;
  }
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
  closeChat(); // 退出时关闭会话并阻止在途响应写入
  const landing = document.getElementById('landingWrap');
  if (landing) landing.style.display = '';       // 退出后回到首页
  document.body.dataset.view = 'landing';
  if (window.__motionRefresh) setTimeout(() => window.__motionRefresh(), 30);
  document.getElementById('authWrap').style.display = 'none';
  document.getElementById('dashWrap').style.display = 'none';
  document.getElementById('userBox').style.display = 'none';
  document.getElementById('headerNote').style.display = '';
  switchAuth('login');
  window.scrollTo(0, 0);
}

// switchAuth：切换登录/注册页签
function switchAuth(mode) {
  document.getElementById('tabLogin').classList.toggle('active', mode === 'login'); // 切换登录页签高亮
  document.getElementById('tabReg').classList.toggle('active', mode === 'register'); // 切换注册页签高亮
  document.getElementById('loginForm').style.display = mode === 'login' ? 'block' : 'none'; // 显示对应表单
  document.getElementById('regForm').style.display = mode === 'register' ? 'block' : 'none'; // 显示对应表单
  document.getElementById('tabLogin').setAttribute('aria-pressed', String(mode === 'login'));
  document.getElementById('tabReg').setAttribute('aria-pressed', String(mode === 'register'));
  document.getElementById('authTitle').textContent = mode === 'login' ? '欢迎回来' : '开启新的可能';
  document.getElementById('authSubtitle').textContent = mode === 'login' ? '登录 add work，继续你的职业旅程。' : '创建你的账号，让合适的人与机会相遇。';
  document.title = `${mode === 'login' ? '登录' : '创建账号'} · add work`;
  showMsg('');
}


// showLanding / openLogin：首页介绍页与登录页之间的切换
function showLanding() {
  const landing = document.getElementById('landingWrap');
  if (landing) landing.style.display = '';
  document.body.dataset.view = 'landing';      // 供样式与滚动动效判断当前视图
  document.getElementById('authWrap').style.display = 'none';
  document.getElementById('dashWrap').style.display = 'none';
  window.scrollTo(0, 0);
}

// openLogin：从首页进入登录面板（修复「让我们一起看看」点了没反应）
function openLogin(event) {
  if (event) event.preventDefault();           // 阻止 #login 锚点空跳
  const landing = document.getElementById('landingWrap');
  if (landing) landing.style.display = 'none';
  document.body.dataset.view = 'auth';
  document.getElementById('authWrap').style.display = 'block';
  document.getElementById('dashWrap').style.display = 'none';
  window.scrollTo(0, 0);
  const input = document.getElementById('loginUser');
  if (input) setTimeout(() => input.focus({ preventScroll: true }), 60);
  // 登录面板此前是隐藏的，动效元素需要在显示后重新扫描一次
  if (window.__motionRefresh) setTimeout(() => window.__motionRefresh(), 30);
}

// enterDashboard：登录成功后隐藏登录区、展示工作台并渲染页签
function enterDashboard() {
  const landing = document.getElementById('landingWrap');
  if (landing) landing.style.display = 'none';  // 隐藏首页介绍页，避免与工作台叠加
  document.body.dataset.view = 'app';            // 标记为工作台视图
  document.getElementById('authWrap').style.display = 'none'; // 隐藏登录区
  document.getElementById('dashWrap').style.display = 'block'; // 显示工作台
  document.getElementById('userBox').style.display = 'flex'; // 显示用户信息
  document.getElementById('headerNote').style.display = 'none';
  document.getElementById('workspaceLabel').textContent = { seeker: '个人工作空间', company: '企业招聘空间', admin: '平台管理空间' }[user.role];
  document.getElementById('pageDate').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  // 头像：有图显示图片，无图显示姓名首字占位
  const avatar = document.getElementById('userAvatar'); // 头像图片节点
  const initial = document.getElementById('userInitial'); // 首字占位节点
  avatar.style.display = user.avatar_path ? 'block' : 'none'; // 有头像才显示图片
  avatar.src = user.avatar_path ? '/uploads/' + user.avatar_path : ''; // 头像地址
  initial.style.display = user.avatar_path ? 'none' : 'grid'; // 否则显示占位
  initial.textContent = (user.name || '用').slice(0, 1); // 占位文字取姓名首字
  document.getElementById('userLabel').textContent = user.name || '-'; // 显示姓名
  document.getElementById('userRole').textContent =
    { seeker: '求职者', company: '企业', admin: '管理员' }[user.role]; // 显示角色
  renderTabs(); // 渲染页签
  openTab('home'); // 打开首页
}

const ROLE_TABS = {
  seeker: [
    { id: 'home', name: '工作台', description: '每一步都有方向，每一份努力都值得被看见。' },
    { id: 'jobs', name: '发现职位', description: '按照你的期待，找到值得奔赴的下一站。' },
    { id: 'resume', name: '我的简历', description: '让经验与实力被看见，让好机会主动靠近。' },
    { id: 'applications', name: '投递记录', description: '关注每一次投递，让求职进展清晰可见。' },
    { id: 'interviews', name: '我的面试', description: '安排好下一次见面，为新的可能做好准备。' },
    { id: 'favorites', name: '收藏职位', description: '留住心动的机会，认真做每一次选择。' },
    { id: 'chat', name: '聊天', description: '与合适的人保持沟通，历史会话随时可查。' },
    { id: 'notify', name: '消息通知', description: '重要的消息与进展，都在这里。' }
  ],
  company: [
    { id: 'home', name: '招聘工作台', description: '招聘进展一目了然，让合适的人更快加入。' },
    { id: 'jobs', name: '职位管理', description: '维护招聘机会，让每一个好职位被看见。' },
    { id: 'apps', name: '收到的简历', description: '发现候选人的闪光点，找到团队需要的人。' },
    { id: 'interviews', name: '面试管理', description: '跟进面试安排，及时处理候选人的改约申请。' },
    { id: 'talent', name: '发现人才', description: '主动寻找合适的人才，开启下一次合作。' },
    { id: 'profile', name: '企业资料', description: '展示真实的团队，让人才更了解你们。' },
    { id: 'chat', name: '聊天', description: '和候选人保持沟通，历史会话随时可查。' },
    { id: 'notify', name: '消息通知', description: '及时了解招聘动态，不错过重要消息。' }
  ],
  admin: [
    { id: 'home', name: '数据概览', description: '看见平台的每一点成长，掌握整体运营情况。' },
    { id: 'companies', name: '企业审核', description: '认真审核每一份申请，建立可信赖的招聘环境。' },
    { id: 'users', name: '用户管理', description: '管理平台账号，为求职与招聘提供良好秩序。' },
    { id: 'adminJobs', name: '职位管理', description: '维护职位状态，处理违规或过期职位。' },
    { id: 'logs', name: '操作日志', description: '记录关键操作，让平台管理有迹可循。' }
  ]
};

// uiIcon：返回指定名称的内联 SVG 图标片段
function uiIcon(name) {
  const paths = {
    home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    jobs: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a20 20 0 0 0 18 0M12 12v4"/>',
    resume: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    applications: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M9 5V3h6v2M8 11h8M8 16h5"/>',
    interviews: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M8 16h3"/>',
    favorites: '<path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9L12 3Z"/>',
    chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5a9 9 0 0 1-.9-4A8.5 8.5 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 11h8M8 15h5"/>',
    contact: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5a9 9 0 0 1-.9-4A8.5 8.5 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 11h8M8 15h5"/>',
    adminJobs: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a20 20 0 0 0 18 0M12 12v4"/>',
    notify: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    talent: '<circle cx="10" cy="8" r="4"/><path d="M3 21v-2a7 7 0 0 1 10-6"/><circle cx="17" cy="17" r="3"/><path d="m19.5 19.5 2 2"/>',
    profile: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M10 21v-6h4v6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M17 5a3.5 3.5 0 0 1 0 7M18 15a5 5 0 0 1 4 5"/>',
    companies: '<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z"/><path d="m8 12 3 3 5-6"/>',
    logs: '<path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M8 8h5M8 13h3"/><circle cx="18" cy="6" r="4"/><path d="M18 4v2l1 1"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name === 'apps' ? 'resume' : name] || paths.home}</svg>`;
}

// renderTabs：按当前角色渲染可用页签
function renderTabs() {
  const tabs = document.getElementById('dashTabs');
  tabs.innerHTML = ROLE_TABS[user.role].map((t) =>
    `<button data-t="${t.id}" onclick="openTab('${t.id}')">${uiIcon(t.id)}<span>${t.name}</span></button>`).join('');
}

// openTab：切换页签并渲染对应面板内容
async function openTab(id) {
  document.querySelectorAll('#dashTabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.t === id);
    if (b.dataset.t === id) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const nav = document.getElementById('dashTabs');
  const active = nav.querySelector('[aria-current="page"]');
  if (active && nav.scrollWidth > nav.clientWidth) {
    nav.scrollTo({ left: active.offsetLeft - nav.offsetLeft - 12, behavior: 'instant' });
  }
  const tab = ROLE_TABS[user.role].find((t) => t.id === id) || ROLE_TABS[user.role][0];
  document.getElementById('pageCrumb').textContent = tab.name;
  document.getElementById('pageTitle').textContent = id === 'home' && user.role === 'seeker' ? `你好，${user.name || '朋友'}` : tab.name;
  document.getElementById('pageDescription').textContent = tab.description;
  document.title = `${tab.name} · add work`;
  const panel = document.getElementById('dashPanels');
  panel.innerHTML = '<div class="card"><div class="empty" role="status">正在为你加载…</div></div>';
  const fn = PANELS[id] || PANELS.home;
  try { await fn(panel); } catch (err) {
    panel.innerHTML = `<div class="card"><div class="card-body"><div class="msg err">${esc(err.message)}</div></div></div>`;
  }
}

const PANELS = {};
PANELS.home = async (p) => {
  if (user.role === 'admin') { // 管理员首页展示运营看板
    const d = await api('/api/admin/dashboard');
    p.innerHTML = `
      <div class="card">
        <div class="card-head">运营数据看板</div>
        <div class="card-body">
          <div class="stat-grid admin-stats">
            <button class="stat-card link" onclick="openTab('users')">用户总数<b>${d.users.total || 0}</b></button>
            <button class="stat-card link" onclick="openTab('companies')">企业数<b>${d.users.company || 0}</b></button>
            <button class="stat-card link" onclick="openTab('users')">求职者数<b>${d.users.seeker || 0}</b></button>
            <button class="stat-card link" onclick="openTab('adminJobs')">职位总数<b>${d.jobs.total || 0}</b></button>
            <button class="stat-card link" onclick="openTab('adminJobs')">在招职位<b>${d.jobs.published || 0}</b></button>
            <button class="stat-card link" onclick="openTab('adminJobs')">急招职位<b>${d.jobs.urgent || 0}</b></button>
            <button class="stat-card link" onclick="openTab('adminJobs')">投递总量<b>${d.apps.total || 0}</b></button>
            <button class="stat-card link" onclick="openTab('adminJobs')">面试中<b>${d.apps.interview || 0}</b></button>
            <button class="stat-card link" onclick="openTab('adminJobs')">已录用<b>${d.apps.accepted || 0}</b></button>
            <button class="stat-card link" onclick="openTab('logs')">近 7 天投递<b>${d.recentApplications || 0}</b></button>
          </div>
          <p class="toolbar">
            <button class="tiny" onclick="exportCsv('applications')">导出投递 CSV</button>
            <button class="tiny ghost" onclick="exportCsv('jobs')">导出职位 CSV</button>
            <button class="tiny ghost" onclick="exportCsv('users')">导出用户 CSV</button>
          </p>
        </div>
      </div>`;
    return;
  }
  if (user.role === 'company') { // 企业首页展示招聘漏斗
    const d = await api('/api/company/dashboard');
    p.innerHTML = `
      <section class="welcome-card">
        <div><p class="welcome-kicker">BUILD SOMETHING GREAT</p><h2>好团队，从遇见对的人开始。</h2><p>发布一个好机会，发现一位新伙伴。让每一次招聘，都成为团队向前的一步。</p><div class="welcome-actions"><button onclick="openTab('jobs')">管理招聘职位 <span aria-hidden="true">↗</span></button><button class="ghost" onclick="openTab('talent')">发现合适人才</button></div></div>
        <div class="welcome-art" aria-hidden="true">↗</div>
      </section>
      <div class="card">
        <div class="card-head">招聘看板</div>
        <div class="card-body">
          <div class="stat-grid company-stats">
            <div class="stat-card">职位总数<b>${d.jobs.total || 0}</b></div>
            <div class="stat-card">在招职位<b>${d.jobs.published || 0}</b></div>
            <div class="stat-card">职位曝光<b>${d.jobs.views || 0}</b></div>
            <div class="stat-card">收到投递<b>${d.apps.total || 0}</b></div>
            <div class="stat-card">待面试<b>${d.interviews.pending || 0}</b></div>
            <div class="stat-card">已录用<b>${d.apps.accepted || 0}</b></div>
            <div class="stat-card">浏览→投递<b>${d.conversion.viewToApply}%</b></div>
            <div class="stat-card">投递→面试<b>${d.conversion.applyToInterview}%</b></div>
            <div class="stat-card">面试→录用<b>${d.conversion.interviewToHire}%</b></div>
          </div>
          <p class="match hint">提示：职位发布与修改无需审核；使用“刷新/置顶/急招”可以提升曝光。</p>
        </div>
      </div>`;
    return;
  }
  p.innerHTML = `
    <section class="welcome-card">
      <div>
        <p class="welcome-kicker">MAKE YOUR NEXT MOVE</p>
        <h2>下一站，遇见更好的自己。</h2>
        <p>完善你的简历，让合适的机会找到你。每一次认真出发，都离理想更近一步。</p>
        <div class="welcome-actions"><button onclick="openTab('jobs')">发现好工作 <span aria-hidden="true">↗</span></button><button class="ghost" onclick="openTab('resume')">完善我的简历</button></div>
      </div>
      <div class="welcome-art" aria-hidden="true">↗</div>
    </section>
    <div class="quick-links">
      <button class="quick-link" onclick="openTab('applications')">${uiIcon('applications')}<span>投递记录<small>追踪每一份期待的进展</small></span><b aria-hidden="true">↗</b></button>
      <button class="quick-link" onclick="openTab('interviews')">${uiIcon('interviews')}<span>我的面试<small>为下一次见面做好准备</small></span><b aria-hidden="true">↗</b></button>
      <button class="quick-link" onclick="openTab('favorites')">${uiIcon('favorites')}<span>收藏职位<small>不错过每一个心动机会</small></span><b aria-hidden="true">↗</b></button>
    </div>
    <div id="recommendBox"></div>`;
  const box = document.getElementById('recommendBox');
  box.innerHTML = await showRecommend(p);
};

PANELS.resume = async (p) => {
  const list = await api('/api/resumes'); // 拉取我的简历列表
  p.innerHTML = `
    <div class="card">
      <div class="card-head">我的简历 <button class="tiny" onclick="openResumeForm()">新建简历</button></div>
      <div class="card-body">
        <div id="resumeMsg"></div>
        ${list.length ? `
        <table class="grid"><thead><tr><th scope="col">简历名称</th><th scope="col">姓名</th><th scope="col">期望岗位城市</th><th scope="col">期望薪资</th><th scope="col">开放度</th><th scope="col">更新时间</th><th scope="col">操作</th></tr></thead><tbody>
          
          ${list.map((r) => `
            <tr>
              <td><b>${esc(r.title || '我的简历')}</b>${r.is_default ? ' ' + badge('主简历', 'viewed') : ''}</td>
              <td>${esc(r.name)}</td>
              <td>${esc(r.expected_city || '-')}</td>
              <td class="num">${r.expected_salary_min || '-'}-${r.expected_salary_max || '-'}</td>
              <td>${esc(visibilityLabel(r.visibility))}</td>
              <td>${timeFmt(r.updated_at)}</td>
              <td>
                <button class="tiny" onclick="openResumeForm(${r.id})">编辑</button>
                <button class="tiny ghost" onclick="previewResume(${r.id})">预览</button>
                ${r.is_default ? '' : `<button class="tiny ghost" onclick="setDefaultResume(${r.id})">设为主简历</button>`}
                <button class="tiny ghost" onclick="showResumeHistory(${r.id})">历史</button>
                <button class="tiny ghost" onclick="deleteResume(${r.id})">删除</button>
              </td>
            </tr>`).join('')}
        </tbody></table>` : '<div class="empty">还没有简历，点右上角“新建简历”创建第一份吧</div>'}
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
    <h4 class="form-section">${id ? '编辑简历' : '新建简历'}</h4>
    <form class="form" onsubmit="saveResumeForm(event)">
      <h5 class="form-section">基本信息</h5>
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
      <h5 class="form-section">求职意向</h5>
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
      </div>

      <h5 class="form-section">技能与经历</h5>
      <label>技能标签</label>
      <input type="text" id="rSkills" value="${esc(r && r.skills)}" placeholder="逗号分隔，如：JavaScript,React,Vue">
      <label>工作经历</label>
      <textarea id="rExp" placeholder="如：2021.07-2024.06 某某公司 前端开发">${esc(r && r.experience)}</textarea>
      <label>项目经历</label>
      <textarea id="rProject" placeholder="项目名称、职责、技术栈、成果">${esc(r && r.project_exp)}</textarea>
      <label>教育经历</label>
      <textarea id="rEduExp" placeholder="学校、专业、起止时间">${esc(r && r.edu_exp)}</textarea>
      <h5 class="form-section">自我评价与附件</h5>
      <label>自我评价</label>
      <textarea id="rSelf" placeholder="优势、方向、期望">${esc(r && r.self_eval)}</textarea>
      <label>附件（PDF / Word）</label>
      <input type="file" id="rFile" accept=".pdf,.doc,.docx">
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

// deleteResume：删除指定简历（同时处理默认简历回退）
async function deleteResume(id) {
  if (!confirm('确定删除这份简历吗？')) return;
  try { await api(`/api/resumes/${id}`, { method: 'DELETE' }); await openTab('resume'); }
  catch (err) { alert(err.message); }
}

// showResumeHistory：查看某份简历的修改历史
async function showResumeHistory(id) {
  const rows = await api(`/api/resumes/${id}/history`);
  alert(rows.length ? '该简历共保存过 ' + rows.length + ' 个历史版本：\n' + rows.map((h) => timeFmt(h.created_at)).join('\n') : '暂无历史版本');
}

// saveResume：保存简历（无 id 为新建，有 id 为更新）
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

// readFileAsBase64：读取文件为纯 base64（去掉 data URL 前缀）
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// seekerJobs：求职者端职位列表面板
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

// searchJobs：按关键词 / 地点 / 薪资等条件搜索职位
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
  let appliedMap = {}; // 已投递次数：job_id -> 次数
  if (user && user.role === 'seeker') {
    try {
      const mine = await api('/api/applications/mine'); // 拉取我的投递
      mine.forEach((a) => { appliedMap[a.job_id] = Number(a.apply_count) || 1; }); // 建立映射
    } catch (e) { appliedMap = {}; } // 失败不影响列表
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
        <option value="match" ${jobSort === 'match' ? 'selected' : ''}>匹配度优先</option>
      </select>
    </div>
    <table class="grid"><thead><tr><th scope="col">职位</th><th scope="col">企业</th><th scope="col">地点</th><th scope="col">薪资</th><th scope="col">学历</th><th scope="col">经验</th><th scope="col">要求</th><th scope="col">操作</th></tr></thead><tbody>
      
      ${jobs.map((j) => `
        <tr>
          <td><b onclick="openJobDetail(${j.id})">${esc(j.title)}</b>
              ${j.is_top ? badge('置顶', 'accepted') : ''}${j.is_urgent ? badge('急招', 'interview') : ''}
              <div class="match">${timeFmt(j.created_at)} · 浏览 ${j.view_count || 0}</div></td>
          <td>${esc(j.company || j.company_name)}</td>
          <td>${esc(j.location)}</td>
          <td class="num">${j.salary_min || 0}-${j.salary_max || '不限'}<div class="match">${jobTypeLabel(j.job_type)}</div></td>
          <td>${esc(j.education)}</td>
          <td>${esc(j.experience)}</td>
          <td class="match truncate" title="${esc(j.requirements)}">${esc(j.requirements)}</td>
          <td>${user.role === 'seeker'
            ? `${appliedMap[j.id] ? `<div class="match">已投 ${appliedMap[j.id]} 次</div>` : ''}
               <button class="tiny ${appliedMap[j.id] ? 'ghost' : ''}" onclick="applyJob(${j.id}, this)">${appliedMap[j.id] ? '再投一次' : '投递'}</button>
               <button class="tiny ghost" onclick="toggleFavorite(${j.id})">收藏</button>`
            : '<span class="match">企业端</span>'}</td>
        </tr>`).join('')}
    </tbody></table>
    <div class="pager">
      <button class="tiny ghost" ${d.page <= 1 ? 'disabled' : ''} onclick="searchJobs(${d.page - 1})">上一页</button>
      <span class="match">${d.page} / ${d.pages}</span>
      <button class="tiny ghost" ${d.page >= d.pages ? 'disabled' : ''} onclick="searchJobs(${d.page + 1})">下一页</button>
    </div>`;
}

// applyJob：投递职位并显示匹配分
async function applyJob(id, btn) {
  btn.disabled = true; // 防连点
  try {
    const d = await api(`/api/jobs/${id}/apply`, { method: 'POST' }); // 投递（重复投递会累计次数）
    const times = Number(d.applyCount) || 1; // 已投递次数
    btn.textContent = times > 1 ? `已投 ${times} 次 · 再投一次` : `已投递（${d.score}分）· 可再投`;
    btn.classList.add('ghost'); // 视觉上退为次要按钮，仍可继续点击
  } catch (err) {
    btn.textContent = '投递'; // 失败恢复
    alert(err.message); // 提示原因
  } finally {
    btn.disabled = false; // 允许重复投递
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
    <table class="grid"><thead><tr><th scope="col">职位</th><th scope="col">企业</th><th scope="col">地点</th><th scope="col">薪资</th><th scope="col">匹配分</th><th scope="col">投递次数</th><th scope="col">状态</th><th scope="col">投递时间</th><th scope="col">操作</th></tr></thead><tbody>
      
      ${rows.map((a) => `
        <tr>
          <td><b>${esc(a.job_title)}</b></td>
          <td>${esc(a.company_name)}</td>
          <td>${esc(a.location)}</td>
          <td class="num">${a.salary_min || 0}-${a.salary_max || '不限'}</td>
          <td>${scoreCell(a.match_score)}</td>
          <td class="num">${Number(a.apply_count) || 1}</td>
          <td>${badge(statusLabel(a.status), a.status)}</td>
          <td>${timeFmt(a.created_at)}</td>
          <td><button class="tiny ghost" onclick="showEvents(${a.id})">轨迹</button></td>
        </tr>`).join('')}
    </tbody></table>`;
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
  const isCompany = user.role === 'company';
  const list = await api('/api/interviews/mine'); // 按角色返回面试记录
  p.innerHTML = `
    <div class="card">
      <div class="card-head">${isCompany ? '面试管理' : '我的面试'}</div>
      <div class="card-body">
        ${list.length ? `
        <table class="grid"><thead><tr><th scope="col">职位</th><th scope="col">${isCompany ? '候选人' : '企业'}</th><th scope="col">面试时间 / 改约前时间</th><th scope="col">拟议时间</th><th scope="col">方式</th><th scope="col">备注</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>
          ${list.map((i) => `
            <tr>
              <td><b>${esc(i.job_title || '-')}</b></td>
              <td>${esc((isCompany ? i.candidate : i.company) || '-')}</td>
              <td>${esc(timeFmt(i.scheduled_at))}</td>
              <td>${esc(timeFmt(i.proposed_at) || '-')}</td>
              <td>${i.mode === 'offline' ? '线下' : `线上 ${/^https?:\/\//i.test(i.link || '') ? `<a class="file" href="${esc(i.link)}" target="_blank" rel="noopener">入会</a>` : ''}`}</td>
              <td><div>候选人：${esc(i.seeker_note || '-')}</div><div>企业：${esc(i.company_note || '-')}</div></td>
              <td>${badge(interviewLabel(i.status), interviewTone(i.status))}</td>
              <td>
                ${isCompany
                  ? (i.status === 'rescheduled' ? `
                    <button class="tiny" onclick="reviewInterview(${Number(i.id)},'accept')">接受改约</button>
                    <button class="tiny ghost" onclick="reviewInterview(${Number(i.id)},'reject')">拒绝改约</button>` : '<span class="match">无待处理改约</span>')
                  : `${i.status === 'pending' ? `<button class="tiny" onclick="respondInterview(${Number(i.id)},'confirm')">确认</button>` : ''}
                    ${['pending', 'confirmed'].includes(i.status) ? `<button class="tiny ghost" onclick="rescheduleInterview(${Number(i.id)})">改约</button>` : ''}
                    ${['pending', 'confirmed', 'rescheduled'].includes(i.status) ? `<button class="tiny ghost" onclick="respondInterview(${Number(i.id)},'decline')">拒绝</button>` : '<span class="match">已处理</span>'}`}
                ${i.application_id ? `<button class="tiny ghost" onclick="showEvents(${Number(i.application_id)})">历史</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody></table>` : '<div class="empty">还没有面试邀约</div>'}
      </div>
    </div>`;
};

// interviewLabel：面试状态文案
function interviewLabel(s) {
  return { pending: '待确认', confirmed: '已确认', declined: '已拒绝', rescheduled: '改约待企业确认' }[s] || s;
}

// interviewTone：面试状态对应的徽标色调（映射到 CSS 的 data-s）
function interviewTone(s) {
  return { pending: 'pending', confirmed: 'accepted', declined: 'rejected', rescheduled: 'interview' }[s] || 'viewed';
}

// respondInterview：确认或拒绝面试
async function respondInterview(id, action) {
  const note = action === 'decline' ? prompt('请填写拒绝原因（可留空）') : '';
  if (note === null) return;
  try {
    await api(`/api/interviews/${id}/respond`, { method: 'POST', body: JSON.stringify({ action, note }) });
    await openTab('interviews');
  } catch (err) { alert(err.message); }
}

// futureInterviewTime：校验本地面试时间并统一提交 ISO 时间
function futureInterviewTime(value) {
  const text = String(value).trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) throw new Error('请输入有效时间，格式 YYYY-MM-DD HH:mm');
  const date = new Date(text.replace(' ', 'T'));
  if (!Number.isFinite(date.getTime()) || timeFmt(date) !== text) throw new Error('请输入有效的日期和时间');
  if (date.getTime() <= Date.now()) throw new Error('面试时间必须晚于当前时间');
  return date.toISOString();
}

// rescheduleInterview：提交拟议时间，等待企业审核后才生效
async function rescheduleInterview(id) {
  const t = prompt('请输入希望改约的本地时间，格式 YYYY-MM-DD HH:mm（需企业确认）');
  if (!t) return;
  try {
    const newTime = futureInterviewTime(t);
    const note = prompt('请填写改约备注（可留空）');
    if (note === null) return;
    await api(`/api/interviews/${id}/respond`, {
      method: 'POST',
      body: JSON.stringify({ action: 'reschedule', newTime, note })
    });
    await openTab('interviews');
  } catch (err) { alert(err.message); }
}

// reviewInterview：企业接受或拒绝候选人的改约申请
async function reviewInterview(id, action) {
  const note = prompt(action === 'accept' ? '接受改约后将按拟议时间面试，请填写备注（可留空）' : '拒绝改约后保留原时间并等待候选人确认，请填写备注（可留空）');
  if (note === null) return;
  try {
    await api(`/api/interviews/${id}/review`, { method: 'POST', body: JSON.stringify({ action, note }) });
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
        <table class="grid"><thead><tr><th scope="col">职位</th><th scope="col">企业</th><th scope="col">地点</th><th scope="col">薪资</th><th scope="col">收藏时间</th><th scope="col">操作</th></tr></thead><tbody>
          
          ${list.map((j) => `
            <tr>
              <td><b>${esc(j.title)}</b></td>
              <td>${esc(j.company)}</td>
              <td>${esc(j.location)}</td>
              <td class="num">${j.salary_min || 0}-${j.salary_max || '不限'}</td>
              <td>${timeFmt(j.created_at)}</td>
              <td>
                <button class="tiny" onclick="applyJob(${j.id}, this)">投递</button>
                <button class="tiny ghost" onclick="toggleFavorite(${j.id})">取消收藏</button>
              </td>
            </tr>`).join('')}
        </tbody></table>` : '<div class="empty">还没有收藏职位，去「搜索职位」看看</div>'}
      </div>
    </div>`;
};

// askInterview：企业发起面试邀约（填写时间与方式）
async function askInterview(id) {
  const t = prompt('请输入面试本地时间，格式 YYYY-MM-DD HH:mm');
  if (!t) return; // 取消则不发起
  try {
    const scheduledAt = futureInterviewTime(t);
    const online = confirm('点击“确定”为线上面试，点“取消”为线下面试');
    await api(`/api/applications/${id}/interview`, {
      method: 'POST',
      body: JSON.stringify({ scheduledAt, mode: online ? 'online' : 'offline' })
    });
    alert('面试邀约已发送，等待候选人确认');
    await openTab('apps');
  } catch (err) { alert(err.message); }
}

// toggleFollow：关注/取消关注企业
async function toggleFollow(companyId) {
  try {
    const d = await api(`/api/follows/${companyId}`, { method: 'POST' });
    alert(d.followed ? '已关注该企业，有新职位会优先展示' : '已取消关注');
  } catch (err) { alert(err.message); }
}

let receivedAttachments = new Map(); // 按投递 ID 保存附件元数据，不将文件名拼入事件代码

// previewApplicationAttachment：企业附件访问统一经过投递接口记录轨迹
function previewApplicationAttachment(appId) {
  appId = Number(appId);
  if (!Number.isSafeInteger(appId) || appId <= 0) return;
  const attachment = receivedAttachments.get(appId);
  if (!attachment || !attachment.attachment_path || attachment.attachment_exists === false) return alert('附件不存在或已失效');
  previewAttachment(attachment.attachment_name, attachment.attachment_path, `/api/applications/${appId}/attachment`);
}

// previewAttachment：仅允许内部投递附件 URL；个人附件仍使用原 /uploads 地址
function previewAttachment(name, path, applicationUrl) {
  if (applicationUrl && !/^\/api\/applications\/[1-9]\d*\/attachment$/.test(applicationUrl)) return;
  const url = applicationUrl || '/uploads/' + encodeURIComponent(path);
  const downloadUrl = applicationUrl ? url + '?download=1' : url;
  const isPdf = /\.pdf$/i.test(path);
  const isImg = /\.(png|jpe?g|gif|webp)$/i.test(path);
  if (!isPdf && !isImg) { // Word 等格式无法在线预览
    if (confirm('该文件格式不支持在线预览，是否下载？')) window.open(downloadUrl, '_blank', 'noopener');
    return;
  }
  const old = document.getElementById('attachMask');
  if (old) old.remove();
  const mask = document.createElement('div');
  mask.className = 'chat-mask';
  mask.id = 'attachMask';
  mask.innerHTML = `
    <div class="chat-box modal-lg">
      <div class="chat-head"><b>${esc(name || '附件预览')}</b>
        <span>
          <a class="file" href="${esc(downloadUrl)}" download>下载</a>
          <button class="tiny ghost" onclick="document.getElementById('attachMask').remove()">关闭</button>
        </span></div>
      <div class="chat-body preview-body">
        ${isPdf
          ? `<iframe class="embed-frame" src="${esc(url)}#toolbar=1"></iframe>`
          : `<img class="embed-img" src="${esc(url)}" alt="附件预览">`}
      </div>
    </div>`;
  document.body.appendChild(mask); // 挂载预览弹窗
}

// previewResume：新窗口打开可打印的简历预览（也可直接另存为 PDF）
async function previewResume(id) {
  const list = await api('/api/resumes');
  const r = list.find((x) => x.id === id);
  if (!r) return;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(r.name)}的简历</title>
    <style>
      *{box-sizing:border-box}
      body{margin:0;padding:40px 20px;background:#efeeea;color:#0d0d0d;line-height:1.75;
        font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px}
      .sheet{max-width:780px;margin:0 auto;background:#fff;border:1px solid #0d0d0d;border-radius:6px;padding:40px 44px;
        box-shadow:0 10px 30px -14px rgba(13,13,13,.3)}
      .head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;
        border-bottom:2px solid #0d0d0d;padding-bottom:16px;margin-bottom:8px}
      h1{font-size:26px;margin:0;letter-spacing:-.01em}
      .role{font-size:12px;color:#5f5f5c;letter-spacing:.08em;text-transform:uppercase}
      .muted{color:#5f5f5c;font-size:13px;margin:12px 0 0}
      .tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
      .tag{border:1px solid #d9d9d4;border-radius:999px;padding:2px 10px;font-size:12px}
      h2{font-size:14px;margin:26px 0 10px;display:flex;align-items:center;gap:8px;letter-spacing:.04em}
      h2::before{content:'';width:7px;height:7px;background:#0d0d0d}
      .body{white-space:pre-wrap;word-break:break-word}
      .foot{margin-top:32px;padding-top:12px;border-top:1px solid #e9e9e4;color:#8c8c88;font-size:12px;
        display:flex;justify-content:space-between}
      @media print{body{background:#fff;padding:0}.sheet{border:0;box-shadow:none;padding:0}}
    </style></head><body>
    <div class="sheet">
      <div class="head">
        <div>
          <h1>${esc(r.name)}</h1>
          <div class="muted">${esc(r.education || '')}　·　${esc(r.expected_city || '')}　·　期望 ${r.expected_salary_min || '-'} - ${r.expected_salary_max || '-'}　·　${esc(jobStatusLabel(r.job_status))}</div>
        </div>
        <div class="role">Resume</div>
      </div>
      <div class="tags">${(r.skills || '').split(/[,，]/).filter(Boolean).map((s) => `<span class="tag">${esc(s.trim())}</span>`).join('')}</div>
      <h2>工作经历</h2><div class="body">${esc(r.experience || '-')}</div>
      <h2>项目经历</h2><div class="body">${esc(r.project_exp || '-')}</div>
      <h2>教育经历</h2><div class="body">${esc(r.edu_exp || '-')}</div>
      <h2>自我评价</h2><div class="body">${esc(r.self_eval || '-')}</div>
      <div class="foot"><span>add work · 在线求职招聘系统</span><span>${esc(r.title || '我的简历')}</span></div>
    </div>
    </body></html>`;
  const w = window.open('', '_blank'); // 打开新窗口
  w.document.write(html); // 写入简历 HTML
  w.document.close(); // 关闭写入流
}

// toggleFavorite：收藏/取消收藏职位
async function toggleFavorite(jobId) {
  try {
    const d = await api(`/api/favorites/${jobId}`, { method: 'POST' });
    alert(d.favorited ? '已收藏' : '已取消收藏');
    if (typeof openTab === 'function') await openTab('favorites');
  } catch (err) { alert(err.message); }
}

// statusLabel：把投递状态码翻译成中文文案
function statusLabel(s) {
  return { submitted: '已投递', viewed: '已查看', interview: '面试中', accepted: '已录用', rejected: '未通过' }[s] || s;
}


// jobOp：职位运营（刷新 / 置顶 / 急招）
async function jobOp(id, op) {
  try {
    await api(`/api/jobs/${id}/${op}`, { method: 'POST' }); // 调用对应接口
    await openTab('jobs'); // 刷新列表
  } catch (err) { alert(err.message); }
}

// batchOffline：批量下架勾选的职位
async function batchOffline() {
  const ids = Array.from(document.querySelectorAll('.jobPick:checked')).map((c) => Number(c.value)); // 收集勾选
  if (!ids.length) return alert('请先勾选要下架的职位');
  try {
    const r = await api('/api/jobs/batch-offline', { method: 'POST', body: JSON.stringify({ ids }) });
    alert(r);
    await openTab('jobs');
  } catch (err) { alert(err.message); }
}

// exportCsv：导出 CSV（浏览器直接用 Cookie 鉴权下载）
function exportCsv(type) {
  window.open('/api/admin/export?type=' + encodeURIComponent(type), '_blank'); // 新窗口下载
}

PANELS.logs = async (p) => {
  const rows = await api('/api/admin/logs'); // 操作日志
  p.innerHTML = `
    <div class="card">
      <div class="card-head">操作日志（最近 200 条）</div>
      <div class="card-body">
        ${rows.length ? `
        <table class="grid"><thead><tr><th scope="col">时间</th><th scope="col">用户</th><th scope="col">角色</th><th scope="col">方法</th><th scope="col">接口</th><th scope="col">状态码</th></tr></thead><tbody>
          
          ${rows.map((l) => `
            <tr>
              <td>${timeFmt(l.created_at)}</td>
              <td>${esc(l.username || '-')}</td>
              <td>${esc(l.role || '-')}</td>
              <td>${esc(l.method)}</td>
              <td class="match">${esc(l.path)}</td>
              <td>${l.status}</td>
            </tr>`).join('')}
        </tbody></table>` : '<div class="empty">暂无日志</div>'}
      </div>
    </div>`;
};

PANELS.profile = async (p) => {
  const c = await api('/api/company/profile'); // 企业资料
  p.innerHTML = `
    <div class="card">
      <div class="card-head">企业资料 ${c.verified ? badge('已认证', 'accepted') : badge('待认证', 'pending')}</div>
      <div class="card-body">
        <div id="profileMsg"></div>
        <form class="form" onsubmit="saveProfile(event)">
          <div class="row">
            <div><label>公司名称</label><input type="text" id="pCompany" value="${esc(c.company_name)}" required></div>
            <div><label>联系人</label><input type="text" id="pContact" value="${esc(c.name)}"></div>
          </div>
          <div class="row">
            <div><label>联系电话</label><input type="text" id="pPhone" value="${esc(c.phone)}"></div>
            <div><label>企业头像</label><input type="file" id="pAvatar" accept=".png,.jpg,.jpeg,.gif,.webp"></div>
          </div>
          <div class="row">
            <div><label>行业</label><input type="text" id="pIndustry" value="${esc(c.company_industry)}" placeholder="如：互联网"></div>
            <div><label>规模</label>
              <select id="pSize">
                ${['', '1-20人', '20-99人', '100-499人', '500人以上'].map((v) => `<option value="${v}" ${c.company_size === v ? 'selected' : ''}>${v || '未填写'}</option>`).join('')}
              </select>
            </div>
          </div>
          <label>公司地址</label>
          <input type="text" id="pAddress" value="${esc(c.company_address)}" placeholder="如：上海市浦东新区">
          <label>公司简介</label>
          <textarea id="pIntro" placeholder="介绍主营业务、团队与文化">${esc(c.company_intro)}</textarea>
          <p><button type="submit">保存资料</button></p>
        </form>
      </div>
    </div>`;
};

// saveProfile：保存企业资料
async function saveProfile(e) {
  e.preventDefault();
  const body = {
    companyName: document.getElementById('pCompany').value,
    contact: document.getElementById('pContact').value,
    phone: document.getElementById('pPhone').value,
    industry: document.getElementById('pIndustry').value,
    size: document.getElementById('pSize').value,
    address: document.getElementById('pAddress').value,
    intro: document.getElementById('pIntro').value
  };
  const file = document.getElementById('pAvatar').files[0]; // 可选头像
  if (file) { body.avatarName = file.name; body.avatarBase64 = await readFileAsBase64(file); }
  try {
    await api('/api/company/profile', { method: 'PATCH', body: JSON.stringify(body) });
    await openTab('profile');
  } catch (err) { document.getElementById('profileMsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
}

PANELS.talent = async (p) => {
  p.innerHTML = `
    <div class="card">
      <div class="card-head">人才库</div>
      <div class="card-body">
        <div class="filters">
          <div><label>技能（逗号分隔）</label><input type="text" id="tSkills" placeholder="如：JavaScript,Vue"></div>
          <div><label>期望城市</label><input type="text" id="tCity" placeholder="如：上海"></div>
          <div><label>学历</label>
            <select id="tEdu"><option value="">不限</option><option>大专</option><option>本科</option><option>硕士</option></select>
          </div>
          <div><label>期望薪资下限</label><input type="number" id="tSalary" min="0"></div>
          <div><label>关键词</label><input type="text" id="tKeyword" placeholder="姓名/项目/自我评价"></div>
          <div><button onclick="searchTalent()">搜索</button></div>
        </div>
        <div id="talentTable"><div class="empty">输入条件后点击“搜索”，仅展示选择了“公开”的简历</div></div>
      </div>
    </div>`;
};

// searchTalent：按条件检索公开简历
async function searchTalent() {
  const q = new URLSearchParams();
  const put = (k, id) => { const v = document.getElementById(id).value.trim(); if (v) q.set(k, v); };
  put('skills', 'tSkills'); put('city', 'tCity'); put('education', 'tEdu');
  put('minSalary', 'tSalary'); put('keyword', 'tKeyword');
  const rows = await api('/api/talent?' + q.toString()); // 请求人才列表
  const t = document.getElementById('talentTable');
  if (!rows.length) { t.innerHTML = '<div class="empty">没有符合条件的公开简历</div>'; return; }
  t.innerHTML = `
    <table class="grid"><thead><tr><th scope="col">姓名</th><th scope="col">技能</th><th scope="col">经验</th><th scope="col">学历</th><th scope="col">期望</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>
      
      ${rows.map((r) => `
        <tr>
          <td><b>${esc(r.name)}</b></td>
          <td class="match truncate" title="${esc(r.skills)}">${esc(r.skills)}</td>
          <td>${esc(r.experience)}</td>
          <td>${esc(r.education)}</td>
          <td>${esc(r.expected_city || '-')} ${r.expected_salary_min || '-'}-${r.expected_salary_max || '-'}</td>
          <td>${esc(jobStatusLabel(r.job_status))}</td>
          <td><button class="tiny" data-peer-id="${Number(r.user_id)}" data-peer-name="${esc(r.name)}" onclick="openChat(Number(this.dataset.peerId), this.dataset.peerName, contactText())">主动沟通</button></td>
        </tr>`).join('')}
    </tbody></table>`;
}

// jobStatusLabel：求职状态文案
function jobStatusLabel(s) {
  return { open: '在职-考虑机会', looking: '离职-随时到岗', closed: '暂不考虑' }[s] || '在职';
}

// 推荐候选人（企业）与推荐职位（求职者）
async function showRecommend(p) {
  if (user.role === 'company') {
    const rows = await api('/api/recommend/talent');
    return `<div class="card"><div class="card-head">为你推荐的候选人</div><div class="card-body">
      ${rows.length ? `<table class="grid"><thead><tr><th scope="col">姓名</th><th scope="col">技能</th><th scope="col">匹配分</th><th scope="col">理由</th><th scope="col">操作</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td class="match truncate" title="${esc(r.skills)}">${esc(r.skills)}</td>
        <td>${scoreCell(r.match.score)}</td><td class="match">${esc(r.match.reasons)}</td>
        <td><button class="tiny" data-peer-id="${Number(r.user_id)}" data-peer-name="${esc(r.name)}" onclick="openChat(Number(this.dataset.peerId), this.dataset.peerName, contactText())">主动沟通</button></td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">暂无推荐</div>'}
    </div></div>`;
  }
  const rows = await api('/api/recommend/jobs');
  return `<div class="card"><div class="card-head">为你推荐的职位</div><div class="card-body">
    ${rows.length ? `<table class="grid"><thead><tr><th scope="col">职位</th><th scope="col">企业</th><th scope="col">薪资</th><th scope="col">匹配分</th><th scope="col">理由</th><th scope="col">操作</th></tr></thead><tbody>
      ${rows.map((j) => `<tr><td><b>${esc(j.title)}</b></td><td>${esc(j.company)}</td>
      <td>${j.salary_min || 0}-${j.salary_max || '不限'}</td><td>${scoreCell(j.match.score)}</td>
      <td class="match">${esc(j.match.reasons)}</td>
      <td><button class="tiny" onclick="applyJob(${j.id}, this)">投递</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">完善简历后即可获得推荐</div>'}
  </div></div>`;
}


// openJobDetail：职位详情弹窗（含企业信息与相似职位）
async function openJobDetail(id) {
  try {
    const d = await api(`/api/jobs/${id}`); // 职位详情
    const sim = await api(`/api/jobs/${id}/similar`).catch(() => []); // 相似职位（失败不阻塞）
    document.getElementById('jobDetailMask')?.remove();
    const mask = document.createElement('div');
    mask.className = 'chat-mask';
    mask.id = 'jobDetailMask';
    mask.innerHTML = `
      <div class="chat-box modal-md">
        <div class="chat-head"><b>${esc(d.title)}</b>
          <button class="tiny ghost" onclick="document.getElementById('jobDetailMask').remove()">关闭</button></div>
        <div class="chat-body detail-body">
          <p><b>薪资：</b>${d.salary_min || 0}-${d.salary_max || '不限'} 元/月　
             <b>地点：</b>${esc(d.location || '-')}　<b>学历：</b>${esc(d.education || '不限')}　
             <b>经验：</b>${esc(d.experience || '不限')}</p>
          <p><b>职位要求：</b>${esc(d.requirements || '未填写')}</p>
          ${d.benefits ? `<p><b>福利：</b>${esc(d.benefits)}</p>` : ''}
          <p><b>企业：</b>${esc(d.company || '-')} ${d.verified ? badge('已认证', 'accepted') : ''}
             ${d.company_size ? '　规模：' + esc(d.company_size) : ''}</p>
          ${d.company_intro ? `<p class="match">${esc(d.company_intro)}</p>` : ''}
          <p><b>相似职位：</b>${sim.length ? sim.map((x) => `<a class="file" href="javascript:openJobDetail(${x.id})">${esc(x.title)}</a>`).join(' ') : '暂无'}</p>
        </div>
        <div class="chat-foot">
          <button onclick="applyJob(${d.id}, this)">投递该职位</button>
          <button class="tiny ghost" onclick="toggleFavorite(${d.id})">收藏</button>
          <button class="tiny ghost" onclick="toggleFollow(${d.company_id})">关注企业</button>
          ${user?.role === 'seeker' ? `<button class="tiny ghost" onclick="requestContact(${Number(d.company_id)})">交换联系方式</button>` : ''}
        </div>
        <div id="jobContactMsg"></div>
      </div>`;
    document.body.appendChild(mask); // 挂载弹窗
  } catch (err) { alert(err.message); }
}

// ---------------------------------------------------------------- 站内聊天
// chatSession：隔离会话窗口、分页游标及异步请求，避免旧响应写入新会话
let chatSession = null;

function isCurrentChat(session) {
  return session && chatSession === session && session.mask.isConnected && user && Number(user.id) === session.userId;
}

// 组装企业联系方式文本，供“发布联系方式”时预填
function contactText() {
  const lines = ['【联系方式】'];
  lines.push((user.company_name || user.name || '') + (user.company_name ? ' · 联系人：' + (user.name || '') : '')); // 企业名与联系人
  lines.push('电话：' + (user.phone || '未填写')); // 联系电话
  return lines.join('\n');
}

// openChat：打开与某人的聊天窗口（peerName 仅用于标题，prefill 为预填内容）
async function openChat(peerId, peerName, prefill) {
  peerId = Number(peerId);
  if (!user || !Number.isSafeInteger(peerId) || peerId <= 0) return;
  closeChat(); // 关闭旧窗口，同时使旧请求失效
  const mask = document.createElement('div');
  mask.className = 'chat-mask';
  mask.id = 'chatMask';
  mask.innerHTML = `
    <div class="chat-box">
      <div class="chat-head">
        <b id="chatTitle">与 ${esc(peerName || '对方')} 的会话</b>
        <button class="tiny ghost" onclick="closeChat()">关闭</button>
      </div>
      <div class="chat-quick">
        <button class="tiny ghost" id="chatEarlier" onclick="loadChat(true)" style="display:none">加载更早</button>
        <button class="tiny ghost" id="chatRefresh" onclick="loadChat()">刷新最新消息 / 回执</button>
      </div>
      <div class="chat-body" id="chatBody"><p class="match">加载中…</p></div>
      <div class="chat-quick">
        <button class="tiny ghost" onclick="quickReply('您好，看到您的简历很感兴趣，方便聊一下吗？')">打个招呼</button>
        <button class="tiny ghost" onclick="quickReply('方便的话，我们约个时间线上面试？')">约面试</button>
        <button class="tiny ghost" onclick="quickReply('请问您目前的期望薪资是多少？')">问期望</button>
        <button class="tiny ghost" onclick="quickReply('职位详情已发您，方便的话请回复是否感兴趣。')">发职位</button>
      </div>
      <div class="chat-foot">
        <textarea id="chatInput" rows="3" maxlength="500" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
        <button id="chatSend" onclick="sendChat()">发送</button>
      </div>
      <div id="chatMsg"></div>
    </div>`;
  chatSession = { peerId, userId: Number(user.id), mask, messages: [], hasMore: false, nextBefore: null, request: 0, loading: false, sending: false };
  document.body.appendChild(mask); // 挂到页面上
  const input = mask.querySelector('#chatInput');
  if (prefill) input.value = prefill;
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
  });
  await loadChat(); // 默认只请求最新 50 条
}

// quickReply：快捷回复模板，填入输入框
function quickReply(text) {
  const input = document.getElementById('chatInput');
  if (!input) return;
  input.value = text; // 填入模板
  input.focus(); // 聚焦便于直接发送
}

// closeChat：关闭聊天窗口并使在途请求失效
function closeChat() {
  chatSession = null;
  const mask = document.getElementById('chatMask');
  if (mask) mask.remove();
}

// loadChat：刷新最新一页或按游标加载更早消息，回执仅取服务端返回值
async function loadChat(earlier = false) {
  const session = chatSession;
  if (!isCurrentChat(session) || (earlier && (session.loading || !session.hasMore || !session.nextBefore))) return;
  const request = ++session.request;
  const box = session.mask.querySelector('#chatBody');
  const tip = session.mask.querySelector('#chatMsg');
  const more = session.mask.querySelector('#chatEarlier');
  const refresh = session.mask.querySelector('#chatRefresh');
  session.loading = true;
  more.disabled = refresh.disabled = true;
  tip.innerHTML = '';
  const query = new URLSearchParams({ limit: '50' });
  if (earlier) query.set('before', String(session.nextBefore));
  try {
    const d = await api(`/api/messages/${session.peerId}?${query}`);
    if (!isCurrentChat(session) || request !== session.request) return;
    const scrollTop = box.scrollTop, scrollHeight = box.scrollHeight;
    const rows = earlier ? [...(d.messages || []), ...session.messages] : (d.messages || []);
    session.messages = [...new Map(rows.map((m) => [Number(m.id), m])).values()].sort((a, b) => Number(a.id) - Number(b.id));
    session.nextBefore = Number(d.nextBefore) || null;
    session.hasMore = Boolean(d.hasMore) && Number.isSafeInteger(session.nextBefore) && session.nextBefore > 0;
    if (d.peer) session.mask.querySelector('#chatTitle').textContent = `与 ${d.peer.company_name || d.peer.name || '对方'} 的会话`;
    box.innerHTML = session.messages.length ? session.messages.map((m) => `
      <div class="chat-line ${Number(m.from_user_id) === session.userId ? 'me' : 'peer'}">
        <div class="chat-bubble">${esc(m.content).replace(/\n/g, '<br>')}</div>
        <div class="chat-time">${esc(timeFmt(m.created_at))}${Number(m.from_user_id) === session.userId ? ' · ' + (Number(m.is_read) === 1 ? '已读' : '未读') : ''}</div>
      </div>`).join('') : '<div class="empty">还没有消息，发出第一条消息吧</div>';
    box.scrollTop = earlier ? scrollTop + box.scrollHeight - scrollHeight : box.scrollHeight;
  } catch (err) {
    if (!isCurrentChat(session) || request !== session.request) return;
    if (!session.messages.length) box.innerHTML = '<div class="empty">未能加载消息，请点击刷新重试</div>';
    tip.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  } finally {
    if (isCurrentChat(session) && request === session.request) {
      session.loading = false;
      more.style.display = session.hasMore ? '' : 'none';
      more.disabled = refresh.disabled = false;
    }
  }
}

// sendChat：固定接收方，发送完成后仅更新发起发送的会话窗口
async function sendChat() {
  const session = chatSession;
  if (!isCurrentChat(session) || session.sending) return;
  const input = session.mask.querySelector('#chatInput');
  const tip = session.mask.querySelector('#chatMsg');
  const submit = session.mask.querySelector('#chatSend');
  const draft = input.value;
  const content = draft.trim();
  if (!content) { tip.innerHTML = '<div class="msg err">请输入消息内容</div>'; return; }
  session.sending = true;
  submit.disabled = true;
  try {
    await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ toUserId: session.peerId, content })
    });
    if (!isCurrentChat(session)) return;
    if (input.value === draft) input.value = '';
    tip.innerHTML = '';
    await loadChat();
  } catch (err) {
    if (isCurrentChat(session)) tip.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  } finally {
    if (isCurrentChat(session)) {
      session.sending = false;
      submit.disabled = false;
    }
  }
}

PANELS.chat = async (p) => {
  p.innerHTML = `
    <div class="card">
      <div class="card-head">聊天</div>
      <div class="card-body">
        <div class="chat-layout">
          <aside class="chat-side">
            <div class="chat-side-head"><span class="match">全部会话</span>
              <button class="tiny ghost" onclick="renderChatList()">刷新</button></div>
            <div id="chatList"><div class="empty">加载中…</div></div>
          </aside>
          <section class="chat-main" id="chatMain">
            <div class="empty">从左侧选择联系人开始聊天，历史消息会自动加载</div>
          </section>
        </div>
      </div>
    </div>`;
  await renderChatList(); // 首次加载会话列表
};

// renderChatList：渲染左侧联系人（企业端显示求职者，求职者端显示企业）
async function renderChatList(activePeer) {
  const list = await api('/api/messages/contacts'); // 拉取会话列表
  window.__chatContacts = list; // 缓存
  const box = document.getElementById('chatList');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<div class="empty">还没有会话</div>'; return; }
  box.innerHTML = list.map((c) => {
    const name = c.peer_company || c.peer_name || '对方'; // 企业名优先展示
    return `<button class="chat-item ${Number(c.peer_id) === Number(activePeer) ? 'active' : ''}"
        data-peer="${Number(c.peer_id)}" data-name="${esc(name)}" onclick="selectChatPeer(Number(this.dataset.peer), this.dataset.name)">
      <span class="chat-avatar" aria-hidden="true">${esc(String(name).slice(0, 1))}</span>
      <span class="chat-meta"><b>${esc(name)}</b><span class="match">${esc(String(c.last_content || '').slice(0, 18))}</span></span>
      ${Number(c.unread) > 0 ? `<span class="chat-unread">${Number(c.unread)}</span>` : ''}
    </button>`;
  }).join(''); // 渲染会话项
}

// selectChatPeer：切换右侧会话
async function selectChatPeer(peerId, peerName) {
  window.__chatPeer = { id: Number(peerId), name: peerName }; // 记录当前会话
  document.querySelectorAll('.chat-item').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.peer) === Number(peerId)); // 高亮当前联系人
  });
  const main = document.getElementById('chatMain');
  main.innerHTML = `
    <div class="chat-pane">
      <div class="chat-pane-head"><b>${esc(peerName || '对方')}</b>
        <button class="tiny ghost" onclick="openChat(${Number(peerId)}, this.dataset.n)" data-n="${esc(peerName || '')}">弹窗模式</button>
      </div>
      <div class="chat-history" id="chatHistory"><div class="match">加载中…</div></div>
      <div class="chat-pane-foot">
        <textarea id="chatText" rows="3" maxlength="500" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
        <button id="chatPaneSend" onclick="sendPaneMessage()">发送</button>
      </div>
      <div id="chatPaneMsg"></div>
    </div>`;
  await loadPaneMessages(); // 加载历史消息
  const ta = document.getElementById('chatText');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendPaneMessage(); } // Enter 发送
  });
  ta.focus();
}

// loadPaneMessages：加载当前会话最近 50 条消息
async function loadPaneMessages() {
  const peer = window.__chatPeer; // 当前会话
  if (!peer) return;
  const d = await api(`/api/messages/${peer.id}?limit=50`); // 拉取消息
  const box = document.getElementById('chatHistory');
  if (!box) return;
  const rows = d.messages || [];
  box.innerHTML = rows.length ? rows.map((m) => `
    <div class="chat-line ${Number(m.from_user_id) === Number(user.id) ? 'me' : 'peer'}">
      <div class="chat-bubble">${esc(m.content).replace(/\n/g, '<br>')}</div>
      <div class="chat-time">${esc(timeFmt(m.created_at))}${Number(m.from_user_id) === Number(user.id) ? ' · ' + (Number(m.is_read) === 1 ? '已读' : '未读') : ''}</div>
    </div>`).join('') : '<div class="empty">还没有消息，发出第一条吧</div>';
  box.scrollTop = box.scrollHeight; // 滚动到底
}

// sendPaneMessage：在面板内发送消息
async function sendPaneMessage() {
  const peer = window.__chatPeer;
  if (!peer) return;
  const ta = document.getElementById('chatText');
  const tip = document.getElementById('chatPaneMsg');
  const text = ta.value.trim();
  if (!text) { tip.innerHTML = '<div class="msg err">请输入消息内容</div>'; return; }
  const btn = document.getElementById('chatPaneSend');
  if (btn) btn.disabled = true; // 防重复提交
  try {
    await api('/api/messages', { method: 'POST', body: JSON.stringify({ toUserId: peer.id, content: text }) }); // 发送
    ta.value = ''; // 清空输入
    await loadPaneMessages(); // 刷新会话
    await renderChatList(peer.id); // 刷新左侧最近消息
    tip.innerHTML = ''; // 清空提示
  } catch (err) {
    tip.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; // 错误提示
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 兼容旧入口：openTab('contact') 仍可用
PANELS.contact = PANELS.chat;

// respondContact：同意或拒绝对方的联系方式交换请求
async function respondContact(id, accept, btn) {
  if (btn) btn.disabled = true;
  try {
    const d = await api(`/api/contact/requests/${id}/respond`, {
      method: 'POST', body: JSON.stringify({ accept })
    });
    await openTab('notify'); // 请求处理结果回到通知面板
    const tip = document.getElementById('contactMsg');
    if (tip) tip.innerHTML = `<div class="msg">${esc(d.message)}${accept ? '，对方电话：' + esc(d.phone || '未填写') : ''}</div>`;
  } catch (err) { alert(err.message); }
  finally { if (btn && btn.isConnected) btn.disabled = false; }
}

PANELS.notify = async (p) => {
  let d, reqs;
  try {
    [d, reqs] = await Promise.all([api('/api/notifications'), api('/api/contact/requests')]); // 通知 + 联系方式请求
  } catch (err) {
    p.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; // 请求失败提示
    return;
  }
  const list = d.list || [];
  const pending = (reqs.received || []).filter((r) => r.status === 'pending'); // 待处理的联系方式请求
  const handled = (reqs.received || []).filter((r) => r.status !== 'pending'); // 已处理的请求
  p.innerHTML = `
    <div class="card">
      <div class="card-head">联系方式请求</div>
      <div class="card-body">
        <div id="contactMsg"></div>
        ${pending.length ? pending.map((r) => `
          <div class="notice unread">
            <span class="n-type">交换联系方式</span>
            <span class="n-time">${timeFmt(r.created_at)}</span>
            <div class="n-body">${esc(r.user_name)}（${r.role === 'company' ? '企业' : '求职者'}${r.company_name ? ' · ' + esc(r.company_name) : ''}）请求交换联系方式</div>
            <div class="toolbar">
              <button class="tiny" onclick="respondContact(${Number(r.id)}, true, this)">同意</button>
              <button class="tiny ghost" onclick="respondContact(${Number(r.id)}, false, this)">拒绝</button>
              <button class="tiny ghost" onclick="openChat(${Number(r.from_user_id)}, '${esc(r.user_name)}')">先聊聊</button>
            </div>
          </div>`).join('') : '<div class="empty">暂无待处理的联系方式请求</div>'}
        ${handled.length ? `<h4 class="form-section">已处理的请求</h4>
          <table class="grid"><thead><tr><th scope="col">对方</th><th scope="col">角色</th><th scope="col">企业</th><th scope="col">结果</th><th scope="col">电话</th><th scope="col">操作</th></tr></thead><tbody>
          ${handled.map((r) => `<tr>
            <td>${esc(r.user_name)}</td>
            <td>${r.role === 'company' ? '企业' : '求职者'}</td>
            <td>${esc(r.company_name || '-')}</td>
            <td>${badge(r.status === 'accepted' ? '已同意' : '已拒绝', r.status)}</td>
            <td>${r.status === 'accepted' ? esc(r.peer_phone || '未填写') : '-'}</td>
            <td><button class="tiny ghost" onclick="openChat(${Number(r.from_user_id)}, '${esc(r.user_name)}')">聊天</button></td>
          </tr>`).join('')}
          </tbody></table>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="card-head">消息通知</div>
      <div class="card-body">
        ${d.unread ? `<div class="list-bar"><span class="match">${d.unread} 条未读</span>
          <button class="tiny" onclick="readAllNotify()">全部已读</button></div>` : ''}
        ${list.length ? list.map((n) => `
          <div class="notice ${n.is_read ? '' : 'unread'}">
            <span class="n-type">${{ application: '投递动态', interview: '面试邀约', contact: '联系方式', approve: '审核结果', message: '站内消息', account: '账号状态', resume: '简历动态', job: '职位动态', favorite: '收藏动态' }[n.type] || n.type}</span>
            <span class="n-time">${timeFmt(n.created_at)}</span>
            <div class="n-body">${esc(n.message)}</div>
            ${n.type === 'message' ? '<button class="tiny ghost" onclick="openTab(\'chat\')">去聊天</button>' : ''}
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
// companyJobs：企业端职位管理面板
async function companyJobs(p) {
  const jobs = await api('/api/jobs/mine');
  p.innerHTML = `
    <div class="card">
      <div class="card-head">职位管理</div>
      <div class="card-body">
        <div id="jobMsg"></div>
        <div class="list-bar">
          <span class="match">共 ${jobs.length} 个职位</span>
          <span class="inline">
            <button class="tiny ghost" onclick="batchOffline()">批量下架选中职位</button>
            <button class="tiny" onclick="toggleJobForm()">＋ 发布新职位</button>
          </span>
        </div>
        <div class="card spaced" id="jobForm" style="display:none">
          <div class="card-head">填写职位信息</div>
          <div class="card-body">
            <form class="form" onsubmit="saveJob(event)">
              <label>职位标题</label><input type="text" id="jTitle" required>
              <label>职位要求（技能标签用逗号分隔）</label>
              <textarea id="jReq" placeholder="如：JavaScript,React,Vue,前端工程化"></textarea>

              <h5 class="form-section">薪资与要求</h5>
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
              <div class="row">
                <div><label>职位类型</label>
                  <select id="jType">
                    <option value="fulltime">全职</option><option value="parttime">兼职</option>
                    <option value="intern">实习</option><option value="remote">远程</option>
                  </select>
                </div>
                <div><label>福利标签</label><input type="text" id="jBenefits" placeholder="如：五险一金,双休,弹性工作"></div>
              </div>
              <h5 class="form-section">技能与发布</h5>
              <label>技能快选（点击追加到职位要求）</label>
              <div class="chips" id="skillChips"></div>
              <p class="toolbar">
                <button type="button" class="tiny ghost" onclick="fillJobTemplate()">套用职位模板</button>
                <button type="submit" id="jobSubmit">发布职位</button>
              </p>
            </form>
          </div>
        </div>
        <div id="jobsTable"></div>
      </div>
    </div>`;
  renderJobsTable(jobs);
};

// 常用技能库：点击即可追加到职位要求，帮助结构化 JD
const SKILL_LIB = ['JavaScript', 'TypeScript', 'React', 'Vue', 'Node.js', 'Java', 'Python', 'MySQL',
  'Redis', 'Spring', 'Docker', '微服务', '数据分析'];

// renderSkillChips：渲染技能快捷标签
function renderSkillChips() {
  const box = document.getElementById('skillChips');
  if (!box) return;
  box.innerHTML = SKILL_LIB.map((s) => `<button type="button" class="chip" onclick="addSkill('${s}')">${s}</button>`).join('');
}

// addSkill：把技能追加到职位要求
function addSkill(skill) {
  const input = document.getElementById('jReq');
  const cur = input.value.trim();
  if (cur.includes(skill)) return; // 已存在不重复
  input.value = cur ? cur + ',' + skill : skill; // 逗号分隔追加
}

// fillJobTemplate：套用职位模板
function fillJobTemplate() {
  document.getElementById('jTitle').value = document.getElementById('jTitle').value || '前端开发工程师';
  document.getElementById('jReq').value = 'JavaScript,React,Vue,前端工程化';
  document.getElementById('jBenefits').value = '五险一金,双休,弹性工作,年度体检';
  document.getElementById('jType').value = 'fulltime';
}

// toggleJobForm：展开或收起职位发布表单
function toggleJobForm() {
  const box = document.getElementById('jobForm');
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
  renderSkillChips(); // 展开表单时渲染技能标签
}

let editingJobId = null;

// saveJob：提交职位表单（新建或编辑）
async function saveJob(e) {
  e.preventDefault();
  const body = {
    title: document.getElementById('jTitle').value,
    requirements: document.getElementById('jReq').value,
    location: document.getElementById('jLoc').value,
    salaryMin: document.getElementById('jSalMin').value,
    salaryMax: document.getElementById('jSalMax').value,
    education: document.getElementById('jEdu').value,
    experience: document.getElementById('jExp').value,
    jobType: document.getElementById('jType') ? document.getElementById('jType').value : 'fulltime',
    benefits: document.getElementById('jBenefits') ? document.getElementById('jBenefits').value : ''
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

// editJob：把职位数据填入表单进行编辑
async function editJob(id) {
  const form = document.getElementById('jobForm');
  try {
    const jobs = await api('/api/jobs/mine');
    if (!form || form !== document.getElementById('jobForm')) return;
    const job = jobs.find((j) => Number(j.id) === Number(id));
    if (!job) throw new Error('职位不存在或已删除，请刷新列表');
    editingJobId = job.id;
    document.getElementById('jTitle').value = job.title;
    document.getElementById('jReq').value = job.requirements || '';
    document.getElementById('jLoc').value = job.location || '';
    document.getElementById('jSalMin').value = job.salary_min || '';
    document.getElementById('jSalMax').value = job.salary_max || '';
    document.getElementById('jEdu').value = job.education || '';
    document.getElementById('jExp').value = job.experience || '';
    if (document.getElementById('jType')) document.getElementById('jType').value = job.job_type || 'fulltime';
    if (document.getElementById('jBenefits')) document.getElementById('jBenefits').value = job.benefits || '';
    document.getElementById('jobSubmit').textContent = '保存修改';
    form.style.display = 'block';
    renderSkillChips();
  } catch (err) { alert(err.message); }
}

// renderJobsTable：渲染职位表格（含运营按钮与投递数）
function renderJobsTable(jobs) {
  const t = document.getElementById('jobsTable');
  if (!jobs.length) { t.innerHTML = '<div class="empty">还没有发布职位</div>'; return; }
  t.innerHTML = `
    <table class="grid"><thead><tr><th scope="col">选择</th><th scope="col">职位</th><th scope="col">地点</th><th scope="col">薪资</th><th scope="col">投递数</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>
      
      ${jobs.map((j) => `
        <tr>
          <td><input type="checkbox" class="jobPick" value="${j.id}"></td>
          <td><b>${esc(j.title)}</b>${j.is_top ? ' ' + badge('置顶', 'accepted') : ''}${j.is_urgent ? ' ' + badge('急招', 'interview') : ''}</td>
          <td>${esc(j.location)}</td>
          <td class="num">${j.salary_min || 0}-${j.salary_max || '不限'}</td>
          <td class="num">${j.apply_count || 0}</td>
          <td>${badge({ offline: '已下架', published: '已发布' }[j.status] || j.status, j.status)}</td>
          <td>
            <button class="tiny" onclick="editJob(${j.id})">编辑</button>
            <button class="tiny ghost" onclick="jobOp(${j.id},'refresh')">刷新</button>
            <button class="tiny ghost" onclick="jobOp(${j.id},'top')">${j.is_top ? '取消置顶' : '置顶'}</button>
            <button class="tiny ghost" onclick="jobOp(${j.id},'urgent')">${j.is_urgent ? '取消急招' : '急招'}</button>
            ${j.status === 'offline'
              ? `<button class="tiny" onclick="republishJob(${j.id})">上架</button>`
              : `<button class="tiny ghost" onclick="unpublishJob(${j.id})">下架</button>`}
          </td>
        </tr>`).join('')}
    </tbody></table>`;
}

// republishJob：把已下架职位重新上架
async function republishJob(id) {
  try {
    await api(`/api/jobs/${id}/republish`, { method: 'PATCH' }); // 调用重新上架接口
    await openTab('jobs'); // 刷新列表
  } catch (err) { alert(err.message); }
}

// unpublishJob：下架指定职位
async function unpublishJob(id) {
  try {
    await api(`/api/jobs/${id}/unpublish`, { method: 'PATCH' });
    await openTab('jobs');
  } catch (err) { alert(err.message); }
}

PANELS.jobs = (p) => user.role === 'seeker' ? seekerJobs(p) : companyJobs(p);
PANELS.apps = async (p) => {
  const [stats, apps] = await Promise.all([
    api('/api/applications/received/stats'), // 各状态数量
    api('/api/applications/received'), // 全部收到的简历
  ]);
  window.__receivedApps = apps; // 缓存给筛选使用
  receivedAttachments = new Map(apps.map((a) => [Number(a.id), a])); // 附件预览缓存
  const tabs = [
    ['all', '全部', stats.all], ['submitted', '待查看', stats.submitted],
    ['viewed', '已查看', stats.viewed], ['interview', '待面试', stats.interview],
    ['accepted', '已录取', stats.accepted], ['rejected', '不通过', stats.rejected],
  ];
  p.innerHTML = `
    <div class="card">
      <div class="card-head">收到的简历</div>
      <div class="card-body">
        <div id="appsMsg"></div>
        <div class="seg" id="appStatusTabs" role="tablist">
          ${tabs.map(([k, n, c], i) => `<button type="button" role="tab" data-status="${k}" aria-selected="${i === 0}" class="${i === 0 ? 'active' : ''}" onclick="filterReceived('${k}')">${n} <span class="count">${c || 0}</span></button>`).join('')}
        </div>
        <div id="receivedTable"></div>
      </div>
    </div>`;
  renderReceived('all'); // 默认展示全部
};

// filterReceived：切换归档页签
function filterReceived(status) {
  document.querySelectorAll('#appStatusTabs button').forEach((b) => {
    const on = b.dataset.status === status; // 是否当前页签
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  renderReceived(status);
}

// renderReceived：按归档状态渲染收到的简历
function renderReceived(status) {
  const all = window.__receivedApps || [];
  const rows = status && status !== 'all' ? all.filter((a) => a.status === status) : all; // 过滤
  const box = document.getElementById('receivedTable');
  if (!box) return;
  if (!rows.length) { box.innerHTML = '<div class="empty">该归档下暂无简历</div>'; return; }
  box.innerHTML = `
    <table class="grid"><thead><tr><th scope="col">候选人</th><th scope="col">投递职位</th><th scope="col">投递次数</th><th scope="col">简历附件</th><th scope="col">技能标签</th><th scope="col">经验</th><th scope="col">学历</th><th scope="col">匹配分</th><th scope="col">匹配理由</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>
    ${rows.map((a) => `
      <tr>
        <td><b>${esc(a.candidate)}</b></td>
        <td>${esc(a.job_title)}</td>
        <td class="num">${Number(a.apply_count) || 1}</td>
        <td>${a.attachment_path
          ? (a.attachment_exists === false
              ? '<span class="match">附件已失效</span>'
              : `<button class="tiny" onclick="previewApplicationAttachment(${Number(a.id)})">预览</button>
                 <a class="file" href="/api/applications/${Number(a.id)}/attachment?download=1" download>下载</a>`)
          : '<span class="match">未上传</span>'}</td>
        <td class="match truncate" title="${esc(a.skills)}">${esc(a.skills)}</td>
        <td class="truncate" title="${esc(a.experience)}">${esc(a.experience)}</td>
        <td>${esc(a.education)}</td>
        <td>${scoreCell(a.match_score)}</td>
        <td class="match truncate" title="${esc(a.match_reasons)}">${esc(a.match_reasons)}</td>
        <td>${badge(statusLabel(a.status), a.status)}</td>
        <td>
          <button class="tiny" onclick="setAppStatus(${a.id},'viewed')">已查看</button>
          <button class="tiny" onclick="askInterview(${a.id})">邀面试</button>
          <button class="tiny ghost" onclick="setAppStatus(${a.id},'accepted')">录取</button>
          <button class="tiny ghost" onclick="setAppStatus(${a.id},'rejected')">不通过</button>
          <button class="tiny ghost" onclick="requestContact(${a.seeker_id})">交换联系方式</button>
          <button class="tiny ghost danger" onclick="deleteApplication(${a.id})">删除</button>
        </td>
      </tr>`).join('')}
    </tbody></table>`;
}

// deleteApplication：企业端删除收到的简历（软删除）
async function deleteApplication(id) {
  if (!confirm('确定删除这条简历记录吗？删除后不再出现在列表中。')) return;
  try {
    await api(`/api/applications/${id}`, { method: 'DELETE' }); // 软删除
    await openTab('apps'); // 刷新列表与计数
  } catch (err) { alert(err.message); }
}

// setAppStatus：修改投递状态（查看 / 面试 / 录用 / 不合适）
async function setAppStatus(id, status) {
  try {
    await api(`/api/applications/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    await openTab('apps');
  } catch (err) { alert(err.message); }
}

// requestContact：向对方发起交换联系方式请求
async function requestContact(toUserId) {
  try {
    const d = await api('/api/contact/request', {
      method: 'POST', body: JSON.stringify({ toUserId })
    });
    const tip = document.getElementById('jobContactMsg') || document.getElementById('appsMsg');
    if (tip) tip.innerHTML = `<div class="msg">${esc(d)}</div>`;
  } catch (err) { alert(err.message); }
}

PANELS.companies = async (p) => {
  const list = await api('/api/admin/companies');
  p.innerHTML = `
    <div class="card">
      <div class="card-head">企业注册审核</div>
      <div class="card-body">
        ${list.length ? `
        <table class="grid"><thead><tr><th scope="col">企业名称</th><th scope="col">联系人</th><th scope="col">用户名</th><th scope="col">电话</th><th scope="col">经营许可证</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>
          
          ${list.map((c) => `
            <tr>
              <td><b>${esc(c.company_name)}</b></td>
              <td>${esc(c.name)}</td>
              <td>${esc(c.username)}</td>
              <td>${esc(c.phone)}</td>
              <td>${fileLink('查看许可证', c.license_path)}</td>
              <td>${badge(c.status === 'pending' ? '待审核' : c.status === 'active' ? '已通过' : c.reject_reason ? '审核未通过' : '已停用',
                c.status === 'active' ? 'accepted' : c.status === 'pending' ? 'pending' : 'banned')}
                ${c.reject_reason ? `<div class="match">${esc(c.reject_reason)}</div>` : ''}</td>
              <td>${c.status === 'pending' || (c.status !== 'active' && c.reject_reason)
                ? `<button class="tiny" onclick="approveCompany(${Number(c.id)})">${c.reject_reason ? '重新审核通过' : '通过'}</button>
                   <button class="tiny ghost" onclick="rejectCompany(${Number(c.id)})">驳回</button>`
                : `<button class="tiny ghost" onclick="toggleUserStatus(${Number(c.id)},'active')">启用</button>
                   <button class="tiny ghost" onclick="toggleUserStatus(${Number(c.id)},'banned')">停用</button>`}</td>
            </tr>`).join('')}
        </tbody></table>` : '<div class="empty">暂无企业注册申请</div>'}
      </div>
    </div>`;
};

// rejectCompany：驳回企业注册并要求填写理由
async function rejectCompany(id) {
  const reason = prompt('请填写驳回理由（会通知企业）');
  if (!reason) return;
  try {
    await api(`/api/admin/companies/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    await openTab('companies');
  } catch (err) { alert(err.message); }
}

// approveCompany：管理员通过企业注册审核
async function approveCompany(id) {
  try {
    await api(`/api/admin/companies/${id}/approve`, { method: 'POST' });
    await openTab('companies');
  } catch (err) { alert(err.message); }
}

PANELS.users = async (p) => {
  p.innerHTML = `
    <div class="card">
      <div class="card-head">用户管理</div>
      <div class="card-body">
        <div class="filters">
          <div><label>关键词</label><input type="search" id="adminUserKeyword" placeholder="用户名 / 姓名 / 企业"></div>
          <div><label>角色</label>
            <select id="adminUserRole">
              <option value="">全部</option><option value="seeker">求职者</option>
              <option value="company">企业</option><option value="admin">管理员</option>
            </select>
          </div>
          <div><button onclick="loadAdminUsers()">查询</button></div>
        </div>
        <div id="adminUserTable"></div>
      </div>
    </div>`;
  await loadAdminUsers(); // 首次加载
};

// loadAdminUsers：按关键字与角色拉取用户列表
async function loadAdminUsers() {
  const kw = (document.getElementById('adminUserKeyword') || {}).value || '';
  const role = (document.getElementById('adminUserRole') || {}).value || '';
  const q = new URLSearchParams(); // 查询参数
  if (kw.trim()) q.set('keyword', kw.trim());
  if (role) q.set('role', role);
  const rows = await api(`/api/admin/users/manage?${q}`);
  const box = document.getElementById('adminUserTable');
  if (!box) return;
  box.innerHTML = `
    <table class="grid"><thead><tr><th scope="col">用户名</th><th scope="col">角色</th><th scope="col">姓名</th><th scope="col">企业</th><th scope="col">电话</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>
    ${rows.map((u) => `
      <tr>
        <td><b>${esc(u.username)}</b></td>
        <td>${{ seeker: '求职者', company: '企业', admin: '管理员' }[u.role] || esc(u.role)}</td>
        <td>${esc(u.name)}</td>
        <td>${esc(u.company_name || '-')}</td>
        <td>${esc(u.phone || '-')}</td>
        <td>${badge({ active: '正常', pending: '待审核', banned: '已停用' }[u.status] || u.status, u.status)}</td>
        <td>${u.role !== 'admin'
          ? `<button class="tiny ghost" onclick="toggleUserStatus(${u.id},'active')">启用</button>
             <button class="tiny ghost" onclick="toggleUserStatus(${u.id},'banned')">停用</button>
             <button class="tiny ghost danger" onclick="adminDeleteUser(${u.id}, '${esc(u.username)}')">删除</button>`
          : '<span class="match">-</span>'}</td>
      </tr>`).join('')}
    </tbody></table>`;
}

// adminDeleteUser：管理员删除用户（连带关联数据）
async function adminDeleteUser(id, username) {
  if (!confirm(`确定删除用户「${username}」吗？其简历、投递、消息等数据会一并删除，且不可恢复。`)) return;
  try {
    await api(`/api/admin/users/${id}`, { method: 'DELETE' });
    await loadAdminUsers();
  } catch (err) { alert(err.message); }
}

PANELS.adminJobs = async (p) => {
  p.innerHTML = `
    <div class="card">
      <div class="card-head">职位管理</div>
      <div class="card-body">
        <div class="filters">
          <div><label>关键词</label><input type="search" id="adminJobKeyword" placeholder="职位标题 / 企业名称"></div>
          <div><label>状态</label>
            <select id="adminJobStatus"><option value="">全部</option><option value="published">在招</option><option value="offline">已下架</option></select>
          </div>
          <div><button onclick="loadAdminJobs()">查询</button></div>
        </div>
        <div id="adminJobTable"></div>
      </div>
    </div>`;
  await loadAdminJobs(); // 首次加载
};

// loadAdminJobs：拉取职位列表并渲染
async function loadAdminJobs() {
  const kw = (document.getElementById('adminJobKeyword') || {}).value || '';
  const status = (document.getElementById('adminJobStatus') || {}).value || '';
  const q = new URLSearchParams(); // 查询参数
  if (kw.trim()) q.set('keyword', kw.trim());
  if (status) q.set('status', status);
  const rows = await api(`/api/admin/jobs/manage?${q}`);
  const box = document.getElementById('adminJobTable');
  if (!box) return;
  box.innerHTML = rows.length ? `
    <table class="grid"><thead><tr><th scope="col">职位</th><th scope="col">企业</th><th scope="col">地点</th><th scope="col">薪资</th><th scope="col">投递</th><th scope="col">状态</th><th scope="col">标记</th><th scope="col">操作</th></tr></thead><tbody>
    ${rows.map((j) => `
      <tr>
        <td><b>${esc(j.title)}</b></td>
        <td>${esc(j.company_name)}</td>
        <td>${esc(j.location || '-')}</td>
        <td class="num">${j.salary_min || 0}-${j.salary_max || '不限'}</td>
        <td class="num">${Number(j.apply_count) || 0}</td>
        <td>${badge(j.status === 'published' ? '在招' : '已下架', j.status === 'published' ? 'accepted' : 'banned')}</td>
        <td>${Number(j.is_top) ? badge('置顶', 'pending') : ''} ${Number(j.is_urgent) ? badge('急招', 'interview') : ''}</td>
        <td>
          ${j.status === 'published'
            ? `<button class="tiny ghost" onclick="adminJobAction(${j.id},{status:'offline'})">下架</button>`
            : `<button class="tiny ghost" onclick="adminJobAction(${j.id},{status:'published'})">上架</button>`}
          <button class="tiny ghost" onclick="adminJobAction(${j.id},{isTop:${Number(j.is_top) ? 0 : 1}})">${Number(j.is_top) ? '取消置顶' : '置顶'}</button>
          <button class="tiny ghost" onclick="adminJobAction(${j.id},{isUrgent:${Number(j.is_urgent) ? 0 : 1}})">${Number(j.is_urgent) ? '取消急招' : '急招'}</button>
          <button class="tiny ghost danger" onclick="adminDeleteJob(${j.id}, '${esc(j.title)}')">删除</button>
        </td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="empty">没有符合条件的职位</div>';
}

// adminJobAction：管理员修改职位状态或标记
async function adminJobAction(id, patch) {
  try {
    await api(`/api/admin/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await loadAdminJobs(); // 刷新列表
  } catch (err) { alert(err.message); }
}

// adminDeleteJob：管理员删除职位及其投递记录
async function adminDeleteJob(id, title) {
  if (!confirm(`确定删除职位「${title}」吗？该职位的投递与面试记录会一并删除。`)) return;
  try {
    await api(`/api/admin/jobs/${id}`, { method: 'DELETE' });
    await loadAdminJobs();
  } catch (err) { alert(err.message); }
}

// toggleUserStatus：启用或停用用户账号
async function toggleUserStatus(id, status) {
  try {
    await api(`/api/admin/users/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    const active = document.querySelector('#dashTabs button.active');
    await openTab(active ? active.dataset.t : 'companies');
  } catch (err) { alert(err.message); }
}

// wrapTables：为表格套上横向滚动容器，窄屏时表格内部滚动而不是撑破页面
function wrapTables(root) {
  (root || document).querySelectorAll('table.grid').forEach((t) => {
    if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return; // 已包裹则跳过
    const box = document.createElement('div'); // 新建滚动容器
    box.className = 'table-wrap'; // 标记容器类名
    box.tabIndex = 0;
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', '数据表格，可横向滚动查看');
    t.parentNode.insertBefore(box, t); // 先把容器插到表格原位置
    box.appendChild(t); // 再把表格移进容器
  });
}

// 监听面板内容变化：后续异步渲染出来的表格同样自动套上滚动容器
const panelEl = document.getElementById('dashPanels');
if (panelEl && window.MutationObserver) {
  new MutationObserver(() => wrapTables(panelEl)).observe(panelEl, { childList: true, subtree: true });
}

(async function init() {
  try {
    user = await api('/api/me'); // 依靠服务端 HttpOnly Cookie 恢复登录态
    enterDashboard();
  } catch (e) {
    token = null; // 未登录则停留在登录页
  }
})();

