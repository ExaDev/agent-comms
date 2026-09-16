/**
 * Records a room.send as a durable, catch-up-able room-notice in the sender's own oplog -- P5's mint-and-append half (agent-comms#50), riding wire-mesh-core's createRoomNotice + appendOwnEntry directly. Deliberately opt-in per call, not wired into sendRoomMessage's own default path: a caller decides per-message whether durability is worth the extra local write, matching the plan's own "delivery and durable catch-up are the same artifact, opt-in per message" design. Wiring this into a bridge's own send path, and the actual catch-up policy (when to send data-have, which peers' logs to track), stay their own separate, still-open piece.
 */

import { encode as cborEncode, cdeEncodeOptions } from "cbor2";
import { createRoomNotice } from "wire-mesh-core/domain/room";
import { appendOwnEntry } from "wire-mesh-core/domain/data-sync";
import type {
  CapabilityToken,
  DataHaveFrame,
  MessageRef,
  RoomPath,
} from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import { randomId } from "./random-id.js";

export interface RecordRoomSendNoticeDeps {
  identity: IdentityPort;
  clock: Clock;
  storage: KeyValueStorage;
}

export interface RecordRoomSendNoticeOptions {
  room: RoomPath;
  /** The sender's own room:member token for `room`, embedded in full in the minted notice -- see createRoomNotice's own token field for why. */
  token: CapabilityToken;
  contentType: string;
  content: Uint8Array<ArrayBuffer>;
  refs?: readonly MessageRef[];
  validUntil?: number;
}

/** Mints a self-certifying room-notice for this send, CBOR-encodes it (cbor2's own deterministic-encoding preset, matching handshake.ts's established convention for every other wire-mesh value this codebase serialises), and appends it to the sender's own oplog. Returns the new sequence number and the data-have frame announcing it -- sending that frame to any peer is the caller's own policy, not this function's. */
export async function recordRoomSendNotice(
  deps: Readonly<RecordRoomSendNoticeDeps>,
  options: Readonly<RecordRoomSendNoticeOptions>,
): Promise<{ seq: number; haveFrame: DataHaveFrame }> {
  const notice = await createRoomNotice({
    identity: deps.identity,
    clock: deps.clock,
    room: options.room,
    token: options.token,
    noticeId: randomId(),
    contentType: options.contentType,
    content: options.content,
    ...(options.refs !== undefined ? { refs: options.refs } : {}),
    ...(options.validUntil !== undefined
      ? { validUntil: options.validUntil }
      : {}),
  });
  // cbor2's encode() returns Uint8Array<ArrayBufferLike>; appendOwnEntry needs the narrower Uint8Array<ArrayBuffer> every other wire-mesh-core byte-string field already uses. Uint8Array.from copies into a fresh, plain ArrayBuffer-backed array rather than asserting the existing buffer's type.
  const encoded: Uint8Array<ArrayBuffer> = Uint8Array.from(
    cborEncode(notice, cdeEncodeOptions),
  );
  return appendOwnEntry(
    { identity: deps.identity, storage: deps.storage },
    encoded,
  );
}
