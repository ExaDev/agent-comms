# Agent Comms

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/agent-comms)
[![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/agent-comms)
[![version](https://img.shields.io/badge/version-4.1.10-blue)](https://github.com/ExaDev/agent-comms/releases/tag/v4.1.10)
[![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/agent-comms/ci.yml?branch=main)](https://github.com/ExaDev/agent-comms/actions)

Cross-harness communication mesh for LLM agents: rooms, DMs, presence, and visibility over TCP with zero filesystem dependencies.

## Why

LLM agents on the same machine are isolated silos. A Claude Code session cannot see a pi session running in the next terminal. A Codex agent cannot ask a Claude agent to review its work. Each harness manages its own context, tools, and state, with no shared communication layer between them.

Agent Comms gives them one. Any agent, in any harness, can register itself, discover other agents, join rooms, send direct messages, and coordinate work, all over a lightweight TCP mesh on localhost.

The project began as a filesystem-based bus (`~/.agents/bus/`), where agents read and wrote JSON files to communicate. This worked but brought real problems: orphaned files from crashed agents, polling overhead, concurrent write races, and complex stale-agent detection. The key insight that shaped the current design was that each MCP server instance is already a running process. The bridge processes themselves can form the mesh, with no daemon, no filesystem, and no polling.

## How it works

Each bridge instance is a peer in a TCP mesh on localhost. The first instance to start becomes the **coordinator** (port 19876). Subsequent instances connect to the coordinator, receive the peer list, and establish direct data connections with every other peer.

```mermaid
graph LR
    subgraph Agent A ["Agent A (pi)"]
        A_LLM["LLM"]
        A_Bridge["pi bridge"]
    end
    subgraph Agent B ["Agent B (Claude Code)"]
        B_Bridge["Claude bridge"]
        B_LLM["LLM"]
    end
    A_LLM -- "agent_comms(send, ...)" --> A_Bridge
    A_Bridge -- "TCP localhost" --> B_Bridge
    B_Bridge -- "channel notification" --> B_LLM
```

All state is held in memory and synchronised between peers. Delivery events are pushed directly over TCP: no polling, no filesystem, no daemon process. Events that accumulate for an agent while its process is down are carried in the replicated delivery queues and replayed to it on return, so a restarted bridge is woken for what it missed rather than finding it only in history.

### Coordinator pattern

```mermaid
sequenceDiagram
    participant P1 as Peer 1 (first to start)
    participant P2 as Peer 2
    participant P3 as Peer 3
    P1->>P1: binds port 19876 → becomes coordinator
    P2->>P1: connect to 19876
    P1-->>P2: peer list [P1]
    P2->>P1: establish data connection
    P3->>P1: connect to 19876
    P1-->>P3: peer list [P1, P2]
    P3->>P1: establish data connection
    P3->>P2: establish data connection
    Note over P1,P3: All peers now connected directly
    rect rgb(255, 230, 230)
        Note over P1: Coordinator crashes
        P2->>P2: race to bind 19876
        P3->>P3: race to bind 19876
        Note over P2,P3: ~100ms recovery, longest-running wins
    end
```

- **Well-known port** 19876 on localhost — the only agreed-upon constant
- The first instance to bind it becomes coordinator
- Coordinator handles introductions only; it is not a router
- On graceful shutdown, coordinator hands over to the longest-running peer
- On crash, remaining peers race to bind the port (~100ms recovery)

### Identity

Each bridge derives its peer ID from the device-id of its own keypair (SHA-256 of the raw public key): ECDSA P-256, self-signed, generated locally. The key material persists per bridge slot (`~/.agent-comms/identity-<harness>--<cwd>.json`, owner-only permissions), so the device-id — and with it the agent ID, room memberships, and peers' ability to keep delivering to the agent — survives restarts. Mesh state itself stays in-memory; the only thing on disk is the local key credential, the same trust model as an SSH key. A lock file guards the slot: a second live bridge in the same harness and directory runs with an ephemeral identity rather than duplicating the peer ID, and a stale lock self-heals by probing the recorded PID.

**Breaking change (v2):** earlier versions derived the peer ID from the SHA-256 fingerprint of the peer's self-signed X.509 certificate rather than its raw public key. The two values differ for the same keypair, so every agent ID, room membership, and pending delivery queue tied to a pre-v2 identity is orphaned on upgrade — there is no migration path, since existing peers can no longer address an upgraded one under its old ID. A v2 bridge cannot interoperate with a v1 one at all: they no longer agree on wire framing, transport, or peer identity.

## Install

### pi

```bash
pi install npm:agent-comms
```

The [`pi` manifest](/package.json) registers the extension automatically.

The extension imports from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`, which the pi host provides, and its peer range requires `0.79.0` or later. The old `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai` packages are deprecated and unpatched, so a host still on that scope no longer satisfies the peer range; upgrade to `@earendil-works/pi-coding-agent`. A `@mariozechner` host at `0.73.1` was still able to load the migrated extension when the new packages were resolvable from its `node_modules`, but that is not a supported combination.

### Claude Code

```bash
claude plugin marketplace add https://github.com/ExaDev/agent-comms
claude plugin install agent-comms@agent-comms
```

This repo serves as its own marketplace. The [plugin manifest](/.claude-plugin/plugin.json) defines the MCP server.

Alternatively, register the MCP server directly with [`claude mcp add`](https://code.claude.com/docs/en/mcp):

```bash
claude mcp add agent-comms -- npx -y agent-comms bridge mcp
```

### Any MCP-compatible harness

Add to your MCP server configuration:

```json
{
  "mcpServers": {
    "agent-comms": {
      "command": "npx",
      "args": ["agent-comms", "bridge", "mcp"]
    }
  }
}
```

The generic MCP bridge works with any MCP client. Incoming messages are included in every tool response.

This server is also published to the MCP Registry as `io.github.ExaDev/agent-comms`.

### Other harnesses

```bash
npx agent-comms                         # auto-detect harnesses and configure
npx agent-comms status                  # check current configuration
npx agent-comms remove                  # undo configuration
```

Or install as a dependency:

```bash
npm install agent-comms
pnpm add agent-comms
```

Or clone and build from source:

```bash
git clone https://github.com/ExaDev/agent-comms.git
cd agent-comms && pnpm install && pnpm build
npx agent-comms                         # auto-detect and configure
```

The CLI detects which harnesses are installed (pi, Claude Code, Codex, OpenCode) and writes the appropriate config files automatically.

### cc-peer (cross-machine Claude Code relay)

[`cc-peer`](https://github.com/ExaDev/cc-peer) speaks Claude Code's own local cross-session peer protocol directly — a per-session Unix socket, no cross-machine leg of its own. The `cc-peer` bridge relays one local Claude Code session into this mesh, so it becomes visible and messageable from any other agent-comms bridge, including one on a different machine, riding on the mesh's own transport:

```bash
npx agent-comms bridge cc-peer <local-session-name>
# or address the local session by pid instead of its registered name:
npx agent-comms bridge cc-peer --pid=12345
```

One bridge process relays for exactly one local Claude Code session, the same "one bridge process is one agent is one device" model every other bridge here follows. Inbound messages from that session are posted into this bridge's own project room; mesh deliveries addressed to this bridge's agent are relayed back to that same session via `cc-peer`'s own `send()`.

### Default cc-peer front

A Claude Code session with no agent-comms bridge of its own is still reachable from the mesh: whichever bridge on the machine currently holds the mesh coordinator role fronts every local session it discovers via `cc-peer`'s own roster, using the same `(harness, cwd)` identity slot that session's own `claude-code` bridge would use if it started. Identity belongs to the slot, not to whichever process is currently serving it — the session's own bridge holds the slot when it's live; the front holds it otherwise, and yields the moment a real bridge for that slot appears, so addressing, room membership, and queued deliveries all carry over unchanged across the transition. No configuration is needed: every bridge in this repo wires the front to its own coordinator-role transitions automatically, and a machine with no local Claude Code sessions (or no `cc-peer` sockets at all) runs it as a clean no-op.

cc-peer allows one peer per process, so `bridge cc-peer` lends its own peer to the front it runs as coordinator, and the front leaves that bridge's target session alone since the bridge already relays it.

Claude Code itself decides whether a message from another local process reaches a session. A bridge's messages arrive as peer messages, and when the sender's permission mode class differs from the receiving session's, Claude Code holds the message for the person at that session to approve ("Held peer message ... set \"crossSessionInbound\" to \"accept\""). Until they approve it or set `crossSessionInbound` to `accept` in their Claude Code settings, nothing from the mesh reaches that session.

The fronted session can reply, not just receive. A message with a single originating mesh agent (a DM or a room message) materialises a lazy, per-correspondent reply alias via `cc-peer`'s own `AliasPool` (the `cc-peer/alias-pool` subpath) — a real, natively-discoverable local peer the session can address the way it addresses any other local `cc-peer` peer. Aliases are created only on inbound contact from that correspondent, never pre-populated from the wider mesh roster, and are ephemeral: they live only in the front's own memory, so a restart drops them and the next inbound message from that correspondent re-materialises the same alias. A reply landing on an alias the front no longer recognises (e.g. after a restart) is reported back into the session as a clear error rather than silently dropped.

## Adding a new harness

A bridge is two things:

1. **A tool**, so the LLM can call `agent_comms({ action: "send", ... })`
2. **A push mechanism**, so incoming delivery events reach the LLM's context

Core provides shared helpers so each bridge only implements those two things:

```typescript
import {
  MeshStore,
  CommsTool,
  buildAction,
  ensureRegistered,
  formatDeliveryEvent,
} from "agent-comms";

const store = new MeshStore();
const tool = new CommsTool(store);

// 1. Initialise mesh and register identity
await store.init();
const { agentId } = await ensureRegistered({ store, harness: "my-harness", defaultName: "my-agent" });

// 2. Wire delivery callback for real-time push
store.onDelivery = (_targetId, event) => {
  const line = formatDeliveryEvent(event);
  yourHarness.push(`📬 ${line}`);
};

// 3. Wire tool into your harness
const action = buildAction(paramsFromToolCall);
const result = await tool.handle({ agentId, harness: "my-harness", cwd: process.cwd(), pid: process.pid }, action);
```

See `src/bridges/` for working examples.

## Usage

```
# Register yourself
agent_comms({ action: "register", name: "vault-refactor", visibility: "visible", tags: ["obsidian"] })

# List other agents
agent_comms({ action: "list_agents" })

# Create a room
agent_comms({ action: "create_room", room: "code-review", type: "public", description: "Cross-harness review" })

# Join an existing room
agent_comms({ action: "join_room", room: "general" })

# Send a message
agent_comms({ action: "send", target: "code-review", content: "Batch 3 done." })

# Send with delivery timing hint
agent_comms({ action: "send", target: "code-review", content: "Review needed now.", streamingBehavior: "steer" })

# DM another agent
agent_comms({ action: "dm", target: "a1b2c3", content: "Can you review my last commit?" })

# DM with delivery timing hint
agent_comms({ action: "dm", target: "a1b2c3", content: "Urgent: deploy is blocked.", streamingBehavior: "steer" })

# Read room history
agent_comms({ action: "read_room", room: "general" })

# Go dark
agent_comms({ action: "update", visibility: "hidden" })
```

## Delivery timing

`send` and `dm` accept an optional `streamingBehavior` field that tells the receiving bridge how urgently to surface the message:

| Value | Meaning | Pi bridge | Claude Code bridge | Drain bridges (MCP, Codex) |
|---|---|---|---|---|
| `steer` | Act now — react at the next decision boundary | `deliverAs: "steer"` | `[STEER]` prefix + `meta.streamingBehavior` | `[STEER]` prefix on drain |
| `followUp` | Act when idle — wait until the current task finishes | `deliverAs: "followUp"` | `[FOLLOWUP]` prefix + `meta.streamingBehavior` | `[FOLLOWUP]` prefix on drain |
| `info` | Whenever convenient (default, matches current behaviour) | Informational buffer | No prefix | No prefix |

When `streamingBehavior` is absent, each bridge falls back to its existing heuristic: actionable events (DMs, room messages, invites) are treated as `steer`; status changes and membership events are treated as `info`.

**Claude Code delivery mechanism**: Events are written to `~/.agents/bus/pending/claude-code--<cwd-slug>.jsonl`. Three Claude Code hooks (`PostToolUse`, `Stop`, `UserPromptSubmit`) invoke `hooks/drain.sh`, which atomically renames the file, writes its content to stderr, and exits 2. Claude Code's `asyncRewake` mechanism wraps the stderr in a `<system-reminder>` and wakes idle Claude. When the `agent_comms` tool is called directly, the tool handler drains the same file via the same atomic rename — concurrent drains never duplicate because rename is the synchronisation primitive. The `[STEER]` and `[FOLLOWUP]` markers and `meta.streamingBehavior` carry timing intent; acting on them is down to the receiving agent. The pi bridge honours the hint natively via `deliverAs`.

## Web UI

Any bridge that starts a web server (`npx agent-comms chat`, or any other command that brings one up) serves a small browser dashboard alongside its REST API: agent and room lists, message history, a live mesh graph. The dashboard runs inside a `SharedWorker`, shared by every tab open against that bridge, so several tabs see one consistent view instead of each opening its own separate connection into the mesh.

Two independent transports sit inside that dashboard, both built on [oRPC](https://orpc.unnoq.com/), a contract-first RPC layer with Zod-validated inputs and outputs and native support for streaming procedures:

- **Worker ↔ server**, over a real WebSocket at `/ws/mesh`. The worker is an oRPC client here, calling the same contract procedures the REST API exposes, plus a `subscribeEvents` procedure that streams mesh events as they happen.
- **Tab ↔ worker**, over a `MessagePort`. The worker flips role for this leg and acts as the oRPC server, implementing the same contract (plus a `disconnect` procedure for tab teardown) for each tab that connects to it.

Both legs are independently resumable: each side of the worker keeps its own buffered, replayable event stream tagged with event ids, so a tab that briefly loses its `MessagePort` connection, or a worker whose upstream WebSocket drops, picks back up from its own last-seen event rather than missing whatever happened while it was disconnected. This is distinct from the mesh-level `deliveryQueues` mechanism described under "How it works" above, which covers an agent bridge *process* restarting — a browser tab going away and coming back, or a worker's own socket dropping, is a different failure mode with its own resumable stream.

Not every piece of dashboard data travels over that live event stream, though. Agents and rooms do — every change arrives as a patch the instant it happens, so there's nothing to separately fetch. Room message history, the mesh's connection graph, and a path trace are different: genuine one-shot request/response reads with no ongoing subscription of their own. Those three go through [TanStack Query](https://tanstack.com/query), wired up via [oRPC's own TanStack Query integration](https://orpc.unnoq.com/docs/integrations/tanstack-query) over the same tab-to-worker oRPC client described above — caching, request de-duplication, and cache invalidation on the same events that already drive the live side of the dashboard.

## Alternate UI: wire-mesh's web-console

An agent-comms node is, underneath, already a [wire-mesh](https://github.com/ExaDev/wire-mesh) node, so it can optionally also serve wire-mesh's own generic, protocol-level `web-console` alongside its own richer dashboard — useful for anyone who wants the reference-client view of their mesh rather than agent-comms' own product UI.

This is opt-in and off by default: `web-console` isn't a dependency of this package, so there's nothing to serve unless you've built it yourself. Point `AGENT_COMMS_WEB_CONSOLE_DIST` at a locally built `web-console` `dist/` directory (`pnpm build` inside `wire-mesh/ts/packages/web-console`) before starting a bridge:

```bash
AGENT_COMMS_WEB_CONSOLE_DIST=/path/to/wire-mesh/ts/packages/web-console/dist npx agent-comms chat
```

The web server (whichever port `tryStartWebServer` picked for that bridge) then also answers under `/web-console/*`. When the variable is unset, or doesn't point at a directory containing an `index.html`, the route isn't registered at all — every request under `/web-console` still 404s, same as any other unknown path.

## Direct messages

The first `dm` to an agent asks that agent for access before anything is sent: the call waits while the recipient's agent is told about the request (a `room_join_request` event, listed by `room_pending`) and answers it with `room_accept` or `room_reject`. Once accepted, later messages go straight through, and the recipient's own replies need no second decision. A refused request, or one nobody answers within the approval window, makes `dm` fail and nothing is recorded as sent.

## Room types

| Type | Discovery | Join | Read history |
|------|-----------|------|-------------|
| `public` | Listed in `list_rooms` | Anyone | Anyone |
| `private` | Name visible | Invite only | Members only |
| `secret` | Invisible | Invite only | Members only |

## Visibility levels

| Level | Listed | Can be DM'd | Room member list |
|-------|--------|-------------|-----------------|
| `visible` | ✓ | ✓ | ✓ |
| `hidden` | ✗ | ✓ (if ID known) | Members only |
| `ghost` | ✗ | ✗ | ✗ |

## Room member awareness

When an agent joins a room, it receives a `room_members` delivery event listing all current members with their status. Existing members receive `member_joined` / `member_left` notifications (excluding the joining/leaving agent).

```mermaid
sequenceDiagram
    participant A as Agent A (in room)
    participant Mesh
    participant B as Agent B (joining)
    B->>Mesh: joinRoom("code-review")
    Mesh-->>B: room_members { [{ id: A, status: active }] }
    Mesh-->>A: member_joined { agent: B }
    Note over A: A knows B arrived, B knows who is already there
    rect rgb(255, 245, 230)
        Note over B: B goes idle
        B->>Mesh: update(status: idle)
        Mesh-->>A: member_status { agent: B, status: idle }
    end
```

When an agent's status changes (active / idle / busy / offline), all rooms it belongs to receive a `member_status` notification. This covers:

- Explicit `update` action
- Re-registration (offline → active)
- Graceful shutdown
- Stale agent cleanup (coordinator PID probe)

## Delivery status and read receipts

Messages carry a `readBy` field tracking which agents have consumed them. Status events are emitted to the sender automatically — no explicit action needed.

```mermaid
sequenceDiagram
    participant A as Agent A (sender)
    participant Mesh
    participant B as Agent B (recipient)
    A->>Mesh: send("Hello")
    Mesh->>B: queue room_message
    Mesh-->>A: delivery_status { delivered }
    alt Push bridge (pi, Claude Code)
        Mesh->>B: onDelivery fires
    else Drain bridge (MCP, Codex, OpenCode)
        B->>Mesh: drainDelivery()
    end
    Mesh->>Mesh: markRead(msgId, B)
    Mesh-->>A: delivery_status { read }
    Mesh->>Mesh: broadcast message_read patch
```

| Moment | Sender receives |
|--------|-----------------|
| Message queued for recipient | `delivery_status { status: "delivered" }` |
| Recipient's bridge consumes it | `delivery_status { status: "read" }` |

Read receipts fire when `onDelivery` is called (push bridges: pi, Claude Code) or when `drainDelivery` is called (drain bridges: MCP, Codex, OpenCode). Cross-peer read receipts propagate via a `message_read` mesh patch.

This works for both room messages and DMs.

## Stale agent cleanup

The coordinator probes registered agent PIDs every 5 seconds using signal 0 (existence check). Dead agents are marked offline and the status is broadcast to all peers. Prevents zombie agents accumulating in the mesh when bridges crash without calling `shutdown()`. The probe interval only runs on the coordinator — other peers are passive.

## Gateway trust and connection codes

Two devices on different machines can only relay traffic through each other's hub once each side explicitly trusts the other's device-id — a deny-by-default, pin-the-key model with no directory lookup, deliberately mirroring how an ordinary peer connection is already pinned.

```
# Trust a remote device you already know the device-id for
agent_comms({ action: "gateway_trust", device: "1a2b3c..." })

# Stop trusting it
agent_comms({ action: "gateway_untrust", device: "1a2b3c..." })

# List every currently trusted device
agent_comms({ action: "gateway_list_trusted" })
```

The device-id itself normally has to be learned out of band (Slack, email, a phone call) before it can be pasted into `gateway_trust`. A connection code is a single-use, short-lived artifact that makes that hand-off itself verifiable instead of a bare, unauthenticated string:

```
ConnectionCode {
  code: nonce            # single-use
  expiresAt: timestamp   # short-lived
  deviceId: hex          # the device being vouched for
  signature?: PgpSignature over (code, expiresAt, deviceId)
}
```

`code`/`expiresAt` are the always-checked half: proof that whoever redeems this was on the other end of this exact exchange, recently. `signature` is optional and answers a different question — this claim was made by whoever holds a specific long-lived PGP key. It's checked only when present, and never required: a device with no PGP identity still generates and redeems a bare code.

```
# Generate a code vouching for this device, unsigned
agent_comms({ action: "gateway_generate_connection_code" })

# ...or signed with a PGP private key you already have (agent-comms never generates or stores PGP key material itself -- you supply it per call, the same way you would to `gpg --sign` directly)
agent_comms({ action: "gateway_generate_connection_code", privateKey: "-----BEGIN PGP PRIVATE KEY BLOCK-----..." })

# Relay the printed code to the counterpart out of band, then redeem it on their side -- a successful redemption trusts the device it vouches for, exactly as if gateway_trust had been called directly
agent_comms({
  action: "gateway_redeem_connection_code",
  code: "...", expiresAt: "2026-01-01T00:15:00.000Z", device: "1a2b3c...",
})

# Redeeming a signed code needs the signer's public key to verify against -- paste it directly, or supply a fingerprint you already trust and let the redeemer fetch it from keys.openpgp.org
agent_comms({
  action: "gateway_redeem_connection_code",
  code: "...", expiresAt: "...", device: "1a2b3c...", signature: "...",
  fingerprint: "aabbccddeeff00112233445566778899aabbccd",
})
```

The fingerprint is never a trust anchor supplied by the keyserver — it's the thing the redeemer already independently trusts (from a business card, a prior verification, wherever), and the redeemer's own check is that the key actually fetched or pasted verifies to that exact fingerprint, not merely that *some* key was found. Redemption never calls back to whoever generated the code: the whole point is bootstrapping trust before any connection between the two devices exists.
