/**
 * Integration tests for bidirectional connection approval.
 *
 * Verifies that a peer can connect via connect_request, the coordinator
 * receives the request, accepts or rejects it, and the connection is
 * established or torn down accordingly.
 */

import * as net from "node:net";
import { test, describe, expect } from "vitest";
import { createTlsTransport } from "wire-mesh-core/adapters/tls-transport";
import { acceptMeshSession } from "wire-mesh-core/domain/mesh-session";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import {
  DOMAIN,
  FRAME_SCOPE,
  buildCommand,
} from "../core/wire-mesh-transport.js";
import type { DeliveryEvent, AgentIdentity } from "../core/types.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

/** How long to let the coordinator settle (bind its listener, finish registering its agent) before a connecting peer dials in. */
const COORDINATOR_SETTLE_DELAY_MS = 100;
/** How long to wait for a reject to propagate when there is no positive event to poll for (the assertion proves an absence). */
const REJECTION_PROPAGATION_WAIT_MS = 200;
/** How long to let the coordinator settle before driving the mesh_connect/mesh_accept/mesh_reject/mesh_pending flow through the tool layer. */
const TOOL_FLOW_SETTLE_DELAY_MS = 200;
/** Extra margin past a pending connection's own configured timeout, to be sure it has actually expired before asserting on that. */
const PENDING_CONNECTION_EXPIRY_BUFFER_MS = 500;

/** Find a free port on localhost by binding to port 0. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/** Find a free port for a single test's use. An alias for findFreePort(): asking the OS for a fresh ephemeral port each call already guarantees distinctness from any other currently-bound port, so no arithmetic offset is layered on top -- a prior +offset scheme could push an already-high OS-assigned port past 65535 and fail with ERR_SOCKET_BAD_PORT. */
async function uniquePort(): Promise<number> {
  return findFreePort();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("connection approval", () => {
  test("coordinator receives connection_request from connecting peer", async () => {
    const portA = await uniquePort();
    const portB = await uniquePort();

    // Set up coordinator (store A)
    const storeA = new MeshStore({ coordinatorPort: portA });
    await wireTestTransport(storeA);
    const storeB = new MeshStore({ coordinatorPort: portB });
    await wireTestTransport(storeB);
    try {
      const receivedRequests: Extract<
        DeliveryEvent,
        { type: "connection_request" }
      >[] = [];
      storeA.onDelivery = (_id, event) => {
        if (event.type === "connection_request") {
          receivedRequests.push(event);
        }
      };
      await storeA.init();
      await storeA.registerAgent({
        name: "coordinator",
        harness: "test",
        cwd: "/test/a",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      await sleep(COORDINATOR_SETTLE_DELAY_MS);

      // Set up connecting peer (store B) that uses connectToRemote
      await storeB.startDataServerOnly();
      await storeB.registerAgent({
        name: "connector",
        harness: "test",
        cwd: "/test/b",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      // Initiate connection request
      storeB.connectToRemote("127.0.0.1", portA);

      // Wait for the coordinator to receive the request
      await waitFor(
        () => receivedRequests.length === 1,
        "coordinator receives the connection request",
      );

      // Coordinator should have received a connection_request event
      expect(
        receivedRequests.length,
        "Coordinator should receive exactly one connection request",
      ).toBe(1);
      const request = receivedRequests[0];
      expect(request?.type).toBe("connection_request");
      expect(
        request?.connectionId,
        "Request should have a connectionId",
      ).toBeTruthy();
      expect(
        request?.peerId,
        "Request should contain connector's peer ID",
      ).toBe(storeB.peerId);
      expect(request?.name, "Request should contain connector's name").toBe(
        "connector",
      );
    } finally {
      await storeB.shutdown();
      await storeA.shutdown();
    }
  });

  test("accept establishes the peer connection", async () => {
    const portA = await uniquePort();
    const portB = await uniquePort();

    const storeA = new MeshStore({ coordinatorPort: portA });
    await wireTestTransport(storeA);
    const storeB = new MeshStore({ coordinatorPort: portB });
    await wireTestTransport(storeB);
    try {
      const receivedRequests: Extract<
        DeliveryEvent,
        { type: "connection_request" }
      >[] = [];
      storeA.onDelivery = (_id, event) => {
        if (event.type === "connection_request") {
          receivedRequests.push(event);
        }
      };
      await storeA.init();
      await storeA.registerAgent({
        name: "coordinator",
        harness: "test",
        cwd: "/test/a",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      await sleep(COORDINATOR_SETTLE_DELAY_MS);

      await storeB.startDataServerOnly();
      await storeB.registerAgent({
        name: "connector",
        harness: "test",
        cwd: "/test/b",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      storeB.connectToRemote("127.0.0.1", portA);

      await waitFor(
        () => receivedRequests.length === 1,
        "coordinator receives the connection request",
      );
      const request = receivedRequests[0];
      expect(request?.connectionId).toBeTruthy();
      if (request === undefined)
        throw new Error("expected a pending connection request");

      // Accept the connection
      await storeA.acceptConnection(request.connectionId);

      // State sync (peer_list -> connectToPeer -> state_sync -> handlePeerConnected) is a real TLS round trip, not instantaneous -- poll rather than assume any fixed delay is enough under a loaded CI runner.
      await waitFor(
        () => storeA.serialise().agents[storeB.peerId] !== undefined,
        "coordinator sees the connector agent",
      );
      await waitFor(
        () => storeB.serialise().agents[storeA.peerId] !== undefined,
        "connector sees the coordinator agent",
      );

      const agentsA = await storeA.listAgents(storeA.peerId);
      const agentsB = await storeB.listAgents(storeB.peerId);

      expect(
        agentsA.some((a) => a.id === storeB.peerId),
        "Coordinator should see the connector agent",
      ).toBeTruthy();
      expect(
        agentsB.some((a) => a.id === storeA.peerId),
        "Connector should see the coordinator agent",
      ).toBeTruthy();
    } finally {
      await storeB.shutdown();
      await storeA.shutdown();
    }
  });

  test("reject closes with reason", async () => {
    const portA = await uniquePort();
    const portB = await uniquePort();

    const storeA = new MeshStore({ coordinatorPort: portA });
    await wireTestTransport(storeA);
    const storeB = new MeshStore({ coordinatorPort: portB });
    await wireTestTransport(storeB);
    try {
      const receivedRequests: Extract<
        DeliveryEvent,
        { type: "connection_request" }
      >[] = [];
      storeA.onDelivery = (_id, event) => {
        if (event.type === "connection_request") {
          receivedRequests.push(event);
        }
      };
      await storeA.init();
      await storeA.registerAgent({
        name: "coordinator",
        harness: "test",
        cwd: "/test/a",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      await sleep(COORDINATOR_SETTLE_DELAY_MS);

      await storeB.startDataServerOnly();
      await storeB.registerAgent({
        name: "connector",
        harness: "test",
        cwd: "/test/b",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      storeB.connectToRemote("127.0.0.1", portA);

      await waitFor(
        () => receivedRequests.length === 1,
        "coordinator receives the connection request",
      );

      expect(
        receivedRequests.length,
        "Coordinator should receive a connection request",
      ).toBe(1);
      const request = receivedRequests[0];
      expect(request?.connectionId).toBeTruthy();
      if (request === undefined)
        throw new Error("expected a pending connection request");

      // Reject the connection
      await storeA.rejectConnection(request.connectionId, "unauthorised");

      // Give the rejection time to propagate -- there is no positive event to poll for here (the assertion below proves an absence), so a fixed wait is the right shape, unlike the accept-flow tests above.
      await sleep(REJECTION_PROPAGATION_WAIT_MS);

      // Verify the coordinator no longer sees the connector agent
      const agentsA = await storeA.listAgents(storeA.peerId);
      expect(
        !agentsA.some((a) => a.id === storeB.peerId),
        "Rejected peer should not appear in agent list",
      ).toBeTruthy();
    } finally {
      await storeB.shutdown();
      await storeA.shutdown();
    }
  });

  test("connect_request expires and is auto-rejected if left unanswered past the configured timeout", async () => {
    const portA = await uniquePort();
    const portB = await uniquePort();
    const SHORT_PENDING_CONNECTION_TIMEOUT_MS = 300;

    const storeA = new MeshStore({ coordinatorPort: portA });
    wireTestTransport(storeA, {
      pendingConnectionTimeoutMs: SHORT_PENDING_CONNECTION_TIMEOUT_MS,
    });
    const storeB = new MeshStore({ coordinatorPort: portB });
    wireTestTransport(storeB);
    try {
      const receivedRequests: Extract<
        DeliveryEvent,
        { type: "connection_request" }
      >[] = [];
      storeA.onDelivery = (_id, event) => {
        if (event.type === "connection_request") {
          receivedRequests.push(event);
        }
      };
      await storeA.init();
      await storeA.registerAgent({
        name: "coordinator",
        harness: "test",
        cwd: "/test/a",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      await sleep(COORDINATOR_SETTLE_DELAY_MS);

      await storeB.startDataServerOnly();
      await storeB.registerAgent({
        name: "connector",
        harness: "test",
        cwd: "/test/b",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      storeB.connectToRemote("127.0.0.1", portA);

      await waitFor(
        () => receivedRequests.length === 1,
        "coordinator receives the connection request",
      );
      const request = receivedRequests[0];
      expect(request?.connectionId).toBeTruthy();
      if (request === undefined)
        throw new Error("expected a pending connection request");

      // No accept/reject call at all -- wait past the configured timeout with the request left untouched.
      await sleep(
        SHORT_PENDING_CONNECTION_TIMEOUT_MS +
          PENDING_CONNECTION_EXPIRY_BUFFER_MS,
      );

      // The strongest available proof the entry actually expired (not merely "still pending, not yet an agent," which would be equally true before any decision): acceptConnection on an expired request must fail exactly the way it fails for any other unknown handle, since expirePendingConnection has already deleted it.
      await expect(
        storeA.acceptConnection(request.connectionId),
        "An expired connect_request should no longer be acceptable",
      ).rejects.toThrow(/No pending connection/);

      const agentsA = await storeA.listAgents(storeA.peerId);
      expect(
        !agentsA.some((a) => a.id === storeB.peerId),
        "An expired, auto-rejected peer should not appear in agent list",
      ).toBeTruthy();
    } finally {
      await storeB.shutdown();
      await storeA.shutdown();
    }
  });

  test("mesh_pending lists pending connections", async () => {
    const portA = await uniquePort();
    const portB = await uniquePort();

    const storeA = new MeshStore({ coordinatorPort: portA });
    await wireTestTransport(storeA);
    const storeB = new MeshStore({ coordinatorPort: portB });
    await wireTestTransport(storeB);
    try {
      storeA.onDelivery = () => {};
      await storeA.init();
      await storeA.registerAgent({
        name: "coordinator",
        harness: "test",
        cwd: "/test/a",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      await sleep(COORDINATOR_SETTLE_DELAY_MS);

      await storeB.startDataServerOnly();
      await storeB.registerAgent({
        name: "connector",
        harness: "test",
        cwd: "/test/b",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      // No pending connections initially
      let pending = storeA.listPendingConnections();
      expect(
        pending.length,
        "Should have no pending connections initially",
      ).toBe(0);

      // Initiate connection request
      storeB.connectToRemote("127.0.0.1", portA);

      await waitFor(
        () => storeA.listPendingConnections().length === 1,
        "coordinator sees the pending connection",
      );

      // Should now have one pending connection
      pending = storeA.listPendingConnections();
      expect(pending.length, "Should have one pending connection").toBe(1);
      expect(
        pending[0]?.name,
        "Pending connection should show connector name",
      ).toBe("connector");
      expect(
        pending[0]?.peerId,
        "Pending connection should show connector peer ID",
      ).toBe(storeB.peerId);

      // Accept to clean up
      const connectionId = pending[0]?.connectionId;
      expect(connectionId).toBeTruthy();
      if (connectionId === undefined)
        throw new Error("expected a connection id");
      await storeA.acceptConnection(connectionId);

      // No more pending connections after acceptance
      await waitFor(
        () => storeA.listPendingConnections().length === 0,
        "pending connection is cleared after accept",
      );

      // connectToRemote (storeB) and acceptConnection's own introduction handling (storeA) both continue asynchronously after this point (state_sync's own connectToPeer round trip) -- shutting down before that settles races storeB's still-in-flight session setup against its own teardown, leaving a session that gets tracked into an already-shut-down transport and never closed. Wait for real convergence first, the same way "accept establishes the peer connection" above already does.
      await waitFor(
        () => storeB.serialise().agents[storeA.peerId] !== undefined,
        "connector sees the coordinator agent",
      );
    } finally {
      await storeB.shutdown();
      await storeA.shutdown();
    }
  });

  test("tool handles mesh_connect/mesh_accept/mesh_reject/mesh_pending actions", async () => {
    const portA = await uniquePort();
    const portB = await uniquePort();

    const storeA = new MeshStore({ coordinatorPort: portA });
    await wireTestTransport(storeA);
    const storeB = new MeshStore({ coordinatorPort: portB });
    await wireTestTransport(storeB);
    try {
      storeA.onDelivery = () => {};
      await storeA.init();
      await storeA.registerAgent({
        name: "coordinator",
        harness: "test",
        cwd: "/test/a",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });
      const toolA = new CommsTool(storeA);

      await sleep(COORDINATOR_SETTLE_DELAY_MS);

      await storeB.startDataServerOnly();
      await storeB.registerAgent({
        name: "connector",
        harness: "test",
        cwd: "/test/b",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });
      const toolB = new CommsTool(storeB);

      // Use buildAction to construct the mesh_connect action
      const connectAction = buildAction({
        action: "mesh_connect",
        host: "127.0.0.1",
        port: portA,
      });

      // Give coordinator time to settle
      await sleep(TOOL_FLOW_SETTLE_DELAY_MS);

      // Verify coordinator is listening
      const listeners = storeA.listListeners();
      expect(
        listeners.length > 0,
        `Coordinator should have listeners, got ${listeners.length}`,
      ).toBeTruthy();
      expect(listeners[0]?.port, `Coordinator should be on port ${portA}`).toBe(
        portA,
      );

      // B initiates the connection via the tool
      const connectResult = await toolB.handle(
        {
          agentId: storeB.peerId,
          harness: "test",
          cwd: "/test/b",
          pid: process.pid,
        },
        connectAction,
      );
      expect(
        !connectResult.isError,
        `mesh_connect should succeed: ${connectResult.content}`,
      ).toBeTruthy();

      await waitFor(
        () => storeA.listPendingConnections().length === 1,
        "coordinator sees the pending connection",
      );

      // A checks pending connections via the tool
      const pendingAction = buildAction({ action: "mesh_pending" });
      const pendingResult = await toolA.handle(
        {
          agentId: storeA.peerId,
          harness: "test",
          cwd: "/test/a",
          pid: process.pid,
        },
        pendingAction,
      );
      expect(
        !pendingResult.isError,
        `mesh_pending should succeed: ${pendingResult.content}`,
      ).toBeTruthy();
      expect(
        pendingResult.content.includes("connector"),
        "Pending list should show connector name",
      ).toBeTruthy();

      // Extract connectionId from the pending connections list
      const pendingConns = storeA.listPendingConnections();
      expect(pendingConns.length, "Should have one pending connection").toBe(1);
      const connectionId = pendingConns[0]?.connectionId;
      expect(connectionId).toBeTruthy();

      // A accepts the connection via the tool
      const acceptAction = buildAction({
        action: "mesh_accept",
        connectionId,
      });
      const acceptResult = await toolA.handle(
        {
          agentId: storeA.peerId,
          harness: "test",
          cwd: "/test/a",
          pid: process.pid,
        },
        acceptAction,
      );
      expect(
        !acceptResult.isError,
        `mesh_accept should succeed: ${acceptResult.content}`,
      ).toBeTruthy();

      // State sync is a real TLS round trip, not instantaneous -- poll rather than assume any fixed delay is enough under a loaded CI runner.
      await waitFor(
        () => storeA.serialise().agents[storeB.peerId] !== undefined,
        "A sees B after accept",
      );
      await waitFor(
        () => storeB.serialise().agents[storeA.peerId] !== undefined,
        "B sees A after accept",
      );

      // Verify both see each other
      const agentsA = await storeA.listAgents(storeA.peerId);
      const agentsB = await storeB.listAgents(storeB.peerId);
      expect(
        agentsA.some((a) => a.id === storeB.peerId),
        "A should see B after accept",
      ).toBeTruthy();
      expect(
        agentsB.some((a) => a.id === storeA.peerId),
        "B should see A after accept",
      ).toBeTruthy();
    } finally {
      await storeB.shutdown();
      await storeA.shutdown();
    }
  });

  test("tool mesh_reject returns error message", async () => {
    const portA = await uniquePort();
    const portB = await uniquePort();

    const storeA = new MeshStore({ coordinatorPort: portA });
    await wireTestTransport(storeA);
    const storeB = new MeshStore({ coordinatorPort: portB });
    await wireTestTransport(storeB);
    try {
      storeA.onDelivery = () => {};
      await storeA.init();
      await storeA.registerAgent({
        name: "coordinator",
        harness: "test",
        cwd: "/test/a",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });
      const toolA = new CommsTool(storeA);

      await sleep(COORDINATOR_SETTLE_DELAY_MS);

      await storeB.startDataServerOnly();
      await storeB.registerAgent({
        name: "connector",
        harness: "test",
        cwd: "/test/b",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      // B connects
      storeB.connectToRemote("127.0.0.1", portA);

      await waitFor(
        () => storeA.listPendingConnections().length === 1,
        "coordinator sees the pending connection",
      );

      const pendingConns = storeA.listPendingConnections();
      const connectionId = pendingConns[0]?.connectionId;
      expect(connectionId).toBeTruthy();

      // A rejects via the tool
      const rejectAction = buildAction({
        action: "mesh_reject",
        connectionId,
        reason: "not allowed",
      });
      const rejectResult = await toolA.handle(
        {
          agentId: storeA.peerId,
          harness: "test",
          cwd: "/test/a",
          pid: process.pid,
        },
        rejectAction,
      );
      expect(
        !rejectResult.isError,
        `mesh_reject should succeed: ${rejectResult.content}`,
      ).toBeTruthy();
      expect(
        rejectResult.content.includes("not allowed"),
        "Result should include the reason",
      ).toBeTruthy();

      // Verify rejection took effect
      const pending = storeA.listPendingConnections();
      expect(pending.length, "No pending connections after reject").toBe(0);
    } finally {
      await storeB.shutdown();
      await storeA.shutdown();
    }
  });

  test("a message other than introduce/connect_request from an unapproved connection is refused, not routed", async () => {
    const portA = await uniquePort();
    const storeA = new MeshStore({ coordinatorPort: portA });
    await wireTestTransport(storeA);
    try {
      await storeA.init();
      await storeA.registerAgent({
        name: "coordinator",
        harness: "test",
        cwd: "/test/a",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });

      // A hostile client that completes a TLS handshake (proving only which key it holds, not that a human approved it) and skips connect_request entirely, going straight for a forged state_update.
      const attackerIdentity = generateIdentity();
      const attackerTransport = createTlsTransport({
        certificatePem: attackerIdentity.certificate,
        privateKeyPem: attackerIdentity.privateKey,
      });
      const connection = await attackerTransport.connect(
        `127.0.0.1:${String(portA)}`,
      );
      const attackerIdentityPort = await toIdentityPort(attackerIdentity);
      const session = await acceptMeshSession(
        connection,
        attackerIdentityPort,
        [DOMAIN],
      );

      const forgedAgent: AgentIdentity = {
        id: "forged-attacker-agent",
        version: 1,
        name: "forged",
        harness: "test",
        cwd: "/forged",
        pid: 1,
        startedAt: new Date().toISOString(),
        visibility: "visible",
        status: "active",
        tags: [],
        subscribedRooms: [],
      };
      const outcome = await session.sendManageRequest(
        buildCommand({
          method: "state_update",
          patch: { type: "agent_upsert", agent: forgedAgent },
        }),
        FRAME_SCOPE,
      );

      expect(
        outcome.result,
        "an unapproved connection's message must be refused, not routed",
      ).toBe("error");
      expect(
        storeA.serialise().agents[forgedAgent.id],
        "a forged state_update from an unapproved connection must never reach mesh-store's own state",
      ).toBe(undefined);
    } finally {
      await storeA.shutdown();
    }
  });
});
