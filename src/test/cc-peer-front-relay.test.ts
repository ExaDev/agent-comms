/**
 * Direct, DI-based unit tests for buildFrontedSessionRecord/detachFrontedSession -- the pure relay wiring front-relay.ts exposes, tested against fake store/tool/peer objects rather than a real MeshStore or local Claude Code session, mirroring cc-peer-bridge.test.ts's own approach for the one-shot bridge command.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildFrontedSessionRecord,
  detachFrontedSession,
} from "../bridges/cc-peer/front-relay.js";
import type {
  FrontRelayPeer,
  FrontRelayStore,
} from "../bridges/cc-peer/front-relay.js";
import type { CcPeerRosterEntryLike } from "../bridges/cc-peer/front.js";
import type { CommsTool } from "../core/tool.js";
import type { DeliveryEvent, RoomMessage } from "../core/types.js";

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

describe("buildFrontedSessionRecord — outbound (mesh -> cc-peer)", () => {
  it("wires store.onDelivery to send the formatted event to the session's own pid", () => {
    const store = fakeStore();
    const peer = fakePeer();
    const entry = rosterEntry({ pid: 333 });

    buildFrontedSessionRecord({
      entry,
      agentId: "agent-1",
      roomId: "owner/project",
      store,
      tool: fakeTool(),
      peer,
    });

    expect(store.onDelivery).toBeDefined();
    const event: DeliveryEvent = {
      type: "room_message",
      message: roomMessage(),
    };
    void store.onDelivery?.("agent-1", event);

    expect(peer.sendCalls).toHaveLength(1);
    expect(peer.sendCalls[0]?.target).toEqual({ pid: 333 });
  });
});

describe("buildFrontedSessionRecord — inbound (cc-peer -> mesh)", () => {
  it("returns a record whose handleInbound posts into the session's own project room", () => {
    const tool = fakeTool();
    const entry = rosterEntry({ cwd: "/tmp/my-project" });

    const record = buildFrontedSessionRecord({
      entry,
      agentId: "agent-1",
      roomId: "owner/my-project",
      store: fakeStore(),
      tool,
      peer: fakePeer(),
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
      agentId: "agent-1",
      roomId: "owner/project",
      store: fakeStore(),
      tool,
      peer: fakePeer(),
    });

    record.handleInbound({ from: "local-session", body: "hi" });

    const call = tool.handleCalls[0] as { action: { content: string } };
    expect(call.action.content).toBe("local-session: hi");
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
      agentId: "agent-1",
      roomId: "owner/other",
      store: fakeStore(),
      tool: fakeTool(),
      peer: fakePeer(),
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
