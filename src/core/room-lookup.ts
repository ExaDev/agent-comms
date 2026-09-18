/**
 * Resolves a caller-supplied room identifier against this store's own known rooms -- every room-touching tool action (send/join_room/leave_room/read_room/invite/kick/destroy_room) documents its room/target parameter as accepting a room's plain local `name`, matching the README's own usage examples (e.g. `target: "code-review"`) and createRoom's own confirmation message, which surfaces the name back to the caller rather than the owner-qualified id. MeshStore's real room identity is `<owner-hex>/<local-name>` (room-path.ts's ownerNamedRoomPath), a value no caller can construct from a bare name alone, so this is the one place that gap gets closed -- every local-facing RoomLifecycle/RoomMessaging method resolves a name the same way here rather than each reimplementing (or forgetting to reimplement) its own lookup. Wire-protocol-received room paths (room-protocol.ts's own verb handlers) never need this: those always arrive as the real path a remote peer already resolved on its own side.
 */

import { CommsError } from "./store.js";
import type { Room } from "./types.js";

/**
 * Returns `roomIdOrName` unchanged when it already names a known room (a real id, or a name this store doesn't recognise at all -- leaving the caller's own existing not-found/remote-join handling to fire exactly as before). Resolves to the matching room's real id when exactly one known room's `name` equals `roomIdOrName`. Throws AMBIGUOUS_ROOM_NAME when more than one known room shares that name -- distinct owners can legitimately pick the same local name, so silently picking one would be a correctness bug, not a convenience.
 */
export function resolveRoomId(
  rooms: ReadonlyMap<string, Room>,
  roomIdOrName: string,
): string {
  if (rooms.has(roomIdOrName)) return roomIdOrName;

  const matches: Room[] = [];
  for (const room of rooms.values()) {
    if (room.name === roomIdOrName) matches.push(room);
  }
  if (matches.length === 0) return roomIdOrName;
  if (matches.length > 1) {
    throw new CommsError(
      `Room name ${JSON.stringify(roomIdOrName)} is ambiguous (matches ${matches.map((room) => room.id).join(", ")}); address it by its full room id instead`,
      "AMBIGUOUS_ROOM_NAME",
    );
  }
  const [match] = matches;
  if (match === undefined) return roomIdOrName;
  return match.id;
}
