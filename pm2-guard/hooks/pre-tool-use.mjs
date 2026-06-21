#!/usr/bin/env node
// pm2-guard PreToolUse hook (Bash).
// Инцидент 2026-06-18: субагент-haiku выполнил `pm2 delete all` → снёс ~218 процессов, ~2ч восстановления.
// Блокирует fleet-wide PM2-операции (delete/stop/restart/reload all + kill) внутри Claude-харнесса
// (интерактив + субагенты). Кроны идут мимо харнесса → их легитимный `pm2 reload all` не затрагивается.
// Обойти можно явным флагом `--force-confirm` или `PM2_FORCE_ALL=1` (= явное ОК Дениса).

import { readFileSync } from 'node:fs';

function read(fd) {
  try { return readFileSync(fd, 'utf8'); } catch { return ''; }
}

let payload = {};
try { payload = JSON.parse(read(0) || '{}'); } catch { payload = {}; }

const cmd = String(payload?.tool_input?.command ?? '');

// нормализация: схлопнуть пробелы, в нижний регистр
const norm = cmd.replace(/\s+/g, ' ').toLowerCase();

// разрешённый обход
const bypass = /--force-confirm\b/.test(cmd) || /\bpm2_force_all=1\b/i.test(cmd);

// опасные паттерны: `pm2` ДОЛЖЕН быть командой (начало строки/после ;&|( ),
// затем опц. флаги, затем destructive verb + all. Иначе ловит "pm2-autosave" и т.п. (ложное срабатывание).
const fleetAll = /(^|[\s;&|(])pm2\s+(-{1,2}\S+\s+)*(delete|del|stop|restart|reload)\s+all([\s;&|)]|$)/.test(norm);
const pm2Kill  = /(^|[\s;&|(])pm2\s+kill([\s;&|)]|$)/.test(norm);

if ((fleetAll || pm2Kill) && !bypass) {
  const what = pm2Kill ? 'pm2 kill' : 'pm2 <delete|stop|restart|reload> all';
  const reason =
    `🛑 pm2-guard ЗАБЛОКИРОВАЛ команду «${what}».\n` +
    `Инцидент 2026-06-18: субагент выполнил «pm2 delete all» и снёс весь зоопарк (~218 процессов, ~2ч восстановления).\n` +
    `Fleet-wide операции PM2 агентам ЗАПРЕЩЕНЫ — работай ТОЧЕЧНО: pm2 restart <name|id>, pm2 delete <name|id>.\n` +
    `Если действие действительно нужно и есть ОК — добавь флаг --force-confirm к команде.`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

process.exit(0);
