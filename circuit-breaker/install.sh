#!/bin/bash
# Установка circuit-breaker в проект Node.js агента

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/circuit-breaker.mjs"

# Целевая папка: сначала проверяем agents/_lib/, потом ~/.claude-skills/
if [ -d "./agents/_lib" ]; then
  DEST="./agents/_lib/circuit-breaker.mjs"
  echo "Найдена папка agents/_lib/ — устанавливаю туда..."
else
  DEST_DIR="$HOME/.claude-skills"
  mkdir -p "$DEST_DIR"
  DEST="$DEST_DIR/circuit-breaker.mjs"
  echo "Устанавливаю в ~/.claude-skills/..."
fi

cp "$SOURCE" "$DEST"
echo "Готово: $DEST"
echo ""
echo "Подключение:"
echo "  import { CircuitBreaker, getBreaker } from '$DEST';"
