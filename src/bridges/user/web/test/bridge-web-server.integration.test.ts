/**
 * The web UI a bridge starts runs on the bridge's own store (agent-comms#293): a bridge process is one mesh peer and one agent, so serving the UI must not add a second store, a second device on the mesh, or a second agent.
 */
import { afterEach, expect, it } from "vitest";
import { MeshStore } from "../../../../core/mesh-store.js";
import { freeLocalPort, TeardownStack } from "../../../../test/hub-helpers.js";
import { wireTestTransport } from "../../../../test/test-transport.js";
import { tryStartBridgeWebServer } from "../server.js";

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

it("serves the web UI from the bridge's own store, without adding a device or an agent to the mesh", async () => {
  const store = new MeshStore({ coordinatorPort: await freeLocalPort() });
  await wireTestTransport(store);
  await store.init();
  cleanups.push(async () => store.shutdown());
  const registered = await store.registerAgent({
    name: "bridge-agent",
    harness: "test",
    cwd: "/test/bridge",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });

  const handle = await tryStartBridgeWebServer(store, "test");
  if (handle === undefined) throw new Error("expected the web server to start");
  cleanups.push(async () => {
    await new Promise<void>((resolve) => {
      handle.wss.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      handle.server.close(() => {
        resolve();
      });
    });
  });

  expect(handle.controller.meshStore).toBe(store);
  expect(handle.controller.agentId).toBe(registered.id);
  const agents = await store.listAgents(store.peerId);
  expect(agents.map((agent) => agent.id)).toEqual([store.peerId]);
  expect(Object.keys(store.serialise().agents)).toEqual([store.peerId]);
});
