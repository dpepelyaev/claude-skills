#!/bin/bash
# install.sh — установка structured-output в ваш проект

set -e

DEST="${1:-./agents/_lib}"
FILE="structured-output.mjs"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$DEST"
cp "$SCRIPT_DIR/$FILE" "$DEST/$FILE"

echo "✓ $FILE скопирован в $DEST/"
echo ""
echo "Убедитесь, что установлен пакет openai:"
echo "  npm install openai"
echo ""
echo "Установите переменные окружения:"
echo "  LLM_API_KEY=your_key          # или POLZA_API_KEY для Polza.AI"
echo "  LLM_BASE_URL=https://...      # опционально, если используете другой провайдер"
echo ""
echo "Пример использования:"
echo "  import { callWithSchema } from './$FILE';"
