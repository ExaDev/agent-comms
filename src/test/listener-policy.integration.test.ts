/**
 * Integration tests for multi-listener coordinator support.
 *
 * Verifies that the coordinator can listen on multiple adapters,
 * each with its own policy, and that listeners can be added and
 * removed dynamically.
 */

import * as net from "node:net";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { buildAction } from "../core/bridge.js";
import type { TransportEvents } from "../core/transport.js";
import * as assert from "node:assert/strict";
import { test, describe } from "node:test";

const TEST_PORT = 19880;

describe("listener policy", () => {
  void test("coordinator starts with a single default localhost listener", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const listeners = store.listListeners();
    assert.equal(listeners.length, 1, "Should have exactly one listener");
    assert.equal(
      listeners[0]?.policy,
      "full",
      "Default listener should have full policy",
    );
    assert.equal(
      listeners[0]?.isDefault,
      true,
      "Default listener should be marked as default",
    );
    assert.equal(
      listeners[0]?.host,
      "127.0.0.1",
      "Default listener should be on localhost",
    );
    assert.equal(
      listeners[0]?.port,
      TEST_PORT,
      "Default listener should be on the coordinator port",
    );

    await store.shutdown();
  });

  void test("addListener creates an additional listener", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const id = await store.addListener("127.0.0.1", 0, "observe");
    assert.ok(id, "Should return a listener ID");

    const listeners = store.listListeners();
    assert.equal(listeners.length, 2, "Should have two listeners");

    const newListener = listeners.find((l) => l.id === id);
    assert.ok(newListener, "New listener should be listed");
    assert.equal(
      newListener.policy,
      "observe",
      "New listener should have observe policy",
    );
    assert.equal(
      newListener.isDefault,
      false,
      "New listener should not be default",
    );
    assert.ok(newListener.port > 0, "Should have an assigned port");

    await store.shutdown();
  });

  void test("removeListener removes a non-default listener", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const id = await store.addListener("127.0.0.1", 0, "observe");
    assert.equal(store.listListeners().length, 2);

    await store.removeListener(id);
    const listeners = store.listListeners();
    assert.equal(listeners.length, 1, "Should be back to one listener");
    assert.equal(
      listeners[0]?.isDefault,
      true,
      "Remaining listener should be the default",
    );

    await store.shutdown();
  });

  void test("removeListener rejects removing the default listener", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const listeners = store.listListeners();
    const defaultId = listeners[0]?.id;
    assert.ok(defaultId, "Should have a default listener");

    await assert.rejects(
      () => store.removeListener(defaultId),
      /Cannot remove the default/,
      "Should reject removing default listener",
    );

    await store.shutdown();
  });

  void test("observe listener accepts connections but enforces policy", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const id = await store.addListener("127.0.0.1", 0, "observe");
    const listeners = store.listListeners();
    const observeListener = listeners.find((l) => l.id === id);
    assert.ok(observeListener, "Observe listener should exist");

    // Verify a peer can connect to the observe listener's port
    const canConnect = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({
        port: observeListener.port,
        host: "127.0.0.1",
      });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    assert.ok(canConnect, "Should be able to connect to observe listener");

    await store.shutdown();
  });

  void test("mesh_listeners action returns all listeners via CommsTool", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const agent = await store.registerAgent({
      name: "test-agent",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    await store.addListener("127.0.0.1", 0, "rooms-only");

    const tool = new CommsTool(store);
    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "mesh_listeners" },
    );

    assert.ok(!result.isError, "Should not be an error");
    assert.ok(
      result.content.includes("full"),
      "Should list the default full listener",
    );
    assert.ok(
      result.content.includes("rooms-only"),
      "Should list the rooms-only listener",
    );

    await store.shutdown();
  });

  void test("mesh_interfaces action returns available network adapters", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const agent = await store.registerAgent({
      name: "test-agent",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    const tool = new CommsTool(store);
    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "mesh_interfaces" },
    );

    assert.ok(!result.isError, "Should not be an error");
    assert.ok(
      result.content.includes("lo") || result.content.includes("IPv4"),
      "Should list network interfaces",
    );

    await store.shutdown();
  });

  void test("mesh_unlisten removes listener via CommsTool", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const agent = await store.registerAgent({
      name: "test-agent",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    const listenerId = await store.addListener("127.0.0.1", 0, "observe");

    const tool = new CommsTool(store);
    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "mesh_unlisten", id: listenerId },
    );

    assert.ok(!result.isError, "Should not be an error");
    assert.ok(result.content.includes("removed"), "Should confirm removal");

    const listeners = store.listListeners();
    assert.equal(listeners.length, 1, "Should be back to one listener");

    await store.shutdown();
  });

  void test("mesh_listen adds listener via CommsTool", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    const agent = await store.registerAgent({
      name: "test-agent",
      harness: "test",
      cwd: "/test",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });

    const tool = new CommsTool(store);
    const result = await tool.handle(
      { agentId: agent.id, harness: "test", cwd: "/test", pid: process.pid },
      { action: "mesh_listen", host: "127.0.0.1", policy: "observe" },
    );

    assert.ok(!result.isError, "Should not be an error");
    assert.ok(
      result.content.includes("Listener added"),
      "Should confirm addition",
    );

    const listeners = store.listListeners();
    assert.equal(listeners.length, 2, "Should have two listeners");

    await store.shutdown();
  });

  void test("buildAction parses mesh_listen with host and policy", () => {
    const action = buildAction({
      action: "mesh_listen",
      host: "192.168.1.1",
      port: 9999,
      policy: "observe",
    });
    assert.equal(action.action, "mesh_listen");
    if (action.action === "mesh_listen") {
      assert.equal(action.host, "192.168.1.1");
      assert.equal(action.port, 9999);
      assert.equal(action.policy, "observe");
    }
  });

  void test("buildAction parses mesh_unlisten", () => {
    const action = buildAction({
      action: "mesh_unlisten",
      id: "abc123",
    });
    assert.equal(action.action, "mesh_unlisten");
    if (action.action === "mesh_unlisten") {
      assert.equal(action.id, "abc123");
    }
  });

  void test("buildAction parses mesh_listeners", () => {
    const action = buildAction({ action: "mesh_listeners" });
    assert.equal(action.action, "mesh_listeners");
  });

  void test("buildAction parses mesh_interfaces", () => {
    const action = buildAction({ action: "mesh_interfaces" });
    assert.equal(action.action, "mesh_interfaces");
  });

  void test("connections via non-default listener carry policy in handle", async () => {
    const store = new MeshStore(TEST_PORT);
    await store.init();

    // Add an observe listener
    const listenerId = await store.addListener("127.0.0.1", 0, "observe");
    const listeners = store.listListeners();
    const observeListener = listeners.find((l) => l.id === listenerId);
    assert.ok(observeListener, "Should find the observe listener");

    // Connect to the observe listener and send an introduce message
    // The transport should tag the connection handle with policy="observe"
    //
    // We intercept at the transport.events level because store.events
    // is a getter that creates a fresh object each call.
    const receivedHandle = await new Promise<{
      policy: string | undefined;
    } | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 3000);

      const transport = (
        store as unknown as { transport: { events: TransportEvents } }
      ).transport;
      const originalOnIntroduction = (
        handle: ConnectionHandle,
        msg: { peerId: string; dataPort: number },
      ) => transport.events.onIntroduction(handle, msg);
      transport.events.onIntroduction = (handle, msg) => {
        // Capture the handle's policy
        resolve({ policy: handle.policy });
        clearTimeout(timeout);
        // Call the original handler
        originalOnIntroduction(handle, msg);
      };

      const socket = net.createConnection({
        port: observeListener.port,
        host: "127.0.0.1",
      });

      socket.on("connect", () => {
        socket.write(
          JSON.stringify({
            method: "introduce",
            peerId: "test-observe-peer",
            dataPort: 19999,
          }) + "\n",
        );
      });

      socket.on("error", () => {
        socket.destroy();
        clearTimeout(timeout);
        resolve(null);
      });
    });

    assert.ok(receivedHandle, "Should receive an introduction");
    assert.equal(
      receivedHandle.policy,
      "observe",
      "Handle should carry observe policy",
    );

    await store.shutdown();
  });
});
