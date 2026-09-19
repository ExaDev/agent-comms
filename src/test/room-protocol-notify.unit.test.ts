/**
 * Direct, DI-based unit tests for RoomProtocol's handleRoomNotify (P3.8's directed-delivery replacement for informational events, agent-comms#48) -- moved into its own file to stay under the repo's max-lines cap once room-protocol.test.ts and room-protocol-admission.test.ts were already at capacity. Real identities and real minted tokens throughout, matching those two files' own established convention (handleRoomNotify genuinely verifies tokens cryptographically, so an opaque placeholder string fails the mint/verify outright).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { bytesToHex, deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import { generateIdentity } from "../core/identity.js";
import { loadOrCreateIdentity } from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { ownerNamedRoomPath } from "../core/room-path.js";
import { RoomProtocol, type RoomProtocolDeps } from "../core/room-protocol.js";
import { randomId } from "../core/random-id.js";
import type { DeliveryEvent, Room } from "../core/types.js";

/** Far longer than any test runs, so a pending join is never expired unless a test says so. */
const JOIN_DECISION_TIMEOUT_MS = 600_000;

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

interface Identities {
  ownerId: string;
  ownerPort: Awaited<ReturnType<typeof toIdentityPort>>;
  memberId: string;
}

async function makeIdentities(): Promise<Identities> {
  const owner = generateIdentity();
  const member = generateIdentity();
  return {
    ownerId: bytesToHex(Uint8Array.from(owner.deviceId)),
    ownerPort: await toIdentityPort(owner),
    memberId: bytesToHex(Uint8Array.from(member.deviceId)),
  };
}

async function mintRoomToken(
  issuerPort: Awaited<ReturnType<typeof toIdentityPort>>,
  bearerHex: string,
  roomPath: string,
): Promise<CapabilityToken> {
  const clock = createSystemClock();
  const verdict = await mintCapabilityToken({
    identity: issuerPort,
    clock,
    tokenId: randomId(),
    bearer: deviceIdFromHex(bearerHex),
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires: clock.now() + TOKEN_TTL_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok)
    throw new Error("expected the fixture token to mint successfully");
  return verdict.token;
}

interface Harness {
  deps: RoomProtocolDeps;
  protocol: RoomProtocol;
  ids: Identities;
  queueDelivery: ReturnType<typeof vi.fn>;
  fireLocalDelivery: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<Harness> {
  const ids = await makeIdentities();
  const slotDir = fs.mkdtempSync(
    path.join(tmpdir(), "room-protocol-notify-test-"),
  );
  const slot = { harness: "test", cwd: "room-protocol-notify", dir: slotDir };
  loadOrCreateIdentity(slot);
  const queueDelivery =
    vi.fn<RoomProtocolDeps["deliveryEngine"]["queueDelivery"]>();
  const fireLocalDelivery =
    vi.fn<RoomProtocolDeps["deliveryEngine"]["fireLocalDelivery"]>();

  const deps: RoomProtocolDeps = {
    rooms: new Map(),
    messages: new Map(),
    dms: new Map(),
    agents: new Map(),
    dmRequestsInitiatedByMe: new Set(),
    getPeerId: () => ids.ownerId,
    requireIdentity: () => ({
      identity: ids.ownerPort,
      clock: createSystemClock(),
      slot,
      revocation: createRevocationView(),
      dataStorage: {} as never,
      userIdentity: {} as never,
      userIdentityOptions: {},
    }),
    requireTransport: () =>
      ({}) as unknown as ReturnType<RoomProtocolDeps["requireTransport"]>,
    deliveryEngine: {
      queueDelivery,
      fireLocalDelivery,
      bump: vi.fn(),
      recordMemberOp:
        vi.fn<RoomProtocolDeps["deliveryEngine"]["recordMemberOp"]>(),
      refreshMembership:
        vi.fn<RoomProtocolDeps["deliveryEngine"]["refreshMembership"]>(),
      broadcastPatch: vi.fn().mockResolvedValue(undefined),
      deliverToRoom: vi.fn().mockResolvedValue(undefined),
    },
    joinDecisionTimeoutMs: JOIN_DECISION_TIMEOUT_MS,
    revokeMemberGrant: vi.fn().mockResolvedValue(undefined),
  };

  return {
    deps,
    protocol: new RoomProtocol(deps),
    ids,
    queueDelivery,
    fireLocalDelivery,
  };
}

function handle(deviceHex: string): { id: string } {
  return { id: deviceHex };
}

function manageRequest(
  overrides: {
    scope?: { kind: string; path?: string };
    token?: CapabilityToken | undefined;
    params?: Record<string, unknown>;
  } = {},
): IncomingManageRequest {
  return {
    requestId: 1,
    command: { verb: "room:member", params: overrides.params ?? {} },
    scope: overrides.scope ?? { kind: "room" },
    token: overrides.token,
    respond: vi.fn().mockResolvedValue(undefined),
  } as unknown as IncomingManageRequest;
}

describe("RoomProtocol — handleRoomNotify", () => {
  let h: Harness;
  let ownerNamedRoom: string;

  beforeEach(async () => {
    h = await makeHarness();
    ownerNamedRoom = ownerNamedRoomPath(h.ids.ownerId, "general");
    h.deps.rooms.set(
      ownerNamedRoom,
      room({
        id: ownerNamedRoom,
        owner: h.ids.ownerId,
        members: [h.ids.ownerId, h.ids.memberId],
      }),
    );
  });

  async function notify(
    params: Record<string, unknown>,
    token: CapabilityToken | undefined,
  ): Promise<ManageOutcome> {
    const handler = h.protocol.roomVerbHandlers["room.notify"];
    if (handler === undefined) throw new Error("expected room.notify handler");
    return handler(
      manageRequest({
        scope: { kind: "room", path: ownerNamedRoom },
        token,
        params,
      }),
      handle(h.ids.memberId),
    );
  }

  it("returns missing_scope_path when the request carries no room path", async () => {
    const handler = h.protocol.roomVerbHandlers["room.notify"];
    if (handler === undefined) throw new Error("expected room.notify handler");
    const outcome = await handler(
      manageRequest({ scope: { kind: "room" } }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "missing_scope_path" });
  });

  it("returns unauthorized when no token is presented", async () => {
    const outcome = await notify(
      { verb: "room.notify", event: { type: "member_joined" } },
      undefined,
    );
    expect(outcome).toEqual({ result: "error", code: "unauthorized" });
  });

  it("returns malformed_params for an event that doesn't parse as a real DeliveryEvent", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const outcome = await notify(
      { verb: "room.notify", event: { type: "not-a-real-type" } },
      token,
    );
    expect(outcome).toEqual({ result: "error", code: "malformed_params" });
  });

  it("returns malformed_params when the event's own room field doesn't match the token's verified scope", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const event: DeliveryEvent = {
      type: "member_status",
      room: "a-different-room-entirely",
      agent: h.ids.memberId,
      status: "idle",
    };
    const outcome = await notify({ verb: "room.notify", event }, token);
    expect(outcome).toEqual({ result: "error", code: "malformed_params" });
  });

  it("queues and fires local delivery for a well-formed, correctly-scoped event", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const event: DeliveryEvent = {
      type: "member_status",
      room: ownerNamedRoom,
      agent: h.ids.memberId,
      status: "busy",
    };
    const outcome = await notify({ verb: "room.notify", event }, token);
    expect(outcome).toEqual({ result: "ok" });
    expect(h.queueDelivery).toHaveBeenCalledWith(h.ids.ownerId, event);
    expect(h.fireLocalDelivery).toHaveBeenCalledWith(h.ids.ownerId, event);
  });
});
