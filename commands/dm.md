---
description: Send a direct message to an agent
argument-hint: <agent-id-or-name> <message>
---

Parse `$ARGUMENTS` as `<target> <message>` — first whitespace-separated token is the target agent id or name; everything after is the message body. Call the `agent_comms` MCP tool with `action: "dm"`, `target: <target>`, `content: <message>`, and `streamingBehavior: "steer"`. Confirm with a single line containing the returned message id. If the target is unknown, surface the error verbatim.
