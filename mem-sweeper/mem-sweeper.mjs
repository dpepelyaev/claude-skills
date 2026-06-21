#!/usr/bin/env node
/**
 * mem-sweeper.mjs — Memory Sweeper v1.0
 * Убивает осиротевшие MCP/npx процессы (PPID=1, etime > 30 мин).
 * При available < 20% total → drop_caches.
 * Алертит в Telegram при критических условиях.
 *
 * ENV переменные:
 *   SUPABASE_PG_URL   — строка подключения к PostgreSQL (обязательно)
 *   TG_BOT_TOKEN      — токен Telegram-бота для алертов
 *   TG_CHAT_ID        — chat_id для отправки алертов
 *
 * Флаг --dry-run: показывает что убил бы, но не убивает.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

// ─── Config ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

const PG_URL = process.env.SUPABASE_PG_URL;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

if (!PG_URL) {
  console.error('[sweep] FATAL: SUPABASE_PG_URL не задан');
  process.exit(1);
}

// Паттерны MCP/npx процессов для зачистки
const MCP_PATTERNS = [
  '@modelcontextprotocol',
  'mcp-server',
  'mcp-remote',
  'firecrawl-mcp',
  'figma-developer-mcp',
  'gemini-nanobanana-mcp',
  'mcp-google-drive',
  'context7-mcp',
  'server-sequential-thinking',
  'server-memory',
  'upstash',
  'icons8',
  'magic-21st',
  'shadcn',
  '@apify/',
  '@upstash/',
  'firecrawl',
  'figma',
];

// Имена защищённых процессов — не трогать
const PROTECTED_NAMES = [
  'sokrat-heartbeat', 'viktor-', 'anna-', 'alex-', 'elena-',
  'gena-', 'claude-cli', 'claude',
];

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function readMeminfo() {
  const raw = fs.readFileSync('/proc/meminfo', 'utf8');
  const parse = (key) => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? Math.round(parseInt(m[1]) / 1024) : 0; // kB → MB
  };
  return {
    total: parse('MemTotal'),
    available: parse('MemAvailable'),
    used: parse('MemTotal') - parse('MemAvailable'),
  };
}

function etimeToSeconds(etime) {
  // форматы: MM:SS, HH:MM:SS, D-HH:MM:SS
  try {
    let days = 0;
    let rest = etime.trim();
    if (rest.includes('-')) {
      const [d, r] = rest.split('-');
      days = parseInt(d);
      rest = r;
    }
    const parts = rest.split(':').map(Number);
    let secs = 0;
    if (parts.length === 2) secs = parts[0] * 60 + parts[1];
    if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
    return days * 86400 + secs;
  } catch {
    return 0;
  }
}

function isProtected(user, comm, argv) {
  if (user === 'gena') return true;
  const allText = `${comm} ${argv}`.toLowerCase();
  for (const pat of PROTECTED_NAMES) {
    if (allText.includes(pat)) return true;
  }
  return false;
}

function isMcpProcess(comm, argv) {
  const allText = `${comm} ${argv}`.toLowerCase();
  const isNpmExec = allText.includes('npm exec') || allText.includes('npx') ||
    comm.includes('npm') || comm.includes('node');
  if (!isNpmExec) return false;
  for (const pat of MCP_PATTERNS) {
    if (allText.includes(pat.toLowerCase())) return true;
  }
  return false;
}

function getOrphanedMcpProcesses() {
  const output = execSync(
    'ps -eo pid,ppid,user,comm,etime,args --no-headers 2>/dev/null',
    { maxBuffer: 10 * 1024 * 1024 }
  ).toString();

  const orphans = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;

    const pid = parseInt(parts[0]);
    const ppid = parseInt(parts[1]);
    const user = parts[2];
    const comm = parts[3];
    const etime = parts[4];
    const argv = parts.slice(5).join(' ');

    if (ppid !== 1) continue;
    const etimeSecs = etimeToSeconds(etime);
    if (etimeSecs < 30 * 60) continue;
    if (!isMcpProcess(comm, argv)) continue;
    if (isProtected(user, comm, argv)) continue;

    orphans.push({ pid, ppid, user, comm, etime, etimeSecs, argv: argv.slice(0, 120) });
  }
  return orphans;
}

async function killProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    await new Promise(r => setTimeout(r, 30000));
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
      console.log(`[sweep] SIGKILL → PID ${pid}`);
    } catch {
      // уже умер от SIGTERM
    }
  } catch {
    // процесс уже не существует
  }
}

async function sendTgAlert(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' });
  return new Promise((resolve) => {
    const req = https.request(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => { res.resume(); resolve(); }
    );
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

async function saveToDb(row) {
  const client = new Client({ connectionString: PG_URL });
  try {
    await client.connect();
    await client.query(`
      INSERT INTO agents.memory_sweeps
        (ts, mem_total_mb, mem_used_before_mb, mem_available_before_mb,
         mem_used_after_mb, mem_available_after_mb, freed_mb,
         killed_count, killed_pids, drop_caches_ran, alert_sent, alert_severity, notes)
      VALUES
        (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      row.total, row.usedBefore, row.availBefore,
      row.usedAfter, row.availAfter, row.freed,
      row.killedCount, JSON.stringify(row.killedPids),
      row.dropCachesRan, row.alertSent, row.alertSeverity || null,
      row.notes || null,
    ]);
    console.log('[sweep] Запись в agents.memory_sweeps сохранена');
  } catch (e) {
    console.error('[sweep] Ошибка записи в БД:', e.message);
  } finally {
    await client.end();
  }
}

async function getKilledLastHour() {
  const client = new Client({ connectionString: PG_URL });
  try {
    await client.connect();
    const r = await client.query(`
      SELECT COALESCE(SUM(killed_count), 0) AS total
      FROM agents.memory_sweeps
      WHERE ts > now() - interval '1 hour'
    `);
    return parseInt(r.rows[0].total);
  } catch {
    return 0;
  } finally {
    await client.end();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[sweep] Старт ${DRY_RUN ? '(DRY-RUN)' : ''} — ${new Date().toISOString()}`);

  // 1. Состояние памяти ДО
  const memBefore = readMeminfo();
  console.log(`[sweep] RAM before: total=${memBefore.total}MB used=${memBefore.used}MB avail=${memBefore.available}MB`);

  // 2. Найти осиротевшие MCP процессы
  const orphans = getOrphanedMcpProcesses();
  console.log(`[sweep] Найдено осиротевших MCP процессов: ${orphans.length}`);

  for (const p of orphans) {
    console.log(`  PID=${p.pid} etime=${p.etime} user=${p.user} comm=${p.comm} argv=${p.argv}`);
  }

  let killedCount = 0;
  const killedPids = [];

  if (!DRY_RUN && orphans.length > 0) {
    const chunks = [];
    for (let i = 0; i < orphans.length; i += 5) chunks.push(orphans.slice(i, i + 5));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(p => killProcess(p.pid)));
      killedPids.push(...chunk.map(p => p.pid));
      killedCount += chunk.length;
    }
    console.log(`[sweep] Убито процессов: ${killedCount}`);
  } else if (DRY_RUN && orphans.length > 0) {
    console.log(`[sweep] DRY-RUN: убил бы ${orphans.length} процессов`);
    killedCount = orphans.length;
    killedPids.push(...orphans.map(p => p.pid));
  }

  // 3. drop_caches при нехватке памяти (< 20% total)
  const threshold20 = Math.round(memBefore.total * 0.2);
  let dropCachesRan = false;
  if (memBefore.available < threshold20) {
    console.log(`[sweep] available ${memBefore.available}MB < 20% (${threshold20}MB) → drop_caches`);
    if (!DRY_RUN) {
      try {
        execSync('sync && echo 3 > /proc/sys/vm/drop_caches');
        console.log('[sweep] drop_caches выполнен');
        dropCachesRan = true;
      } catch (e) {
        console.error('[sweep] drop_caches ошибка:', e.message);
      }
    } else {
      console.log('[sweep] DRY-RUN: drop_caches пропущен');
    }
  }

  // 4. Состояние памяти ПОСЛЕ
  const memAfter = readMeminfo();
  const freed = memAfter.available - memBefore.available;
  console.log(`[sweep] RAM after: used=${memAfter.used}MB avail=${memAfter.available}MB freed=${freed}MB`);

  // 5. TG-алерт при критических условиях
  let alertSent = false;
  let alertSeverity = null;
  let alertText = null;

  const threshold10 = Math.round(memBefore.total * 0.1);
  if (memBefore.available < threshold10) {
    alertSeverity = 'critical';
    alertText = `🚨 <b>RAM CRITICAL</b> на VPS\n`
      + `До: ${memBefore.used}/${memBefore.total}MB (доступно ${memBefore.available}MB)\n`
      + `После: ${memAfter.used}/${memAfter.total}MB (доступно ${memAfter.available}MB)\n`
      + `Убито: ${killedCount} MCP-процессов | drop_caches: ${dropCachesRan ? 'да' : 'нет'}`;
  } else if (killedCount > 10) {
    alertSeverity = 'warning';
    alertText = `⚠️ <b>RAM sweep</b>: убито ${killedCount} осиротевших MCP-процессов\n`
      + `Было: ${memBefore.available}MB → стало: ${memAfter.available}MB\nFreed: ~${freed}MB`;
  }

  if (!alertText && !DRY_RUN) {
    const killedLastHour = await getKilledLastHour();
    if (killedLastHour + killedCount > 30) {
      alertSeverity = 'warning';
      alertText = `⚠️ <b>RAM sweep</b>: за час убито ${killedLastHour + killedCount} MCP-процессов\n`
        + `Текущий прогон: ${killedCount} | RAM: ${memAfter.available}MB доступно`;
    }
  }

  if (alertText && !DRY_RUN) {
    await sendTgAlert(alertText);
    alertSent = true;
    console.log(`[sweep] TG-алерт отправлен (${alertSeverity})`);
  } else if (alertText && DRY_RUN) {
    console.log(`[sweep] DRY-RUN: алерт НЕ отправлен (${alertSeverity}): ${alertText}`);
  }

  // 6. Запись в БД
  if (!DRY_RUN) {
    await saveToDb({
      total: memBefore.total,
      usedBefore: memBefore.used,
      availBefore: memBefore.available,
      usedAfter: memAfter.used,
      availAfter: memAfter.available,
      freed,
      killedCount,
      killedPids,
      dropCachesRan,
      alertSent,
      alertSeverity,
      notes: `killed=${killedCount} drop_caches=${dropCachesRan}`,
    });
  } else {
    console.log('[sweep] DRY-RUN: запись в БД пропущена');
  }

  console.log(`[sweep] Готово. killed=${killedCount} freed=${freed}MB drop_caches=${dropCachesRan}`);
}

main().catch(e => {
  console.error('[sweep] FATAL:', e);
  process.exit(1);
});
