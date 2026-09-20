/**
 * The shared DI harness every RoomProtocol unit-test file builds against: real identities and real minted tokens (token verification here is genuinely cryptographic, unlike room-messaging.ts's sending side, which never inspects a token's own structure), a fake transport whose sendRoomRequest each test drives, and a fake delivery engine whose calls each test asserts on. Extracted so the three RoomProtocol test files share one harness rather than each carrying its own copy of it.
 */
import { vi } from "vitest";
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
import { RoomProtocol, type RoomProtocolDeps } from "../core/room-protocol.js";
import { randomId } from "../core/random-id.js";
import type { AgentIdentity, Room } from "../core/types.js";

/** Far longer than any test runs, so a pending join is never expired unless a test says so. */
export const JOIN_DECISION_TIMEOUT_MS = 600_000;

export const TOKEN_TTL_MS = 60_000;
/** A device-id is a 64-character lowercase hex SHA-256 digest; room-path.ts's assertDeviceIdHex rejects anything shorter. */
export const DEVICE_ID_HEX_LENGTH = 64;
/** Distinct, real random ids for fixture message/ref/token ids -- randomId() is the exact utility production code (admitRoomJoin, sendRoomMessageDirected) uses for the identical purpose, so these fixtures need no arbitrary literal bytes of their own. */
export const SAMPLE_MESSAGE_ID = randomId();
/** A message-id this store will never recognise, standing in for "already expired from history". */
export const UNRECOGNISED_MESSAGE_ID = randomId();
/** Arbitrary, distinctive placeholder bytes for a message-ref's own id. */
export const SAMPLE_REF_ID = randomId();
export const SAMPLE_TOKEN_ID = randomId();

export function room(overrides: Partial<Room> = {}): Room {
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

export function agent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: "",
    version: 1,
    name: "agent-name",
    harness: "pi",
    cwd: "/tmp/agent",
    pid: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
    ...overrides,
  };
}

export interface Identities {
  ownerId: string;
  ownerPort: Awaited<ReturnType<typeof toIdentityPort>>;
  memberId: string;
}

export async function makeIdentities(): Promise<Identities> {
  const owner = generateIdentity();
  const member = generateIdentity();
  return {
    ownerId: bytesToHex(Uint8Array.from(owner.deviceId)),
    ownerPort: await toIdentityPort(owner),
    memberId: bytesToHex(Uint8Array.from(member.deviceId)),
  };
}

export async function mintRoomToken(
  issuerPort: Awaited<ReturnType<typeof toIdentityPort>>,
  bearerHex: string,
  roomPath: string,
): Promise<CapabilityToken> {
  const clock = createSystemClock();
  const verdict = await mintCapabilityToken({
    identity: issuerPort,
    clock,
    tokenId: SAMPLE_TOKEN_ID,
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

export interface Harness {
  deps: RoomProtocolDeps;
  /** Moves this harness's own clock, the one RoomProtocol reads for queue ages, forward by the given number of milliseconds. Every other collaborator reads the same clock, so a test that jumps it forward is jumping the store's whole notion of now, exactly as real elapsed time would. */
  advanceClock: (ms: number) => void;
  protocol: RoomProtocol;
  ids: Identities;
  slotDir: string;
  queueDelivery: ReturnType<typeof vi.fn>;
  fireLocalDelivery: ReturnType<typeof vi.fn>;
  bump: ReturnType<typeof vi.fn>;
  recordMemberOp: ReturnType<typeof vi.fn>;
  refreshMembership: ReturnType<typeof vi.fn>;
  broadcastPatch: ReturnType<typeof vi.fn>;
  deliverToRoom: ReturnType<typeof vi.fn>;
  revokeMemberGrant: ReturnType<typeof vi.fn>;
  sendRoomRequest: ReturnType<typeof vi.fn>;
}

export async function makeHarness(): Promise<Harness> {
  const ids = await makeIdentities();
  const systemClock = createSystemClock();
  let clockOffsetMs = 0;
  const clock = { now: () => systemClock.now() + clockOffsetMs };
  const slotDir = fs.mkdtempSync(path.join(tmpdir(), "room-protocol-test-"));
  const slot = { harness: "test", cwd: "room-protocol", dir: slotDir };
  // saveRoomToken/saveIssuedRoomGrant write into this slot's own persisted identity file, which must already exist on disk -- unrelated to which crypto identity requireIdentity() uses for minting/verifying, purely a filesystem bookkeeping precondition.
  loadOrCreateIdentity(slot);
  const queueDelivery =
    vi.fn<RoomProtocolDeps["deliveryEngine"]["queueDelivery"]>();
  const fireLocalDelivery =
    vi.fn<RoomProtocolDeps["deliveryEngine"]["fireLocalDelivery"]>();
  const bump = vi.fn();
  const recordMemberOp =
    vi.fn<RoomProtocolDeps["deliveryEngine"]["recordMemberOp"]>();
  const refreshMembership =
    vi.fn<RoomProtocolDeps["deliveryEngine"]["refreshMembership"]>();
  const broadcastPatch = vi.fn().mockResolvedValue(undefined);
  const deliverToRoom = vi.fn().mockResolvedValue(undefined);
  const revokeMemberGrant = vi.fn().mockResolvedValue(undefined);
  const sendRoomRequest = vi
    .fn()
    .mockResolvedValue({ result: "ok" } satisfies ManageOutcome);

  const deps: RoomProtocolDeps = {
    rooms: new Map(),
    messages: new Map(),
    dms: new Map(),
    agents: new Map(),
    dmRequestsInitiatedByMe: new Set(),
    getPeerId: () => ids.ownerId,
    requireIdentity: () => ({
      identity: ids.ownerPort,
      clock,
      slot,
      revocation: createRevocationView(),
      dataStorage: {} as never,
      userIdentity: {} as never,
      userIdentityOptions: {},
    }),
    requireTransport: () =>
      ({ sendRoomRequest }) as unknown as ReturnType<
        RoomProtocolDeps["requireTransport"]
      >,
    deliveryEngine: {
      queueDelivery,
      fireLocalDelivery,
      bump,
      recordMemberOp,
      refreshMembership,
      broadcastPatch,
      deliverToRoom,
    },
    joinDecisionTimeoutMs: JOIN_DECISION_TIMEOUT_MS,
    revokeMemberGrant,
  };

  return {
    deps,
    advanceClock: (ms: number) => {
      clockOffsetMs += ms;
    },
    protocol: new RoomProtocol(deps),
    ids,
    slotDir,
    queueDelivery,
    fireLocalDelivery,
    bump,
    recordMemberOp,
    refreshMembership,
    broadcastPatch,
    deliverToRoom,
    revokeMemberGrant,
    sendRoomRequest,
  };
}

export function handle(deviceHex: string): { id: string } {
  return { id: deviceHex };
}

export function manageRequest(
  overrides: {
    scope?: { kind: string; path?: string };
    token?: CapabilityToken | undefined;
    params?: Record<string, unknown>;
  } = {},
): IncomingManageRequest {
  return {
    requestId: 1,
    command: { verb: "room:member", params: overrides.params ?? {} },
    scope: overrides.scope ?? { kind: "room", path: "room-1" },
    token: overrides.token,
    respond: vi.fn().mockResolvedValue(undefined),
  } as unknown as IncomingManageRequest;
}
