/**
 * End-to-end proof of agent-comms#192 over a real wire-mesh relay hub (the same domain logic the production mesh.exadev.io Durable Object runs, served over local WebSockets via hub-helpers.ts): a real room.join from a device the receiving gateway's own GatewayTrust does NOT trust reaches the deliberate human-approval flow instead of being rejected outright by the coarse bare-device gateway allowlist. Under the pre-#192 code, the owner's own consume() would answer this request with an immediate unauthorized outcome, and owner.listPendingRoomJoins() would never show it at all.
 *
 * Only a hub connection between owner and requester is ever established, deliberately never a direct local peer connection: hub mode carries no legacy full-state-sync (room-join-admission.test.ts's own header comment explains why that path makes "a room I've never heard of" untestable over an ordinary two-peer local mesh), so this is the one topology where the requester genuinely has never heard of the owner's room before sending a real wire-level room.join for it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { wireTestTransportWithHub } from "./test-transport.js";
import { realHubOverWs, waitForCondition } from "./hub-helpers.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0)) {
    await close();
  }
});

/** Wires up an owner and a requester MeshStore, each connected to the same real hub, with the requester trusting the owner's device (the outbound leg WireMeshTransport.sendRoomRequest needs before it will even attempt routing via the hub) but the owner trusting nothing at all -- the absence that is the whole point of every test in this file. Deliberately never calls MeshStore.init(): that method's own local-mesh coordinator election (connectToCoordinator/becomeCoordinator against the real, well-known port 19876) has nothing to do with hub mode and risks colliding with an unrelated coordinator already running on the machine -- hub-mode-session.integration.test.ts's own raw-WireMeshTransport tests never call it either, for the same reason. */
async function connectedOwnerAndRequester(hubUrl: string): Promise<{
  owner: MeshStore;
  requester: MeshStore;
}> {
  const owner = new MeshStore();
  const { transport: ownerTransport } = await wireTestTransportWithHub(owner);
  await owner.registerAgent({
    name: "owner",
    harness: "test",
    cwd: "/test/owner",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  const requester = new MeshStore();
  const { transport: requesterTransport } =
    await wireTestTransportWithHub(requester);
  await requester.registerAgent({
    name: "requester",
    harness: "test",
    cwd: "/test/requester",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  requester.gatewayTrust.add(owner.peerId);
  expect(owner.gatewayTrust.hasAny()).toBe(false);

  await ownerTransport.connectHub?.(hubUrl);
  await requesterTransport.connectHub?.(hubUrl);
  // The requester's own directory surfacing the owner means the hub verified and registered the owner's advert, which a relay-connect naming the owner needs before it is routed rather than silently dropped. Being connected is not enough.
  await waitForCondition(
    () =>
      ownerTransport.hub.isConnected &&
      requesterTransport.hub.peers().includes(owner.peerId),
  );

  return { owner, requester };
}

describe("hub-relayed room.join versus the gateway trust boundary", () => {
  it("reaches the owner's human-approval flow, and grants membership on acceptance, even though the owner's gateway does not trust the requester's device at all", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const { owner, requester } = await connectedOwnerAndRequester(hub.url);

    const room = await owner.createRoom({
      name: "general",
      type: "public",
      owner: owner.peerId,
      description: "",
    });
    expect(await requester.getRoom(room.id)).toBeUndefined();

    const joinPromise = requester.joinRoom(room.id, requester.peerId);

    await waitForCondition(() =>
      owner
        .listPendingRoomJoins()
        .some(
          (pending) =>
            pending.roomPath === room.id &&
            pending.requesterId === requester.peerId,
        ),
    );

    owner.acceptRoomJoin(room.id, requester.peerId);
    const joined = await joinPromise;

    expect(joined.id).toBe(room.id);
    expect(joined.members.includes(requester.peerId)).toBe(true);
    // hubPeersKnown (peers()) stays "gateway-trusted hub peers" even after a real, successful room-domain admission: the requester's own device was never on the owner's bare-device allowlist, only its capability token was ever verified, so it must never surface as a "known" hub peer just because a room-domain request from it happened to succeed.
    expect(owner.gatewayTrust.hasAny()).toBe(false);

    await requester.shutdown();
    await owner.shutdown();
  });

  it("still lets the owner reject the same untrusted-gateway request through the ordinary human-decision outcome, not a gateway-level error", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const { owner, requester } = await connectedOwnerAndRequester(hub.url);

    const room = await owner.createRoom({
      name: "private-room",
      type: "public",
      owner: owner.peerId,
      description: "",
    });

    const joinPromise = requester.joinRoom(room.id, requester.peerId);

    await waitForCondition(() =>
      owner
        .listPendingRoomJoins()
        .some(
          (pending) =>
            pending.roomPath === room.id &&
            pending.requesterId === requester.peerId,
        ),
    );

    owner.rejectRoomJoin(room.id, requester.peerId, "not today");

    await expect(joinPromise).rejects.toThrow();
    expect(await requester.getRoom(room.id)).toBeUndefined();

    await requester.shutdown();
    await owner.shutdown();
  });
});
