/**
 * Unit tests for room.join admission (P3.4): the owner-side handler that holds a request open until a human decides, and the requester-side joinRoom path that sends a real wire-level request for a room this store has never seen replicated.
 *
 * Deliberately unit-level, not a full two-peer integration test: MeshStore's own legacy full-state-sync (still active per P3.3's "both paths coexist" transition) makes any two mesh-connected stores instantly aware of every room the moment they connect, so a genuinely two-peer test can never actually exercise the "room I've never heard of" case this code exists for -- exactly the scenario section 4 of the design doc names as a real regression, not something a live two-store test can reach today. Testing the handler and the remote-join path directly, against fakes, is the only way to exercise this code before P3.8 retires the legacy path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
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
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { MeshStore } from "../core/mesh-store.js";
import { ownerNamedRoomPath } from "../core/room-path.js";
import {
  loadOrCreateIdentity,
  loadRoomTokens,
} from "../core/identity-store.js";
import type { IdentitySlot } from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { loadOrCreateUserIdentity } from "../core/user-identity.js";
import type { ConnectionHandle, MeshTransport } from "../core/transport.js";
import { wireTestTransport } from "./test-transport.js";

const DEVICE_ID_HEX_LENGTH = 64;
const TOKEN_TTL_MS = 60_000;
const REQUESTER_ID = "b".repeat(DEVICE_ID_HEX_LENGTH);

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
    expect(handler, "expected a registered room.join handler").toBeTruthy();
    if (handler === undefined)
      throw new Error("expected a registered room.join handler");
    const handle: ConnectionHandle = { id: REQUESTER_ID };
    const { request } = fakeRequest(room.id);

    const outcomePromise = handler(request, handle);

    expect(store.listPendingRoomJoins()).toEqual([
      { roomPath: room.id, requesterId: REQUESTER_ID },
    ]);

    store.acceptRoomJoin(room.id, REQUESTER_ID);
    const outcome = await outcomePromise;

    expect(outcome.result).toBe("ok");
    if (outcome.result !== "ok") return;
    expect(store.listPendingRoomJoins()).toEqual([]);

    const token = outcome["granted-token"];
    expect(token, "expected a granted-token in the outcome").toBeDefined();

    const roomAfterJoin = await store.getRoom(room.id);
    expect(roomAfterJoin?.members.includes(REQUESTER_ID)).toBeTruthy();
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
    expect(handler).toBeTruthy();
    if (handler === undefined)
      throw new Error("expected a room.join handler to be registered");
    const handle: ConnectionHandle = { id: REQUESTER_ID };
    const { request } = fakeRequest(room.id);

    const outcomePromise = handler(request, handle);
    store.rejectRoomJoin(room.id, REQUESTER_ID);
    const outcome = await outcomePromise;

    expect(outcome.result).toBe("error");
    const roomAfterReject = await store.getRoom(room.id);
    expect(roomAfterReject?.members.includes(REQUESTER_ID)).toBe(false);
  });

  it("refuses a DM path naming neither of its own device as a participant, with no pending entry created", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    // Neither "c"x64 nor "d"x64 is this store's own peerId, so this DM path names a conversation the store has no part in -- the dm-admission integration tests cover the genuinely-a-participant case end to end.
    const dmPath = `${deviceIdToHex(deviceIdFromHex("c".repeat(DEVICE_ID_HEX_LENGTH)))}+${deviceIdToHex(deviceIdFromHex("d".repeat(DEVICE_ID_HEX_LENGTH)))}`;

    const handler = store.roomVerbHandlers["room.join"];
    expect(handler).toBeTruthy();
    if (handler === undefined)
      throw new Error("expected a room.join handler to be registered");
    const handle: ConnectionHandle = { id: REQUESTER_ID };
    const { request } = fakeRequest(dmPath);

    const outcome = await handler(request, handle);

    expect(outcome.result).toBe("error");
    expect(store.listPendingRoomJoins()).toEqual([]);
  });

  it("refuses a named room this store doesn't own", async () => {
    const store = new MeshStore();
    await wireTestTransport(store);
    const someoneElse = "e".repeat(DEVICE_ID_HEX_LENGTH);
    const roomPath = ownerNamedRoomPath(someoneElse, "general");

    const handler = store.roomVerbHandlers["room.join"];
    expect(handler).toBeTruthy();
    if (handler === undefined)
      throw new Error("expected a room.join handler to be registered");
    const handle: ConnectionHandle = { id: REQUESTER_ID };
    const { request } = fakeRequest(roomPath);

    const outcome = await handler(request, handle);

    expect(outcome.result).toBe("error");
    expect(store.listPendingRoomJoins()).toEqual([]);
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
    const userIdentityOptions = {
      dir: fs.mkdtempSync(
        path.join(tmpdir(), "agent-comms-test-user-identity-"),
      ),
    };
    store.setIdentity({
      identity: identityPort,
      clock: createSystemClock(),
      slot,
      revocation: createRevocationView(),
      dataStorage: createMemoryStorage(),
      userIdentity: await toIdentityPort(
        loadOrCreateUserIdentity(userIdentityOptions),
      ),
      userIdentityOptions,
    });

    const ownerId = "f".repeat(DEVICE_ID_HEX_LENGTH);
    const roomPath = ownerNamedRoomPath(ownerId, "general");
    // A real, validly-minted token -- roomJoinOkSchema validates the wire response's own granted-token shape against the real CapabilityToken schema, so a hand-rolled fixture would just fail that validation. Minted here by the requester's own identity purely as a stand-in for "any real token the owner could have sent"; who actually signed it plays no part in this test, only that saveRoomToken's own CapabilityToken contract is satisfied.
    const grantedTokenVerdict = await mintCapabilityToken({
      identity: identityPort,
      clock: createSystemClock(),
      tokenId: new Uint8Array([1]),
      bearer: deviceIdFromHex(store.peerId),
      capability: "room:member",
      scope: { kind: "room", path: roomPath },
      expires: Date.now() + TOKEN_TTL_MS,
      delegationsRemaining: 0,
    });
    expect(
      grantedTokenVerdict.ok,
      "expected the fixture token to mint successfully",
    ).toBeTruthy();
    if (!grantedTokenVerdict.ok) return;
    const grantedToken = grantedTokenVerdict.token;

    let capturedRoomPath: string | undefined;
    const fakeTransport: MeshTransport = {
      dataPort: 0,
      isCoordinator: false,
      hasCoordinatorConnection: false,
      coordinatorPeerId: undefined,
      startDataServer: async () => {},
      connectToCoordinator: async () => {},
      becomeCoordinator: async () => {},
      connectToPeer: async () => {},
      send: async () => {},
      acceptConnection: async () => {},
      rejectConnection: async () => {},
      connectToRemote: async () => {},
      broadcast: async () => {},
      broadcastRevocation: async () => {},
      sendRoomRequest: async (_memberId, command, scope) => {
        capturedRoomPath = scope.path;
        expect(command.params).toEqual({ verb: "room.join" });
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

    expect(await store.getRoom(roomPath)).toBe(undefined);

    const joined = await store.joinRoom(roomPath, store.peerId);

    expect(joined.id).toBe(roomPath);
    expect(capturedRoomPath).toBe(roomPath);
    expect(joined.members.includes(store.peerId)).toBeTruthy();

    const tokens = loadRoomTokens(slot);
    expect(
      tokens[roomPath],
      "expected the granted token to be persisted",
    ).toBeDefined();
  });
});
