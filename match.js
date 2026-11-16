// match.js：简化匹配推荐，按简历技能标签与职位要求打分

// splitTags：把逗号/空格等分隔的技能文本拆分成标签数组
function splitTags(text) {
  return String(text || '')
    .split(/[,，、\s]+/) // 按多种分隔符拆分
    .map((t) => t.trim()) // 去除两端空白
    .filter(Boolean); // 过滤空字符串
}

// matchScore：计算简历与职位的匹配分和匹配理由
function matchScore(resume, job) {
  const jobSkills = splitTags(job.requirements).filter((t) => t.length > 1); // 拆分职位要求中的技能
  const resumeSkills = splitTags(resume.skills); // 拆分简历中的技能标签
  const hit = jobSkills.filter((j) => resumeSkills.some((r) => j.includes(r) || r.includes(j))); // 找出命中的技能

  let score = 0; // 累计匹配分
  const reasons = []; // 累计匹配理由

  if (hit.length) { // 有技能命中时加分
    score += Math.min(60, hit.length * 20); // 技能最多计 60 分
    reasons.push(`技能吻合（${hit.join('、')}）`); // 记录技能吻合理由
  }

  if (job.experience && resume.experience) { // 双方均有经验信息时校验经验
    const jobYears = (job.experience.match(/(\d+)/) || [])[1]; // 提取职位要求年限
    if (jobYears) {
      const resumeYears = (resume.experience.match(/(\d+)/) || [])[1]; // 提取简历年限
      if (resumeYears && +resumeYears >= +jobYears) { // 简历年限满足职位要求
        score += 20; // 经验项加 20 分
        reasons.push('经验符合'); // 记录经验符合理由
      }
    }
  }

  if (job.education && resume.education && job.education.includes(resume.education)) { // 学历满足要求
    score += 20; // 学历项加 20 分
    reasons.push('学历符合'); // 记录学历符合理由
  }

  if (!reasons.length) reasons.push('暂无突出匹配项'); // 无任何匹配时给出兜底理由
  return { score, reasons: reasons.join('；') }; // 返回匹配分与合并后的理由
}

// 导出匹配函数，供投递时计算
module.exports = { matchScore, splitTags };
