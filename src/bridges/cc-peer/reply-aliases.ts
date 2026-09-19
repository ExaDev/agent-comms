/**
 * Lazy per-correspondent reply aliases for the default cc-peer front (agent-comms#158) -- pure alias-name derivation and the in-memory correspondent↔alias directory the front consults on both the mesh-to-session direction (materialise an alias so the session can address a reply to it) and the session-to-mesh direction (translate a reply arriving on an alias back into the correspondent it stands for).
 *
 * Deliberately not persisted: aliases are ephemeral by design, lost on restart and re-materialised by the next inbound message from that correspondent (see the issue body's "Rejected alternatives" for why a directory of every mesh agent is not minted upfront). Kept free of any real cc-peer/AliasPool construction, exactly like front.ts's pure decision logic -- front-relay.ts and front-controller.ts consult this directory, and front-runtime.ts supplies the real AliasPool the alias names get materialised against.
 */

import type { DeliveryEvent } from "../../core/types.js";

/** How many leading hex characters of a correspondent's device-id go into its alias name -- 48 bits of a SHA-256 hash, chosen purely for a short, readable cc-peer peer name; cc-peer's own registry name field has no length or format restriction beyond non-empty (see AliasStartCommandSchema in cc-peer's alias-ipc schema), so this is a readability choice, not a protocol requirement. */
const ALIAS_ID_LENGTH = 12;

/** cc-peer peer names materialised for reply aliases are prefixed so they read unambiguously as a mesh correspondent, not a real local Claude Code session, in `roster()`/UI listings that show every locally known peer name side by side. */
const ALIAS_NAME_PREFIX = "mesh-";

/** Derives the cc-peer peer name a correspondent's reply alias registers under. Deterministic and side-effect-free: the same correspondent id always derives the same name, so ReplyAliasDirectory only needs to remember the mapping, not invent a fresh name per call. */
export function deriveAliasName(correspondentId: string): string {
  return `${ALIAS_NAME_PREFIX}${correspondentId.slice(0, ALIAS_ID_LENGTH)}`;
}

/** The mesh agent id a DeliveryEvent originated from, for the event types that carry a single, repliable-to sender -- undefined for every other event type (room membership/status/capability events describe something happening, not a message from one correspondent worth aliasing). */
export function correspondentForEvent(
  event: Readonly<DeliveryEvent>,
): string | undefined {
  switch (event.type) {
    case "dm":
    case "room_message":
      return event.message.from;
    case "room_invite":
    case "member_joined":
    case "member_left":
    case "room_members":
    case "member_status":
    case "delivery_status":
    case "invite_declined":
    case "name_changed":
    case "connection_request":
    case "capability_request":
    case "room_join_request":
      return undefined;
    default:
      return event satisfies never;
  }
}

/**
 * Bounded, in-memory, bijective map between the cc-peer peer names materialised for a front's reply aliases and the mesh correspondent id each one stands for. Bounded by real correspondents, per the issue's own "Rejected alternatives": a name is only ever minted by ensure(), which the front calls solely on genuine inbound contact from that correspondent -- nothing pre-populates this directory with the wider mesh roster.
 */
export class ReplyAliasDirectory {
  private readonly nameToCorrespondent = new Map<string, string>();
  private readonly correspondentToName = new Map<string, string>();

  /** Returns the alias name for a correspondent, deriving and recording it the first time this correspondent is seen. Idempotent: a correspondent already known always gets back its existing name, so a session's reply target stays stable across repeated inbound contact within the same front lifetime. */
  ensure(correspondentId: string): string {
    const existing = this.correspondentToName.get(correspondentId);
    if (existing !== undefined) return existing;
    const name = deriveAliasName(correspondentId);
    this.correspondentToName.set(correspondentId, name);
    this.nameToCorrespondent.set(name, correspondentId);
    return name;
  }

  /** The correspondent a previously-minted alias name stands for, or undefined for a name this directory never minted (or no longer remembers, e.g. after a front restart cleared it) -- the front's own signal to treat an inbound reply as addressed to a stale alias rather than a known correspondent. */
  correspondentFor(aliasName: string): string | undefined {
    return this.nameToCorrespondent.get(aliasName);
  }
}
