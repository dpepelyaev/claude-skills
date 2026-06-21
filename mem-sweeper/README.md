# Mem Sweeper — защита VPS от OOM через автоочистку памяти

Легковесный воркер на Node.js, который каждые 5 минут проверяет состояние RAM, убивает осиротевшие MCP/npx процессы и алертит в Telegram при нехватке памяти.

---

## Проблема

VPS с Node.js агентами (Claude Code, MCP-серверы, AI-воркеры) накапливает «сироты» — процессы с PPID=1, которые родитель забыл. Через несколько часов они съедают 2–4 GB RAM, система падает в OOM, PM2-зоопарк умирает.

Типичная картина:
- 10–50 зависших `npx @modelcontextprotocol/*` процессов
- Каждый держит 200–400 MB RAM
- При достижении 80–90% RAM — краш всего флота

---

## Решение

Cron каждые 5 минут:

1. Читает `/proc/meminfo` → получает текущее состояние RAM
2. Находит осиротевших MCP/npx процессов (PPID=1 + etime > 30 мин)
3. Убивает их через SIGTERM → SIGKILL (grace period 30 сек)
4. Если доступно < 20% RAM → вызывает `echo 3 > /proc/sys/vm/drop_caches`
5. Записывает результат в PostgreSQL таблицу `agents.memory_sweeps`
6. При RAM < 10% или >10 убитых за прогон — отправляет алерт в Telegram

### Защищённые процессы

Воркер никогда не трогает процессы с именами: `claude`, `claude-cli`, `anna-*`, `alex-*`, `elena-*`, `viktor-*`, `gena-*`, `sokrat-heartbeat` и процессы пользователя `gena`.

---

## Установка

### Требования
- Node.js >= 20
- PM2 (`npm install -g pm2`)
- PostgreSQL (Supabase или любой)

### Быстрый старт

```bash
# 1. Клонировать репозиторий
git clone https://github.com/YOUR_USER/mem-sweeper.git
cd mem-sweeper

# 2. Задать переменные окружения
export SUPABASE_PG_URL="postgresql://user:password@host:5432/dbname"
export TG_BOT_TOKEN="123456789:AABBccDDee..."
export TG_CHAT_ID="145470161"

# 3. Установить и запустить
chmod +x install.sh
./install.sh
```

### ENV переменные

| Переменная | Обязательно | Описание |
|---|---|---|
| `SUPABASE_PG_URL` | Да | PostgreSQL connection string |
| `TG_BOT_TOKEN` | Нет | Токен Telegram-бота для алертов |
| `TG_CHAT_ID` | Нет | chat_id куда слать алерты |

### Таблица в БД

Создаётся автоматически при установке. Если нужно вручную:

```sql
CREATE TABLE IF NOT EXISTS agents.memory_sweeps (
  id                      BIGSERIAL PRIMARY KEY,
  ts                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  mem_total_mb            INT,
  mem_used_before_mb      INT,
  mem_available_before_mb INT,
  mem_used_after_mb       INT,
  mem_available_after_mb  INT,
  freed_mb                INT,
  killed_count            INT DEFAULT 0,
  killed_pids             JSONB DEFAULT '[]',
  drop_caches_ran         BOOLEAN DEFAULT false,
  alert_sent              BOOLEAN DEFAULT false,
  alert_severity          TEXT,
  notes                   TEXT
);
```

---

## Использование

```bash
# Запуск вручную (тест без изменений)
node /root/workers/mem-sweeper/sweep.mjs --dry-run

# Запуск вручную (боевой)
node /root/workers/mem-sweeper/sweep.mjs

# Статус PM2
pm2 status mem-sweeper

# Логи
pm2 logs mem-sweeper --lines 50

# Статистика из БД (последние 10 прогонов)
psql $SUPABASE_PG_URL -c "
  SELECT ts, killed_count, freed_mb, drop_caches_ran, alert_severity
  FROM agents.memory_sweeps
  ORDER BY ts DESC LIMIT 10;
"
```

---

## Что убивает, что нет

**Убивает** (все условия должны быть выполнены):
- PPID = 1 (осиротел — родитель умер)
- etime > 30 минут (работает давно)
- Имя содержит паттерн MCP/npx (список в коде)

**Не трогает**:
- Любые процессы пользователя `gena`
- Процессы со словами `claude`, `anna-`, `alex-`, `elena-`, `viktor-`, `gena-`, `sokrat-heartbeat` в имени/аргументах

---

## Алерты в Telegram

| Условие | Уровень |
|---|---|
| RAM < 10% total | CRITICAL — немедленно |
| Убито > 10 процессов за прогон | WARNING |
| Убито > 30 за последний час | WARNING |

---

## Настройка PM2 (cron)

PM2 запускает скрипт по расписанию (`--cron`) в режиме `--no-autorestart` — скрипт сам завершается после каждого прогона, PM2 запускает его снова по cron.

```bash
pm2 start sweep.mjs --name mem-sweeper --cron "*/5 * * * *" --no-autorestart
```

Изменить частоту:
```bash
# Каждые 10 минут
pm2 start sweep.mjs --name mem-sweeper --cron "*/10 * * * *" --no-autorestart

# Каждые 2 минуты (при частых проблемах с RAM)
pm2 start sweep.mjs --name mem-sweeper --cron "*/2 * * * *" --no-autorestart
```

---

## Цена


Включает:
- Настройку под ваши процессы (паттерны, protected names)
- Создание таблицы в БД
- Настройку Telegram-алертов
- Интеграцию с вашим PM2-флотом

Контакт: [@denis201345](https://t.me/denis201345)

---

## Лицензия

MIT
