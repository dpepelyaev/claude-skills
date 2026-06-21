// Circuit breaker для внешних API.
// Предотвращает каскадные ошибки — если API падает 5 раз подряд,
// останавливаем попытки на cooldown, потом пробуем снова.
//
// States: closed (работает) → open (пауза) → half-open (пробный вызов)
//
// Usage:
//   import { CircuitBreaker, getBreaker } from './circuit-breaker.mjs';
//
//   // Глобальный реестр (один breaker per endpoint)
//   const result = await getBreaker('yandex-direct').call(async () => {
//     return await directApi.getCampaigns(...);
//   });
//
//   // Или свой инстанс
//   const breaker = new CircuitBreaker('deepseek', { threshold: 3, cooldown_ms: 60_000 });
//   const result = await breaker.call(async () => apiCall());

export class CircuitBreakerOpenError extends Error {
  constructor(name, until) {
    super(`Circuit '${name}' is OPEN — paused until ${until.toISOString()}`);
    this.name = 'CircuitBreakerOpenError';
    this.circuit = name;
    this.until = until;
  }
}

export class CircuitBreaker {
  /**
   * @param {string} name         — имя для логов / алертов
   * @param {object} [opts]
   * @param {number} [opts.threshold=5]       — число ошибок до open
   * @param {number} [opts.cooldown_ms=60000] — пауза в open state
   * @param {Function} [opts.onOpen]          — callback при переходе в open
   * @param {Function} [opts.onClose]         — callback при восстановлении
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.threshold = opts.threshold ?? 5;
    this.cooldown_ms = opts.cooldown_ms ?? 60_000;
    this.onOpen = opts.onOpen ?? null;
    this.onClose = opts.onClose ?? null;

    this._failures = 0;
    this._state = 'closed';   // closed / open / half-open
    this._openedAt = null;
  }

  get state() { return this._state; }
  get failures() { return this._failures; }

  /** Запускает fn под защитой circuit breaker. */
  async call(fn) {
    if (this._state === 'open') {
      const reopenAt = new Date(this._openedAt.getTime() + this.cooldown_ms);
      if (Date.now() < reopenAt.getTime()) {
        throw new CircuitBreakerOpenError(this.name, reopenAt);
      }
      this._state = 'half-open';
      this._log('→ half-open (trying one call)');
    }

    try {
      const result = await fn();
      if (this._state === 'half-open') {
        this._state = 'closed';
        this._failures = 0;
        this._log('→ closed (recovered)');
        this.onClose?.();
      }
      return result;
    } catch (err) {
      // Не считаем 4xx как сбой circuit (это ошибки данных, не инфры)
      if (err.status >= 400 && err.status < 500) throw err;

      this._failures++;
      if (this._state === 'half-open' || this._failures >= this.threshold) {
        this._state = 'open';
        this._openedAt = new Date();
        this._log(`→ OPEN after ${this._failures} failures`);
        this.onOpen?.({ name: this.name, failures: this._failures, error: err });
      }
      throw err;
    }
  }

  /** Мануальный reset (после ручного фикса). */
  reset() {
    this._state = 'closed';
    this._failures = 0;
    this._openedAt = null;
    this._log('→ manually reset');
  }

  _log(msg) {
    if (process.env.CIRCUIT_DEBUG === '1') {
      console.log(`[circuit:${this.name}] ${msg}`);
    }
  }
}

// Глобальный реестр — один breaker per named endpoint
const _registry = new Map();

/**
 * Получить или создать named breaker.
 * @param {string} name
 * @param {object} [opts] — только при первом создании
 */
export function getBreaker(name, opts = {}) {
  if (!_registry.has(name)) {
    _registry.set(name, new CircuitBreaker(name, opts));
  }
  return _registry.get(name);
}

/** Статус всех зарегистрированных breaker'ов (для heartbeat/dashboard). */
export function getAllBreakersStatus() {
  const result = {};
  for (const [name, cb] of _registry) {
    result[name] = { state: cb.state, failures: cb.failures };
  }
  return result;
}
