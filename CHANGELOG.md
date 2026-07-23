## [1.24.1](https://github.com/ExaDev/agent-comms/compare/v1.24.0...v1.24.1) (2026-07-23)

## [1.24.0](https://github.com/ExaDev/agent-comms/compare/v1.23.1...v1.24.0) (2026-06-06)

### Features

* **bridge:** clean up mesh state on Claude Code exit ([3088e00](https://github.com/ExaDev/agent-comms/commit/3088e00f3fb29f87a114601d9647d149bd8f7899))
* **core:** add hasCoordinatorConnection and onError to transport ([1133260](https://github.com/ExaDev/agent-comms/commit/1133260a5199195be82e7773c328bb2c6369925f))

### Bug Fixes

* **bridge:** adapt pi bridge to graceful mesh degradation ([5ba4e43](https://github.com/ExaDev/agent-comms/commit/5ba4e43451447d0c86cbf430aae2081ab5d81671))
* **mesh-store:** degrade gracefully when coordinator port is held by orphan ([d9303ff](https://github.com/ExaDev/agent-comms/commit/d9303ffe0ad30bce45ab040b6152af76a813604f))

## [1.23.1](https://github.com/ExaDev/agent-comms/compare/v1.23.0...v1.23.1) (2026-06-03)

### Refactoring

* **bridge:** use local tsx path instead of npx for claude-code bridge ([1629c8e](https://github.com/ExaDev/agent-comms/commit/1629c8e0d80c4a787ee48a173ea207d3f6ee220c))

## [1.23.0](https://github.com/ExaDev/agent-comms/compare/v1.22.0...v1.23.0) (2026-05-30)

### Features

* **cli:** add /agent-comms:agents slash command ([16ea3cc](https://github.com/ExaDev/agent-comms/commit/16ea3ccd1d3bc9fed5f19fa563a011779dbc2c5c))
* **cli:** add slash commands for agent-comms actions ([7522d9e](https://github.com/ExaDev/agent-comms/commit/7522d9eb4b463bfb299db0c544f6c0d588545d6a))

### Bug Fixes

* **bridge:** key pending file by Claude Code PID, not just cwd ([8ef9149](https://github.com/ExaDev/agent-comms/commit/8ef914923ec689e528e103ca6920bbb3d78ee1d9))
* **bridge:** use synchronous hooks for Stop and PostToolUse drain ([e5714fe](https://github.com/ExaDev/agent-comms/commit/e5714feba73c11d8ad03d019f5a8834eee86970d))
* **release:** sync marketplace.json version on release ([8d0e288](https://github.com/ExaDev/agent-comms/commit/8d0e28875dd2d721c396412152e6fe9c45e4d2f1))

## [1.22.0](https://github.com/ExaDev/agent-comms/compare/v1.21.2...v1.22.0) (2026-05-30)

### Features

* **bridge:** add asyncRewake hooks for idle-Claude delivery ([dacdeba](https://github.com/ExaDev/agent-comms/commit/dacdebae342cc98f03b2e2de0c5d2ca7bbf68b1f))

## [1.21.2](https://github.com/ExaDev/agent-comms/compare/v1.21.1...v1.21.2) (2026-05-30)

### Bug Fixes

* **bridge:** buffer all delivery events for idle-Claude fallback ([cb340fe](https://github.com/ExaDev/agent-comms/commit/cb340fe61a2bbc3054231f57aac51bfc840eeb51))

## [1.21.1](https://github.com/ExaDev/agent-comms/compare/v1.21.0...v1.21.1) (2026-05-30)

### Chores

* **deps:** upgrade direct deps and add overrides to clear audit warnings ([1712222](https://github.com/ExaDev/agent-comms/commit/1712222eb7ee973f32576ccac6c336d8c41327ac))

## [1.21.0](https://github.com/ExaDev/agent-comms/compare/v1.20.0...v1.21.0) (2026-05-30)

### Features

* **bridge:** reserve channel notifications for actionable events in Claude Code bridge ([ffe123d](https://github.com/ExaDev/agent-comms/commit/ffe123dd6ac0c870790d756c55aec6b9490e405e))

## [1.20.0](https://github.com/ExaDev/agent-comms/compare/v1.19.5...v1.20.0) (2026-05-30)

### Features

* **bridge:** populate meta.streamingBehavior on Claude Code channel notifications ([8f23cc3](https://github.com/ExaDev/agent-comms/commit/8f23cc3a2a76c7032410d41c8c271bc3bfcaa8be))
* **bridge:** use streamingBehavior hint to select deliverAs in pi bridge ([64be6af](https://github.com/ExaDev/agent-comms/commit/64be6af7c1dced2b4fb2af95111352bb37872947))
* **core:** add extractStreamingBehavior and delivery hint prefixes ([58dbc5b](https://github.com/ExaDev/agent-comms/commit/58dbc5b850a55fcfac310dc256f10d8934c30660))
* **core:** add StreamingBehavior type and extend message/action schemas ([0c288a4](https://github.com/ExaDev/agent-comms/commit/0c288a41a43db07b471275422ff5c663a64b8780))
* **core:** thread streamingBehavior through store and tool ([2481743](https://github.com/ExaDev/agent-comms/commit/248174327ec072f64efa52baf277c9f7543cc4e1))

### Documentation

* document streamingBehavior delivery timing field and per-bridge behaviour ([9551a2e](https://github.com/ExaDev/agent-comms/commit/9551a2e6252663f748c5f706b40d0611213165b4))

## [1.19.5](https://github.com/ExaDev/agent-comms/compare/v1.19.4...v1.19.5) (2026-05-27)

### Bug Fixes

* **bridge:** use OS-assigned port for auto-started web servers ([69d3624](https://github.com/ExaDev/agent-comms/commit/69d3624e2d5f5d66f7edb67fd022e1363c3dc0c3))

## [1.19.4](https://github.com/ExaDev/agent-comms/compare/v1.19.3...v1.19.4) (2026-05-27)

### Refactoring

* **bridge:** replace MeshStatePatch type assertion with type guard ([d54cbb5](https://github.com/ExaDev/agent-comms/commit/d54cbb5c026a381aa88fe974ee163990049e1a65))

## [1.19.3](https://github.com/ExaDev/agent-comms/compare/v1.19.2...v1.19.3) (2026-05-27)

### Bug Fixes

* **core:** remove spurious async from synchronous methods ([5c594e4](https://github.com/ExaDev/agent-comms/commit/5c594e4479b2caaeb020ff7423cb770dae5677b6))

## [1.19.2](https://github.com/ExaDev/agent-comms/compare/v1.19.1...v1.19.2) (2026-05-27)

### Bug Fixes

* **build:** restore build step in pre-push hook using direct node calls ([48ba490](https://github.com/ExaDev/agent-comms/commit/48ba49018fd1345ea61f70e7b45f78452e695188))

## [1.19.1](https://github.com/ExaDev/agent-comms/compare/v1.19.0...v1.19.1) (2026-05-27)

### Bug Fixes

* **core:** retry tls.createServer on intermittent OpenSSL ASN.1 race ([6af1d19](https://github.com/ExaDev/agent-comms/commit/6af1d19274456c73103e14f4bb108670e6f1546a))

## [1.19.0](https://github.com/ExaDev/agent-comms/compare/v1.18.0...v1.19.0) (2026-05-27)

### Features

* **bridge:** add E2E tests for PWA features ([ca5f322](https://github.com/ExaDev/agent-comms/commit/ca5f322235942475bca367304208e076a88368d4))
* **bridge:** add sidebar toggle with collapse/expand ([d8b2d47](https://github.com/ExaDev/agent-comms/commit/d8b2d471b8e3c418b1e9da4f127d95aa32bb9278)), closes [#sidebar-toggle](https://github.com/ExaDev/agent-comms/issues/sidebar-toggle)

### Bug Fixes

* **bridge:** relax SW activation check for headless Chromium ([87e5717](https://github.com/ExaDev/agent-comms/commit/87e57179982161871f4c5acd786df6807465cead))
* **bridge:** remove type assertions from PWA E2E test ([28d7819](https://github.com/ExaDev/agent-comms/commit/28d7819369c303258e1b95e636deb443e6bf7da8))
* **bridge:** simplify SW activation test to registration check ([6288265](https://github.com/ExaDev/agent-comms/commit/6288265d272ff9ab4150f75190e1d4df8bae84e8))
* **bridge:** verify SW activation without requiring controller claim ([9131dd5](https://github.com/ExaDev/agent-comms/commit/9131dd5676a9ae897b0001fccb733e492f329680))
* **bridge:** wait for SW controller after reload in PWA E2E test ([da99706](https://github.com/ExaDev/agent-comms/commit/da997067dd9e7dac179bdbd1822c063903486a2d))
* **build:** use direct node invocations in pre-push hook ([900b7c3](https://github.com/ExaDev/agent-comms/commit/900b7c3c059321e6d85014c60fcc080050565451))

### Styles

* **bridge:** apply eslint --fix formatting to PWA E2E test ([9a77db6](https://github.com/ExaDev/agent-comms/commit/9a77db67d4af3882b22ba46ac82ed4a6872d8135))

### Tests

* **bridge:** add E2E tests for deferred mesh connection and connect prompt ([1da3db4](https://github.com/ExaDev/agent-comms/commit/1da3db46b5c921d012b006ea352ea31c9d064cf4))
* **bridge:** add E2E tests for web UI interactions ([90a437f](https://github.com/ExaDev/agent-comms/commit/90a437f747040972e3e63be76e9f1f43d341be89))

### Chores

* **build:** simplify pre-push hook to avoid submodule deadlocks ([6eddd38](https://github.com/ExaDev/agent-comms/commit/6eddd383ea5a9249b65ca6be335294138705b4b1))

## [1.18.0](https://github.com/ExaDev/agent-comms/compare/v1.17.1...v1.18.0) (2026-05-27)

### Features

* **bridge:** extract testable modules and add 31 new tests ([b71aaa2](https://github.com/ExaDev/agent-comms/commit/b71aaa2c1e5bdfb72d2fb321708ee996718a53d2))

### Bug Fixes

* **bridge:** add room-list ID to ProjectTree for E2E test selectors ([b930fe9](https://github.com/ExaDev/agent-comms/commit/b930fe9234ef8c71c5e8b6e9130bd2695aa10f1c)), closes [#room-list](https://github.com/ExaDev/agent-comms/issues/room-list)
* **bridge:** capture deep link before rerender clears URL params ([c162f0c](https://github.com/ExaDev/agent-comms/commit/c162f0c417598f2770f710594bc677feba392e5b))
* **bridge:** correct /join test assertion from 'Switched to' to 'Joined' ([ac1bb24](https://github.com/ExaDev/agent-comms/commit/ac1bb242322577282c8f6c33590bab52aec2d92b))
* **bridge:** fix deep link E2E tests for room ID and message clearing ([bfc55e4](https://github.com/ExaDev/agent-comms/commit/bfc55e4ce98691380d871b446c8f0f04f4cb4e66))
* **bridge:** isolate E2E test coordinator ports to prevent EADDRINUSE ([c0f03ab](https://github.com/ExaDev/agent-comms/commit/c0f03ab4af078eb00d7d8507f23404baa8008886))
* **bridge:** wait for room items before clicking in E2E tests ([c949358](https://github.com/ExaDev/agent-comms/commit/c949358e945d06e7b8908c96aa91b6ea5808a17f))

### Styles

* **bridge:** apply prettier and eslint formatting fixes ([8e5a643](https://github.com/ExaDev/agent-comms/commit/8e5a64356130240eba817f26d19acba21ae499cc))

## [1.17.1](https://github.com/ExaDev/agent-comms/compare/v1.17.0...v1.17.1) (2026-05-27)

### Bug Fixes

* render initial UI on first load without REST or mesh connection ([496e0ee](https://github.com/ExaDev/agent-comms/commit/496e0ee047709467275a6cd5f80cdae12a08685f))

## [1.17.0](https://github.com/ExaDev/agent-comms/compare/v1.16.1...v1.17.0) (2026-05-27)

### Features

* defer mesh connection on first visit to avoid browser prompt ([e618be3](https://github.com/ExaDev/agent-comms/commit/e618be3bbe15b58597f02078b7134fc921587eda))

## [1.16.1](https://github.com/ExaDev/agent-comms/compare/v1.16.0...v1.16.1) (2026-05-27)

### Bug Fixes

* skip REST API calls entirely on standalone PWA ([e76698f](https://github.com/ExaDev/agent-comms/commit/e76698f267b8045aadafa775387f588a9aac509b))

## [1.16.0](https://github.com/ExaDev/agent-comms/compare/v1.15.1...v1.16.0) (2026-05-27)

### Features

* sequential port discovery for standalone PWA mesh discovery ([d23ba26](https://github.com/ExaDev/agent-comms/commit/d23ba26faf55b6a2bf7e52666c3cc415437300e9))

### Bug Fixes

* prettier formatting and void expression in main.tsx ([c318dca](https://github.com/ExaDev/agent-comms/commit/c318dca674954a4046e087581a1913bd1b306d25))
* wrap void-returning callback in braces for no-confusing-void-expression ([b8ef5df](https://github.com/ExaDev/agent-comms/commit/b8ef5df06c9052c4c199ffbad72005540c8574c1))

### Styles

* prettier formatting ([fc54d6f](https://github.com/ExaDev/agent-comms/commit/fc54d6f3ae51830ef50ce541c5f8a02063a780fc))

## [1.15.1](https://github.com/ExaDev/agent-comms/compare/v1.15.0...v1.15.1) (2026-05-27)

### Bug Fixes

* use relative paths for GitHub Pages subpath deployment ([3ea54e4](https://github.com/ExaDev/agent-comms/commit/3ea54e428dea8cae61d82d9be30076e980a093c8))

## [1.15.0](https://github.com/ExaDev/agent-comms/compare/v1.14.0...v1.15.0) (2026-05-27)

### Features

* **bridge:** add mesh_set_visibility and mesh_get_visibility to buildAction ([374ad2d](https://github.com/ExaDev/agent-comms/commit/374ad2da9782a7a6a4772ec92fe6482927ade00b))
* **bridge:** add PWA manifest, offline caching, and installability ([3872e5f](https://github.com/ExaDev/agent-comms/commit/3872e5f426d5544bdb43b0e47092a3b6238ba88b))
* **bridge:** add root entry point for pi auto-discovery ([e16b39b](https://github.com/ExaDev/agent-comms/commit/e16b39b55b43cd0931c0bbd7c8e5448b14e51863))
* **bridge:** add service worker with push notification handling ([b91537c](https://github.com/ExaDev/agent-comms/commit/b91537c5431c6c4461399dd5b507979ff16fc3ab))
* **bridge:** add URL query parameter deep linking for rooms and DMs ([f4ce6e2](https://github.com/ExaDev/agent-comms/commit/f4ce6e26b8a02e7e5e098658feebd8792771e12c))
* **bridge:** enable TLS transport across all bridges ([927ee99](https://github.com/ExaDev/agent-comms/commit/927ee997ae080963da889f77bc892899746ed01d))
* **bridge:** integrate PushManager into web server ([51c7e64](https://github.com/ExaDev/agent-comms/commit/51c7e64d7d7a1185982913718c39478a33caec4a))
* **bridge:** pass discovery manager to CommsTool in all bridges ([ab302d6](https://github.com/ExaDev/agent-comms/commit/ab302d65780f5cd94f9e28d6957431050bdabbb2))
* **bridge:** restore project tree sidebar, agent rename, and routeAction ([74fd260](https://github.com/ExaDev/agent-comms/commit/74fd260fc2d92cac7a5c2e4f19a81311f8c1db32))
* **build:** add mesh-worker.ts as separate esbuild entry point ([c615bc8](https://github.com/ExaDev/agent-comms/commit/c615bc852bcb5cca34142f5d615bcdc5a1c00b8e))
* **core:** add bidirectional approval wire messages and types ([558c68b](https://github.com/ExaDev/agent-comms/commit/558c68b7833ca41fd788b0eea70907cf96df4b11))
* **core:** add cryptographic identity generation ([89ec5cb](https://github.com/ExaDev/agent-comms/commit/89ec5cb392ce683337af23ed33dcec45fdc1aadd))
* **core:** add discovery module with mDNS and Tailscale backends ([8063874](https://github.com/ExaDev/agent-comms/commit/80638740d2dd96679b0889a0830a0feec1a3f4df))
* **core:** add federation wire messages and types ([aca2526](https://github.com/ExaDev/agent-comms/commit/aca2526c35bd118a39cd20513f97bc4265a8ed19))
* **core:** add listener management and network interface discovery to MeshStore ([8bb9570](https://github.com/ExaDev/agent-comms/commit/8bb9570cebb9d4abe2a01b88a4c2ecb5cf9aeead))
* **core:** add mesh_discover, mesh_advertise, mesh_unadvertise action types ([fb9613b](https://github.com/ExaDev/agent-comms/commit/fb9613b3f1b6c98cc12a3faa928224d46ccec66e))
* **core:** add MeshVisibility type and stop() to discovery backends ([696f11d](https://github.com/ExaDev/agent-comms/commit/696f11dff47ece5e44cdfeafd2032b83939ef09f))
* **core:** add multi-listener coordinator support with per-listener policies ([cf897e8](https://github.com/ExaDev/agent-comms/commit/cf897e85f46dc3df6b2c6d3f01ce4816559497c4))
* **core:** add onPatch callback to MeshStore ([4fc5676](https://github.com/ExaDev/agent-comms/commit/4fc567600ff06dd1c155ff657cbf8d21e7e20428))
* **core:** add PushManager for browser push subscriptions ([1dad588](https://github.com/ExaDev/agent-comms/commit/1dad588ed4d839e9a3f858db161b33d4b07ff8a8))
* **core:** add TlsTransport with certificate pinning ([527429c](https://github.com/ExaDev/agent-comms/commit/527429ccc2ba8b94c6bd545e7163cc6922c9dd2b))
* **core:** add VAPID key generation for Web Push ([90ce608](https://github.com/ExaDev/agent-comms/commit/90ce608b218150cc9c7251f0845973087ab84494))
* **core:** add visibility state machine to DiscoveryManager ([3bd6326](https://github.com/ExaDev/agent-comms/commit/3bd6326d2d43d91e0e135dd527b676ead40c4433))
* **core:** add WebSocketTransport for browser mesh participation ([1dbe6c6](https://github.com/ExaDev/agent-comms/commit/1dbe6c6ae6be53e97fdcdbeef5bb2f93fb1780c7))
* **core:** export VAPID and PushManager from public API ([b68c4e7](https://github.com/ExaDev/agent-comms/commit/b68c4e78774716c6f2b70f189bdee720446ed119))
* **core:** handle discovery actions in CommsTool ([8cf06c8](https://github.com/ExaDev/agent-comms/commit/8cf06c8cfe6d2882d191542aa0f2242a70bd22ac))
* **core:** implement bidirectional connection approval ([5fd3d14](https://github.com/ExaDev/agent-comms/commit/5fd3d148996c6be924c41d25336fc25932b55ac9))
* **core:** implement FederationManager ([04bb349](https://github.com/ExaDev/agent-comms/commit/04bb349e9dce7f56da8beac22a1cb8af75f92fe7))
* **core:** implement TcpTransport with connection lifecycle and event dispatch ([a1d2196](https://github.com/ExaDev/agent-comms/commit/a1d21960af05a0ab16d921b75722d815c5ebd69b))
* **core:** implement Web Push encryption and VAPID signing ([eacaa95](https://github.com/ExaDev/agent-comms/commit/eacaa955e34ffb013d99c0f247a9d70de8840123))
* **core:** wire discovery backends into MeshStore and exports ([e545dde](https://github.com/ExaDev/agent-comms/commit/e545dde43fd9523b3c8b645c726d55d154760c2d))
* **core:** wire federation into MeshStore, CommsTool, and buildAction ([9d5a0ac](https://github.com/ExaDev/agent-comms/commit/9d5a0ac3d871530b41bb68c705a8fc514459aa9f))
* **core:** wire listener actions through CommsTool and bridge helpers ([5cb4a3b](https://github.com/ExaDev/agent-comms/commit/5cb4a3bf253d3262cd8ec5487c9a2af85ea44a4f))
* **core:** wire visibility through MeshStore and CommsTool ([0606977](https://github.com/ExaDev/agent-comms/commit/06069772803df0fdff870e975b8975fa713a93ab))
* **web:** add /ws/mesh bridge endpoint for browser mesh participation ([c22e44b](https://github.com/ExaDev/agent-comms/commit/c22e44bcb86a5ab53766b77dd5575eabd1dc40dd))
* **web:** add relay SharedWorker for cross-mesh message forwarding ([f9d6c31](https://github.com/ExaDev/agent-comms/commit/f9d6c31d09f377f485940bf381eecea73ec3b68a))
* **web:** add RelayClient main-thread API ([b163e66](https://github.com/ExaDev/agent-comms/commit/b163e66c65578d691114c727b89e07ed40e8726b))
* **web:** add RelayPanel component with relay configuration UI ([52b3eb7](https://github.com/ExaDev/agent-comms/commit/52b3eb7ba2b1598a98cf3665ae9aa2dc46cda4b1))
* **web:** add SharedWorker mesh node and main-thread MeshClient ([c889c91](https://github.com/ExaDev/agent-comms/commit/c889c911c42ce84f695bd9d33768c4a8ff9fcec6))
* **web:** integrate MeshClient into frontend for real-time mesh state ([b03bbd7](https://github.com/ExaDev/agent-comms/commit/b03bbd71a93ff5b68ee6bd87207ba36b2d53ce59))
* **web:** wire relay client into App, Sidebar, and main entry point ([df4b83e](https://github.com/ExaDev/agent-comms/commit/df4b83eefa3e43d7f7baf0389ed1dc547d883615))

### Bug Fixes

* **bridge:** share mesh store between pi bridge and web server ([6438629](https://github.com/ExaDev/agent-comms/commit/6438629e0f0cb1cd61b67de91a94fbb718c02a37))
* **build:** replace lint-staged with direct eslint in git hooks ([a495d81](https://github.com/ExaDev/agent-comms/commit/a495d818a167a3bb03002a8abd3aed9e0a1fe972))
* **ci:** remove stale _site upload-artifact step ([522e93b](https://github.com/ExaDev/agent-comms/commit/522e93bd20c84d5fcee67bae7c958f9b7c7a4ceb))
* **ci:** skip husky hooks during semantic-release ([05eb4bb](https://github.com/ExaDev/agent-comms/commit/05eb4bb795ec620c3cac2d84d6a59602192813f9))
* **core:** add federation stubs to FileStore and fix test narrowing ([b2abcab](https://github.com/ExaDev/agent-comms/commit/b2abcab41bacd54365fda445b03b02ef5039ebb6))
* **core:** handle EADDRINUSE race in coordinator election and graceful degradation ([b0c3894](https://github.com/ExaDev/agent-comms/commit/b0c3894b7eef749c1b55f1cd40d00e3f4ce01489))
* **core:** prevent event-loop starvation in delivery chain ([c54c07d](https://github.com/ExaDev/agent-comms/commit/c54c07d83528519bab0917c5dbcf2045fce46864))
* **core:** prevent untracked markRead timers after shutdown ([b45e215](https://github.com/ExaDev/agent-comms/commit/b45e215677d4c23b4fa8988c70a3645b4afd6be8))
* **core:** remove invalid adapter reference from meshGetVisibility ([58177a0](https://github.com/ExaDev/agent-comms/commit/58177a0a0b34f8e5b341e6617b199bfab69bd20e))
* **core:** resolve merge conflict leftovers in tool.ts ([90152dc](https://github.com/ExaDev/agent-comms/commit/90152dc8adc752ab4243c8ff9d70f858afd46bea))
* **core:** resolve merge conflicts from parallel agent integration ([9acf30c](https://github.com/ExaDev/agent-comms/commit/9acf30c05feff9c693e3454fe246180915070c39))
* **core:** resolve type errors from parallel agent integration ([c1e9af4](https://github.com/ExaDev/agent-comms/commit/c1e9af4c0acdffec05ce92536364aeb8dfec1a8c))
* **core:** use listener.server.close() in transport shutdown ([4c08bb0](https://github.com/ExaDev/agent-comms/commit/4c08bb06717fe9f6bc5a4a8b70340363c7e0790f))
* remove noInlineConfig to allow eslint-disable for legitimate casts ([e27af8d](https://github.com/ExaDev/agent-comms/commit/e27af8d3b11c1522289af650d5ab38cdf9388c1a))
* resolve all ESLint errors with proper type narrowing and runtime validation ([8d47f7d](https://github.com/ExaDev/agent-comms/commit/8d47f7d386ba56887560f3813497c5191185202f))
* resolve CI type errors and lint failures ([7ffa4f3](https://github.com/ExaDev/agent-comms/commit/7ffa4f3b9058e40859d164d1a8dcca4a8e75cbf9))
* resolve TypeScript errors from satisfies-based type narrowing ([036b603](https://github.com/ExaDev/agent-comms/commit/036b603f687f2f7957391da4425c189859cbd16f))
* **test:** intercept transport events for listener policy test ([b9a0d07](https://github.com/ExaDev/agent-comms/commit/b9a0d07a9d44d38faa3e5d81c4fa314d1c5f07c4))

### Refactoring

* **bridge:** separate folder toggle from directory room selection ([ae2a898](https://github.com/ExaDev/agent-comms/commit/ae2a89809624ddfdf1b430d9bc4776c3ae2c3b71))
* **core:** extract wire protocol and transport interface ([852dc5f](https://github.com/ExaDev/agent-comms/commit/852dc5fde37c4025739cfe377560c1d657192af0))
* **core:** inject transport into MeshStore via DI ([1ab25b0](https://github.com/ExaDev/agent-comms/commit/1ab25b045fa43cd86cf7e6fff767000813e67454))

### Styles

* apply prettier formatting across codebase ([7879d3b](https://github.com/ExaDev/agent-comms/commit/7879d3b77a833a8a562d30f1355a1c36f6a8d181))

### Tests

* add federation integration tests ([19b2241](https://github.com/ExaDev/agent-comms/commit/19b2241d18e9b9d2cd2f8d957762dc7582e3128a))
* add visibility integration tests and test:visibility script ([2ac7298](https://github.com/ExaDev/agent-comms/commit/2ac7298e310ca33fad1f52a15a2f78afb0085ace))
* **core:** add delivery receipt integration tests ([6a59a65](https://github.com/ExaDev/agent-comms/commit/6a59a65cb0edd2803a7da4af9a161c624dbf89df))
* **core:** add listener policy integration test ([386bbac](https://github.com/ExaDev/agent-comms/commit/386bbacb6a1ef28a88c1b726b7d5d34d693212c2))

### Build

* **web:** add relay-worker.ts as separate esbuild IIFE entry point ([6f0f569](https://github.com/ExaDev/agent-comms/commit/6f0f56911588b35de0bf04f862e62fae2d9c524f))

### CI

* deploy PWA to GitHub Pages on push to main ([c9176c1](https://github.com/ExaDev/agent-comms/commit/c9176c1099feefb1d04ac82098083f8b8c03a472))
* trigger Pages deployment ([1458e38](https://github.com/ExaDev/agent-comms/commit/1458e38d0e78e12e210b031d7ed55932b9b3973a))

### Chores

* **ci:** update to Node 26 and latest action versions ([665e14f](https://github.com/ExaDev/agent-comms/commit/665e14f7bb66086ab9dab7789af541dbc2761a53))
* ignore local .worktrees/ directories ([11e1a29](https://github.com/ExaDev/agent-comms/commit/11e1a2900dd2df7bf2765361e865bc6815b2d5b7))

## [1.14.0](https://github.com/ExaDev/agent-comms/compare/v1.13.0...v1.14.0) (2026-05-25)

### Features

* **bridge:** add buildProjectTree function with unit tests ([86d0250](https://github.com/ExaDev/agent-comms/commit/86d02500983c6de343345dc5fd0d43923f812875))
* **bridge:** add footer status line with project room, web URL, and unread count ([9ce0811](https://github.com/ExaDev/agent-comms/commit/9ce08117356372fc9ec18d4b34ab47266f27dd9d))
* **bridge:** add ProjectTree component and rebuild sidebar ([2c38d16](https://github.com/ExaDev/agent-comms/commit/2c38d16eff892cba1d046d3a5e02b6d9c19c0d34))
* **bridge:** categorise delivery events as actionable vs informational ([bffbedb](https://github.com/ExaDev/agent-comms/commit/bffbedb1cc11654f5afdb63d8c5da4fe8fea7359))
* **cli:** add /comms-url slash command ([0877b98](https://github.com/ExaDev/agent-comms/commit/0877b986a36fc0bc94c2258a6641816e6f55bc27))
* **core:** add agent renaming via name_changed event and rename_agent action ([1740a1a](https://github.com/ExaDev/agent-comms/commit/1740a1ad978ab71f23fd59bcf596e5f5b6047a72))
* **core:** add isActionableEvent for delivery event classification ([12cc749](https://github.com/ExaDev/agent-comms/commit/12cc7499170843183841e0333a0458dad1529d6d))
* **core:** auto-create project rooms per working directory ([a44a52a](https://github.com/ExaDev/agent-comms/commit/a44a52a172afb909a3939fbe6c27ec03b85e12cc))

### Bug Fixes

* **bridge:** add required display field to sendMessage call ([5721170](https://github.com/ExaDev/agent-comms/commit/5721170e48068af722291a81b7ba2567b8813434))
* **bridge:** correct sendMessage API usage and add name_changed to TUI ([40fd3e4](https://github.com/ExaDev/agent-comms/commit/40fd3e47113d155805d8473c69d1fb26934916b3))
* **bridge:** fix handler return type and exclude frontend tests from tsc ([f962966](https://github.com/ExaDev/agent-comms/commit/f962966f6eb55ef49776e22591a39b6a71be0087))
* **bridge:** fix TypeScript errors in tests and command handler ([d7aef53](https://github.com/ExaDev/agent-comms/commit/d7aef53b2e1410927fdb31049150b0ee12711d29))
* **bridge:** resolve ESLint errors in web UI components and tests ([ddce4b9](https://github.com/ExaDev/agent-comms/commit/ddce4b9854a28ab6af2b27a0fb52bb9ac5e8f68f))
* **bridge:** rewrite garbled pi bridge index from reconstruction ([4efcdff](https://github.com/ExaDev/agent-comms/commit/4efcdff1d4d2f1500b112e9c8b63ac5e3056ad0e))
* **bridge:** use requireElement with tag for join form inputs ([fc7019a](https://github.com/ExaDev/agent-comms/commit/fc7019a96d3d89b2815c47bc1ea479eab9f1331c))
* **build:** deduplicate package.json keys and add missing preact dependency ([8a10193](https://github.com/ExaDev/agent-comms/commit/8a1019372131fc99dec59abbf374404bcb437664))
* **build:** exclude hanging multi-process integration tests from pnpm test ([c43cca3](https://github.com/ExaDev/agent-comms/commit/c43cca3b470da431d59abfd8668453105c8b67e2))
* **build:** remove stale imperative files and fix project-tree.ts ([642dcac](https://github.com/ExaDev/agent-comms/commit/642dcacd99571c68dcd839e54dedc01c48a6a5c1))
* **core:** remove duplicate isActionableEvent export ([8a50ae8](https://github.com/ExaDev/agent-comms/commit/8a50ae847bd7b52826d8b3349d815ac35a686133))
* **lint:** add test files to allowDefaultProject and fix prettier formatting ([35a831f](https://github.com/ExaDev/agent-comms/commit/35a831ffaa71c1ca2b37d7734ce882ce64b9c238))
* **lint:** downgrade require-await to warning and fix prettier formatting ([9d751a8](https://github.com/ExaDev/agent-comms/commit/9d751a857dc0b88d70943655ef0eb41f3acfb6bc))
* **lint:** rename JSX test files to .tsx and delete stale duplicates ([5d16af2](https://github.com/ExaDev/agent-comms/commit/5d16af2698ebef3719215875ef42cdae8e8d1835))
* **lint:** resolve all ESLint errors flagged by CI ([4bcf690](https://github.com/ExaDev/agent-comms/commit/4bcf6905c52c794d697e2afc22c3a1cbac03f300))
* **lint:** restore async handler, add non-nullable-type-assertion-style to test overrides ([0eeb670](https://github.com/ExaDev/agent-comms/commit/0eeb670d54a6acbb25459c4aa38b5f0d0715c1d3))
* **mesh:** deduplicate delivery events and clean up stale peers ([f78ba74](https://github.com/ExaDev/agent-comms/commit/f78ba7442a4cece22ea272290e72c69a169fffcc))
* **mesh:** deduplicate delivery events at the MeshStore level ([d7d67c5](https://github.com/ExaDev/agent-comms/commit/d7d67c557a36c4be66c9e9965a69744fd34af93d))
* **mesh:** merge members and subscribedRooms on patch receive ([3406c4e](https://github.com/ExaDev/agent-comms/commit/3406c4ec66389c775628e0a46b0ef0fb0fa3001f))
* **mesh:** only owning store broadcasts agent offline status ([d84e227](https://github.com/ExaDev/agent-comms/commit/d84e22780221ac317cfee20ead9a3e5f10a3dd43))
* **mesh:** prevent duplicate name_changed delivery to agent in room ([469dce3](https://github.com/ExaDev/agent-comms/commit/469dce35bd42bf985ab7fede87ed9478ce2a9e48))
* **mesh:** skip setAgentOffline if agent is already offline ([0175a55](https://github.com/ExaDev/agent-comms/commit/0175a55db874c54fa784cfb404e6747e494f8030))
* **tool:** route /join and /leave through local handlers for correct state ([7a8eb36](https://github.com/ExaDev/agent-comms/commit/7a8eb3668def6369ef8b82e95954443a1c20c9fc))

### Refactoring

* **bridge:** replace imperative DOM with Preact components ([e0699d6](https://github.com/ExaDev/agent-comms/commit/e0699d6f68ae7bd0782a4e2cc0b31c7331e03c4b))
* **bridge:** serve frontend as static assets instead of generated TS ([c700219](https://github.com/ExaDev/agent-comms/commit/c700219085faabddc743d5b3e95f0a703a60f34e))
* **web:** extract inline HTML frontend into TypeScript modules ([c272bd0](https://github.com/ExaDev/agent-comms/commit/c272bd09849e0f08531f3f20252d0eddface57da))

### Tests

* **bridge:** add message conversion unit tests, component tests, and web server integration tests ([9449ce5](https://github.com/ExaDev/agent-comms/commit/9449ce5f2327c48d74c0d33943978085035819e4))

## [1.13.0](https://github.com/ExaDev/agent-comms/compare/v1.12.0...v1.13.0) (2026-05-23)

### Features

* **bridge:** add web_url action to agent_comms tool ([db3d73e](https://github.com/ExaDev/agent-comms/commit/db3d73ed2a86abf69ac93680de030f4dae8439e6))
* **bridge:** enable DM by clicking agent in sidebar ([5d6cb33](https://github.com/ExaDev/agent-comms/commit/5d6cb33db5b0c08471eb5e2545a8cee443632d2d))

### Refactoring

* **bridge:** extract inline HTML frontend into TypeScript modules ([196dc6b](https://github.com/ExaDev/agent-comms/commit/196dc6bbc4071db77ffd5281b6e9395d93bb001a))

### Tests

* **bridge:** add Playwright e2e tests for web UI ([a263eeb](https://github.com/ExaDev/agent-comms/commit/a263eeb53e4a3836bb519641d134dd17875650c1))
* **bridge:** expand unit and e2e test coverage ([ee9c0d4](https://github.com/ExaDev/agent-comms/commit/ee9c0d4b70668e37fabc155c6d8308c5d80fbc5a))

### Chores

* **build:** adopt typed test file suffix convention ([b46dc4b](https://github.com/ExaDev/agent-comms/commit/b46dc4b8ffe2657f6e43e935fb1fa9ce290fe289))
* **build:** fix pre-push ESLint errors ([ffc1408](https://github.com/ExaDev/agent-comms/commit/ffc1408273518921c52a9d813cc7ad95ee38c877))
* **build:** relax ESLint rules for test files ([d15fe76](https://github.com/ExaDev/agent-comms/commit/d15fe76d7c581e5d114f66484b8dfaf1094df5b8))

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
