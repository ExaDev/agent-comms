/**
 * Direct, DI-based unit tests for wireCcPeerBridge -- the pure relay wiring cc-peer's own bridge.ts exposes, tested against a fake CcPeer/tool/store rather than a real local Claude Code session (no such session exists in a test environment; run.ts's own real CcPeer.create() construction is exercised only by actually running the bridge).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createTargetSenderMatcher,
  targetMatchesEntry,
  wireCcPeerBridge,
} from "../bridges/cc-peer/bridge.js";
import type {
  CcPeerBridgeStore,
  CcPeerInboundMessage,
  CcPeerLike,
} from "../bridges/cc-peer/bridge.js";
import type { CommsTool } from "../core/tool.js";
import type { DeliveryEvent, RoomMessage } from "../core/types.js";

function fakePeer(): CcPeerLike & {
  messageListener: ((m: Readonly<CcPeerInboundMessage>) => void) | undefined;
  sendCalls: { target: unknown; body: string }[];
} {
  const peer = {
    messageListener: undefined as
      ((m: Readonly<CcPeerInboundMessage>) => void) | undefined,
    sendCalls: [] as { target: unknown; body: string }[],
    on: (
      event: "message",
      listener: (m: Readonly<CcPeerInboundMessage>) => void,
    ): void => {
      if (event === "message") peer.messageListener = listener;
    },
    send: vi.fn(async (target: unknown, body: string) => {
      peer.sendCalls.push({ target, body });
      return Promise.resolve({ msgId: "msg-1" });
    }),
  };
  return peer;
}

function fakeTool(): Pick<CommsTool, "handle"> & {
  handleCalls: unknown[];
} {
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

describe("wireCcPeerBridge — inbound (cc-peer -> mesh)", () => {
  it("posts an inbound cc-peer message into this agent's own project room, prefixed with the sender's name", async () => {
    const peer = fakePeer();
    const tool = fakeTool();
    const store: CcPeerBridgeStore = {
      onDelivery: undefined,
      onError: undefined,
    };

    wireCcPeerBridge({
      store,
      tool,
      peer,
      agentId: "agent-1",
      roomId: "owner/project",
      target: { name: "local-session" },
      cwd: "/tmp/project",
      isFromTarget: async () => Promise.resolve(true),
    });

    peer.messageListener?.({
      from: "local-session",
      fromName: "my-local-session",
      body: "hello from cc-peer",
    });

    await vi.waitFor(() => {
      expect(tool.handleCalls).toHaveLength(1);
    });
    expect(tool.handleCalls[0]).toEqual({
      ctx: {
        agentId: "agent-1",
        harness: "cc-peer",
        cwd: "/tmp/project",
        pid: process.pid,
      },
      action: {
        action: "send",
        target: "owner/project",
        content: "my-local-session: hello from cc-peer",
      },
    });
  });

  it("falls back to the raw from id when the local peer has no registered display name", async () => {
    const peer = fakePeer();
    const tool = fakeTool();
    const store: CcPeerBridgeStore = {
      onDelivery: undefined,
      onError: undefined,
    };

    wireCcPeerBridge({
      store,
      tool,
      peer,
      agentId: "agent-1",
      roomId: "owner/project",
      target: { name: "local-session" },
      cwd: "/tmp/project",
      isFromTarget: async () => Promise.resolve(true),
    });

    peer.messageListener?.({ from: "local-session", body: "hi" });

    await vi.waitFor(() => {
      expect(tool.handleCalls).toHaveLength(1);
    });
    const call = tool.handleCalls[0] as { action: { content: string } };
    expect(call.action.content).toBe("local-session: hi");
  });
});

describe("wireCcPeerBridge — outbound (mesh -> cc-peer)", () => {
  it("relays a mesh delivery to the configured cc-peer target", () => {
    const peer = fakePeer();
    const tool = fakeTool();
    const store: CcPeerBridgeStore = {
      onDelivery: undefined,
      onError: undefined,
    };

    wireCcPeerBridge({
      store,
      tool,
      peer,
      agentId: "agent-1",
      roomId: "owner/project",
      target: { name: "local-session" },
      cwd: "/tmp/project",
      isFromTarget: async () => Promise.resolve(true),
    });

    expect(store.onDelivery).toBeDefined();
    const event: DeliveryEvent = {
      type: "room_message",
      message: roomMessage(),
    };
    void store.onDelivery?.("agent-1", event);

    expect(peer.sendCalls).toEqual([
      {
        target: { name: "local-session" },
        body: "[owner/project] peer-a: hi from the mesh",
      },
    ]);
  });

  it("relays to a pid-addressed target exactly as configured", () => {
    const peer = fakePeer();
    const tool = fakeTool();
    const store: CcPeerBridgeStore = {
      onDelivery: undefined,
      onError: undefined,
    };

    wireCcPeerBridge({
      store,
      tool,
      peer,
      agentId: "agent-1",
      roomId: "owner/project",
      target: { pid: 4242 },
      cwd: "/tmp/project",
      isFromTarget: async () => Promise.resolve(true),
    });

    void store.onDelivery?.("agent-1", {
      type: "room_message",
      message: roomMessage(),
    });

    expect(peer.sendCalls[0]?.target).toEqual({ pid: 4242 });
  });
});

describe("wireCcPeerBridge — inbound from anyone but the target", () => {
  it("ignores a message whose sender is not the target", async () => {
    const peer = fakePeer();
    const tool = fakeTool();
    const isFromTarget = vi.fn(async () => Promise.resolve(false));

    wireCcPeerBridge({
      store: { onDelivery: undefined, onError: undefined },
      tool,
      peer,
      agentId: "agent-1",
      roomId: "owner/project",
      target: { name: "local-session" },
      cwd: "/tmp/project",
      isFromTarget,
    });

    peer.messageListener?.({ from: "uds:/tmp/other.sock", body: "not for us" });

    await vi.waitFor(() => {
      expect(isFromTarget).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(tool.handleCalls).toEqual([]);
  });
});

describe("wireCcPeerBridge — relay failures", () => {
  it("reports a failed target check through the store's error channel instead of leaving an unhandled rejection", async () => {
    const peer = fakePeer();
    const onError = vi.fn<(error: Error) => void>();

    wireCcPeerBridge({
      store: { onDelivery: undefined, onError },
      tool: fakeTool(),
      peer,
      agentId: "agent-1",
      roomId: "owner/project",
      target: { name: "local-session" },
      cwd: "/tmp/project",
      isFromTarget: async () => Promise.reject(new Error("roster unreadable")),
    });

    peer.messageListener?.({ from: "uds:/tmp/x.sock", body: "x" });

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(new Error("roster unreadable"));
    });
  });
});

const ENTRY = {
  pid: 4242,
  name: "local-session",
  messagingSocketPath: "/tmp/cc-socks/4242.sock",
};

describe("targetMatchesEntry", () => {
  it("matches a pid target by pid", () => {
    expect(targetMatchesEntry({ pid: 4242 }, ENTRY)).toBe(true);
    expect(targetMatchesEntry({ pid: 1 }, ENTRY)).toBe(false);
  });

  it("matches a name target by the session's registered name", () => {
    expect(targetMatchesEntry({ name: "local-session" }, ENTRY)).toBe(true);
    expect(targetMatchesEntry({ name: "someone-else" }, ENTRY)).toBe(false);
    expect(
      targetMatchesEntry(
        { name: "local-session" },
        { ...ENTRY, name: undefined },
      ),
    ).toBe(false);
  });

  it("matches an address target against the session's own uds address", () => {
    expect(
      targetMatchesEntry(
        { address: `uds:${ENTRY.messagingSocketPath}` },
        ENTRY,
      ),
    ).toBe(true);
    expect(targetMatchesEntry({ address: "uds:/tmp/other.sock" }, ENTRY)).toBe(
      false,
    );
  });
});

describe("createTargetSenderMatcher", () => {
  const roster = async () => Promise.resolve([ENTRY]);

  it("accepts a message sent from the target session's socket", async () => {
    const matches = createTargetSenderMatcher(
      { name: "local-session" },
      roster,
    );
    expect(
      await matches({ from: `uds:${ENTRY.messagingSocketPath}`, body: "x" }),
    ).toBe(true);
  });

  it("rejects a message from a different session, and one with no sender at all", async () => {
    const matches = createTargetSenderMatcher(
      { name: "local-session" },
      roster,
    );
    expect(await matches({ from: "uds:/tmp/cc-socks/9.sock", body: "x" })).toBe(
      false,
    );
    expect(await matches({ body: "x" })).toBe(false);
  });

  it("re-reads the roster for every message, so a session that restarts under the same name is still recognised", async () => {
    const listRoster = vi
      .fn<() => Promise<(typeof ENTRY)[]>>()
      .mockResolvedValueOnce([ENTRY])
      .mockResolvedValueOnce([
        { ...ENTRY, pid: 5555, messagingSocketPath: "/tmp/cc-socks/5555.sock" },
      ]);
    const matches = createTargetSenderMatcher(
      { name: "local-session" },
      listRoster,
    );

    expect(
      await matches({ from: "uds:/tmp/cc-socks/4242.sock", body: "a" }),
    ).toBe(true);
    expect(
      await matches({ from: "uds:/tmp/cc-socks/5555.sock", body: "b" }),
    ).toBe(true);
  });

  it("matches an address target on the message's from alone, without reading the roster", async () => {
    const listRoster = vi.fn(async () => Promise.resolve([ENTRY]));
    const matches = createTargetSenderMatcher(
      { address: "uds:/tmp/x.sock" },
      listRoster,
    );

    expect(await matches({ from: "uds:/tmp/x.sock", body: "x" })).toBe(true);
    expect(listRoster).not.toHaveBeenCalled();
  });
});
