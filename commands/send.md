---
description: Broadcast a message to a room
argument-hint: <room> <message>
---

Parse `$ARGUMENTS` as `<room> <message>` — first whitespace-separated token is the room name; everything after is the message body. Call the `agent_comms` MCP tool with `action: "send"`, `target: <room>`, `content: <message>`, and `streamingBehavior: "info"`. Confirm with a single line containing the returned message id. If the room isn't joined, surface the error verbatim.
