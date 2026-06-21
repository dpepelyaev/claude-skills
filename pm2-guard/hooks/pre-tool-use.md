# Claude Code PreToolUse Hook — инструкция подключения

## Что делает hook

Блокирует fleet-wide PM2-команды прямо внутри Claude Code harness **до выполнения** Bash-команды.
Работает для основного Claude и для всех субагентов (cavecrew, haiku, sonnet и т.д.).

Блокирует:
- `pm2 delete all` / `pm2 del all`
- `pm2 stop all`
- `pm2 restart all`
- `pm2 reload all`
- `pm2 kill`

Пропускает:
- Любые точечные операции: `pm2 restart my-service`, `pm2 delete 5`
- Команды с флагом `--force-confirm`
- Команды с env `PM2_FORCE_ALL=1`

Кроны идут **мимо** Claude harness → их `reload all` / `restart all` не затрагиваются.

## Файл hook

`hooks/pre-tool-use.mjs` — копируется в `~/.claude/hooks/pm2-guard.mjs` при установке.

## Подключение к settings.json

Добавить в `~/.claude/settings.json` (или в проектный `.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node /root/.claude/hooks/pm2-guard.mjs"
          }
        ]
      }
    ]
  }
}
```

Путь `node /root/.claude/hooks/pm2-guard.mjs` — замени на реальный путь куда скопирован файл.

Если секция `PreToolUse` уже есть — добавь объект `{matcher, hooks}` в массив, **первым**
(hooks выполняются по порядку, лучше блокировать сразу).

## Важная грабля

Regex хука ловит литерал `pm2 delete all` в **любой** Bash-команде, даже в `echo "текст про инцидент"`.

Если нужно написать такой текст в файл — используй инструмент **Write** или **Edit**, а не `echo >> file`.

## Проверка

```bash
# В чате Claude напиши: "выполни команду pm2 kill"
# Должен получить: 🛑 pm2-guard ЗАБЛОКИРОВАЛ команду...
```

## Обход (только с явным ОК)

```bash
pm2 delete all --force-confirm
# или
PM2_FORCE_ALL=1 pm2 delete all
```
