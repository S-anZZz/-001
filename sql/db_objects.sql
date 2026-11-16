-- =====================================================================
-- db_objects.sql —— 在线求职招聘系统 数据库扩展对象
-- 包含：视图 3 个、存储过程 2 个、存储函数 2 个、触发器 2 个
-- 适用：MySQL 8.0 及以上（本地开发库 add_work）
-- 说明：应用启动时会由 db.js 自动建表并写入演示数据，本脚本在建表之后执行
-- =====================================================================

USE add_work; -- 切换到本项目数据库

-- ---------------------------------------------------------------------
-- 一、视图设计
-- ---------------------------------------------------------------------

-- 1.1 v_job_list：职位列表视图，联出企业信息、投递数量与薪资文本
DROP VIEW IF EXISTS v_job_list; -- 重复执行时先删除旧视图，保证脚本可重复运行
CREATE VIEW v_job_list AS -- 创建职位列表视图
SELECT
  j.id                AS job_id,        -- 职位主键
  j.title             AS title,         -- 职位标题
  j.requirements      AS requirements,  -- 职位要求（技能标签，逗号分隔）
  j.location          AS location,      -- 工作地点
  j.salary_min        AS salary_min,    -- 薪资下限（元/月）
  j.salary_max        AS salary_max,    -- 薪资上限（元/月）
  j.education         AS education,     -- 学历要求
  j.experience        AS experience,    -- 经验要求
  j.status            AS status,        -- 职位状态：pending/ published/ offline
  u.id                AS company_id,    -- 企业用户主键
  u.company_name      AS company_name,  -- 企业名称
  u.name              AS contact_name,  -- 企业联系人
  COUNT(a.id)         AS apply_count    -- 该职位累计收到的投递数量
FROM jobs j -- 主表：职位
JOIN users u ON u.id = j.company_id -- 关联发布该职位的企业
LEFT JOIN applications a ON a.job_id = j.id -- 左连投递表，未收到投递时计数为 0
GROUP BY j.id, j.title, j.requirements, j.location, j.salary_min, j.salary_max,
         j.education, j.experience, j.status, u.id, u.company_name, u.name; -- 按职位与企业维度分组

-- 1.2 v_application_detail：投递详情视图，联出求职者、简历、职位、企业四方信息
DROP VIEW IF EXISTS v_application_detail; -- 先删后建，保证可重复执行
CREATE VIEW v_application_detail AS -- 创建投递详情视图
SELECT
  a.id                AS application_id, -- 投递记录主键
  a.status            AS status,         -- 投递状态：submitted / viewed / interview / accepted / rejected
  a.match_score       AS match_score,    -- 投递时计算出的匹配分（0~100）
  a.match_reasons     AS match_reasons,  -- 匹配理由文本
  a.meeting_link      AS meeting_link,   -- 线上面试链接
  a.created_at        AS created_at,     -- 投递时间
  s.id                AS seeker_id,      -- 求职者用户主键
  s.name              AS seeker_name,    -- 求职者姓名
  s.phone             AS seeker_phone,   -- 求职者联系电话
  r.skills            AS skills,         -- 简历技能标签
  r.experience        AS experience,     -- 简历工作经历
  r.education         AS education,      -- 简历学历
  r.attachment_name   AS attachment_name,-- 简历附件原始文件名
  j.id                AS job_id,         -- 职位主键
  j.title             AS job_title,      -- 职位标题
  j.location          AS job_location,   -- 工作地点
  j.salary_min        AS salary_min,     -- 薪资下限
  j.salary_max        AS salary_max,     -- 薪资上限
  c.id                AS company_id,     -- 企业用户主键
  c.company_name      AS company_name    -- 企业名称
FROM applications a -- 主表：投递记录
JOIN users s ON s.id = a.seeker_id -- 关联投递人（求职者）
JOIN users c ON c.id = a.company_id -- 关联接收方（企业）
JOIN jobs j ON j.id = a.job_id -- 关联被投递的职位
LEFT JOIN resumes r ON r.id = a.resume_id; -- 左连简历表，附件缺失时仍能查出投递

-- 1.3 v_company_stat：企业运营统计视图，汇总职位数与投递处理情况
DROP VIEW IF EXISTS v_company_stat; -- 先删后建
CREATE VIEW v_company_stat AS -- 创建企业统计视图
SELECT
  u.id                                                   AS company_id,   -- 企业主键
  u.company_name                                         AS company_name, -- 企业名称
  COUNT(DISTINCT j.id)                                   AS job_count,    -- 已发布职位总数
  COUNT(a.id)                                            AS apply_total,  -- 收到的投递总数
  SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END) AS pending_count, -- 待处理投递数
  SUM(CASE WHEN a.status = 'interview' THEN 1 ELSE 0 END) AS interview_count -- 已发面试邀约数
FROM users u -- 主表：用户表
LEFT JOIN jobs j ON j.company_id = u.id AND j.status = 'published' -- 只统计已发布职位
LEFT JOIN applications a ON a.company_id = u.id -- 关联该企业收到的投递
WHERE u.role = 'company' -- 仅统计企业角色
GROUP BY u.id, u.company_name; -- 按企业分组汇总

-- ---------------------------------------------------------------------
-- 二、存储函数设计
-- ---------------------------------------------------------------------

DROP FUNCTION IF EXISTS fn_salary_text; -- 重复执行时先删除旧函数
DELIMITER $$ -- 临时改变语句分隔符，便于在函数体内使用分号
CREATE FUNCTION fn_salary_text(p_min INT, p_max INT) -- 定义函数：把薪资上下限格式化成“15K-25K”
RETURNS VARCHAR(32) -- 返回字符串结果
DETERMINISTIC -- 相同入参必得相同结果，允许优化器缓存
BEGIN
  IF p_min IS NULL AND p_max IS NULL THEN -- 两个薪资都为空
    RETURN '面议'; -- 统一显示为面议
  END IF;
  IF p_max IS NULL THEN -- 只有下限
    RETURN CONCAT(FLOOR(p_min / 1000), 'K 起'); -- 显示“15K 起”
  END IF;
  IF p_min IS NULL THEN -- 只有上限
    RETURN CONCAT('最高 ', FLOOR(p_max / 1000), 'K'); -- 显示“最高 25K”
  END IF;
  RETURN CONCAT(FLOOR(p_min / 1000), 'K-', FLOOR(p_max / 1000), 'K'); -- 正常区间显示
END$$ -- 函数体结束
DELIMITER ; -- 恢复默认分隔符

DROP FUNCTION IF EXISTS fn_match_score; -- 重复执行时先删除旧函数
DELIMITER $$ -- 进入自定义分隔符模式
CREATE FUNCTION fn_match_score( -- 定义函数：与应用层完全一致的加权匹配分（技能 60 + 经验 20 + 学历 20）
  p_skills TEXT, p_requirements TEXT, -- 简历技能、职位要求
  p_resume_exp VARCHAR(32), p_job_exp VARCHAR(32), -- 简历与职位的经验要求
  p_resume_edu VARCHAR(32), p_job_edu VARCHAR(32) -- 简历与职位的学历要求
)
RETURNS INT -- 返回 0~100 的整数分数
DETERMINISTIC -- 纯函数，无副作用
BEGIN
  DECLARE v_rest TEXT; -- 待处理的职位要求串
  DECLARE v_tag VARCHAR(64); -- 当前取出的单个技能
  DECLARE v_skills TEXT; -- 归一化后的简历技能串
  DECLARE v_total INT DEFAULT 0; -- 职位要求中的技能总数
  DECLARE v_hit INT DEFAULT 0; -- 简历命中的技能数
  DECLARE v_score INT DEFAULT 0; -- 累计得分
  DECLARE v_ry INT DEFAULT -1; -- 简历年限
  DECLARE v_jy INT DEFAULT -1; -- 职位要求年限
  DECLARE v_re INT DEFAULT 0; -- 简历学历等级
  DECLARE v_je INT DEFAULT 0; -- 职位学历等级

  IF p_requirements IS NULL OR p_skills IS NULL THEN -- 任一侧为空无法比较
    RETURN 0; -- 返回 0 分
  END IF;

  SET v_skills = REPLACE(REPLACE(p_skills, '，', ','), ' ', ''); -- 统一中文逗号并去空白
  SET v_rest = REPLACE(REPLACE(p_requirements, '，', ','), ' ', ''); -- 同上

  WHILE LENGTH(v_rest) > 0 DO -- 逐个切分职位要求里的技能
    SET v_tag = SUBSTRING_INDEX(v_rest, ',', 1); -- 取第一个技能
    SET v_rest = IF(LOCATE(',', v_rest) > 0, SUBSTRING(v_rest, LOCATE(',', v_rest) + 1), ''); -- 剩余部分
    IF v_tag <> '' THEN -- 跳过空串
      SET v_total = v_total + 1; -- 技能总数加一
      -- 用逗号包裹做精确匹配，Java 不会命中 JavaScript
      IF LOCATE(CONCAT(',', v_tag, ','), CONCAT(',', v_skills, ',')) > 0 THEN
        SET v_hit = v_hit + 1; -- 命中则累加
      END IF;
    END IF;
  END WHILE;

  IF v_total > 0 THEN -- 有技能要求时按覆盖率折算 60 分
    SET v_score = v_score + ROUND(60 * v_hit / v_total); -- 技能分
  END IF;

  -- 经验：取双方文本里的最小数字作为年限，简历不低于要求才加 20 分
  IF p_resume_exp IS NOT NULL AND p_resume_exp <> '' THEN
    SET v_ry = CAST(REGEXP_SUBSTR(p_resume_exp, '[0-9]+') AS UNSIGNED); -- 简历年限
  END IF;
  IF p_job_exp IS NOT NULL AND p_job_exp <> '' THEN
    SET v_jy = CAST(REGEXP_SUBSTR(p_job_exp, '[0-9]+') AS UNSIGNED); -- 职位年限
  END IF;
  IF v_ry >= 0 AND v_jy >= 0 AND v_ry >= v_jy THEN
    SET v_score = v_score + 20; -- 经验满足
  END IF;

  -- 学历：折算成等级再比较，简历不低于要求才加 20 分
  SET v_re = CASE WHEN p_resume_edu LIKE '%博士%' THEN 5 WHEN p_resume_edu LIKE '%硕士%' OR p_resume_edu LIKE '%研究生%' THEN 4
                  WHEN p_resume_edu LIKE '%本科%' THEN 3 WHEN p_resume_edu LIKE '%大专%' OR p_resume_edu LIKE '%专科%' THEN 2
                  WHEN p_resume_edu LIKE '%高中%' OR p_resume_edu LIKE '%中专%' THEN 1 ELSE 0 END; -- 简历学历等级
  SET v_je = CASE WHEN p_job_edu LIKE '%博士%' THEN 5 WHEN p_job_edu LIKE '%硕士%' OR p_job_edu LIKE '%研究生%' THEN 4
                  WHEN p_job_edu LIKE '%本科%' THEN 3 WHEN p_job_edu LIKE '%大专%' OR p_job_edu LIKE '%专科%' THEN 2
                  WHEN p_job_edu LIKE '%高中%' OR p_job_edu LIKE '%中专%' THEN 1 ELSE 0 END; -- 职位学历等级
  IF v_re > 0 AND v_je > 0 AND v_re >= v_je THEN
    SET v_score = v_score + 20; -- 学历满足
  END IF;

  RETURN LEAST(100, v_score); -- 归一到 0~100
END$$ -- 函数体结束
DELIMITER ; -- 恢复默认分隔符

-- ---------------------------------------------------------------------
-- 三、存储过程设计
-- ---------------------------------------------------------------------

DROP PROCEDURE IF EXISTS sp_audit_job; -- 重复执行时先删除旧过程
DELIMITER $$ -- 进入自定义分隔符模式
CREATE PROCEDURE sp_audit_job( -- 定义存储过程：管理员审核职位
  IN  p_job_id INT, -- 入参：职位主键
  IN  p_action VARCHAR(16), -- 入参：pass 表示通过，reject 表示驳回
  OUT p_msg VARCHAR(64) -- 出参：执行结果说明
)
BEGIN
  DECLARE v_status VARCHAR(16) DEFAULT 'pending'; -- 保存职位当前状态
  DECLARE v_company_id INT DEFAULT 0; -- 保存职位所属企业
  DECLARE EXIT HANDLER FOR SQLEXCEPTION -- 出现任何 SQL 异常时
  BEGIN
    ROLLBACK; -- 回滚事务
    SET p_msg = '审核失败：数据库异常'; -- 返回错误说明
  END;
  START TRANSACTION; -- 开启事务，保证状态与通知同时生效
  SELECT status, company_id INTO v_status, v_company_id FROM jobs WHERE id = p_job_id FOR UPDATE; -- 加行锁读取职位
  IF v_company_id = 0 THEN -- 职位不存在
    SET p_msg = '审核失败：职位不存在'; -- 返回提示
    ROLLBACK; -- 回滚
  ELSE
    IF p_action = 'pass' THEN -- 审核通过
      UPDATE jobs SET status = 'published' WHERE id = p_job_id; -- 职位进入职位库
      INSERT INTO notifications (user_id, type, message) -- 给企业写一条通知
      VALUES (v_company_id, 'audit', CONCAT('职位「', (SELECT title FROM jobs WHERE id = p_job_id), '」审核通过，已上架')); -- 通知内容
      SET p_msg = '审核通过，职位已上架'; -- 返回提示
    ELSE -- 其余情况按驳回处理
      UPDATE jobs SET status = 'offline' WHERE id = p_job_id; -- 职位置为已下架（与代码状态枚举一致）
      INSERT INTO notifications (user_id, type, message) -- 给企业写一条通知
      VALUES (v_company_id, 'audit', CONCAT('职位「', (SELECT title FROM jobs WHERE id = p_job_id), '」未通过审核，请修改后重新提交')); -- 通知内容
      SET p_msg = '已驳回该职位'; -- 返回提示
    END IF;
    COMMIT; -- 提交事务
  END IF;
END$$ -- 过程体结束
DELIMITER ; -- 恢复默认分隔符

DROP PROCEDURE IF EXISTS sp_apply_job; -- 重复执行时先删除旧过程
DELIMITER $$ -- 进入自定义分隔符模式
CREATE PROCEDURE sp_apply_job( -- 定义存储过程：求职者投递职位
  IN  p_seeker_id INT, -- 入参：求职者主键
  IN  p_job_id INT, -- 入参：职位主键
  OUT p_app_id INT, -- 出参：新投递记录主键
  OUT p_msg VARCHAR(64) -- 出参：执行结果说明
)
BEGIN
  DECLARE v_resume_id INT DEFAULT 0; -- 简历主键
  DECLARE v_skills TEXT; -- 简历技能标签
  DECLARE v_company_id INT DEFAULT 0; -- 职位所属企业
  DECLARE v_requirements TEXT; -- 职位要求
  DECLARE v_r_exp VARCHAR(32); -- 简历经验
  DECLARE v_r_edu VARCHAR(32); -- 简历学历
  DECLARE v_j_exp VARCHAR(32); -- 职位经验要求
  DECLARE v_j_edu VARCHAR(32); -- 职位学历要求
  DECLARE v_dup INT DEFAULT 0; -- 重复投递数
  DECLARE v_score INT DEFAULT 0; -- 计算出的匹配分
  DECLARE EXIT HANDLER FOR SQLEXCEPTION -- 异常处理
  BEGIN
    ROLLBACK; -- 回滚事务
    SET p_app_id = 0, p_msg = '投递失败：数据库异常'; -- 返回错误
  END;
  START TRANSACTION; -- 开启事务
  SELECT id, skills, experience, education INTO v_resume_id, v_skills, v_r_exp, v_r_edu
    FROM resumes WHERE user_id = p_seeker_id LIMIT 1; -- 取求职者简历（含经验与学历）
  IF v_resume_id = 0 THEN -- 没有简历
    SET p_msg = '请先创建简历后再投递'; -- 提示先建简历
    ROLLBACK; -- 回滚
  ELSE
    SELECT company_id, requirements, experience, education INTO v_company_id, v_requirements, v_j_exp, v_j_edu
      FROM jobs WHERE id = p_job_id AND status = 'published'; -- 取已发布职位（含经验与学历要求）
    IF v_company_id = 0 THEN -- 职位不存在或未发布
      SET p_msg = '职位不存在或已下架'; -- 提示
      ROLLBACK; -- 回滚
    ELSE
      SELECT COUNT(*) INTO v_dup FROM applications WHERE seeker_id = p_seeker_id AND job_id = p_job_id; -- 查重
      IF v_dup > 0 THEN -- 已经投递过
        SET p_msg = '已投递过该职位，请勿重复投递'; -- 提示
        ROLLBACK; -- 回滚
      ELSE
        SET v_score = fn_match_score(v_skills, v_requirements, v_r_exp, v_j_exp, v_r_edu, v_j_edu); -- 与应用层一致的加权匹配分
        INSERT INTO applications (resume_id, job_id, seeker_id, company_id, status, match_score, match_reasons) -- 插入投递记录
        VALUES (v_resume_id, p_job_id, p_seeker_id, v_company_id, 'submitted', v_score, CONCAT('技能匹配分 ', v_score)); -- 初始状态为已投递
        SET p_app_id = LAST_INSERT_ID(); -- 取出新记录主键
        INSERT INTO notifications (user_id, type, message) -- 通知企业
        VALUES (v_company_id, 'application', CONCAT('收到新简历，匹配分 ', v_score)); -- 通知内容
        SET p_msg = '投递成功'; -- 返回提示
        COMMIT; -- 提交事务
      END IF;
    END IF;
  END IF;
END$$ -- 过程体结束
DELIMITER ; -- 恢复默认分隔符

-- ---------------------------------------------------------------------
-- 四、触发器设计
-- ---------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_jobs_after_update; -- 清理旧版本触发器（已由账号状态触发器取代）
DROP TRIGGER IF EXISTS trg_users_status_notify; -- 先删后建
DELIMITER $$ -- 进入自定义分隔符模式
CREATE TRIGGER trg_users_status_notify -- 触发器：账号状态被管理员修改后自动通知本人
AFTER UPDATE ON users -- 触发时机：users 表更新之后
FOR EACH ROW -- 行级触发器
BEGIN
  IF OLD.status <> NEW.status THEN -- 仅当状态真正发生变化
    INSERT INTO notifications (user_id, type, message) -- 写入通知表
    VALUES (NEW.id, 'account', CONCAT('你的账号状态已变更为 ', NEW.status,
      CASE NEW.status WHEN 'banned' THEN '（账号已被停用，如有疑问请联系管理员）'
                      WHEN 'active' THEN '（账号已恢复正常使用）'
                      ELSE '' END)); -- 按新状态给出可读说明
  END IF;
END$$ -- 触发器体结束
DELIMITER ; -- 恢复默认分隔符

-- 说明：投递成功的站内通知由应用层统一发送，这里不再建立重复触发器
DROP TRIGGER IF EXISTS trg_applications_after_insert; -- 清理历史版本遗留的触发器

-- =====================================================================
-- 脚本执行结束
-- =====================================================================
