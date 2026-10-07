#!/usr/bin/env bash
# Runs fuzz-hooks-inproc.mjs once per (dialect, event), resumable: existing results are skipped.
# usage: OUT=/tmp/fuzz N=5000 SEED=7 ./run-fuzz-all.sh [maxSeconds]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-/tmp/sam-fuzz-out}"; N="${N:-5000}"; SEED="${SEED:-7}"; BUDGET="${1:-100000}"
mkdir -p "$OUT"; start=$(date +%s)
declare -A EV=(
 [claude]="SessionStart UserPromptSubmit PostToolUse PostToolUseFailure PreCompact Stop SessionEnd"
 [codex]="SessionStart UserPromptSubmit PostToolUse PreCompact Stop"
 [gemini]="SessionStart BeforeAgent AfterTool PreCompress AfterAgent SessionEnd"
 [antigravity]="PreInvocation PostToolUse Stop"
 [opencode]="SessionStart UserPromptSubmit PostToolUse PreCompact PostCompact Stop SessionEnd"
 [cursor]="sessionStart beforeSubmitPrompt postToolUse postToolUseFailure afterAgentResponse preCompact sessionEnd")
for a in claude codex gemini antigravity opencode cursor; do
  for e in ${EV[$a]}; do
    f="$OUT/$a-$e.json"; [ -s "$f" ] && continue
    [ $(( $(date +%s) - start )) -gt "$BUDGET" ] && { echo "budget reached"; exit 0; }
    node "$HERE/fuzz-hooks-inproc.mjs" --agent "$a" --event "$e" --n "$N" --seed "$SEED" --out "$f.tmp" >/dev/null 2>"$OUT/$a-$e.err" && mv "$f.tmp" "$f"
    echo "$a $e rc=$?"
  done
done
echo all-done
