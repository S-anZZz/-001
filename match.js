// match.js：简历与职位的匹配打分（分词精确匹配 + 加权）
const WEIGHT_SKILL = 60; // 技能分权重
const WEIGHT_EXP = 20; // 经验分权重
const WEIGHT_EDU = 20; // 学历分权重

// 常见同义写法归一到同一个标签，避免 "React.js" 与 "React" 被当成两种技能
const ALIAS = {
  reactjs: 'react', 'react.js': 'react', react: 'react',
  vuejs: 'vue', 'vue.js': 'vue', vue: 'vue',
  nodejs: 'node', 'node.js': 'node', node: 'node',
  js: 'javascript', javascript: 'javascript',
  ts: 'typescript', typescript: 'typescript',
  mysql: 'mysql', 数据库: 'mysql', db: 'mysql',
};

// normalize：小写、去空白，并按别名表归一
function normalizeTag(tag) {
  const key = String(tag || '').toLowerCase().replace(/\s+/g, ''); // 统一小写并去掉空白
  return ALIAS[key] || key; // 命中别名则替换，否则用原值
}

// splitTagEntries：拆分技能文本，返回 [{ key: 归一值, label: 原始写法 }]，便于原样展示
function splitTagEntries(text) {
  return String(text || '')
    .split(/[,，、;；/|]+|\s{2,}/)
    .flatMap((t) => t.split(/\s+/))
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ key: normalizeTag(t), label: t }));
}

// splitTags：把逗号/顿号/空格分隔的技能文本拆成标签数组并归一
function splitTags(text) {
  return String(text || '')
    .split(/[,，、;；/|]+|\s{2,}/) // 只按显式分隔符切分，避免把 "Node.js" 拆坏
    .flatMap((t) => t.split(/\s+/)) // 再按单个空格拆分多词短语
    .map((t) => t.trim())
    .filter(Boolean)
    .map(normalizeTag);
}

// eduLevel：把学历文本换算成可比较的等级，便于判断"是否满足"
function eduLevel(text) {
  const s = String(text || '');
  if (/博士/.test(s)) return 5;
  if (/硕士|研究生/.test(s)) return 4;
  if (/本科/.test(s)) return 3;
  if (/大专|专科/.test(s)) return 2;
  if (/高中|中专/.test(s)) return 1;
  return 0;
}

// parseYears：从"3-5年""5年以上""应届生"等文本中解析出年限
function parseYears(text) {
  const s = String(text || '');
  if (/应届|在校/.test(s)) return 0; // 应届生按 0 年
  const nums = s.match(/\d+/g); // 取出所有数字
  if (!nums) return null; // 没有数字无法判断
  return Math.min.apply(null, nums.map(Number)); // 取最小值作为门槛
}

// matchScore：计算匹配分（0~100）与可读的匹配理由
function matchScore(resume, job) {
  const jobEntries = splitTagEntries(job.requirements); // 职位要求的技能（含原始写法）
  const resumeEntries = splitTagEntries(resume.skills); // 简历中的技能（含原始写法）
  const resumeSet = new Set(resumeEntries.map((e) => e.key)); // 用归一值集合做精确比对，避免子串误判

  // 关键词命中：归一后完全相等才算命中，因此 Java 不会命中 JavaScript，React.js 等同于 React
  const hit = jobEntries.filter((e) => resumeSet.has(e.key)).map((e) => e.label);
  const jobSkills = jobEntries;
  const reasons = []; // 匹配理由
  let score = 0; // 累计得分

  if (jobSkills.length) { // 职位有明确技能要求时才计算技能分
    const ratio = hit.length / jobSkills.length; // 技能覆盖率
    score += Math.round(WEIGHT_SKILL * ratio); // 按覆盖率给分
    if (hit.length) reasons.push(`技能吻合 ${hit.length}/${jobSkills.length}（${hit.join('、')}）`); // 命中明细
    else reasons.push('技能暂未匹配'); // 一个都没命中
  }

  // 经验：简历年限不低于职位门槛才得分
  const jobYears = parseYears(job.experience);
  const resumeYears = parseYears(resume.experience);
  if (jobYears !== null && resumeYears !== null) {
    if (resumeYears >= jobYears) {
      score += WEIGHT_EXP; // 经验满足
      reasons.push(`经验符合（${resumeYears} 年 ≥ 要求 ${jobYears} 年）`);
    } else {
      reasons.push(`经验偏少（${resumeYears} 年 < 要求 ${jobYears} 年）`); // 不满足也要说明原因
    }
  }

  // 学历：简历学历不低于职位要求才得分
  const jobEdu = eduLevel(job.education);
  const resumeEdu = eduLevel(resume.education);
  if (jobEdu && resumeEdu) {
    if (resumeEdu >= jobEdu) {
      score += WEIGHT_EDU; // 学历满足
      reasons.push(`学历符合（${resume.education} ≥ ${job.education}）`);
    } else {
      reasons.push(`学历略低（${resume.education} < ${job.education}）`);
    }
  }

  if (!reasons.length) reasons.push('暂无突出匹配项'); // 兜底理由
  return { score: Math.max(0, Math.min(100, score)), reasons: reasons.join('；') }; // 归一到 0~100
}

module.exports = { matchScore, splitTags, splitTagEntries, normalizeTag };
