/**
 * A bridge binds the first free port of the bridge port range, and the hosted dashboard's probe finds it there. The range base is the calling test worker's own slot, so these tests never bind the range a bridge running on the machine may hold.
 */
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ChatController } from "../../controller.js";
import {
  freeLocalPort,
  TeardownStack,
  testBridgePortBase,
  unreachableHubUrl,
} from "../../../../test/hub-helpers.js";
import {
  BRIDGE_PORT_BASE,
  BRIDGE_PORT_COUNT,
  bridgeMeshUrl,
  bridgePortRange,
  findBridgePort,
  HIGHEST_PORT,
  LOWEST_UNPRIVILEGED_PORT,
  InvalidBridgePortBaseError,
  isBridgeAt,
  probeForBridge,
} from "../bridge-port-range.js";
import {
  createWebServer,
  getWebPort,
  getWebUrlStatus,
  type WebServerHandle,
} from "../server.js";
import {
  startTestBridge,
  startTestStore,
  stopWebServer,
} from "./bridge-web-server.helper.js";

/** The first and last port the hosted dashboard has always probed for a bridge, written out so a change to the range is a deliberate edit of this test too. */
const DASHBOARD_PROBE_FIRST_PORT = 19_877;
const DASHBOARD_PROBE_LAST_PORT = 19_886;

/** A TEST-NET-1 address (RFC 5737), reserved for documentation, so no ordinary host holds it and binding it fails with a code other than "address in use". The test proves that assumption on the host it runs on before relying on it. */
const UNASSIGNED_ADDRESS = "192.0.2.1";

/** How long a probe in these tests waits on a listener that never answers: short, because the answer is known to be silence. */
const SILENT_PROBE_TIMEOUT_MS = 150;

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

/** Binds `port` on loopback with `onConnection` handling each socket, stopped by `cleanups`; undefined when the port is taken. */
async function holdPort(
  port: number,
  onConnection: (socket: net.Socket) => void = () => undefined,
): Promise<net.Server | undefined> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    onConnection(socket);
  });
  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve(true);
    });
  });
  if (!bound) return undefined;
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  return server;
}

/** An HTTP server that is not a bridge, on `port`, stopped by `cleanups`. */
async function holdForeignHttpServer(port: number): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.end("not a bridge");
  });
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
}

function heldPort(handle: WebServerHandle): number {
  const port = getWebPort(handle);
  if (port === undefined) throw new Error("expected a bound port");
  return port;
}

function addressPort(server: net.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return address.port;
}

/** A controller wrapping a started store, the way a bridge hands its own to the web server. */
async function startTestController(): Promise<ChatController> {
  const store = await startTestStore(cleanups);
  return ChatController.fromExisting(store, {
    agentId: store.peerId,
    harness: "test",
    cwd: process.cwd(),
    pid: process.pid,
  });
}

/** Fails with a message naming the cause when this host owns the documentation address, since the bind-error test below would then be testing nothing. */
async function expectDocumentationAddressNotBindable(): Promise<void> {
  const probe = net.createServer();
  const bound = await new Promise<boolean>((resolve) => {
    probe.once("error", () => {
      resolve(false);
    });
    probe.listen(0, UNASSIGNED_ADDRESS, () => {
      resolve(true);
    });
  });
  if (bound) {
    probe.close();
    throw new Error(
      `This host owns ${UNASSIGNED_ADDRESS}, an address reserved for documentation, so a bind there cannot fail: the non-"address in use" bind error test needs a host that does not own it`,
    );
  }
}

describe("the bridge port range", () => {
  it("starts at the port the dashboard has always probed and spans ten ports", () => {
    const range = bridgePortRange();

    expect(BRIDGE_PORT_BASE).toBe(DASHBOARD_PROBE_FIRST_PORT);
    expect(range).toHaveLength(BRIDGE_PORT_COUNT);
    expect(range[0]).toBe(DASHBOARD_PROBE_FIRST_PORT);
    expect(range.at(-1)).toBe(DASHBOARD_PROBE_LAST_PORT);
    expect(range).toEqual(
      Array.from(
        { length: DASHBOARD_PROBE_LAST_PORT - DASHBOARD_PROBE_FIRST_PORT + 1 },
        (_, index) => DASHBOARD_PROBE_FIRST_PORT + index,
      ),
    );
  });

  it("gives each bridge on one machine the next free port, and reports the port it holds", async () => {
    const base = testBridgePortBase();
    const first = await startTestBridge(cleanups, base);
    const second = await startTestBridge(cleanups, base);

    expect(heldPort(first)).toBe(base);
    expect(heldPort(second)).toBe(base + 1);
    expect(getWebUrlStatus(first)).toEqual({
      kind: "ready",
      url: `http://127.0.0.1:${String(base)}`,
    });
    expect(getWebUrlStatus(second)).toEqual({
      kind: "ready",
      url: `http://127.0.0.1:${String(base + 1)}`,
    });
  });

  it("reuses a port a stopped bridge released", async () => {
    const base = testBridgePortBase();
    const first = await startTestBridge(cleanups, base);
    await startTestBridge(cleanups, base);
    await stopWebServer(first);

    expect(heldPort(await startTestBridge(cleanups, base))).toBe(base);
  });

  it("falls back to an operating-system port when every port of the range is taken", async () => {
    const base = testBridgePortBase();
    const range = bridgePortRange(base);
    for (const port of range) {
      if ((await holdPort(port)) === undefined) {
        throw new Error(`port ${String(port)} is taken`);
      }
    }

    const port = heldPort(await startTestBridge(cleanups, base));

    expect(range).not.toContain(port);
    expect(port).toBeGreaterThan(0);
  });

  it("binds an explicit port exactly, and refuses one that is taken instead of moving on", async () => {
    const explicit = await freeLocalPort();
    const controller = await startTestController();

    const handle = await createWebServer({
      port: explicit,
      bridgePortBase: testBridgePortBase(),
      existingController: controller,
    });
    cleanups.push(async () => stopWebServer(handle));
    expect(heldPort(handle)).toBe(explicit);

    await expect(
      createWebServer({
        port: explicit,
        bridgePortBase: testBridgePortBase(),
        existingController: controller,
      }),
    ).rejects.toThrow(new RegExp(`already in use.*${String(explicit)}`, "u"));
  });

  it("rejects with the bind error itself when it is not 'address in use', and does not walk on or fall back", async () => {
    await expectDocumentationAddressNotBindable();
    const controller = await startTestController();

    await expect(
      createWebServer({
        host: UNASSIGNED_ADDRESS,
        port: await freeLocalPort(),
        existingController: controller,
      }),
    ).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
    await expect(
      createWebServer({
        host: UNASSIGNED_ADDRESS,
        bridgePortBase: testBridgePortBase(),
        existingController: controller,
      }),
    ).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
  });
});

describe("a bridge port base", () => {
  it.each([
    ["a fraction", Math.PI * BRIDGE_PORT_BASE],
    ["not a number", Number.NaN],
    ["below the unprivileged ports", LOWEST_UNPRIVILEGED_PORT - 1],
    ["negative", -1],
    ["leaving the last port past the highest", HIGHEST_PORT],
  ])("is refused when it is %s", (_label, base) => {
    expect(() => bridgePortRange(base)).toThrow(InvalidBridgePortBaseError);
  });

  it("accepts the lowest and highest bases whose whole range fits", () => {
    expect(bridgePortRange(LOWEST_UNPRIVILEGED_PORT)[0]).toBe(
      LOWEST_UNPRIVILEGED_PORT,
    );
    expect(bridgePortRange(HIGHEST_PORT - BRIDGE_PORT_COUNT + 1).at(-1)).toBe(
      HIGHEST_PORT,
    );
  });

  it("is refused by a web server start before anything is bound, and the controller it created is shut down", async () => {
    const controller = await startTestController();
    const subscribed = controller.listenerCount("message");

    await expect(
      createWebServer({
        bridgePortBase: Math.PI * BRIDGE_PORT_BASE,
        existingController: controller,
      }),
    ).rejects.toBeInstanceOf(InvalidBridgePortBaseError);

    expect(controller.listenerCount("message")).toBe(subscribed);
  });
});

describe("a web server that fails to bind", () => {
  it("leaves nothing subscribed on a controller it was given", async () => {
    const taken = await holdPort(await freeLocalPort());
    const controller = await startTestController();
    const subscribed = controller.listenerCount("message");
    if (taken === undefined) throw new Error("expected to hold a port");

    await expect(
      createWebServer({
        port: addressPort(taken),
        existingController: controller,
      }),
    ).rejects.toThrow(/already in use/u);

    expect(controller.listenerCount("message")).toBe(subscribed);
  });

  it("shuts down the controller it created itself, releasing the ports its store held", async () => {
    const taken = await holdPort(await freeLocalPort());
    if (taken === undefined) throw new Error("expected to hold a port");
    const coordinatorPort = await freeLocalPort();

    await expect(
      createWebServer({
        port: addressPort(taken),
        coordinatorPort,
        firstContactPort: await freeLocalPort(),
        hubUrl: await unreachableHubUrl(),
      }),
    ).rejects.toThrow(/already in use/u);

    const coordinatorPortAgain = await holdPort(coordinatorPort);
    expect(coordinatorPortAgain).toBeDefined();
  });
});

describe("the dashboard's probe", () => {
  it("finds a running bridge in the range, and the first one when several run", async () => {
    const base = testBridgePortBase();
    const first = await startTestBridge(cleanups, base);
    const second = await startTestBridge(cleanups, base);

    expect(await findBridgePort(isBridgeAt, base)).toBe(heldPort(first));

    await stopWebServer(first);
    expect(await findBridgePort(isBridgeAt, base)).toBe(heldPort(second));
  });

  it("finds nothing when no bridge runs in the range", async () => {
    expect(
      await findBridgePort(isBridgeAt, testBridgePortBase()),
    ).toBeUndefined();
  });

  it("does not take a port that accepts and never answers, or another kind of server, for a bridge", async () => {
    const base = testBridgePortBase();
    const accepted: net.Socket[] = [];
    await holdPort(base, (socket) => {
      accepted.push(socket);
    });
    await holdForeignHttpServer(base + 1);

    expect(await isBridgeAt(base, { timeoutMs: SILENT_PROBE_TIMEOUT_MS })).toBe(
      false,
    );
    expect(accepted).toHaveLength(1);
    expect(
      await isBridgeAt(base + 1, { timeoutMs: SILENT_PROBE_TIMEOUT_MS }),
    ).toBe(false);
  });

  it("walks past a silent listener and a foreign server to the bridge behind them", async () => {
    const base = testBridgePortBase();
    await holdPort(base);
    await holdForeignHttpServer(base + 1);
    const bridge = await startTestBridge(cleanups, base + 2);
    const found: string[] = [];

    await probeForBridge(
      (meshUrl) => {
        found.push(meshUrl);
      },
      { base, timeoutMs: SILENT_PROBE_TIMEOUT_MS },
    );

    expect(heldPort(bridge)).toBe(base + 2);
    expect(found).toEqual([bridgeMeshUrl(base + 2)]);
  });

  it("calls nothing back when no bridge answers", async () => {
    const found: string[] = [];

    await probeForBridge(
      (meshUrl) => {
        found.push(meshUrl);
      },
      { base: testBridgePortBase(), timeoutMs: SILENT_PROBE_TIMEOUT_MS },
    );

    expect(found).toEqual([]);
  });
});
