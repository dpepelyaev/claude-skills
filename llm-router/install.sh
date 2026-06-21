#!/usr/bin/env bash
# LLM Router — установочный скрипт
# Использование: bash install.sh [TARGET_DIR]
# По умолчанию TARGET_DIR=./agents/_lib

set -e

TARGET="${1:-./agents/_lib}"

echo "==> LLM Router installer"
echo "    Target: $TARGET"

# Проверяем Node.js
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js не найден. Установите Node.js >= 18"
  exit 1
fi

NODE_VER=$(node -e "console.log(parseInt(process.versions.node))")
if [ "$NODE_VER" -lt 18 ]; then
  echo "ERROR: Нужен Node.js >= 18, найден $NODE_VER"
  exit 1
fi

# Проверяем package.json (нужен для npm install)
if [ ! -f "package.json" ]; then
  echo '{"name":"llm-router-install","type":"module"}' > package.json
  CREATED_PACKAGE=1
fi

# Устанавливаем зависимость
echo "==> npm install @anthropic-ai/sdk ..."
npm install @anthropic-ai/sdk --save 2>&1 | tail -3

# Копируем файл
mkdir -p "$TARGET"
cp llm-client.mjs "$TARGET/llm-client.mjs"
echo "==> Скопировано: $TARGET/llm-client.mjs"

# Убираем временный package.json если создавали
if [ "${CREATED_PACKAGE:-0}" = "1" ]; then
  rm -f package.json
fi

echo ""
echo "✓ Готово! Добавьте в .env:"
echo "  POLZA_API_KEY=your_key"
echo "  # или"
echo "  ANTHROPIC_API_KEY=your_key"
echo ""
echo "Импорт:"
echo "  import { getLLMClient } from '$TARGET/llm-client.mjs';"
