/**
 * recordRoomSendNotice: mints a room-notice for a real room-send and appends it to the sender's own oplog. The critical correctness property is round-trip fidelity -- what gets CBOR-encoded and appended must decode back into exactly the same verifiable RoomNotice createRoomNotice produced, since appendOwnEntry only ever stores opaque bytes and has no idea a RoomNotice is inside them.
 */

import { describe, expect, it } from "vitest";
import { decode as cborDecode, cdeDecodeOptions } from "cbor2";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { ownerNamedRoomPath } from "wire-mesh-core/domain/room-path";
import { verifyRoomNotice } from "wire-mesh-core/domain/room";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { readEntries, headSeqFor } from "wire-mesh-core/domain/data-sync";
import type {
  CapabilityToken,
  RoomNotice,
} from "wire-mesh-core/generated/protocol";
import { generateIdentity } from "../core/identity.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { recordRoomSendNotice } from "../core/room-notice-log.js";
import { randomId } from "../core/random-id.js";

const NO_DELEGATIONS_REMAINING = 0;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const ONE_HOUR_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

async function mintRoomMemberToken(
  issuer: Awaited<ReturnType<typeof toIdentityPort>>,
  bearer: Awaited<ReturnType<typeof toIdentityPort>>,
  roomPath: string,
): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity: issuer,
    clock: createSystemClock(),
    tokenId: randomId(),
    bearer: bearer.deviceId,
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires: Date.now() + ONE_HOUR_MS,
    delegationsRemaining: NO_DELEGATIONS_REMAINING,
  });
  if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);
  return verdict.token;
}

describe("recordRoomSendNotice", () => {
  it("appends a notice that decodes back into exactly what verifyRoomNotice accepts", async () => {
    const ownerIdentity = await toIdentityPort(generateIdentity());
    const posterIdentity = await toIdentityPort(generateIdentity());
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(ownerIdentity.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(
      ownerIdentity,
      posterIdentity,
      roomPath,
    );
    const storage = createMemoryStorage();
    const clock = createSystemClock();

    const { seq, haveFrame } = await recordRoomSendNotice(
      { identity: posterIdentity, clock, storage },
      {
        room: roomPath,
        token,
        contentType: "text/plain",
        content: new TextEncoder().encode("hello room"),
      },
    );

    expect(seq).toBe(1);
    expect(haveFrame).toEqual({
      type: "data-have",
      peer: posterIdentity.deviceId,
      "head-seq": 1,
    });
    expect(await headSeqFor(storage, posterIdentity.deviceId)).toBe(1);

    const [storedBytes] = await readEntries(
      storage,
      posterIdentity.deviceId,
      0,
    );
    expect(storedBytes).toBeDefined();
    if (storedBytes === undefined) return;
    const decoded = cborDecode<RoomNotice>(storedBytes, cdeDecodeOptions);

    const verdict = await verifyRoomNotice(decoded, {
      identity: posterIdentity,
      clock,
      revocation: createRevocationView(),
    });

    expect(
      verdict.ok,
      `expected the round-tripped notice to verify, got ${JSON.stringify(verdict)}`,
    ).toBeTruthy();
    if (!verdict.ok) return;
    expect(verdict.claims.room).toBe(roomPath);
    expect(new TextDecoder().decode(verdict.claims.content)).toBe("hello room");
  });

  it("increments the sequence across successive sends in the same room", async () => {
    const ownerIdentity = await toIdentityPort(generateIdentity());
    const posterIdentity = await toIdentityPort(generateIdentity());
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(ownerIdentity.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(
      ownerIdentity,
      posterIdentity,
      roomPath,
    );
    const storage = createMemoryStorage();
    const clock = createSystemClock();
    const deps = { identity: posterIdentity, clock, storage };
    const options = {
      room: roomPath,
      token,
      contentType: "text/plain",
    };

    const first = await recordRoomSendNotice(deps, {
      ...options,
      content: new TextEncoder().encode("first"),
    });
    const second = await recordRoomSendNotice(deps, {
      ...options,
      content: new TextEncoder().encode("second"),
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });
});
