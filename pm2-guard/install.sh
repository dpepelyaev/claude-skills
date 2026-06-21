#!/usr/bin/env bash
# pm2-guard install.sh — установка 2-слойной защиты PM2
# Шаг 1: OS-враппер в /usr/local/bin/pm2
# Шаг 2: Claude Code PreToolUse hook в ~/.claude/settings.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER_SRC="$SCRIPT_DIR/pm2-wrapper.sh"
HOOK_SRC="$SCRIPT_DIR/hooks/pre-tool-use.mjs"
WRAPPER_DEST="/usr/local/bin/pm2"
CLAUDE_SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

echo "=== pm2-guard installer ==="
echo ""

# --- Шаг 1: OS-враппер ---
echo "[1/2] Установка OS-враппера..."

if [ ! -f "$WRAPPER_SRC" ]; then
  echo "  ОШИБКА: $WRAPPER_SRC не найден." >&2
  exit 1
fi

# бэкап оригинала если там что-то есть (и это не наш враппер)
if [ -f "$WRAPPER_DEST" ]; then
  if grep -q "pm2-guard" "$WRAPPER_DEST" 2>/dev/null; then
    echo "  Враппер уже установлен, обновляем..."
  else
    BAK="${WRAPPER_DEST}.bak-$(date +%s)"
    cp "$WRAPPER_DEST" "$BAK"
    echo "  Бэкап оригинала: $BAK"
  fi
fi

cp "$WRAPPER_SRC" "$WRAPPER_DEST"
chmod +x "$WRAPPER_DEST"
echo "  OK: $WRAPPER_DEST"

# проверка что /usr/local/bin раньше /usr/bin в PATH
if ! echo "$PATH" | tr ':' '\n' | grep -x "/usr/local/bin" | head -1 > /dev/null; then
  echo "  ВНИМАНИЕ: /usr/local/bin не найден в PATH или стоит после /usr/bin."
  echo "  Добавь в ~/.bashrc или ~/.zshrc: export PATH=/usr/local/bin:\$PATH"
fi

# проверка что реальный pm2 существует
REAL_PM2="/usr/bin/pm2"
if [ ! -e "$REAL_PM2" ]; then
  # попробуем найти через which (до нашего враппера)
  FOUND=$(PATH="/usr/bin:/usr/lib/node_modules/.bin" which pm2 2>/dev/null || true)
  if [ -n "$FOUND" ]; then
    echo "  ВНИМАНИЕ: реальный pm2 ожидается в $REAL_PM2, но найден в $FOUND."
    echo "  Отредактируй REAL_PM2 в $WRAPPER_DEST."
  else
    echo "  ВНИМАНИЕ: pm2 не найден в /usr/bin. Убедись что REAL_PM2 в враппере указывает правильно."
  fi
fi

echo ""

# --- Шаг 2: Claude Code hook ---
echo "[2/2] Установка Claude Code PreToolUse hook..."

if [ ! -f "$HOOK_SRC" ]; then
  echo "  ОШИБКА: $HOOK_SRC не найден." >&2
  exit 1
fi

# Создать директорию hooks если нет
CLAUDE_HOOKS_DIR="$(dirname "$CLAUDE_SETTINGS")/../hooks"
CLAUDE_HOOKS_DIR="$(realpath "$CLAUDE_HOOKS_DIR" 2>/dev/null || echo "$HOME/.claude/hooks")"
mkdir -p "$CLAUDE_HOOKS_DIR"

HOOK_DEST="$CLAUDE_HOOKS_DIR/pm2-guard.mjs"
cp "$HOOK_SRC" "$HOOK_DEST"
chmod +x "$HOOK_DEST"
echo "  OK: $HOOK_DEST"

# Добавить hook в settings.json
if [ ! -f "$CLAUDE_SETTINGS" ]; then
  echo "  ВНИМАНИЕ: $CLAUDE_SETTINGS не найден."
  echo "  Создаём минимальный settings.json..."
  mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
  cat > "$CLAUDE_SETTINGS" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node $HOOK_DEST"
          }
        ]
      }
    ]
  }
}
EOF
  echo "  Создан: $CLAUDE_SETTINGS"
else
  echo "  $CLAUDE_SETTINGS существует."
  echo "  Добавь вручную в секцию hooks.PreToolUse (см. hooks/pre-tool-use.md):"
  echo ""
  echo '  {'
  echo '    "matcher": "Bash",'
  echo '    "hooks": [{"type": "command", "command": "node '"$HOOK_DEST"'"}]'
  echo '  }'
  echo ""
  echo "  Или запусти: node $SCRIPT_DIR/hooks/inject-settings.mjs"
fi

echo ""
echo "=== Готово ==="
echo ""
echo "Проверка:"
echo "  pm2 list          # должно работать как обычно"
echo "  pm2 kill          # должно быть заблокировано враппером"
echo ""
echo "Журнал блокировок: /var/log/pm2-guard.log"
echo "Обход (только с ОК): pm2 <cmd> --force-confirm  или  PM2_FORCE_ALL=1 pm2 <cmd>"
