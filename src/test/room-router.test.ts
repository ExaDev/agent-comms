import { describe, it, vi, expect } from "vitest";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import { FRAME_VERB, buildCommand } from "../core/wire-mesh-transport.js";
import { createRoomRouter } from "../core/room-router.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";

const TEST_HANDLE: ConnectionHandle = { id: "a".repeat(64) };

function fakeEvents(): TransportEvents {
  return {
    onMessage: vi.fn(),
    onIntroduction: vi.fn(),
    onConnectionRequest: vi.fn(),
    onPeerConnected: vi.fn(),
    onPeerDisconnected: vi.fn(),
    onPeerList: vi.fn(),
    onPeerJoined: vi.fn(),
    onBecomeCoordinator: vi.fn(),
    onError: vi.fn(),
    onRevocationAnnounce: vi.fn(),
    onPresenceAdvert: vi.fn(),
  };
}

function fakeRequest(
  command: IncomingManageRequest["command"],
  token?: IncomingManageRequest["token"],
): { request: IncomingManageRequest; responses: ManageOutcome[] } {
  const responses: ManageOutcome[] = [];
  const request: IncomingManageRequest = {
    requestId: 1,
    command,
    scope: { kind: "room" },
    ...(token !== undefined ? { token } : {}),
    respond: async (outcome: ManageOutcome): Promise<void> => {
      responses.push(outcome);
    },
  };
  return { request, responses };
}

describe("createRoomRouter", () => {
  it("routes a legacy FRAME_VERB command to events.onMessage", async () => {
    const events = fakeEvents();
    const router = createRoomRouter({ events });
    const { request, responses } = fakeRequest(
      buildCommand({ method: "peer_list", peers: [] }),
    );

    await router.handleRequest(request, TEST_HANDLE);

    expect(
      (events.onPeerList as unknown as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBe(1);
    expect(responses).toEqual([{ result: "ok" }]);
  });

  it("routes an otherwise-well-formed FRAME_VERB payload with no recognised case to the onMessage catch-all", async () => {
    const events = fakeEvents();
    const router = createRoomRouter({ events });
    // A wire payload shaped like a MeshMessage but naming a method no case in routeLegacyMessage's switch recognises -- e.g. from a peer running a newer build. isMeshMessage's own runtime check only requires a string method field, deliberately looser than the closed MeshMessage type, so this constructs the command directly rather than through buildCommand (which requires a real MeshMessage at compile time).
    const { request, responses } = fakeRequest({
      verb: FRAME_VERB,
      params: { message: { method: "not-a-real-method" } },
    });

    await router.handleRequest(request, TEST_HANDLE);

    expect(
      (events.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBe(1);
    expect(responses).toEqual([{ result: "ok" }]);
  });

  it("responds ok without routing anything for a FRAME_VERB payload with no message field at all", async () => {
    const events = fakeEvents();
    const router = createRoomRouter({ events });
    const { request, responses } = fakeRequest({
      verb: FRAME_VERB,
      params: {},
    });

    await router.handleRequest(request, TEST_HANDLE);

    expect(
      (events.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBe(0);
    expect(responses).toEqual([{ result: "ok" }]);
  });

  it("dispatches a registered room verb to its own handler", async () => {
    const events = fakeEvents();
    const handled: unknown[] = [];
    const router = createRoomRouter({
      events,
      handlers: {
        "room.send": async (request) => {
          handled.push(request.command.params);
          return { result: "ok" };
        },
      },
    });
    const { request, responses } = fakeRequest({
      verb: "room:member",
      params: { verb: "room.send", text: "hi" },
    });

    await router.handleRequest(request, TEST_HANDLE);

    expect(handled).toEqual([{ verb: "room.send", text: "hi" }]);
    expect(responses).toEqual([{ result: "ok" }]);
  });

  it("refuses an unregistered room verb with unsupported_verb", async () => {
    const events = fakeEvents();
    const router = createRoomRouter({ events });
    const { request, responses } = fakeRequest({
      verb: "room:member",
      params: { verb: "room.send", text: "hi" },
    });

    await router.handleRequest(request, TEST_HANDLE);

    expect(responses.length).toBe(1);
    expect(responses[0]).toEqual({
      result: "error",
      code: "unsupported_verb",
    });
  });

  it("refuses a verb this domain has never heard of with unsupported_verb", async () => {
    const events = fakeEvents();
    const router = createRoomRouter({ events });
    const { request, responses } = fakeRequest({
      verb: "exec:pty",
      params: { verb: "exec.list" },
    });

    await router.handleRequest(request, TEST_HANDLE);

    expect(responses).toEqual([{ result: "error", code: "unsupported_verb" }]);
  });

  it("refuses a params object with no verb field at all", async () => {
    const events = fakeEvents();
    const router = createRoomRouter({ events });
    const { request, responses } = fakeRequest({
      verb: "room:member",
      params: {},
    });

    await router.handleRequest(request, TEST_HANDLE);

    expect(responses).toEqual([{ result: "error", code: "unsupported_verb" }]);
  });
});
