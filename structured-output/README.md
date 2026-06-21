# Structured Output — JSON-схема для любого LLM без парсинга

Одна утилита, которая заставляет LLM возвращать **всегда валидный JSON** — с retry при мисмэтче и без хрупкого парсинга вручную.

---

## Проблема

LLM возвращает свободный текст. Вы пишете `JSON.parse(response)` — и в 20% случаев получаете:

- markdown-обёртку ` ```json ... ``` `
- частичный JSON
- текст с пояснением перед скобкой
- пустой ответ

Каждый агент изобретает свой костыль. Это хрупко и не масштабируется.

---

## Решение

```js
import { callWithSchema } from './structured-output.mjs';

const result = await callWithSchema(
  'Извлеки данные из текста: "Иван Петров, 32 года, Москва"',
  {
    type: 'object',
    properties: {
      name:  { type: 'string' },
      age:   { type: 'number' },
      city:  { type: 'string' },
    },
    required: ['name', 'age', 'city'],
  }
);

console.log(result);
// { name: 'Иван Петров', age: 32, city: 'Москва' }
```

**Всегда** получаете `object`. Никакого `JSON.parse`, никаких регулярок.

---

## Как работает

1. Добавляет схему в промпт: «верни ТОЛЬКО валидный JSON без markdown»
2. Извлекает JSON из ответа через `/{[\s\S]+}/`
3. При невалидном ответе — повторяет с уточнением ошибки (до 3 попыток)
4. После всех провалов — бросает `Error` с причиной

---

## Установка

```bash
bash install.sh ./agents/_lib
npm install openai
```

Задайте переменные окружения:

```bash
# Для Polza.AI (Claude через прокси)
POLZA_API_KEY=your_key

# Или для любого OpenAI-совместимого провайдера
LLM_API_KEY=your_key
LLM_BASE_URL=https://your-provider/api/v1
```

---

## API

### `callWithSchema(prompt, schema, options?)`

| Параметр | Тип | По умолчанию | Описание |
|----------|-----|--------------|----------|
| `prompt` | string | — | Запрос к модели |
| `schema` | object | — | JSON Schema |
| `options.model` | string | `claude-haiku-4-5-20251001` | Модель |
| `options.maxRetries` | number | `3` | Попыток при невалидном JSON |
| `options.apiKey` | string | `LLM_API_KEY` из env | API ключ |
| `options.baseURL` | string | `LLM_BASE_URL` из env | URL провайдера |
| `options.onError` | function | — | `(err, attempt) => void` для логирования |

Возвращает `Promise<object>`. Бросает `Error` если все попытки провалились.

### `callWithSchemaOrNull(prompt, schema, options?)`

Как `callWithSchema`, но возвращает `null` при провале вместо исключения. Удобно внутри pipeline, где потеря одного элемента не критична.

---

## Реальный пример из продакшна

```js
// Классификация входящего сообщения агентом
const classification = await callWithSchema(
  `Классифицируй запрос клиента: "${message}"`,
  {
    type: 'object',
    properties: {
      intent:   { type: 'string', enum: ['buy', 'support', 'info', 'other'] },
      priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      summary:  { type: 'string' },
    },
    required: ['intent', 'priority', 'summary'],
  },
  {
    model: 'claude-haiku-4-5-20251001',
    maxRetries: 2,
    onError: (err, attempt) => console.warn(`attempt ${attempt}: ${err.message}`),
  }
);

// classification.intent === 'buy', classification.priority === 'high'
```

---

## Поддерживаемые провайдеры

| Провайдер | Переменные окружения | Примечание |
|-----------|---------------------|------------|
| **Polza.AI** | `POLZA_API_KEY` | Claude через прокси, рекомендуется |
| **Anthropic** (напрямую) | `LLM_API_KEY`, `LLM_BASE_URL=https://api.anthropic.com/v1` | Нужен `anthropic-version` хедер — лучше через Polza |
| **OpenAI** | `LLM_API_KEY`, `LLM_BASE_URL=https://api.openai.com/v1` | GPT-4o и др. |
| Любой OpenAI-совместимый | `LLM_API_KEY`, `LLM_BASE_URL` | Ollama, LM Studio, vLLM и др. |

---

## Зависимости

```json
{
  "dependencies": {
    "openai": "^4.0.0"
  }
}
```

Node.js >= 18, ESM (`import`).

---


Одноразовая оплата. Включает: исходник + поддержка интеграции под ваш стек.

📩 Telegram: [@denis201345](https://t.me/denis201345)
