# Deploy Gate — защита продакшена от случайного деплоя

## Проблема

AI-агент может случайно залить код на клиентский сайт — без ведома заказчика.
Это происходит при SFTP/scp/rsync в автоматических воркерах, N8N-workflows, скриптах.
Последствия: поломка прода, потеря доверия, юридические риски.

## Решение

**Deploy Gate** — единственный шлюз публикации на прод-сайты.
Ни один агент не пишет на боевой сайт в обход.

### 3 режима работы

| Режим | Когда | Что происходит |
|---|---|---|
| `hard_gate` | Сайт заказчика | СТОП. Агент ждёт ОК владельца в Telegram. Без ОК — публикации нет. |
| `log_rollback` | Ваш собственный сайт | Публикуется сразу, но всё журналируется. Возможен откат. |
| `allow` | Тестовая среда | Свободная публикация без ограничений. |

Неизвестный сайт автоматически получает `hard_gate` (fail-safe).

## Конфигурация

Список сайтов и их режимов задаётся в `SITE_REGISTRY` внутри `deploy-gate.mjs`:

```js
const SITE_REGISTRY = {
  // Ваши сайты → журнал + откат
  'mysite.ru':         { owner: 'us',     policy: 'log_rollback' },

  // Сайты клиентов → жёсткий стоп, ОК владельца
  'client-shop.ru':    { owner: 'client', policy: 'hard_gate', client_slug: 'client-a' },
  'another-store.ru':  { owner: 'client', policy: 'hard_gate', client_slug: 'client-b' },
};
```

Установите переменные окружения:

```bash
# PostgreSQL для журнала (Supabase или любой Postgres)
SUPABASE_PG_URL=postgresql://user:password@host:5432/dbname

# Telegram-бот для уведомлений
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

## Установка

```bash
bash install.sh
```

Скрипт копирует `deploy-gate.mjs` в `./agents/_lib/`.

Создайте таблицу журнала в PostgreSQL:

```sql
CREATE TABLE IF NOT EXISTS agents.deploy_gate (
  id            BIGSERIAL PRIMARY KEY,
  site          TEXT NOT NULL,
  owner         TEXT,
  client_slug   TEXT,
  policy        TEXT NOT NULL,
  actor         TEXT,
  change_type   TEXT,
  target        TEXT,
  summary       TEXT,
  diff          TEXT,
  undo_command  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  approval_id   TEXT,
  decided_by    TEXT,
  auto_approved BOOLEAN DEFAULT FALSE,
  adversarial_check JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
```

## Пример использования

```js
import { publishToProd, GateRejectError } from './agents/_lib/deploy-gate.mjs';

try {
  const res = await publishToProd({
    site:        'client-shop.ru',          // домен без протокола
    target:      'https://client-shop.ru/product/123',
    actor:       'my-worker',               // кто инициирует
    changeType:  'content',                 // тип: content|price|code|seo_title|...
    summary:     'Обновить описание товара #123',
    diff:        '- старый текст\n+ новый текст',
    undoCommand: 'git -C /repo revert HEAD',
  }, async () => {
    // Реальная публикация — вызывается ТОЛЬКО после одобрения
    await uploadViaSFTP();
  });

  console.log('Опубликовано:', res.gate_id, res.status);

} catch (e) {
  if (e instanceof GateRejectError) {
    console.log('Отклонено:', e.reason);
    // gate rejected или timeout — ничего не опубликовано
  } else {
    throw e;
  }
}
```

## Как это работает

**hard_gate (сайт клиента):**
```
INSERT журнал (pending)
  → withApproval → кнопки в Telegram владельцу
  → [ОК] → выполнить executeFn() → status=published
  → [Отклонить/Timeout] → throw GateRejectError
```

**log_rollback (ваш сайт):**
```
INSERT журнал (pending)
  → выполнить executeFn() сразу
  → status=published + undo_command в журнале
```

## Авто-одобрение для картинок

Если в `opts.files` передан массив файлов, и все они — изображения (`.jpg`, `.webp`, `.png` и т.д.),
`hard_gate` пропускается автоматически. Картинки не требуют ручного ОК.

```js
await publishToProd({
  site: 'client-shop.ru',
  files: ['product-123.webp', 'product-123-thumb.webp'],
  // ...
}, executeFn);
// → auto_approved: true, без Telegram-уведомления
```

## Экспортируемые функции

| Функция | Описание |
|---|---|
| `publishToProd(opts, executeFn)` | Главный шлюз. Возвращает `{gate_id, status, policy, result}` |
| `resolvePolicy(site)` | Определить политику для домена |
| `normalizeSite(input)` | Нормализовать домен (убрать протокол, www, порт) |
| `getUndoCommand(gateId)` | Получить команду отката по ID журнала |
| `markReverted(gateId)` | Пометить запись откатанной |
| `GateRejectError` | Класс ошибки при отклонении/таймауте |

## Стоимость и контакт


Telegram: [@denis201345](https://t.me/denis201345)
