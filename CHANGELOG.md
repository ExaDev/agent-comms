## [5.2.4](https://github.com/ExaDev/agent-comms/compare/v5.2.3...v5.2.4) (2026-09-20)

### Bug Fixes

* **core:** contradict a stale offline report about this store's own running agent ([b6e300f](https://github.com/ExaDev/agent-comms/commit/b6e300f6b3c34b8c728e7c08c314ff1fbdb9bfe5))

## [5.2.3](https://github.com/ExaDev/agent-comms/compare/v5.2.2...v5.2.3) (2026-09-20)

### Build

* **deps:** bump cc-peer to 1.6.1 ([7673976](https://github.com/ExaDev/agent-comms/commit/7673976a23fed38f5571b7540c2df8ace2bd7349))

## [5.2.2](https://github.com/ExaDev/agent-comms/compare/v5.2.1...v5.2.2) (2026-09-20)

### Build

* **deps:** bump wire-mesh-core to 2.0.1 ([a45532b](https://github.com/ExaDev/agent-comms/commit/a45532b9b020091f8e6d130e07172c8bee5e1ac0))

## [5.2.1](https://github.com/ExaDev/agent-comms/compare/v5.2.0...v5.2.1) (2026-09-20)

### Bug Fixes

* **bridge:** deliver a fronted session's DM from the correspondent's alias ([3de7364](https://github.com/ExaDev/agent-comms/commit/3de73645c4315c519090203471211eb6a19ce660))

### Documentation

* describe alias-sender delivery and how to accept inbound messages ([d3f609b](https://github.com/ExaDev/agent-comms/commit/d3f609b7c03273c29ba22c2dcc1c8cc9595c1722))

## [5.2.0](https://github.com/ExaDev/agent-comms/compare/v5.1.0...v5.2.0) (2026-09-20)

### Features

* **core:** report whether a sent message was delivered or only queued ([3de4c88](https://github.com/ExaDev/agent-comms/commit/3de4c8868d3d551f107c0701f5b13cf71ffc0e28))

### Bug Fixes

* **core:** answer no_route when this side has nowhere to send a request ([44ea176](https://github.com/ExaDev/agent-comms/commit/44ea1767c8b7cde66e49d6f68c02ace83cf9459d))
* **core:** only ask for an identity once something is actually queued ([57bab37](https://github.com/ExaDev/agent-comms/commit/57bab3723b1b9f64843c88e7363e56f2f1b8d049))
* **mesh-store:** retry a queued room request when any route to the member appears ([1d5d82d](https://github.com/ExaDev/agent-comms/commit/1d5d82dbc633e8d7c35a310f93bdd516910a40f9))

### Styles

* **core:** wrap two long test assertions ([7196ec8](https://github.com/ExaDev/agent-comms/commit/7196ec8d3dfd6fa2c0c90a504aa31f628edd494c))

### Tests

* **bridge:** assert the web UI names who a delivery status is about ([0db1177](https://github.com/ExaDev/agent-comms/commit/0db1177cd56581b69293adc6a1281bf5e6bd989b))
* **core:** cover the queued-then-delivered DM path end to end ([1459a48](https://github.com/ExaDev/agent-comms/commit/1459a487ec29795ae33bac904f33db2a1375ca06))
* **core:** expect no_route from an untrusted target with no session ([54f0340](https://github.com/ExaDev/agent-comms/commit/54f034070053b87ee28f249d10a105d19330e979))
* **core:** expect the nested delivery union on delivery_status events ([bc8f071](https://github.com/ExaDev/agent-comms/commit/bc8f071014058eb28795f07903a81093e427ca18))

## [5.1.0](https://github.com/ExaDev/agent-comms/compare/v5.0.6...v5.1.0) (2026-09-20)

### Features

* **bridge:** answer termination signals in every bridge, not just two of them ([7772cca](https://github.com/ExaDev/agent-comms/commit/7772cca8e8510818238e28dd3b00200db57a3880))

### Bug Fixes

* **core:** read a hub session's events from one consumer so a close is never missed ([36a746a](https://github.com/ExaDev/agent-comms/commit/36a746ae6881d8a80354143a8ab4eb510f8be78b))
* **mesh-store:** bound the deadline on mesh-state frames and settle a lost coordinator ([0f99514](https://github.com/ExaDev/agent-comms/commit/0f995145c4b1f03498c88fa08d2a2797d85378d2))
* **mesh-store:** race to rebind the coordinator port when the coordinator crashes ([939d058](https://github.com/ExaDev/agent-comms/commit/939d05853360d8554ba661734de51f83cf1f0f86))

### Documentation

* describe what actually happens when the coordinator goes away ([6a706bf](https://github.com/ExaDev/agent-comms/commit/6a706bf43a168b093728dbc778cd2f1f31909216))

## [5.0.6](https://github.com/ExaDev/agent-comms/compare/v5.0.5...v5.0.6) (2026-09-20)

### Build

* **deps:** bump cc-peer to 1.6.0 ([1c71fb4](https://github.com/ExaDev/agent-comms/commit/1c71fb4586ffe0306f7d64a67de360421efde0bb))

## [5.0.5](https://github.com/ExaDev/agent-comms/compare/v5.0.4...v5.0.5) (2026-09-20)

### Build

* **deps:** bump web-ui-primitives to 1.1.1 ([24b9b32](https://github.com/ExaDev/agent-comms/commit/24b9b329ce4dd29d1e3f7b1f9a599b95eee6905d))

## [5.0.4](https://github.com/ExaDev/agent-comms/compare/v5.0.3...v5.0.4) (2026-09-20)

### Build

* **deps-dev:** bump @semantic-release/git from 10.0.1 to 11.0.1 ([2cf35f2](https://github.com/ExaDev/agent-comms/commit/2cf35f284cd1ebf068f6a2da94e23dbcaa7748a1))

## [5.0.3](https://github.com/ExaDev/agent-comms/compare/v5.0.2...v5.0.3) (2026-09-20)

### Tests

* **core:** tear hub tests down in reverse order so the hub outlives its clients ([26a052f](https://github.com/ExaDev/agent-comms/commit/26a052fcc8169bb89cc371787772da13168beba2))

## [5.0.2](https://github.com/ExaDev/agent-comms/compare/v5.0.1...v5.0.2) (2026-09-20)

### Build

* **deps-dev:** bump @commitlint/config-conventional ([7c4917b](https://github.com/ExaDev/agent-comms/commit/7c4917bda9574727e9dde972b5123e84275e4c6f))
* **deps-dev:** bump @playwright/test from 1.61.1 to 1.63.0 ([88d2c65](https://github.com/ExaDev/agent-comms/commit/88d2c656e60339b25ccc051ecd1bb3430c190528))
* **deps-dev:** bump @types/node from 26.1.1 to 26.6.1 ([dd141c7](https://github.com/ExaDev/agent-comms/commit/dd141c7fe9aa6751a4566067bc2e06caddc049af))
* **deps-dev:** bump prettier from 3.9.5 to 3.9.7 ([1309722](https://github.com/ExaDev/agent-comms/commit/130972253d28c5bdb3661ddf66a1efcb66ed90a1))
* **deps:** bump cc-peer to 1.5.3 ([a60067e](https://github.com/ExaDev/agent-comms/commit/a60067ec38e5775eceb1e9be42b6e62a5090f41f))
* **deps:** bump web-ui-primitives to 1.1.0 ([76844f7](https://github.com/ExaDev/agent-comms/commit/76844f749908224240b0b4304478d5446a60b577))

## [5.0.1](https://github.com/ExaDev/agent-comms/compare/v5.0.0...v5.0.1) (2026-09-20)

### Build

* **deps:** bump cc-peer to 1.5.2 ([48d9b15](https://github.com/ExaDev/agent-comms/commit/48d9b150a224c52fec2117aa2c1106972186b801))

### CI

* **deps:** bump sibling packages as soon as they publish ([d26d8e4](https://github.com/ExaDev/agent-comms/commit/d26d8e438cd46649814ccbdff17ce1ea63459b4a))

## [5.0.0](https://github.com/ExaDev/agent-comms/compare/v4.5.2...v5.0.0) (2026-09-20)

### ⚠ BREAKING CHANGES

* **deps:** peers and hubs running wire-mesh-core 1 no longer interoperate with this version.

### Features

* **deps:** require wire-mesh-core 2 and its signed peer adverts ([4370a98](https://github.com/ExaDev/agent-comms/commit/4370a98131c16ce355ce36a8b91c292a0a31d39d))

### Bug Fixes

* **core:** catch a hub up with only the devices this side fronts ([180247d](https://github.com/ExaDev/agent-comms/commit/180247db9f626a17e69d30fdf84a2f95407b8339))

### Documentation

* **core:** describe signed adverts and why a merge and the hub differ on ties ([92ddaf1](https://github.com/ExaDev/agent-comms/commit/92ddaf1244d723c8424eb33d2c2d48b9e8c9e2f4))

### Tests

* **core:** wait for the hub to register a peer before relaying to it ([d568ed4](https://github.com/ExaDev/agent-comms/commit/d568ed46c06867a1a82ff3f8f10ad313d5761526))

## [4.5.2](https://github.com/ExaDev/agent-comms/compare/v4.5.1...v4.5.2) (2026-09-20)

### Refactoring

* **core:** give the room router separate local and relayed entry points ([8c2d9ca](https://github.com/ExaDev/agent-comms/commit/8c2d9caed02ba261b3216d4c81793ba01a952dee))

### Tests

* **core:** send raw legacy frames through a real hub to a trusting peer ([0b0c64e](https://github.com/ExaDev/agent-comms/commit/0b0c64ecabbb3a448a1880b423a6276ec5d48645))

## [4.5.1](https://github.com/ExaDev/agent-comms/compare/v4.5.0...v4.5.1) (2026-09-20)

### Bug Fixes

* **build:** smoke-check the hub with a relayed path.trace ([bfb879a](https://github.com/ExaDev/agent-comms/commit/bfb879a672381e14f874ff383d2d4aa42b692de8))
* **core:** refuse legacy frame requests relayed through a hub ([c8f94f6](https://github.com/ExaDev/agent-comms/commit/c8f94f639d8de80cd34dd8cdac55778547cde4a8))

## [4.5.0](https://github.com/ExaDev/agent-comms/compare/v4.4.0...v4.5.0) (2026-09-20)

### Features

* **core:** trust a principal to cover every device it vouches for ([9ace9d2](https://github.com/ExaDev/agent-comms/commit/9ace9d225d77faf9743dbc7d120c0e283180db9c))

### Bug Fixes

* **core:** bound and harden membership proof admission ([6cdf560](https://github.com/ExaDev/agent-comms/commit/6cdf560bac878cb886c357fc29e05dc7a9d23c99))

### Tests

* **tool:** accept either rejection path for a revoked DM grant ([1fe8057](https://github.com/ExaDev/agent-comms/commit/1fe805717ea610c24e24792e497d912bd97bd3d9))

## [4.4.0](https://github.com/ExaDev/agent-comms/compare/v4.3.0...v4.4.0) (2026-09-19)

### Features

* **tool:** admit a whole user for DMs, and show a user their own principal in whoami ([cf6cd84](https://github.com/ExaDev/agent-comms/commit/cf6cd840c8ae95b6a471555349b8cbd5a6530b7b))

## [4.3.0](https://github.com/ExaDev/agent-comms/compare/v4.2.0...v4.3.0) (2026-09-19)

### Features

* **tool:** add dm_admit, dm_use_grant and dm_revoke for pre-authorised DMs ([f0fe369](https://github.com/ExaDev/agent-comms/commit/f0fe369c63db527e615bd4948d954c4affda3475)), references [agent-comms#162](https://github.com/agent-comms/issues/162)

## [4.2.0](https://github.com/ExaDev/agent-comms/compare/v4.1.10...v4.2.0) (2026-09-19)

### Features

* **bridge:** let a cc-peer session answer a join or DM request ([d496198](https://github.com/ExaDev/agent-comms/commit/d496198b218e4cfed4fbc82751ba4b8e3380b264))

## [4.1.10](https://github.com/ExaDev/agent-comms/compare/v4.1.9...v4.1.10) (2026-09-19)

### Bug Fixes

* **core:** resolve bare room names against gossip-discovered rooms ([406b2ec](https://github.com/ExaDev/agent-comms/commit/406b2ec64cbc2546f0514c58296f7545edfa2c9f))

## [4.1.9](https://github.com/ExaDev/agent-comms/compare/v4.1.8...v4.1.9) (2026-09-19)

### Bug Fixes

* **core:** bound how long a room.join may await a human decision ([f3a246f](https://github.com/ExaDev/agent-comms/commit/f3a246ffd41c6b112f3b383300616a55cd14d2d1))

### Tests

* **core:** find the drained DM by type instead of by position ([ec1f0bc](https://github.com/ExaDev/agent-comms/commit/ec1f0bc2d0ccb901d4bca8418a2fb8ca593c40f4))

### CI

* run the delivery receipt tests ([336e51a](https://github.com/ExaDev/agent-comms/commit/336e51a66424af7ccb3fb4e5f99cecdd3d6960ae))

## [4.1.8](https://github.com/ExaDev/agent-comms/compare/v4.1.7...v4.1.8) (2026-09-19)

### Documentation

* **bridge:** note that Claude Code holds cross-session messages until approved ([73c2ec1](https://github.com/ExaDev/agent-comms/commit/73c2ec1aba08d4c0b420fbcd20cea125a3678af2))

## [4.1.7](https://github.com/ExaDev/agent-comms/compare/v4.1.6...v4.1.7) (2026-09-19)

### Bug Fixes

* **core:** resolve ws-dial send once the frame is flushed and reject on failure ([c1d3ce5](https://github.com/ExaDev/agent-comms/commit/c1d3ce5a3c2dbd6ea312e585afe33b5848b13bc3))

### Refactoring

* **bridge:** drop async from handlers that never await or return a promise ([7505bd3](https://github.com/ExaDev/agent-comms/commit/7505bd39bce962dbdb30e3d723a85c23ebd3a021))

### Tests

* make the ws test connection's send and close reflect real socket completion ([e68a75a](https://github.com/ExaDev/agent-comms/commit/e68a75a14909831e0c5cf0652829f1387c6ef1e5))

## [4.1.6](https://github.com/ExaDev/agent-comms/compare/v4.1.5...v4.1.6) (2026-09-19)

### Build

* **bridge:** build the service worker as an iife to avoid a deprecated Rolldown option ([4e4eaff](https://github.com/ExaDev/agent-comms/commit/4e4eaffce2fb26c1bac81fa1b29aeccd39fc8ecb))

## [4.1.5](https://github.com/ExaDev/agent-comms/compare/v4.1.4...v4.1.5) (2026-09-19)

### CI

* move actions/cache to v6, which runs on Node 24 ([91c9dd8](https://github.com/ExaDev/agent-comms/commit/91c9dd836dece3dd923d8ff75c36fc5cd1631628))

## [4.1.4](https://github.com/ExaDev/agent-comms/compare/v4.1.3...v4.1.4) (2026-09-19)

### Bug Fixes

* **bridge:** report mesh store errors instead of dropping them ([2c42fca](https://github.com/ExaDev/agent-comms/commit/2c42fca39e11c5148c7860ffe4b572912f6c9977))
* **bridge:** share one cc-peer peer between the bridge command and the default front ([1262f5d](https://github.com/ExaDev/agent-comms/commit/1262f5d72791e929807f8451bc0ec54f7435cc16))

## [4.1.3](https://github.com/ExaDev/agent-comms/compare/v4.1.2...v4.1.3) (2026-09-19)

### Bug Fixes

* **core:** re-read the identity file before concluding a concurrent create never happened ([bc6e83b](https://github.com/ExaDev/agent-comms/commit/bc6e83b67cd945387b7c0b803ffad202daecaacc))

## [4.1.2](https://github.com/ExaDev/agent-comms/compare/v4.1.1...v4.1.2) (2026-09-19)

### CI

* pass the exadev GitHub App's client id instead of the deprecated app-id input ([52a4f56](https://github.com/ExaDev/agent-comms/commit/52a4f5629a8423470b012d5d7c209904eba43413))

## [4.1.1](https://github.com/ExaDev/agent-comms/compare/v4.1.0...v4.1.1) (2026-09-19)

### CI

* push the release commit as the exadev GitHub App and gate release on e2e ([40b7817](https://github.com/ExaDev/agent-comms/commit/40b7817b7884aa6461e6ad5ee0f5ebba28fa647e))

## [4.1.0](https://github.com/ExaDev/agent-comms/compare/v4.0.1...v4.1.0) (2026-09-19)

### Features

* **core:** tell an agent when a room join is waiting on its decision ([c68a5e4](https://github.com/ExaDev/agent-comms/commit/c68a5e43e6c9ed0f9cde0780bda395b8a52be80b))

### Bug Fixes

* **core:** request DM access from sendDm when no room:member token is held yet ([05dd97d](https://github.com/ExaDev/agent-comms/commit/05dd97d6d8b0f330ace1b452b07ee04d7b7f0b8b))

### CI

* run the Playwright e2e suite on pull requests and pushes to main ([db38111](https://github.com/ExaDev/agent-comms/commit/db38111d0d1018d18579ab375495e8606c3344f9))

## [4.0.1](https://github.com/ExaDev/agent-comms/compare/v4.0.0...v4.0.1) (2026-09-19)

### Bug Fixes

* **deps:** bump wire-mesh-core to 1.58.4 so a fresh npm install resolves ([812c830](https://github.com/ExaDev/agent-comms/commit/812c8301f53673a483d827401c57730a4bbc0454))

## [4.0.0](https://github.com/ExaDev/agent-comms/compare/v3.34.1...v4.0.0) (2026-09-19)

### ⚠ BREAKING CHANGES

* **deps:** the pi extension and its peerDependencies now name the
  @earendil-works pi packages, so a pi host on the deprecated @mariozechner scope no
  longer satisfies the peer range.

### Documentation

* describe the pi host scope and version the extension requires ([5290da3](https://github.com/ExaDev/agent-comms/commit/5290da3c7ebefec47e99b316497a44d84528e7f7))

### Build

* **deps:** import pi types and helpers from the [@earendil-works](https://github.com/earendil-works) scope ([822e8c5](https://github.com/ExaDev/agent-comms/commit/822e8c532ced3fd1b3eec47638f1cf75f250399e))

## [3.34.1](https://github.com/ExaDev/agent-comms/compare/v3.34.0...v3.34.1) (2026-09-19)

### Tests

* terminate web socket clients before closing the server fixture ([ed94832](https://github.com/ExaDev/agent-comms/commit/ed94832297073eab11f44df6370796bedf1fc2b0))

## [3.34.0](https://github.com/ExaDev/agent-comms/compare/v3.33.3...v3.34.0) (2026-09-19)

### Features

* **build:** recognise a component test kind for React component tests ([65b3683](https://github.com/ExaDev/agent-comms/commit/65b3683cbf1d4239e2bbceae9db68823e7402626))

### Bug Fixes

* **build:** stop this repo's own json/json override from reverting tsconfig.json back off jsonc ([4a3e1ee](https://github.com/ExaDev/agent-comms/commit/4a3e1eed3bc24c8ec70b528c6ebd04d07d09c00b))

### Refactoring

* **cli:** replace remaining trailing optional parameters with options objects ([2ac77ed](https://github.com/ExaDev/agent-comms/commit/2ac77ed87704dd3c7302ecb75cc7a085e9040d93))
* **core:** pass dispatchHubRequest its inputs as an options object ([af17605](https://github.com/ExaDev/agent-comms/commit/af17605367f23fbc9532fdcf7b39036938487b23))
* **core:** pass sendRoomMessage reply, timing and durability hints as an options object ([2ef1963](https://github.com/ExaDev/agent-comms/commit/2ef1963c6369bff42d19376db940f2c5e34df400))
* **core:** take WireMeshTransport and its helpers' optional inputs as options objects ([0712569](https://github.com/ExaDev/agent-comms/commit/0712569c59ccb7da613a2f34a648b991c7ca85ed))
* **mesh-store:** construct MeshStore and the bridge mesh from options objects ([0fe48aa](https://github.com/ExaDev/agent-comms/commit/0fe48aa84af0190074e0755e6e0c695f99be38a2))
* **tool:** construct CommsTool from an options object ([ce03325](https://github.com/ExaDev/agent-comms/commit/ce03325186b54f380d93e7827cf58b378f197cd0))

### Tests

* **core:** assert connectToRemote is called with its options object ([3c4e2df](https://github.com/ExaDev/agent-comms/commit/3c4e2dfbf746ab3a9461f66283e84b5411224a1a))

### Chores

* **build:** apply RFC 8785 canonical JSON formatting ([b559047](https://github.com/ExaDev/agent-comms/commit/b5590476fea3684fa0337d11b0fb8170fa191d46))
* **build:** declare a test kind for every test file exadev/test-file-kind flags ([e80cc0f](https://github.com/ExaDev/agent-comms/commit/e80cc0f9e9820b09029ba07fb19b9a1530476ccc))
* **deps:** bump @exadev/eslint-config to 2.20.1 ([3849a34](https://github.com/ExaDev/agent-comms/commit/3849a34702f54f16b5a589f6f11b795cbc2591af))

## [3.33.3](https://github.com/ExaDev/agent-comms/compare/v3.33.2...v3.33.3) (2026-09-19)

### Bug Fixes

* **bridge:** await close callbacks and export disconnect() from mesh-worker ([625c8fc](https://github.com/ExaDev/agent-comms/commit/625c8fcfeec26315529fe8e6590f1ab72c96e371))
* **build:** configure mutual gateway trust in the production hub smoke check ([d657950](https://github.com/ExaDev/agent-comms/commit/d65795031f0e0de08d414e5b2fb4f6cc7011feed))
* **build:** route pre-push through a single turbo prepush task ([f5a7407](https://github.com/ExaDev/agent-comms/commit/f5a7407eb8523969e22e87093589401cc4bd0aeb))

## [3.33.2](https://github.com/ExaDev/agent-comms/compare/v3.33.1...v3.33.2) (2026-09-19)

### Chores

* exclude wire-mesh-core from the npm minimum-release-age gate ([7c19faa](https://github.com/ExaDev/agent-comms/commit/7c19faaf22926aea5fdf570f32357bb33632aaa8))

## [3.33.1](https://github.com/ExaDev/agent-comms/compare/v3.33.0...v3.33.1) (2026-09-19)

### Bug Fixes

* **bridge:** let a test-constructed controller override its own hub dial ([9f44d1b](https://github.com/ExaDev/agent-comms/commit/9f44d1bbc242a3c4f9eb7aa26ef759673cae7e6a))

### Tests

* **bridge:** stop web bridge integration tests dialling the real production hub ([2ffdb63](https://github.com/ExaDev/agent-comms/commit/2ffdb633d2df9120bf2782525211279c9aa745c8)), references [agent-comms#154](https://github.com/agent-comms/issues/154)

## [3.33.0](https://github.com/ExaDev/agent-comms/compare/v3.32.1...v3.33.0) (2026-09-18)

### Features

* **bridge:** replace duplicated compose rows with web-ui-primitives ([82edda4](https://github.com/ExaDev/agent-comms/commit/82edda4f5af4405400204a1586e0c6620c59cb21))

## [3.32.1](https://github.com/ExaDev/agent-comms/compare/v3.32.0...v3.32.1) (2026-09-18)

### Documentation

* **bridge:** document the web UI's TanStack Query layer ([a91bbc2](https://github.com/ExaDev/agent-comms/commit/a91bbc20dca901a4f7827cd214c6c43f53e73b5e))

## [3.32.0](https://github.com/ExaDev/agent-comms/compare/v3.31.0...v3.32.0) (2026-09-18)

### Features

* **bridge:** cut the web UI's one-shot reads over to TanStack Query ([46f4fa6](https://github.com/ExaDev/agent-comms/commit/46f4fa6035eb5464b61016cbfcb0a3cfcb106260))

## [3.31.0](https://github.com/ExaDev/agent-comms/compare/v3.30.0...v3.31.0) (2026-09-18)

### Features

* **bridge:** proxy the structured one-shot reads through the worker's tab-facing leg ([a33beb6](https://github.com/ExaDev/agent-comms/commit/a33beb61cfdb655ebded055fc1298a7b776c5ba6))

## [3.30.0](https://github.com/ExaDev/agent-comms/compare/v3.29.3...v3.30.0) (2026-09-18)

### Features

* **bridge:** add structured one-shot read procedures to the mesh contract ([8ea1c66](https://github.com/ExaDev/agent-comms/commit/8ea1c66e0ba58820c18690ce749945387062a058))

## [3.29.3](https://github.com/ExaDev/agent-comms/compare/v3.29.2...v3.29.3) (2026-09-18)

### Documentation

* **bridge:** document the web UI's oRPC-based tab/worker/server transport ([5ff8f17](https://github.com/ExaDev/agent-comms/commit/5ff8f172f6732cd17034d830a868a7f84ce26b04))

## [3.29.2](https://github.com/ExaDev/agent-comms/compare/v3.29.1...v3.29.2) (2026-09-18)

### Documentation

* **bridge:** confirm the test suite's own wire-facing parts are current ([f1c5d5f](https://github.com/ExaDev/agent-comms/commit/f1c5d5fe1195076bafcee892b56e4edd10f69e40))

## [3.29.1](https://github.com/ExaDev/agent-comms/compare/v3.29.0...v3.29.1) (2026-09-18)

### Bug Fixes

* **core:** make identity-slot lock acquisition and file writes atomic ([5985ede](https://github.com/ExaDev/agent-comms/commit/5985ede63557cd5559c86852f47c5ddf47c7f38f))

### Tests

* **core:** reproduce two processes racing loadOrCreateIdentity against a fresh identity slot ([8c14dc7](https://github.com/ExaDev/agent-comms/commit/8c14dc7eb9691fd61870924cbe0ae092665cbd24))

## [3.29.0](https://github.com/ExaDev/agent-comms/compare/v3.28.0...v3.29.0) (2026-09-18)

### Features

* **bridge:** retire the legacy chat/mesh sockets, oRPC now owns /ws/mesh ([d80c92a](https://github.com/ExaDev/agent-comms/commit/d80c92aaf5bd30efc71826f40c975fd200d60016))
* **core:** carry this side's own dialled hub address into hub-relayed dispatch ([f788958](https://github.com/ExaDev/agent-comms/commit/f788958159547418afc2980552c98332dc9dbb12))
* **core:** thread a request's own transport origin through RoomVerbHandler dispatch ([c1b3496](https://github.com/ExaDev/agent-comms/commit/c1b34960c8cb530364d9e1c220e5401d984df9b2))

### Bug Fixes

* **bridge:** wire push_subscribe/push_unsubscribe through dispatchAction ([1366efc](https://github.com/ExaDev/agent-comms/commit/1366efc205cf16cbf0bd98b195a1bd00e30520c4))
* **core:** report hubAddress on an incoming hub-relayed path.trace ([07fee03](https://github.com/ExaDev/agent-comms/commit/07fee0367ebdef1f330d9b7e91d43ea68ad71ca3))

## [3.28.0](https://github.com/ExaDev/agent-comms/compare/v3.27.0...v3.28.0) (2026-09-18)

### Features

* **bridge:** cut main.tsx over to meshClient, delete CommsWs entirely ([01c0a0d](https://github.com/ExaDev/agent-comms/commit/01c0a0d87fc1a6b5e8e46640dd65b218c398ede8))

## [3.27.0](https://github.com/ExaDev/agent-comms/compare/v3.26.0...v3.27.0) (2026-09-18)

### Features

* **bridge:** cut mesh-client.ts over to the real oRPC message-port client ([116ee65](https://github.com/ExaDev/agent-comms/commit/116ee65b10629dfb43c51516ffe7d1a8ddd28bd4))

## [3.26.0](https://github.com/ExaDev/agent-comms/compare/v3.25.0...v3.26.0) (2026-09-18)

### Features

* **bridge:** make mesh-worker serve tabs over oRPC too, still dark ([35529cc](https://github.com/ExaDev/agent-comms/commit/35529cc2a9d0eb0818af310f06be2f3b49fd1ea7))

## [3.25.0](https://github.com/ExaDev/agent-comms/compare/v3.24.0...v3.25.0) (2026-09-18)

### Features

* **bridge:** add mesh graph/trace types and REST client to the frontend ([2a03b1b](https://github.com/ExaDev/agent-comms/commit/2a03b1bfc3f4af0ce131ca931018cb907436a6b4))
* **bridge:** render a live mesh connection graph and path-trace view ([3b3a5e0](https://github.com/ExaDev/agent-comms/commit/3b3a5e0d592f43b2f017ace9d1481345f8b8260d))
* **bridge:** serve the mesh's connection graph and path trace over REST ([b7e5915](https://github.com/ExaDev/agent-comms/commit/b7e591533bbb9ff381f8573775932f5ecbd7ef84))

### Bug Fixes

* **core:** include every mesh graph edge endpoint in its own node list ([5bc68f8](https://github.com/ExaDev/agent-comms/commit/5bc68f8ca3e2745e08c8d85d4a8b5302518d2fef))

### Chores

* **deps:** add d3-force for the mesh graph view's layout ([3cd2369](https://github.com/ExaDev/agent-comms/commit/3cd236920f010d34de504a86421c8e6f3e098782))

## [3.24.0](https://github.com/ExaDev/agent-comms/compare/v3.23.0...v3.24.0) (2026-09-18)

### Features

* **bridge:** serve wire-mesh web-console as an opt-in alternate UI ([feb7971](https://github.com/ExaDev/agent-comms/commit/feb797197f117a94010312584913637234b14859))

### Documentation

* **bridge:** document AGENT_COMMS_WEB_CONSOLE_DIST ([2ad972f](https://github.com/ExaDev/agent-comms/commit/2ad972f99a356db7ca0c06f3350c315686014502))

## [3.23.0](https://github.com/ExaDev/agent-comms/compare/v3.22.0...v3.23.0) (2026-09-18)

### Features

* **bridge:** move mesh-worker's upstream connection onto oRPC ([30f2cba](https://github.com/ExaDev/agent-comms/commit/30f2cba3f6a8869663bfbab023a81062de76eb66))

## [3.22.0](https://github.com/ExaDev/agent-comms/compare/v3.21.0...v3.22.0) (2026-09-18)

### Features

* **core:** add mesh graph and trace result types to MeshTransport ([d116642](https://github.com/ExaDev/agent-comms/commit/d1166421b0f69d44bb31da4382debae659035f20))
* **core:** implement mesh_graph/mesh_trace over WireMeshTransport ([c713f3a](https://github.com/ExaDev/agent-comms/commit/c713f3adcd30de0d1f2c89622acc6cc785eb182a)), references [agent-comms#216](https://github.com/agent-comms/issues/216)
* **mesh-store:** delegate meshGraph/meshTrace to the underlying transport ([a643fc2](https://github.com/ExaDev/agent-comms/commit/a643fc290f62848a42ebfc5f322903ce159cae81))
* **tool:** add mesh_graph/mesh_trace CommsTool actions ([984efd9](https://github.com/ExaDev/agent-comms/commit/984efd90cdb545f415ced0b62492ab635a3b423c))
* **web:** implement oRPC router dark-launched on /ws/mesh-orpc ([54c4d01](https://github.com/ExaDev/agent-comms/commit/54c4d0170be36d11626b65b5bd8e9530bbb63dfd))

### Refactoring

* **core:** extract listKnownDevices' array conversion to gossip-directory ([5caba8a](https://github.com/ExaDev/agent-comms/commit/5caba8a036584b68a69961d329efa8bdb3d89ba6))
* **tool:** extract mesh discovery/advertise/listener actions to their own module ([1a253e8](https://github.com/ExaDev/agent-comms/commit/1a253e81c72e0b62fe88fb4a3c3f0afcb748c34a))

### Tests

* cover mesh_graph/mesh_trace end-to-end and at the tool layer ([7ec7bd2](https://github.com/ExaDev/agent-comms/commit/7ec7bd22f4eec7c5680904518e1d21c7629c7ed7))

### Build

* bump wire-mesh-core to 1.58.0 ([21bcafe](https://github.com/ExaDev/agent-comms/commit/21bcafe7d0452660ef7c02ae45f65bc99b76547f)), references [wire-mesh#180](https://github.com/wire-mesh/issues/180) [wire-mesh#181](https://github.com/wire-mesh/issues/181)

## [3.21.0](https://github.com/ExaDev/agent-comms/compare/v3.20.0...v3.21.0) (2026-09-18)

### Features

* **core:** gossip and read back mesh-wide package versions ([042e1fd](https://github.com/ExaDev/agent-comms/commit/042e1fdffb49487f090c63a98bc760ee82a5802b))
* **core:** read this process's own installed wire-mesh-core version ([d4d27c0](https://github.com/ExaDev/agent-comms/commit/d4d27c0444e0723e91bab173e1b8be158ac51cf5))
* **core:** surface package versions in whoami, update, and list_agents ([bfad1e1](https://github.com/ExaDev/agent-comms/commit/bfad1e187f4799bce41910dbaccf26712b86e1fa))
* **web:** add oRPC contract for the browser mesh protocol ([783d6b1](https://github.com/ExaDev/agent-comms/commit/783d6b1befc114297e70f30acfa0e2a43385f2df))

### Bug Fixes

* **bridge:** show a room's plain name instead of its owner-qualified id in the web UI ([b770724](https://github.com/ExaDev/agent-comms/commit/b770724901254caaeb02f867f797e2a5559d72c9))
* **core:** resolve a room's plain local name to its real id before every local room lookup ([79c7f3c](https://github.com/ExaDev/agent-comms/commit/79c7f3c39f3e7208a95a113653f36ff3aa83349b))

### Tests

* **bridge:** account for the owner-qualified room id in ChatArea and deep-link fixtures ([73c7056](https://github.com/ExaDev/agent-comms/commit/73c70563bf735592d7b72d71bc0fcce6e61b4006))
* **core:** cover version gossip, query_version, and formatting ([dda70ae](https://github.com/ExaDev/agent-comms/commit/dda70aef6ccfc796a2427bf971c3a2067e121234))
* **core:** reproduce ROOM_NOT_FOUND when addressing a room by its plain local name ([a601d25](https://github.com/ExaDev/agent-comms/commit/a601d25522ed830ed8a225c471648c6ad0211d4f))

### Chores

* **deps:** bump wire-mesh-core and cc-peer ([2d570cc](https://github.com/ExaDev/agent-comms/commit/2d570cc247f3c6f18a3e531fe5d9b8e8085f36f2))

## [3.20.0](https://github.com/ExaDev/agent-comms/compare/v3.19.0...v3.20.0) (2026-09-18)

### Features

* **bridge:** replace the esbuild frontend build with Vite and vite-plugin-pwa ([24358b8](https://github.com/ExaDev/agent-comms/commit/24358b8c3cf3b7f880d762218d43398ddbde9781))
* **bridge:** rewrite the web frontend UI in React and Mantine ([11c143b](https://github.com/ExaDev/agent-comms/commit/11c143b85a57d4df4d315d4ad5e12fb3773fa3d8))

### Bug Fixes

* **bridge:** destructure the server e2e fixture's first parameter ([2253fcb](https://github.com/ExaDev/agent-comms/commit/2253fcbcb4714bb030396e8a224e4b4689d61e48))
* **bridge:** pin the eslint-plugin-react React version ([b306cef](https://github.com/ExaDev/agent-comms/commit/b306cefbf0a05fcc0544929948d05cda9d3d40d4))
* **bridge:** serve index.html at its own literal path ([3ad7744](https://github.com/ExaDev/agent-comms/commit/3ad774465d2b5a25aa818aaffa3740e1954b01f9))
* **build:** update turbo's build:frontend:run inputs for the Vite config ([0a6e6c8](https://github.com/ExaDev/agent-comms/commit/0a6e6c81e6ba60548bade2292683408d7493f250))

### Refactoring

* **bridge:** give ChatArea a header landmark and disambiguate ARIA labels ([838b1dc](https://github.com/ExaDev/agent-comms/commit/838b1dccfa8ca58a9770fc3c6820eb877fabcaba))
* **bridge:** retire dom.ts, styles.css, and css.d.ts ([6465177](https://github.com/ExaDev/agent-comms/commit/6465177b412d05f777f40caa824ad5d9aa3a0518))

### Tests

* **bridge:** rewrite e2e specs for React and Mantine's rendered markup ([87c2549](https://github.com/ExaDev/agent-comms/commit/87c254938f06f1d41caa7bca10682e15f6a40a98)), references [#sidebar](https://github.com/ExaDev/agent-comms/issues/sidebar) [#header](https://github.com/ExaDev/agent-comms/issues/header) [#input](https://github.com/ExaDev/agent-comms/issues/input)
* **bridge:** rewrite frontend component tests for React and Testing Library ([1991e23](https://github.com/ExaDev/agent-comms/commit/1991e23e214ab3eded37d8c7f9eca58186862cc6))

### Chores

* **bridge:** remove dead escapeHtml, generated-html.ts and unused relay CSS ([0dcfb12](https://github.com/ExaDev/agent-comms/commit/0dcfb12b1d76d867d38f82c3399ef47479519867))
* **bridge:** swap Preact for React 19 and Mantine ([6bdbc4b](https://github.com/ExaDev/agent-comms/commit/6bdbc4b31b364f129e329a8b01919877e053b577))

## [3.19.0](https://github.com/ExaDev/agent-comms/compare/v3.18.0...v3.19.0) (2026-09-18)

### Features

* **build:** wire build/test/typecheck/lint through turbo for content-hash caching ([2d9603d](https://github.com/ExaDev/agent-comms/commit/2d9603d9c3c7d2cc936e22e8724cf843d284f4ba))

### Bug Fixes

* **lint:** lint turbo.json as JSONC instead of strict JSON ([3ce8528](https://github.com/ExaDev/agent-comms/commit/3ce8528a37a3ad41b930134ab17dcc68ae62a476))

### CI

* persist turbo's cache directory across CI runs ([4878bb9](https://github.com/ExaDev/agent-comms/commit/4878bb938f3c9490dda3318cf53e82fa65d66fe5))

## [3.18.0](https://github.com/ExaDev/agent-comms/compare/v3.17.1...v3.18.0) (2026-09-18)

### Features

* **core:** add web_url action reporting a bridge's own web UI address ([a374032](https://github.com/ExaDev/agent-comms/commit/a374032fada5514b184f438d89887153facf8f94))

### Refactoring

* **bridge:** route pi's web_url action through CommsTool ([d022b11](https://github.com/ExaDev/agent-comms/commit/d022b11bd020621767bb2212c401f6684b7ad8fa))

## [3.17.1](https://github.com/ExaDev/agent-comms/compare/v3.17.0...v3.17.1) (2026-09-18)

### Bug Fixes

* **core:** stop gating hub-relayed room-domain verbs behind bare-device trust ([e06c1c1](https://github.com/ExaDev/agent-comms/commit/e06c1c15c6056e59d82d39a643c8eadd518e1d3d)), references [#187](https://github.com/ExaDev/agent-comms/issues/187)

### Tests

* **bridge:** move port-discovery fixture ports out of the OS ephemeral port range ([ef7ee17](https://github.com/ExaDev/agent-comms/commit/ef7ee17d0952f07eead0f0c67bf0465cb9fc8191)), closes [#196](https://github.com/ExaDev/agent-comms/issues/196)
* **core:** prove a hub-relayed room.join reaches human approval untrusted ([ccc8616](https://github.com/ExaDev/agent-comms/commit/ccc86160e79a31263f3f9b60574930b03ab87c64))
* **core:** prove gossip directory-merge accepts a principal-only trust ([bbbdaf6](https://github.com/ExaDev/agent-comms/commit/bbbdaf6a6ac60226b99e036df32db4d3bf82ae0b))

## [3.17.0](https://github.com/ExaDev/agent-comms/compare/v3.16.0...v3.17.0) (2026-09-18)

### Features

* **core:** accept a principal flag on gateway_trust/gateway_untrust ([95f3b91](https://github.com/ExaDev/agent-comms/commit/95f3b9113020e1e1fdf5d3466a8372ae4ef71dd9)), references [agent-comms#187](https://github.com/agent-comms/issues/187)
* **core:** route gateway_trust/gateway_untrust to principal trust ([4fe7469](https://github.com/ExaDev/agent-comms/commit/4fe746953e2c8528933c1f4ed8a6a26756b2e0b6)), closes [#193](https://github.com/ExaDev/agent-comms/issues/193), references [agent-comms#187](https://github.com/agent-comms/issues/187)

### Refactoring

* **core:** split gateway-trust action handlers out of tool.ts ([8e1d3c6](https://github.com/ExaDev/agent-comms/commit/8e1d3c6e988cd671efdd4f5786fba45ecde635c1))

## [3.16.0](https://github.com/ExaDev/agent-comms/compare/v3.15.0...v3.16.0) (2026-09-18)

### Features

* **core:** add ConnectionCodeLedger for connection-code generation and redemption ([a47358f](https://github.com/ExaDev/agent-comms/commit/a47358f376b0574adc40226c9fa0e55ac1d7330b)), references [agent-comms#188](https://github.com/agent-comms/issues/188)
* **core:** add keyserver lookup for a connection code's signing key ([81142ad](https://github.com/ExaDev/agent-comms/commit/81142ad14b89bd39d52435bbccf46d0351350a58)), references [agent-comms#188](https://github.com/agent-comms/issues/188)
* **core:** let a principal delegate a received dm:send grant to its own device ([36456ae](https://github.com/ExaDev/agent-comms/commit/36456aeff2c36e75fb86d0090baa0459f984a2b3))
* **core:** let admitAgentForDm admit a delegable user principal ([3384982](https://github.com/ExaDev/agent-comms/commit/3384982f718f205efbd0d6d92298f90a245ebecf)), references [agent-comms#187](https://github.com/agent-comms/issues/187)
* **core:** let GatewayTrust admit a user principal, not just a bare device ([6025362](https://github.com/ExaDev/agent-comms/commit/60253626782a23ec1d5b1689e202e31a43c0321d))
* **core:** persist a per-slot connection-code ledger ([1320900](https://github.com/ExaDev/agent-comms/commit/13209006a55a2483d6f7b6919d33c1275710a8eb)), references [agent-comms#188](https://github.com/agent-comms/issues/188)
* **core:** wire gateway_generate_connection_code and gateway_redeem_connection_code ([2815ac4](https://github.com/ExaDev/agent-comms/commit/2815ac49f7dd200f2e4da50274dcb7b965cd3cfd))

### Documentation

* document gateway trust and connection codes ([60b8669](https://github.com/ExaDev/agent-comms/commit/60b866922a631d92920f308645ddccdba11c9d1f))

### Styles

* **core:** match prettier's multiline formatting for the gateway-trust object literals ([f45fca8](https://github.com/ExaDev/agent-comms/commit/f45fca8749de884ff21442b5b90fdbc7d712bf9b))

### Tests

* **core:** cover gateway_generate_connection_code and gateway_redeem_connection_code end to end ([c5ba830](https://github.com/ExaDev/agent-comms/commit/c5ba8301ce5ccd1b24b2ff677eebecdca26d4d46))
* **core:** prove a principal's own device auto-admits via a delegated dm:send token ([f1c4da9](https://github.com/ExaDev/agent-comms/commit/f1c4da9dc5492b2f15ac8ac9cb60a5a2f8dee427)), references [agent-comms#187](https://github.com/agent-comms/issues/187)

## [3.15.0](https://github.com/ExaDev/agent-comms/compare/v3.14.0...v3.15.0) (2026-09-18)

### Features

* **core:** let GatewayTrust load and persist its allowlist per bridge slot ([edc40d7](https://github.com/ExaDev/agent-comms/commit/edc40d71950aacbbef782bcc660e5e3619a97df2))
* **core:** persist a slot's trusted-gateway device-id set ([a338522](https://github.com/ExaDev/agent-comms/commit/a338522f6e969708691cecc29ff5b43c21bd66e8))
* **core:** thread the identity slot through to MeshStore's gatewayTrust ([c41ef73](https://github.com/ExaDev/agent-comms/commit/c41ef73efb2e96b81e1c8f66a22b81f7dd8a1baa))

## [3.14.0](https://github.com/ExaDev/agent-comms/compare/v3.13.0...v3.14.0) (2026-09-17)

### Features

* **core:** route hub-relayed requests to the correct local peer via toDevice ([4d64d05](https://github.com/ExaDev/agent-comms/commit/4d64d05433e739b4c3a65fbcfaa54a11fc0859f9))

### Chores

* **deps:** bump wire-mesh-core to 1.48.2 ([0d23e12](https://github.com/ExaDev/agent-comms/commit/0d23e12e05d9f2a1f3448517e1bee92e988d3a11)), references [wire-mesh#175](https://github.com/wire-mesh/issues/175)

## [3.13.0](https://github.com/ExaDev/agent-comms/compare/v3.12.0...v3.13.0) (2026-09-17)

### Features

* **core:** add GatewayTrust, the cross-machine gateway allowlist ([4060f76](https://github.com/ExaDev/agent-comms/commit/4060f7670e98b7f31c87421ccc5d752d98ccaa08))
* **core:** expose gateway trust as gateway_trust/gateway_untrust/gateway_list_trusted tool actions ([703ae00](https://github.com/ExaDev/agent-comms/commit/703ae00da078c4436a617a3859d9c86ae2aa2355))
* **core:** gate hub gossip forwarding on gateway trust ([3f2b7c7](https://github.com/ExaDev/agent-comms/commit/3f2b7c7cdfeea81007e3ef483792db5a84bcc733))
* **core:** gate hub session dispatch and directory merge on gateway trust ([f11f82e](https://github.com/ExaDev/agent-comms/commit/f11f82e25d69e13e91cd02416c89b6d02a0bc801))
* **core:** wire GatewayTrust through MeshStore and WireMeshTransport ([3e63783](https://github.com/ExaDev/agent-comms/commit/3e63783f355e656d1395b2a12f72f3e605614911))

### Bug Fixes

* **core:** gate readvertiseGossip's own hub-directed self-advert on gateway trust ([e75ef0b](https://github.com/ExaDev/agent-comms/commit/e75ef0b64a4b31765d2624f72e4764acdecbd91d))

### Documentation

* **core:** escape angle-bracket type refs in GatewayTrust doc comments ([ae74011](https://github.com/ExaDev/agent-comms/commit/ae74011ed1e036acc19d623db005cfe617895342))

### Styles

* **core:** apply eslint/prettier autofix to hub-forwarding.test.ts ([48a0fd5](https://github.com/ExaDev/agent-comms/commit/48a0fd5f3556f0f7d8fa39c02c743c72838edd21))

### Tests

* **core:** cover sendRoomRequest's gateway-trust gate in its own file ([c5a377a](https://github.com/ExaDev/agent-comms/commit/c5a377a87f6b79277c40e9e76ede6f6fc78c2347))
* **core:** establish mutual gateway trust in hub-session integration tests ([fb2f5d1](https://github.com/ExaDev/agent-comms/commit/fb2f5d18de7e16732cb1eea03dcacb4588e6ad0d)), references [agent-comms#156](https://github.com/agent-comms/issues/156) [#169](https://github.com/ExaDev/agent-comms/issues/169)
* **core:** prove gateway trust's deny-by-default posture end to end ([7559c21](https://github.com/ExaDev/agent-comms/commit/7559c212cca909b1e3ec43d799340fa9370f70a1))
* **core:** trust remote devices explicitly in gateway forwarding tests ([685b754](https://github.com/ExaDev/agent-comms/commit/685b75481dc7e0d862c86c51ff60060cb18479ab)), references [agent-comms#156](https://github.com/agent-comms/issues/156)

## [3.12.0](https://github.com/ExaDev/agent-comms/compare/v3.11.0...v3.12.0) (2026-09-17)

### Features

* **bridge:** add reply-alias name derivation and directory ([832e5c0](https://github.com/ExaDev/agent-comms/commit/832e5c05080c8d5b44be5e137e836f0b6d6459fa))
* **bridge:** construct the shared AliasPool for the default front ([ca208f5](https://github.com/ExaDev/agent-comms/commit/ca208f5758b8524297ab1ca6c33d0b8a96232997))
* **bridge:** route alias replies through the front controller ([cb4c956](https://github.com/ExaDev/agent-comms/commit/cb4c9565bf9484e429b9811b1e124c80c2b2c2a4))
* **bridge:** wire reply aliases into the fronted-session relay ([bee76d5](https://github.com/ExaDev/agent-comms/commit/bee76d5798676d96abab7d97311d119cb51d2fff))

### Documentation

* document the reply half of the default cc-peer front ([55e5add](https://github.com/ExaDev/agent-comms/commit/55e5adde54a9fff725514ca209f193c38e2e4451))

### Chores

* **deps:** bump cc-peer to 1.4.1 for the alias-pool subpath ([738e7d5](https://github.com/ExaDev/agent-comms/commit/738e7d58856e78c9e1d4c2cc4ead1aa3b8be223a)), references [agent-comms#158](https://github.com/agent-comms/issues/158) [agent-comms#40](https://github.com/agent-comms/issues/40)

## [3.11.0](https://github.com/ExaDev/agent-comms/compare/v3.10.0...v3.11.0) (2026-09-17)

### Features

* **core:** add CapabilityAskAdmission for the ask tier's held-open capability requests ([cfb1a6b](https://github.com/ExaDev/agent-comms/commit/cfb1a6b6d5b690d0942fdc355912cd72b7885df5))
* **core:** surface capability_request events and the accept/reject/pending actions ([84b5d7c](https://github.com/ExaDev/agent-comms/commit/84b5d7c7cc19bcfcbd1361d1af1bea6bb99f1d2b))
* **release:** retry connection-level and expired-JWT MCP publish failures ([9629703](https://github.com/ExaDev/agent-comms/commit/9629703d7d7cc8d95bf51385057d9578ae9b3cc0))

### Bug Fixes

* **release:** re-login before each MCP registry publish retry ([9f77176](https://github.com/ExaDev/agent-comms/commit/9f7717619a54fe9aad65b106a31f6ded3bad1776))

## [3.10.0](https://github.com/ExaDev/agent-comms/compare/v3.9.0...v3.10.0) (2026-09-17)

### Features

* **core:** add PeerLifecycle.sendCoordinatorHandover ([47824d8](https://github.com/ExaDev/agent-comms/commit/47824d8a6119985a45aa30df16c6fbbad73cd373))
* **core:** forward gossip and room-domain requests between the local mesh and the hub ([5f0dfba](https://github.com/ExaDev/agent-comms/commit/5f0dfbaa787e868571b96657c199d05e50de5be2)), references [agent-comms#154](https://github.com/agent-comms/issues/154)
* **core:** gate DM admission on a user-issued dm:send capability ([b61348c](https://github.com/ExaDev/agent-comms/commit/b61348c13869cde621497e4c85a770f0a7a7210b))
* **core:** persist issued dm:send grants on the user principal ([2df7a33](https://github.com/ExaDev/agent-comms/commit/2df7a3301537a3b33c04255c45bc22425ce47da5))
* **core:** resolve gossip-discovered agents in getAgent and sendDm ([50af385](https://github.com/ExaDev/agent-comms/commit/50af385d0c9115379ba4e849a1eb6370190d746c)), references [agent-comms#155](https://github.com/agent-comms/issues/155)
* **core:** thread the user principal identity through MeshStoreIdentity ([1a32c68](https://github.com/ExaDev/agent-comms/commit/1a32c68d32b00bed2dde1345dd8450e9f351614c)), references [agent-comms#160](https://github.com/agent-comms/issues/160) [agent-comms#162](https://github.com/agent-comms/issues/162)
* **core:** verify dm:send capability tokens against the user principal ([62ceb84](https://github.com/ExaDev/agent-comms/commit/62ceb8484b44bdab48b45dfb7614caaf2e34811a))
* **core:** wire graceful coordinator handover into MeshStore.shutdown ([afd98f6](https://github.com/ExaDev/agent-comms/commit/afd98f662696d8ab8b3ed1d41f9e662bf7d74d34))

### Bug Fixes

* **core:** retry becomeCoordinator's bind after EADDRINUSE ([0d6cd6f](https://github.com/ExaDev/agent-comms/commit/0d6cd6f6642ae1d02c8af5b940d06bb34490a66c)), references [agent-comms#170](https://github.com/agent-comms/issues/170)

### Refactoring

* **core:** avoid a redundant array copy in sendCoordinatorHandover ([a332021](https://github.com/ExaDev/agent-comms/commit/a33202199da8267dd825546aded5eccba13e846f))

### Styles

* **core:** reformat isStoredUserIdentity's issuedDeviceGrants check ([1896ff4](https://github.com/ExaDev/agent-comms/commit/1896ff4b3e6d226533d499f21b13dce573979c0e))

### Tests

* **core:** cover gateway forwarding end to end over a real relay hub ([7f98815](https://github.com/ExaDev/agent-comms/commit/7f988151a2aa5dbc0fcdb55bbba4064113b5685b)), references [agent-comms#155](https://github.com/agent-comms/issues/155)
* **core:** randomise mesh-e2e's coordinator port ([bed922e](https://github.com/ExaDev/agent-comms/commit/bed922eacf61a02684ea40913ea9bddbfb671842))

## [3.9.0](https://github.com/ExaDev/agent-comms/compare/v3.8.0...v3.9.0) (2026-09-17)

### Features

* **bridges:** wire the default cc-peer front into every real bridge entry point ([4bb8def](https://github.com/ExaDev/agent-comms/commit/4bb8def55a924bf7ecd62c365ded75bb35ebf9a6))
* **cc-peer:** add DI-testable relay wiring for one fronted session ([7113949](https://github.com/ExaDev/agent-comms/commit/7113949b5968e94d02eb9e4d940908d1a6bc2039))
* **cc-peer:** add pure roster-selection and inbound-routing logic for the default front ([84b058d](https://github.com/ExaDev/agent-comms/commit/84b058d2d1f0b4e3620ebcb8bfed1baa4340eba5)), references [agent-comms#157](https://github.com/agent-comms/issues/157)
* **cc-peer:** add the coordinator-only periodic front controller ([d739908](https://github.com/ExaDev/agent-comms/commit/d739908fbd133ba0197cc9c2b3724418236cfefc))
* **cc-peer:** add the store.onCoordinatorRoleChanged glue for the default front ([668fbf2](https://github.com/ExaDev/agent-comms/commit/668fbf21de0231a7c74593b22c3325d3cdcbb915))
* **cc-peer:** wire the default front's real cc-peer/MeshStore construction ([4d8dcb7](https://github.com/ExaDev/agent-comms/commit/4d8dcb7077ceb841fe030b271da97d1806280001))
* **core:** add an onCoordinatorRoleChanged hook to MeshStore ([401b1f8](https://github.com/ExaDev/agent-comms/commit/401b1f8a5c257fcb6f6cd761820335cbe0af65f0)), references [agent-comms#157](https://github.com/agent-comms/issues/157)
* **core:** add read-only slot probing and lock-free identity loading ([63e9964](https://github.com/ExaDev/agent-comms/commit/63e99644a914441420ab9381ad8686fe00a9f2e5))

### Refactoring

* **core:** split bridge-mesh construction from identity loading ([5e9615e](https://github.com/ExaDev/agent-comms/commit/5e9615e0fa0aba8e0204c874e7a9e903a56f4fce)), references [agent-comms#157](https://github.com/agent-comms/issues/157)

### Documentation

* **readme:** document the default cc-peer front ([71c1d5c](https://github.com/ExaDev/agent-comms/commit/71c1d5c368d41a48300d54271b10c95c548c3d55))

### Styles

* **core:** satisfy prettier formatting for the new identity-store tests ([dcf42d0](https://github.com/ExaDev/agent-comms/commit/dcf42d06f8a6072ae46468d806cfcb50d40e5428))

## [3.8.0](https://github.com/ExaDev/agent-comms/compare/v3.7.0...v3.8.0) (2026-09-17)

### Features

* **core:** add issuer-side delegation policy resolver ([4d1a4a4](https://github.com/ExaDev/agent-comms/commit/4d1a4a4aec00d1e63918c8a9e8717f8606c0ed30))
* **core:** add VersionDriftChecker for npm release drift detection ([d6ac974](https://github.com/ExaDev/agent-comms/commit/d6ac9744910ae4860fedd15ec0330487c28b5a16))
* **core:** admit and remove a device from the user principal's group ([23a6864](https://github.com/ExaDev/agent-comms/commit/23a6864d5d813ce166f78f7602bad5ea4868cd1a))
* **core:** read this package's own version from package.json ([0590d33](https://github.com/ExaDev/agent-comms/commit/0590d33f41e40cf89ea63f524afa1f34775f0ba1))
* **core:** record the user principal's own issued device-membership grants ([980dee4](https://github.com/ExaDev/agent-comms/commit/980dee49ff16937967e3965a4f21ff387af68a63))
* **core:** start a VersionDriftChecker for every bridge on construction ([8c09b02](https://github.com/ExaDev/agent-comms/commit/8c09b02fad3d49fafca151aa350381d027efbfa1))
* **core:** store a device's own held group:member token ([0ee1eff](https://github.com/ExaDev/agent-comms/commit/0ee1eff48dc138d978a68a511c16903512441fe8))
* **core:** surface this bridge's own version in whoami/update output ([9bb5215](https://github.com/ExaDev/agent-comms/commit/9bb5215a25799779764dfa6ba08e637aafd24313))
* **core:** verify group:member device-membership tokens ([2ba0a7a](https://github.com/ExaDev/agent-comms/commit/2ba0a7a7e6044cb181c691d879c247a77aa54e20))
* **core:** wire room:member mints through the delegation policy ([4817398](https://github.com/ExaDev/agent-comms/commit/4817398a00e6b5cf5b5ea342b31679cf957b2f80))

### Bug Fixes

* **core:** narrow resolveDelegationsRemaining's return type by overload ([8bd2a35](https://github.com/ExaDev/agent-comms/commit/8bd2a35d69010972db29bc065d16493750a60dc8))

### Styles

* **core:** keep isVersionedPackageJson's signature on one line ([6179f70](https://github.com/ExaDev/agent-comms/commit/6179f70a8e2569b0b9c7c90d529e4964e3b08bd5))

## [3.7.0](https://github.com/ExaDev/agent-comms/compare/v3.6.0...v3.7.0) (2026-09-17)

### Features

* **core:** route a capability-request up its issuer chain ([6f96357](https://github.com/ExaDev/agent-comms/commit/6f963570712e134cbfcbfae06b1c0d4be97efe08)), references [agent-comms#164](https://github.com/agent-comms/issues/164)

### Tests

* **core:** add failing specs for issuer-chain bubble-up routing ([525d9b6](https://github.com/ExaDev/agent-comms/commit/525d9b6705f59e7d24ace36546173191db67af07))

## [3.6.0](https://github.com/ExaDev/agent-comms/compare/v3.5.0...v3.6.0) (2026-09-17)

### Features

* **core:** add connectHub/disconnectHub to the transport contract ([8e67e64](https://github.com/ExaDev/agent-comms/commit/8e67e64b9babb5a31f30a26d0dae6c81e3466495))
* **core:** add CoordinatorGateway connection-lifecycle collaborator ([9c6634c](https://github.com/ExaDev/agent-comms/commit/9c6634c022f6b55699b33f5f51272c26b7b406e9))
* **core:** thread hubUrl through createBridgeMesh/createBridgeMeshSync ([f7aaaea](https://github.com/ExaDev/agent-comms/commit/f7aaaeaf0b8b22f6c824b7bfe6293d34231a75ce))
* **core:** wire CoordinatorGateway into MeshStore's become/lose paths ([27f3b90](https://github.com/ExaDev/agent-comms/commit/27f3b90a35aac40c71854abc13fe7decd40dcbd6))

### Bug Fixes

* **core:** drop state_sync/state_update relayed by hub peers ([9db4d68](https://github.com/ExaDev/agent-comms/commit/9db4d68dc862ae5c512bd0c274e7f7b01f1c1c7a)), references [#169](https://github.com/ExaDev/agent-comms/issues/169) [#151](https://github.com/ExaDev/agent-comms/issues/151)
* **core:** isolate a hub dial failure from local coordinator election ([2100b2c](https://github.com/ExaDev/agent-comms/commit/2100b2c33c0062b440c95282e6deb53f1d178724))

### Tests

* **core:** extract real-hub-over-ws test harness into hub-helpers ([fd47fde](https://github.com/ExaDev/agent-comms/commit/fd47fdecfa9eddc9c5a9fab6b93a255e4974ce64))
* **core:** point the multi-process smoke test at an unreachable hub ([5cd582a](https://github.com/ExaDev/agent-comms/commit/5cd582af5841a0456fa5aea09cbc48bf63727d42)), references [agent-comms#154](https://github.com/agent-comms/issues/154)

## [3.5.0](https://github.com/ExaDev/agent-comms/compare/v3.4.2...v3.5.0) (2026-09-17)

### Features

* **core:** add a persisted user-principal identity ([9f175eb](https://github.com/ExaDev/agent-comms/commit/9f175eb01c0f7caee222043558fc48e8de0ad0b6))

## [3.4.2](https://github.com/ExaDev/agent-comms/compare/v3.4.1...v3.4.2) (2026-09-17)

### Chores

* **deps:** bump actions/upload-artifact from 4 to 7 ([e039d67](https://github.com/ExaDev/agent-comms/commit/e039d67672bb33868659adbe0da214612bfcbc60))

## [3.4.1](https://github.com/ExaDev/agent-comms/compare/v3.4.0...v3.4.1) (2026-09-17)

### Documentation

* **build:** add the production hub smoke check ([d3afe07](https://github.com/ExaDev/agent-comms/commit/d3afe07db31eea334a287eca9655592f029af222))

## [3.4.0](https://github.com/ExaDev/agent-comms/compare/v3.3.0...v3.4.0) (2026-09-17)

### Features

* **core:** add hub relay mode ([e0313e4](https://github.com/ExaDev/agent-comms/commit/e0313e46e81180031d7f8cbf3136eadeef15fa76)), closes [#151](https://github.com/ExaDev/agent-comms/issues/151)

## [3.3.0](https://github.com/ExaDev/agent-comms/compare/v3.2.0...v3.3.0) (2026-09-16)

### Features

* **core:** dial remote connections over ws or wss URLs ([99841b8](https://github.com/ExaDev/agent-comms/commit/99841b874ec3216395e30b6ec9b2961e431728a5)), closes [#149](https://github.com/ExaDev/agent-comms/issues/149)

## [3.2.0](https://github.com/ExaDev/agent-comms/compare/v3.1.0...v3.2.0) (2026-09-16)

### Features

* **bridge:** add a cc-peer bridge for cross-machine Claude Code relay ([80ce989](https://github.com/ExaDev/agent-comms/commit/80ce989e02366b17415edd45f7e430d0b0c14aa8))

## [3.1.0](https://github.com/ExaDev/agent-comms/compare/v3.0.2...v3.1.0) (2026-09-16)

### Features

* **core:** gossip operator-registered listener addresses (wire-mesh[#38](https://github.com/ExaDev/agent-comms/issues/38)) ([6a5c887](https://github.com/ExaDev/agent-comms/commit/6a5c887dd350ca23fbd33500d981efea64b9899a)), references [#92](https://github.com/ExaDev/agent-comms/issues/92)

## [3.0.2](https://github.com/ExaDev/agent-comms/compare/v3.0.1...v3.0.2) (2026-09-16)

### Bug Fixes

* **core:** name the actual mismatch when the mesh coordinator port is unusable ([97fcae2](https://github.com/ExaDev/agent-comms/commit/97fcae2630cd0e5427a6778559acdc35541d8e07))

## [3.0.1](https://github.com/ExaDev/agent-comms/compare/v3.0.0...v3.0.1) (2026-09-16)

### Bug Fixes

* **bridge:** stop the mesh SharedWorker merging patches on top of stale local state ([92f352e](https://github.com/ExaDev/agent-comms/commit/92f352e44da35fdf0d1e42ab9f9efa24b25475df))

## [3.0.0](https://github.com/ExaDev/agent-comms/compare/v2.31.1...v3.0.0) (2026-09-16)

### ⚠ BREAKING CHANGES

* **core:** retire federation.ts in favour of wire-mesh's own connectToRemote

### Features

* **core:** retire federation.ts in favour of wire-mesh's own connectToRemote ([4232b08](https://github.com/ExaDev/agent-comms/commit/4232b08041e4dad95b6e45d4247a00462d24cae2)), references [agent-comms#48](https://github.com/agent-comms/issues/48)

## [2.31.1](https://github.com/ExaDev/agent-comms/compare/v2.31.0...v2.31.1) (2026-09-16)

### Bug Fixes

* **core:** actually re-advertise on discovery visibility resume ([76c00ac](https://github.com/ExaDev/agent-comms/commit/76c00acd3af713629782f277fbc2b0880bda1389))

## [2.31.0](https://github.com/ExaDev/agent-comms/compare/v2.30.0...v2.31.0) (2026-09-16)

### Features

* **core:** retire the last two mesh-wide broadcast sites for directed room.notify ([ffd60b8](https://github.com/ExaDev/agent-comms/commit/ffd60b8de24cc70c3fd443c68f3c1f331711da0b))

## [2.30.0](https://github.com/ExaDev/agent-comms/compare/v2.29.0...v2.30.0) (2026-09-16)

### Features

* **core:** retire two more mesh-wide broadcast sites for directed room.notify ([60b331c](https://github.com/ExaDev/agent-comms/commit/60b331c275f13746519f51be0b9a9f31f3047613))

## [2.29.0](https://github.com/ExaDev/agent-comms/compare/v2.28.0...v2.29.0) (2026-09-16)

### Features

* **core:** retire deliverToRoom's mesh-wide broadcast for a real directed room.notify ([7c0a606](https://github.com/ExaDev/agent-comms/commit/7c0a60689d2c077cf1359e399e5675f50cd273be)), references [agent-comms#48](https://github.com/agent-comms/issues/48)

## [2.28.0](https://github.com/ExaDev/agent-comms/compare/v2.27.0...v2.28.0) (2026-09-16)

### Features

* **core:** gossip this side's own agent identity and merge discoveries into listAgents ([1fe110f](https://github.com/ExaDev/agent-comms/commit/1fe110ffa550f0b285a68895599e3b9c552841fe)), references [#138](https://github.com/ExaDev/agent-comms/issues/138)

## [2.27.0](https://github.com/ExaDev/agent-comms/compare/v2.26.0...v2.27.0) (2026-09-16)

### Features

* **core:** merge gossip-discovered rooms into listRooms ([a753487](https://github.com/ExaDev/agent-comms/commit/a753487ec24e50207169c0432ba7db8a913ebea9)), references [131/#132](https://github.com/ExaDev/agent-comms/issues/132)

## [2.26.0](https://github.com/ExaDev/agent-comms/compare/v2.25.0...v2.26.0) (2026-09-16)

### Features

* **core:** wire sendRoomMessage's opt-in durable-recording flag ([a93ecff](https://github.com/ExaDev/agent-comms/commit/a93ecff33a22050960f122642585024a5b49c582)), references [#135](https://github.com/ExaDev/agent-comms/issues/135) [#136](https://github.com/ExaDev/agent-comms/issues/136)

## [2.25.0](https://github.com/ExaDev/agent-comms/compare/v2.24.2...v2.25.0) (2026-09-16)

### Features

* **core:** record a room.send as a durable room-notice in the sender's own oplog ([090af14](https://github.com/ExaDev/agent-comms/commit/090af14a80d5cfa0c5bfd92b6aa7f01e88ff7d66))
* **core:** wire core/data's sync protocol into WireMeshTransport's frame handling ([5b29146](https://github.com/ExaDev/agent-comms/commit/5b29146d865d813779257ed7e1f2eca24cccdd8f)), references [wire-mesh#102](https://github.com/wire-mesh/issues/102)

## [2.24.2](https://github.com/ExaDev/agent-comms/compare/v2.24.1...v2.24.2) (2026-09-16)

### Chores

* **deps:** bump wire-mesh-core from 1.30.0 to 1.30.1 ([01321f4](https://github.com/ExaDev/agent-comms/commit/01321f4f704e66b1d79c1da299e34ed47ad887d6))

## [2.24.1](https://github.com/ExaDev/agent-comms/compare/v2.24.0...v2.24.1) (2026-09-16)

### Chores

* **deps:** bump wire-mesh-core from 1.13.0 to 1.30.0 ([2cbe843](https://github.com/ExaDev/agent-comms/commit/2cbe843b62fb7467209f38f5d65955c91b8a8818)), references [wire-mesh#84](https://github.com/wire-mesh/issues/84)

## [2.24.0](https://github.com/ExaDev/agent-comms/compare/v2.23.0...v2.24.0) (2026-09-16)

### Features

* **core:** wire this store's own rooms into the hosted-rooms gossip ([d592f4a](https://github.com/ExaDev/agent-comms/commit/d592f4ae8aeebd0ae2ec59c3eddb6f36753b8725))

## [2.23.0](https://github.com/ExaDev/agent-comms/compare/v2.22.0...v2.23.0) (2026-09-16)

### Features

* **core:** gossip this side's own currently-hosted public/private rooms ([76dbc44](https://github.com/ExaDev/agent-comms/commit/76dbc44faa9725e455acdd1bc3f40055661ba1de))

## [2.22.0](https://github.com/ExaDev/agent-comms/compare/v2.21.19...v2.22.0) (2026-09-16)

### Features

* **core:** aggregate a mesh-wide known-devices view from gossip ([a8c3749](https://github.com/ExaDev/agent-comms/commit/a8c37498419f2c6e13802e46c5a624e5f1a7d307))

## [2.21.19](https://github.com/ExaDev/agent-comms/compare/v2.21.18...v2.21.19) (2026-09-16)

### Tests

* **core:** assert RoomLifecycle's CRUD, join/leave, and grant logic directly ([246b56c](https://github.com/ExaDev/agent-comms/commit/246b56cdeecc8b16a57132a09a7f9b495cbec6cf))
* **core:** close four more real gaps found in a fresh RoomLifecycle run ([878a5c7](https://github.com/ExaDev/agent-comms/commit/878a5c7641a6ad93aef689e1133902a90d6de805))
* **core:** close sixteen real gaps in RoomLifecycle mutation coverage ([6542bd6](https://github.com/ExaDev/agent-comms/commit/6542bd6ee76dc535fb932712e128fda0928ab4c4))

## [2.21.18](https://github.com/ExaDev/agent-comms/compare/v2.21.17...v2.21.18) (2026-09-15)

### Tests

* **core:** assert DeliveryEngine's queueing, merge, and delivery logic directly ([82bb16b](https://github.com/ExaDev/agent-comms/commit/82bb16bda8728fb6a6e99d3817fb56b6a73a9146))
* **core:** close applyPatch(agent_offline)'s missing gap, document a real equivalent ([843e019](https://github.com/ExaDev/agent-comms/commit/843e019915c9f62e05ab890ab47736d86e6f8098))
* **core:** close six real gaps in DeliveryEngine mutation coverage ([e32969b](https://github.com/ExaDev/agent-comms/commit/e32969b98b3c26b349ec585d42c1b973313c35bd))
* **core:** document the three remaining equivalent DeliveryEngine mutants ([3982352](https://github.com/ExaDev/agent-comms/commit/39823526e6e9d38f9f1bbd19153493f878db203d))

## [2.21.17](https://github.com/ExaDev/agent-comms/compare/v2.21.16...v2.21.17) (2026-09-15)

### Tests

* **core:** assert RoomProtocol's wire-verb handlers and token verification directly ([08f1a77](https://github.com/ExaDev/agent-comms/commit/08f1a773caf919e081b3eeb3cbe60f03a8428094))
* **core:** close two real gaps in DM-send and handleRoomMembers coverage ([0a6e69a](https://github.com/ExaDev/agent-comms/commit/0a6e69a51d74f22b4caaaf80ae3548e37bd4a848))

## [2.21.16](https://github.com/ExaDev/agent-comms/compare/v2.21.15...v2.21.16) (2026-09-15)

### Tests

* **mesh-store:** assert MeshStore's own orchestration logic directly ([78a1f76](https://github.com/ExaDev/agent-comms/commit/78a1f76c501d3d8aeb7b97a13e196f2941154eb7))
* **mesh-store:** close four more real gaps a fresh mutation run surfaced ([0ad906b](https://github.com/ExaDev/agent-comms/commit/0ad906bbe59df9a900e89fab9be2d04052d148bf))
* **mesh-store:** close two more real gaps, init()'s onError message and isShutDown ([60e3e18](https://github.com/ExaDev/agent-comms/commit/60e3e18de17c3fa7fb61837c8f7ed644a53c9bac))
* **mesh-store:** fix isShutDown test to actually reach the guarded branch ([13f94ab](https://github.com/ExaDev/agent-comms/commit/13f94ab86e79ac8e776c8f8f33a4c2d6a958c2da))

## [2.21.15](https://github.com/ExaDev/agent-comms/compare/v2.21.14...v2.21.15) (2026-09-15)

### Tests

* **core:** assert RoomMessaging's optional-field spreads and DM key derivation directly ([ba88af3](https://github.com/ExaDev/agent-comms/commit/ba88af365a23a1c4dd9609e189976a0031310090))
* **core:** close three real gaps, document readRoomMessages' since='' equivalent ([6f594e8](https://github.com/ExaDev/agent-comms/commit/6f594e813e0ec52ffd3225d265b30a0f818070b3))
* **core:** correct equivalent-mutant documentation for readRoomMessages ([d68d991](https://github.com/ExaDev/agent-comms/commit/d68d991eb67678abf6341462fe8a60871debc37c))

## [2.21.14](https://github.com/ExaDev/agent-comms/compare/v2.21.13...v2.21.14) (2026-09-15)

### Tests

* **core:** assert FederationBridge's fed:-prefix and filtering logic directly ([a774a84](https://github.com/ExaDev/agent-comms/commit/a774a844ea0bda6c866353c9efe96d48df285808))
* **core:** assert onRoomLeave calls refreshMembership, document equivalent Map.set mutants ([884170b](https://github.com/ExaDev/agent-comms/commit/884170b33f3632382f98125c9fbc269e1253c9b1))

## [2.21.13](https://github.com/ExaDev/agent-comms/compare/v2.21.12...v2.21.13) (2026-09-15)

### Tests

* **core:** assert PeerLifecycle's dispatch and self-connect guards directly ([4ec2e40](https://github.com/ExaDev/agent-comms/commit/4ec2e400a7dabab0d2ccd35e1ffa83b196337003))

## [2.21.12](https://github.com/ExaDev/agent-comms/compare/v2.21.11...v2.21.12) (2026-09-15)

### Tests

* **core:** assert ConnectionApproval's admission and fallback behaviour directly ([76e04a4](https://github.com/ExaDev/agent-comms/commit/76e04a4b1e5c7f282cb7eaf6bc8d9dbf5841bb57))

## [2.21.11](https://github.com/ExaDev/agent-comms/compare/v2.21.10...v2.21.11) (2026-09-15)

### Tests

* **core:** assert AgentRegistry's identity cache, registration, and lifecycle directly ([3382e82](https://github.com/ExaDev/agent-comms/commit/3382e8227a54e7a8c3e074c2c9902e5082e270a2))
* **core:** document setAgentOffline's equivalent redundant-Map.set mutant ([e89130a](https://github.com/ExaDev/agent-comms/commit/e89130a461e4e719a38cc1422852e5f1cf9b2f62))

## [2.21.10](https://github.com/ExaDev/agent-comms/compare/v2.21.9...v2.21.10) (2026-09-15)

### Tests

* **core:** assert wire-mesh-transport's shutdown/unref cleanup mechanisms directly ([629cc8c](https://github.com/ExaDev/agent-comms/commit/629cc8c13f1b9b24839e719508d5a49a38e60eb9))

## [2.21.9](https://github.com/ExaDev/agent-comms/compare/v2.21.8...v2.21.9) (2026-09-14)

### Tests

* **core:** add dedicated coverage for mesh-store-shared ([d9a5c4d](https://github.com/ExaDev/agent-comms/commit/d9a5c4d7da45b062738ceeadd1d27b1fbcf48854))

## [2.21.8](https://github.com/ExaDev/agent-comms/compare/v2.21.7...v2.21.8) (2026-09-14)

### Styles

* **core:** satisfy the newly-adopted no-magic-numbers rule ([df2eefd](https://github.com/ExaDev/agent-comms/commit/df2eefd5e8e290f72ad9a91b6ef295e6cfe5fced))

### Tests

* **core:** add dedicated coverage for StaleAgentChecker ([66b7bba](https://github.com/ExaDev/agent-comms/commit/66b7bba8775c1cd1b6ec7a57c7fb2c73669c9b81))
* **core:** kill start/stop and purge-boundary mutants in StaleAgentChecker ([b36e00a](https://github.com/ExaDev/agent-comms/commit/b36e00ae8bb084c1ed9c279b8c7a731ca83de685))

## [2.21.7](https://github.com/ExaDev/agent-comms/compare/v2.21.6...v2.21.7) (2026-09-14)

### Bug Fixes

* **bridge:** isolate the web-server test suite's coordinator port ([e6edc27](https://github.com/ExaDev/agent-comms/commit/e6edc27834a431a6b5d071599186d8e639f65a4a))
* **bridge:** resolve @exadev/eslint-config fallout in non-web bridges ([c7dfb03](https://github.com/ExaDev/agent-comms/commit/c7dfb0311727a88770049317b7bf0addafa887eb))
* **bridge:** resolve @exadev/eslint-config fallout in web frontend/server ([b4ba944](https://github.com/ExaDev/agent-comms/commit/b4ba94406368c61e0170fb557f733e7b0e628650))
* **bridge:** resolve @exadev/eslint-config fallout in web tests ([246340f](https://github.com/ExaDev/agent-comms/commit/246340f085de7e3d135d90d4d1999ed033c70545))
* **cli:** resolve @exadev/eslint-config fallout in cli.ts and scripts ([484ef0f](https://github.com/ExaDev/agent-comms/commit/484ef0f21f8da0d11037a82fe1e6d9bfd66bece9))
* **core:** resolve @exadev/eslint-config fallout in src/test ([6039f77](https://github.com/ExaDev/agent-comms/commit/6039f77de6192bd741e9c29cf4b6c9b863c213ed))
* **core:** resolve exadev/eslint-config fallout with real behavioural fixes ([1b52de1](https://github.com/ExaDev/agent-comms/commit/1b52de117b013957ff65dee967148d9ababeafe9))
* **core:** resolve remaining @exadev/eslint-config fallout in src/core ([f390757](https://github.com/ExaDev/agent-comms/commit/f39075764b27ebab2874612791069aa527ceafed))

### Build

* **deps:** adopt @exadev/eslint-config and bump to pnpm 12.4.1 ([bf38aab](https://github.com/ExaDev/agent-comms/commit/bf38aab2fa3395422a3e6b9cdf16b227f5388610))

## [2.21.6](https://github.com/ExaDev/agent-comms/compare/v2.21.5...v2.21.6) (2026-09-14)

### Tests

* **core:** cover accepting-side disconnect wiring and dial dedup cleanup ([e408ca1](https://github.com/ExaDev/agent-comms/commit/e408ca187076e0507dee409b44ed73b3df6f0bad))

## [2.21.5](https://github.com/ExaDev/agent-comms/compare/v2.21.4...v2.21.5) (2026-09-14)

### Tests

* **core:** cover presence early-return and pending-connection expiry message ([6987407](https://github.com/ExaDev/agent-comms/commit/69874070c4a96765f2b8e5f05ccdab847d43903f))
* **core:** cover WireMeshTransport constants, presence interval, and connect_request lifecycle ([af64ab7](https://github.com/ExaDev/agent-comms/commit/af64ab7b9c3d222d6794256f9d1b84bcb5c7eaba))
* **core:** drop unused AgentStatus type import ([258e5df](https://github.com/ExaDev/agent-comms/commit/258e5df90ce671fed5317d1b63e10ab68fc5b370))

## [2.21.4](https://github.com/ExaDev/agent-comms/compare/v2.21.3...v2.21.4) (2026-09-14)

### Tests

* **core:** assert Basic Constraints criticality and PEM line wrapping ([5027e62](https://github.com/ExaDev/agent-comms/commit/5027e620b7160d2a2a34c2a356fc33b858eff112))
* **core:** assert notBefore/notAfter as an exact zero-padded date ([315275e](https://github.com/ExaDev/agent-comms/commit/315275edd2a6f279683f35da7b58b0422e7a9298))
* **core:** assert rawPublicKeyFromPrivateKey rejects non-EC keys ([f6291c9](https://github.com/ExaDev/agent-comms/commit/f6291c9ae70d108b938d4a6a6386a284e87823a5))
* **core:** assert the certificate's X.509 v3 tag and serial byte spread ([71ab639](https://github.com/ExaDev/agent-comms/commit/71ab6398611e9bd70075e354214369e6f0a30bd2))
* **core:** pin CERTIFICATE_VALIDITY_MS to its exact millisecond value ([f1d80ac](https://github.com/ExaDev/agent-comms/commit/f1d80ac91c1960b60150c83cfe453ad382d37074))

## [2.21.3](https://github.com/ExaDev/agent-comms/compare/v2.21.2...v2.21.3) (2026-09-14)

### Bug Fixes

* **core:** exclude .stryker-tmp from vitest test discovery ([4d329ae](https://github.com/ExaDev/agent-comms/commit/4d329aee213c3cec3d6c79fa185513fea587140c))

## [2.21.2](https://github.com/ExaDev/agent-comms/compare/v2.21.1...v2.21.2) (2026-09-14)

### Tests

* **bridge:** widen blockPort's EADDRINUSE retry window ([0d3afb8](https://github.com/ExaDev/agent-comms/commit/0d3afb8ae4492c0340be658530a717650f26fe90))

## [2.21.1](https://github.com/ExaDev/agent-comms/compare/v2.21.0...v2.21.1) (2026-09-14)

### Chores

* **ci:** expand mutation-testing scope to mesh-store.ts's split files ([b8a70e3](https://github.com/ExaDev/agent-comms/commit/b8a70e3e9b4986f6205e64555180ff3071cf7d72))

## [2.21.0](https://github.com/ExaDev/agent-comms/compare/v2.20.2...v2.21.0) (2026-09-14)

### Features

* **build:** cap source file length at 800 lines ([8f2de6f](https://github.com/ExaDev/agent-comms/commit/8f2de6fe1a934d0adb96a47d94aa24760527768e))

### Bug Fixes

* **core:** re-export MeshStoreIdentity from mesh-store.ts ([d5af1fd](https://github.com/ExaDev/agent-comms/commit/d5af1fd316d9ba724e1bbcac2bb3e5ca33c38424))

### Refactoring

* **core:** add AgentRegistry ([6f6e88e](https://github.com/ExaDev/agent-comms/commit/6f6e88ec0aa36a4c0deeda029e3ec0c1004d8749))
* **core:** add ConnectionApproval ([348be88](https://github.com/ExaDev/agent-comms/commit/348be880744fcc8e6243d7386bc27022d2ecfc12))
* **core:** add DeliveryEngine ([fa1117b](https://github.com/ExaDev/agent-comms/commit/fa1117b3944ac70f7291244f2daee6633c96990a))
* **core:** add FederationBridge ([7edd943](https://github.com/ExaDev/agent-comms/commit/7edd943c6a93434dd7bbe85e247b205ace506b03))
* **core:** add mesh-store constants and room-wire extension helpers ([8851758](https://github.com/ExaDev/agent-comms/commit/885175801789282828ac0596775edd6075faf499))
* **core:** add PeerLifecycle ([57f382c](https://github.com/ExaDev/agent-comms/commit/57f382c1170e14f94d07c5fb18af88e55fbd9f56))
* **core:** add RoomLifecycle ([0757049](https://github.com/ExaDev/agent-comms/commit/07570492663b36273b0f3ff97cdc256364546cf8))
* **core:** add RoomMessaging ([ddd183b](https://github.com/ExaDev/agent-comms/commit/ddd183b7d34c580ec0c53a4725735806588f3d38))
* **core:** add RoomProtocol ([d3cfc25](https://github.com/ExaDev/agent-comms/commit/d3cfc251169c8833d244a3a007cf049c135698f7))
* **core:** add StaleAgentChecker ([6191a2d](https://github.com/ExaDev/agent-comms/commit/6191a2d0dc55448a345f94c02bbef1925e14aaa9))
* **core:** wire mesh-store.ts to delegate to its collaborators ([950f757](https://github.com/ExaDev/agent-comms/commit/950f757424c6b9d1dc1893cc6383ee8b70c2ac28))

## [2.20.2](https://github.com/ExaDev/agent-comms/compare/v2.20.1...v2.20.2) (2026-09-14)

### Bug Fixes

* **ci:** raise the mutation matrix's per-file timeout to 240 minutes ([fc791b9](https://github.com/ExaDev/agent-comms/commit/fc791b9f1903d2d7196eff3da8eab037557977e1))

## [2.20.1](https://github.com/ExaDev/agent-comms/compare/v2.20.0...v2.20.1) (2026-09-14)

### Bug Fixes

* **bridge:** retry blockPort's bind against a transient EADDRINUSE ([b1cbd1e](https://github.com/ExaDev/agent-comms/commit/b1cbd1ed842140f36d2b7497d5711886f9558540))

## [2.20.0](https://github.com/ExaDev/agent-comms/compare/v2.19.1...v2.20.0) (2026-09-13)

### Features

* **ci:** split mutation testing into a per-file matrix job ([c477dcc](https://github.com/ExaDev/agent-comms/commit/c477dcce29a07663412ef0971594008e7db28c40))

## [2.19.1](https://github.com/ExaDev/agent-comms/compare/v2.19.0...v2.19.1) (2026-09-13)

### Bug Fixes

* **ci:** raise the mutation testing job's own timeout to 240 minutes ([c702a9e](https://github.com/ExaDev/agent-comms/commit/c702a9e8dcead9568c737bc728357fbf4f31a1c3))

## [2.19.0](https://github.com/ExaDev/agent-comms/compare/v2.18.4...v2.19.0) (2026-09-13)

### Features

* add StrykerJS mutation testing scoped to src/core ([9abd460](https://github.com/ExaDev/agent-comms/commit/9abd460baf5893a0c6dbc8eb61c753ed2bb74832))
* **ci:** run mutation testing against vitest on a dispatchable job ([0207e00](https://github.com/ExaDev/agent-comms/commit/0207e0080097c23b14185407f33aa5737edc9055))

### Bug Fixes

* **build:** exclude Stryker's own sandbox and report output from lint ([daa250b](https://github.com/ExaDev/agent-comms/commit/daa250b770acd0791aaf0033f491bb72fc6dd79b))
* **ci:** force-include the built dist/ in each mutant sandbox ([ca99384](https://github.com/ExaDev/agent-comms/commit/ca993846c4a599ae198c8f96744305800a2c6fdf))
* **core:** raise the mutation dry run's own absolute timeout ([af261e0](https://github.com/ExaDev/agent-comms/commit/af261e0a498111372e7f1eb329466cdc85e5a22a))
* **core:** scope mutation testing to its own stated three files ([1b6ec83](https://github.com/ExaDev/agent-comms/commit/1b6ec83944d41e0bf96118d844b65209f08ca944))

## [2.18.4](https://github.com/ExaDev/agent-comms/compare/v2.18.3...v2.18.4) (2026-09-13)

### Bug Fixes

* **build:** point the pre-push hook at vitest instead of node:test ([b7564b5](https://github.com/ExaDev/agent-comms/commit/b7564b553af6f8cb2892a70d26c99efb69e8d8d4))
* keep a project-room directory node with no agents in the tree ([408a0b1](https://github.com/ExaDev/agent-comms/commit/408a0b1aed5cea5ecb8919125b209ab587fc8382))

### Tests

* migrate core unit tests to vitest's describe/it/expect ([59a17bb](https://github.com/ExaDev/agent-comms/commit/59a17bb1f24815b9cfa362c88a171775612b4fe8))
* migrate frontend component and unit tests to vitest ([46e86b3](https://github.com/ExaDev/agent-comms/commit/46e86b3111a2a095733941c6e53d6d2bfccaaeed))
* migrate identity and room-primitive tests to vitest ([83e7ebf](https://github.com/ExaDev/agent-comms/commit/83e7ebf01d5473635f7bf0a62431426e3458326c))
* migrate mesh, transport, and connection tests to vitest ([2b12620](https://github.com/ExaDev/agent-comms/commit/2b126207ef75310c27e59325c31c3ffebad488dd))
* migrate room lifecycle and admission tests to vitest ([a10b638](https://github.com/ExaDev/agent-comms/commit/a10b6384053f12a6fd61f75c0f914c7e94db42b1))
* migrate web bridge server-side tests to vitest ([47846cc](https://github.com/ExaDev/agent-comms/commit/47846cc24d6800300fd40e149e608469448c10a3))
* point pnpm test at vitest and finish its runtime config ([576acd8](https://github.com/ExaDev/agent-comms/commit/576acd81740f21da1b6e67f810bdb3a5534f0f4a))

### Chores

* add vitest and a serial-execution config ([737a76d](https://github.com/ExaDev/agent-comms/commit/737a76de1dc161e9b8261ef0758f80532e836041))

## [2.18.3](https://github.com/ExaDev/agent-comms/compare/v2.18.2...v2.18.3) (2026-09-13)

### Bug Fixes

* **core:** renew identity by re-certifying the existing key pair ([f059230](https://github.com/ExaDev/agent-comms/commit/f05923067a6bdae2387a5f2cf38858eddd98f0bd))

## [2.18.2](https://github.com/ExaDev/agent-comms/compare/v2.18.1...v2.18.2) (2026-09-13)

### Bug Fixes

* **release:** retry a transient 5xx from the MCP registry, not just npm propagation lag ([3bfb933](https://github.com/ExaDev/agent-comms/commit/3bfb93359d1cd53b6146d24a3c659b0b452098a2))

## [2.18.1](https://github.com/ExaDev/agent-comms/compare/v2.18.0...v2.18.1) (2026-09-13)

### Bug Fixes

* **build:** scope no-pointless-reassignments to const bindings only ([7588a89](https://github.com/ExaDev/agent-comms/commit/7588a89c96f7da53e6619875918d66f7b073fe26))
* **release:** retry the MCP registry publish for up to 15 minutes ([6a0b32f](https://github.com/ExaDev/agent-comms/commit/6a0b32f23b99d2717d1de3e765497206b44c4136))

### Tests

* cover the MCP registry publish retry logic ([929bd0e](https://github.com/ExaDev/agent-comms/commit/929bd0ed8c1935743bd86f071df413a347215b94))

## [2.18.0](https://github.com/ExaDev/agent-comms/compare/v2.17.0...v2.18.0) (2026-09-13)

### Features

* **core:** periodically re-advertise and consume presence over gossip ([685d5b8](https://github.com/ExaDev/agent-comms/commit/685d5b85f094ae66d682ef1b7db1a1c23cd9babe))

### Styles

* reformat presence-readvertise test to satisfy prettier ([8da5fcc](https://github.com/ExaDev/agent-comms/commit/8da5fcc9256e3002f10c2d61a70d9d8400b2546b))

### Chores

* bump wire-mesh-core to the release carrying sendGossipUpdate ([bfed2c0](https://github.com/ExaDev/agent-comms/commit/bfed2c066e5a51197480ce9a06c042cae44abb06))

## [2.17.0](https://github.com/ExaDev/agent-comms/compare/v2.16.0...v2.17.0) (2026-09-13)

### Features

* **core:** expire an unanswered connect_request after a configurable timeout ([007f7e0](https://github.com/ExaDev/agent-comms/commit/007f7e0834b463a3a30c1446ce168c616c99818d))

## [2.16.0](https://github.com/ExaDev/agent-comms/compare/v2.15.0...v2.16.0) (2026-09-12)

### Features

* **core:** revoke every member's grant for real when a room is destroyed ([61ce084](https://github.com/ExaDev/agent-comms/commit/61ce0842e378002e07dd5fb2bb5b1c385131061a))

## [2.15.0](https://github.com/ExaDev/agent-comms/compare/v2.14.0...v2.15.0) (2026-09-12)

### Features

* **core:** revoke a leaving or declining member's grant for real ([0fe440c](https://github.com/ExaDev/agent-comms/commit/0fe440cd12542746a1167337def49474ee534056))

### Styles

* **core:** wrap a few lines a pre-commit formatting pass had missed ([cbf7cac](https://github.com/ExaDev/agent-comms/commit/cbf7cacdd43fd8587783fd2096e0ab594bbd52da))

### Tests

* **core:** cover real leave/decline revocation and fix a convergence test ([2c5f369](https://github.com/ExaDev/agent-comms/commit/2c5f3697b76ea98d64d967b510b161e0b4c1af82))

## [2.14.0](https://github.com/ExaDev/agent-comms/compare/v2.13.0...v2.14.0) (2026-09-12)

### Features

* **core:** deliver room invites over a real, wire-authenticated request ([40ab9ec](https://github.com/ExaDev/agent-comms/commit/40ab9ec584f9a523d2f09c04f4ff58938ef1009d))

### Styles

* **core:** wrap handleRoomInvite's inviterId ternary onto two lines ([dbf9038](https://github.com/ExaDev/agent-comms/commit/dbf9038916c1d498e663c34b5a5eefff9897b52d))

## [2.13.0](https://github.com/ExaDev/agent-comms/compare/v2.12.0...v2.13.0) (2026-09-12)

### Features

* **core:** announce and ingest revocation entries over the wire ([80d2bfe](https://github.com/ExaDev/agent-comms/commit/80d2bfe0043cd588295a3cc10c949e8367550075))
* **core:** revoke a kicked member's own grant for real ([4f201b6](https://github.com/ExaDev/agent-comms/commit/4f201b6dc9117d51ac2232da95689e600af2bd16))

### Tests

* **core:** cover kick revoking a member's token for every peer ([1abd8cf](https://github.com/ExaDev/agent-comms/commit/1abd8cf2d8880c2769cf652859dcb13b17469964))

## [2.12.0](https://github.com/ExaDev/agent-comms/compare/v2.11.0...v2.12.0) (2026-09-12)

### Features

* **core:** sync real room name, description, and type on join ([c42e3d8](https://github.com/ExaDev/agent-comms/commit/c42e3d87c3bd877eeecc2f44401fca2be3b88247))

### Tests

* **core:** cover room-state sync on join and refresh ([6e53365](https://github.com/ExaDev/agent-comms/commit/6e53365e32ac152fef22fc0b6a8345f0579924a5))

## [2.11.0](https://github.com/ExaDev/agent-comms/compare/v2.10.0...v2.11.0) (2026-09-12)

### Features

* **core:** deliver read receipts via a directed room.read ([3e47ef3](https://github.com/ExaDev/agent-comms/commit/3e47ef35d90f16a16c3218ef433f6264c3ad6716))

### Tests

* **core:** cover directed room.read delivery ([2c8b521](https://github.com/ExaDev/agent-comms/commit/2c8b5217a015f67b45ba5579909b392ae09ccc20))
* give the smoke test's own join-admission poll a realistic budget ([7090708](https://github.com/ExaDev/agent-comms/commit/709070861b826b138641eac80ab479520e9a9593))

## [2.10.0](https://github.com/ExaDev/agent-comms/compare/v2.9.0...v2.10.0) (2026-09-12)

### Features

* **core:** fan out room.send to every member over directed wire sends ([be4e933](https://github.com/ExaDev/agent-comms/commit/be4e93381e4edd0b94363f15270e435eb5f63108))

### Bug Fixes

* **deps:** bump wire-mesh-core to 1.1.0 for bytesFromHex ([c0c5964](https://github.com/ExaDev/agent-comms/commit/c0c59645c9ab89548c5436296c459026500ba20d)), references [ExaDev/wire-mesh#90](https://github.com/ExaDev/wire-mesh/issues/90)

### Tests

* admit real room joins before sending across integration tests ([5d2925f](https://github.com/ExaDev/agent-comms/commit/5d2925f7e8a0aea4f14a83df0737abc2c37501da))
* **core:** cover the directed room.send retry queue ([cbba2a6](https://github.com/ExaDev/agent-comms/commit/cbba2a6c6c007dad3b54a13b944b40672df5e299))
* give the self-join CRDT-merge test a token before joinRoom ([6e72948](https://github.com/ExaDev/agent-comms/commit/6e729483854d2a6eda957c01bb14f6a41edef0d9))
* replace downtime-replay.integration.test.ts with the retry-queue version ([39ef09d](https://github.com/ExaDev/agent-comms/commit/39ef09db48faabeaa97b8b01535140a7185c299d)), references [#28](https://github.com/ExaDev/agent-comms/issues/28)
* split invite replay out of downtime-replay.test.ts ([0a41a07](https://github.com/ExaDev/agent-comms/commit/0a41a07870c9a7110b4e6dead49f2518f1160660))

## [2.9.0](https://github.com/ExaDev/agent-comms/compare/v2.8.0...v2.9.0) (2026-09-12)

### Features

* **core:** verify and deliver a directed room.send ([b9c110b](https://github.com/ExaDev/agent-comms/commit/b9c110b1df3fcd328d2120ea0c9ce33dc40c6827))

### Bug Fixes

* **deps:** bump wire-mesh-core to 1.0.3 for the real-wire signature fix ([3cb441e](https://github.com/ExaDev/agent-comms/commit/3cb441e9f3f81e3d34637dbd05940567d14105fc))

### Refactoring

* **core:** generalise token-id.ts into random-id.ts ([3708080](https://github.com/ExaDev/agent-comms/commit/37080804c1b6b09e91f10c0d27706664470485af))

### Styles

* apply eslint --fix formatting ([b69bddb](https://github.com/ExaDev/agent-comms/commit/b69bddbb02034b0ec1ef5f2b06942194ef2cce59))

### Tests

* **core:** cover directed room.send delivery end to end ([796916f](https://github.com/ExaDev/agent-comms/commit/796916f7c26290fe115e881a20884bde7d116c93))
* wire the smoke test's generated script for real room-verb dispatch ([a01c564](https://github.com/ExaDev/agent-comms/commit/a01c56436a541e2cb4acfd54d309dc264f399f07))

## [2.8.0](https://github.com/ExaDev/agent-comms/compare/v2.7.0...v2.8.0) (2026-09-12)

### Features

* **core:** implement the two-round DM consent flow ([481ec2a](https://github.com/ExaDev/agent-comms/commit/481ec2a2273d021fca79c5a5e7a51acd6aa42a16))

## [2.7.0](https://github.com/ExaDev/agent-comms/compare/v2.6.0...v2.7.0) (2026-09-12)

### Features

* **core:** expose room.join admission through room_accept/room_reject/room_pending ([08d91da](https://github.com/ExaDev/agent-comms/commit/08d91daa3e9b1f8debed34546d50ea8e454c8cba))

## [2.6.0](https://github.com/ExaDev/agent-comms/compare/v2.5.0...v2.6.0) (2026-09-12)

### Features

* **core:** add room.join owner-side admission and the requester wire path ([76f1f26](https://github.com/ExaDev/agent-comms/commit/76f1f26b3ffed6d63e09c1934011a430c6526f09))

## [2.5.0](https://github.com/ExaDev/agent-comms/compare/v2.4.0...v2.5.0) (2026-09-12)

### Features

* **core:** add a random token-id generator for minted capability tokens ([47514d0](https://github.com/ExaDev/agent-comms/commit/47514d0a52fdedfaa4488f93f20eeb57ee20ea1c))
* **core:** mint and persist the room owner's own room:member grant ([6d50426](https://github.com/ExaDev/agent-comms/commit/6d5042637c7099676a5db7a010f66e7208a0d7aa))

### Tests

* wire the smoke test's spawned peers with identity, retry the port wait ([6de80e4](https://github.com/ExaDev/agent-comms/commit/6de80e4744af82bb9535ad0417927027c2ced1bb))

## [2.4.0](https://github.com/ExaDev/agent-comms/compare/v2.3.1...v2.4.0) (2026-09-12)

### Features

* **core:** extract verb-routed dispatch into a dedicated room router ([8b778d0](https://github.com/ExaDev/agent-comms/commit/8b778d0ef171a6de44bda877507791abbc26d61d))

## [2.3.1](https://github.com/ExaDev/agent-comms/compare/v2.3.0...v2.3.1) (2026-09-12)

### Bug Fixes

* **core:** reject a room token whose own capability isn't room:member ([923c721](https://github.com/ExaDev/agent-comms/commit/923c7214e8c5cfa3a265879e27022e79530fcbb1))

## [2.3.0](https://github.com/ExaDev/agent-comms/compare/v2.2.0...v2.3.0) (2026-09-12)

### Features

* **core:** persist a per-room capability token set in the identity slot ([a5601da](https://github.com/ExaDev/agent-comms/commit/a5601dad1b931a913fe97aca60346e4cb2f8708b)), references [#68](https://github.com/ExaDev/agent-comms/issues/68)

## [2.2.0](https://github.com/ExaDev/agent-comms/compare/v2.1.0...v2.2.0) (2026-09-12)

### Features

* **core:** add the six-obligation room-token verification helper ([3e26c48](https://github.com/ExaDev/agent-comms/commit/3e26c484dc91169f97667d12e38b8547b2a7373b))

## [2.1.0](https://github.com/ExaDev/agent-comms/compare/v2.0.1...v2.1.0) (2026-09-11)

### Features

* **core:** re-key rooms and DMs onto core/room's path grammar ([a6b9be5](https://github.com/ExaDev/agent-comms/commit/a6b9be5e90c6370412413d0b5b8cc2c7c381f12a))

### Bug Fixes

* **core:** sanitise createRoom's name before constructing its path ([d57da03](https://github.com/ExaDev/agent-comms/commit/d57da0308a3147b78bb4bb2fecabbb71c604efef))

### Refactoring

* retire the browser-mesh-relay prototype ([e768f39](https://github.com/ExaDev/agent-comms/commit/e768f39073e7945a6ad54cf1313cdb1a43799257))

## [2.0.1](https://github.com/ExaDev/agent-comms/compare/v2.0.0...v2.0.1) (2026-09-11)

### Build

* depend on the real published wire-mesh-core npm package ([7b0bf19](https://github.com/ExaDev/agent-comms/commit/7b0bf19ac35298e40cdccdc5c694dab356b0f6f2))

## [2.0.0](https://github.com/ExaDev/agent-comms/compare/v1.33.1...v2.0.0) (2026-09-11)

### ⚠ BREAKING CHANGES

* peer IDs are now derived from SHA-256 of the raw public
  key (device-id), not the SHA-256 fingerprint of the self-signed X.509
  certificate. Every agent ID, room membership, and pending delivery queue
  tied to a pre-v2 identity is orphaned on upgrade, with no migration path.
  A v2 bridge cannot interoperate with a v1 one at all.

### Documentation

* correct identity description to device-id, flag the v2 breaking change ([8d52488](https://github.com/ExaDev/agent-comms/commit/8d524884e5d027fa658246114d276c7246e04c26))

### Chores

* stop pre-push from building and running a hardcoded compiled test ([e5bcf41](https://github.com/ExaDev/agent-comms/commit/e5bcf41e89f788d7dc89ede75b72fc86a7a57aa1))

## [1.33.1](https://github.com/ExaDev/agent-comms/compare/v1.33.0...v1.33.1) (2026-09-11)

### Bug Fixes

* **core:** report the OS-assigned port from becomeCoordinator and addListener ([a674834](https://github.com/ExaDev/agent-comms/commit/a674834bbad14223b6013087283c4e15abef6855))

### Refactoring

* **core:** delete TlsTransport now that every bridge runs on WireMeshTransport ([2a8d759](https://github.com/ExaDev/agent-comms/commit/2a8d759e2a162ec821a5a08331e1ed106169b37f))

## [1.33.0](https://github.com/ExaDev/agent-comms/compare/v1.32.1...v1.33.0) (2026-09-11)

### Features

* **core:** cut the remaining five bridges over to createBridgeMesh ([a985426](https://github.com/ExaDev/agent-comms/commit/a985426544943c3d6e96dc99e907a2baefe995ff))

### Tests

* stop deriving a second test port by adding an offset to the first ([84613af](https://github.com/ExaDev/agent-comms/commit/84613af02aaf7fffc587c455e376c4575b8a6181))

## [1.32.1](https://github.com/ExaDev/agent-comms/compare/v1.32.0...v1.32.1) (2026-09-11)

### Bug Fixes

* **core:** quarantine WireMeshTransport sessions until connection approval ([8ea3b3f](https://github.com/ExaDev/agent-comms/commit/8ea3b3f95f98af4ab57a5c5c2ffe3b79b7db6fdf))

### Tests

* give mesh-smoke's own dist-requiring subprocess a dedicated script ([003bba3](https://github.com/ExaDev/agent-comms/commit/003bba3ad18547cab469de4295d0b556d4670157))

## [1.32.0](https://github.com/ExaDev/agent-comms/compare/v1.31.0...v1.32.0) (2026-09-11)

### Features

* **core:** cut the mcp bridge over to WireMeshTransport via createBridgeMesh ([091d497](https://github.com/ExaDev/agent-comms/commit/091d497b5411503c6e918c186547b3e3f74731f0))

### Tests

* run the suite directly against TypeScript source via tsx, no build step ([198c9e4](https://github.com/ExaDev/agent-comms/commit/198c9e48ed40341c42ce3a4838e17695175384d2))

## [1.31.0](https://github.com/ExaDev/agent-comms/compare/v1.30.0...v1.31.0) (2026-09-11)

### Features

* **core:** implement WireMeshTransport over wire-mesh-core ([ba21335](https://github.com/ExaDev/agent-comms/commit/ba21335b5135b040cd722909166948c195963102))

## [1.30.0](https://github.com/ExaDev/agent-comms/compare/v1.29.0...v1.30.0) (2026-09-11)

### Features

* **core:** adapt PeerIdentity into wire-mesh-core's IdentityPort ([bc83bd9](https://github.com/ExaDev/agent-comms/commit/bc83bd95809b70b5b8885196ef7efa00c1d80823))

### Chores

* **deps:** bump wire-mesh-core to pick up createTlsTransport ([d9a337c](https://github.com/ExaDev/agent-comms/commit/d9a337c9a89b5fb5d14d957917606f0598500151))

## [1.29.0](https://github.com/ExaDev/agent-comms/compare/v1.28.1...v1.29.0) (2026-09-11)

### Features

* **core:** add wire-mesh's device-id derivation to PeerIdentity ([8d1c8de](https://github.com/ExaDev/agent-comms/commit/8d1c8de701d2d0aa1c8e48fae67e1d0a956e150d))

## [1.28.1](https://github.com/ExaDev/agent-comms/compare/v1.28.0...v1.28.1) (2026-09-11)

### Bug Fixes

* **core:** guard TlsTransport writes against a peer vanishing mid-write ([979aae1](https://github.com/ExaDev/agent-comms/commit/979aae16642e4c1f7f6ee9e92b55fa9683220b79))
* **core:** remove MeshStore's implicit TcpTransport default ([4c9f377](https://github.com/ExaDev/agent-comms/commit/4c9f37761a027058fb3b7d645508a747a0eba4d3))
* **core:** stop an inbound dial from suppressing the reciprocal outbound one ([2b0b293](https://github.com/ExaDev/agent-comms/commit/2b0b29334c78e6a3cf87549c7dd21c77ce301f48))
* **core:** surface connectToPeer's own socket errors via onError ([ca5413c](https://github.com/ExaDev/agent-comms/commit/ca5413c9e24183326b99ac4d664d1e90283f4727))
* give waitFor a 20s ceiling, not 5s ([ee742f4](https://github.com/ExaDev/agent-comms/commit/ee742f4afc4bb7b5693dd110a33eea3c148b3d50))
* **mesh-store:** destroy in-flight connectToPeer dials on shutdown ([4c087bd](https://github.com/ExaDev/agent-comms/commit/4c087bd3f427909461c03b08d2db11584a2b6a6f))
* **mesh-store:** skip dialling yourself when handling a gossiped peer list ([de2435b](https://github.com/ExaDev/agent-comms/commit/de2435b4775177ea1216ab25da04186613b9a699))
* **mesh-store:** wire onError so transport-level failures are observable ([b22df4e](https://github.com/ExaDev/agent-comms/commit/b22df4eccb8a9f6b9e5615fc919287322c0c81e4))

### Refactoring

* **core:** narrow CommsStore to exclude MeshStore-only features ([8d41880](https://github.com/ExaDev/agent-comms/commit/8d41880194239d6a7471f5a5ed223afd34143811))

### Tests

* poll for real conditions, guarantee store cleanup, bound child waits ([2ca5cb8](https://github.com/ExaDev/agent-comms/commit/2ca5cb83020b8c75b467c525465fda851f0e117d))
* rewire two raw-socket probes for TlsTransport, fix a recursion bug ([62481da](https://github.com/ExaDev/agent-comms/commit/62481da95491a1a24e127c4be6c9e8f767494f83)), references [#42](https://github.com/ExaDev/agent-comms/issues/42)

### Chores

* **ci:** run approval, listener-policy, and mesh-smoke suites ([f864283](https://github.com/ExaDev/agent-comms/commit/f864283a2e72ea42b2e234764bd85baa7466a041))
* **core:** trace peer_list handling and connectToPeer entry ([bd7749d](https://github.com/ExaDev/agent-comms/commit/bd7749d6f3adbca666720e3084dc94761975f709))

## [1.28.0](https://github.com/ExaDev/agent-comms/compare/v1.27.3...v1.28.0) (2026-09-10)

### Features

* **core:** add @exadev/wire-mesh-core as a workspace dependency ([ba04d2f](https://github.com/ExaDev/agent-comms/commit/ba04d2f54e48a18d2637b12123d4ef13290fd918))
* **core:** negotiate wire-format version at connection start ([a261d98](https://github.com/ExaDev/agent-comms/commit/a261d986d19b6d4a94c3c61d4bdb3b12840456a2))

### Bug Fixes

* **core:** declare cbor2 as a direct dependency ([f112c77](https://github.com/ExaDev/agent-comms/commit/f112c770f2693ff7f6ab2b99c645382e4a3aa0d0))
* **core:** gate every connection through the protocol handshake ([fd51bb0](https://github.com/ExaDev/agent-comms/commit/fd51bb0e5e558e7afff715de923258741c483233))
* **core:** tolerate a pre-[#29](https://github.com/ExaDev/agent-comms/issues/29)/[#30](https://github.com/ExaDev/agent-comms/issues/30) state_sync snapshot on the wire ([d76b7d3](https://github.com/ExaDev/agent-comms/commit/d76b7d366c87525a56a91856673c93c3d3b9f0c5))

## [1.27.3](https://github.com/ExaDev/agent-comms/compare/v1.27.2...v1.27.3) (2026-09-09)

### Bug Fixes

* read the OS-assigned port back from the listener in becomeCoordinator ([3876df5](https://github.com/ExaDev/agent-comms/commit/3876df553d53dd66f5be09147b53364c5a94741c))

### Tests

* cover becomeCoordinator's reported port against an OS-assigned bind ([c1c44ca](https://github.com/ExaDev/agent-comms/commit/c1c44caea84937caeb8e5f19b07aa34125b676a1))

## [1.27.2](https://github.com/ExaDev/agent-comms/compare/v1.27.1...v1.27.2) (2026-09-09)

### Bug Fixes

* **core:** verify a claimed peer ID against its presented certificate ([15113b0](https://github.com/ExaDev/agent-comms/commit/15113b0b902f5e7a4135f023fcb888864193fa29))

## [1.27.1](https://github.com/ExaDev/agent-comms/compare/v1.27.0...v1.27.1) (2026-09-09)

### Bug Fixes

* **core:** keep FileStore invites in the membership operation maps ([74c6162](https://github.com/ExaDev/agent-comms/commit/74c61621db3f1c79363d4681041ec87ca267e51a))

## [1.27.0](https://github.com/ExaDev/agent-comms/compare/v1.26.1...v1.27.0) (2026-09-09)

### Features

* **core:** expose federation trust management through CommsStore ([b37ab5e](https://github.com/ExaDev/agent-comms/commit/b37ab5e755cef2c6b91e795b73a1d071b4ef684c))
* **core:** pin certificate fingerprints for federation links ([537f4c9](https://github.com/ExaDev/agent-comms/commit/537f4c9c99ab5b0a4bdc402f9119c35935c40b85))
* **core:** verify federation peer certificates against a trusted allowlist ([ae67382](https://github.com/ExaDev/agent-comms/commit/ae673825808eb27b50f727f1936019ac8ebb49a7))
* **tool:** add MCP actions for managing federation trust ([29f6dd7](https://github.com/ExaDev/agent-comms/commit/29f6dd7a5dc05ef80ec93f3cd052262792366356))

### Tests

* **core:** cover federation fingerprint rejection and run the suite in CI ([6790898](https://github.com/ExaDev/agent-comms/commit/679089857e11fe1b4f322be3b6b85d8ec9ad1045))

## [1.26.1](https://github.com/ExaDev/agent-comms/compare/v1.26.0...v1.26.1) (2026-09-09)

### Documentation

* add claude mcp add as alternative Claude Code install method ([eac9d0c](https://github.com/ExaDev/agent-comms/commit/eac9d0c4978142752183777a7e31a91493086478))

## [1.26.0](https://github.com/ExaDev/agent-comms/compare/v1.25.7...v1.26.0) (2026-09-09)

### Features

* **mesh-store:** add per-agent membership operation maps to rooms ([2f95f9d](https://github.com/ExaDev/agent-comms/commit/2f95f9d122097b5f344cbe1e9debb13ba76a65e9))
* **mesh-store:** converge room membership as a per-agent element set ([0dae92e](https://github.com/ExaDev/agent-comms/commit/0dae92ed66ce4bc9fe2397e05a2d65336eba5320))

## [1.25.7](https://github.com/ExaDev/agent-comms/compare/v1.25.6...v1.25.7) (2026-09-09)

### Bug Fixes

* **mesh-store:** replay only delivery events that carry consumption evidence ([57605c0](https://github.com/ExaDev/agent-comms/commit/57605c07050f5d858cd9d6691678ae652138b783))

## [1.25.6](https://github.com/ExaDev/agent-comms/compare/v1.25.5...v1.25.6) (2026-09-09)

### Bug Fixes

* **mesh-store:** replay pending deliveries to an agent returning from downtime ([39a2020](https://github.com/ExaDev/agent-comms/commit/39a202080350cea0239125769a8c75e21c92cb02))

## [1.25.5](https://github.com/ExaDev/agent-comms/compare/v1.25.4...v1.25.5) (2026-09-09)

### Bug Fixes

* **mesh-store:** converge state sync by per-entity version ([4ea4a73](https://github.com/ExaDev/agent-comms/commit/4ea4a7360fb18ccbb763e816ef0ee24de3467e96))

## [1.25.4](https://github.com/ExaDev/agent-comms/compare/v1.25.3...v1.25.4) (2026-09-09)

### Tests

* **core:** run every tls-transport scenario when no test name is given ([8564519](https://github.com/ExaDev/agent-comms/commit/8564519f93d379f856ec06f4052f7cc44db247c8))
* **core:** wire the mesh integration suites into CI and cover the ws queue ([76591a0](https://github.com/ExaDev/agent-comms/commit/76591a08404a376183e6afaf4e16a6b7172518cf))

## [1.25.3](https://github.com/ExaDev/agent-comms/compare/v1.25.2...v1.25.3) (2026-09-09)

### Bug Fixes

* **core:** keep the certificate serial a minimal DER integer ([aff2031](https://github.com/ExaDev/agent-comms/commit/aff20314fe728c1533320a0f8aa319f4af42eb72))
* **core:** stop dropping broadcasts sent while peer connections are still dialling ([e945458](https://github.com/ExaDev/agent-comms/commit/e9454588c3629d9c3b23e8814764237e033cdc42))

## [1.25.2](https://github.com/ExaDev/agent-comms/compare/v1.25.1...v1.25.2) (2026-09-08)

### Refactoring

* **core:** drop void-operator acknowledgements of unused values ([428188d](https://github.com/ExaDev/agent-comms/commit/428188dac7bf5c98770c5ec8187f48822241e944))

### Build

* **deps-dev:** bump typescript-eslint from 8.64.0 to 8.69.0 ([0d1c2a3](https://github.com/ExaDev/agent-comms/commit/0d1c2a30117907f4facad234ff0dc2625f5d21b3))

## [1.25.1](https://github.com/ExaDev/agent-comms/compare/v1.25.0...v1.25.1) (2026-09-08)

### Build

* **deps:** bump @modelcontextprotocol/sdk from 1.29.0 to 1.30.0 ([0658895](https://github.com/ExaDev/agent-comms/commit/06588951338f22780acfb92a79ba7d329a8a3767))
* **deps:** bump actions/checkout from 6 to 7 ([58ea7f6](https://github.com/ExaDev/agent-comms/commit/58ea7f632811204b1792aa54f1577bb8f6354840))
* **deps:** bump actions/setup-node from 6 to 7 ([bddf7cf](https://github.com/ExaDev/agent-comms/commit/bddf7cfc402ceea31b346ec1ca039adf746f7f5a))

## [1.25.0](https://github.com/ExaDev/agent-comms/compare/v1.24.4...v1.25.0) (2026-09-08)

### Features

* **bridge:** persist bridge identity across restarts ([82b52b2](https://github.com/ExaDev/agent-comms/commit/82b52b2d7bbee946e3aeb37fc6ed39654047d230))

## [1.24.4](https://github.com/ExaDev/agent-comms/compare/v1.24.3...v1.24.4) (2026-09-08)

### Bug Fixes

* **release:** retry MCP registry publish on npm propagation lag ([e1aaaa9](https://github.com/ExaDev/agent-comms/commit/e1aaaa9782f324a4683d94bf8fafcd7e66ba8706))

### Tests

* **mesh-store:** assert cross-peer visibility and room membership in e2e ([023a46a](https://github.com/ExaDev/agent-comms/commit/023a46a144d4564c2bb4053e22631f9c3496e65d))

## [1.24.3](https://github.com/ExaDev/agent-comms/compare/v1.24.2...v1.24.3) (2026-09-08)

### Bug Fixes

* **build:** publish web frontend assets so the CLI doesn't crash on launch ([e0e08ff](https://github.com/ExaDev/agent-comms/commit/e0e08ffe0eb5937a7a1e604735c4105a616309d7)), closes [#18](https://github.com/ExaDev/agent-comms/issues/18)

## [1.24.2](https://github.com/ExaDev/agent-comms/compare/v1.24.1...v1.24.2) (2026-08-03)

### Bug Fixes

* override conventional-changelog-writer to fix empty changelog notes ([5cb0c2e](https://github.com/ExaDev/agent-comms/commit/5cb0c2ebd7994f8641bc63301397006918a1c1e5))

## [1.24.1](https://github.com/ExaDev/agent-comms/compare/v1.24.0...v1.24.1) (2026-07-23)

### Chores

* **deps:** update dependencies to latest ([71709ff](https://github.com/ExaDev/agent-comms/commit/71709ff327e3f8432e2f693f711ae70841052d34))

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
