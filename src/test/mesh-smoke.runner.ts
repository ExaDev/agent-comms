/**
 * Multi-process smoke test for the MeshStore mesh.
 *
 * Spawns two separate Node.js processes running MeshStore instances over WireMeshTransport, verifies they discover each other via the coordinator, exchange messages, and receive push delivery. Each spawned process requires() compiled dist/ output directly (the point is exercising the real built artifact across a genuine process boundary, not re-testing TS source logic already covered elsewhere), so this runs via its own pnpm test:smoke script rather than the plain pnpm test glob -- unlike every other *.test.ts file, it needs a build to have happened first.
 *
 * Usage: pnpm test:smoke
 */

import * as assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as net from "node:net";

const SMOKE_PORT = 19877;
const SMOKE_HOST = "127.0.0.1";

interface TestMessage {
  type: string;
  data: Record<string, number | string | boolean>;
}

interface PeerHandle {
  messages: TestMessage[];
  exit: Promise<void>;
}

// A hung child (a mesh operation that never resolves) must not hang this process indefinitely -- the child is killed and the promise rejects with a clear reason instead of Promise.all([...]) waiting forever.
const PEER_EXIT_TIMEOUT_MS = 15_000;

// -----------------------------------------------------------------------
// Child process peer
// -----------------------------------------------------------------------

function spawnPeer(name: string, actions: string): PeerHandle {
  const messages: TestMessage[] = [];
  const script = buildScript(name, actions);

  const child = child_process.spawn("node", ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  child.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isTestMessage(parsed)) messages.push(parsed);
      } catch {
        /* skip non-JSON lines */
      }
    }
  });

  const exit = new Promise<void>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(
          `${name} did not exit within ${String(PEER_EXIT_TIMEOUT_MS)}ms:\n${stderr}`,
        ),
      );
    }, PEER_EXIT_TIMEOUT_MS);
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buffer.trim()) {
        try {
          const parsed: unknown = JSON.parse(buffer);
          if (isTestMessage(parsed)) messages.push(parsed);
        } catch {
          /* skip */
        }
      }
      if (code === 0) resolve();
      else
        reject(
          new Error(`${name} exited with code ${String(code)}:\n${stderr}`),
        );
    });
  });

  return { messages, exit };
}

function isTestMessage(value: unknown): value is TestMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value)) return false;
  return typeof value.type === "string";
}

function buildScript(name: string, actions: string): string {
  return [
    `const { MeshStore } = require("./dist/core/mesh-store.js");`,
    `const { CommsTool } = require("./dist/core/tool.js");`,
    `const { WireMeshTransport } = require("./dist/core/wire-mesh-transport.js");`,
    `const { loadOrCreateIdentity } = require("./dist/core/identity-store.js");`,
    `const { toIdentityPort } = require("./dist/core/wire-mesh-identity.js");`,
    `const { deviceIdToHex } = require("wire-mesh-core/domain/device-id");`,
    `const { createSystemClock } = require("wire-mesh-core/adapters/system-clock");`,
    `const { createRevocationView } = require("wire-mesh-core/domain/revocation-view");`,
    `const os = require("node:os");`,
    `const path = require("node:path");`,
    `const fs = require("node:fs");`,
    `function log(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }`,
    `(async () => {`,
    `  const store = new MeshStore(${String(SMOKE_PORT)});`,
    `  const slot = { harness: "smoke-${name}", cwd: "/test/${name}", dir: fs.mkdtempSync(path.join(os.tmpdir(), "agent-comms-smoke-${name}-")) };`,
    `  const identity = loadOrCreateIdentity(slot);`,
    `  store.peerId = deviceIdToHex(Uint8Array.from(identity.deviceId));`,
    `  store.setTransport(new WireMeshTransport(store.events, identity, store.roomVerbHandlers));`,
    `  store.setIdentity({ identity: await toIdentityPort(identity), clock: createSystemClock(), slot, revocation: createRevocationView() });`,
    `  const tool = new CommsTool(store);`,
    `  const deliveries = [];`,
    `  store.onDelivery = (_id, event) => {`,
    `    deliveries.push(event);`,
    `    log({ type: "delivery", data: { eventType: event.type } });`,
    `  };`,
    `  await store.init();`,
    `  const agent = await store.registerAgent({`,
    `    name: "${name}", harness: "smoke-${name}",`,
    `    cwd: "/test/${name}", pid: process.pid,`,
    `    visibility: "visible", tags: [],`,
    `  });`,
    `  log({ type: "registered", data: { id: agent.id } });`,
    `  await new Promise(r => setTimeout(r, 500));`,
    `  ${actions}`,
    `  await new Promise(r => setTimeout(r, 1000));`,
    `  const agents = await store.listAgents(agent.id);`,
    `  log({ type: "agents", data: { count: agents.length } });`,
    `  const rooms = await store.listRooms(agent.id);`,
    `  log({ type: "rooms", data: { count: rooms.length, names: rooms.map(r => r.name).join(",") } });`,
    `  log({ type: "deliveries_received", data: { count: deliveries.length } });`,
    `  await store.shutdown();`,
    `  process.exit(0);`,
    `})().catch(e => { console.error(e); process.exit(1); });`,
  ].join("\n");
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

const WAIT_FOR_PORT_TIMEOUT_MS = 15_000;
const WAIT_FOR_PORT_RETRY_MS = 50;

/** Retries a single connection attempt until the port accepts one or the deadline passes, rather than a single attempt after a flat sleep -- binding the port now waits on real, load-dependent work (identity load/generation, then an async WebCrypto key import for the room-token identity) before the coordinator listener opens, so a fixed pre-sleep is exactly the fragile pattern this codebase's own waitFor helpers already avoid elsewhere. */
function waitForPort(port: number, host: string): Promise<void> {
  const deadline = Date.now() + WAIT_FOR_PORT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    function attempt(): void {
      const socket = new net.Socket();
      socket.connect(port, host, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(
            new Error(
              `Port ${String(port)} not listening after ${String(WAIT_FOR_PORT_TIMEOUT_MS)}ms`,
            ),
          );
          return;
        }
        setTimeout(attempt, WAIT_FOR_PORT_RETRY_MS);
      });
    }
    attempt();
  });
}

function findMsg(
  messages: TestMessage[],
  type: string,
): TestMessage | undefined {
  return messages.find((m) => m.type === type);
}

// -----------------------------------------------------------------------
// Test
// -----------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Multi-process smoke test ===\n");

  console.log("Spawning peer A (coordinator)...");
  const peerA = spawnPeer(
    "a",
    [
      `const roomId = "smoke-room-" + Date.now();`,
      `const room = await store.createRoom({`,
      `  name: roomId, type: "public", owner: agent.id,`,
      `  description: "Smoke test room",`,
      `});`,
      `log({ type: "room_created", data: { id: room.id } });`,
      `await new Promise(r => setTimeout(r, 1500));`,
      `await store.sendRoomMessage(room.id, agent.id, "Hello from A!");`,
      `log({ type: "sent", data: { room: room.id } });`,
    ].join("\n    "),
  );

  // Wait for A to bind coordinator port -- waitForPort itself retries until bound or its own timeout, so no fixed pre-sleep is needed.
  await waitForPort(SMOKE_PORT, SMOKE_HOST);
  console.log("  Coordinator bound on port " + String(SMOKE_PORT));

  console.log("Spawning peer B (joins mesh)...");
  const peerB = spawnPeer(
    "b",
    [
      `await new Promise(r => setTimeout(r, 800));`,
      `const existingRooms = await store.listRooms(agent.id);`,
      `const smokeRoom = existingRooms.find(r => r.name.startsWith("smoke-room"));`,
      `if (smokeRoom) {`,
      `  await store.joinRoom(smokeRoom.id, agent.id);`,
      `  log({ type: "joined", data: { room: smokeRoom.id } });`,
      `} else {`,
      `  log({ type: "no_room", data: {} });`,
      `}`,
    ].join("\n    "),
  );

  console.log("Waiting for peers to complete...\n");
  await Promise.all([peerA.exit, peerB.exit]);

  // --- Results ---
  console.log("Peer A messages:");
  for (const m of peerA.messages)
    console.log(`  ${m.type}: ${JSON.stringify(m.data)}`);
  console.log();
  console.log("Peer B messages:");
  for (const m of peerB.messages)
    console.log(`  ${m.type}: ${JSON.stringify(m.data)}`);
  console.log();

  // --- Assertions ---
  assert.ok(findMsg(peerA.messages, "registered"), "A should register");
  assert.ok(findMsg(peerB.messages, "registered"), "B should register");

  const agentsA = findMsg(peerA.messages, "agents");
  const agentsB = findMsg(peerB.messages, "agents");

  assert.ok(
    agentsA &&
      typeof agentsA.data.count === "number" &&
      agentsA.data.count >= 2,
    `A should see at least 2 agents, got ${String(agentsA?.data.count)}`,
  );
  assert.ok(
    agentsB &&
      typeof agentsB.data.count === "number" &&
      agentsB.data.count >= 2,
    `B should see at least 2 agents, got ${String(agentsB?.data.count)}`,
  );

  assert.ok(findMsg(peerB.messages, "joined"), "B should join the room");

  const bDeliveries = findMsg(peerB.messages, "deliveries_received");
  assert.ok(
    bDeliveries &&
      typeof bDeliveries.data.count === "number" &&
      bDeliveries.data.count >= 1,
    `B should receive at least 1 delivery, got ${String(bDeliveries?.data.count)}`,
  );

  console.log("✓ All smoke tests passed!");
}

main().catch((err: unknown) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
