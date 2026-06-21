# Agent Loop — multi-turn оркестратор для Claude с approval gate

Защитный слой прогона агента. Оборачивает вашу функцию-шаг, ограничивая всё в **коде**, а не в промпте.

---

## Проблема

Простой вызов `llm.call(prompt)` даёт один ответ и останавливается.  
Нет инструментов. Нет approval gate. Нет трассировки. Нет защиты от бесконечных петель и перерасхода бюджета.

```js
// Так — плохо: нет контроля
const reply = await llm.call(prompt);
```

Агент может зациклиться, потратить $50 за ночь, или выполнить деструктивное действие без согласования.

---

## Решение

`runAgentLoop(opts, stepFn)` — несколько туров с жёсткими лимитами:

```
запрос → шаг 1 → tool call → approval gate → шаг 2 → ... → done
                                    ↓
                           agents.agent_runs (трейс в БД)
```

**Ключевые фичи:**

| Функция | Что делает |
|---|---|
| `max_steps` | Жёсткий потолок итераций — агент не зациклится |
| `max_cost_usd` | Стоп по стоимости одного прогона (по `agents.llm_calls`) |
| `timeout_ms` | Deadline на весь прогон — race с Promise |
| `repeated_error_limit` | Circuit-breaker: одна и та же ошибка N раз → стоп |
| `swarm_budget` | Дневной потолок трат **всех** агентов роя (из БД) |
| `confidenceThreshold` | Approval gate: низкая уверенность → пауза, запрос в `agents.decision_requests` |
| `traceRun()` | Best-effort трейс для always-on сервисов — пишет прогон, не блокирует |
| `assertAllowedProvider()` | Whitelist каналов LLM — прямой Anthropic API и OpenRouter запрещены |

---

## Установка

```bash
bash install.sh
```

Или вручную:

```bash
npm install pg node-fetch
cp agent-loop.mjs ./agents/_lib/
```

---

## ENV переменные

| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (например, `postgresql://user:pass@host:5432/db`) |
| `AGENT_LLM_CHANNEL` | Канал LLM: `max` или `polza` (прямой Anthropic API запрещён) |
| `AGENT_DEFAULT_MAX_STEPS` | Дефолт лимита шагов (если нет записи в БД) |
| `AGENT_DEFAULT_TIMEOUT_MS` | Дефолт таймаута в мс |

Лимиты на конкретного агента хранятся в таблице `agents.agent_limits` (агент берёт свои лимиты из БД при старте).

---

## DDL: нужные таблицы

```sql
-- Прогоны агентов (трейс)
CREATE TABLE agents.agent_runs (
  id            BIGSERIAL PRIMARY KEY,
  agent         TEXT NOT NULL,
  task_id       BIGINT,
  parent_run_id BIGINT,
  status        TEXT NOT NULL DEFAULT 'running',
  stop_reason   TEXT,
  steps         INT DEFAULT 0,
  cost_usd      NUMERIC(10,6) DEFAULT 0,
  meta          JSONB,
  started_at    TIMESTAMPTZ DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

-- Лимиты на агента (* = дефолт для всего роя)
CREATE TABLE agents.agent_limits (
  agent                TEXT NOT NULL,
  is_active            BOOLEAN DEFAULT true,
  max_steps            INT,
  max_cost_usd         NUMERIC(10,6),
  timeout_ms           INT,
  repeated_error_limit INT DEFAULT 3
);

-- Дневной бюджет роя
CREATE TABLE agents.swarm_budget (
  id             INT PRIMARY KEY DEFAULT 1,
  daily_cap_usd  NUMERIC(10,6),
  is_active      BOOLEAN DEFAULT true
);

-- Запросы на согласование человека (approval gate)
CREATE TABLE agents.decision_requests (
  id           BIGSERIAL PRIMARY KEY,
  agent_origin TEXT,
  intent       TEXT,
  client_id    TEXT,
  payload_json JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);
```

---

## Пример использования

```js
import { runAgentLoop, assertAllowedProvider } from './agent-loop.mjs';

// Проверяем канал при старте — запрещаем api.anthropic.com / openrouter.ai
assertAllowedProvider(process.env.AGENT_LLM_CHANNEL);

const tasks = ['Проверь сайт', 'Отправь отчёт', 'Зафиксируй результат'];

const result = await runAgentLoop(
  {
    agent: 'my-worker',                // Имя агента (ищет лимиты в agents.agent_limits)
    taskId: 42,                        // Опционально: ID задачи из трекера
    confidenceThreshold: 0.7,          // Уверенность < 0.7 → эскалация человеку
    limits: {                          // Переопределить лимиты из БД (опционально)
      max_steps: 10,
      max_cost_usd: 0.50,
      timeout_ms: 60_000,
    },
  },
  async (ctx) => {
    const task = tasks[ctx.step];
    if (!task) return { done: true };

    // ctx.llmContext содержит run_id — маркируйте вызовы LLM для трейса стоимости
    const reply = await callModel(task, { meta: ctx.llmContext });
    return { done: false, result: reply };
  }
);

console.log(result);
// { status: 'success', steps: 3, costUsd: 0.12, runId: 1234, result: ... }
```

### Трейс для always-on сервисов

```js
import { traceRun } from './agent-loop.mjs';

// Не управляет потоком — только пишет прогон в БД. Ошибки пробрасывает прозрачно.
const reply = await traceRun('anna-voice', async () => {
  return await processVoiceMessage(update);
});
```

---

## Статусы завершения

| `status` | Причина |
|---|---|
| `success` | `stepFn` вернул `{ done: true }` |
| `stopped_max_steps` | Достигнут лимит итераций |
| `stopped_max_cost` | Превышен бюджет прогона |
| `stopped_timeout` | Истёк таймаут |
| `stopped_swarm_budget` | Исчерпан дневной бюджет роя |
| `stopped_repeated_error` | Одна ошибка повторилась N раз подряд |
| `external_error` | `stepFn` выбросил исключение |
| `parked_low_confidence` | Уверенность ниже порога → ждёт решения человека |

---

## Цена

Корпоративная лицензия (несколько проектов) — уточняйте.

**Контакт:** [@denis201345](https://t.me/denis201345)
