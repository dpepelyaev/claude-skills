#!/bin/bash
# install.sh — установка db-backup как PM2 cron-сервиса
# Использование: bash install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/db-backup.mjs"

echo "=== DB Backup Installer ==="

# Проверки
command -v node >/dev/null 2>&1 || { echo "ERROR: node не найден (нужен Node.js >= 18)"; exit 1; }
command -v pg_dump >/dev/null 2>&1 || { echo "ERROR: pg_dump не найден. Установите postgresql-client"; exit 1; }
command -v pm2 >/dev/null 2>&1 || { echo "ERROR: pm2 не найден. npm install -g pm2"; exit 1; }

# Проверка ENV
if [ -z "$SUPABASE_PG_URL" ]; then
  echo "ERROR: SUPABASE_PG_URL не задан"
  echo "Задайте переменную: export SUPABASE_PG_URL='postgresql://user:pass@host:5432/dbname'"
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-/root/backups/db}"
mkdir -p "$BACKUP_DIR"
echo "Директория дампов: $BACKUP_DIR"

# Тестовый запуск
echo "Тестовый дамп..."
SUPABASE_PG_URL="$SUPABASE_PG_URL" \
BACKUP_DIR="$BACKUP_DIR" \
TG_TOKEN="${TG_TOKEN:-}" \
TG_CHAT_ID="${TG_CHAT_ID:-}" \
node "$SCRIPT"

echo "Тест прошёл. Регистрируем PM2 cron..."

# Регистрация в PM2 (каждые 15 минут)
pm2 start "$SCRIPT" \
  --name "db-backup-15m" \
  --cron "*/15 * * * *" \
  --no-autorestart \
  --env SUPABASE_PG_URL="$SUPABASE_PG_URL" \
  --env BACKUP_DIR="$BACKUP_DIR" \
  --env OFFSITE_URL="${OFFSITE_URL:-}" \
  --env TG_TOKEN="${TG_TOKEN:-}" \
  --env TG_CHAT_ID="${TG_CHAT_ID:-}"

pm2 save

echo ""
echo "=== Установка завершена ==="
echo "Дампы пишутся в: $BACKUP_DIR"
echo "Проверить статус: pm2 logs db-backup-15m"
echo "Последние дампы:  ls -lh $BACKUP_DIR | tail -5"
