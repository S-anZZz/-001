# 本地 Tomcat 部署

本项目前端是静态页面、后端是 Node 服务，因此本地用 **Tomcat 作为统一入口**：
Tomcat 负责托管前端页面，并把 `/api/*`、`/uploads/*` 反向代理到本机 3000 端口的 Node 后端。
浏览器只需要访问 **http://localhost:8080/**，前端代码无需改动任何接口地址。

```
浏览器 ──> Tomcat :8080 ──┬─ 静态资源（index.html / app.js / style.css / bg.webp）
                          └─ /api/*、/uploads/*  ──代理──> Node :3000 ──> MySQL :3306
```

## 目录结构

```
tomcat/                 启动脚本与说明
tomcat-base/            自定义 CATALINA_BASE（不入库，首次运行自动生成）
  ├── conf/             从 Tomcat 复制来的配置（端口 8080）
  ├── logs/             Tomcat 与 Node 日志
  ├── webapps/ROOT/     前端页面 + WEB-INF（含代理 Servlet）
  └── work/ temp/
```

## 部署步骤（已在本机执行过一次）

1. 备份并准备独立运行目录，避免污染 Homebrew 安装的 Tomcat 默认应用：

   ```bash
   mkdir -p tomcat-base/{conf,logs,temp,webapps,work}
   cp -R /opt/homebrew/opt/tomcat@9/libexec/conf/. tomcat-base/conf/
   ```

2. 把前端页面复制进 `tomcat-base/webapps/ROOT/`：

   ```bash
   mkdir -p tomcat-base/webapps/ROOT/WEB-INF/classes
   cp -R public/. tomcat-base/webapps/ROOT/
   ```

3. 编译反向代理 Servlet（`tomcat-base/src/ProxyServlet.java`）：

   ```bash
   javac -encoding UTF-8 \
     -cp /opt/homebrew/opt/tomcat@9/libexec/lib/servlet-api.jar \
     -d tomcat-base/webapps/ROOT/WEB-INF/classes \
     tomcat-base/src/ProxyServlet.java
   ```

4. `tomcat-base/webapps/ROOT/WEB-INF/web.xml` 中把 `/api/*` 与 `/uploads/*` 映射到该 Servlet。

5. 启动：

   ```bash
   ./tomcat/start.sh     # 启动 Node(3000) + Tomcat(8080) 并自检
   ./tomcat/stop.sh      # 停止
   ```

## 验证清单

| 检查 | 地址 |
| --- | --- |
| 首页 | http://localhost:8080/ |
| 静态资源 | http://localhost:8080/style.css 、/app.js 、/bg.webp |
| 接口代理 | http://localhost:8080/api/jobs |
| 登录（含 Cookie） | 页面登录后台验证 |

## 说明

- Tomcat 自身无法执行 Node 代码，所以这里用「Tomcat 托管前端 + 反向代理后端」的方式落地；
  如果后续把后端改写为 Servlet/JSP，这个代理层可以直接删掉。
- 反向代理会透传 `Cookie`、`Authorization`、`Content-Type` 等关键请求头，因此登录态与附件鉴权在 8080 端口下同样有效。
- 端口可在 `tomcat-base/conf/server.xml` 修改；后端地址可通过 `-Dbackend.url=http://127.0.0.1:3000` 覆盖。
