#!/usr/bin/env bash
# install.sh — установка agent-loop в ваш проект
set -e

DEST="${1:-./agents/_lib}"

echo "==> Agent Loop installer"
echo "    Destination: $DEST"

# Проверяем Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js не найден. Установите Node.js >= 18." >&2
  exit 1
fi

NODE_VER=$(node -e 'console.log(process.version.match(/^v(\d+)/)[1])')
if [ "$NODE_VER" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 обязателен (текущий: $(node -v))." >&2
  exit 1
fi

# Создаём папку назначения
mkdir -p "$DEST"

# Копируем модуль
cp "$(dirname "$0")/agent-loop.mjs" "$DEST/agent-loop.mjs"
echo "==> Скопировано: $DEST/agent-loop.mjs"

# Проверяем/устанавливаем зависимости
if [ ! -f package.json ]; then
  echo '{"type":"module"}' > package.json
fi

echo "==> Устанавливаем зависимости (pg, node-fetch)..."
npm install --save pg node-fetch 2>&1 | tail -3

# Подсказка по ENV
cat <<'ENV'

==> Готово! Добавьте в ваш .env:

DATABASE_URL=postgresql://user:password@host:5432/dbname
AGENT_LLM_CHANNEL=polza

==> Быстрый старт (скопируйте в файл agent.mjs):

import { runAgentLoop, assertAllowedProvider } from './agents/_lib/agent-loop.mjs';

assertAllowedProvider(process.env.AGENT_LLM_CHANNEL);

const res = await runAgentLoop(
  { agent: 'my-agent', limits: { max_steps: 10, timeout_ms: 30000 } },
  async (ctx) => {
    console.log('Шаг', ctx.step);
    if (ctx.step >= 2) return { done: true, result: 'ok' };
    return { done: false };
  }
);
console.log(res);

ENV

echo "==> Поддержка: @denis201345"
