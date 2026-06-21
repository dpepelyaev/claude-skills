// LLM Router — единый клиент для Claude + Polza.AI с fallback.
//
// Поддерживает endpoint'ы через единый Anthropic-compatible интерфейс:
//   - polza     (qwen3-235b-a22b, qwen3-30b, qwen3-8b) — Polza.AI, ДЕФОЛТ
//   - anthropic (claude-sonnet-4-6, claude-opus-4-5, claude-haiku-4-5)
//
// Выбор endpoint через env переменные:
//   1. Per-call:   getLLMClient({ profile: 'anthropic' })
//   2. Per-script: LLM_PROFILE=anthropic node script.js
//   3. Fallback:   polza (qwen3-235b-a22b)
//
// Usage:
//   import { getLLMClient } from './llm-client.mjs';
//   const { client, model, profile } = getLLMClient({ layer: 'cron' });
//   const resp = await client.messages.create({ model, max_tokens: 800, messages: [...] });

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

// ─── Профили провайдеров ──────────────────────────────────────────────────────

const PROFILES = {
  polza: {
    baseURL: process.env.LLM_BASE_URL || 'https://api.polza.ai',
    models: {
      standard: 'qwen3-235b-a22b',
      fast:     'qwen3-8b',
      smart:    'qwen3-235b-a22b',
    },
    pricing: {
      'qwen3-235b-a22b': { input: 0.0009,  output: 0.0009  },
      'qwen3-30b':       { input: 0.00045, output: 0.00045 },
      'qwen3-8b':        { input: 0.00015, output: 0.00015 },
    },
    type: 'openai-compat',
  },
  anthropic: {
    baseURL: process.env.LLM_BASE_URL || 'https://api.anthropic.com',
    models: {
      standard: 'claude-sonnet-4-6',
      fast:     'claude-haiku-4-5',
      smart:    'claude-opus-4-5',
    },
    pricing: {
      'claude-sonnet-4-6': { input: 0.003,  output: 0.015  },
      'claude-haiku-4-5':  { input: 0.00025, output: 0.00125 },
      'claude-opus-4-5':   { input: 0.015,  output: 0.075  },
    },
    type: 'anthropic',
  },
};

// Layer → профиль по умолчанию
const LAYER_DEFAULTS = {
  communicator: { profile: 'polza', tier: 'standard' },
  cron:         { profile: 'polza', tier: 'fast'     },
  decision:     { profile: 'polza', tier: 'fast'     },
  voice:        { profile: 'polza', tier: 'standard' },
};

// ─── Вспомогательные функции ─────────────────────────────────────────────────

function calcCost(usage, pricing) {
  if (!pricing) return 0;
  return +(
    ((usage.input_tokens  || 0) / 1000) * pricing.input +
    ((usage.output_tokens || 0) / 1000) * pricing.output
  ).toFixed(8);
}

// Резолвит POLZA_API_KEY: env → .env файл в текущей директории
let _polzaKeyCache;
function resolvePolzaKey() {
  if (process.env.POLZA_API_KEY) return process.env.POLZA_API_KEY;
  if (_polzaKeyCache !== undefined) return _polzaKeyCache;
  _polzaKeyCache = '';
  try {
    // Ищем .env в текущей директории
    const envPath = '.env';
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*POLZA_API_KEY\s*=\s*(.+?)\s*$/);
        if (m) { _polzaKeyCache = m[1].replace(/^["']|["']$/g, ''); break; }
      }
    }
  } catch { /* оставляем '' */ }
  return _polzaKeyCache;
}

/**
 * Resolve tool context из env для телеметрии.
 */
export function resolveToolContext(explicit = {}) {
  return {
    tool_name: explicit.tool_name || explicit.toolName ||
               process.env.TOOL_NAME || null,
    source:    explicit.source || (process.argv[1] ? basename(process.argv[1]) : null),
  };
}

// ─── Простая телеметрия (fire-and-forget) ────────────────────────────────────
// По умолчанию logLLM — no-op. Подключите свой логгер через setLLMLogger().

let _llmLogger = null;

/**
 * Подключить внешний логгер вызовов LLM.
 * @param {function(rec): void} fn
 */
export function setLLMLogger(fn) {
  _llmLogger = fn;
}

/**
 * Логирует вызов LLM (fire-and-forget).
 * Если логгер не подключён через setLLMLogger — no-op.
 *
 * @param {Object} rec - agent, model, provider, prompt_tokens,
 *   completion_tokens, cost_usd, latency_ms, success, error_text
 */
export function logLLM(rec = {}) {
  if (!_llmLogger) return;
  try { _llmLogger(rec); } catch { /* никогда не бросаем */ }
}

// ─── Polza-compat клиент (OpenAI /chat/completions) ─────────────────────────

function createPolzaCompatClient(profileName, tier) {
  const prof = PROFILES[profileName];
  const model = prof.models[tier] || prof.models.standard;
  const _ctx = resolveToolContext();

  const _call = async (params) => {
    const t0 = Date.now();
    const key = resolvePolzaKey();
    if (!key) throw new Error('Нет POLZA_API_KEY (env или .env)');

    const msgs = [];
    if (params.system) {
      const sysContent = Array.isArray(params.system)
        ? params.system.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n\n')
        : String(params.system);
      msgs.push({ role: 'system', content: sysContent });
    }
    for (const mm of params.messages || []) {
      const c = Array.isArray(mm.content)
        ? mm.content.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n')
        : mm.content;
      msgs.push({ role: mm.role, content: c });
    }

    let res, data, text = '';
    try {
      res = await fetch(`${prof.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: params.max_tokens || 1024,
          temperature: params.temperature ?? 0.3,
          messages: msgs,
        }),
        signal: AbortSignal.timeout(90000),
      });

      if (!res.ok) {
        const e = await res.text().catch(() => '');
        const err = new Error(`${profileName.toUpperCase()} ${res.status}: ${e.slice(0, 120)}`);
        logLLM({
          agent: params._agent || _ctx.tool_name,
          model, provider: profileName,
          latency_ms: Date.now() - t0,
          success: false, error_text: err.message,
        });
        throw err;
      }

      data = await res.json();
      text = data.choices?.[0]?.message?.content || '';
    } catch (e) {
      if (!res || res.ok) {
        logLLM({
          agent: params._agent || _ctx.tool_name,
          model, provider: profileName,
          latency_ms: Date.now() - t0,
          success: false, error_text: e.message?.slice(0, 200),
        });
      }
      throw e;
    }

    const usage = {
      input_tokens:  data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    };
    const cost = calcCost(usage, prof.pricing[model]);

    logLLM({
      agent: params._agent || _ctx.tool_name,
      model, provider: profileName,
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
      cost_usd: cost,
      latency_ms: Date.now() - t0,
      success: true,
    });

    // Возвращаем Anthropic-совместимый формат
    return {
      content: [{ type: 'text', text }],
      usage,
      model,
      stop_reason: data.choices?.[0]?.finish_reason || 'end_turn',
    };
  };

  // Anthropic-совместимый интерфейс
  return {
    messages: {
      create: _call,
    },
    _model: model,
    _profile: profileName,
  };
}

// ─── Anthropic клиент ─────────────────────────────────────────────────────────

function createAnthropicClient(tier) {
  const prof = PROFILES.anthropic;
  const model = prof.models[tier] || prof.models.standard;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Нет ANTHROPIC_API_KEY в env');

  const sdk = new Anthropic({ apiKey, baseURL: prof.baseURL });
  const _ctx = resolveToolContext();

  // Оборачиваем для телеметрии
  const _call = async (params) => {
    const t0 = Date.now();
    try {
      const resp = await sdk.messages.create(params);
      logLLM({
        agent: params._agent || _ctx.tool_name,
        model: resp.model || model,
        provider: 'anthropic',
        prompt_tokens: resp.usage?.input_tokens,
        completion_tokens: resp.usage?.output_tokens,
        total_tokens: (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0),
        cost_usd: calcCost(
          { input_tokens: resp.usage?.input_tokens, output_tokens: resp.usage?.output_tokens },
          prof.pricing[resp.model || model]
        ),
        latency_ms: Date.now() - t0,
        success: true,
      });
      return resp;
    } catch (e) {
      logLLM({
        agent: params._agent || _ctx.tool_name,
        model, provider: 'anthropic',
        latency_ms: Date.now() - t0,
        success: false, error_text: e.message?.slice(0, 200),
      });
      throw e;
    }
  };

  return {
    messages: { create: _call },
    _model: model,
    _profile: 'anthropic',
  };
}

// ─── Главный экспорт ─────────────────────────────────────────────────────────

/**
 * Возвращает { client, model, profile } для вызова LLM.
 *
 * @param {Object} options
 * @param {string} [options.profile] - 'polza' | 'anthropic'
 * @param {string} [options.tier]    - 'standard' | 'fast' | 'smart'
 * @param {string} [options.layer]   - семантический слой ('cron', 'communicator', ...)
 *
 * @returns {{ client: object, model: string, profile: string }}
 *
 * @example
 * const { client, model } = getLLMClient({ layer: 'cron' });
 * const resp = await client.messages.create({ model, max_tokens: 500, messages: [...] });
 * console.log(resp.content[0].text);
 */
export function getLLMClient(options = {}) {
  // Резолвим профиль: явный → layer-default → env → дефолт
  const layerDef = options.layer ? LAYER_DEFAULTS[options.layer] : null;
  const profile  = options.profile
    || layerDef?.profile
    || process.env.LLM_PROFILE
    || 'polza';
  const tier = options.tier
    || layerDef?.tier
    || process.env.LLM_TIER
    || 'standard';

  if (!PROFILES[profile]) {
    throw new Error(`Неизвестный LLM профиль: "${profile}". Доступны: ${Object.keys(PROFILES).join(', ')}`);
  }

  let client;
  if (PROFILES[profile].type === 'anthropic') {
    client = createAnthropicClient(tier);
  } else {
    client = createPolzaCompatClient(profile, tier);
  }

  return { client, model: client._model, profile };
}

// ─── Утилита: разовый вызов с авто-fallback ──────────────────────────────────

/**
 * Вызывает LLM с автоматическим fallback: сначала основной профиль, потом запасной.
 * Удобно для критических задач.
 *
 * @param {Object} params - параметры messages.create (model добавляется автоматически)
 * @param {Object} options - опции getLLMClient
 * @param {string} [fallbackProfile] - профиль fallback (дефолт: 'polza')
 */
export async function callWithFallback(params, options = {}, fallbackProfile = 'polza') {
  const primary = getLLMClient(options);
  try {
    return await primary.client.messages.create({ ...params, model: primary.model });
  } catch (primaryErr) {
    if (process.env.LLM_DEBUG === '1') {
      console.warn(`[llm-router] primary (${primary.profile}) failed: ${primaryErr.message} — trying fallback`);
    }
    const fallback = getLLMClient({ profile: fallbackProfile, tier: options.tier });
    return await fallback.client.messages.create({ ...params, model: fallback.model });
  }
}
