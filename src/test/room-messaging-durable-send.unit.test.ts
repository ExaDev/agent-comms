/**
 * sendRoomMessage's opt-in durable flag (P5's mint-and-append half, agent-comms#50, wired via recordRoomSendNotice from #135): a caller that passes durable: true also gets the message recorded as a room-notice in the sender's own oplog, verifiable end to end via a real verifyRoomNotice, not just an opaque append. Real identities and a real minted token throughout, matching room-lifecycle.test.ts's own established convention for this class of test -- recordRoomSendNotice genuinely mints and signs, so an opaque placeholder token would fail the mint outright.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { decode as cborDecode, cdeDecodeOptions } from "cbor2";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { ownerNamedRoomPath } from "wire-mesh-core/domain/room-path";
import { verifyRoomNotice } from "wire-mesh-core/domain/room";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { readEntries } from "wire-mesh-core/domain/data-sync";
import type { RoomNotice } from "wire-mesh-core/generated/protocol";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { loadOrCreateIdentity, saveRoomToken } from "../core/identity-store.js";
import { randomId } from "../core/random-id.js";
import {
  RoomMessaging,
  type RoomMessagingDeps,
} from "../core/room-messaging.js";
import type { Room } from "../core/types.js";

const NO_DELEGATIONS_REMAINING = 0;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const ONE_HOUR_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

async function makeHarness() {
  const ownerIdentity = await toIdentityPort(generateIdentity());
  const roomPath = ownerNamedRoomPath(
    deviceIdToHex(ownerIdentity.deviceId),
    "general",
  );
  const clock = createSystemClock();
  const verdict = await mintCapabilityToken({
    identity: ownerIdentity,
    clock,
    tokenId: randomId(),
    bearer: ownerIdentity.deviceId,
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires: Date.now() + ONE_HOUR_MS,
    delegationsRemaining: NO_DELEGATIONS_REMAINING,
  });
  if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);

  // saveRoomToken writes into this slot's own persisted identity file, which must already exist on disk -- unrelated to which crypto identity requireIdentity() uses for minting/verifying (room-lifecycle.test.ts's own established convention for this exact precondition).
  const slotDir = fs.mkdtempSync(
    path.join(tmpdir(), "room-messaging-durable-send-test-"),
  );
  const slot = { harness: "test", cwd: "room-messaging", dir: slotDir };
  loadOrCreateIdentity(slot);
  saveRoomToken(slot, roomPath, verdict.token);

  const dataStorage = createMemoryStorage();
  const room: Room = {
    id: roomPath,
    version: 1,
    name: "general",
    type: "public",
    owner: deviceIdToHex(ownerIdentity.deviceId),
    createdAt: "2026-01-01T00:00:00.000Z",
    description: "",
    members: [deviceIdToHex(ownerIdentity.deviceId)],
    invited: [],
    memberJoins: {},
    memberLeaves: {},
    invitedJoins: {},
    invitedLeaves: {},
  };

  const deps: RoomMessagingDeps = {
    rooms: new Map([[roomPath, room]]),
    messages: new Map(),
    dms: new Map(),
    requireIdentity: () => ({
      slot,
      clock,
      identity: ownerIdentity,
      revocation: createRevocationView(),
      dataStorage,
      userIdentity: ownerIdentity,
      userIdentityOptions: {},
    }),
    roomProtocol: { sendRoomRequestToMember: async () => undefined },
    // This harness only sends room messages, never DMs, so DM admission is never reached.
    requestDmAccess: async () => undefined,
    resolveAgent: async () => undefined,
    // Every send here already names the room by its real path.
    resolveRoomId: (roomIdOrName) => roomIdOrName,
  };

  return {
    messaging: new RoomMessaging(deps),
    ownerIdentity,
    roomPath,
    dataStorage,
  };
}

describe("RoomMessaging — sendRoomMessage durable flag", () => {
  it("records nothing in the oplog when durable is omitted", async () => {
    const h = await makeHarness();
    const ownerDeviceHex = deviceIdToHex(h.ownerIdentity.deviceId);
    await h.messaging.sendRoomMessage(h.roomPath, ownerDeviceHex, "hello");

    expect(
      await readEntries(h.dataStorage, h.ownerIdentity.deviceId, 0),
    ).toEqual([]);
  });

  it("appends a verifiable room-notice to the sender's own oplog when durable is true", async () => {
    const h = await makeHarness();
    const ownerDeviceHex = deviceIdToHex(h.ownerIdentity.deviceId);

    await h.messaging.sendRoomMessage(
      h.roomPath,
      ownerDeviceHex,
      "hello, durably",
      { durable: true },
    );

    const [entry] = await readEntries(
      h.dataStorage,
      h.ownerIdentity.deviceId,
      0,
    );
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const decoded = cborDecode<RoomNotice>(entry, cdeDecodeOptions);
    const verdict = await verifyRoomNotice(decoded, {
      identity: h.ownerIdentity,
      clock: createSystemClock(),
      revocation: createRevocationView(),
    });

    expect(
      verdict.ok,
      `expected the durably-recorded notice to verify, got ${JSON.stringify(verdict)}`,
    ).toBeTruthy();
    if (!verdict.ok) return;
    expect(verdict.claims.room).toBe(h.roomPath);
    expect(new TextDecoder().decode(verdict.claims.content)).toBe(
      "hello, durably",
    );
  });
});
