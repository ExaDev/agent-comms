/**
 * Direct, DI-based unit tests for ConnectionApproval -- it was previously exercised only indirectly through approval.integration.test.ts's end-to-end transport scenarios, which left several individual branches, error messages, and fallback string literals unobserved. ConnectionApprovalDeps is a narrow, injectable surface built exactly for this: a fake deps object with vi.fn() collaborators lets every branch be asserted on directly.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ConnectionApproval,
  type ConnectionApprovalDeps,
} from "../core/connection-approval.js";
import type { AgentIdentity } from "../core/types.js";

const OWNER_ID = "owner-device";
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const REMOTE_HOST = "example.test";
const REMOTE_PORT = 4242;
const LOCAL_DATA_PORT = 5150;

function agent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: OWNER_ID,
    version: 1,
    name: "agent-name",
    harness: "pi",
    cwd: "/tmp",
    pid: 111,
    startedAt: STARTED_AT,
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
    ...overrides,
  };
}

interface Harness {
  deps: ConnectionApprovalDeps;
  approval: ConnectionApproval;
  transport: {
    acceptConnection: ReturnType<typeof vi.fn>;
    rejectConnection: ReturnType<typeof vi.fn>;
    connectToRemote: ReturnType<typeof vi.fn>;
    startDataServer: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    dataPort: number;
  };
  queueDelivery: ReturnType<typeof vi.fn>;
  onDelivery: ReturnType<typeof vi.fn> | undefined;
}

function makeHarness(
  options: Readonly<{ withOnDelivery?: boolean }> = {},
): Harness {
  const transport = {
    acceptConnection: vi.fn().mockResolvedValue(undefined),
    rejectConnection: vi.fn().mockResolvedValue(undefined),
    connectToRemote: vi.fn().mockResolvedValue(undefined),
    startDataServer: vi.fn().mockResolvedValue(undefined),
    unref: vi.fn(),
    dataPort: LOCAL_DATA_PORT,
  };
  const queueDelivery = vi.fn<ConnectionApprovalDeps["queueDelivery"]>();
  const onDelivery = options.withOnDelivery === true ? vi.fn() : undefined;
  const deps: ConnectionApprovalDeps = {
    agents: new Map(),
    peerInfo: new Map(),
    startedAt: STARTED_AT,
    getPeerId: () => OWNER_ID,
    requireTransport: () => transport as never,
    getOnDelivery: () => onDelivery,
    queueDelivery,
  };
  return {
    deps,
    approval: new ConnectionApproval(deps),
    transport,
    queueDelivery,
    onDelivery,
  };
}

describe("ConnectionApproval — handleConnectionRequest", () => {
  it("queues a connection_request delivery event addressed to the owning peer", () => {
    const h = makeHarness();
    h.approval.handleConnectionRequest(
      { id: "conn-1" },
      {
        peerId: "remote-peer",
        dataPort: 9000,
        name: "remote-name",
        fingerprint: "fp",
      },
    );

    expect(h.queueDelivery).toHaveBeenCalledWith(OWNER_ID, {
      type: "connection_request",
      connectionId: "conn-1",
      peerId: "remote-peer",
      dataPort: 9000,
      name: "remote-name",
      fingerprint: "fp",
    });
  });

  it("pushes the delivery live via onDelivery when a callback is registered", () => {
    const h = makeHarness({ withOnDelivery: true });
    h.approval.handleConnectionRequest(
      { id: "conn-1" },
      {
        peerId: "remote-peer",
        dataPort: 9000,
        name: "remote-name",
        fingerprint: "fp",
      },
    );
    expect(h.onDelivery).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectionApproval — acceptConnection", () => {
  it("accepts a genuinely pending connection via the transport", async () => {
    const h = makeHarness();
    h.approval.handleConnectionRequest(
      { id: "conn-1" },
      {
        peerId: "remote-peer",
        dataPort: 9000,
        name: "remote-name",
        fingerprint: "fp",
      },
    );
    await h.approval.acceptConnection("conn-1");
    expect(h.transport.acceptConnection).toHaveBeenCalledWith({ id: "conn-1" });
  });

  it("throws an error naming the exact unknown connection id, and never touches the transport", async () => {
    const h = makeHarness();
    await expect(h.approval.acceptConnection("no-such-conn")).rejects.toThrow(
      "No pending connection no-such-conn",
    );
    expect(h.transport.acceptConnection).not.toHaveBeenCalled();
  });
});

describe("ConnectionApproval — rejectConnection", () => {
  it("rejects a genuinely pending connection via the transport with the given reason", async () => {
    const h = makeHarness();
    h.approval.handleConnectionRequest(
      { id: "conn-1" },
      {
        peerId: "remote-peer",
        dataPort: 9000,
        name: "remote-name",
        fingerprint: "fp",
      },
    );
    await h.approval.rejectConnection("conn-1", "not now");
    expect(h.transport.rejectConnection).toHaveBeenCalledWith(
      { id: "conn-1" },
      "not now",
    );
  });

  it("throws an error naming the exact unknown connection id, and never touches the transport", async () => {
    const h = makeHarness();
    await expect(
      h.approval.rejectConnection("no-such-conn", "reason"),
    ).rejects.toThrow("No pending connection no-such-conn");
    expect(h.transport.rejectConnection).not.toHaveBeenCalled();
  });
});

describe("ConnectionApproval — connectToRemote", () => {
  it("dials out with the local agent's real name and an empty fingerprint when the agent is known", async () => {
    const h = makeHarness();
    h.deps.agents.set(OWNER_ID, agent({ name: "real-name" }));

    await h.approval.connectToRemote(REMOTE_HOST, REMOTE_PORT);

    expect(h.transport.connectToRemote).toHaveBeenCalledWith({
      host: REMOTE_HOST,
      port: REMOTE_PORT,
      peerId: OWNER_ID,
      dataPort: LOCAL_DATA_PORT,
      name: "real-name",
      fingerprint: "",
    });
  });

  it("falls back to an empty name (not a placeholder) when the local agent isn't registered yet", async () => {
    const h = makeHarness();

    await h.approval.connectToRemote(REMOTE_HOST, REMOTE_PORT);

    expect(h.transport.connectToRemote).toHaveBeenCalledWith({
      host: REMOTE_HOST,
      port: REMOTE_PORT,
      peerId: OWNER_ID,
      dataPort: LOCAL_DATA_PORT,
      name: "",
      fingerprint: "",
    });
  });

  it("does not reject the returned promise when the transport's own connect attempt is rejected", async () => {
    const h = makeHarness();
    h.transport.connectToRemote.mockRejectedValue(
      new Error("coordinator refused"),
    );

    await expect(
      h.approval.connectToRemote(REMOTE_HOST, REMOTE_PORT),
    ).resolves.toBeUndefined();
  });
});

describe("ConnectionApproval — startDataServerOnly", () => {
  it("starts the data server, records this peer's own PeerInfo, and unrefs the transport", async () => {
    const h = makeHarness();
    await h.approval.startDataServerOnly();

    expect(h.transport.startDataServer).toHaveBeenCalledTimes(1);
    expect(h.deps.peerInfo.get(OWNER_ID)).toEqual({
      id: OWNER_ID,
      port: LOCAL_DATA_PORT,
      startedAt: STARTED_AT,
    });
    expect(h.transport.unref).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectionApproval — listPendingConnections", () => {
  it("lists every still-pending inbound connection with its full request detail", () => {
    const h = makeHarness();
    h.approval.handleConnectionRequest(
      { id: "conn-1" },
      { peerId: "peer-a", dataPort: 1, name: "a", fingerprint: "fp-a" },
    );
    h.approval.handleConnectionRequest(
      { id: "conn-2" },
      { peerId: "peer-b", dataPort: 2, name: "b", fingerprint: "fp-b" },
    );

    expect(h.approval.listPendingConnections()).toEqual([
      {
        connectionId: "conn-1",
        peerId: "peer-a",
        dataPort: 1,
        name: "a",
        fingerprint: "fp-a",
      },
      {
        connectionId: "conn-2",
        peerId: "peer-b",
        dataPort: 2,
        name: "b",
        fingerprint: "fp-b",
      },
    ]);
  });

  it("no longer lists a connection once it's been accepted or rejected", async () => {
    const h = makeHarness();
    h.approval.handleConnectionRequest(
      { id: "conn-1" },
      { peerId: "peer-a", dataPort: 1, name: "a", fingerprint: "fp-a" },
    );
    await h.approval.acceptConnection("conn-1");
    expect(h.approval.listPendingConnections()).toEqual([]);
  });
});
