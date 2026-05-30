#!/usr/bin/env bash
# Drain pending agent-comms events and exit 2 to wake idle Claude via asyncRewake.
#
# Called by Claude Code hooks (PostToolUse, Stop). If there are pending events,
# writes them to stderr and exits 2 — Claude Code wraps the stderr in a
# <system-reminder> and enqueues it as a task-notification, waking idle Claude.
#
# Uses atomic rename to drain so concurrent drains (in-process tool drain vs
# this out-of-process hook) never duplicate or lose events.

set -euo pipefail

SLUG="${PWD//[^a-zA-Z0-9]/_}"

# Walk up the process tree to find the Claude Code PID. Two Claude Code
# instances in the same cwd would otherwise share one pending file and consume
# each other's messages. Each Claude Code session has a unique PID; the bridge
# discovers and uses the same value, so each session gets its own file.
find_claude_pid() {
  local pid=$PPID
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ "$pid" -le 1 ] && return 1
    local info ppid comm
    info=$(ps -p "$pid" -o ppid=,comm= 2>/dev/null) || return 1
    info=${info#"${info%%[![:space:]]*}"}
    [ -z "$info" ] && return 1
    ppid=${info%%[[:space:]]*}
    comm=${info#*[[:space:]]}
    comm=${comm#"${comm%%[![:space:]]*}"}
    case "$comm" in
      */claude|claude) echo "$pid"; return 0 ;;
    esac
    pid=$ppid
  done
  return 1
}

CLAUDE_PID=$(find_claude_pid 2>/dev/null || true)
if [ -n "$CLAUDE_PID" ]; then
  PENDING="$HOME/.agents/bus/pending/claude-code--${SLUG}--${CLAUDE_PID}.jsonl"
else
  echo "agent-comms drain.sh: could not locate Claude Code PID, falling back to shared cwd file" >&2
  PENDING="$HOME/.agents/bus/pending/claude-code--${SLUG}.jsonl"
fi

DRAINING="${PENDING}.draining-$$-$(date +%s%N 2>/dev/null || date +%s)"

# Atomic drain — if rename fails (file absent), nothing to surface.
if ! mv "$PENDING" "$DRAINING" 2>/dev/null; then
  exit 0
fi

CONTENT=$(cat "$DRAINING")
rm -f "$DRAINING"

if [ -z "$CONTENT" ]; then
  exit 0
fi

echo "Pending agent-comms messages:" >&2
while IFS= read -r line; do
  [ -n "$line" ] && echo "  📬 $line" >&2
done <<< "$CONTENT"

exit 2
