/**
 * Unit tests for dispatchHubRequest (agent-comms#192): the per-request trust decision hub-session.ts's own consume() loop delegates to, exercised directly against fake requests and fake deps rather than a real hub connection, mirroring hub-forwarding.test.ts's own fake-object approach for the sibling gateway-trust gates. hub-mode-session.integration.test.ts already proves the legacy FRAME_VERB gate end to end over a real hub; this file is what actually exercises the fix itself, that a real room-domain verb (room.send, room.join, room.notify, ...) is no longer rejected by the coarse per-device isTrusted allowlist at all, and the edge case that gate's removal would otherwise expose: a request with no fromDevice at all still has to be refused before ever reaching a room-verb handler, since resolveHandle/verifyRoomToken would call deviceIdFromHex on a non-hex placeholder and throw synchronously rather than answering with an ordinary unauthorized outcome.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import type {
  CapabilityScope,
  DeviceId,
} from "wire-mesh-core/generated/protocol";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { dispatchHubRequest } from "../core/hub-session.js";
import type { HubRequestDispatchDeps } from "../core/hub-session.js";
import { FRAME_VERB } from "../core/wire-mesh-transport.js";
import type { ConnectionHandle, TransportEvents } from "../core/transport.js";
import type { MeshMessage } from "../core/wire-protocol.js";

const DEVICE_ID_HEX_LENGTH = 64;
const SENDER_HEX = "a".repeat(DEVICE_ID_HEX_LENGTH);

function deviceIdBytes(hex: string): DeviceId {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  // A fixture device-id: the real DeviceId type wire-mesh-core mints only through its own deviceIdFromHex/generateIdentity is structurally just a Uint8Array of the right length, and every dispatchHubRequest call site only ever round-trips this value back through deviceIdToHex, so a plain byte array is a faithful stand-in for a test fixture with no cast needed.
  return bytes;
}

function fakeOnKnownPeer(): ReturnType<
  typeof vi.fn<(deviceHex: string) => void>
> {
  return vi.fn<(deviceHex: string) => void>();
}

function noopEvents(): TransportEvents {
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
    onPresenceAdvert: () => undefined,
    onDeviceReachable: () => undefined,
  };
}

function fakeRequest(
  options: Readonly<{
    verb?: string;
    fromDevice?: string;
  }>,
): {
  request: IncomingManageRequest;
  responses: ManageOutcome[];
} {
  const responses: ManageOutcome[] = [];
  const scope: Readonly<CapabilityScope> = { kind: "room", path: "owner/room" };
  const request: IncomingManageRequest = {
    requestId: 1,
    command: { verb: options.verb ?? "room:member", params: {} },
    scope,
    ...(options.fromDevice !== undefined
      ? { fromDevice: deviceIdBytes(options.fromDevice) }
      : {}),
    respond: async (outcome: ManageOutcome): Promise<void> => {
      responses.push(outcome);
    },
  };
  return { request, responses };
}

function fakeDeps(
  overrides: Readonly<Partial<HubRequestDispatchDeps>> = {},
): HubRequestDispatchDeps {
  return {
    isTrusted: () => false,
    handleRoomRequest: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("dispatchHubRequest", () => {
  it("refuses a room-domain verb with no fromDevice with an ordinary unauthorized outcome, never dispatching to handleRoomRequest", async () => {
    const { request, responses } = fakeRequest({ verb: "room:member" });
    const deps = fakeDeps();
    const onKnownPeer = fakeOnKnownPeer();

    await dispatchHubRequest({
      request,
      deps,
      onKnownPeer: onKnownPeer,
    });

    expect(responses).toEqual([{ result: "error", code: "unauthorized" }]);
    expect(deps.handleRoomRequest).not.toHaveBeenCalled();
    expect(onKnownPeer).not.toHaveBeenCalled();
  });

  it.each([
    { label: "an untrusted device", fromDevice: SENDER_HEX, trusted: false },
    { label: "a trusted device", fromDevice: SENDER_HEX, trusted: true },
    { label: "no identified device", fromDevice: undefined, trusted: false },
  ])(
    "refuses a legacy FRAME_VERB request from $label with unsupported_verb, never dispatching it or recording a known peer (agent-comms#169, agent-comms#268)",
    async ({ fromDevice, trusted }) => {
      const { request, responses } = fakeRequest({
        verb: FRAME_VERB,
        ...(fromDevice !== undefined ? { fromDevice } : {}),
      });
      request.command.params = {
        message: {
          method: "state_update",
          patch: { type: "agent_offline", agentId: "spoofed" },
        },
      };
      const deps = fakeDeps({ isTrusted: () => trusted });
      const onKnownPeer = fakeOnKnownPeer();

      await dispatchHubRequest({
        request,
        deps,
        onKnownPeer,
      });

      expect(responses).toEqual([
        { result: "error", code: "unsupported_verb" },
      ]);
      expect(deps.handleRoomRequest).not.toHaveBeenCalled();
      expect(onKnownPeer).not.toHaveBeenCalled();
    },
  );

  it("dispatches a room-domain verb from an UNTRUSTED but identified device straight to handleRoomRequest, never rejecting it as unauthorized (the actual agent-comms#192 fix)", async () => {
    const { request, responses } = fakeRequest({
      verb: "room:member",
      fromDevice: SENDER_HEX,
    });
    const handleRoomRequest = vi
      .fn<HubRequestDispatchDeps["handleRoomRequest"]>()
      .mockImplementation(async (req) => {
        await req.respond({ result: "ok" });
      });
    const deps = fakeDeps({ isTrusted: () => false, handleRoomRequest });
    const onKnownPeer = fakeOnKnownPeer();

    await dispatchHubRequest({
      request,
      deps,
      onKnownPeer: onKnownPeer,
    });

    expect(handleRoomRequest).toHaveBeenCalledTimes(1);
    const [dispatchedRequest, dispatchedHandle] =
      handleRoomRequest.mock.calls[0] ?? [];
    expect(dispatchedRequest).toBe(request);
    expect(dispatchedHandle).toEqual({ id: SENDER_HEX });
    expect(responses).toEqual([{ result: "ok" }]);
    // hubPeersKnown stays "gateway-trusted hub peers": a room-domain sender's own capability token hasn't been verified yet at this point (that happens inside handleRoomRequest), so an untrusted sender reaching this branch must not be recorded as known just because it presented a syntactically valid device-id.
    expect(onKnownPeer).not.toHaveBeenCalled();
  });

  it("still records a TRUSTED room-domain sender as a known hub peer", async () => {
    const { request } = fakeRequest({
      verb: "room:member",
      fromDevice: SENDER_HEX,
    });
    const deps = fakeDeps({ isTrusted: () => true });
    const onKnownPeer = fakeOnKnownPeer();

    await dispatchHubRequest({
      request,
      deps,
      onKnownPeer: onKnownPeer,
    });

    expect(onKnownPeer).toHaveBeenCalledWith(SENDER_HEX);
  });

  it("uses deviceIdToHex(request.fromDevice) as the resolved handle id for a room-domain verb ", async () => {
    const { request } = fakeRequest({
      verb: "room:member",
      fromDevice: SENDER_HEX,
    });
    const handleRoomRequest = vi.fn().mockResolvedValue(undefined);
    const deps = fakeDeps({ isTrusted: () => true, handleRoomRequest });

    await dispatchHubRequest({
      request,
      deps,
      onKnownPeer: fakeOnKnownPeer(),
    });

    expect(handleRoomRequest).toHaveBeenCalledTimes(1);
    const [, handleArg] = handleRoomRequest.mock.calls[0] ?? [];
    expect(handleArg).toEqual({ id: deviceIdToHex(deviceIdBytes(SENDER_HEX)) });
  });

  it("threads the given hubAddress through to handleRoomRequest as origin.relayHubAddress (agent-comms#216)", async () => {
    const { request } = fakeRequest({
      verb: "room:member",
      fromDevice: SENDER_HEX,
    });
    const handleRoomRequest = vi.fn().mockResolvedValue(undefined);
    const deps = fakeDeps({ isTrusted: () => false, handleRoomRequest });

    await dispatchHubRequest({
      request,
      deps,
      onKnownPeer: fakeOnKnownPeer(),
      hubAddress: "wss://hub.example/",
    });

    expect(handleRoomRequest).toHaveBeenCalledTimes(1);
    const [, , originArg] = handleRoomRequest.mock.calls[0] ?? [];
    expect(originArg).toEqual({ relayHubAddress: "wss://hub.example/" });
  });

  it("passes an empty origin to handleRoomRequest when no hubAddress was given", async () => {
    const { request } = fakeRequest({
      verb: "room:member",
      fromDevice: SENDER_HEX,
    });
    const handleRoomRequest = vi.fn().mockResolvedValue(undefined);
    const deps = fakeDeps({ isTrusted: () => false, handleRoomRequest });

    await dispatchHubRequest({
      request,
      deps,
      onKnownPeer: fakeOnKnownPeer(),
    });

    expect(handleRoomRequest).toHaveBeenCalledTimes(1);
    const [, , originArg] = handleRoomRequest.mock.calls[0] ?? [];
    expect(originArg).toEqual({});
  });
});
