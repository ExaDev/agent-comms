/**
 * Lazy per-correspondent reply aliases for the default cc-peer front (agent-comms#158) — pure alias-name derivation and the in-memory correspondent↔alias directory the front consults on both the mesh-to-session direction (materialise an alias so the session can address a reply to it) and the session-to-mesh direction (translate a reply arriving on an alias back into the correspondent it stands for and where that reply should go).
 *
 * Deliberately not persisted: aliases are ephemeral by design, lost on restart and re-materialised by the next inbound message from that correspondent (see the issue body's "Rejected alternatives" for why a directory of every mesh agent is not minted upfront). Kept free of any real cc-peer/AliasPool construction, exactly like front.ts's pure decision logic — front-relay.ts and front-controller.ts consult this directory, and front-runtime.ts supplies the real AliasPool the alias names get materialised against.
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

/** Where a reply arriving on a correspondent's alias should go back to: a DM straight to that correspondent, or a post back into the room the message that produced the alias was itself sent in. A room's own reply-aliased message always names the room it came from, so a reply lands in the same room rather than always falling back to a DM (agent-comms#289). */
export type ReplyContext =
  { readonly kind: "dm" } | { readonly kind: "room"; readonly room: string };

/** The mesh correspondent and reply context a DeliveryEvent carries, for the event types with a single, repliable-to sender — undefined for every other event type (room membership/status/capability events describe something happening, not a message from one correspondent worth aliasing). */
export interface ReplyTarget {
  readonly correspondentId: string;
  readonly context: ReplyContext;
}

/** Resolves a DeliveryEvent's own reply target, or undefined when the event has no single originating correspondent. A dm event's reply target is always another dm; a room_message event's reply target is the room the message was posted in, since that is what a reply to it should return to, not the sender's own dm channel (agent-comms#289). */
export function replyTargetForEvent(
  event: Readonly<DeliveryEvent>,
): ReplyTarget | undefined {
  switch (event.type) {
    case "dm":
      return { correspondentId: event.message.from, context: { kind: "dm" } };
    case "room_message":
      return {
        correspondentId: event.message.from,
        context: { kind: "room", room: event.message.room },
      };
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
 * Bounded, in-memory, bijective map between the cc-peer peer names materialised for a front's reply aliases and the mesh correspondent id each one stands for, plus the reply context (dm vs. room) each alias currently carries. Bounded by real correspondents, per the issue's own "Rejected alternatives": a name is only ever minted by ensure(), which the front calls solely on genuine inbound contact from that correspondent — nothing pre-populates this directory with the wider mesh roster.
 *
 * A single correspondent id can reach a fronted session two different ways — a direct dm, and a message posted in a room they share with the session — and both share the same alias, since the alias scheme is keyed on the correspondent alone (agent-comms#158). ensure() therefore always records the context of the *most recent* event sent from that alias: a session's reply always continues whatever conversation it was last shown on that alias, so the context that matters is the one behind the last message it actually saw, not whichever context first minted the name.
 */
export class ReplyAliasDirectory {
  private readonly nameToCorrespondent = new Map<string, string>();
  private readonly correspondentToName = new Map<string, string>();
  private readonly nameToContext = new Map<string, ReplyContext>();

  /** Returns the alias name for a correspondent, deriving and recording it the first time this correspondent is seen, and records `context` as that alias's current reply target regardless of whether the alias was just minted or already existed. Idempotent on the name itself: a correspondent already known always gets back its existing name, so a session's reply target stays stable across repeated inbound contact within the same front lifetime; the context, however, is refreshed on every call. */
  ensure(correspondentId: string, context: ReplyContext): string {
    const existing = this.correspondentToName.get(correspondentId);
    const name = existing ?? deriveAliasName(correspondentId);
    if (existing === undefined) {
      this.correspondentToName.set(correspondentId, name);
      this.nameToCorrespondent.set(name, correspondentId);
    }
    this.nameToContext.set(name, context);
    return name;
  }

  /** The correspondent a previously-minted alias name stands for, or undefined for a name this directory never minted (or no longer remembers, e.g. after a front restart cleared it) -- the front's own signal to treat an inbound reply as addressed to a stale alias rather than a known correspondent. */
  correspondentFor(aliasName: string): string | undefined {
    return this.nameToCorrespondent.get(aliasName);
  }

  /** The reply context a previously-minted alias name currently carries (dm or a named room), or undefined for a name this directory never minted. Always defined whenever correspondentFor(aliasName) is, since both are set together by ensure(). */
  contextFor(aliasName: string): ReplyContext | undefined {
    return this.nameToContext.get(aliasName);
  }
}
