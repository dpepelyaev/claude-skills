/**
 * deploy-gate.mjs — единый шлюз публикации на прод-сайты.
 *
 * НАЗНАЧЕНИЕ
 *   Один-единственный канал, через который проходит ЛЮБАЯ запись на боевой сайт.
 *   Ни один агент/воркер не должен публиковать в прод в обход.
 *
 * ПОЛИТИКА:
 *   • Сайт заказчика  → policy='hard_gate'   → НИЧЕГО не уходит без ОК владельца в Telegram.
 *   • Ваш сайт        → policy='log_rollback' → публикуется сразу, журналируется + откат.
 *   • НЕИЗВЕСТНЫЙ сайт → hard_gate (fail-safe / default-deny).
 *
 * Использование:
 *   import { publishToProd, GateRejectError } from './agents/_lib/deploy-gate.mjs';
 *
 *   const res = await publishToProd({
 *     site:        'YOUR_CLIENT_DOMAIN',     // домен без протокола
 *     target:      'https://YOUR_CLIENT_DOMAIN/page',
 *     actor:       'my-worker',              // кто хочет опубликовать
 *     changeType:  'content',                // seo_title|content|price|code|...
 *     summary:     'Краткое описание правки',
 *     diff:        '- старый\n+ новый',
 *     undoCommand: 'git -C /repo revert HEAD',
 *   }, async () => {
 *     // реальная публикация — вызывается ТОЛЬКО после одобрения
 *     return await actuallyUpload();
 *   });
 *
 * Flow hard_gate:  INSERT deploy_gate(pending) → Telegram кнопки владельцу →
 *                  approve → execute() → status=published | reject/timeout → throw GateRejectError
 * Flow log_rollback: INSERT deploy_gate(pending) → execute() сразу → status=published (+undo)
 */

import pg from 'pg';
import fs from 'node:fs';
import { withApproval, PAERejectError } from './with-approval.mjs';

// ── ENV ─────────────────────────────────────────────────────────────────────
// Загружаем переменные окружения из .env файлов.
// Настройте пути под свой проект:
function loadEnv(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch {}
}
// Укажите пути к вашим .env файлам:
loadEnv('./agents/.env');   // YOUR_ENV_PATH
loadEnv('./.env');          // YOUR_ROOT_ENV_PATH

// ── DB ──────────────────────────────────────────────────────────────────────
// Прямой коннект к PostgreSQL (не через пулер, если используете Supabase).
// Переменная: SUPABASE_PG_URL или DATABASE_URL
const PG_URL = process.env.SUPABASE_PG_URL
  || process.env.DATABASE_URL
  || process.env.SOKRAT_PG_DSN;

if (!PG_URL) {
  throw new Error('[deploy-gate] Не задана переменная SUPABASE_PG_URL / DATABASE_URL');
}

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: PG_URL, max: 2, connectionTimeoutMillis: 6000 });
    _pool.on('error', () => {});
  }
  return _pool;
}
const q = (sql, params = []) => getPool().query(sql, params).then(r => r.rows);

// ── РЕЕСТР САЙТОВ ────────────────────────────────────────────────────────────
// owner: 'us' | 'client'.  policy: 'hard_gate' | 'log_rollback'.
// Добавление сайта = одна строка здесь.
// Замените примеры ниже на реальные домены вашего проекта:
const SITE_REGISTRY = {
  // ── Ваши сайты → журнал + откат, без блокировки ──
  'YOUR_SITE.ru':         { owner: 'us', policy: 'log_rollback' },       // YOUR_DOMAIN
  'dashboard.YOUR_SITE.ru': { owner: 'us', policy: 'log_rollback' },     // YOUR_DOMAIN

  // ── Сайты заказчиков → ЖЁСТКИЙ СТОП, ОК владельца ──
  'CLIENT_SITE_1.ru':    { owner: 'client', policy: 'hard_gate', client_slug: 'client-a' },  // YOUR_DOMAIN
  'CLIENT_SITE_2.ru':    { owner: 'client', policy: 'hard_gate', client_slug: 'client-b' },  // YOUR_DOMAIN
};

/** Нормализует домен: убирает протокол, путь, www., порт, регистр. */
export function normalizeSite(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');   // протокол
  s = s.split('/')[0];                 // путь
  s = s.split('?')[0].split('#')[0];
  s = s.split(':')[0];                 // порт
  s = s.replace(/^www\./, '');
  return s;
}

/**
 * Определяет политику для сайта.
 * НЕИЗВЕСТНЫЙ сайт → hard_gate (fail-safe / default-deny).
 */
export function resolvePolicy(site) {
  const norm = normalizeSite(site);
  const entry = SITE_REGISTRY[norm];
  if (entry) return { site: norm, ...entry, known: true };
  return { site: norm, owner: 'unknown', policy: 'hard_gate', client_slug: null, known: false };
}

// ── GateRejectError ──────────────────────────────────────────────────────────
export class GateRejectError extends Error {
  constructor(reason, gateId) {
    super(`Deploy gate rejected: ${reason} (gate_id=${gateId})`);
    this.name = 'GateRejectError';
    this.gate_id = gateId;
    this.reason = reason;
  }
}

// ── Журнал ───────────────────────────────────────────────────────────────────
async function insertJournal(p) {
  const rows = await q(
    `INSERT INTO agents.deploy_gate
       (site, owner, client_slug, policy, actor, change_type, target, summary, diff, undo_command, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
     RETURNING id`,
    [p.site, p.owner, p.client_slug, p.policy, p.actor, p.changeType, p.target,
     p.summary || null, p.diff || null, p.undoCommand || null]
  );
  return rows[0]?.id;
}

async function setStatus(id, status, extra = {}) {
  const sets = [`status=$2`, `updated_at=now()`];
  const vals = [id, status];
  if (extra.approval_id) { vals.push(extra.approval_id); sets.push(`approval_id=$${vals.length}`); }
  if (extra.decided_by)  { vals.push(extra.decided_by);  sets.push(`decided_by=$${vals.length}`); }
  await q(`UPDATE agents.deploy_gate SET ${sets.join(', ')} WHERE id=$1`, vals);
}

// ── ГЛАВНАЯ ФУНКЦИЯ ──────────────────────────────────────────────────────────
/**
 * Опубликовать изменение на прод через шлюз.
 *
 * @param {object} opts
 * @param {string} opts.site         — домен сайта
 * @param {string} opts.target       — конкретный URL/файл правки
 * @param {string} opts.actor        — кто инициатор (agent/worker)
 * @param {string} opts.changeType   — тип: seo_title|content|price|code|legal|...
 * @param {string} opts.summary      — человекочитаемое описание (идёт в Telegram)
 * @param {string} [opts.diff]       — текст diff (для журнала/превью)
 * @param {string} [opts.undoCommand]— команда отката (git revert / restore)
 * @param {string[]} [opts.files]    — список файлов (для авто-апрува картинок)
 * @param {Function} executeFn       — async публикация; вызывается ТОЛЬКО при разрешении
 * @returns {Promise<{gate_id, status, policy, result}>}
 * @throws {GateRejectError} при reject/timeout на hard_gate
 */
export async function publishToProd(opts, executeFn) {
  const pol = resolvePolicy(opts.site);

  const ctx = {
    site: pol.site, owner: pol.owner, client_slug: pol.client_slug, policy: pol.policy,
    actor: opts.actor || 'unknown', changeType: opts.changeType || 'unspecified',
    target: opts.target || pol.site, summary: opts.summary, diff: opts.diff,
    undoCommand: opts.undoCommand,
  };

  const gateId = await insertJournal(ctx);
  if (!gateId) throw new Error('[deploy-gate] journal INSERT failed — публикация отменена');

  // ── HARD GATE: ждём ОК владельца ──
  if (pol.policy === 'hard_gate') {
    // Авто-апрув: если ВСЕ файлы в деплое — только картинки, ОК не нужен
    const files = Array.isArray(opts.files) ? opts.files : [];
    const IMAGE_RE = /\.(jpg|jpeg|webp|png|gif)$/i;
    const isImageOnlyDeploy = files.length > 0 && files.every(f => IMAGE_RE.test(f));

    if (isImageOnlyDeploy) {
      try {
        const result = await executeFn();
        await q(
          `UPDATE agents.deploy_gate SET status='published', auto_approved=true, decided_by='auto', updated_at=now() WHERE id=$1`,
          [gateId]
        );
        console.log(`[deploy-gate] auto-approved image deploy: ${files.length} file(s) on ${ctx.site} (gate_id=${gateId})`);
        return { gate_id: gateId, status: 'published', policy: pol.policy, auto_approved: true, result };
      } catch (e) {
        await setStatus(gateId, 'failed');
        throw e;
      }
    }

    const ownerLabel = pol.known
      ? (pol.owner === 'client' ? `сайт заказчика (${pol.client_slug})` : 'ваш сайт')
      : '⚠️ НЕИЗВЕСТНЫЙ САЙТ';
    const summary = [
      `🌐 ${ctx.site} — ${ownerLabel}`,
      `✏️ ${ctx.changeType}: ${opts.summary || ctx.target}`,
      ctx.target ? `🔗 ${ctx.target}` : '',
      opts.diff ? `\n${String(opts.diff).slice(0, 600)}` : '',
      `\nИнициатор: ${ctx.actor}  ·  gate_id=${gateId}`,
    ].filter(Boolean).join('\n');

    try {
      const result = await withApproval({
        agent: ctx.actor,
        action_type: 'prod_deploy',
        client_id: null,
        summary,
        payload: { gate_id: gateId, site: ctx.site, target: ctx.target, change_type: ctx.changeType },
      }, async () => {
        return await executeFn();
      });
      await setStatus(gateId, 'published', { decided_by: 'owner' });
      return { gate_id: gateId, status: 'published', policy: pol.policy, result };
    } catch (e) {
      if (e instanceof PAERejectError) {
        const st = e.reason === 'timeout' ? 'timeout' : 'rejected';
        await setStatus(gateId, st, { decided_by: 'owner' });
        throw new GateRejectError(e.reason, gateId);
      }
      await setStatus(gateId, 'failed');
      throw e;
    }
  }

  // ── LOG + ROLLBACK: публикуем сразу, журналируем ──
  try {
    const result = await executeFn();
    await setStatus(gateId, 'published');
    return { gate_id: gateId, status: 'published', policy: pol.policy, result };
  } catch (e) {
    await setStatus(gateId, 'failed');
    throw e;
  }
}

// ── Откат ────────────────────────────────────────────────────────────────────
/** Возвращает undo_command для записи журнала. */
export async function getUndoCommand(gateId) {
  const rows = await q(`SELECT undo_command, status FROM agents.deploy_gate WHERE id=$1`, [gateId]);
  return rows[0] || null;
}

/** Помечает запись откатанной (вызывается после успешного исполнения undo). */
export async function markReverted(gateId) {
  await setStatus(gateId, 'reverted');
}
