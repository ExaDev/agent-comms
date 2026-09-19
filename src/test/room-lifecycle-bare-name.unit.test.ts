/**
 * Direct, DI-based unit tests for how RoomLifecycle resolves a bare room name (agent-comms#246): listRooms surfaces a room discovered through another device's gossiped hosted-room advert under its bare `name`, so every room action that accepts a name has to resolve against the same discovered rooms, not only against rooms already replicated into this store's own map.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { bytesToHex, deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import { generateIdentity } from "../core/identity.js";
import { loadOrCreateIdentity } from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { ownerNamedRoomPath } from "../core/room-path.js";
import { randomId } from "../core/random-id.js";
import {
  RoomLifecycle,
  type RoomLifecycleDeps,
} from "../core/room-lifecycle.js";
import type { Room } from "../core/types.js";

const TOKEN_TTL_MS = 60_000;

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: "room-1",
    version: 1,
    name: "room-name",
    type: "public",
    owner: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    description: "a room",
    members: [],
    invited: [],
    memberJoins: {},
    memberLeaves: {},
    invitedJoins: {},
    invitedLeaves: {},
    ...overrides,
  };
}

interface Advertised {
  hostId: string;
  path: string;
  name: string;
}

interface Harness {
  lifecycle: RoomLifecycle;
  rooms: Map<string, Room>;
  selfId: string;
  hostA: string;
  hostB: string;
  sendRoomRequest: ReturnType<typeof vi.fn>;
  advertise: (adverts: readonly Advertised[]) => void;
  grantFor: (roomPath: string) => Promise<ManageOutcome>;
}

/** A RoomLifecycle whose transport fake answers listKnownDevices from whatever advertise() last set, and whose sendRoomRequest records the room-path it was asked to join. */
async function makeHarness(): Promise<Harness> {
  const self = generateIdentity();
  const hostA = generateIdentity();
  const hostB = generateIdentity();
  const selfPort = await toIdentityPort(self);
  const selfId = bytesToHex(Uint8Array.from(self.deviceId));
  const hostAId = bytesToHex(Uint8Array.from(hostA.deviceId));
  const hostBId = bytesToHex(Uint8Array.from(hostB.deviceId));
  const slotDir = fs.mkdtempSync(path.join(tmpdir(), "room-bare-name-test-"));
  const slot = { harness: "test", cwd: "room-bare-name", dir: slotDir };
  loadOrCreateIdentity(slot);

  let adverts: readonly Advertised[] = [];
  const sendRoomRequest = vi.fn();
  const rooms = new Map<string, Room>();
  const deps: RoomLifecycleDeps = {
    rooms,
    messages: new Map(),
    agents: new Map(),
    dmRequestsInitiatedByMe: new Set(),
    getPeerId: () => selfId,
    requireIdentity: () => ({
      identity: selfPort,
      clock: createSystemClock(),
      slot,
      revocation: createRevocationView(),
      dataStorage: {} as never,
      userIdentity: {} as never,
      userIdentityOptions: {},
    }),
    requireTransport: () =>
      ({
        sendRoomRequest,
        listKnownDevices: () =>
          [hostAId, hostBId].map((deviceId) => ({
            deviceId,
            advert: {
              "room/hosted": adverts
                .filter((advert) => advert.hostId === deviceId)
                .map(({ path: advertPath, name }) => ({
                  path: advertPath,
                  name,
                  type: "public",
                  description: "",
                })),
            },
          })),
      }) as unknown as ReturnType<RoomLifecycleDeps["requireTransport"]>,
    deliveryEngine: {
      bump: vi.fn(),
      recordMemberOp:
        vi.fn<RoomLifecycleDeps["deliveryEngine"]["recordMemberOp"]>(),
      refreshMembership:
        vi.fn<RoomLifecycleDeps["deliveryEngine"]["refreshMembership"]>(),
      broadcastPatch: vi.fn().mockResolvedValue(undefined),
      deliverToRoom: vi.fn().mockResolvedValue(undefined),
      deliverToMember: vi.fn().mockResolvedValue(undefined),
    },
  };

  const hostAPort = await toIdentityPort(hostA);
  return {
    lifecycle: new RoomLifecycle(deps),
    rooms,
    selfId,
    hostA: hostAId,
    hostB: hostBId,
    sendRoomRequest,
    advertise: (next) => {
      adverts = next;
    },
    grantFor: async (roomPath) => {
      const clock = createSystemClock();
      const verdict = await mintCapabilityToken({
        identity: hostAPort,
        clock,
        tokenId: randomId(),
        bearer: deviceIdFromHex(selfId),
        capability: "room:member",
        scope: { kind: "room", path: roomPath },
        expires: clock.now() + TOKEN_TTL_MS,
        delegationsRemaining: 0,
      });
      if (!verdict.ok)
        throw new Error("expected the fixture token to mint successfully");
      return {
        result: "ok",
        "granted-token": verdict.token,
        members: [{ device: deviceIdFromHex(hostAId) }],
      } as unknown as ManageOutcome;
    },
  };
}

describe("RoomLifecycle bare-name resolution over gossip-discovered rooms", () => {
  it("joinRoom sends the join request for the discovered room's full path when given its bare name", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.hostA, "e2e-test");
    h.advertise([{ hostId: h.hostA, path: roomPath, name: "e2e-test" }]);
    h.sendRoomRequest.mockResolvedValue(await h.grantFor(roomPath));

    const joined = await h.lifecycle.joinRoom("e2e-test", h.selfId);

    expect(joined.id).toBe(roomPath);
    expect(h.sendRoomRequest).toHaveBeenCalledWith(h.hostA, expect.anything(), {
      kind: "room",
      path: roomPath,
    });
  });

  it("throws AMBIGUOUS_ROOM_NAME naming every candidate when two hosts advertise the same name", async () => {
    const h = await makeHarness();
    const pathA = ownerNamedRoomPath(h.hostA, "e2e-test");
    const pathB = ownerNamedRoomPath(h.hostB, "e2e-test");
    h.advertise([
      { hostId: h.hostA, path: pathA, name: "e2e-test" },
      { hostId: h.hostB, path: pathB, name: "e2e-test" },
    ]);

    const rejection = h.lifecycle.joinRoom("e2e-test", h.selfId);

    await expect(rejection).rejects.toMatchObject({
      code: "AMBIGUOUS_ROOM_NAME",
    });
    await expect(rejection).rejects.toThrow(pathA);
    await expect(rejection).rejects.toThrow(pathB);
    expect(h.sendRoomRequest).not.toHaveBeenCalled();
  });

  it("treats a discovered room and a replicated copy of the same room as one candidate, not an ambiguity", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.hostA, "e2e-test");
    h.rooms.set(
      roomPath,
      room({ id: roomPath, name: "e2e-test", owner: h.hostA }),
    );
    h.advertise([{ hostId: h.hostA, path: roomPath, name: "e2e-test" }]);
    h.sendRoomRequest.mockResolvedValue(await h.grantFor(roomPath));

    const joined = await h.lifecycle.joinRoom("e2e-test", h.selfId);

    expect(joined.id).toBe(roomPath);
  });

  it("throws AMBIGUOUS_ROOM_NAME when a local room and a discovered room from another host share a name", async () => {
    const h = await makeHarness();
    const localPath = ownerNamedRoomPath(h.selfId, "e2e-test");
    const remotePath = ownerNamedRoomPath(h.hostA, "e2e-test");
    h.rooms.set(
      localPath,
      room({ id: localPath, name: "e2e-test", owner: h.selfId }),
    );
    h.advertise([{ hostId: h.hostA, path: remotePath, name: "e2e-test" }]);

    await expect(
      h.lifecycle.joinRoom("e2e-test", h.selfId),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_ROOM_NAME" });
  });

  it("still accepts the full room-path of a discovered room", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.hostA, "e2e-test");
    h.advertise([{ hostId: h.hostA, path: roomPath, name: "e2e-test" }]);
    h.sendRoomRequest.mockResolvedValue(await h.grantFor(roomPath));

    const joined = await h.lifecycle.joinRoom(roomPath, h.selfId);

    expect(joined.id).toBe(roomPath);
  });
});
