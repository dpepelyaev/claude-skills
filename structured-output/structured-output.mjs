/**
 * structured-output.mjs — получение структурированного JSON из LLM.
 * Поддержка: Anthropic API, Polza.AI (OpenAI-совместимый).
 * Retry + логирование ошибок.
 */

import OpenAI from 'openai';

const DEFAULT_BASE_URL = 'https://api.polza.ai/api/v1';

function getClient(options = {}) {
  const baseURL = options.baseURL || process.env.LLM_BASE_URL || DEFAULT_BASE_URL;
  const apiKey = options.apiKey || process.env.LLM_API_KEY || process.env.POLZA_API_KEY;

  if (!apiKey) {
    throw new Error('LLM API key not found. Set LLM_API_KEY or POLZA_API_KEY env variable.');
  }

  return new OpenAI({ apiKey, baseURL });
}

/**
 * callWithSchema — вызывает LLM и парсит ответ как JSON.
 *
 * @param {string} prompt — запрос к модели
 * @param {object} schema — JSON Schema объект (описание ожидаемой структуры)
 * @param {object} options
 * @param {string} options.model — модель (default: 'claude-haiku-4-5-20251001')
 * @param {number} options.maxRetries — количество попыток при неверном JSON (default: 3)
 * @param {string} options.apiKey — API ключ (или через env)
 * @param {string} options.baseURL — базовый URL провайдера (или через env)
 * @param {Function} options.onError — callback(err, attempt) для логирования
 * @returns {object} распарсенный JSON
 * @throws при провале всех ретраев
 */
export async function callWithSchema(prompt, schema, options = {}) {
  const {
    model = 'claude-haiku-4-5-20251001',
    maxRetries = 3,
    onError = null,
  } = options;

  const client = getClient(options);
  const schemaStr = JSON.stringify(schema, null, 2);
  const basePrompt = `${prompt}

Верни ТОЛЬКО валидный JSON (без markdown, без пояснений) соответствующий схеме:
${schemaStr}`;

  let lastError = null;
  let currentPrompt = basePrompt;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model,
        max_tokens: 1000,
        messages: [{ role: 'user', content: currentPrompt }],
        temperature: 0,
      });

      const text = resp.choices?.[0]?.message?.content || '';
      const m = text.match(/\{[\s\S]+\}/);
      if (!m) throw new Error('no JSON object in response');

      const parsed = JSON.parse(m[0]);
      return parsed;
    } catch (e) {
      lastError = e;
      if (onError) onError(e, attempt);

      if (attempt < maxRetries) {
        currentPrompt = `${basePrompt}

Предыдущая попытка вернула невалидный JSON. Ошибка: ${e.message}
Верни ТОЛЬКО валидный JSON без markdown-обёрток.`;
      }
    }
  }

  throw new Error(`callWithSchema failed after ${maxRetries} attempts: ${lastError?.message}`);
}

/**
 * callWithSchemaOrNull — как callWithSchema, но возвращает null при провале.
 */
export async function callWithSchemaOrNull(prompt, schema, options = {}) {
  try {
    return await callWithSchema(prompt, schema, options);
  } catch {
    return null;
  }
}
