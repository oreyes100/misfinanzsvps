#!/usr/bin/env bash
# filter-rewrite.sh — Mis Finanzas. Sustituto local de RTK rewrite.
# PreToolUse(Bash): inyecta los excludes de .claude/rtk-filter.json en
# grep/rg/find para no traversar node_modules, dist, *.db, *.pdf, Cuentas/, etc.
# Solo reescribe cuando el PRIMER token del comando es grep/egrep/fgrep/rg/find.
# Idempotente (no duplica flags). find: solo comandos simples (sin -exec/-delete/-o).
set -euo pipefail

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -n "$CMD" ] || exit 0

DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
FJSON="$DIR/.claude/rtk-filter.json"
[ -f "$FJSON" ] || exit 0

first=$(printf '%s' "$CMD" | awk '{print $1}')

# Construir flags desde el JSON (single source of truth).
gflags=""; rflags=""; fflags=""
while IFS= read -r d; do
  [ -n "$d" ] || continue
  gflags="$gflags --exclude-dir=$d"
  rflags="$rflags -g '!$d'"
  fflags="$fflags -not -path '*/$d/*'"
done < <(jq -r '.filters.files.exclude[]?' "$FJSON" 2>/dev/null | sed 's#.*/##' | awk 'NF' | sort -u)
while IFS= read -r g; do
  [ -n "$g" ] || continue
  gflags="$gflags --exclude=$g"
  rflags="$rflags -g '!$g'"
  fflags="$fflags -not -name '$g'"
done < <(jq -r '.filters.files.exclude_glob[]?' "$FJSON" 2>/dev/null | awk 'NF')

REW="$CMD"
case "$first" in
  grep|egrep|fgrep)
    case "$CMD" in *--exclude-dir=*|*--exclude=*) exit 0 ;; esac
    REW="${CMD/$first/$first$gflags}"
    ;;
  rg)
    case "$CMD" in *"-g '!"*|*"--glob"*|*"--no-ignore"*) exit 0 ;; esac
    REW="${CMD/rg/rg$rflags}"
    ;;
  find)
    # Solo find simple: si hay acción/operador, no tocar (riesgo de romper semántica).
    case "$CMD" in
      *-exec*|*-delete*|*-prune*|*-path*|*-not*|*-print*|*" -o "*|*-o\ *) exit 0 ;;
    esac
    REW="$CMD$fflags"
    ;;
  *)
    exit 0
    ;;
esac

[ "$REW" = "$CMD" ] && exit 0

UPDATED=$(printf '%s' "$INPUT" | jq -c --arg cmd "$REW" '.tool_input | .command = $cmd')
jq -n --argjson updated "$UPDATED" '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "filter-rewrite: excludes de rtk-filter.json",
    "updatedInput": $updated
  }
}'
exit 0
