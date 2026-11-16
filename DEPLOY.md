# 部署到公网：addwork.us.ci

本项目的线上版本部署在 **Render（免费 Web 服务）+ TiDB Cloud（免费 MySQL）**，通过自定义域名 `addwork.us.ci` 对外访问。

> 为什么不用 Qoder Sites：Qoder Sites 的地址是「可改前缀 + 固定后缀」（如 `xxx.qoder.zone`），不提供自定义域名；且个人免费版只支持静态站点，无法运行 Node + MySQL 后端。本系统登录、投递、审核、匹配全部依赖数据库，因此改用支持常驻服务的 Render。

## 架构

```
浏览器 ──https──> addwork.us.ci（CNAME）
                        │
                        ▼
              Render 免费 Web 服务（Node 20 + Express，新加坡节点）
                        │  TLS 1.2+（DB_SSL=true）
                        ▼
              TiDB Cloud Starter（MySQL 协议兼容，免费 5GiB）
```

| 组件 | 免费额度 | 限制 |
| --- | --- | --- |
| Render Web 服务 | 750 实例小时/月，512MB 内存 | 15 分钟无流量休眠，冷启动约 1 分钟 |
| Render 自定义域名 | Hobby 工作区含 2 个 | 免费实例可用 |
| TiDB Cloud Starter | 5GiB 存储 + 5000 万 RU/月 | 需要 TLS 连接 |

## 一、创建免费数据库（TiDB Cloud）

1. 打开 https://tidbcloud.com ，用邮箱或 GitHub 注册（**不需要信用卡**）。
2. 创建集群：**Create Cluster → Starter → MySQL 兼容模式**，区域选 `Singapore`（离国内近）。
3. 集群创建完成后点 **Connect**，连接类型选 **Public**，记录：
   - `Endpoint` 主机名，形如 `gateway01.ap-southeast-1.prod.aws.tidbcloud.com`
   - 端口：`4000`
   - 用户名：形如 `3AbCdEfGhIjK.root`
   - 密码：点 **Generate Password** 生成（**只显示一次，先复制保存**）
4. 不需要手工建库：应用启动时会自动执行 `CREATE DATABASE IF NOT EXISTS add_work`，并建表、写入演示数据。

## 二、部署到 Render

1. 打开 https://render.com ，用 **GitHub 账号**登录并授权访问 `S-anZZz/-001` 仓库。
2. 点 **New → Blueprint**，选择本仓库。Render 会自动读取根目录的 `render.yaml`。
3. 在弹出的环境变量表单里填上第一步的四项数据库信息：

   | Key | Value |
   | --- | --- |
   | `DB_HOST` | TiDB 的 Endpoint |
   | `DB_PORT` | `4000` |
   | `DB_USER` | TiDB 用户名（`xxx.root`） |
   | `DB_PASSWORD` | TiDB 密码 |

   `DB_NAME`、`DB_SSL`、`FILE_STORAGE` 已在 blueprint 里预设为 `add_work`、`true`、`db`，不用改。
4. 点 **Apply / Create**，等待构建完成（`npm ci` → `npm start`）。日志里出现下面两行即成功：

   ```
   add-work 招聘系统已启动： http://localhost:10000
   上传文件存储模式： db
   ```
5. 先用 Render 分配的默认地址 `https://addwork-xxxx.onrender.com` 验证：打开首页、用 `admin / root123456` 登录。

## 三、绑定自定义域名 addwork.us.ci

### 1. 在 Render 添加域名

Render 服务页 → **Settings → Custom Domains → Add Custom Domain**，填入 `addwork.us.ci`。
Render 会给出需要配置的 DNS 记录（形如下表）以及一个验证用的 TXT 记录：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| CNAME | `addwork` | `addwork-xxxx.onrender.com` |
| TXT | `_render-verify.addwork` 或按控制台提示 | 控制台给出的验证值 |

### 2. 在 dnshe 添加解析

`addwork.us.ci` 的权威 DNS 在 dnshe（`a.nic.dnshe.org` / `b.nic.dnshe.org`），登录 dnshe 控制台 → 该域名 → DNS 记录：

1. 添加 **CNAME** 记录：主机记录 `addwork`（若面板要求写全名则填 `addwork.us.ci`），记录值填 Render 给的 `xxx.onrender.com`。
2. 添加 Render 要求的 **TXT** 验证记录。
3. TTL 用默认值（600s 左右）即可。

### 3. 等待生效

```bash
dig +short addwork.us.ci CNAME   # 应返回 xxx.onrender.com
dig +short addwork.us.ci         # 应能解析到 Render 的 IP
```

DNS 生效后回到 Render 点 **Verify**，状态变为 **Verified** 后 Render 会自动签发 Let's Encrypt 证书，`https://addwork.us.ci` 即可访问。

## 四、验证清单

| 检查项 | 命令 / 操作 |
| --- | --- |
| 首页可访问 | `curl -I https://addwork.us.ci` 返回 200 |
| 管理员登录 | `admin / root123456` |
| 求职者登录 | `lilei / 123456` |
| 企业登录 | `techco / 123456` |
| 上传头像/附件 | 注册时传头像，刷新后头像仍显示（文件存在数据库里，重启不丢） |
| 数据库连通 | Render 日志无 `数据库初始化失败` |

## 五、环境变量说明

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DB_HOST` | `127.0.0.1` | 数据库主机 |
| `DB_PORT` | `3306` | 端口，TiDB Cloud 为 `4000` |
| `DB_USER` | `root` | 用户名 |
| `DB_PASSWORD` | `808080` | 密码 |
| `DB_NAME` | `add_work` | 库名，不存在会自动创建 |
| `DB_SSL` | 关闭 | `true` 时启用 TLS 1.2+，云数据库必须开启 |
| `FILE_STORAGE` | `disk` | `disk` 写本地 `uploads/`；`db` 存进 `files` 表（PaaS 上必须用 `db`） |
| `PORT` | `3000` | 监听端口，Render 会自动注入 |

## 六、常见问题

**Q：第一次打开很慢（一分钟左右）？**
免费实例 15 分钟无流量会休眠，唤醒需要约 1 分钟，属正常现象。想要常驻需升级到付费实例。

**Q：重启后上传的头像、简历附件消失？**
Render 免费实例的磁盘是临时的。本项目已用 `FILE_STORAGE=db` 把文件存进数据库的 `files` 表，所以不会丢；如果误删了这个变量，就会退化成写临时磁盘。

**Q：日志报 `ER_ACCESS_DENIED_ERROR`？**
TiDB 的用户名必须带前缀（`xxx.root`），密码是生成时那一次显示的字符串，不要用控制台登录密码。

**Q：日志报 `self signed certificate` 或握手失败？**
确认 `DB_SSL=true`；TiDB Cloud 不接受未加密连接。

**Q：域名一直 `Not verified`？**
1. 用 `dig` 确认 CNAME 已生效；
2. dnshe 面板里主机记录不要写成 `addwork.us.ci.us.ci`；
3. DNS 生效最长可能需要几十分钟，稍等后重新 Verify。

## 七、本地开发

部署相关的环境变量都不影响本地运行，默认连接本机 MySQL（`root / 808080 / add_work`）：

```bash
npm install
npm start          # http://localhost:3000
```

想本地模拟线上存储方式：

```bash
FILE_STORAGE=db npm start
```
