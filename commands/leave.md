---
description: Leave a room
argument-hint: <room-name>
---

Call the `agent_comms` MCP tool with `action: "leave_room"` and `room: "$ARGUMENTS"`. Confirm with a single line. If the room doesn't exist or you're not a member, surface the error verbatim.
