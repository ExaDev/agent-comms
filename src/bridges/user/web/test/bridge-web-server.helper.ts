/**
 * Starting and stopping a bridge's web server on its own store, as a bridge starts it, for tests of the port range and of what probes it.
 */
import { MeshStore } from "../../../../core/mesh-store.js";
import {
  freeLocalPort,
  type TeardownStack,
} from "../../../../test/hub-helpers.js";
import { wireTestTransport } from "../../../../test/test-transport.js";
import { tryStartBridgeWebServer, type WebServerHandle } from "../server.js";

/** Closes the web socket server and the HTTP server of a handle, whether or not it is still listening. */
export async function stopWebServer(handle: WebServerHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    handle.wss.close(() => {
      resolve();
    });
  });
  if (!handle.server.listening) return;
  await new Promise<void>((resolve) => {
    handle.server.close(() => {
      resolve();
    });
    handle.server.closeAllConnections();
  });
}

/** A mesh store with an isolated coordinator and first-contact port, shut down by `cleanups`. */
export async function startTestStore(
  cleanups: Readonly<TeardownStack>,
): Promise<MeshStore> {
  const store = new MeshStore({
    coordinatorPort: await freeLocalPort(),
    firstContactPort: await freeLocalPort(),
  });
  await wireTestTransport(store);
  await store.init();
  cleanups.push(async () => store.shutdown());
  return store;
}

/** A bridge's web server on a store of its own, bound from `bridgePortBase` and stopped by `cleanups`. */
export async function startTestBridge(
  cleanups: Readonly<TeardownStack>,
  bridgePortBase: number,
): Promise<WebServerHandle> {
  const store = await startTestStore(cleanups);
  const handle = await tryStartBridgeWebServer(store, "test", {
    bridgePortBase,
  });
  if (handle === undefined) throw new Error("expected the web server to start");
  cleanups.push(async () => stopWebServer(handle));
  return handle;
}
