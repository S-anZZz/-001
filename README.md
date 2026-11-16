# add work · 在线求职招聘系统

一款类似领英 / Boss / 猎聘的线上求职招聘系统：企业发布职位、求职者投递简历、搜索匹配。

## 线上访问

| 项目 | 地址 |
| --- | --- |
| 公网地址 | **https://addwork.us.ci** |
| 部署方式 | Render 免费 Web 服务 + TiDB Cloud 免费 MySQL |
| 部署文档 | [DEPLOY.md](./DEPLOY.md) |

> 免费实例 15 分钟无流量会休眠，首次打开约需 1 分钟唤醒。

## 技术栈

- 后端：Node.js + Express + MySQL（`mysql2` 异步驱动）
- 前端：原生 HTML / CSS / JavaScript（黑白色块、Excel 表格风格、表单为主）
- 数据存储：MySQL，库名 `add_work`
- 部署：Render（Node 服务）+ TiDB Cloud（MySQL 协议兼容）+ 自定义域名 `addwork.us.ci`

## 功能

### 求职者

- 注册 / 登录，创建或上传简历（PDF / Word 附件，可选头像）
- 按关键词、地点、薪资、学历、经验搜索职位
- 投递简历，查看投递状态与匹配分、匹配理由
- 接收面试通知与站内消息
- 在企业发布联系方式后，可直接在聊天窗口回复
- 与发起交换联系方式请求

### 企业

- 注册（填写企业名称、用户名、密码、联系人，可上传头像与经营许可证；提交后需管理员审核通过才能登录）
- 发布 / 编辑 / 下架职位（提交后立即进入职位库，无需管理员审核）
- 查看收到的简历，筛选候选人，更新投递状态
- 发送线上面试邀约（腾讯会议 / 钉钉 / 飞书 / 企业微信，当前为可插拔模拟实现）
- 处理交换联系方式请求，可主动「发布联系方式」并弹出聊天窗口与求职者沟通

### 管理员

- 账号：`admin / root123456`
- 审核企业注册申请（通过后企业方可登录）
- 管理用户账号（启用 / 停用）

## 安全与可靠性

- 密码使用**随机盐 + scrypt** 哈希存储（旧版固定盐哈希在登录成功时自动升级），数据库中不出现明文；
- 登录令牌 **7 天过期**，过期后自动失效并清理；
- 同一用户名 5 分钟内密码错误 5 次将被临时锁定，防止暴力破解；
- 所有 SQL 使用 `PreparedStatement`/占位符参数化，杜绝注入；
- 投递在数据库层有 `(seeker_id, job_id)` **唯一索引**兜底，并发下也不会产生重复投递。

## 匹配推荐

投递时根据简历技能标签与职位要求进行简化匹配打分，展示匹配理由：

- **技能 60 分**：按技能覆盖率计分（命中数 / 要求数），分词后精确比对，`Java` 不会误命中 `JavaScript`；`React.js` 与 `React` 视为同一技能；
- **经验 20 分**：简历年限达到职位门槛才得分，并给出「4 年 ≥ 要求 3 年」这样的具体理由；
- **学历 20 分**：按博士/硕士/本科/大专等级比较，不满足时同样写明差距。

职位检索支持关键词、地点、薪资、学历、经验筛选，并支持按最新发布 / 薪资高低排序与**分页**（每页 10 条）。

## 数据表

- 用户表 `users`：ID、角色、认证状态、头像、经营许可证、令牌等
- 简历表 `resumes`：用户 ID、技能标签、经历、附件
- 职位表 `jobs`：企业 ID、标题、要求、薪资、状态
- 投递表 `applications`：简历 ID、职位 ID、状态、匹配分、面试链接
- 联系方式表 `contact_requests`
- 消息表 `messages`：站内聊天记录（发送方、接收方、内容、已读标记）
- 通知表 `notifications`：含已读标记，支持未读计数与一键已读
- 文件表 `files`：上传的头像与简历附件（`FILE_STORAGE=db` 时启用，保证实例重启后文件不丢）

## 环境要求

- Node.js 18+
- MySQL 8+（本机已安装并通过 Homebrew 管理）

## 数据库配置

应用默认连接本机 MySQL：

- 主机：`127.0.0.1`
- 端口：`3306`
- 用户：`root`
- 密码：`808080`
- 数据库：`add_work`

可通过环境变量覆盖：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DB_HOST` | `127.0.0.1` | 数据库主机 |
| `DB_PORT` | `3306` | 端口（TiDB Cloud 为 `4000`） |
| `DB_USER` | `root` | 用户名 |
| `DB_PASSWORD` | `808080` | 密码 |
| `DB_NAME` | `add_work` | 库名 |
| `DB_SSL` | 关闭 | `true` 启用 TLS 1.2+，云数据库必须开启 |
| `FILE_STORAGE` | `disk` | `disk` 写本地目录；`db` 存进 `files` 表（PaaS 上必须用 `db`） |

完整示例见 [.env.example](./.env.example)。

首次启动会自动建库、建表并写入演示数据（管理员、演示企业、演示求职者、演示职位）。

## 启动

```bash
npm install
npm start
```

启动后访问：http://localhost:3000

## 演示账号

| 角色 | 用户名 | 密码 |
| --- | --- | --- |
| 管理员 | admin | root123456 |
| 求职者 | lilei | 123456 |
| 企业 | techco | 123456 |

## 目录结构

```
server.js     后端服务与 API 路由
db.js         MySQL 连接、建库建表与种子数据
storage.js    上传文件存储层（磁盘 / 数据库两种模式）
match.js      匹配打分逻辑
meeting.js    面试会议集成点（模拟实现）
public/       前端页面（index.html / style.css / app.js）
uploads/      本地开发时的附件与头像目录（不入仓库）
render.yaml   Render 蓝图，一键创建免费 Web 服务
DEPLOY.md     公网部署步骤（数据库、Render、域名解析、排错）
.env.example  环境变量示例
```

## 推送到 GitHub

```bash
git remote add origin https://github.com/S-anZZz/-001.git
git push -u origin main
```

## 部署

详见 [DEPLOY.md](./DEPLOY.md)：创建 TiDB Cloud 免费 MySQL → Render Blueprint 部署 → 绑定 `addwork.us.ci`。
