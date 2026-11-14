/**
 * A connection whose handling fails after a listener accepted it is reported through the transport's error handler and never ends the process as an unhandled rejection.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTlsTransport } from "wire-mesh-core/adapters/tls-transport";
import { generateIdentity } from "../core/identity.js";
import type { TransportEvents } from "../core/transport.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";

const SETTLE_MS = 300;
const unhandled: unknown[] = [];
function record(reason: unknown): void {
  unhandled.push(reason);
}

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", record);
});

afterEach(() => {
  process.off("unhandledRejection", record);
  vi.restoreAllMocks();
});

function events(onError: (error: Error) => void): TransportEvents {
  const noop = (): void => undefined;
  return {
    onMessage: noop,
    onPeerConnected: noop,
    onPeerDisconnected: noop,
    onIntroduction: noop,
    onConnectionRequest: noop,
    onPeerList: noop,
    onPeerJoined: noop,
    onBecomeCoordinator: noop,
    onError,
    onRevocationAnnounce: noop,
    onCoordinatorClaim: noop,
    onElectionSessionEnrolled: noop,
    onPresenceAdvert: noop,
    onDeviceReachable: noop,
  };
}

it("reports a failure while handling an accepted connection instead of leaving it unhandled", async () => {
  const errors: Error[] = [];
  const failure = new Error("handling the connection failed");
  vi.spyOn(
    WireMeshTransport.prototype as unknown as {
      handleAcceptedConnection: () => Promise<void>;
    },
    "handleAcceptedConnection",
  ).mockRejectedValue(failure);
  const transport = new WireMeshTransport(
    events((error) => {
      errors.push(error);
    }),
    generateIdentity(),
  );
  try {
    await transport.becomeCoordinator("127.0.0.1", 0);
    const [listener] = transport.listListeners();
    if (listener === undefined) throw new Error("no listener");
    const probe = generateIdentity();
    const connection = await createTlsTransport({
      certificatePem: probe.certificate,
      privateKeyPem: probe.privateKey,
    }).connect(`127.0.0.1:${String(listener.port)}`);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
    await connection.close();

    expect(errors).toEqual([failure]);
    expect(unhandled).toEqual([]);
  } finally {
    await transport.shutdown();
  }
});
