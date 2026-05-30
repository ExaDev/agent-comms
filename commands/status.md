---
description: Set this session's presence status
argument-hint: <active|idle|busy>
---

Validate that `$ARGUMENTS` is one of `active`, `idle`, or `busy`. If invalid, print an error and stop. Otherwise call the `agent_comms` MCP tool with `action: "update"` and `status: "$ARGUMENTS"`. Confirm with a single line: the new status.
