// 简化匹配推荐：技能标签 + 经验/学历符合度
function splitTags(text) {
  return String(text || '')
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function matchScore(resume, job) {
  const jobSkills = splitTags(job.requirements).filter((t) => t.length > 1);
  const resumeSkills = splitTags(resume.skills);
  const hit = jobSkills.filter((j) => resumeSkills.some((r) => j.includes(r) || r.includes(j)));

  let score = 0;
  const reasons = [];

  if (hit.length) {
    score += Math.min(60, hit.length * 20);
    reasons.push(`技能吻合（${hit.join('、')}）`);
  }

  if (job.experience && resume.experience) {
    const jobYears = (job.experience.match(/(\d+)/) || [])[1];
    if (jobYears) {
      const resumeYears = (resume.experience.match(/(\d+)/) || [])[1];
      if (resumeYears && +resumeYears >= +jobYears) {
        score += 20;
        reasons.push('经验符合');
      }
    }
  }

  if (job.education && resume.education && job.education.includes(resume.education)) {
    score += 20;
    reasons.push('学历符合');
  }

  if (!reasons.length) reasons.push('暂无突出匹配项');
  return { score, reasons: reasons.join('；') };
}

module.exports = { matchScore, splitTags };
