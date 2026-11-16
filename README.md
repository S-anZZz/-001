# add work · 在线求职招聘系统

一款类似领英 / Boss / 猎聘的线上求职招聘系统：企业发布职位、求职者投递简历、搜索匹配。

## 技术栈

- 后端：Node.js + Express + MySQL（`mysql2` 异步驱动）
- 前端：原生 HTML / CSS / JavaScript（黑白色块、Excel 表格风格、表单为主）
- 数据存储：MySQL，库名 `add_work`

## 功能

### 求职者

- 注册 / 登录，创建或上传简历（PDF / Word 附件，可选头像）
- 按关键词、地点、薪资、学历、经验搜索职位
- 投递简历，查看投递状态与匹配分、匹配理由
- 接收面试通知
- 与发起交换联系方式请求

### 企业

- 注册（需管理员审核通过后才能登录）
- 发布 / 编辑 / 下架职位（发布与修改均需管理员审核）
- 查看收到的简历，筛选候选人，更新投递状态
- 发送线上面试邀约（腾讯会议 / 钉钉 / 飞书 / 企业微信，当前为可插拔模拟实现）
- 处理交换联系方式请求

### 管理员

- 账号：`admin / root123456`
- 审核企业注册申请
- 审核企业发布的职位
- 管理用户账号（启用 / 停用）

## 匹配推荐

投递时根据简历技能标签与职位要求进行简化匹配打分，展示匹配理由：

- 技能吻合：简历技能标签命中职位要求
- 经验符合：简历工作年限满足职位要求
- 学历符合：简历学历满足职位要求

## 数据表

- 用户表 `users`：ID、角色、认证状态、头像、令牌等
- 简历表 `resumes`：用户 ID、技能标签、经历、附件
- 职位表 `jobs`：企业 ID、标题、要求、薪资、状态
- 投递表 `applications`：简历 ID、职位 ID、状态、匹配分、面试链接
- 联系方式表 `contact_requests`
- 通知表 `notifications`

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

可通过环境变量覆盖：`DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`。

首次启动会自动建表并写入演示数据（管理员、演示企业、演示求职者、演示职位）。

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
db.js         MySQL 连接、建表与种子数据
match.js      匹配打分逻辑
meeting.js    面试会议集成点（模拟实现）
public/       前端页面（index.html / style.css / app.js）
uploads/      简历附件与头像存储目录（不入仓库）
```

## 推送到 GitHub

```bash
git remote add origin https://github.com/S-anZZz/-001.git
git push -u origin main
```
