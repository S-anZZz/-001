#!/bin/bash
# stop.sh：停止 Tomcat 与本次启动的 Node 后端
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$ROOT/tomcat-base"
TC_HOME="/opt/homebrew/opt/tomcat@9/libexec"
CATALINA="/opt/homebrew/opt/tomcat@9/bin/catalina"

CATALINA_HOME="$TC_HOME" CATALINA_BASE="$BASE" "$CATALINA" stop || true   # 停 Tomcat
if [ -f "$BASE/node.pid" ]; then                                         # 停本脚本启动的 Node
  kill "$(cat "$BASE/node.pid")" 2>/dev/null || true
  rm -f "$BASE/node.pid"
  echo "✔ Node 后端已停止"
fi
echo "✔ 停止完成"
