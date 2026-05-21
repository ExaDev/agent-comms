## [1.12.0](https://github.com/ExaDev/agent-comms/compare/v1.11.0...v1.12.0) (2026-05-21)

### Features

* add commitlint and lint-staged ([020fbdf](https://github.com/ExaDev/agent-comms/commit/020fbdf46115b99ff8e5b2c711f5156229e0446d))

## [1.11.0](https://github.com/ExaDev/agent-comms/compare/v1.10.2...v1.11.0) (2026-05-21)

### Features

* bump README version badge on release ([73bea55](https://github.com/ExaDev/agent-comms/commit/73bea55d18b6e4cd7eb26d5b823e73bb247cde30))

### Documentation

* add badges to README ([4d640f9](https://github.com/ExaDev/agent-comms/commit/4d640f9f7f41788c7200d32b00622f9c4941b538))

### Styles

* fix prettier formatting in sync-release-metadata ([33140fd](https://github.com/ExaDev/agent-comms/commit/33140fde2ebffc129b864c19b96a380888343da3))

## [1.10.2](https://github.com/ExaDev/agent-comms/compare/v1.10.1...v1.10.2) (2026-05-21)

### Chores

* filter release commits from CHANGELOG.md ([6513495](https://github.com/ExaDev/agent-comms/commit/6513495bde7f1a6d29abf8bf24fbad2979ab2fd6))

## [1.0.0](https://github.com/ExaDev/agent-comms/releases/tag/v1.0.0) (2026-04-27)

### Features

* add npm publishing config — entry points, exports, provenance, packageManager ([8d87c31](https://github.com/ExaDev/agent-comms/commit/8d87c3102aa378756ef60ad1aafa19efcc06df54))
* add no-pointless-reassignments custom rule ([3f49ba6](https://github.com/ExaDev/agent-comms/commit/3f49ba6e6406edc4f8d3951b43f8f75642fdb192))
* add setup CLI with harness auto-detection ([c8fae13](https://github.com/ExaDev/agent-comms/commit/c8fae1315efe1e4718850ded09b3533cd4383a00))
* add Codex and OpenCode bridges, extract shared helpers, make harness pluggable ([489376b](https://github.com/ExaDev/agent-comms/commit/489376bf7801ba51d8f289d5572c846edac4df97))
* add Codex and OpenCode bridges, fix types and deps ([25c2d2e](https://github.com/ExaDev/agent-comms/commit/25c2d2ea746c2409dbfe9ac227a9ac23c9a39b6e))
* add pi extension bridge with delivery watcher ([c8ef78a](https://github.com/ExaDev/agent-comms/commit/c8ef78a13087c92a321ea5c22afed5686437b690))
* add Claude Code MCP channel server bridge ([b20fd11](https://github.com/ExaDev/agent-comms/commit/b20fd11c1d0ac99c258cab4b907ca29a4a5e356c))
* add barrel export for bus protocol, store, and tool ([11b83c3](https://github.com/ExaDev/agent-comms/commit/11b83c3146ddd2997cae9134fcf69d3df83a0c60))
* add BusAction tool handler with human-readable results ([e0025f9](https://github.com/ExaDev/agent-comms/commit/e0025f962ef3ebee074a582c85952dae7b750bde))
* add filesystem-based bus store — agents, rooms, DMs, delivery ([fd05a5e](https://github.com/ExaDev/agent-comms/commit/fd05a5e721090572872d35d7f343896442c3a658))
* add minimal nanoid utility using crypto.getRandomValues ([c39d1f5](https://github.com/ExaDev/agent-comms/commit/c39d1f51f84ee134957fc7b7f88679b9ae029055))
* add bus protocol types — identity, rooms, messages, delivery events ([5d33018](https://github.com/ExaDev/agent-comms/commit/5d330189d0da922ad44f6fb67afebb048385a685))

### Bug Fixes

* remove MCP_TOOL_SCHEMA alias, add typebox dep, fix eslint config ([cf1c335](https://github.com/ExaDev/agent-comms/commit/cf1c335c3b2fd4219ebcb244d4f452a05bc4b2f4))
* resolve type errors — narrow undefined access, use Zod schema for MCP input ([bb23867](https://github.com/ExaDev/agent-comms/commit/bb23867be30382b5f0522a59d5bc09a01ce34398))
* resolve all ESLint errors (0 errors remaining) ([1d863fc](https://github.com/ExaDev/agent-comms/commit/1d863fc988c56e9a85e3a7f0c1c1fb8d299eac91))
* copy cli.ts to temp dir for npx execution ([174f297](https://github.com/ExaDev/agent-comms/commit/174f29797693018f535e379dfb84f9099e78a929))
* add .js shim for npx compatibility ([3abbbe1](https://github.com/ExaDev/agent-comms/commit/3abbbe14269f46cbff55e3c7e2ce3b41fb1d557b))

### Refactoring

* rename package from agent-bus to agent-comms ([f513c22](https://github.com/ExaDev/agent-comms/commit/f513c22a6ffacedc3b9db3846b822be89058e34d))
* move CLI to src/cli.ts, rename bin to bin.js ([09e78ec](https://github.com/ExaDev/agent-comms/commit/09e78ecc2206f4896df69a3dd78c762a2ea6c9e1))
* convert bin and stop hook to TypeScript, run via tsx ([dd57267](https://github.com/ExaDev/agent-comms/commit/dd57267bfc190e0616486fffd2ace72bc5239095))
* make AgentIdentity.harness a plain string ([64d41e2](https://github.com/ExaDev/agent-comms/commit/64d41e2865f48e4ee70a6a0cb2d44b7196e0af01))

### Documentation

* use literal path placeholders in JSON/TOML configs ([01595dc](https://github.com/ExaDev/agent-comms/commit/01595dca1bdcfd9b54ec720041d870a8e2a4c2f0))
* replace hardcoded ~/Developer/agent-bus/ paths with $AGENT_BUS_DIR ([fd2397d](https://github.com/ExaDev/agent-comms/commit/fd2397da890e06f26462d684dc5305f331fad5f9))
* remove project structure and implicit file paths from README ([37d1a98](https://github.com/ExaDev/agent-comms/commit/37d1a989720886846779ae271274c3b12bd66367))
* add README with symlinked AGENTS.md and CLAUDE.md ([50dcdf9](https://github.com/ExaDev/agent-comms/commit/50dcdf9ebbe47df623000e5498417b67d6dd9009))

### Build

* update pnpm-lock.yaml ([b823e41](https://github.com/ExaDev/agent-comms/commit/b823e415ca14ea4bfaf653ff4d29c2d073bbe143))
* add release.config.mjs — semantic-release configuration ([552ea2a](https://github.com/ExaDev/agent-comms/commit/552ea2a86c3725c0bcbc2b6cc585504347349591))
* add semantic-release with conventionalcommits preset ([adbca55](https://github.com/ExaDev/agent-comms/commit/adbca55abd2e8bf2b55f4beb5ef4762169782eaa))
* pin Node 22 via .tool-versions ([db2df31](https://github.com/ExaDev/agent-comms/commit/db2df31f3479283ddf89d65243c841312d11d226))
* initialise project scaffolding with TypeScript config ([8d004c0](https://github.com/ExaDev/agent-comms/commit/8d004c006ea00526cc5cd4f26aaa63c65c87dd9a))

### CI

* add GitHub Actions workflow — lint, typecheck, test, release ([9f84539](https://github.com/ExaDev/agent-comms/commit/9f84539529e3e1bc89b307e9fbbbdfc3e2e31d7a))

### Chores

* add *.tgz to gitignore ([f44e9a5](https://github.com/ExaDev/agent-comms/commit/f44e9a5ba34e35974452222d6c8207b3cb1636b3))
* clean up stale .mcp.json from local testing ([61b9e08](https://github.com/ExaDev/agent-comms/commit/61b9e08b3abb5b8ea17a779518ad730b60acb23a))
* switch from npm to pnpm ([59849ec](https://github.com/ExaDev/agent-comms/commit/59849ec7d4686aa7094a664e5ed5ae658ec3f0df))

### Other

*  ([0eed337](https://github.com/ExaDev/agent-comms/commit/0eed33701f2a626d1d34ed28c233f43620eb5f9a))

## [1.0.1](https://github.com/ExaDev/agent-comms/compare/v1.0.0...v1.0.1) (2026-04-27)

### Bug Fixes

* remove registry-url from setup-node to allow OIDC trusted publishing ([8f13fc9](https://github.com/ExaDev/agent-comms/commit/8f13fc919aa2074f412465ce66b823bd22967229))

## [1.0.2](https://github.com/ExaDev/agent-comms/compare/v1.0.1...v1.0.2) (2026-04-27)

### CI

* bump actions to latest — checkout@v5, pnpm@v5, setup-node@v6 ([c284a35](https://github.com/ExaDev/agent-comms/commit/c284a35903f9ce8c859ce343109fe565340e2d3d))

## [1.0.3](https://github.com/ExaDev/agent-comms/compare/v1.0.2...v1.0.3) (2026-04-27)

### CI

* configure dependabot for npm and github-actions weekly updates ([72fb7ce](https://github.com/ExaDev/agent-comms/commit/72fb7ce8d3cc409e7beeb6ee584cbd27c51dddf5))

## [1.0.4](https://github.com/ExaDev/agent-comms/compare/v1.0.3...v1.0.4) (2026-04-27)

### Bug Fixes

* add bun types to tsconfig to resolve lint errors ([ef62e40](https://github.com/ExaDev/agent-comms/commit/ef62e402c7090dd4fc1da7c3f4887528a2e7091f))

### Build

* accept dependabot dep bumps and lockfile update ([0dcc5b3](https://github.com/ExaDev/agent-comms/commit/0dcc5b309bb6d728e4fe880d6a1f94618c5e9063))

### CI

* bump node to lts/24, add husky pre-push hook ([8a036ea](https://github.com/ExaDev/agent-comms/commit/8a036ea4f946acc34db7c38c73528284378d7899))

### Chores

* set 7-day minimum release age in project .npmrc ([600f2cb](https://github.com/ExaDev/agent-comms/commit/600f2cbd854a565e82ed544bee52b821789d6950))

## [1.0.5](https://github.com/ExaDev/agent-comms/compare/v1.0.4...v1.0.5) (2026-04-27)

### Documentation

* update README install instructions for npm registry ([1231709](https://github.com/ExaDev/agent-comms/commit/1231709ab5b0591c40650c2f51e23eb4a678b087))

## [1.0.6](https://github.com/ExaDev/agent-comms/compare/v1.0.5...v1.0.6) (2026-04-27)

### Refactoring

* remove bin.js shim, use compiled dist/cli.js directly ([3ba1752](https://github.com/ExaDev/agent-comms/commit/3ba17522b6fcee9e63fb25c32af4cd60f15015e3))

## [1.0.7](https://github.com/ExaDev/agent-comms/compare/v1.0.6...v1.0.7) (2026-04-27)

### Bug Fixes

* add shebang to dist/cli.js via build step ([22b99d9](https://github.com/ExaDev/agent-comms/commit/22b99d99fe933231f2c9e3025b203873696c7c2b))

## [1.0.8](https://github.com/ExaDev/agent-comms/compare/v1.0.7...v1.0.8) (2026-04-27)

### Bug Fixes

* handle missing .mcp.json when configuring Claude Code bridge ([4dc967c](https://github.com/ExaDev/agent-comms/commit/4dc967c6be0f9548ab39a3ae88dbfdea8ab4e5a3))

## [1.0.9](https://github.com/ExaDev/agent-comms/compare/v1.0.8...v1.0.9) (2026-04-27)

### Refactoring

* replace bridge child process spawns with in-process static imports ([c4bfa9f](https://github.com/ExaDev/agent-comms/commit/c4bfa9f820534755d9954597bfc68527f963c0d8))

## [1.0.10](https://github.com/ExaDev/agent-comms/compare/v1.0.9...v1.0.10) (2026-04-27)

### Bug Fixes

* move @modelcontextprotocol/sdk to production dependencies ([0a018db](https://github.com/ExaDev/agent-comms/commit/0a018db32ad0c0b40bbcc693b2fc3a48fe3a8b9c))

## [1.0.11](https://github.com/ExaDev/agent-comms/compare/v1.0.10...v1.0.11) (2026-04-27)

### Bug Fixes

* remove all stale agent-comms/agent-bus pi extension paths ([a81bd7a](https://github.com/ExaDev/agent-comms/commit/a81bd7a84e6eedb26bac45678c33745e8d7a8a2e))

## [1.0.12](https://github.com/ExaDev/agent-comms/compare/v1.0.11...v1.0.12) (2026-04-27)

### Bug Fixes

* isolate agent identity per harness ([fbded01](https://github.com/ExaDev/agent-comms/commit/fbded01f161e04c3a76db622a7c2f2554127cf16))

## [1.0.13](https://github.com/ExaDev/agent-comms/compare/v1.0.12...v1.0.13) (2026-04-27)

### Bug Fixes

* isolate agent identity per harness and working directory ([15585f8](https://github.com/ExaDev/agent-comms/commit/15585f8f0500d7e0625a9b49f21f4d18b486942d))

## [1.0.14](https://github.com/ExaDev/agent-comms/compare/v1.0.13...v1.0.14) (2026-04-27)

### Bug Fixes

* deliver incoming messages as steering messages ([465416c](https://github.com/ExaDev/agent-comms/commit/465416c54e9ca9b053761e9e4bcc1fbdcfc42124))

## [1.1.0](https://github.com/ExaDev/agent-comms/compare/v1.0.14...v1.1.0) (2026-04-27)

### Features

* add Codex PostToolUse hook for mid-turn message delivery ([378805e](https://github.com/ExaDev/agent-comms/commit/378805e90eb57e5b667bd54a125978a08188d32d))

## [1.2.0](https://github.com/ExaDev/agent-comms/compare/v1.1.0...v1.2.0) (2026-04-28)

### Features

* add stale agent cleanup via PID probing (coordinator) ([3561bd7](https://github.com/ExaDev/agent-comms/commit/3561bd7027b40e6b079c67891c0d6f22f96d7414))
* persist MeshStore identity to disk for cross-restart recovery ([de2ad42](https://github.com/ExaDev/agent-comms/commit/de2ad423de89677c5fe45ce5ebef1bec795d55a6))
* wire MeshStore into all bridges, remove filesystem polling ([c337e03](https://github.com/ExaDev/agent-comms/commit/c337e0328355144efa7ea03e14c0c8518be3af60))
* add generic MCP bridge for any MCP-compatible harness ([addc0b5](https://github.com/ExaDev/agent-comms/commit/addc0b5fc3282531827eaab7e997c58254680013))
* add Claude Code marketplace manifest ([81b911c](https://github.com/ExaDev/agent-comms/commit/81b911cc32e914b71afc070de81a295c65b4f9d5))
* add Claude Code plugin manifest and pi package manifest ([10a254e](https://github.com/ExaDev/agent-comms/commit/10a254ee32f9d5ce46f51705a9621399105dc0f7))

### Bug Fixes

* isolate test meshes on separate ports ([eb6b407](https://github.com/ExaDev/agent-comms/commit/eb6b4076256b23370c263e284fcef42a44dac9f7))
* make tests resilient to stale mesh state between runs ([8d44fc6](https://github.com/ExaDev/agent-comms/commit/8d44fc69dc0f7cb6773d76b5962634d810c1dc01))
* merge state_sync instead of replacing — prevents losing local state ([732b9a0](https://github.com/ExaDev/agent-comms/commit/732b9a023ec9d26dd48c43fd4db83609f9a46b88))
* remove identity file persistence — incompatible with concurrent sessions ([1164098](https://github.com/ExaDev/agent-comms/commit/11640986d28dd498502c60139706d49aa8157d82))

### Refactoring

* move CommsError import to top of mesh-store.ts ([6ee7fb0](https://github.com/ExaDev/agent-comms/commit/6ee7fb0c88938e40a0a1c21dcb965e746afa7d63))
* remove Codex hooks — delivery now handled by MeshStore ([c7ba9dc](https://github.com/ExaDev/agent-comms/commit/c7ba9dc45068515a63e57c7c288ad86f0d4e55d0))
* rename Bus to Comms, extract interface, add TCP mesh store ([bbfbacf](https://github.com/ExaDev/agent-comms/commit/bbfbacfefab8032b9937b4eae4d3fff904bfcaf2))

### Documentation

* update README and package description for TCP mesh architecture ([5600f08](https://github.com/ExaDev/agent-comms/commit/5600f08e4c16bfe157a357840f35e09a941c0f04))
* document generic MCP bridge for any MCP-compatible harness ([2e1d5f5](https://github.com/ExaDev/agent-comms/commit/2e1d5f51bb16c6ccc62351398fb515b5a0d7db94))
* add marketplace setup to Claude Code install instructions ([ad62cdb](https://github.com/ExaDev/agent-comms/commit/ad62cdb7cef163b99b0cc7986036a82fe5209318))
* fix pi and Claude Code install commands ([257d517](https://github.com/ExaDev/agent-comms/commit/257d5173fb0d2b9127c773c05428615c9ad1c60a))
* add Claude Code and pi install instructions to README ([dfa61a3](https://github.com/ExaDev/agent-comms/commit/dfa61a3d8ed0e192413f89d291431798eb9ddc66))

### Tests

* add MeshStore end-to-end test ([2256965](https://github.com/ExaDev/agent-comms/commit/2256965f0ec0f98b55e853949b59ba821daab354))

### Chores

* update lockfile after dependency resolution ([a253ae9](https://github.com/ExaDev/agent-comms/commit/a253ae9a6c6905d2a21c027b0fe793c6bab72582))

## [1.3.0](https://github.com/ExaDev/agent-comms/compare/v1.2.0...v1.3.0) (2026-04-28)

### Features

* room member awareness — join roster and status change notifications ([2399f89](https://github.com/ExaDev/agent-comms/commit/2399f89408d361cb46eace37d7c4ca72676262e8))

## [1.3.1](https://github.com/ExaDev/agent-comms/compare/v1.3.0...v1.3.1) (2026-04-28)

### Documentation

* add motivation section, fix broken install path, improve punctuation ([a57b465](https://github.com/ExaDev/agent-comms/commit/a57b4658a2828b8a7889da908b2199368883038c))

## [1.4.0](https://github.com/ExaDev/agent-comms/compare/v1.3.1...v1.4.0) (2026-04-28)

### Features

* automatic delivery status and read receipts ([b61e995](https://github.com/ExaDev/agent-comms/commit/b61e995a641e67117ea690d58f489dc3e51162c5))

## [1.4.1](https://github.com/ExaDev/agent-comms/compare/v1.4.0...v1.4.1) (2026-04-28)

### Documentation

* add delivery status, read receipts, member awareness to README ([d55928f](https://github.com/ExaDev/agent-comms/commit/d55928fd2fb4fb3d37d4e0eaf5c690c608f76fa5))

## [1.4.2](https://github.com/ExaDev/agent-comms/compare/v1.4.1...v1.4.2) (2026-04-28)

### Documentation

* replace ASCII diagrams with Mermaid in README ([97ecf78](https://github.com/ExaDev/agent-comms/commit/97ecf78f9761d020a7f64ce4e10daf161036887a))

## [1.4.3](https://github.com/ExaDev/agent-comms/compare/v1.4.2...v1.4.3) (2026-04-28)

### Refactoring

* rename "bus" to "mesh" in package.json and plugin manifest ([9954bbf](https://github.com/ExaDev/agent-comms/commit/9954bbf77e57db32462b180c2be17d7828746fab))
* rename "bus" to "comms" in FileStore comments and default path ([21f0894](https://github.com/ExaDev/agent-comms/commit/21f089490b271da2429990216dd986990b936d81))
* rename "bus" to "mesh" in CLI, remove legacy "agent-bus" detection ([9ea8934](https://github.com/ExaDev/agent-comms/commit/9ea8934ff4e1b4c2c5005dca74ae52bdf007753f))
* rename "bus" to "mesh" in plugin marketplace manifest ([7e03c89](https://github.com/ExaDev/agent-comms/commit/7e03c89aed1ca39227c885cac10a4232243a2fe6))
* rename "bus" to "mesh" in bridge tool descriptions ([5c0807e](https://github.com/ExaDev/agent-comms/commit/5c0807ec4d19794f9aee4a64fa43cafe4e521f97))

## [1.5.0](https://github.com/ExaDev/agent-comms/compare/v1.4.3...v1.5.0) (2026-04-28)

### Features

* add user bridge — TUI, web UI, and non-interactive CLI ([97ef406](https://github.com/ExaDev/agent-comms/commit/97ef4067c8f43d7996396cacd5d04178fb0a3379))

## [1.6.0](https://github.com/ExaDev/agent-comms/compare/v1.5.0...v1.6.0) (2026-04-28)

### Features

* auto-start web UI from every bridge ([5c1af03](https://github.com/ExaDev/agent-comms/commit/5c1af036228b277539b18eb3cb8986d5ab20eeb7))

## [1.7.0](https://github.com/ExaDev/agent-comms/compare/v1.6.0...v1.7.0) (2026-04-29)

### Features

* add decline_invite action with reason message ([809a87f](https://github.com/ExaDev/agent-comms/commit/809a87f36bf797079e77b314596c3d99a0d90160))
* richer formatDeliveryEvent for room invites ([6f570f7](https://github.com/ExaDev/agent-comms/commit/6f570f7d95cfca48362d4397ed37f11f95fe03b4))
* enrich room_invite event with room description, inviter name and cwd ([2b5c3f0](https://github.com/ExaDev/agent-comms/commit/2b5c3f037e3128808e57703ae826b371ecfb8fd2))
* show cwd and subscribed rooms in list_agents output ([d260d10](https://github.com/ExaDev/agent-comms/commit/d260d1025a5c04b61f070e726e32ab4c85b154ec))
* expose cwd on AgentIdentity ([1104da2](https://github.com/ExaDev/agent-comms/commit/1104da23a6bbacad6bcdca03d96dd65ee092ecce))

### Styles

* fix prettier and eslint violations from pre-push hook ([d6eabd1](https://github.com/ExaDev/agent-comms/commit/d6eabd1926b17ec43d26173485de45950180d7a5))

## [1.8.0](https://github.com/ExaDev/agent-comms/compare/v1.7.0...v1.8.0) (2026-05-08)

### Features

* use dynamic port, await controller init, return structured handle ([48ae0b4](https://github.com/ExaDev/agent-comms/commit/48ae0b414f4f3ef2f1387a12d542242fba55b19c))

### Bug Fixes

* shut down web server before bridge store on session end ([a664b4b](https://github.com/ExaDev/agent-comms/commit/a664b4bfad75a834ff9b3fdf0b9deff48364ab66))
* track and destroy all TCP sockets on shutdown ([4199447](https://github.com/ExaDev/agent-comms/commit/419944705e9bd4badceaa5781dcdc8c754f644bd))

## [1.8.1](https://github.com/ExaDev/agent-comms/compare/v1.8.0...v1.8.1) (2026-05-21)

### Refactoring

* replace custom banEslintDisable rule with noInlineConfig ([30fc24b](https://github.com/ExaDev/agent-comms/commit/30fc24b9d760e7fca0ae3627a8f3d9f453ab5640))

### Chores

* add .pi/ to gitignore ([1ca0e0d](https://github.com/ExaDev/agent-comms/commit/1ca0e0d56e9f9b40ac4f7dd127c8e12220736bbe))

## [1.8.2](https://github.com/ExaDev/agent-comms/compare/v1.8.1...v1.8.2) (2026-05-21)

### Bug Fixes

* add error listener to coordinator server sockets ([833aeef](https://github.com/ExaDev/agent-comms/commit/833aeef17e58d8d72e1a25ac8054b2bfaf0e09ef))

### Tests

* coordinator survives ECONNRESET on accepted socket ([2d8c34e](https://github.com/ExaDev/agent-comms/commit/2d8c34eaec14c1e400a83f9dc991a6d02781d32f))
* coordinator survives ECONNRESET on accepted socket ([567a896](https://github.com/ExaDev/agent-comms/commit/567a8961c4f8dc8fd87475d7aee5b97dd3135182))

## [1.9.0](https://github.com/ExaDev/agent-comms/compare/v1.8.2...v1.9.0) (2026-05-21)

### Features

* publish agent-comms to the MCP Registry ([89c2a4a](https://github.com/ExaDev/agent-comms/commit/89c2a4aa075da0123c2e18d302994e7ceab0ba32))

### Refactoring

* rename release config to TypeScript ([a8c6eb7](https://github.com/ExaDev/agent-comms/commit/a8c6eb711d39cbc61ab06b8f424c2b8fc2598c19))

## [1.9.1](https://github.com/ExaDev/agent-comms/compare/v1.9.0...v1.9.1) (2026-05-21)

### Bug Fixes

* correct MCP Registry name casing to io.github.ExaDev ([d788fe0](https://github.com/ExaDev/agent-comms/commit/d788fe05fc84c70f486fc6975e58e8493edf20c2))

## [1.10.0](https://github.com/ExaDev/agent-comms/compare/v1.9.1...v1.10.0) (2026-05-21)

### Features

* add changelog generation to release pipeline ([76038ac](https://github.com/ExaDev/agent-comms/commit/76038acad1cefcf417e4054bd98ff6f437348373))
* add changelog generation to release pipeline ([ea43920](https://github.com/ExaDev/agent-comms/commit/ea439200c38fbd5966472ac256030689a8aff4e9))

### Chores

* update pnpm-lock.yaml after adding @semantic-release/changelog ([c7bcb2c](https://github.com/ExaDev/agent-comms/commit/c7bcb2cc4d87dc6b7eb6f745abc67fe4c30fac57))

## [1.10.1](https://github.com/ExaDev/agent-comms/compare/v1.10.0...v1.10.1) (2026-05-21)

### Chores

* rewrite CHANGELOG.md to match semantic-release format ([f030208](https://github.com/ExaDev/agent-comms/commit/f0302089d00e7e8a37646f587b0a9497d31034a0))
