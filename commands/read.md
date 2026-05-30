---
description: Read recent messages from a room
argument-hint: <room>
---

Call the `agent_comms` MCP tool with `action: "read_room"` and `room: "$ARGUMENTS"`. Present each message on its own line in chronological order, using the format `[HH:MM] <sender>: <content>`. If `<sender>` is a long fingerprint, truncate to the last 8 characters. No commentary.
