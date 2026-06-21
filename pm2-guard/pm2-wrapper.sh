#!/usr/bin/env bash
# pm2 safety wrapper — OS-уровень, перехватывает bare `pm2` (PATH: /usr/local/bin раньше /usr/bin).
# Инцидент 2026-06-18: субагент `pm2 delete all` снёс весь зоопарк (~218 процессов).
# Жёстко блокирует ТОЛЬКО катастрофические fleet-wide операции:
#   - pm2 delete all / pm2 del all
#   - pm2 kill   (убивает демон + все процессы)
# `restart all` / `reload all` НЕ блокируются (их используют jwt-rotation/deploy-кроны — легитимно).
# Обойти: флаг --force-confirm в команде ИЛИ PM2_FORCE_ALL=1 (= явное ОК Дениса).
# Реальный pm2 — симлинк /usr/bin/pm2 → /usr/lib/node_modules/pm2/bin/pm2 (НЕ этот враппер).

REAL_PM2="/usr/bin/pm2"
LOG="/var/log/pm2-guard.log"

# защита от рекурсии: если REAL_PM2 указывает на нас самих — фейлимся явно
if [ "$(readlink -f "$REAL_PM2" 2>/dev/null)" = "$(readlink -f "$0" 2>/dev/null)" ]; then
  echo "pm2-guard: REAL_PM2 резолвится во враппер — рекурсия, abort." >&2
  exit 1
fi
if [ ! -e "$REAL_PM2" ]; then
  echo "pm2-guard: реальный pm2 не найден ($REAL_PM2)." >&2
  exit 1
fi

# собрать аргументы в одну строку (lowercase) для матчинга
joined=" $(printf '%s ' "$@" | tr '[:upper:]' '[:lower:]')"

danger=""
case "$joined" in
  *" delete all "*|*" del all "*) danger="delete all" ;;
esac
[ "$1" = "kill" ] && danger="kill"

if [ -n "$danger" ]; then
  confirmed=0
  [ "$PM2_FORCE_ALL" = "1" ] && confirmed=1
  newargs=()
  for a in "$@"; do
    if [ "$a" = "--force-confirm" ]; then confirmed=1; else newargs+=("$a"); fi
  done

  ts="$(date -Iseconds 2>/dev/null || date)"
  caller="${PM2_GUARD_CALLER:-${SUDO_USER:-$USER}}"
  if [ "$confirmed" != "1" ]; then
    echo "$ts | BLOCKED | $danger | by=$caller | cmd: pm2 $*" >> "$LOG" 2>/dev/null
    {
      echo "🛑 pm2-guard: «pm2 $danger» ЗАБЛОКИРОВАНА."
      echo "   Инцидент 2026-06-18: субагент снёс весь зоопарк через 'pm2 delete all' (~2ч восстановления)."
      echo "   Это уничтожает ВЕСЬ флот процессов. Точечно: pm2 delete <name|id>."
      echo "   Если действительно нужно (есть ОК): pm2 $* --force-confirm"
      echo "   либо: PM2_FORCE_ALL=1 pm2 $*"
    } >&2
    exit 13
  fi
  echo "$ts | ALLOWED(confirmed) | $danger | by=$caller | cmd: pm2 $*" >> "$LOG" 2>/dev/null
  exec "$REAL_PM2" "${newargs[@]}"
fi

exec "$REAL_PM2" "$@"
