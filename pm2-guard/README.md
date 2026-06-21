# PM2 Guard — защита флота агентов от случайного `pm2 delete all`

## Проблема

**Инцидент 2026-06-18:** субагент-haiku выполнил `pm2 delete all` при починке флапающего процесса → снёс **~218 процессов** за 0.3 секунды. Восстановление заняло ~2 часа.

PM2 не спрашивает подтверждения. Одна команда — весь зоопарк агентов мёртв.

## Решение

2 независимых слоя защиты:

### Слой 1: OS-враппер `/usr/local/bin/pm2`

Перехватывает bare `pm2` (т.к. `/usr/local/bin` раньше `/usr/bin` в PATH). Жёстко блокирует:
- `pm2 delete all` / `pm2 del all`
- `pm2 kill` (убивает демон + все процессы)

`restart all` / `reload all` **НЕ блокируются** — их используют jwt-rotation и deploy-кроны (легитимно).

Журнал блокировок: `/var/log/pm2-guard.log`

### Слой 2: Claude Code PreToolUse hook

Блокирует fleet-wide PM2-команды прямо внутри Claude Code harness перед выполнением Bash. Работает для Claude и всех субагентов. Кроны идут **мимо** харнесса — не затрагиваются.

Блокирует: `pm2 delete|del|stop|restart|reload all` + `pm2 kill`

### Обход (только с явным ОК)

```bash
# Флаг в команде:
pm2 delete all --force-confirm

# Или через env:
PM2_FORCE_ALL=1 pm2 delete all
```

## Установка

```bash
# 2 шага:
curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/pm2-guard/main/install.sh | bash
```

Или вручную:

```bash
git clone https://github.com/YOUR_ORG/pm2-guard
cd pm2-guard
./install.sh
```

install.sh делает:
1. Копирует `pm2-wrapper.sh` в `/usr/local/bin/pm2` (бэкап оригинала)
2. Добавляет hook в `~/.claude/settings.json`

## Требования

- Linux / macOS
- PM2 установлен (`/usr/bin/pm2` или npm global)
- Claude Code (для hook-слоя)
- Node.js >= 18 (для hook)

## Файлы

```
pm2-guard/
├── README.md           — этот файл
├── install.sh          — установщик (2 шага)
├── pm2-wrapper.sh      — OS-враппер для /usr/local/bin/pm2
└── hooks/
    └── pre-tool-use.md — инструкция подключения Claude Code hook
```

## Цена

- OS-враппер (sh, без зависимостей)
- Claude Code hook (Node.js)
- install.sh
- Поддержка по вопросам установки

## Контакт

Telegram: [@denis201345](https://t.me/denis201345)
