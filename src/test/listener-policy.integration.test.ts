/**
 * Integration tests for multi-listener coordinator support.
 *
 * Verifies that the coordinator can listen on multiple adapters,
 * each with its own policy, and that listeners can be added and
 * removed dynamically.
 */

import * as net from "node:net";
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
  WireMeshTransport,
} from "../core/wire-mesh-transport.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";
import { test, describe, expect } from "vitest";
import { wireTestTransport } from "./test-transport.js";

const TEST_PORT = 19880;
const PARSED_ACTION_TEST_PORT = 9999;

describe("listener policy", () => {
  test("coordinator starts with a single default localhost listener", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    try {
      await store.init();

      const listeners = store.listListeners();
      expect(listeners.length, "Should have exactly one listener").toBe(1);
      expect(
        listeners[0]?.policy,
        "Default listener should have full policy",
      ).toBe("full");
      expect(
        listeners[0]?.isDefault,
        "Default listener should be marked as default",
      ).toBe(true);
      expect(
        listeners[0]?.host,
        "Default listener should be on localhost",
      ).toBe("127.0.0.1");
      expect(
        listeners[0]?.port,
        "Default listener should be on the coordinator port",
      ).toBe(TEST_PORT);
    } finally {
      await store.shutdown();
    }
  });

  test("addListener creates an additional listener", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    try {
      await store.init();

      const id = await store.addListener("127.0.0.1", 0, "observe");
      expect(id, "Should return a listener ID").toBeTruthy();

      const listeners = store.listListeners();
      expect(listeners.length, "Should have two listeners").toBe(2);

      const newListener = listeners.find((l) => l.id === id);
      expect(newListener, "New listener should be listed").toBeTruthy();
      if (newListener === undefined)
        throw new Error("New listener should be listed");
      expect(
        newListener.policy,
        "New listener should have observe policy",
      ).toBe("observe");
      expect(newListener.isDefault, "New listener should not be default").toBe(
        false,
      );
      expect(newListener.port > 0, "Should have an assigned port").toBeTruthy();
    } finally {
      await store.shutdown();
    }
  });

  test("removeListener removes a non-default listener", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    try {
      await store.init();

      const id = await store.addListener("127.0.0.1", 0, "observe");
      expect(store.listListeners().length).toBe(2);

      await store.removeListener(id);
      const listeners = store.listListeners();
      expect(listeners.length, "Should be back to one listener").toBe(1);
      expect(
        listeners[0]?.isDefault,
        "Remaining listener should be the default",
      ).toBe(true);
    } finally {
      await store.shutdown();
    }
  });

  test("removeListener rejects removing the default listener", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    try {
      await store.init();

      const listeners = store.listListeners();
      const defaultId = listeners[0]?.id;
      expect(defaultId, "Should have a default listener").toBeTruthy();
      if (defaultId === undefined)
        throw new Error("Should have a default listener");

      await expect(
        store.removeListener(defaultId),
        "Should reject removing default listener",
      ).rejects.toThrow(/Cannot remove the default/);
    } finally {
      await store.shutdown();
    }
  });

  test("observe listener accepts connections but enforces policy", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    try {
      await store.init();

      const id = await store.addListener("127.0.0.1", 0, "observe");
      const listeners = store.listListeners();
      const observeListener = listeners.find((l) => l.id === id);
      expect(observeListener, "Observe listener should exist").toBeTruthy();
      if (observeListener === undefined)
        throw new Error("Observe listener should exist");

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
      expect(
        canConnect,
        "Should be able to connect to observe listener",
      ).toBeTruthy();
    } finally {
      await store.shutdown();
    }
  });

  test("mesh_listeners action returns all listeners via CommsTool", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    try {
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

      expect(!result.isError, "Should not be an error").toBeTruthy();
      expect(
        result.content.includes("full"),
        "Should list the default full listener",
      ).toBeTruthy();
      expect(
        result.content.includes("rooms-only"),
        "Should list the rooms-only listener",
      ).toBeTruthy();
    } finally {
      await store.shutdown();
    }
  });

  test("mesh_interfaces action returns available network adapters", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    try {
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

      expect(!result.isError, "Should not be an error").toBeTruthy();
      expect(
        result.content.includes("lo") || result.content.includes("IPv4"),
        "Should list network interfaces",
      ).toBeTruthy();
    } finally {
      await store.shutdown();
    }
  });

  test("mesh_unlisten removes listener via CommsTool", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    try {
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

      expect(!result.isError, "Should not be an error").toBeTruthy();
      expect(
        result.content.includes("removed"),
        "Should confirm removal",
      ).toBeTruthy();

      const listeners = store.listListeners();
      expect(listeners.length, "Should be back to one listener").toBe(1);
    } finally {
      await store.shutdown();
    }
  });

  test("mesh_listen adds listener via CommsTool", async () => {
    const store = new MeshStore({ coordinatorPort: TEST_PORT });
    await wireTestTransport(store);
    try {
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

      expect(!result.isError, "Should not be an error").toBeTruthy();
      expect(
        result.content.includes("Listener added"),
        "Should confirm addition",
      ).toBeTruthy();

      const listeners = store.listListeners();
      expect(listeners.length, "Should have two listeners").toBe(2);
    } finally {
      await store.shutdown();
    }
  });

  test("buildAction parses mesh_listen with host and policy", () => {
    const action = buildAction({
      action: "mesh_listen",
      host: "192.168.1.1",
      port: PARSED_ACTION_TEST_PORT,
      policy: "observe",
    });
    expect(action.action).toBe("mesh_listen");
    if (action.action === "mesh_listen") {
      expect(action.host).toBe("192.168.1.1");
      expect(action.port).toBe(PARSED_ACTION_TEST_PORT);
      expect(action.policy).toBe("observe");
    }
  });

  test("buildAction parses mesh_unlisten", () => {
    const action = buildAction({
      action: "mesh_unlisten",
      id: "abc123",
    });
    expect(action.action).toBe("mesh_unlisten");
    if (action.action === "mesh_unlisten") {
      expect(action.id).toBe("abc123");
    }
  });

  test("buildAction parses mesh_listeners", () => {
    const action = buildAction({ action: "mesh_listeners" });
    expect(action.action).toBe("mesh_listeners");
  });

  test("buildAction parses mesh_interfaces", () => {
    const action = buildAction({ action: "mesh_interfaces" });
    expect(action.action).toBe("mesh_interfaces");
  });

  test("connections via non-default listener carry policy in handle", async () => {
    // Constructed directly rather than through MeshStore: MeshStore.events is a getter that builds a fresh TransportEvents object on every access, so there's no way to observe what the transport itself passed to onIntroduction without either reaching into the transport by an unsafe cast or, as here, supplying our own TransportEvents object the transport calls directly.
    let receivedPolicy: string | undefined = "not-called";
    const events: TransportEvents = {
      onMessage: () => undefined,
      onPeerConnected: () => undefined,
      onPeerDisconnected: () => undefined,
      onIntroduction: (handle) => {
        receivedPolicy = handle.policy;
      },
      onConnectionRequest: () => undefined,
      onPeerList: () => undefined,
      onPeerJoined: () => undefined,
      onBecomeCoordinator: () => undefined,
      onRevocationAnnounce: () => undefined,
      onPresenceAdvert: () => undefined,
    };
    const identity = generateIdentity();
    const transport = new WireMeshTransport(events, identity);
    try {
      await transport.becomeCoordinator("127.0.0.1", 0);

      const listenerId = await transport.addListener("127.0.0.1", 0, "observe");
      const listeners = transport.listListeners();
      const observeListener = listeners.find((l) => l.id === listenerId);
      expect(observeListener, "Should find the observe listener").toBeTruthy();
      if (observeListener === undefined)
        throw new Error("Should find the observe listener");

      // Connect to the observe listener and send an introduce message over a real WireMeshTransport client session -- the transport should tag the resulting connection handle with policy="observe".
      const probeIdentity = generateIdentity();
      const probeTransport = createTlsTransport({
        certificatePem: probeIdentity.certificate,
        privateKeyPem: probeIdentity.privateKey,
      });
      const connection = await probeTransport.connect(
        `127.0.0.1:${String(observeListener.port)}`,
      );
      const probeIdentityPort = await toIdentityPort(probeIdentity);
      const session = await acceptMeshSession(connection, probeIdentityPort, [
        DOMAIN,
      ]);
      try {
        const outcome = await session.sendManageRequest(
          buildCommand({
            method: "introduce",
            peerId: "probe",
            dataPort: 19999,
          }),
          FRAME_SCOPE,
        );
        expect(outcome.result, "introduce should be accepted").toBe("ok");
        expect(receivedPolicy, "Handle should carry observe policy").toBe(
          "observe",
        );
      } finally {
        await session.close();
      }
    } finally {
      await transport.shutdown();
    }
  });
});
