#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-4318}"
URL="http://localhost:${PORT}"

echo "SEO Studio"
echo "项目目录: $SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "未检测到 Node.js。"
  echo "请先安装 Node.js LTS:"
  echo "https://nodejs.org/en/download"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo ""
  echo "首次运行，正在安装依赖..."
  npm install
fi

if [ ! -f dist/index.html ]; then
  echo ""
  echo "未检测到前端建构结果，正在建构..."
  npm run build
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo ""
  echo "未检测到 Python 3，DOCX 导出会不可用。"
  echo "请先安装 Python 3 后重新启动。"
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo ""
  echo "正在初始化 DOCX 导出环境..."
  python3 -m venv .venv
fi

if ! .venv/bin/python - <<'PY' >/dev/null 2>&1
import importlib.util
raise SystemExit(0 if importlib.util.find_spec("docx") else 1)
PY
then
  echo ""
  echo "正在安装 DOCX 导出依赖..."
  .venv/bin/python -m pip install python-docx
fi

if lsof -tiTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  OLD_PID="$(lsof -tiTCP:${PORT} -sTCP:LISTEN | head -n 1)"
  echo ""
  echo "检测到旧服务占用 ${PORT}，正在停止 PID ${OLD_PID}..."
  kill "${OLD_PID}" || true
  sleep 1
fi

echo ""
echo "正在启动本地服务: $URL"
npm start &
SERVER_PID=$!

cleanup() {
  kill "${SERVER_PID}" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

for _ in {1..20}; do
  if curl -sf "$URL" >/dev/null 2>&1; then
    open "$URL"
    wait "${SERVER_PID}"
    exit $?
  fi

  if ! kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    echo ""
    echo "本地服务启动失败，请查看上方报错。"
    exit 1
  fi

  sleep 1
done

echo ""
echo "本地服务在 20 秒内未完成启动。"
exit 1
