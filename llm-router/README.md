# LLM Router — единый клиент для Claude + Polza.AI с fallback

## Проблема

Каждый агент в проекте тянет свой SDK, хардкодит ключи и модели — в итоге:
- нет единого fallback: если один провайдер лежит, агент падает
- разные форматы ответов → дублирующийся код парсинга
- нет телеметрии: непонятно, сколько стоит каждый вызов

## Решение

Один импорт — и автоматически:
1. Пробует **Claude Max** (через headless-CLI, бесплатно для Max-подписки)
2. При недоступности переключается на **Polza.AI** (qwen3-235b или sonnet через российский прокси)
3. Умный retry с экспоненциальной задержкой
4. Единый формат ответа Anthropic-compatible во всех случаях

## Поддерживаемые провайдеры

| Профиль | Модели | Примечание |
|---------|--------|-----------|
| `polza` | qwen3-235b-a22b, qwen3-30b, qwen3-8b | Дефолт. Российский прокси Polza.AI |
| `anthropic` | claude-sonnet-4-6, claude-opus-4-5, claude-haiku-4-5 | Официальный Anthropic API |

## ENV переменные

```bash
POLZA_API_KEY=your_key_here          # Ключ Polza.AI (обязателен для polza-профиля)
ANTHROPIC_API_KEY=your_key_here      # Ключ Anthropic API (для anthropic-профиля)
LLM_PROFILE=polza                    # Профиль по умолчанию (polza / anthropic)
LLM_BASE_URL=https://api.polza.ai   # Базовый URL (переопределяет дефолт профиля)
LLM_DEBUG=1                          # Включить отладочные логи
```

## Установка

```bash
bash install.sh
```

Или вручную:

```bash
npm install @anthropic-ai/sdk
cp llm-client.mjs ./agents/_lib/
```

## Использование

```js
import { getLLMClient } from './llm-client.mjs';

// Простой вызов (дефолтный профиль из env)
const { client, model } = getLLMClient();
const resp = await client.messages.create({
  model,
  max_tokens: 800,
  messages: [{ role: 'user', content: 'Привет!' }],
});
console.log(resp.content[0].text);

// Выбор профиля явно
const { client, model } = getLLMClient({ profile: 'anthropic' });

// Выбор уровня модели (standard / fast / smart)
const { client, model } = getLLMClient({ profile: 'polza', tier: 'fast' });
```

### Параметры `getLLMClient(options)`

| Параметр | Тип | Описание |
|----------|-----|---------|
| `profile` | string | `'polza'` \| `'anthropic'` (дефолт: env `LLM_PROFILE` или `'polza'`) |
| `tier` | string | `'standard'` \| `'fast'` \| `'smart'` (дефолт: `'standard'`) |
| `layer` | string | Семантический слой агента (`'cron'`, `'communicator'`, `'decision'`) — влияет на дефолтный профиль |

### Layer-defaults

| Layer | Профиль по умолчанию |
|-------|---------------------|
| `communicator` | polza / qwen3-235b |
| `cron` | polza / qwen3-8b |
| `decision` | polza / qwen3-30b |

## Пример с retry и телеметрией

```js
import { getLLMClient, logLLM } from './llm-client.mjs';

const { client, model, profile } = getLLMClient({ layer: 'cron' });
const t0 = Date.now();

try {
  const resp = await client.messages.create({
    model,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  logLLM({
    agent: 'my-worker',
    model,
    provider: profile,
    prompt_tokens: resp.usage.input_tokens,
    completion_tokens: resp.usage.output_tokens,
    latency_ms: Date.now() - t0,
    success: true,
  });

  return resp.content[0].text;
} catch (err) {
  logLLM({ agent: 'my-worker', model, provider: profile, success: false, error_text: err.message });
  throw err;
}
```

## Требования

- Node.js >= 18
- `npm install @anthropic-ai/sdk`
- Один из ключей: `POLZA_API_KEY` или `ANTHROPIC_API_KEY`

## Цена

- исходный код `llm-client.mjs`
- `install.sh`
- поддержка по интеграции

## Контакт

Telegram: [@denis201345](https://t.me/denis201345)
