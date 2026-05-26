/**
 * Integration tests for bidirectional connection approval.
 *
 * Verifies that a peer can connect via connect_request, the coordinator
 * receives the request, accepts or rejects it, and the connection is
 * established or torn down accordingly.
 */

import * as net from "node:net";
import * as assert from "node:assert/strict";
import { test, describe } from "node:test";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import type { DeliveryEvent } from "../core/types.js";

/** Find a free port on localhost by binding to port 0. */
function findFreePort(): Promise<number> {
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

/** Unique port counter to avoid reusing ports across sequential tests. */
let portOffset = 0;

/** Find a free port with a unique offset to avoid conflicts. */
async function uniquePort(): Promise<number> {
  portOffset += 10;
  const base = await findFreePort();
  return base + portOffset;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("connection approval", () => {
  void test("coordinator receives connection_request from connecting peer", async () => {
    const portA = await uniquePort();
    const portB = portA + 100;

    // Set up coordinator (store A)
    const storeA = new MeshStore(portA);
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

    await sleep(100);

    // Set up connecting peer (store B) that uses connectToRemote
    const storeB = new MeshStore(portB);
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
    await sleep(300);

    // Coordinator should have received a connection_request event
    assert.equal(
      receivedRequests.length,
      1,
      "Coordinator should receive exactly one connection request",
    );
    const request = receivedRequests[0];
    assert.equal(request?.type, "connection_request");
    assert.ok(request?.connectionId, "Request should have a connectionId");
    assert.equal(
      request?.peerId,
      storeB.peerId,
      "Request should contain connector's peer ID",
    );
    assert.equal(
      request?.name,
      "connector",
      "Request should contain connector's name",
    );

    await storeB.shutdown();
    await storeA.shutdown();
  });

  void test("accept establishes the peer connection", async () => {
    const portA = await uniquePort();
    const portB = portA + 100;

    const storeA = new MeshStore(portA);
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

    await sleep(100);

    const storeB = new MeshStore(portB);
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

    await sleep(300);

    assert.equal(
      receivedRequests.length,
      1,
      "Coordinator should receive a connection request",
    );
    const request = receivedRequests[0];
    assert.ok(request?.connectionId);

    // Accept the connection
    await storeA.acceptConnection(request.connectionId);

    // Wait for state sync (peer_list → connectToPeer → state_sync → handlePeerConnected)
    await sleep(500);

    // Verify both stores see each other's agents
    const agentsA = await storeA.listAgents(storeA.peerId);
    const agentsB = await storeB.listAgents(storeB.peerId);

    assert.ok(
      agentsA.some((a) => a.id === storeB.peerId),
      "Coordinator should see the connector agent",
    );
    assert.ok(
      agentsB.some((a) => a.id === storeA.peerId),
      "Connector should see the coordinator agent",
    );

    await storeB.shutdown();
    await storeA.shutdown();
  });

  void test("reject closes with reason", async () => {
    const portA = await uniquePort();
    const portB = portA + 100;

    const storeA = new MeshStore(portA);
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

    await sleep(100);

    const storeB = new MeshStore(portB);
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

    await sleep(300);

    assert.equal(
      receivedRequests.length,
      1,
      "Coordinator should receive a connection request",
    );
    const request = receivedRequests[0];
    assert.ok(request?.connectionId);

    // Reject the connection
    await storeA.rejectConnection(request.connectionId, "unauthorised");

    // Give the rejection time to propagate
    await sleep(200);

    // Verify the coordinator no longer sees the connector agent
    const agentsA = await storeA.listAgents(storeA.peerId);
    assert.ok(
      !agentsA.some((a) => a.id === storeB.peerId),
      "Rejected peer should not appear in agent list",
    );

    await storeB.shutdown();
    await storeA.shutdown();
  });

  void test("mesh_pending lists pending connections", async () => {
    const portA = await uniquePort();
    const portB = portA + 100;

    const storeA = new MeshStore(portA);
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

    await sleep(100);

    const storeB = new MeshStore(portB);
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
    assert.equal(
      pending.length,
      0,
      "Should have no pending connections initially",
    );

    // Initiate connection request
    storeB.connectToRemote("127.0.0.1", portA);

    await sleep(300);

    // Should now have one pending connection
    pending = storeA.listPendingConnections();
    assert.equal(pending.length, 1, "Should have one pending connection");
    assert.equal(
      pending[0]?.name,
      "connector",
      "Pending connection should show connector name",
    );
    assert.equal(
      pending[0]?.peerId,
      storeB.peerId,
      "Pending connection should show connector peer ID",
    );

    // Accept to clean up
    const connectionId = pending[0]?.connectionId;
    assert.ok(connectionId);
    await storeA.acceptConnection(connectionId);

    // Wait for state sync
    await sleep(300);

    // No more pending connections after acceptance
    pending = storeA.listPendingConnections();
    assert.equal(
      pending.length,
      0,
      "Should have no pending connections after accept",
    );

    await storeB.shutdown();
    await storeA.shutdown();
  });

  void test("tool handles mesh_connect/mesh_accept/mesh_reject/mesh_pending actions", async () => {
    const portA = await uniquePort();
    const portB = portA + 100;

    const storeA = new MeshStore(portA);
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

    await sleep(100);

    const storeB = new MeshStore(portB);
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
    await sleep(200);

    // Verify coordinator is listening
    const listeners = storeA.listListeners();
    assert.ok(
      listeners.length > 0,
      `Coordinator should have listeners, got ${listeners.length}`,
    );
    assert.equal(
      listeners[0]?.port,
      portA,
      `Coordinator should be on port ${portA}`,
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
    assert.ok(
      !connectResult.isError,
      `mesh_connect should succeed: ${connectResult.content}`,
    );

    await sleep(300);

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
    assert.ok(
      !pendingResult.isError,
      `mesh_pending should succeed: ${pendingResult.content}`,
    );
    assert.ok(
      pendingResult.content.includes("connector"),
      "Pending list should show connector name",
    );

    // Extract connectionId from the pending connections list
    const pendingConns = storeA.listPendingConnections();
    assert.equal(pendingConns.length, 1, "Should have one pending connection");
    const connectionId = pendingConns[0]?.connectionId;
    assert.ok(connectionId);

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
    assert.ok(
      !acceptResult.isError,
      `mesh_accept should succeed: ${acceptResult.content}`,
    );

    await sleep(200);

    // Verify both see each other
    const agentsA = await storeA.listAgents(storeA.peerId);
    const agentsB = await storeB.listAgents(storeB.peerId);
    assert.ok(
      agentsA.some((a) => a.id === storeB.peerId),
      "A should see B after accept",
    );
    assert.ok(
      agentsB.some((a) => a.id === storeA.peerId),
      "B should see A after accept",
    );

    await storeB.shutdown();
    await storeA.shutdown();
  });

  void test("tool mesh_reject returns error message", async () => {
    const portA = await uniquePort();
    const portB = portA + 100;

    const storeA = new MeshStore(portA);
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

    await sleep(100);

    const storeB = new MeshStore(portB);
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

    await sleep(300);

    const pendingConns = storeA.listPendingConnections();
    const connectionId = pendingConns[0]?.connectionId;
    assert.ok(connectionId);

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
    assert.ok(
      !rejectResult.isError,
      `mesh_reject should succeed: ${rejectResult.content}`,
    );
    assert.ok(
      rejectResult.content.includes("not allowed"),
      "Result should include the reason",
    );

    // Verify rejection took effect
    const pending = storeA.listPendingConnections();
    assert.equal(pending.length, 0, "No pending connections after reject");

    await storeB.shutdown();
    await storeA.shutdown();
  });
});
