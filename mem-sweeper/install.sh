#!/bin/bash
# install.sh — установка mem-sweeper на VPS
# Требует: Node.js >= 20, PM2, PostgreSQL

set -e

INSTALL_DIR="${INSTALL_DIR:-/root/workers/mem-sweeper}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Mem Sweeper — установка ==="
echo "Целевая папка: $INSTALL_DIR"

# 1. Создать директорию
mkdir -p "$INSTALL_DIR"

# 2. Скопировать скрипт
cp "$SCRIPT_DIR/mem-sweeper.mjs" "$INSTALL_DIR/sweep.mjs"
chmod +x "$INSTALL_DIR/sweep.mjs"

echo "Файл скопирован в $INSTALL_DIR/sweep.mjs"

# 3. Установить зависимость pg (если нет)
if [ ! -d "$INSTALL_DIR/node_modules/pg" ]; then
  echo "Устанавливаем зависимость pg..."
  cd "$INSTALL_DIR"
  npm init -y > /dev/null 2>&1 || true
  npm install pg --save 2>&1 | tail -3
fi

# 4. Создать таблицу в PostgreSQL (если не существует)
if [ -n "$SUPABASE_PG_URL" ]; then
  echo "Создаём таблицу agents.memory_sweeps..."
  psql "$SUPABASE_PG_URL" <<'SQL' 2>/dev/null || echo "(Таблица уже существует или нет доступа к БД)"
CREATE TABLE IF NOT EXISTS agents.memory_sweeps (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  mem_total_mb          INT,
  mem_used_before_mb    INT,
  mem_available_before_mb INT,
  mem_used_after_mb     INT,
  mem_available_after_mb  INT,
  freed_mb              INT,
  killed_count          INT DEFAULT 0,
  killed_pids           JSONB DEFAULT '[]',
  drop_caches_ran       BOOLEAN DEFAULT false,
  alert_sent            BOOLEAN DEFAULT false,
  alert_severity        TEXT,
  notes                 TEXT
);
SQL
else
  echo "SUPABASE_PG_URL не задан — таблицу в БД нужно создать вручную (SQL в README.md)"
fi

# 5. Запустить через PM2
echo ""
echo "Запускаем через PM2 (cron каждые 5 минут)..."
pm2 start "$INSTALL_DIR/sweep.mjs" \
  --name mem-sweeper \
  --cron "*/5 * * * *" \
  --no-autorestart \
  --env production \
  -- 2>/dev/null || pm2 restart mem-sweeper

pm2 save

echo ""
echo "=== Установка завершена ==="
echo ""
echo "Проверить статус:  pm2 status mem-sweeper"
echo "Логи:              pm2 logs mem-sweeper --lines 20"
echo "Тест (dry-run):    node $INSTALL_DIR/sweep.mjs --dry-run"
echo ""
echo "Обязательные ENV переменные (добавить в /etc/environment или .env):"
echo "  SUPABASE_PG_URL=postgresql://user:password@host:5432/dbname"
echo "  TG_BOT_TOKEN=<токен бота>"
echo "  TG_CHAT_ID=<chat_id для алертов>"
