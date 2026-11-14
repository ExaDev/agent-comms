/**
 * A standalone page (the hosted dashboard) has no bridge at its own origin, so MeshClient.connect probes the bridge port range and hands the worker the mesh socket address of the first bridge it finds. Runs the real client against a real bridge, with a real MessageChannel standing in for the SharedWorker's port.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  TeardownStack,
  testBridgePortBase,
} from "../../../../../test/hub-helpers.js";
import { bridgeMeshUrl } from "../../bridge-port-range.js";
import { startTestBridge } from "../../test/bridge-web-server.helper.js";
import { MeshClient } from "../mesh-client.js";
import { getWebPort } from "../../server.js";

const cleanups = new TeardownStack();

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanups.run();
});

beforeEach(() => {
  vi.stubGlobal("location", {
    host: "exadev.github.io",
    protocol: "https:",
  });
});

/** The first init frame the page posts to the worker's port. */
async function nextInitUrl(port: Readonly<MessagePort>): Promise<string> {
  return new Promise((resolve) => {
    port.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const frame: unknown = JSON.parse(event.data);
      if (
        typeof frame === "object" &&
        frame !== null &&
        "type" in frame &&
        frame.type === "init" &&
        "url" in frame &&
        typeof frame.url === "string"
      ) {
        resolve(frame.url);
      }
    });
    port.start();
  });
}

it("posts the mesh socket address of the bridge it found in the range to the worker", async () => {
  const base = testBridgePortBase();
  const bridge = await startTestBridge(cleanups, base);
  const channel = new MessageChannel();
  cleanups.push(async () => {
    channel.port1.close();
    channel.port2.close();
  });
  vi.stubGlobal(
    "SharedWorker",
    class {
      readonly port = channel.port1;
    },
  );
  const init = nextInitUrl(channel.port2);

  const client = new MeshClient({ bridgePortBase: base });
  // Runs before the ports close: disconnect() ends the client's event pump, which otherwise retries at once, without waiting, whenever the port it reads from closes.
  cleanups.push(async () => {
    client.disconnect();
  });
  client.connect();

  const port = getWebPort(bridge);
  if (port === undefined) throw new Error("expected a bound port");
  expect(await init).toBe(bridgeMeshUrl(port));
});
