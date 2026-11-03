/**
 * Unit tests for MdnsDiscoveryBackend's socket ownership (agent-comms#476): however its advertise and discover calls interleave, and whatever its socket reports, the backend holds at most one open UDP socket and closes it once nothing uses it. Real dgram sockets on an OS-assigned port, created through the backend's own socket factory seam so each test can count what was opened and closed.
 */
import * as dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { MdnsDiscoveryBackend } from "../core/discovery-mdns.js";
import { freeLocalPort } from "./hub-helpers.js";

/** A discover() window short enough to keep the suite fast; the tests count sockets, not beacons heard. */
const DISCOVER_TIMEOUT_MS = 50;

const ADVERTISE_OPTIONS = { name: "mesh-under-test", port: 41000 };

interface SocketLedger {
  created: dgram.Socket[];
  open: () => number;
}

/** A socket factory recording every socket the backend creates and which of them are still open (a socket is closed once it has emitted "close"). */
function recordingFactory(): {
  createSocket: (options: dgram.SocketOptions) => dgram.Socket;
  ledger: SocketLedger;
} {
  const created: dgram.Socket[] = [];
  const closed = new Set<dgram.Socket>();
  return {
    createSocket: (options) => {
      const socket = dgram.createSocket(options);
      socket.on("close", () => {
        closed.add(socket);
      });
      created.push(socket);
      return socket;
    },
    ledger: {
      created,
      open: () => created.filter((socket) => !closed.has(socket)).length,
    },
  };
}

const backends: MdnsDiscoveryBackend[] = [];
const blockers: dgram.Socket[] = [];

async function backendUnderTest(port?: number): Promise<{
  backend: MdnsDiscoveryBackend;
  ledger: SocketLedger;
}> {
  const { createSocket, ledger } = recordingFactory();
  const backend = new MdnsDiscoveryBackend({
    port: port ?? (await freeLocalPort()),
    createSocket,
  });
  backends.push(backend);
  return { backend, ledger };
}

/** Lets a socket's asynchronous close callback run, so the ledger reflects it. */
async function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.stop();
  for (const blocker of blockers.splice(0)) blocker.close();
});

describe("MdnsDiscoveryBackend socket ownership", () => {
  it("binds exactly one socket for concurrent advertise calls", async () => {
    const { backend, ledger } = await backendUnderTest();

    await Promise.all([
      backend.startAdvertising(ADVERTISE_OPTIONS),
      backend.startAdvertising(ADVERTISE_OPTIONS),
    ]);

    expect(ledger.created).toHaveLength(1);
    expect(ledger.open()).toBe(1);
  });

  it("binds exactly one socket for concurrent discover calls, and closes it once both finish", async () => {
    const { backend, ledger } = await backendUnderTest();

    await Promise.all([
      backend.discover(DISCOVER_TIMEOUT_MS),
      backend.discover(DISCOVER_TIMEOUT_MS),
    ]);
    await settle();

    expect(ledger.created).toHaveLength(1);
    expect(ledger.open()).toBe(0);
  });

  it("keeps one socket open when a discover starts while an advertisement is binding", async () => {
    const { backend, ledger } = await backendUnderTest();

    await Promise.all([
      backend.startAdvertising(ADVERTISE_OPTIONS),
      backend.discover(DISCOVER_TIMEOUT_MS),
    ]);
    await settle();

    expect(ledger.created).toHaveLength(1);
    expect(ledger.open()).toBe(1);
  });

  it("does not bind a second socket after its socket reports an error", async () => {
    const { backend, ledger } = await backendUnderTest();
    await backend.startAdvertising(ADVERTISE_OPTIONS);
    const [socket] = ledger.created;
    if (socket === undefined) throw new Error("expected a bound socket");

    socket.emit("error", new Error("simulated socket error"));
    await backend.startAdvertising(ADVERTISE_OPTIONS);
    await backend.discover(DISCOVER_TIMEOUT_MS);
    await settle();

    expect(ledger.open()).toBe(1);
  });

  it("rejects a failed bind and leaves no socket open, so a later call can bind afresh", async () => {
    const port = await freeLocalPort();
    // A socket holding the port without address reuse makes the backend's own reuseAddr bind fail with EADDRINUSE.
    const blocker = dgram.createSocket({ type: "udp4" });
    blockers.push(blocker);
    await new Promise<void>((resolve) => {
      blocker.bind(port, resolve);
    });
    const { backend, ledger } = await backendUnderTest(port);

    await expect(
      backend.startAdvertising(ADVERTISE_OPTIONS),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    await settle();
    expect(ledger.open()).toBe(0);

    blockers.splice(0);
    await new Promise<void>((resolve) => {
      blocker.close(resolve);
    });
    await backend.startAdvertising(ADVERTISE_OPTIONS);
    expect(ledger.open()).toBe(1);
  });

  it("closes its socket on stop() even when stop() arrives while the socket is still binding", async () => {
    const { backend, ledger } = await backendUnderTest();

    const advertising = backend.startAdvertising(ADVERTISE_OPTIONS);
    await backend.stop();
    await advertising;
    await settle();

    expect(ledger.open()).toBe(0);
  });
});
