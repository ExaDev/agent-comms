/**
 * Direct, DI-based unit tests for RoomMessaging -- it was previously exercised only indirectly through end-to-end room-send integration tests, leaving many individual branches (optional-field spreads, error message text, since-filtering boundaries, self-DM vs cross-DM key derivation) unobserved. RoomMessagingDeps is a narrow, injectable surface built exactly for this. loadRoomTokens is a free function reading a real identity file, not part of the injectable deps -- mocked here since RoomMessaging only ever forwards its return value opaquely, never inspects or verifies it.
 *
 * Two mutants Stryker raises against readRoomMessages' `since === undefined || since === ""` check are practical equivalents, not gaps -- documented here rather than chased with a contrived test. Both replace the `since === ""` comparison (one with the literal `false`, one with `since === "Stryker was here!"`) and both share the identical root cause: whenever the real code's early-return branch would fire on `since === ""`, the mutant instead falls through to `arr.filter(m => m.timestamp > since)` with `since` still `""` -- and every RoomMessage in this codebase is constructed with `new Date().toISOString()`, never an empty string, so `m.timestamp > ""` is true for every real message regardless of which branch runs. The early-return and the filter produce identical output for any timestamp this codebase can actually produce; only a RoomMessage with an empty-string timestamp (violating that invariant) would distinguish them, and fabricating one would be exactly the kind of contrived test this repo's own convention (see stale-agent-checker.test.ts) says to document instead of force.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dmRoomPath } from "../core/room-path.js";
import { resolveRoomId } from "../core/room-lookup.js";
import { loadRoomTokens } from "../core/identity-store.js";
import {
  RoomMessaging,
  type RoomMessagingDeps,
} from "../core/room-messaging.js";
import type { AgentIdentity, Room } from "../core/types.js";
import { CommsError } from "../core/store.js";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";

vi.mock("../core/identity-store.js", () => ({
  loadRoomTokens: vi.fn(),
}));

// Opaque placeholder: RoomMessaging never inspects a token's own COSE_Sign1 structure, only forwards whatever loadRoomTokens returns to sendRoomRequestToMember -- so any distinguishable value stands in for a real one in these tests.
const FAKE_TOKEN = "fake-token" as unknown as CapabilityToken;

/** A device-id is a 64-character lowercase hex SHA-256 digest; room-path.ts's assertDeviceIdHex rejects anything shorter. */
const DEVICE_ID_HEX_LENGTH = 64;
/** A message/token id is 16 random bytes, hex-encoded to 32 characters -- randomId()'s own convention, matched here so bytesFromHex doesn't reject the fixture. */
const MESSAGE_ID_BYTE_LENGTH = 16;
const FROM_DEVICE_ID = "a".repeat(DEVICE_ID_HEX_LENGTH);
const TO_DEVICE_ID = "b".repeat(DEVICE_ID_HEX_LENGTH);
/** A third room member, so a fan-out test can show one member's outcome not affecting another's. */
const OTHER_DEVICE_ID = "c".repeat(DEVICE_ID_HEX_LENGTH);
const NOW_MS = 1_700_000_000_000;

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: "room-1",
    version: 1,
    name: "room-name",
    type: "public",
    owner: FROM_DEVICE_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    description: "",
    members: [FROM_DEVICE_ID],
    invited: [],
    memberJoins: {},
    memberLeaves: {},
    invitedJoins: {},
    invitedLeaves: {},
    ...overrides,
  };
}

function agent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: TO_DEVICE_ID,
    version: 1,
    name: "recipient",
    harness: "pi",
    cwd: "/tmp",
    pid: 111,
    startedAt: "2026-01-01T00:00:00.000Z",
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
    ...overrides,
  };
}

function makeHarness() {
  const sendRoomRequestToMember = vi
    .fn()
    .mockResolvedValue({ kind: "delivered" });
  const requestDmAccess = vi.fn().mockResolvedValue(undefined);
  // Backs the default resolveAgent mock below -- a plain lookup Map standing in for AgentRegistry.getAgent's own real "known, else gossip-discovered" resolution, which RoomMessaging itself never sees; it only calls resolveAgent opaquely.
  const agents = new Map<string, AgentIdentity>();
  const resolveAgent = vi
    .fn()
    .mockImplementation(async (id: string) => agents.get(id));
  const rooms = new Map<string, Room>();
  // Stands in for RoomLifecycle.resolveRoomId, which RoomMessaging only reaches through this dependency: resolves against the harness's own rooms, the same way the real one does for rooms this store holds.
  const resolveRoomIdMock = vi
    .fn()
    .mockImplementation((roomIdOrName: string) =>
      resolveRoomId(rooms.values(), roomIdOrName),
    );
  const deps: RoomMessagingDeps = {
    rooms,
    messages: new Map(),
    dms: new Map(),
    requireIdentity: () => ({
      slot: { harness: "pi", cwd: "/tmp" },
      clock: { now: () => NOW_MS },
      identity: {} as never,
      revocation: {} as never,
      dataStorage: {} as never,
      userIdentity: {} as never,
      userIdentityOptions: {},
    }),
    roomProtocol: { sendRoomRequestToMember },
    requestDmAccess,
    resolveAgent,
    resolveRoomId: resolveRoomIdMock,
  };
  return {
    resolveRoomId: resolveRoomIdMock,
    agents,
    resolveAgent,
    deps,
    messaging: new RoomMessaging(deps),
    sendRoomRequestToMember,
    requestDmAccess,
  };
}

type H = ReturnType<typeof makeHarness>;

beforeEach(() => {
  vi.mocked(loadRoomTokens).mockReset();
  vi.mocked(loadRoomTokens).mockReturnValue({ "room-1": FAKE_TOKEN });
});

describe("RoomMessaging — sendRoomMessage", () => {
  it("throws ROOM_NOT_FOUND naming the exact room id when the room doesn't exist", async () => {
    const h = makeHarness();
    await expect(
      h.messaging.sendRoomMessage("no-such-room", FROM_DEVICE_ID, "hi"),
    ).rejects.toMatchObject({
      message: "Room no-such-room not found",
      code: "ROOM_NOT_FOUND",
    });
  });

  it("looks the room up by the id its bare name resolves to", async () => {
    const h = makeHarness();
    const roomPath = `${TO_DEVICE_ID}/general`;
    h.deps.rooms.set(
      roomPath,
      room({ id: roomPath, name: "general", members: [FROM_DEVICE_ID] }),
    );
    vi.mocked(loadRoomTokens).mockReturnValue({ [roomPath]: FAKE_TOKEN });

    const { message } = await h.messaging.sendRoomMessage(
      "general",
      FROM_DEVICE_ID,
      "hi",
    );

    expect(h.resolveRoomId).toHaveBeenCalledWith("general");
    expect(message.room).toBe(roomPath);
  });

  it("propagates the resolver's ambiguity error instead of picking a room", async () => {
    const h = makeHarness();
    h.deps.rooms.set(
      `${FROM_DEVICE_ID}/general`,
      room({ id: `${FROM_DEVICE_ID}/general`, name: "general" }),
    );
    h.deps.rooms.set(
      `${TO_DEVICE_ID}/general`,
      room({ id: `${TO_DEVICE_ID}/general`, name: "general" }),
    );

    await expect(
      h.messaging.sendRoomMessage("general", FROM_DEVICE_ID, "hi"),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_ROOM_NAME" });
  });

  it("throws NOT_MEMBER naming the exact room id when the sender isn't a member", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ members: [] }));
    await expect(
      h.messaging.sendRoomMessage("room-1", FROM_DEVICE_ID, "hi"),
    ).rejects.toMatchObject({
      message: "Not a member of room-1",
      code: "NOT_MEMBER",
    });
  });

  it("throws NOT_MEMBER naming the exact room id when no room:member token is persisted", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room());
    vi.mocked(loadRoomTokens).mockReturnValue({});
    await expect(
      h.messaging.sendRoomMessage("room-1", FROM_DEVICE_ID, "hi"),
    ).rejects.toMatchObject({
      message: "No room:member token for room-1",
      code: "NOT_MEMBER",
    });
  });

  it("stores the message and records it in the room's history", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room());
    const { message } = await h.messaging.sendRoomMessage(
      "room-1",
      FROM_DEVICE_ID,
      "hello",
    );
    expect(h.deps.messages.get("room-1")).toEqual([message]);
    expect(message.content).toBe("hello");
    expect(message.readBy).toEqual([FROM_DEVICE_ID]);
  });

  it("includes replyTo only when explicitly given", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room());
    const replyToId = "aa".repeat(MESSAGE_ID_BYTE_LENGTH);
    const { message: withReply } = await h.messaging.sendRoomMessage(
      "room-1",
      FROM_DEVICE_ID,
      "hi",
      { replyTo: replyToId },
    );
    expect(withReply.replyTo).toBe(replyToId);

    const { message: withoutReply } = await h.messaging.sendRoomMessage(
      "room-1",
      FROM_DEVICE_ID,
      "hi",
    );
    expect(withoutReply).not.toHaveProperty("replyTo");
  });

  it("includes streamingBehavior on the stored message only when given", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room());

    const { message: withBehavior } = await h.messaging.sendRoomMessage(
      "room-1",
      FROM_DEVICE_ID,
      "hi",
      { streamingBehavior: "steer" },
    );
    expect(withBehavior.streamingBehavior).toBe("steer");

    const { message: withoutBehavior } = await h.messaging.sendRoomMessage(
      "room-1",
      FROM_DEVICE_ID,
      "hi",
    );
    expect(withoutBehavior).not.toHaveProperty("streamingBehavior");
  });

  it("sends a directed request to every other member, never to the sender itself", async () => {
    const h = makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ members: [FROM_DEVICE_ID, "member-b", "member-c"] }),
    );
    await h.messaging.sendRoomMessage("room-1", FROM_DEVICE_ID, "hi");

    expect(h.sendRoomRequestToMember).toHaveBeenCalledTimes(2);
    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      "member-b",
      "room-1",
      FAKE_TOKEN,
      expect.anything(),
    );
    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      "member-c",
      "room-1",
      FAKE_TOKEN,
      expect.anything(),
    );
  });

  it('includes a refs entry with relation "reply" in the wire params only when replyTo is given', async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ members: [FROM_DEVICE_ID, "member-b"] }));
    const replyToId = "aa".repeat(MESSAGE_ID_BYTE_LENGTH);

    await h.messaging.sendRoomMessage("room-1", FROM_DEVICE_ID, "hi", {
      replyTo: replyToId,
    });

    const params = h.sendRoomRequestToMember.mock.calls[0]?.[3] as Record<
      string,
      unknown
    >;
    expect(params.refs).toEqual([
      { id: expect.any(Uint8Array), relation: "reply" },
    ]);
  });

  it("omits refs from the wire params when no replyTo is given", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ members: [FROM_DEVICE_ID, "member-b"] }));

    await h.messaging.sendRoomMessage("room-1", FROM_DEVICE_ID, "hi");

    const params = h.sendRoomRequestToMember.mock.calls[0]?.[3] as Record<
      string,
      unknown
    >;
    expect(params).not.toHaveProperty("refs");
  });

  it("includes streaming-behavior in the wire params only when given", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ members: [FROM_DEVICE_ID, "member-b"] }));

    await h.messaging.sendRoomMessage("room-1", FROM_DEVICE_ID, "hi", {
      streamingBehavior: "steer",
    });

    const params = h.sendRoomRequestToMember.mock.calls[0]?.[3] as Record<
      string,
      unknown
    >;
    expect(params["streaming-behavior"]).toBe("steer");
  });

  it("omits streaming-behavior from the wire params when not given", async () => {
    const h = makeHarness();
    h.deps.rooms.set("room-1", room({ members: [FROM_DEVICE_ID, "member-b"] }));

    await h.messaging.sendRoomMessage("room-1", FROM_DEVICE_ID, "hi");

    const params = h.sendRoomRequestToMember.mock.calls[0]?.[3] as Record<
      string,
      unknown
    >;
    expect(params).not.toHaveProperty("streaming-behavior");
  });
});

describe("RoomMessaging — readRoomMessages", () => {
  const OLDER = "2026-01-01T00:00:00.000Z";
  const MIDDLE = "2026-01-01T00:05:00.000Z";
  const NEWER = "2026-01-01T00:10:00.000Z";

  function seeded(h: H): void {
    h.deps.messages.set("room-1", [
      {
        id: "m1",
        from: "a",
        room: "room-1",
        content: "old",
        timestamp: OLDER,
        readBy: [],
      },
      {
        id: "m2",
        from: "a",
        room: "room-1",
        content: "mid",
        timestamp: MIDDLE,
        readBy: [],
      },
      {
        id: "m3",
        from: "a",
        room: "room-1",
        content: "new",
        timestamp: NEWER,
        readBy: [],
      },
    ]);
  }

  it("returns the full history when since is omitted", async () => {
    const h = makeHarness();
    seeded(h);
    const result = await h.messaging.readRoomMessages("room-1");
    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("returns the full history when since is an empty string", async () => {
    const h = makeHarness();
    seeded(h);
    const result = await h.messaging.readRoomMessages("room-1", "");
    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("returns only messages strictly newer than a real since timestamp", async () => {
    const h = makeHarness();
    seeded(h);
    const result = await h.messaging.readRoomMessages("room-1", MIDDLE);
    expect(result.map((m) => m.id)).toEqual(["m3"]);
  });

  it("returns an empty array for a room with no history", async () => {
    const h = makeHarness();
    const result = await h.messaging.readRoomMessages("no-such-room");
    expect(result).toEqual([]);
  });

  it("filters out every message for an arbitrary since lexically greater than any real timestamp", async () => {
    const h = makeHarness();
    seeded(h);
    // Lexically greater than any real ISO timestamp (which starts with a digit) -- proves filtering genuinely runs and genuinely excludes messages for a since value that isn't "" or undefined, distinct from the empty-string shortcut covered (and its equivalent mutants documented) above.
    const result = await h.messaging.readRoomMessages(
      "room-1",
      "not-a-real-timestamp",
    );
    expect(result).toEqual([]);
  });
});

describe("RoomMessaging — sendDm", () => {
  it("throws AGENT_NOT_FOUND naming the exact recipient id when the recipient doesn't exist", async () => {
    const h = makeHarness();
    await expect(
      h.messaging.sendDm(FROM_DEVICE_ID, TO_DEVICE_ID, "hi"),
    ).rejects.toMatchObject({
      message: `Agent ${TO_DEVICE_ID} not found`,
      code: "AGENT_NOT_FOUND",
    });
  });

  it("throws AGENT_NOT_FOUND naming the exact recipient id when the recipient has ghost visibility", async () => {
    const h = makeHarness();
    h.agents.set(TO_DEVICE_ID, agent({ visibility: "ghost" }));
    await expect(
      h.messaging.sendDm(FROM_DEVICE_ID, TO_DEVICE_ID, "hi"),
    ).rejects.toMatchObject({
      message: `Cannot DM agent ${TO_DEVICE_ID}`,
      code: "AGENT_NOT_FOUND",
    });
  });

  it("resolves the recipient via resolveAgent, not a direct agents-map lookup -- so a remote, gossip-discovered recipient (agent-comms#155) is a valid DM target", async () => {
    const h = makeHarness();
    h.resolveAgent.mockResolvedValue(agent({ visibility: "visible" }));
    vi.mocked(loadRoomTokens).mockReturnValue({
      [dmRoomPath(FROM_DEVICE_ID, TO_DEVICE_ID)]: FAKE_TOKEN,
    });
    const { message } = await h.messaging.sendDm(
      FROM_DEVICE_ID,
      TO_DEVICE_ID,
      "hi",
    );
    expect(h.resolveAgent).toHaveBeenCalledWith(TO_DEVICE_ID);
    expect(message.content).toBe("hi");
  });

  it("skips recipient validation entirely for a self-DM", async () => {
    const h = makeHarness();
    const { message } = await h.messaging.sendDm(
      FROM_DEVICE_ID,
      FROM_DEVICE_ID,
      "note to self",
    );
    expect(message.content).toBe("note to self");
  });

  it("stores a self-DM under a self:<id> key and never dials out", async () => {
    const h = makeHarness();
    const { message } = await h.messaging.sendDm(
      FROM_DEVICE_ID,
      FROM_DEVICE_ID,
      "note to self",
    );
    expect(h.deps.dms.get(`self:${FROM_DEVICE_ID}`)).toEqual([message]);
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
  });

  it("stores a cross-agent DM under the sorted dmRoomPath key and dials the recipient", async () => {
    const h = makeHarness();
    h.agents.set(TO_DEVICE_ID, agent());
    vi.mocked(loadRoomTokens).mockReturnValue({
      [dmRoomPath(FROM_DEVICE_ID, TO_DEVICE_ID)]: FAKE_TOKEN,
    });

    const { message } = await h.messaging.sendDm(
      FROM_DEVICE_ID,
      TO_DEVICE_ID,
      "hi",
    );

    const key = dmRoomPath(FROM_DEVICE_ID, TO_DEVICE_ID);
    expect(h.deps.dms.get(key)).toEqual([message]);
    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      TO_DEVICE_ID,
      key,
      FAKE_TOKEN,
      expect.anything(),
    );
  });

  it("sets readBy to exactly the sender on a new DM", async () => {
    const h = makeHarness();
    const { message } = await h.messaging.sendDm(
      FROM_DEVICE_ID,
      FROM_DEVICE_ID,
      "hi",
    );
    expect(message.readBy).toEqual([FROM_DEVICE_ID]);
  });

  it("includes streamingBehavior on the stored message only when given", async () => {
    const h = makeHarness();
    const { message: withBehavior } = await h.messaging.sendDm(
      FROM_DEVICE_ID,
      FROM_DEVICE_ID,
      "hi",
      "followUp",
    );
    expect(withBehavior.streamingBehavior).toBe("followUp");

    const { message: withoutBehavior } = await h.messaging.sendDm(
      FROM_DEVICE_ID,
      FROM_DEVICE_ID,
      "hi",
    );
    expect(withoutBehavior).not.toHaveProperty("streamingBehavior");
  });

  it("requests DM access from the recipient when no room:member token is persisted, then sends with the token that request granted", async () => {
    const h = makeHarness();
    h.agents.set(TO_DEVICE_ID, agent());
    const key = dmRoomPath(FROM_DEVICE_ID, TO_DEVICE_ID);
    vi.mocked(loadRoomTokens)
      .mockReturnValueOnce({})
      .mockReturnValue({ [key]: FAKE_TOKEN });

    const { message } = await h.messaging.sendDm(
      FROM_DEVICE_ID,
      TO_DEVICE_ID,
      "hi",
    );

    expect(h.requestDmAccess).toHaveBeenCalledExactlyOnceWith(TO_DEVICE_ID);
    expect(h.sendRoomRequestToMember).toHaveBeenCalledWith(
      TO_DEVICE_ID,
      key,
      FAKE_TOKEN,
      expect.anything(),
    );
    expect(h.deps.dms.get(key)).toEqual([message]);
  });

  it("does not request DM access when a room:member token is already persisted", async () => {
    const h = makeHarness();
    h.agents.set(TO_DEVICE_ID, agent());
    vi.mocked(loadRoomTokens).mockReturnValue({
      [dmRoomPath(FROM_DEVICE_ID, TO_DEVICE_ID)]: FAKE_TOKEN,
    });

    await h.messaging.sendDm(FROM_DEVICE_ID, TO_DEVICE_ID, "hi");

    expect(h.requestDmAccess).not.toHaveBeenCalled();
  });

  it("never requests DM access for a self-DM", async () => {
    const h = makeHarness();

    await h.messaging.sendDm(FROM_DEVICE_ID, FROM_DEVICE_ID, "note");

    expect(h.requestDmAccess).not.toHaveBeenCalled();
  });

  it("surfaces a refused DM access request and records nothing locally or on the wire", async () => {
    const h = makeHarness();
    h.agents.set(TO_DEVICE_ID, agent());
    vi.mocked(loadRoomTokens).mockReturnValue({});
    h.requestDmAccess.mockRejectedValue(
      new CommsError("DM access request was refused (denied)", "JOIN_REFUSED"),
    );

    await expect(
      h.messaging.sendDm(FROM_DEVICE_ID, TO_DEVICE_ID, "hi"),
    ).rejects.toMatchObject({ code: "JOIN_REFUSED" });

    expect(h.deps.dms.get(dmRoomPath(FROM_DEVICE_ID, TO_DEVICE_ID))).toBe(
      undefined,
    );
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
  });

  it("throws NOT_MEMBER naming the exact dm key when access was granted but no token was persisted", async () => {
    const h = makeHarness();
    h.agents.set(TO_DEVICE_ID, agent());
    vi.mocked(loadRoomTokens).mockReturnValue({});

    const key = dmRoomPath(FROM_DEVICE_ID, TO_DEVICE_ID);
    await expect(
      h.messaging.sendDm(FROM_DEVICE_ID, TO_DEVICE_ID, "hi"),
    ).rejects.toMatchObject({
      message: `No room:member token for ${key}`,
      code: "NOT_MEMBER",
    });
  });

  it("includes streaming-behavior in the wire params only when given, for a cross-agent DM", async () => {
    const h = makeHarness();
    h.agents.set(TO_DEVICE_ID, agent());
    vi.mocked(loadRoomTokens).mockReturnValue({
      [dmRoomPath(FROM_DEVICE_ID, TO_DEVICE_ID)]: FAKE_TOKEN,
    });

    await h.messaging.sendDm(FROM_DEVICE_ID, TO_DEVICE_ID, "hi", "info");

    const params = h.sendRoomRequestToMember.mock.calls[0]?.[3] as Record<
      string,
      unknown
    >;
    expect(params["streaming-behavior"]).toBe("info");
  });

  it("omits streaming-behavior from the wire params when not given, for a cross-agent DM", async () => {
    const h = makeHarness();
    h.agents.set(TO_DEVICE_ID, agent());
    vi.mocked(loadRoomTokens).mockReturnValue({
      [dmRoomPath(FROM_DEVICE_ID, TO_DEVICE_ID)]: FAKE_TOKEN,
    });

    await h.messaging.sendDm(FROM_DEVICE_ID, TO_DEVICE_ID, "hi");

    const params = h.sendRoomRequestToMember.mock.calls[0]?.[3] as Record<
      string,
      unknown
    >;
    expect(params).not.toHaveProperty("streaming-behavior");
  });
});

describe("RoomMessaging — reporting what became of a send", () => {
  /** Makes the DM path's own token already present, so sendDm goes straight to the wire rather than running the consent flow first. */
  function withDmToken(h: ReturnType<typeof makeHarness>): void {
    h.resolveAgent.mockResolvedValue(agent({ visibility: "visible" }));
    vi.mocked(loadRoomTokens).mockReturnValue({
      [dmRoomPath(FROM_DEVICE_ID, TO_DEVICE_ID)]: FAKE_TOKEN,
    });
  }

  it("reports a delivered DM as delivered", async () => {
    const h = makeHarness();
    withDmToken(h);
    h.sendRoomRequestToMember.mockResolvedValue({ kind: "delivered" });

    const sent = await h.messaging.sendDm(FROM_DEVICE_ID, TO_DEVICE_ID, "hi");

    expect(sent.delivery).toEqual({ status: "delivered" });
  });

  it("reports a DM nobody answered as queued, naming why", async () => {
    const h = makeHarness();
    withDmToken(h);
    h.sendRoomRequestToMember.mockResolvedValue({
      kind: "undelivered",
      reason: "timeout",
    });

    const sent = await h.messaging.sendDm(FROM_DEVICE_ID, TO_DEVICE_ID, "hi");

    expect(sent.delivery).toEqual({ status: "queued", reason: "timeout" });
  });

  it("raises SEND_REFUSED when the recipient refuses a DM, naming its own code", async () => {
    const h = makeHarness();
    withDmToken(h);
    h.sendRoomRequestToMember.mockResolvedValue({
      kind: "refused",
      code: "unauthorized",
    });

    await expect(
      h.messaging.sendDm(FROM_DEVICE_ID, TO_DEVICE_ID, "hi"),
    ).rejects.toMatchObject({
      message: `DM to ${TO_DEVICE_ID} refused (unauthorized)`,
      code: "SEND_REFUSED",
    });
  });

  it("includes the refuser's own message in a refusal, when it sent one", async () => {
    const h = makeHarness();
    withDmToken(h);
    h.sendRoomRequestToMember.mockResolvedValue({
      kind: "refused",
      code: "denied",
      message: "not right now",
    });

    await expect(
      h.messaging.sendDm(FROM_DEVICE_ID, TO_DEVICE_ID, "hi"),
    ).rejects.toMatchObject({
      message: `DM to ${TO_DEVICE_ID} refused (denied: not right now)`,
    });
  });

  it("reports a self-DM as delivered without touching the wire", async () => {
    const h = makeHarness();

    const sent = await h.messaging.sendDm(
      FROM_DEVICE_ID,
      FROM_DEVICE_ID,
      "note to self",
    );

    expect(sent.delivery).toEqual({ status: "delivered" });
    expect(h.sendRoomRequestToMember).not.toHaveBeenCalled();
  });

  it("reports a room send's outcome per member, including a refusal", async () => {
    const h = makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ members: [FROM_DEVICE_ID, TO_DEVICE_ID, OTHER_DEVICE_ID] }),
    );
    h.sendRoomRequestToMember
      .mockResolvedValueOnce({ kind: "undelivered", reason: "not_connected" })
      .mockResolvedValueOnce({ kind: "refused", code: "unauthorized" });

    const sent = await h.messaging.sendRoomMessage(
      "room-1",
      FROM_DEVICE_ID,
      "hi",
    );

    expect(sent.deliveries).toEqual([
      {
        member: TO_DEVICE_ID,
        delivery: { status: "queued", reason: "not_connected" },
      },
      {
        member: OTHER_DEVICE_ID,
        delivery: { status: "refused", code: "unauthorized" },
      },
    ]);
  });

  it("keeps sending to the rest of a room after one member refuses", async () => {
    const h = makeHarness();
    h.deps.rooms.set(
      "room-1",
      room({ members: [FROM_DEVICE_ID, TO_DEVICE_ID, OTHER_DEVICE_ID] }),
    );
    h.sendRoomRequestToMember
      .mockResolvedValueOnce({ kind: "refused", code: "unauthorized" })
      .mockResolvedValueOnce({ kind: "delivered" });

    const sent = await h.messaging.sendRoomMessage(
      "room-1",
      FROM_DEVICE_ID,
      "hi",
    );

    expect(h.sendRoomRequestToMember).toHaveBeenCalledTimes(2);
    expect(sent.deliveries[1]).toEqual({
      member: OTHER_DEVICE_ID,
      delivery: { status: "delivered" },
    });
  });
});
