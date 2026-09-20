import { describe, it, vi, expect } from "vitest";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import { FRAME_VERB, buildCommand } from "../core/wire-mesh-transport.js";
import { createRoomRouter } from "../core/room-router.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";

// Matches the real 32-byte device-id's hex encoding length.
const DEVICE_ID_HEX_LENGTH = 64;
const TEST_HANDLE: ConnectionHandle = { id: "a".repeat(DEVICE_ID_HEX_LENGTH) };

function fakeEvents(): TransportEvents {
  return {
    onMessage: vi.fn<() => void>(),
    onIntroduction: vi.fn<() => void>(),
    onConnectionRequest: vi.fn<() => void>(),
    onPeerConnected: vi.fn<() => void>(),
    onPeerDisconnected: vi.fn<() => void>(),
    onPeerList: vi.fn<() => void>(),
    onPeerJoined: vi.fn<() => void>(),
    onBecomeCoordinator: vi.fn<() => void>(),
    onError: vi.fn<() => void>(),
    onRevocationAnnounce: vi.fn<() => void>(),
    onPresenceAdvert: vi.fn<() => void>(),
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

    await router.handleLocalRequest(request, TEST_HANDLE);

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

    await router.handleLocalRequest(request, TEST_HANDLE);

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

    await router.handleLocalRequest(request, TEST_HANDLE);

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

    await router.handleLocalRequest(request, TEST_HANDLE);

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

    await router.handleLocalRequest(request, TEST_HANDLE);

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

    await router.handleLocalRequest(request, TEST_HANDLE);

    expect(responses).toEqual([{ result: "error", code: "unsupported_verb" }]);
  });

  it("refuses a params object with no verb field at all", async () => {
    const events = fakeEvents();
    const router = createRoomRouter({ events });
    const { request, responses } = fakeRequest({
      verb: "room:member",
      params: {},
    });

    await router.handleLocalRequest(request, TEST_HANDLE);

    expect(responses).toEqual([{ result: "error", code: "unsupported_verb" }]);
  });

  it("passes the given origin through to the registered handler (agent-comms#216)", async () => {
    const events = fakeEvents();
    const receivedOrigins: unknown[] = [];
    const router = createRoomRouter({
      events,
      handlers: {
        "room.send": async (_request, _handle, origin) => {
          receivedOrigins.push(origin);
          return { result: "ok" };
        },
      },
    });
    const { request } = fakeRequest({
      verb: "room:member",
      params: { verb: "room.send", text: "hi" },
    });

    await router.handleLocalRequest(request, TEST_HANDLE, {
      relayHubAddress: "wss://hub.example/",
    });

    expect(receivedOrigins).toEqual([
      { relayHubAddress: "wss://hub.example/" },
    ]);
  });

  it("defaults origin to an empty object when the caller supplies none (agent-comms#216)", async () => {
    const events = fakeEvents();
    const receivedOrigins: unknown[] = [];
    const router = createRoomRouter({
      events,
      handlers: {
        "room.send": async (_request, _handle, origin) => {
          receivedOrigins.push(origin);
          return { result: "ok" };
        },
      },
    });
    const { request } = fakeRequest({
      verb: "room:member",
      params: { verb: "room.send", text: "hi" },
    });

    await router.handleLocalRequest(request, TEST_HANDLE);

    expect(receivedOrigins).toEqual([{}]);
  });

  it("dispatches a registered room verb from a relayed request to its own handler", async () => {
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

    await router.handleRelayedRequest(request, TEST_HANDLE);

    expect(handled).toEqual([{ verb: "room.send", text: "hi" }]);
    expect(responses).toEqual([{ result: "ok" }]);
  });

  it.each([
    {
      label: "state_update",
      message: {
        method: "state_update",
        patch: { type: "agent_offline", agentId: "spoofed" },
      },
    },
    { label: "peer_list", message: { method: "peer_list", peers: [] } },
    {
      label: "an unrecognised method",
      message: { method: "not-a-real-method" },
    },
  ])(
    "refuses a relayed FRAME_VERB carrying $label with unsupported_verb and reaches no TransportEvents callback",
    async ({ message }) => {
      const events = fakeEvents();
      const router = createRoomRouter({ events });
      const { request, responses } = fakeRequest({
        verb: FRAME_VERB,
        params: { message },
      });

      await router.handleRelayedRequest(request, TEST_HANDLE);

      expect(responses).toEqual([
        { result: "error", code: "unsupported_verb" },
      ]);
      for (const callback of Object.values(events)) {
        expect(callback).not.toHaveBeenCalled();
      }
    },
  );

  it("refuses a relayed FRAME_VERB even when its params also name a registered room verb", async () => {
    const handler = vi.fn().mockResolvedValue({ result: "ok" });
    const router = createRoomRouter({
      events: fakeEvents(),
      handlers: { "room.send": handler },
    });
    const { request, responses } = fakeRequest({
      verb: FRAME_VERB,
      params: {
        verb: "room.send",
        message: { method: "peer_list", peers: [] },
      },
    });

    await router.handleRelayedRequest(request, TEST_HANDLE);

    expect(responses).toEqual([{ result: "error", code: "unsupported_verb" }]);
    expect(handler).not.toHaveBeenCalled();
  });
});
