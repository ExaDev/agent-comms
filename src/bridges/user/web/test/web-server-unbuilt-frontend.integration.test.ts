/**
 * A checkout whose frontend was never built (a `pi install git:` clone installs without the development dependencies, so nothing runs the build) must still start the bridge's web server: only the routes that serve the frontend answer 503, and everything else keeps working. Before agent-comms#440 the server module read the build output when it was imported, which took down every bridge that imports it, the Pi extension first.
 */
import { afterEach, expect, it, vi } from "vitest";
import { MeshStore } from "../../../../core/mesh-store.js";
import { freeLocalPort, TeardownStack } from "../../../../test/hub-helpers.js";
import { wireTestTransport } from "../../../../test/test-transport.js";
import { getWebPort, tryStartBridgeWebServer } from "../server.js";

vi.mock("../web-assets.js", () => {
  class FrontendNotBuiltError extends Error {
    constructor(assetDir: string) {
      super(
        `The web frontend is not built: ${assetDir}/index.html is missing.`,
      );
    }
  }
  return {
    FrontendNotBuiltError,
    createFrontendAssetLoader: () => () => {
      throw new FrontendNotBuiltError("/not/built");
    },
  };
});

const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

async function startServer(): Promise<string> {
  const store = new MeshStore({ coordinatorPort: await freeLocalPort() });
  await wireTestTransport(store);
  await store.init();
  cleanups.push(async () => store.shutdown());
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
  if (!handle.server.listening) {
    await new Promise<void>((resolve) => {
      handle.server.once("listening", () => {
        resolve();
      });
    });
  }
  return `http://${handle.host}:${String(getWebPort(handle))}`;
}

it("answers 503 naming the missing build on every frontend route, and keeps serving the API", async () => {
  const origin = await startServer();

  for (const route of [
    "/",
    "/index.html",
    "/bundle.js",
    "/mesh-worker.js",
    "/sw.js",
    "/manifest.json",
    "/icons/icon-96x96.svg",
  ]) {
    const response = await fetch(`${origin}${route}`);
    expect(response.status, route).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(await response.text(), route).toContain("/not/built");
  }

  const vapid = await fetch(`${origin}/api/push/vapid-key`);
  expect(vapid.status).toBe(HTTP_OK);
});
