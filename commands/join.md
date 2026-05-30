---
description: Join a room
argument-hint: <room-name>
---

Call the `agent_comms` MCP tool with `action: "join_room"` and `room: "$ARGUMENTS"`. Confirm with a single line — room name and current member count. If the room doesn't exist, surface the error verbatim.
