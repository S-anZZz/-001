#!/bin/bash
# start.sh：一键启动本地 Tomcat 部署环境（Tomcat 前端 + Node 后端 + 本地 MySQL）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"      # 项目根目录
BASE="$ROOT/tomcat-base"                      # 自定义 CATALINA_BASE
TC_HOME="/opt/homebrew/opt/tomcat@9/libexec"  # Tomcat 安装目录
CATALINA="/opt/homebrew/opt/tomcat@9/bin/catalina"

# 0) 端口检查：8080 若被其它 Tomcat（例如 IDEA 里启动的）占用，先提示而不是盲目启动
if lsof -ti tcp:8081 >/dev/null 2>&1 && ! lsof -nP -iTCP:8015 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠ 8081 已被其它进程占用，请先停止它或改 tomcat-base/conf/server.xml 里的 Connector 端口"
  exit 1
fi

# 1) 确认 MySQL 可连
nc -z 127.0.0.1 3306 || { echo "❌ 本地 MySQL 未启动（127.0.0.1:3306）"; exit 1; }

# 2) 启动 Node 后端（3000 端口，若未运行）
if ! curl -s -o /dev/null -m 2 http://127.0.0.1:3000/healthz; then
  echo "▶ 启动 Node 后端 :3000"
  (cd "$ROOT" && nohup node server.js > "$BASE/logs/node.log" 2>&1 & echo $! > "$BASE/node.pid")
  for i in $(seq 1 20); do
    curl -s -o /dev/null -m 2 http://127.0.0.1:3000/healthz && break
    sleep 1
  done
else
  echo "✔ Node 后端已在运行"
fi

# 3) 启动 Tomcat（8080）
echo "▶ 启动 Tomcat :8080"
CATALINA_HOME="$TC_HOME" CATALINA_BASE="$BASE" "$CATALINA" start

# 4) 轮询等待就绪（首次部署需要几秒）
for i in $(seq 1 20); do
  if curl -s -o /dev/null -m 2 http://127.0.0.1:8081/; then
    echo "✅ 部署完成： http://localhost:8081/"
    exit 0
  fi
  sleep 1
done
echo "❌ Tomcat 启动失败，查看 $BASE/logs/catalina.out"; exit 1
