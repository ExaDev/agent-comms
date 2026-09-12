/**
 * Unit tests for room.join admission (P3.4): the owner-side handler that holds a request open until a human decides, and the requester-side joinRoom path that sends a real wire-level request for a room this store has never seen replicated.
 *
 * Deliberately unit-level, not a full two-peer integration test: MeshStore's own legacy full-state-sync (still active per P3.3's "both paths coexist" transition) makes any two mesh-connected stores instantly aware of every room the moment they connect, so a genuinely two-peer test can never actually exercise the "room I've never heard of" case this code exists for -- exactly the scenario section 4 of the design doc names as a real regression, not something a live two-store test can reach today. Testing the handler and the remote-join path directly, against fakes, is the only way to exercise this code before P3.8 retires the legacy path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import {
  deviceIdFromHex,
  deviceIdToHex,
} from "wire-mesh-core/domain/device-id";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { MeshStore } from "../core/mesh-store.js";
import { ownerNamedRoomPath } from "../core/room-path.js";
import {
  loadOrCreateIdentity,
  loadRoomTokens,
} from "../core/identity-store.js";
import type { IdentitySlot } from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import type { ConnectionHandle, MeshTransport } from "../core/transport.js";
import { wireTestTransport } from "./test-transport.js";

const REQUESTER_ID = "b".repeat(64);

function fakeRequest(scopePath: string): {
  request: IncomingManageRequest;
  responses: ManageOutcome[];
} {
  const responses: ManageOutcome[] = [];
  const request: IncomingManageRequest = {
    requestId: 1,
    command: { verb: "room:member", params: { verb: "room.join" } },
    scope: { kind: "room", path: scopePath },
    respond: async (outcome: ManageOutcome): Promise<void> => {
      responses.push(outcome);
    },
  };
  return { request, responses };
}

describe("handleRoomJoin (owner side)", () => {
  it("holds the request open, then grants a working token on acceptance", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const owner = await store.registerAgent({
      name: "owner",
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const room = await store.createRoom({
      name: "general",
      type: "public",
      owner: owner.id,
      description: "",
    });

    const handler = store.roomVerbHandlers["room.join"];
    assert.ok(handler, "expected a registered room.join handler");
    const handle: ConnectionHandle = { id: REQUESTER_ID };
    const { request } = fakeRequest(room.id);

    const outcomePromise = handler(request, handle);

    assert.deepEqual(store.listPendingRoomJoins(), [
      { roomPath: room.id, requesterId: REQUESTER_ID },
    ]);

    store.acceptRoomJoin(room.id, REQUESTER_ID);
    const outcome = await outcomePromise;

    assert.equal(outcome.result, "ok");
    if (outcome.result !== "ok") return;
    assert.deepEqual(store.listPendingRoomJoins(), []);

    const token = outcome["granted-token"];
    assert.ok(token !== undefined, "expected a granted-token in the outcome");

    const roomAfterJoin = await store.getRoom(room.id);
    assert.ok(roomAfterJoin?.members.includes(REQUESTER_ID));
  });

  it("denies the request without minting anything on rejection", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const owner = await store.registerAgent({
      name: "owner",
      harness: "pi",
      cwd: "/tmp/p",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    const room = await store.createRoom({
      name: "general",
      type: "public",
      owner: owner.id,
      description: "",
    });

    const handler = store.roomVerbHandlers["room.join"];
    assert.ok(handler);
    const handle: ConnectionHandle = { id: REQUESTER_ID };
    const { request } = fakeRequest(room.id);

    const outcomePromise = handler(request, handle);
    store.rejectRoomJoin(room.id, REQUESTER_ID);
    const outcome = await outcomePromise;

    assert.equal(outcome.result, "error");
    const roomAfterReject = await store.getRoom(room.id);
    assert.equal(roomAfterReject?.members.includes(REQUESTER_ID), false);
  });

  it("refuses a DM path naming neither of its own device as a participant, with no pending entry created", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    // Neither "c"x64 nor "d"x64 is this store's own peerId, so this DM path names a conversation the store has no part in -- the dm-admission integration tests cover the genuinely-a-participant case end to end.
    const dmPath = `${deviceIdToHex(deviceIdFromHex("c".repeat(64)))}+${deviceIdToHex(deviceIdFromHex("d".repeat(64)))}`;

    const handler = store.roomVerbHandlers["room.join"];
    assert.ok(handler);
    const handle: ConnectionHandle = { id: REQUESTER_ID };
    const { request } = fakeRequest(dmPath);

    const outcome = await handler(request, handle);

    assert.equal(outcome.result, "error");
    assert.deepEqual(store.listPendingRoomJoins(), []);
  });

  it("refuses a named room this store doesn't own", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const someoneElse = "e".repeat(64);
    const roomPath = ownerNamedRoomPath(someoneElse, "general");

    const handler = store.roomVerbHandlers["room.join"];
    assert.ok(handler);
    const handle: ConnectionHandle = { id: REQUESTER_ID };
    const { request } = fakeRequest(roomPath);

    const outcome = await handler(request, handle);

    assert.equal(outcome.result, "error");
    assert.deepEqual(store.listPendingRoomJoins(), []);
  });
});

describe("joinRoom (requester side, remote path)", () => {
  it("sends a real room.join request and persists the granted token for a room it has never seen", async () => {
    const store = new MeshStore();
    const slot: IdentitySlot = {
      harness: "test",
      cwd: "req",
      dir: fs.mkdtempSync(path.join(tmpdir(), "agent-comms-join-remote-")),
    };
    const identity = loadOrCreateIdentity(slot);
    store.peerId = deviceIdToHex(Uint8Array.from(identity.deviceId));
    const identityPort = await toIdentityPort(identity);
    store.setIdentity({
      identity: identityPort,
      clock: createSystemClock(),
      slot,
      revocation: createRevocationView(),
    });

    const ownerId = "f".repeat(64);
    const roomPath = ownerNamedRoomPath(ownerId, "general");
    // A real, validly-minted token -- roomJoinOkSchema validates the wire response's own granted-token shape against the real CapabilityToken schema, so a hand-rolled fixture would just fail that validation. Minted here by the requester's own identity purely as a stand-in for "any real token the owner could have sent"; who actually signed it plays no part in this test, only that saveRoomToken's own CapabilityToken contract is satisfied.
    const grantedTokenVerdict = await mintCapabilityToken({
      identity: identityPort,
      clock: createSystemClock(),
      tokenId: new Uint8Array([1]),
      bearer: deviceIdFromHex(store.peerId),
      capability: "room:member",
      scope: { kind: "room", path: roomPath },
      expires: Date.now() + 60_000,
      delegationsRemaining: 0,
    });
    assert.ok(
      grantedTokenVerdict.ok,
      "expected the fixture token to mint successfully",
    );
    if (!grantedTokenVerdict.ok) return;
    const grantedToken = grantedTokenVerdict.token;

    let capturedRoomPath: string | undefined;
    const fakeTransport: MeshTransport = {
      dataPort: 0,
      isCoordinator: false,
      hasCoordinatorConnection: false,
      startDataServer: async () => {},
      connectToCoordinator: async () => {},
      becomeCoordinator: async () => {},
      connectToPeer: async () => {},
      send: async () => {},
      acceptConnection: async () => {},
      rejectConnection: async () => {},
      connectToRemote: async () => {},
      broadcast: async () => {},
      sendRoomRequest: async (_memberId, command, scope) => {
        capturedRoomPath = scope.path;
        assert.deepEqual(command.params, { verb: "room.join" });
        return {
          result: "ok",
          "granted-token": grantedToken,
          members: [{ device: deviceIdFromHex(store.peerId) }],
        };
      },
      addListener: async () => "id",
      removeListener: async () => {},
      listListeners: () => [],
      shutdown: async () => {},
      unref: () => {},
    };
    store.setTransport(fakeTransport);

    assert.equal(await store.getRoom(roomPath), undefined);

    const joined = await store.joinRoom(roomPath, store.peerId);

    assert.equal(joined.id, roomPath);
    assert.equal(capturedRoomPath, roomPath);
    assert.ok(joined.members.includes(store.peerId));

    const tokens = loadRoomTokens(slot);
    assert.ok(
      tokens[roomPath] !== undefined,
      "expected the granted token to be persisted",
    );
  });
});
