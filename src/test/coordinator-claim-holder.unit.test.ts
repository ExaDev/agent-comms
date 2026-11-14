/**
 * Whose coordinator claims count: a claim is evaluated only when its holder is this side, the peer that sent it, or a peer this side has a machine-local session to. Any other claim waits in one pending slot until its holder's session is enrolled and is dropped after one claim wait, so a claim for an absent device neither changes the incumbent nor starts a takeover.
 */

import { afterEach, expect, test, vi } from "vitest";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import type { CoordinatorFrame } from "wire-mesh-core/generated/protocol";
import { CoordinatorRole } from "../core/coordinator-role.js";
import { ROOM_REQUEST_TIMEOUT_MS } from "../core/request-timeouts.js";

const DEVICE_ID_HEX_LENGTH = 64;
const SELF = "5".repeat(DEVICE_ID_HEX_LENGTH);
const SENDER = "7".repeat(DEVICE_ID_HEX_LENGTH);
const ABSENT = "1".repeat(DEVICE_ID_HEX_LENGTH);
const OTHER_ABSENT = "2".repeat(DEVICE_ID_HEX_LENGTH);
const INCUMBENT_TERM = 4;
/** How much longer than one claim wait a test lets time pass to show that nothing happens. */
const LONG_WAIT_FACTOR = 10;
const TERM_STEP = 3;
const TERM_GAP = 2;
const LATER_TERM = INCUMBENT_TERM + TERM_STEP;
const EARLIER_TERM = INCUMBENT_TERM - TERM_GAP;

afterEach(() => {
  vi.useRealTimers();
});

function claimFor(holder: string, term: number): CoordinatorFrame {
  return { type: "coordinator", term, coordinator: deviceIdFromHex(holder) };
}

/** A role whose machine-local sessions are exactly `peers`, which the test may change; everything it broadcasts is recorded. */
function roleWith(peers: Set<string>) {
  const broadcast: CoordinatorFrame[] = [];
  const role = new CoordinatorRole({
    getPeerId: () => SELF,
    claimWaitMs: ROOM_REQUEST_TIMEOUT_MS,
    requireTransport: () => ({
      broadcastCoordinatorClaim: async (frame) => {
        broadcast.push(frame);
      },
      sendCoordinatorClaim: async () => undefined,
      electionPeerIds: () => peers,
    }),
    onGained: async () => undefined,
    onLost: async () => undefined,
    onError: (error) => {
      throw error;
    },
  });
  return { role, broadcast };
}

test("a claim naming an absent holder does not change the incumbent", async () => {
  const { role } = roleWith(new Set([SENDER]));
  await role.handleClaim({ id: SENDER }, claimFor(SENDER, INCUMBENT_TERM));

  await role.handleClaim({ id: SENDER }, claimFor(ABSENT, LATER_TERM));

  expect(role.current()).toEqual({ term: INCUMBENT_TERM, holder: SENDER });
});

test("a claim naming an absent holder starts no takeover, however long the wait", async () => {
  vi.useFakeTimers();
  const { role, broadcast } = roleWith(new Set([SENDER]));

  await role.handleClaim({ id: SENDER }, claimFor(ABSENT, LATER_TERM));
  await vi.advanceTimersByTimeAsync(ROOM_REQUEST_TIMEOUT_MS * LONG_WAIT_FACTOR);

  expect(role.current()).toBeUndefined();
  expect(role.isHolder()).toBe(false);
  expect(broadcast).toEqual([]);
});

test("the same claim is accepted once its holder's session enrols, and is gossiped on", async () => {
  const peers = new Set([SENDER]);
  const { role, broadcast } = roleWith(peers);
  await role.handleClaim({ id: SENDER }, claimFor(ABSENT, LATER_TERM));
  expect(role.current()).toBeUndefined();

  peers.add(ABSENT);
  await role.announceTo({ id: ABSENT });

  expect(role.current()).toEqual({ term: LATER_TERM, holder: ABSENT });
  expect(broadcast).toEqual([claimFor(ABSENT, LATER_TERM)]);
});

test("a claim gossiped onward by a peer other than its holder is accepted when the holder is reachable", async () => {
  const { role } = roleWith(new Set([SENDER, ABSENT]));

  await role.handleClaim({ id: SENDER }, claimFor(ABSENT, LATER_TERM));

  expect(role.current()).toEqual({ term: LATER_TERM, holder: ABSENT });
});

test("a claim naming its own sender, or this side, is evaluated whatever the sessions are", async () => {
  const { role } = roleWith(new Set());

  await role.handleClaim({ id: SENDER }, claimFor(SENDER, INCUMBENT_TERM));
  expect(role.current()).toEqual({ term: INCUMBENT_TERM, holder: SENDER });

  await role.handleClaim({ id: SENDER }, claimFor(SELF, LATER_TERM));
  expect(role.current()).toEqual({ term: LATER_TERM, holder: SELF });
  expect(role.isHolder()).toBe(true);
});

test("the sender is the session's device, never a field of the frame: a frame cannot vouch for a holder by naming it", async () => {
  const { role } = roleWith(new Set([SENDER]));

  await role.handleClaim({ id: SENDER }, claimFor(ABSENT, LATER_TERM));
  await role.handleClaim({ id: ABSENT }, claimFor(ABSENT, LATER_TERM + 1));

  expect(role.current()).toEqual({ term: LATER_TERM + 1, holder: ABSENT });
});

test("one claim waits at a time, and a claim of a higher term replaces a waiting one of a lower term, not the reverse", async () => {
  const peers = new Set([SENDER]);
  const { role } = roleWith(peers);
  await role.handleClaim({ id: SENDER }, claimFor(ABSENT, INCUMBENT_TERM));
  await role.handleClaim({ id: SENDER }, claimFor(OTHER_ABSENT, EARLIER_TERM));

  peers.add(OTHER_ABSENT);
  await role.announceTo({ id: OTHER_ABSENT });
  expect(role.current()).toBeUndefined();

  await role.handleClaim({ id: SENDER }, claimFor(OTHER_ABSENT, LATER_TERM));
  peers.add(ABSENT);
  await role.announceTo({ id: ABSENT });
  expect(role.current()).toEqual({ term: LATER_TERM, holder: OTHER_ABSENT });
});

test("a claim set aside is dropped after one claim wait, so a holder that enrols later finds nothing waiting", async () => {
  vi.useFakeTimers();
  const peers = new Set([SENDER]);
  const { role } = roleWith(peers);
  await role.handleClaim({ id: SENDER }, claimFor(ABSENT, LATER_TERM));

  await vi.advanceTimersByTimeAsync(ROOM_REQUEST_TIMEOUT_MS);
  peers.add(ABSENT);
  await role.announceTo({ id: ABSENT });

  expect(role.current()).toBeUndefined();
});
