/**
 * The PWA icon route answers only the icons the build holds. A name that is a member of every object (`constructor`, `toString`) is not an icon: it is answered 404, never as the member's value.
 */
import { afterEach, expect, it, vi } from "vitest";
import { MeshStore } from "../../../../core/mesh-store.js";
import {
  freeLocalPort,
  TeardownStack,
  testBridgePortBase,
} from "../../../../test/hub-helpers.js";
import { wireTestTransport } from "../../../../test/test-transport.js";
import { getWebPort, tryStartBridgeWebServer } from "../server.js";

const ICON_NAME = "icon-96x96.svg";
const ICON_BODY = "<svg/>";

vi.mock("../web-assets.js", () => {
  class FrontendNotBuiltError extends Error {}
  return {
    FrontendNotBuiltError,
    createFrontendAssetLoader: () => () => ({
      indexHtml: "<html/>",
      bundleJs: "",
      meshWorkerJs: "",
      swJs: "",
      manifestJson: "{}",
      icons: new Map([["icon-96x96.svg", Buffer.from("<svg/>")]]),
    }),
  };
});

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

const cleanups = new TeardownStack();

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanups.run();
});

async function startServer(): Promise<string> {
  const store = new MeshStore({ coordinatorPort: await freeLocalPort() });
  await wireTestTransport(store);
  await store.init();
  cleanups.push(async () => store.shutdown());
  const handle = await tryStartBridgeWebServer(store, "test", {
    bridgePortBase: testBridgePortBase(),
  });
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

it("serves an icon the build holds", async () => {
  const origin = await startServer();

  const response = await fetch(`${origin}/icons/${ICON_NAME}`);

  expect(response.status).toBe(HTTP_OK);
  expect(await response.text()).toBe(ICON_BODY);
});

it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
  "answers /icons/%s 404, and reports no failure",
  async (name) => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const origin = await startServer();

    const response = await fetch(`${origin}/icons/${name}`);

    expect(response.status).toBe(HTTP_NOT_FOUND);
    expect(
      stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
    ).not.toMatch(/TypeError|ERR_INVALID_ARG_TYPE/);
  },
);
