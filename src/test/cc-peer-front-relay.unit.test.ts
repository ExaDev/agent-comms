/**
 * Direct, DI-based unit tests for buildFrontedSessionRecord/detachFrontedSession -- the pure relay wiring front-relay.ts exposes, tested against fake store/tool/peer objects rather than a real MeshStore or local Claude Code session, mirroring cc-peer-bridge.test.ts's own approach for the one-shot bridge command.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildFrontedSessionRecord,
  detachFrontedSession,
} from "../bridges/cc-peer/front-relay.js";
import type {
  FrontRelayAliasDirectory,
  FrontRelayAliasPool,
  FrontRelayPeer,
  FrontRelayStore,
} from "../bridges/cc-peer/front-relay.js";
import type { CcPeerRosterEntryLike } from "../bridges/cc-peer/front.js";
import type { ReplyContext } from "../bridges/cc-peer/reply-aliases.js";
import type { CommsTool } from "../core/tool.js";
import type { DeliveryEvent, DmMessage, RoomMessage } from "../core/types.js";

/** The peer name the front is registered under; sessions are told to message it to answer a join request. */
const PEER_NAME = "agent-comms-front";
/** A device-id is a 64-character lowercase hex digest. */
const DEVICE_ID_HEX_LENGTH = 64;
const REQUESTER_ID = "a".repeat(DEVICE_ID_HEX_LENGTH);
const DM_ROOM = `${"b".repeat(DEVICE_ID_HEX_LENGTH)}+${REQUESTER_ID}`;

function rosterEntry(
  overrides: Readonly<Partial<CcPeerRosterEntryLike>> = {},
): CcPeerRosterEntryLike {
  return {
    pid: 222,
    cwd: "/tmp/project",
    version: "2.1.269",
    messagingSocketPath: "/tmp/sock-222",
    ...overrides,
  };
}

function fakeStore(): FrontRelayStore & {
  setAgentOfflineCalls: string[];
  shutdownCalls: number;
} {
  const setAgentOfflineCalls: string[] = [];
  let shutdownCalls = 0;
  return {
    onDelivery: undefined,
    setAgentOfflineCalls,
    get shutdownCalls() {
      return shutdownCalls;
    },
    setAgentOffline: vi.fn(async (id: string) => {
      setAgentOfflineCalls.push(id);
      return Promise.resolve();
    }),
    shutdown: vi.fn(async () => {
      shutdownCalls += 1;
      return Promise.resolve();
    }),
  };
}

function fakePeer(): FrontRelayPeer & {
  sendCalls: { target: unknown; body: string }[];
} {
  const sendCalls: { target: unknown; body: string }[] = [];
  return {
    sendCalls,
    send: vi.fn(async (target: unknown, body: string) => {
      sendCalls.push({ target, body });
      return Promise.resolve({ msgId: "msg-1" });
    }),
  };
}

function fakeTool(): Pick<CommsTool, "handle"> & { handleCalls: unknown[] } {
  const handleCalls: unknown[] = [];
  return {
    handleCalls,
    handle: vi.fn(async (ctx: unknown, action: unknown) => {
      handleCalls.push({ ctx, action });
      return Promise.resolve({ content: "ok", isError: false });
    }),
  };
}

function roomMessage(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: "msg-1",
    from: "peer-a",
    room: "owner/project",
    content: "hi from the mesh",
    timestamp: "2026-01-01T00:00:00.000Z",
    readBy: [],
    ...overrides,
  };
}

function dmMessage(overrides: Partial<DmMessage> = {}): DmMessage {
  return {
    id: "msg-1",
    from: "peer-a",
    to: "agent-1",
    content: "hi from the mesh",
    timestamp: "2026-01-01T00:00:00.000Z",
    readBy: [],
    ...overrides,
  };
}

function fakeAliasPool(): FrontRelayAliasPool & {
  sendCalls: { alias: string; target: unknown; body: string }[];
} {
  const sendCalls: { alias: string; target: unknown; body: string }[] = [];
  return {
    sendCalls,
    send: vi.fn(async (alias: string, target: unknown, body: string) => {
      sendCalls.push({ alias, target, body });
      return Promise.resolve({ msgId: "alias-msg-1" });
    }),
  };
}

/** A tool whose every call is refused, for the paths that must report a refusal back into the session rather than discard it. */
function refusingTool(
  content: string,
): Pick<CommsTool, "handle"> & { handleCalls: unknown[] } {
  const handleCalls: unknown[] = [];
  return {
    handleCalls,
    handle: vi.fn(async (ctx: unknown, action: unknown) => {
      handleCalls.push({ ctx, action });
      return Promise.resolve({ content, isError: true });
    }),
  };
}

function fakeAliasDirectory(
  nameFor: (correspondentId: string, context: ReplyContext) => string = (id) =>
    `mesh-${id}`,
): FrontRelayAliasDirectory {
  return {
    ensure: vi.fn(nameFor),
  };
}

describe("buildFrontedSessionRecord — outbound (mesh -> cc-peer)", () => {
  it("wires store.onDelivery to send the event to the session's own pid", async () => {
    const store = fakeStore();
    const aliasPool = fakeAliasPool();
    const entry = rosterEntry({ pid: 333 });

    buildFrontedSessionRecord({
      entry,
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store,
      tool: fakeTool(),
      peer: fakePeer(),
      aliasPool,
      aliasDirectory: fakeAliasDirectory(),
    });

    expect(store.onDelivery).toBeDefined();
    const event: DeliveryEvent = {
      type: "room_message",
      message: roomMessage(),
    };
    await store.onDelivery?.("agent-1", event);

    expect(aliasPool.sendCalls).toHaveLength(1);
    expect(aliasPool.sendCalls[0]?.target).toEqual({ pid: 333 });
  });

  it("sends a DM from the correspondent's own alias, not from the front's shared peer", async () => {
    const store = fakeStore();
    const peer = fakePeer();
    const aliasPool = fakeAliasPool();
    const aliasDirectory = fakeAliasDirectory((id) => `mesh-${id}`);

    buildFrontedSessionRecord({
      entry: rosterEntry(),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store,
      tool: fakeTool(),
      peer,
      aliasPool,
      aliasDirectory,
    });

    const event: DeliveryEvent = {
      type: "dm",
      message: dmMessage({ from: "correspondent-1" }),
    };
    await store.onDelivery?.("agent-1", event);

    expect(aliasDirectory.ensure).toHaveBeenCalledWith("correspondent-1", {
      kind: "dm",
    });
    expect(aliasPool.sendCalls).toEqual([
      {
        alias: "mesh-correspondent-1",
        target: { pid: 222 },
        body: expect.stringContaining("hi from the mesh"),
      },
    ]);
    expect(peer.sendCalls).toEqual([]);
  });

  it("sends a room message from the correspondent's own alias, recording a room reply context naming the room it came from", async () => {
    const store = fakeStore();
    const peer = fakePeer();
    const aliasPool = fakeAliasPool();
    const aliasDirectory = fakeAliasDirectory((id) => `mesh-${id}`);

    buildFrontedSessionRecord({
      entry: rosterEntry(),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store,
      tool: fakeTool(),
      peer,
      aliasPool,
      aliasDirectory,
    });

    const event: DeliveryEvent = {
      type: "room_message",
      message: roomMessage({ from: "correspondent-1", room: "owner/project" }),
    };
    await store.onDelivery?.("agent-1", event);

    expect(aliasDirectory.ensure).toHaveBeenCalledWith("correspondent-1", {
      kind: "room",
      room: "owner/project",
    });
    expect(aliasPool.sendCalls).toEqual([
      {
        alias: "mesh-correspondent-1",
        target: { pid: 222 },
        body: expect.stringContaining("hi from the mesh"),
      },
    ]);
    expect(peer.sendCalls).toEqual([]);
  });

  it("leaves the delivered body free of a reply hint, since the sender is now the reply target", async () => {
    const store = fakeStore();
    const aliasPool = fakeAliasPool();

    buildFrontedSessionRecord({
      entry: rosterEntry(),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store,
      tool: fakeTool(),
      peer: fakePeer(),
      aliasPool,
      aliasDirectory: fakeAliasDirectory(),
    });

    await store.onDelivery?.("agent-1", {
      type: "dm",
      message: dmMessage({ from: "correspondent-1" }),
    });

    expect(aliasPool.sendCalls[0]?.body).not.toContain("reply via peer");
  });

  it("delivers an event with no single correspondent (e.g. member_joined) without touching the alias pool", async () => {
    const store = fakeStore();
    const peer = fakePeer();
    const aliasPool = fakeAliasPool();

    buildFrontedSessionRecord({
      entry: rosterEntry(),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store,
      tool: fakeTool(),
      peer,
      aliasPool,
      aliasDirectory: fakeAliasDirectory(),
    });

    const event: DeliveryEvent = {
      type: "member_joined",
      room: "owner/project",
      agent: "agent-2",
    };
    await store.onDelivery?.("agent-1", event);

    expect(aliasPool.sendCalls).toEqual([]);
    expect(peer.sendCalls).toHaveLength(1);
  });

  it("reports the failure and warns the session when the alias cannot deliver", async () => {
    const store = fakeStore();
    const peer = fakePeer();
    const onError = vi.fn<(error: Error) => void>();
    const failure = new Error("alias worker failed to start");
    const aliasPool: FrontRelayAliasPool = {
      send: vi.fn(async () => Promise.reject(failure)),
    };

    buildFrontedSessionRecord({
      entry: rosterEntry(),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store,
      tool: fakeTool(),
      peer,
      aliasPool,
      aliasDirectory: fakeAliasDirectory(),
      onError,
    });

    const event: DeliveryEvent = {
      type: "dm",
      message: dmMessage({ from: "correspondent-1" }),
    };
    await store.onDelivery?.("agent-1", event);

    expect(onError).toHaveBeenCalledWith(failure);
    expect(peer.sendCalls).toHaveLength(1);
    const body = peer.sendCalls[0]?.body ?? "";
    expect(body).toContain("hi from the mesh");
    expect(body).toContain("Cannot reply");
    expect(body).toContain("correspondent-1");
  });

  it("still delivers the content when the alias fails and no error channel is wired", async () => {
    const store = fakeStore();
    const peer = fakePeer();
    const aliasPool: FrontRelayAliasPool = {
      send: vi.fn(async () => Promise.reject(new Error("no alias"))),
    };

    buildFrontedSessionRecord({
      entry: rosterEntry(),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store,
      tool: fakeTool(),
      peer,
      aliasPool,
      aliasDirectory: fakeAliasDirectory(),
    });

    await store.onDelivery?.("agent-1", {
      type: "dm",
      message: dmMessage({ from: "correspondent-1" }),
    });

    expect(peer.sendCalls).toHaveLength(1);
  });
});

describe("buildFrontedSessionRecord — alias reply, dm context (cc-peer -> mesh DM)", () => {
  it("sends a mesh DM to the correspondent, as this session's own agent id, when a reply arrives on its alias with a dm context", () => {
    const tool = fakeTool();
    const record = buildFrontedSessionRecord({
      entry: rosterEntry({ cwd: "/tmp/my-project" }),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/my-project",
      store: fakeStore(),
      tool,
      peer: fakePeer(),
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    record.handleAliasReply(
      "correspondent-1",
      { kind: "dm" },
      {
        from: "local-session",
        fromName: "my-local-session",
        body: "reply body",
      },
    );

    expect(tool.handleCalls).toHaveLength(1);
    expect(tool.handleCalls[0]).toEqual({
      ctx: {
        agentId: "agent-1",
        harness: "claude-code",
        cwd: "/tmp/my-project",
        pid: process.pid,
      },
      action: {
        action: "dm",
        target: "correspondent-1",
        content: "reply body",
      },
    });
  });

  it("tells the session when the mesh refuses the dm reply, rather than discarding the result", async () => {
    const peer = fakePeer();
    const record = buildFrontedSessionRecord({
      entry: rosterEntry({ pid: 555 }),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store: fakeStore(),
      tool: refusingTool("No DM grant for correspondent-1."),
      peer,
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    record.handleAliasReply(
      "correspondent-1",
      { kind: "dm" },
      { body: "reply body" },
    );

    await vi.waitFor(() => {
      expect(peer.sendCalls).toHaveLength(1);
    });
    expect(peer.sendCalls[0]?.target).toEqual({ pid: 555 });
    expect(peer.sendCalls[0]?.body).toBe(
      "Reply to correspondent-1 not delivered: No DM grant for correspondent-1.",
    );
  });

  it("stays quiet when the dm reply is delivered", async () => {
    const peer = fakePeer();
    const tool = fakeTool();
    const record = buildFrontedSessionRecord({
      entry: rosterEntry(),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store: fakeStore(),
      tool,
      peer,
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    record.handleAliasReply(
      "correspondent-1",
      { kind: "dm" },
      { body: "reply body" },
    );

    await vi.waitFor(() => {
      expect(tool.handleCalls).toHaveLength(1);
    });
    expect(peer.sendCalls).toEqual([]);
  });
});

describe("buildFrontedSessionRecord — alias reply, room context (cc-peer -> mesh room post) (agent-comms#289)", () => {
  it("posts back into the room the aliased message came from, as this session's own agent id, rather than DMing the sender", () => {
    const tool = fakeTool();
    const record = buildFrontedSessionRecord({
      entry: rosterEntry({ cwd: "/tmp/my-project" }),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/my-project",
      store: fakeStore(),
      tool,
      peer: fakePeer(),
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    record.handleAliasReply(
      "correspondent-1",
      { kind: "room", room: "owner/some-room" },
      {
        from: "local-session",
        fromName: "my-local-session",
        body: "reply body",
      },
    );

    expect(tool.handleCalls).toHaveLength(1);
    expect(tool.handleCalls[0]).toEqual({
      ctx: {
        agentId: "agent-1",
        harness: "claude-code",
        cwd: "/tmp/my-project",
        pid: process.pid,
      },
      action: {
        action: "send",
        target: "owner/some-room",
        content: "reply body",
      },
    });
  });

  it("posts back into the room even when it differs from the session's own default project room", () => {
    const tool = fakeTool();
    const record = buildFrontedSessionRecord({
      entry: rosterEntry({ cwd: "/tmp/my-project" }),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/my-project",
      store: fakeStore(),
      tool,
      peer: fakePeer(),
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    record.handleAliasReply(
      "correspondent-1",
      { kind: "room", room: "owner/a-different-room" },
      { body: "reply body" },
    );

    const call = tool.handleCalls[0] as { action: { target: string } };
    expect(call.action.target).toBe("owner/a-different-room");
  });

  it("tells the session when the mesh refuses the room reply, naming the room rather than the sender", async () => {
    const peer = fakePeer();
    const record = buildFrontedSessionRecord({
      entry: rosterEntry({ pid: 555 }),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store: fakeStore(),
      tool: refusingTool("Not a member of owner/some-room."),
      peer,
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    record.handleAliasReply(
      "correspondent-1",
      { kind: "room", room: "owner/some-room" },
      { body: "reply body" },
    );

    await vi.waitFor(() => {
      expect(peer.sendCalls).toHaveLength(1);
    });
    expect(peer.sendCalls[0]?.target).toEqual({ pid: 555 });
    expect(peer.sendCalls[0]?.body).toBe(
      "Reply to owner/some-room not delivered: Not a member of owner/some-room.",
    );
  });

  it("stays quiet when the room reply is delivered", async () => {
    const peer = fakePeer();
    const tool = fakeTool();
    const record = buildFrontedSessionRecord({
      entry: rosterEntry(),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store: fakeStore(),
      tool,
      peer,
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    record.handleAliasReply(
      "correspondent-1",
      { kind: "room", room: "owner/some-room" },
      { body: "reply body" },
    );

    await vi.waitFor(() => {
      expect(tool.handleCalls).toHaveLength(1);
    });
    expect(peer.sendCalls).toEqual([]);
  });
});

describe("buildFrontedSessionRecord — stale alias notification", () => {
  it("sends a clear error back to the session's own pid rather than silently dropping the reply", () => {
    const peer = fakePeer();
    const record = buildFrontedSessionRecord({
      entry: rosterEntry({ pid: 555 }),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store: fakeStore(),
      tool: fakeTool(),
      peer,
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    record.notifyStaleAlias("mesh-stale");

    expect(peer.sendCalls).toHaveLength(1);
    expect(peer.sendCalls[0]?.target).toEqual({ pid: 555 });
    expect(peer.sendCalls[0]?.body).toContain("mesh-stale");
  });
});

describe("buildFrontedSessionRecord — inbound (cc-peer -> mesh)", () => {
  it("returns a record whose handleInbound posts into the session's own project room", () => {
    const tool = fakeTool();
    const entry = rosterEntry({ cwd: "/tmp/my-project" });

    const record = buildFrontedSessionRecord({
      entry,
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/my-project",
      store: fakeStore(),
      tool,
      peer: fakePeer(),
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    record.handleInbound({
      from: "local-session",
      fromName: "my-local-session",
      body: "hello from cc-peer",
    });

    expect(tool.handleCalls).toHaveLength(1);
    expect(tool.handleCalls[0]).toEqual({
      ctx: {
        agentId: "agent-1",
        harness: "claude-code",
        cwd: "/tmp/my-project",
        pid: process.pid,
      },
      action: {
        action: "send",
        target: "owner/my-project",
        content: "my-local-session: hello from cc-peer",
      },
    });
  });

  it("falls back to the raw from id when the session has no registered display name", () => {
    const tool = fakeTool();
    const record = buildFrontedSessionRecord({
      entry: rosterEntry(),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store: fakeStore(),
      tool,
      peer: fakePeer(),
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    record.handleInbound({ from: "local-session", body: "hi" });

    const call = tool.handleCalls[0] as { action: { content: string } };
    expect(call.action.content).toBe("local-session: hi");
  });

  it("tells the session when the project-room post is refused, rather than discarding the result", async () => {
    const peer = fakePeer();
    const record = buildFrontedSessionRecord({
      entry: rosterEntry({ pid: 777 }),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/project",
      store: fakeStore(),
      tool: refusingTool("Not a member of owner/project."),
      peer,
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    record.handleInbound({ from: "local-session", body: "hi" });

    await vi.waitFor(() => {
      expect(peer.sendCalls).toHaveLength(1);
    });
    expect(peer.sendCalls[0]?.target).toEqual({ pid: 777 });
    expect(peer.sendCalls[0]?.body).toBe(
      "Not posted to owner/project: Not a member of owner/project.",
    );
  });
});

describe("buildFrontedSessionRecord — record shape", () => {
  it("carries the roster entry's own pid/cwd/messagingSocketPath, matching what CcPeerFront diffs and routes on", () => {
    const entry = rosterEntry({
      pid: 444,
      cwd: "/tmp/other",
      messagingSocketPath: "/tmp/sock-444",
    });
    const record = buildFrontedSessionRecord({
      entry,
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/other",
      store: fakeStore(),
      tool: fakeTool(),
      peer: fakePeer(),
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });

    expect(record.pid).toBe(entry.pid);
    expect(record.cwd).toBe(entry.cwd);
    expect(record.messagingSocketPath).toBe(entry.messagingSocketPath);
  });
});

describe("detachFrontedSession", () => {
  it("marks the agent offline, then shuts its store down", async () => {
    const store = fakeStore();

    await detachFrontedSession({ agentId: "agent-1", store });

    expect(store.setAgentOfflineCalls).toEqual(["agent-1"]);
    expect(store.shutdownCalls).toBe(1);
  });

  it("shuts the store down only after setAgentOffline resolves, not concurrently with it", async () => {
    const store = fakeStore();
    const order: string[] = [];
    vi.mocked(store.setAgentOffline).mockImplementation(async () => {
      order.push("offline");
      return Promise.resolve();
    });
    vi.mocked(store.shutdown).mockImplementation(async () => {
      order.push("shutdown");
      return Promise.resolve();
    });

    await detachFrontedSession({ agentId: "agent-1", store });

    expect(order).toEqual(["offline", "shutdown"]);
  });
});

describe("buildFrontedSessionRecord — answering a join request", () => {
  const request: DeliveryEvent = {
    type: "room_join_request",
    room: DM_ROOM,
    requesterId: REQUESTER_ID,
  };

  function build(
    overrides: Readonly<{
      tool?: ReturnType<typeof fakeTool>;
      peer?: ReturnType<typeof fakePeer>;
    }> = {},
  ) {
    const store = fakeStore();
    const peer = overrides.peer ?? fakePeer();
    const tool = overrides.tool ?? fakeTool();
    const record = buildFrontedSessionRecord({
      entry: rosterEntry({ pid: 444, cwd: "/tmp/answering" }),
      peerName: PEER_NAME,
      agentId: "agent-1",
      roomId: "owner/answering",
      store,
      tool,
      peer,
      aliasPool: fakeAliasPool(),
      aliasDirectory: fakeAliasDirectory(),
    });
    return { store, peer, tool, record };
  }

  it("tells the session which peer to message and the exact commands when a join request is waiting", async () => {
    const { store, peer } = build();

    await store.onDelivery?.("agent-1", request);

    expect(peer.sendCalls).toHaveLength(1);
    const body = peer.sendCalls[0]?.body ?? "";
    expect(body).toContain(`"${PEER_NAME}"`);
    expect(body).toContain(`accept ${DM_ROOM} ${REQUESTER_ID}`);
  });

  it("runs room_accept as the session's own agent when the session messages an accept, and reports the result back to it", async () => {
    const { record, tool, peer } = build();

    record.handleInbound({
      from: "uds:/tmp/sock-444",
      body: `accept ${DM_ROOM} ${REQUESTER_ID}`,
    });

    await vi.waitFor(() => {
      expect(peer.sendCalls).toHaveLength(1);
    });
    expect(tool.handleCalls).toEqual([
      {
        ctx: {
          agentId: "agent-1",
          harness: "claude-code",
          cwd: "/tmp/answering",
          pid: process.pid,
        },
        action: {
          action: "room_accept",
          room: DM_ROOM,
          requesterId: REQUESTER_ID,
        },
      },
    ]);
    expect(peer.sendCalls[0]).toEqual({ target: { pid: 444 }, body: "ok" });
  });

  it("runs room_reject with the reason when the session messages a reject", async () => {
    const { record, tool, peer } = build();

    record.handleInbound({
      body: `reject ${DM_ROOM} ${REQUESTER_ID} not now`,
    });

    await vi.waitFor(() => {
      expect(peer.sendCalls).toHaveLength(1);
    });
    expect(tool.handleCalls).toEqual([
      expect.objectContaining({
        action: {
          action: "room_reject",
          room: DM_ROOM,
          requesterId: REQUESTER_ID,
          reason: "not now",
        },
      }),
    ]);
  });

  it("does not post a decision into the project room, and still posts an ordinary message there", async () => {
    const { record, tool, peer } = build();

    record.handleInbound({ body: `accept ${DM_ROOM} ${REQUESTER_ID}` });
    await vi.waitFor(() => {
      expect(peer.sendCalls).toHaveLength(1);
    });
    expect(
      tool.handleCalls.some(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "action" in call &&
          typeof call.action === "object" &&
          call.action !== null &&
          "action" in call.action &&
          call.action.action === "send",
      ),
    ).toBe(false);

    record.handleInbound({ from: "local", body: "just chatting" });
    await vi.waitFor(() => {
      expect(tool.handleCalls).toHaveLength(2);
    });
    expect(tool.handleCalls[1]).toEqual(
      expect.objectContaining({
        action: expect.objectContaining({ action: "send" }),
      }),
    );
  });
});
