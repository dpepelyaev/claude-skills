#!/usr/bin/env node
// db-backup.mjs — авто-дамп PostgreSQL каждые 15 минут с проверкой размера
// ENV: SUPABASE_PG_URL, BACKUP_DIR, OFFSITE_URL (optional), TG_TOKEN, TG_CHAT_ID

import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';

// --- Конфиг из ENV ---
const PG_URL    = process.env.SUPABASE_PG_URL;
const BACKUP_DIR = process.env.BACKUP_DIR || '/root/backups/db';
const OFFSITE_URL = process.env.OFFSITE_URL || '';   // sftp/s3/rclone target (optional)
const TG_TOKEN  = process.env.TG_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

const MIN_SIZE_BYTES = 1024;      // < 1 KB = красный (пустой дамп)
const KEEP_COUNT     = 96;        // хранить последние 96 дампов (~24 ч при 15-мин цикле)

if (!PG_URL) {
  console.error('[ERROR] SUPABASE_PG_URL не задан');
  process.exit(1);
}

// --- Утилиты ---
function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch {}
}

function rotateOld(dir) {
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.dump.gz'))
    .map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const f of files.slice(KEEP_COUNT)) {
    unlinkSync(join(dir, f.name));
    console.log('[rotate] удалён старый дамп:', f.name);
  }
}

// --- Основной цикл ---
async function run() {
  mkdirSync(BACKUP_DIR, { recursive: true });

  const file = join(BACKUP_DIR, `dump-${ts()}.dump.gz`);

  console.log(`[backup] старт → ${file}`);

  try {
    // pg_dump + gzip
    execSync(
      `pg_dump --no-password "${PG_URL}" | gzip -6 > "${file}"`,
      { stdio: ['ignore', 'pipe', 'pipe'], shell: true, timeout: 120_000 }
    );
  } catch (err) {
    const msg = `🔴 <b>DB Backup FAIL</b>\npg_dump завершился с ошибкой:\n<code>${err.message.slice(0, 300)}</code>`;
    console.error('[backup] pg_dump ошибка:', err.message);
    await tg(msg);
    process.exit(1);
  }

  // Проверка размера
  const size = statSync(file).size;
  console.log(`[backup] размер: ${size} байт`);

  if (size < MIN_SIZE_BYTES) {
    const msg = `🔴 <b>DB Backup ПУСТОЙ</b>\nФайл: ${basename(file)}\nРазмер: ${size} байт (< ${MIN_SIZE_BYTES})\nВозможна проблема с подключением к БД!`;
    console.error('[backup] КРИТИЧНО: дамп пустой или слишком мал');
    await tg(msg);
    process.exit(1);
  }

  console.log(`[backup] OK — ${(size / 1024 / 1024).toFixed(2)} MB`);

  // Offsite копирование (опционально)
  if (OFFSITE_URL) {
    try {
      execSync(`rclone copy "${file}" "${OFFSITE_URL}" --timeout=60s`, {
        stdio: 'inherit', timeout: 90_000
      });
      console.log('[offsite] отправлен в:', OFFSITE_URL);
    } catch (err) {
      console.warn('[offsite] ошибка (не критично):', err.message);
      await tg(`⚠️ <b>DB Backup offsite FAIL</b>\n${err.message.slice(0, 200)}`);
    }
  }

  // Ротация старых дампов
  rotateOld(BACKUP_DIR);

  console.log('[backup] завершён успешно');
}

run().catch(async err => {
  console.error('[backup] fatal:', err.message);
  await tg(`🔴 <b>DB Backup FATAL</b>\n${err.message.slice(0, 300)}`);
  process.exit(1);
});
