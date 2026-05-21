# Changelog

## v1.0.0 (2026-04-27)

### Features

- add npm publishing config — entry points, exports, provenance, packageManager (8d87c31)
- add no-pointless-reassignments custom rule (3f49ba6)
- add setup CLI with harness auto-detection (c8fae13)
- add Codex and OpenCode bridges, extract shared helpers, make harness pluggable (489376b)
- add Codex and OpenCode bridges, fix types and deps (25c2d2e)
- add pi extension bridge with delivery watcher (c8ef78a)
- add Claude Code MCP channel server bridge (b20fd11)
- add barrel export for bus protocol, store, and tool (11b83c3)
- add BusAction tool handler with human-readable results (e0025f9)
- add filesystem-based bus store — agents, rooms, DMs, delivery (fd05a5e)
- add minimal nanoid utility using crypto.getRandomValues (c39d1f5)
- add bus protocol types — identity, rooms, messages, delivery events (5d33018)

### Bug Fixes

- remove MCP_TOOL_SCHEMA alias, add typebox dep, fix eslint config (cf1c335)
- resolve type errors — narrow undefined access, use Zod schema for MCP input (bb23867)
- resolve all ESLint errors (0 errors remaining) (1d863fc)
- copy cli.ts to temp dir for npx execution (174f297)
- add .js shim for npx compatibility (3abbbe1)

### Refactoring

- rename package from agent-bus to agent-comms (f513c22)
- move CLI to src/cli.ts, rename bin to bin.js (09e78ec)
- convert bin and stop hook to TypeScript, run via tsx (dd57267)
- make AgentIdentity.harness a plain string (64d41e2)

### Documentation

- use literal path placeholders in JSON/TOML configs (01595dc)
- replace hardcoded ~/Developer/agent-bus/ paths with $AGENT_BUS_DIR (fd2397d)
- remove project structure and implicit file paths from README (37d1a98)
- add README with symlinked AGENTS.md and CLAUDE.md (50dcdf9)

### Build

- update pnpm-lock.yaml (b823e41)
- add release.config.mjs — semantic-release configuration (552ea2a)
- add semantic-release with conventionalcommits preset (adbca55)
- pin Node 22 via .tool-versions (db2df31)
- initialise project scaffolding with TypeScript config (8d004c0)

### CI

- add GitHub Actions workflow — lint, typecheck, test, release (9f84539)

### Chores

- v1.0.0 [skip ci] (ee63d8e)
- add *.tgz to gitignore (f44e9a5)
- clean up stale .mcp.json from local testing (61b9e08)
- switch from npm to pnpm (59849ec)

### Other

-  (0eed337)

## v1.0.1 (2026-04-27)

### Bug Fixes

- remove registry-url from setup-node to allow OIDC trusted publishing (8f13fc9)

### Chores

- v1.0.1 [skip ci] (eed3341)

## v1.0.2 (2026-04-27)

### CI

- bump actions to latest — checkout@v5, pnpm@v5, setup-node@v6 (c284a35)

### Chores

- v1.0.2 [skip ci] (60522ef)

## v1.0.3 (2026-04-27)

### CI

- configure dependabot for npm and github-actions weekly updates (72fb7ce)

### Chores

- v1.0.3 [skip ci] (4af728b)

## v1.0.4 (2026-04-27)

### Bug Fixes

- add bun types to tsconfig to resolve lint errors (ef62e40)

### Build

- accept dependabot dep bumps and lockfile update (0dcc5b3)

### CI

- bump node to lts/24, add husky pre-push hook (8a036ea)

### Chores

- v1.0.4 [skip ci] (4895ea6)
- set 7-day minimum release age in project .npmrc (600f2cb)

## v1.0.5 (2026-04-27)

### Documentation

- update README install instructions for npm registry (1231709)

### Chores

- v1.0.5 [skip ci] (b3bc3f5)

## v1.0.6 (2026-04-27)

### Refactoring

- remove bin.js shim, use compiled dist/cli.js directly (3ba1752)

### Chores

- v1.0.6 [skip ci] (cccae6d)

## v1.0.7 (2026-04-27)

### Bug Fixes

- add shebang to dist/cli.js via build step (22b99d9)

### Chores

- v1.0.7 [skip ci] (8bdfe3d)

## v1.0.8 (2026-04-27)

### Bug Fixes

- handle missing .mcp.json when configuring Claude Code bridge (4dc967c)

### Chores

- v1.0.8 [skip ci] (d093610)

## v1.0.9 (2026-04-27)

### Refactoring

- replace bridge child process spawns with in-process static imports (c4bfa9f)

### Chores

- v1.0.9 [skip ci] (3b9731e)

## v1.0.10 (2026-04-27)

### Bug Fixes

- move @modelcontextprotocol/sdk to production dependencies (0a018db)

### Chores

- v1.0.10 [skip ci] (7838ea7)

## v1.0.11 (2026-04-27)

### Bug Fixes

- remove all stale agent-comms/agent-bus pi extension paths (a81bd7a)

### Chores

- v1.0.11 [skip ci] (551d10d)

## v1.0.12 (2026-04-27)

### Bug Fixes

- isolate agent identity per harness (fbded01)

### Chores

- v1.0.12 [skip ci] (8078469)

## v1.0.13 (2026-04-27)

### Bug Fixes

- isolate agent identity per harness and working directory (15585f8)

### Chores

- v1.0.13 [skip ci] (f07c4e1)

## v1.0.14 (2026-04-27)

### Bug Fixes

- deliver incoming messages as steering messages (465416c)

### Chores

- v1.0.14 [skip ci] (f4819e8)

## v1.1.0 (2026-04-27)

### Features

- add Codex PostToolUse hook for mid-turn message delivery (378805e)

### Chores

- v1.1.0 [skip ci] (683a6fa)

## v1.2.0 (2026-04-28)

### Features

- add stale agent cleanup via PID probing (coordinator) (3561bd7)
- persist MeshStore identity to disk for cross-restart recovery (de2ad42)
- wire MeshStore into all bridges, remove filesystem polling (c337e03)
- add generic MCP bridge for any MCP-compatible harness (addc0b5)
- add Claude Code marketplace manifest (81b911c)
- add Claude Code plugin manifest and pi package manifest (10a254e)

### Bug Fixes

- isolate test meshes on separate ports (eb6b407)
- make tests resilient to stale mesh state between runs (8d44fc6)
- merge state_sync instead of replacing — prevents losing local state (732b9a0)
- remove identity file persistence — incompatible with concurrent sessions (1164098)

### Refactoring

- move CommsError import to top of mesh-store.ts (6ee7fb0)
- remove Codex hooks — delivery now handled by MeshStore (c7ba9dc)
- rename Bus to Comms, extract interface, add TCP mesh store (bbfbacf)

### Documentation

- update README and package description for TCP mesh architecture (5600f08)
- document generic MCP bridge for any MCP-compatible harness (2e1d5f5)
- add marketplace setup to Claude Code install instructions (ad62cdb)
- fix pi and Claude Code install commands (257d517)
- add Claude Code and pi install instructions to README (dfa61a3)

### Tests

- add MeshStore end-to-end test (2256965)

### Chores

- v1.2.0 [skip ci] (67ef65d)
- update lockfile after dependency resolution (a253ae9)

## v1.3.0 (2026-04-28)

### Features

- room member awareness — join roster and status change notifications (2399f89)

### Chores

- v1.3.0 [skip ci] (72fffe0)

## v1.3.1 (2026-04-28)

### Documentation

- add motivation section, fix broken install path, improve punctuation (a57b465)

### Chores

- v1.3.1 [skip ci] (af1eaa8)

## v1.4.0 (2026-04-28)

### Features

- automatic delivery status and read receipts (b61e995)

### Chores

- v1.4.0 [skip ci] (260ab93)

## v1.4.1 (2026-04-28)

### Documentation

- add delivery status, read receipts, member awareness to README (d55928f)

### Chores

- v1.4.1 [skip ci] (cdf6345)

## v1.4.2 (2026-04-28)

### Documentation

- replace ASCII diagrams with Mermaid in README (97ecf78)

### Chores

- v1.4.2 [skip ci] (47a26d4)

## v1.4.3 (2026-04-28)

### Refactoring

- rename "bus" to "mesh" in package.json and plugin manifest (9954bbf)
- rename "bus" to "comms" in FileStore comments and default path (21f0894)
- rename "bus" to "mesh" in CLI, remove legacy "agent-bus" detection (9ea8934)
- rename "bus" to "mesh" in plugin marketplace manifest (7e03c89)
- rename "bus" to "mesh" in bridge tool descriptions (5c0807e)

### Chores

- v1.4.3 [skip ci] (ea78d75)

## v1.5.0 (2026-04-28)

### Features

- add user bridge — TUI, web UI, and non-interactive CLI (97ef406)

### Chores

- v1.5.0 [skip ci] (630c735)

## v1.6.0 (2026-04-28)

### Features

- auto-start web UI from every bridge (5c1af03)

### Chores

- v1.6.0 [skip ci] (3ff22db)

## v1.7.0 (2026-04-29)

### Features

- add decline_invite action with reason message (809a87f)
- richer formatDeliveryEvent for room invites (6f570f7)
- enrich room_invite event with room description, inviter name and cwd (2b5c3f0)
- show cwd and subscribed rooms in list_agents output (d260d10)
- expose cwd on AgentIdentity (1104da2)

### Styles

- fix prettier and eslint violations from pre-push hook (d6eabd1)

### Chores

- v1.7.0 [skip ci] (8d8d7e1)

## v1.8.0 (2026-05-08)

### Features

- use dynamic port, await controller init, return structured handle (48ae0b4)

### Bug Fixes

- shut down web server before bridge store on session end (a664b4b)
- track and destroy all TCP sockets on shutdown (4199447)

### Chores

- v1.8.0 [skip ci] (a42905a)

## v1.8.1 (2026-05-21)

### Refactoring

- replace custom banEslintDisable rule with noInlineConfig (30fc24b)

### Chores

- v1.8.1 [skip ci] (48c4dbc)
- add .pi/ to gitignore (1ca0e0d)

## v1.8.2 (2026-05-21)

### Bug Fixes

- add error listener to coordinator server sockets (833aeef)

### Tests

- coordinator survives ECONNRESET on accepted socket (2d8c34e)
- coordinator survives ECONNRESET on accepted socket (567a896)

### Chores

- v1.8.2 [skip ci] (2943174)

## v1.9.0 (2026-05-21)

### Features

- publish agent-comms to the MCP Registry (89c2a4a)

### Refactoring

- rename release config to TypeScript (a8c6eb7)

### Chores

- v1.9.0 [skip ci] (27b436a)

## v1.9.1 (2026-05-21)

### Bug Fixes

- correct MCP Registry name casing to io.github.ExaDev (d788fe0)

### Chores

- v1.9.1 [skip ci] (ef7f93d)
