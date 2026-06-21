# DB Backup — авто-дамп PostgreSQL каждые 15 минут с offsite

Готовый воркер для PM2: делает `pg_dump` каждые 15 минут, сжимает gzip, проверяет размер (0-байт = красный алерт в Telegram), ротирует старые дампы (хранит последние 96 штук = 24 часа).

---

## Проблема

Стандартный `pg_dump` раз в сутки = потеря данных до **24 часов** при аварии.

Страница БД легла в 23:50 → следующий дамп в 03:00 → восстановление из вчерашнего дампа → теряем весь день работы и данные клиентов.

---

## Решение

```
cron */15 мин
   → pg_dump (полный дамп)
   → gzip -6 (сжатие ~60-70%)
   → проверка размера (< 1 KB = алерт)
   → offsite копия (rclone, опционально)
   → ротация (удаление старше 96 дампов)
   → TG-алерт при любой ошибке
```

Максимальное окно потери данных: **15 минут**.

---

## Установка

### 1. Задайте переменные окружения

```bash
export SUPABASE_PG_URL='postgresql://user:password@host:5432/postgres'
export BACKUP_DIR='/root/backups/db'           # куда писать дампы
export TG_TOKEN='bot_token'                    # Telegram-алерты (опционально)
export TG_CHAT_ID='145470161'                  # ваш chat_id

# Offsite (опционально — нужен rclone)
export OFFSITE_URL='s3:mybucket/db-backups'
```

### 2. Запустите установщик

```bash
bash install.sh
```

Установщик:
1. Проверяет наличие `node`, `pg_dump`, `pm2`
2. Делает тестовый дамп
3. Регистрирует PM2 cron `*/15 * * * *`
4. Сохраняет конфиг (`pm2 save`)

### 3. Проверьте результат

```bash
pm2 logs db-backup-15m      # логи последних запусков
ls -lh /root/backups/db/    # последние дампы
```

---

## ENV-переменные

| Переменная | Обязательная | Описание |
|---|---|---|
| `SUPABASE_PG_URL` | да | PostgreSQL connection string |
| `BACKUP_DIR` | нет | Директория дампов (default: `/root/backups/db`) |
| `OFFSITE_URL` | нет | rclone-таргет для offsite-копии (s3, sftp, gdrive) |
| `TG_TOKEN` | нет | Telegram Bot Token для алертов |
| `TG_CHAT_ID` | нет | Telegram Chat ID для алертов |

---

## Smoke-check (критерий здоровья)

Дамп считается успешным если:
- `pg_dump` завершился без ошибки
- Файл `.dump.gz` существует и **больше 1 KB**

Если файл = 0 байт или < 1 KB — немедленный TG-алерт `🔴 DB Backup ПУСТОЙ`.

Для Надзора (`agents.nadzor_targets`):
```sql
INSERT INTO agents.nadzor_targets (slug, kind, smoke_cmd, freshness_max_age_hours, mode)
VALUES (
  'db-backup-15m', 'worker',
  'find /root/backups/db -name "*.dump.gz" -newer /tmp/.15m-ago -size +1k | grep -q . && echo OK',
  1, 'active'
);
```

---

## Восстановление

```bash
# Найти последний дамп
ls -lt /root/backups/db/*.dump.gz | head -1

# Восстановить
gunzip -c /root/backups/db/dump-2026-06-21T14-30-00.dump.gz \
  | psql "$SUPABASE_PG_URL"
```

---


Включает:
- Настройку воркера на вашем VPS
- PM2 + Надзор (мониторинг здоровья дампов)
- TG-алерты при сбоях
- Поддержку 1 месяц

Написать: [@denis201345](https://t.me/denis201345)
