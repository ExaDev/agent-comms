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
PENDING="$HOME/.agents/bus/pending/claude-code--${SLUG}.jsonl"
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
