#!/usr/bin/env bash
# precommit-privacy.sh — Mis Finanzas.
# PreToolUse(Bash) hook: bloquea `git commit` si .claude/memory/* expone datos
# sensibles (blob tokens, CLABE/tarjeta, saldos, UUIDs de sync) sin envolver en
# <private>...</private>. App de finanzas => confidencialidad obligatoria.
#
# Delega la deteccion a .claude/memory/privacy-filter.py --check.
set -euo pipefail

command -v jq >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

# Solo actuar sobre git commit.
case "$CMD" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
FILTER="$DIR/.claude/memory/privacy-filter.py"
[ -f "$FILTER" ] || exit 0

violations=""
for f in "$DIR"/.claude/memory/*; do
  [ -f "$f" ] || continue
  case "$f" in *privacy-filter.py) continue ;; esac
  if ! out=$(python3 "$FILTER" --check "$f" 2>&1); then
    violations="${violations}
${out}"
  fi
done

if [ -n "$violations" ]; then
  reason="Privacy check FAILED — datos sensibles en .claude/memory/ sin <private>:${violations}

Envolver en <private>...</private> o eliminar antes de commit."
  jq -n --arg r "$reason" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $r
    }
  }'
  exit 0
fi

exit 0
