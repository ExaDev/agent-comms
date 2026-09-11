/**
 * Parity test for WireMeshTransport's connection-approval flow (connectToRemote/acceptConnection/rejectConnection) and listener management, mirroring approval.integration.test.ts's own scenarios against the new substrate.
 */

import * as assert from "node:assert/strict";
import { test, describe } from "node:test";
import * as net from "node:net";
import { createTlsTransport } from "@exadev/wire-mesh-core/adapters/tls-transport";
import { acceptMeshSession } from "@exadev/wire-mesh-core/domain/mesh-session";
import { MeshStore } from "../core/mesh-store.js";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import {
  DOMAIN,
  FRAME_SCOPE,
  buildCommand,
} from "../core/wire-mesh-transport.js";
import type { DeliveryEvent, AgentIdentity } from "../core/types.js";
import { waitFor, wireWireMeshTestTransport } from "./test-transport.js";

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

/** Find a free port for a single test's use. An alias for findFreePort(): asking the OS for a fresh ephemeral port each call already guarantees distinctness from any other currently-bound port, so no arithmetic offset is layered on top -- a prior +offset scheme could push an already-high OS-assigned port past 65535 and fail with ERR_SOCKET_BAD_PORT. */
function uniquePort(): Promise<number> {
  return findFreePort();
}

describe("WireMeshTransport connection approval", () => {
  void test("accept establishes the peer connection", async () => {
    const portA = await uniquePort();
    const portB = await uniquePort();

    const storeA = new MeshStore(portA);
    wireWireMeshTestTransport(storeA);
    const storeB = new MeshStore(portB);
    wireWireMeshTestTransport(storeB);
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
      assert.ok(request?.connectionId);

      await storeA.acceptConnection(request.connectionId);

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
      assert.ok(
        agentsA.some((a) => a.id === storeB.peerId),
        "Coordinator should see the connector agent",
      );
      assert.ok(
        agentsB.some((a) => a.id === storeA.peerId),
        "Connector should see the coordinator agent",
      );
    } finally {
      await storeB.shutdown();
      await storeA.shutdown();
    }
  });

  void test("reject closes with reason", async () => {
    const portA = await uniquePort();
    const portB = await uniquePort();

    const storeA = new MeshStore(portA);
    wireWireMeshTestTransport(storeA);
    const storeB = new MeshStore(portB);
    wireWireMeshTestTransport(storeB);
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
      assert.ok(request?.connectionId);

      await storeA.rejectConnection(request.connectionId, "unauthorised");

      await waitFor(
        () => storeA.listPendingConnections().length === 0,
        "the pending connection clears",
      );
      const agentsA = await storeA.listAgents(storeA.peerId);
      assert.ok(
        !agentsA.some((a) => a.id === storeB.peerId),
        "Rejected peer should not appear in agent list",
      );
    } finally {
      await storeB.shutdown();
      await storeA.shutdown();
    }
  });

  void test("a message other than introduce/connect_request from an unapproved connection is refused, not routed", async () => {
    const portA = await uniquePort();
    const storeA = new MeshStore(portA);
    wireWireMeshTestTransport(storeA);
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

      assert.equal(
        outcome.result,
        "error",
        "an unapproved connection's message must be refused, not routed",
      );
      assert.equal(
        storeA.serialise().agents[forgedAgent.id],
        undefined,
        "a forged state_update from an unapproved connection must never reach mesh-store's own state",
      );
    } finally {
      await storeA.shutdown();
    }
  });
});

describe("WireMeshTransport listener management", () => {
  void test("addListener creates an additional listener; removeListener removes it", async () => {
    const port = await uniquePort();
    const store = new MeshStore(port);
    wireWireMeshTestTransport(store);
    try {
      await store.init();
      const before = store.listListeners();
      assert.strictEqual(
        before.length,
        1,
        "starts with just the default listener",
      );
      assert.ok(before[0]?.isDefault);

      const extraPort = await uniquePort();
      const id = await store.addListener("127.0.0.1", extraPort, "observe");
      const afterAdd = store.listListeners();
      assert.strictEqual(afterAdd.length, 2);
      const added = afterAdd.find((l) => l.id === id);
      assert.ok(added);
      assert.strictEqual(added.policy, "observe");
      assert.strictEqual(added.isDefault, false);

      await store.removeListener(id);
      const afterRemove = store.listListeners();
      assert.strictEqual(afterRemove.length, 1);
    } finally {
      await store.shutdown();
    }
  });

  void test("removeListener rejects removing the default listener", async () => {
    const port = await uniquePort();
    const store = new MeshStore(port);
    wireWireMeshTestTransport(store);
    try {
      await store.init();
      const [defaultListener] = store.listListeners();
      assert.ok(defaultListener);
      await assert.rejects(() => store.removeListener(defaultListener.id));
    } finally {
      await store.shutdown();
    }
  });
});
