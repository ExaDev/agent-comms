/**
 * Reproduces agent-comms#299: a session fronted by the default cc-peer front builds its store from the same identity slot the real claude-code bridge for that directory would use (computeFrontSlot). loadIdentityForFront (front.ts's own path) never takes the slot's exclusivity lock, so nothing stops a real bridge starting afterwards from also loading that slot's identity via loadOrCreateIdentity — both stores end up holding the literal same device-id, each with its own live hub session, for as long as the front takes to notice (via its own poll) that the slot is now held and detach.
 *
 * This test constructs exactly that: a "front" store built via loadIdentityForFront, and a "real bridge" store built afterwards via loadOrCreateIdentity against the same slot — both against a real relay hub (the same domain logic mesh.exadev.io's Durable Object runs, served locally over WebSockets by hub-helpers.ts). A third, unrelated observer store discovers the shared device id through the hub and checks it stays routable once the front (the older of the two live sessions) shuts down, simulating the front noticing the takeover and detaching.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { MeshStore } from "../core/mesh-store.js";
import {
  loadIdentityForFront,
  releaseIdentityLock,
} from "../core/identity-store.js";
import type { IdentitySlot } from "../core/identity-store.js";
import { realHubOverWs, TeardownStack } from "./hub-helpers.js";
import {
  wireTestTransport,
  waitFor as waitForCondition,
} from "./test-transport.js";
import { nanoid } from "../core/nanoid.js";

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

/** Starts an unrelated observer store on its own machine, dialling the same hub, so its view of the shared-identity device only ever arrives via hub gossip — exactly the cross-machine visibility agent-comms#299 is actually about. */
async function startObserver(hubUrl: string): Promise<MeshStore> {
  const store = new MeshStore({ coordinatorPort: 0, hubUrl });
  await wireTestTransport(store, { presenceReadvertiseIntervalMs: 50 });
  await store.init();
  cleanups.push(async () => store.shutdown());
  await store.registerAgent({
    name: "observer",
    harness: "test",
    cwd: "/test/observer",
    pid: process.pid,
    visibility: "visible",
    tags: ["observer"],
  });
  return store;
}

describe("front and real bridge sharing one identity slot (agent-comms#299)", () => {
  it("keeps the shared device routable from another machine once the front (the older session) shuts down", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);

    const slot: IdentitySlot = {
      harness: "claude-code",
      cwd: "/test/fronted-session",
      dir: fs.mkdtempSync(path.join(tmpdir(), "agent-comms-test-identity-")),
    };

    // The front: loadIdentityForFront never takes the slot lock, matching front.ts's own real behaviour.
    const front = new MeshStore({ coordinatorPort: 0, hubUrl: hub.url });
    await wireTestTransport(front, {
      slot,
      identityLoader: loadIdentityForFront,
      presenceReadvertiseIntervalMs: 50,
    });
    await front.init();
    cleanups.push(async () => front.shutdown());
    await front.registerAgent({
      name: "fronted-session",
      harness: "claude-code",
      cwd: slot.cwd,
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    // The real bridge starts afterwards, against the same slot. loadOrCreateIdentity succeeds in taking the lock, since the front never held it, so it loads the identical persisted identity rather than falling back to an ephemeral one.
    const realBridge = new MeshStore({ coordinatorPort: 0, hubUrl: hub.url });
    await wireTestTransport(realBridge, {
      slot,
      presenceReadvertiseIntervalMs: 50,
    });
    await realBridge.init();
    cleanups.push(async () => {
      realBridge.shutdown();
      releaseIdentityLock(slot);
    });
    await realBridge.registerAgent({
      name: "fronted-session",
      harness: "claude-code",
      cwd: slot.cwd,
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    expect(realBridge.peerId).toBe(front.peerId);
    const sharedDeviceId = front.peerId;

    const observer = await startObserver(hub.url);
    observer.addTrustedGateway(sharedDeviceId);
    front.addTrustedGateway(observer.peerId);
    realBridge.addTrustedGateway(observer.peerId);

    await waitForCondition(async () => {
      const agents = await observer.listAgents(observer.peerId);
      return agents.some((agent) => agent.id === sharedDeviceId);
    }, "observer to learn of the shared-identity device via the hub");

    // The front is the older of the two live sessions (it registered first) — shutting it down here stands in for the front's own poll noticing the real bridge now holds the slot and detaching.
    await front.shutdown();

    await waitForCondition(async () => {
      const agents = await observer.listAgents(observer.peerId);
      return agents.some((agent) => agent.id === sharedDeviceId);
    }, "the device to stay routable from the observer once the front (the older session) has shut down, since the real bridge is still live under the same identity");
  });
});
