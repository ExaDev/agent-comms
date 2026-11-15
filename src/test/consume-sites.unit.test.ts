/**
 * Each site that reads a stream a peer feeds hands consumeEach the right answer: a failing item is reported and the next is still read, and the loop ends exactly where the session ends. The sites are driven with fake sessions, since a site that answered the wrong step would pass every test of consumeEach itself.
 */

import { describe, expect, it } from "vitest";
import type {
  AcceptedMeshSession,
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import type { Connection } from "wire-mesh-core/ports/transport";
import { generateIdentity } from "../core/identity.js";
import { HubSession, type HubSessionDeps } from "../core/hub-session.js";
import { RelayServer } from "../core/relay-server.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";
import { FRAME_VERB, WireMeshTransport } from "../core/wire-mesh-transport.js";

const SETTLE_MS = 40;
const DEVICE_ID_BYTES = 32;
const DEVICE_HEX = "ab".repeat(DEVICE_ID_BYTES);
const HANDLE: ConnectionHandle = { id: DEVICE_HEX };
const SECOND = 2;

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

function eventsWith(
  overrides: Readonly<Partial<TransportEvents>>,
): TransportEvents {
  return {
    onMessage: () => undefined,
    onPeerConnected: () => undefined,
    onPeerDisconnected: () => undefined,
    onIntroduction: () => undefined,
    onConnectionRequest: () => undefined,
    onPeerList: () => undefined,
    onPeerJoined: () => undefined,
    onBecomeCoordinator: () => undefined,
    onRevocationAnnounce: () => undefined,
    onCoordinatorClaim: () => undefined,
    onElectionSessionEnrolled: () => undefined,
    onPresenceAdvert: () => undefined,
    onDeviceReachable: () => undefined,
    ...overrides,
  };
}

function transportWith(overrides: Readonly<Partial<TransportEvents>>): {
  transport: WireMeshTransport;
  errors: Error[];
} {
  const errors: Error[] = [];
  const transport = new WireMeshTransport(
    eventsWith({
      onError: (error) => {
        errors.push(error);
      },
      ...overrides,
    }),
    generateIdentity(),
  );
  return { transport, errors };
}

/** Calls a private method of the transport by name: the sites under test have no public entry point of their own. */
function callPrivate(
  transport: object,
  name: string,
  ...args: readonly unknown[]
): unknown {
  const method: unknown = Reflect.get(transport, name);
  if (typeof method !== "function") throw new Error(`no method ${name}`);
  return Reflect.apply(method, transport, args);
}

function session(streams: Readonly<Record<string, readonly unknown[]>>): {
  session: AcceptedMeshSession;
  closed: () => number;
} {
  let closes = 0;
  const fake: Record<string, unknown> = {
    close: async () => {
      closes += 1;
      return Promise.resolve();
    },
    coordinatorFrames: (async function* () {
      yield* [];
    })(),
  };
  for (const [name, items] of Object.entries(streams)) {
    fake[name] = (async function* () {
      yield* items;
    })();
  }
  return {
    session: fake as unknown as AcceptedMeshSession,
    closed: () => closes,
  };
}

function manageRequest(message: unknown): {
  request: IncomingManageRequest;
  responses: ManageOutcome[];
} {
  const responses: ManageOutcome[] = [];
  return {
    responses,
    request: {
      requestId: 1,
      command: { verb: FRAME_VERB, params: { message } },
      scope: { kind: "agent-comms-mesh" },
      respond: async (outcome: ManageOutcome) => {
        responses.push(outcome);
      },
    },
  };
}

describe("the revocation announcements of a session", () => {
  it("reports an entry that cannot be handled and still hands over the next", async () => {
    const seen: unknown[] = [];
    const { transport, errors } = transportWith({
      onRevocationAnnounce: (entry) => {
        seen.push(entry);
        if (seen.length === 1) throw new Error("entry failed");
      },
    });
    const { session: fake } = session({
      revocationAnnouncements: ["first", "second", "third"],
      incomingManageRequests: [],
    });

    callPrivate(transport, "consumeIncoming", fake, HANDLE, false);
    await settle();

    expect(seen).toEqual(["first", "second", "third"]);
    expect(errors.map((e) => e.message)).toEqual(["entry failed"]);
  });
});

describe("the events of a session watched for its end", () => {
  it("reports an event that cannot be handled, ends on the closed event, and reads nothing after it", async () => {
    const left: string[] = [];
    const { transport, errors } = transportWith({
      onPeerDisconnected: (handle) => {
        left.push(handle.id);
      },
    });
    const { session: fake } = session({
      events: [
        { directory: undefined, state: { status: "open" } },
        { directory: [], state: { status: "closed" } },
        { directory: undefined, state: { status: "open" } },
      ],
    });
    const peers: unknown = Reflect.get(transport, "peerSessions");
    if (!(peers instanceof Map)) throw new Error("no peerSessions");
    peers.set(DEVICE_HEX, fake);

    callPrivate(transport, "watchForDisconnect", fake, HANDLE, DEVICE_HEX);
    await settle();

    expect(left).toEqual([DEVICE_HEX]);
    // Only the first event failed: the one after the closed event was never read.
    expect(errors).toHaveLength(1);
  });
});

describe("the requests of a session that is not yet trusted", () => {
  it("ends the loop, after answering and closing, on a request that is neither introduce nor connect_request", async () => {
    const { transport } = transportWith({});
    const refused = manageRequest({ method: "peer_left", peerId: "x" });
    const next = manageRequest({ method: "peer_left", peerId: "y" });
    const { session: fake, closed } = session({
      incomingManageRequests: [refused.request, next.request],
    });

    callPrivate(transport, "consumeQuarantined", fake, HANDLE, false);
    await settle();

    expect(refused.responses).toEqual([
      { result: "error", code: "not_approved" },
    ]);
    expect(closed()).toBe(1);
    expect(next.responses).toEqual([]);
  });

  it("carries approval across requests: after an introduce, a later request is routed and not refused", async () => {
    const introduced: string[] = [];
    const { transport } = transportWith({
      onIntroduction: (handle) => {
        introduced.push(handle.id);
      },
      onMessage: () => undefined,
    });
    const introduce = manageRequest({
      method: "introduce",
      peerId: DEVICE_HEX,
      dataPort: 1,
    });
    const later = manageRequest({ method: "peer_left", peerId: "y" });
    const { session: fake, closed } = session({
      incomingManageRequests: [introduce.request, later.request],
    });

    callPrivate(transport, "consumeQuarantined", fake, HANDLE, false);
    await settle();

    expect(introduced).toEqual([DEVICE_HEX]);
    expect(introduce.responses).toEqual([{ result: "ok" }]);
    expect(later.responses).toEqual([{ result: "ok" }]);
    expect(closed()).toBe(0);
  });

  it("ends the loop after a connect_request that is rejected, closing the session", async () => {
    const { transport } = transportWith({});
    const connect = manageRequest({
      method: "connect_request",
      peerId: DEVICE_HEX,
      dataPort: 1,
      name: "n",
      fingerprint: "f",
    });
    const next = manageRequest({ method: "peer_left", peerId: "y" });
    const { session: fake, closed } = session({
      incomingManageRequests: [connect.request, next.request],
    });

    callPrivate(transport, "consumeQuarantined", fake, HANDLE, false);
    await settle();
    await transport.rejectConnection(HANDLE, "no");
    await settle();

    expect(connect.responses).toEqual([
      { result: "error", code: "rejected", message: "no" },
    ]);
    expect(closed()).toBe(1);
    expect(next.responses).toEqual([]);
  });

  it("reads on after a request whose handling fails", async () => {
    const { transport, errors } = transportWith({
      onIntroduction: () => {
        throw new Error("introduction failed");
      },
    });
    const introduce = manageRequest({
      method: "introduce",
      peerId: DEVICE_HEX,
      dataPort: 1,
    });
    const afterFailure = manageRequest({ method: "peer_left", peerId: "y" });
    const { session: fake } = session({
      incomingManageRequests: [introduce.request, afterFailure.request],
    });

    callPrivate(transport, "consumeQuarantined", fake, HANDLE, false);
    await settle();

    expect(errors.map((e) => e.message)).toEqual(["introduction failed"]);
    // The failed introduce never set approval, so the next request is a protocol violation, answered and not lost.
    expect(afterFailure.responses).toEqual([
      { result: "error", code: "not_approved" },
    ]);
  });
});

describe("the events of a hub session", () => {
  const ENTRY = { device: new Uint8Array(DEVICE_ID_BYTES).fill(1) };

  function hubWith(admit: HubSessionDeps["admitEntries"]): {
    hub: HubSession;
    merged: number[];
    errors: Error[];
  } {
    const merged: number[] = [];
    const errors: Error[] = [];
    const deps = {
      events: eventsWith({
        onError: (error) => {
          errors.push(error);
        },
      }),
      isShuttingDown: () => false,
      admitEntries: admit,
      onDirectory: (entries: readonly unknown[]) => {
        merged.push(entries.length);
      },
    } as unknown as HubSessionDeps;
    return { hub: new HubSession(deps), merged, errors };
  }

  async function consume(hub: HubSession, events: readonly unknown[]) {
    const { session: fake } = session({ events });
    await (callPrivate(hub, "consumeEvents", fake, "00") as Promise<void>);
  }

  it("reports an event whose directory cannot be admitted and still merges the next, ending on the closed event and reading nothing after it", async () => {
    let calls = 0;
    const { hub, merged, errors } = hubWith(async (entries) => {
      calls += 1;
      if (calls === 1) throw new Error("admit failed");
      return Promise.resolve([...entries]);
    });

    await consume(hub, [
      { directory: [ENTRY], state: { status: "open" } },
      { directory: [ENTRY], state: { status: "closed" } },
      { directory: [ENTRY], state: { status: "open" } },
    ]);

    expect(errors.map((e) => e.message)).toEqual(["admit failed"]);
    expect(merged).toEqual([1]);
    expect(calls).toBe(SECOND);
  });
});

describe("the frames of a relay connection", () => {
  function fakeConnection(frames: readonly unknown[]): {
    connection: Connection;
    closed: () => number;
  } {
    let closes = 0;
    const connection = {
      receive: () =>
        (async function* () {
          yield* frames;
        })(),
      send: async () => Promise.resolve(),
      close: async () => {
        closes += 1;
        return Promise.resolve();
      },
    } as unknown as Connection;
    return { connection, closed: () => closes };
  }

  async function serve(
    server: RelayServer,
    connection: Connection,
  ): Promise<void> {
    const method: unknown = Reflect.get(server, "serve");
    if (typeof method !== "function") throw new Error("no serve");
    return Reflect.apply(method, server, [
      connection,
      () => undefined,
    ]) as Promise<void>;
  }

  const GOSSIP = { type: "gossip", peers: [{ device: new Uint8Array(1) }] };

  it("reports a frame that cannot be handled and still reads the frames after it", async () => {
    const errors: Error[] = [];
    let calls = 0;
    const server = new RelayServer({
      host: "127.0.0.1",
      isAdmitted: () => {
        calls += 1;
        if (calls === 1) throw new Error("frame failed");
        return false;
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    const { connection } = fakeConnection([GOSSIP, GOSSIP]);

    await serve(server, connection);

    expect(calls).toBe(SECOND);
    expect(errors.map((e) => e.message)).toEqual(["frame failed"]);
  });

  it("closes the connection when its stream ends", async () => {
    const server = new RelayServer({
      host: "127.0.0.1",
      isAdmitted: () => false,
      onError: () => undefined,
    });
    const { connection, closed } = fakeConnection([]);

    await serve(server, connection);

    expect(closed()).toBe(1);
  });
});
