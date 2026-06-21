#!/usr/bin/env bash
# install.sh — установка deploy-gate в ./agents/_lib/
set -e

DEST="./agents/_lib"
SRC="$(dirname "$0")/deploy-gate.mjs"

if [ ! -d "$DEST" ]; then
  echo "Создаю папку $DEST..."
  mkdir -p "$DEST"
fi

cp "$SRC" "$DEST/deploy-gate.mjs"
echo "✓ deploy-gate.mjs скопирован в $DEST/"
echo ""
echo "Следующие шаги:"
echo "  1. Установите переменные окружения в .env:"
echo "       SUPABASE_PG_URL=postgresql://..."
echo "       TELEGRAM_BOT_TOKEN=..."
echo "       TELEGRAM_CHAT_ID=..."
echo ""
echo "  2. Создайте таблицу agents.deploy_gate в PostgreSQL (см. README.md)"
echo ""
echo "  3. Импортируйте в своём агенте:"
echo "       import { publishToProd, GateRejectError } from './agents/_lib/deploy-gate.mjs';"
