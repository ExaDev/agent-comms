/**
 * Direct, DI-based unit tests for wireCcPeerBridge -- the pure relay wiring cc-peer's own bridge.ts exposes, tested against a fake CcPeer/tool/store rather than a real local Claude Code session (no such session exists in a test environment; run.ts's own real CcPeer.create() construction is exercised only by actually running the bridge).
 */
import { describe, expect, it, vi } from "vitest";
import { wireCcPeerBridge } from "../bridges/cc-peer/bridge.js";
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
  it("posts an inbound cc-peer message into this agent's own project room, prefixed with the sender's name", () => {
    const peer = fakePeer();
    const tool = fakeTool();
    const store: CcPeerBridgeStore = { onDelivery: undefined };

    wireCcPeerBridge({
      store,
      tool,
      peer,
      agentId: "agent-1",
      roomId: "owner/project",
      target: { name: "local-session" },
      cwd: "/tmp/project",
    });

    peer.messageListener?.({
      from: "local-session",
      fromName: "my-local-session",
      body: "hello from cc-peer",
    });

    expect(tool.handleCalls).toHaveLength(1);
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

  it("falls back to the raw from id when the local peer has no registered display name", () => {
    const peer = fakePeer();
    const tool = fakeTool();
    const store: CcPeerBridgeStore = { onDelivery: undefined };

    wireCcPeerBridge({
      store,
      tool,
      peer,
      agentId: "agent-1",
      roomId: "owner/project",
      target: { name: "local-session" },
      cwd: "/tmp/project",
    });

    peer.messageListener?.({ from: "local-session", body: "hi" });

    const call = tool.handleCalls[0] as { action: { content: string } };
    expect(call.action.content).toBe("local-session: hi");
  });
});

describe("wireCcPeerBridge — outbound (mesh -> cc-peer)", () => {
  it("relays a mesh delivery to the configured cc-peer target", () => {
    const peer = fakePeer();
    const tool = fakeTool();
    const store: CcPeerBridgeStore = { onDelivery: undefined };

    wireCcPeerBridge({
      store,
      tool,
      peer,
      agentId: "agent-1",
      roomId: "owner/project",
      target: { name: "local-session" },
      cwd: "/tmp/project",
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
    const store: CcPeerBridgeStore = { onDelivery: undefined };

    wireCcPeerBridge({
      store,
      tool,
      peer,
      agentId: "agent-1",
      roomId: "owner/project",
      target: { pid: 4242 },
      cwd: "/tmp/project",
    });

    void store.onDelivery?.("agent-1", {
      type: "room_message",
      message: roomMessage(),
    });

    expect(peer.sendCalls[0]?.target).toEqual({ pid: 4242 });
  });
});
