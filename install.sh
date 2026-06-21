#!/usr/bin/env bash
# Token Optimizer — установщик скилла для Claude Code
# Копирует skill/token-optimizer.md в .claude/skills/

set -e

SKILL_FILE="$(cd "$(dirname "$0")" && pwd)/skill/token-optimizer.md"
SKILL_NAME="token-optimizer.md"

if [ ! -f "$SKILL_FILE" ]; then
  echo "Ошибка: файл $SKILL_FILE не найден."
  echo "Убедись, что запускаешь install.sh из папки token-optimizer/."
  exit 1
fi

# Определяем целевую папку .claude/skills/
# Приоритет: локальный проект → глобальный ~/.claude/
LOCAL_SKILLS="./.claude/skills"
GLOBAL_SKILLS="$HOME/.claude/skills"

if [ -d "./.claude" ]; then
  TARGET_DIR="$LOCAL_SKILLS"
  echo "Найден локальный .claude/ — устанавливаю в проект."
else
  TARGET_DIR="$GLOBAL_SKILLS"
  echo "Локальный .claude/ не найден — устанавливаю глобально в ~/.claude/skills/"
fi

# Создаём папку если её нет
mkdir -p "$TARGET_DIR"

# Копируем скилл
cp "$SKILL_FILE" "$TARGET_DIR/$SKILL_NAME"
chmod 644 "$TARGET_DIR/$SKILL_NAME"

echo ""
echo "Готово! Скилл установлен:"
echo "  $TARGET_DIR/$SKILL_NAME"
echo ""
echo "Как использовать в Claude Code:"
echo "  /model"
echo ""
echo "Скилл проведёт аудит Agent() вызовов и покажет, где можно заменить sonnet на haiku."
