# Circuit Breaker для Node.js агентов

Защита AI-агентов от каскадных падений при сбоях внешних API.

---

## Проблема

Когда внешний API (Яндекс.Директ, OpenAI, Telegram и т.д.) начинает отдавать ошибки,
агент продолжает долбить его снова и снова — каждые N секунд, сотни раз подряд.
Результат: **крашлуп**, исчерпание лимитов API, лавина ошибок в логах, перегрев PM2.

---

## Решение

Circuit Breaker — электрический предохранитель для кода. Три состояния:

```
closed  →(5 ошибок подряд)→  open  →(60 сек cooldown)→  half-open  →(успех)→  closed
  ↑                                                           |
  └────────────────────(ошибка)───────────────────────────────┘
```

- **closed** — всё работает, вызовы проходят
- **open** — API явно сломан, вызовы блокируются сразу (без ожидания таймаута)
- **half-open** — cooldown истёк, пробуем один вызов; если успех → closed, если ошибка → снова open

4xx-ошибки (400, 401, 403, 404) **не считаются** как сбой circuit — это ошибки данных, не инфры.

---

## Установка

```bash
# Скачать
curl -O https://raw.githubusercontent.com/your-org/circuit-breaker/main/circuit-breaker.mjs

# Установить в проект
bash install.sh
```

---

## Пример использования

```js
import { getBreaker, CircuitBreakerOpenError } from './agents/_lib/circuit-breaker.mjs';

// Вариант 1 — глобальный реестр (рекомендуется)
async function fetchCampaigns() {
  return await getBreaker('yandex-direct').call(async () => {
    const res = await fetch('https://api.direct.yandex.com/...');
    if (!res.ok) throw Object.assign(new Error('API error'), { status: res.status });
    return res.json();
  });
}

// Вариант 2 — свой инстанс с кастомными параметрами
import { CircuitBreaker } from './agents/_lib/circuit-breaker.mjs';

const breaker = new CircuitBreaker('openai', {
  threshold: 3,          // открыть после 3 ошибок (по умолчанию 5)
  cooldown_ms: 30_000,   // пауза 30 секунд (по умолчанию 60)
  onOpen: ({ name, failures }) => {
    console.error(`[ALERT] Circuit ${name} OPEN после ${failures} ошибок`);
  },
  onClose: () => {
    console.log('[OK] Circuit восстановлен');
  },
});

// Обработка блокированного вызова
try {
  const result = await breaker.call(() => apiCall());
} catch (err) {
  if (err.name === 'CircuitBreakerOpenError') {
    console.log(`API недоступен, повтор после ${err.until.toISOString()}`);
  }
}

// Статус всех breaker'ов (для healthcheck/dashboard)
import { getAllBreakersStatus } from './agents/_lib/circuit-breaker.mjs';
console.log(getAllBreakersStatus());
// { 'yandex-direct': { state: 'open', failures: 5 }, 'openai': { state: 'closed', failures: 0 } }

// Отладочные логи (выводит переходы состояний)
process.env.CIRCUIT_DEBUG = '1';
```

---

## API

| Экспорт | Описание |
|---------|----------|
| `CircuitBreaker` | Класс. `new CircuitBreaker(name, opts)` |
| `getBreaker(name, opts?)` | Получить/создать breaker из глобального реестра |
| `getAllBreakersStatus()` | Статус всех зарегистрированных breaker'ов |
| `CircuitBreakerOpenError` | Ошибка, бросаемая когда circuit открыт |

### Параметры `new CircuitBreaker(name, opts)`

| Параметр | По умолчанию | Описание |
|----------|-------------|----------|
| `threshold` | `5` | Число ошибок подряд до перехода в `open` |
| `cooldown_ms` | `60000` | Пауза в `open` состоянии (мс) |
| `onOpen` | `null` | Callback `({ name, failures, error })` при открытии |
| `onClose` | `null` | Callback `()` при восстановлении |

---

## Цена

**1 500 ₽** — разовая лицензия, использование в любом числе проектов.

---

## Контакт

Telegram: [@denis201345](https://t.me/denis201345)
