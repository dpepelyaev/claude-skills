#!/bin/bash
# install.sh — установка скилла session-handoff в текущий проект Claude Code

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-.}/.claude/skills"

mkdir -p "$TARGET_DIR"
cp "$SCRIPT_DIR/skill/session-handoff.md" "$TARGET_DIR/session-handoff.md"

echo "Скилл установлен: $TARGET_DIR/session-handoff.md"
echo "Используй /session-handoff в Claude Code для передачи сессии."
