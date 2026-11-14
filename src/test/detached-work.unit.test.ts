/**
 * Work a peer's messages start and nothing awaits never ends the process by rejecting: it is reported through the error handler, or to stderr when there is none, and a failure while handling one peer request answers that request with an error and leaves the loop reading the next one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import type { AcceptedMeshSession } from "wire-mesh-core/domain/mesh-session";
import { consumeEach, reportRejection } from "../core/detached-work.js";
import { createTransportEvents } from "../core/transport-events.js";
import type { TransportEventTargets } from "../core/transport-events.js";
import { createRoomRouter } from "../core/room-router.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";
import { ElectionSessions } from "../core/election-sessions.js";

const DEVICE_ID_HEX_LENGTH = 64;
const HANDLE: ConnectionHandle = { id: "a".repeat(DEVICE_ID_HEX_LENGTH) };
const SETTLE_MS = 20;

const unhandled: unknown[] = [];
function record(reason: unknown): void {
  unhandled.push(reason);
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", record);
});

afterEach(async () => {
  await settle();
  process.off("unhandledRejection", record);
  vi.restoreAllMocks();
  expect(unhandled).toEqual([]);
});

describe("reportRejection", () => {
  it("passes a rejection to the handler returned when it settles, not when the work started", async () => {
    const seen: Error[] = [];
    const late: { handler?: (error: Error) => void } = {};

    reportRejection(Promise.reject(new Error("boom")), () => late.handler);
    late.handler = (error) => {
      seen.push(error);
    };
    await settle();

    expect(seen.map((e) => e.message)).toEqual(["boom"]);
  });

  it("writes to stderr when there is no handler", async () => {
    const written = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    reportRejection(Promise.reject(new Error("text")), () => undefined);
    await settle();

    expect(String(written.mock.calls[0]?.[0])).toContain("text");
  });
});

describe("the transport events a peer drives", () => {
  const failure = new Error("handler failed");
  const rejects = vi.fn(async () => Promise.reject(failure));
  const reportError = vi.fn();
  const events = createTransportEvents({
    peerLifecycle: {
      handleDataMessage: rejects,
      handlePeerConnected: rejects,
      handleIntroduction: rejects,
    },
    deliveryEngine: { handleRevocationAnnounce: rejects },
    roomProtocol: { flushPendingRoomRequests: rejects },
    reportError,
  } as unknown as TransportEventTargets);

  const FIRES: readonly (readonly [string, () => void])[] = [
    [
      "onMessage",
      () => {
        events.onMessage(HANDLE, { method: "peer_list", peers: [] });
      },
    ],
    [
      "onPeerConnected",
      () => {
        events.onPeerConnected(HANDLE, { id: "p", port: 1, startedAt: "" });
      },
    ],
    [
      "onIntroduction",
      () => {
        events.onIntroduction(HANDLE, { peerId: "p", dataPort: 1 });
      },
    ],
    [
      "onRevocationAnnounce",
      () => {
        events.onRevocationAnnounce({} as never);
      },
    ],
    [
      "onDeviceReachable",
      () => {
        events.onDeviceReachable("a");
      },
    ],
  ];

  it.each(FIRES)(
    "%s reports a failing handler through the store",
    async (_name, fire) => {
      reportError.mockClear();

      fire();
      await settle();

      expect(reportError).toHaveBeenCalledWith(failure);
    },
  );
});

function fakeEvents(onError: (error: Error) => void): TransportEvents {
  const noop = (): void => undefined;
  return {
    onMessage: noop,
    onIntroduction: noop,
    onConnectionRequest: noop,
    onPeerConnected: noop,
    onPeerDisconnected: noop,
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

function roomRequest(verb = "room.send"): {
  request: IncomingManageRequest;
  responses: ManageOutcome[];
} {
  const responses: ManageOutcome[] = [];
  return {
    responses,
    request: {
      requestId: 1,
      command: { verb: "room:member", params: { verb } },
      scope: { kind: "room" },
      respond: async (outcome: ManageOutcome) => {
        responses.push(outcome);
      },
    },
  };
}

describe("the room router", () => {
  it("answers a request whose handler throws with an error, reports it, and goes on to the next request", async () => {
    const errors: Error[] = [];
    let calls = 0;
    const router = createRoomRouter({
      events: fakeEvents((e) => {
        errors.push(e);
      }),
      handlers: {
        "room.send": async () => {
          calls += 1;
          if (calls === 1) throw new Error("handler failed");
          return Promise.resolve({ result: "ok" } as const);
        },
      },
    });
    const first = roomRequest();
    const second = roomRequest();
    const session = {
      incomingManageRequests: (async function* () {
        yield first.request;
        yield second.request;
      })(),
    } as unknown as AcceptedMeshSession;

    router.drainSession(session, HANDLE);
    await settle();

    expect(first.responses).toEqual([
      { result: "error", code: "internal_error" },
    ]);
    expect(second.responses).toEqual([{ result: "ok" }]);
    expect(errors.map((e) => e.message)).toEqual(["handler failed"]);
  });

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "answers a verb named %s, a member of every object and no handler, as unsupported",
    async (verb) => {
      const errors: Error[] = [];
      const router = createRoomRouter({
        events: fakeEvents((e) => {
          errors.push(e);
        }),
        handlers: {},
      });
      const sent = roomRequest(verb);
      const session = {
        incomingManageRequests: (async function* () {
          yield sent.request;
        })(),
      } as unknown as AcceptedMeshSession;

      router.drainSession(session, HANDLE);
      await settle();

      expect(sent.responses).toEqual([
        { result: "error", code: "unsupported_verb" },
      ]);
      expect(errors).toEqual([]);
    },
  );

  it("reports a session whose request stream itself fails", async () => {
    const errors: Error[] = [];
    const router = createRoomRouter({
      events: fakeEvents((e) => {
        errors.push(e);
      }),
    });
    const session = {
      incomingManageRequests: (async function* () {
        yield* [];
        throw new Error("stream failed");
      })(),
    } as unknown as AcceptedMeshSession;

    router.drainSession(session, HANDLE);
    await settle();

    expect(errors.map((e) => e.message)).toEqual(["stream failed"]);
  });
});

describe("the election session watch", () => {
  it("reports a coordinator frame stream that fails", async () => {
    const errors: Error[] = [];
    const sessions = new ElectionSessions({
      onCoordinatorClaim: () => undefined,
      onElectionSessionEnrolled: () => undefined,
      onError: (e) => {
        errors.push(e);
      },
    });
    const session = {
      coordinatorFrames: (async function* () {
        yield* [];
        throw new Error("frames failed");
      })(),
    } as unknown as AcceptedMeshSession;

    sessions.watch(session, HANDLE);
    await settle();

    expect(errors.map((e) => e.message)).toEqual(["frames failed"]);
  });
});

const FIRST_ITEM = 1;
const FAILING_ITEM = 2;
const LAST_ITEM = 3;
const ITEMS = [FIRST_ITEM, FAILING_ITEM, LAST_ITEM];

describe("a failure on one item of a consumed stream", () => {
  it("is reported and the items after it are still handled", async () => {
    const errors: Error[] = [];
    const handled: number[] = [];

    await consumeEach(
      (async function* () {
        yield* ITEMS;
      })(),
      (item) => {
        if (item === FAILING_ITEM) throw new Error("item failed");
        handled.push(item);
      },
      () => (error) => {
        errors.push(error);
      },
    );

    expect(handled).toEqual(ITEMS.filter((item) => item !== FAILING_ITEM));
    expect(errors.map((e) => e.message)).toEqual(["item failed"]);
  });

  it("is reported when the handler rejects asynchronously, and the order of handling is the order of arrival", async () => {
    const errors: Error[] = [];
    const order: number[] = [];

    await consumeEach(
      (async function* () {
        yield* [1, 2];
      })(),
      async (item) => {
        await settle();
        order.push(item);
        if (item === 1) throw new Error("first failed");
      },
      () => (error) => {
        errors.push(error);
      },
    );

    expect(order).toEqual([1, 2]);
    expect(errors.map((e) => e.message)).toEqual(["first failed"]);
  });

  it("ends, reported and without rejecting, when the stream itself fails", async () => {
    const errors: Error[] = [];

    await consumeEach(
      (async function* () {
        yield 1;
        throw new Error("stream failed");
      })(),
      () => undefined,
      () => (error) => {
        errors.push(error);
      },
    );

    expect(errors.map((e) => e.message)).toEqual(["stream failed"]);
  });
});

describe("the election session watch past a failing claim", () => {
  it("reports a claim whose handler throws and still hands over the claims after it", async () => {
    const errors: Error[] = [];
    const handed: string[] = [];
    const sessions = new ElectionSessions({
      onCoordinatorClaim: (_handle, frame) => {
        handed.push(JSON.stringify(frame));
        if (handed.length === 1) throw new Error("claim failed");
      },
      onElectionSessionEnrolled: () => undefined,
      onError: (e) => {
        errors.push(e);
      },
    });
    const claims = [{ n: 1 }, { n: 2 }];
    const session = {
      coordinatorFrames: (async function* () {
        yield* claims;
      })(),
    } as unknown as AcceptedMeshSession;
    sessions.enrol(session, HANDLE);

    sessions.watch(session, HANDLE);
    await settle();

    expect(handed).toHaveLength(claims.length);
    expect(errors.map((e) => e.message)).toEqual(["claim failed"]);
  });
});
