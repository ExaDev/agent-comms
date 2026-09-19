/**
 * Resolves a caller-supplied room identifier against the rooms this store knows of, replicated or merely discovered -- every room-touching tool action (send/join_room/leave_room/read_room/invite/kick/destroy_room) documents its room/target parameter as accepting a room's plain local `name`, matching the README's own usage examples (e.g. `target: "code-review"`) and createRoom's own confirmation message, which surfaces the name back to the caller rather than the owner-qualified id. MeshStore's real room identity is `<owner-hex>/<local-name>` (room-path.ts's ownerNamedRoomPath), a value no caller can construct from a bare name alone, so this is the one place that gap gets closed -- every local-facing RoomLifecycle/RoomMessaging method resolves a name the same way here rather than each reimplementing (or forgetting to reimplement) its own lookup. Wire-protocol-received room paths (room-protocol.ts's own verb handlers) never need this: those always arrive as the real path a remote peer already resolved on its own side.
 */

import { CommsError } from "./store.js";

/** The two fields of a room that name resolution needs: its real id and the plain local name a caller may use instead. A full `Room` satisfies this, and so does a room known only from a gossiped hosted-room advert. */
export interface RoomRef {
  id: string;
  name: string;
}

/**
 * Resolves `roomIdOrName` against every room the caller knows of: rooms replicated into this store and rooms other devices merely advertise as hosted, since list_rooms shows both under their bare `name`. The same room appearing in both sources (same id) is one candidate, not two.
 *
 * Returns `roomIdOrName` unchanged when it already is a known room's id, or when no known room has that name (leaving the caller's own not-found or remote-join handling to fire exactly as it would for any unrecognised id). Resolves to the matching room's id when exactly one candidate's `name` equals `roomIdOrName`. Throws AMBIGUOUS_ROOM_NAME, naming every candidate id, when more than one candidate shares that name: distinct owners can legitimately pick the same local name, so silently picking one would be a correctness bug, not a convenience.
 */
export function resolveRoomId(
  candidates: Readonly<Iterable<RoomRef>>,
  roomIdOrName: string,
): string {
  const byId = new Map<string, RoomRef>();
  for (const candidate of candidates) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  if (byId.has(roomIdOrName)) return roomIdOrName;

  const matches: RoomRef[] = [];
  for (const candidate of byId.values()) {
    if (candidate.name === roomIdOrName) matches.push(candidate);
  }
  const [match, ...rest] = matches;
  if (match === undefined) return roomIdOrName;
  if (rest.length > 0) {
    throw new CommsError(
      `Room name ${JSON.stringify(roomIdOrName)} is ambiguous (matches ${matches.map((candidate) => candidate.id).join(", ")}); address it by its full room id instead`,
      "AMBIGUOUS_ROOM_NAME",
    );
  }
  return match.id;
}
