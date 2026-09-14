/**
 * Shared constants and helpers for MeshStore and its collaborator classes — module-level constants, types, and free functions with no `this` dependency, split out purely to keep mesh-store.ts under the repo's max-lines cap.
 */

import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { RevocationView } from "wire-mesh-core/domain/revocation-view";
import type { IdentitySlot } from "./identity-store.js";

/** The identity/clock/persistence collaborators MeshStore mints and persists room-membership grants against. Set via setIdentity(), mirroring the transport's own setTransport() contract. */
export interface MeshStoreIdentity {
  identity: IdentityPort;
  clock: Clock;
  slot: IdentitySlot;
  revocation: RevocationView;
}

/**
 * Lifetime of a freshly minted room:member grant (owner root grant or member join/invite grant alike). Deliberately generous rather than the "short expires, periodic re-issue" pattern the design calls for to bound kick-convergence to gossip-independent expiry -- that re-issue mechanism is P3.7's own deliverable (riding room.members refreshes), and shipping a short expiry before it exists would let ordinary grants go stale with nothing to renew them. 30 days comfortably outlives any realistic room lifetime for now; P3.7 tightens this once re-issue-on-refresh lands.
 */
const ROOM_TOKEN_LIFETIME_DAYS = 30;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
export const ROOM_TOKEN_LIFETIME_MS =
  ROOM_TOKEN_LIFETIME_DAYS *
  HOURS_PER_DAY *
  MINUTES_PER_HOUR *
  SECONDS_PER_MINUTE *
  MS_PER_SECOND;

/** A human's decision on a pending room.join request -- reject carries an optional reason, mirroring rejectConnection's own equivalent room-independent decision. */
export type RoomJoinDecision =
  { kind: "accept" } | { kind: "reject"; reason?: string };

/**
 * Bound on pending delivery events held per target agent. Events beyond the bound drop oldest-first: a long-offline agent's queue cannot grow without limit in memory or in synced snapshots (#28).
 */
export const MAX_QUEUED_DELIVERIES_PER_AGENT = 100;

/** The coordinator's own bind host -- always loopback, since the mesh coordinator role only ever needs to be reachable from other local peers on this machine. Shared between mesh-store.ts's own init() and PeerLifecycle's handleBecomeCoordinator. */
export const COORDINATOR_HOST = "127.0.0.1";

/** Shallow-clones an entry together with its own `readBy` array, so a merged history never shares mutable array references with either input it was built from. */
function cloneWithReadBy<T extends { readBy: string[] }>(entry: T): T {
  return { ...entry, readBy: [...entry.readBy] };
}

/**
 * Merge an incoming append-only message history with the local one, returning a new array: entries the local list does not have are appended, and read receipts are unioned on the ones it does. Local ordering is preserved; unseen entries are appended. Neither input array (nor its entries) is mutated -- the caller is responsible for storing the returned array back wherever the local history is kept.
 */
export function mergeMessageHistories<
  T extends { id: string; readBy: string[] },
>(local: readonly T[], incoming: readonly T[]): T[] {
  const merged = local.map((m) => cloneWithReadBy(m));
  const byId = new Map(merged.map((m) => [m.id, m]));
  for (const msg of incoming) {
    const existing = byId.get(msg.id);
    if (existing === undefined) {
      const copy = cloneWithReadBy(msg);
      merged.push(copy);
      byId.set(msg.id, copy);
      continue;
    }
    for (const reader of msg.readBy) {
      if (!existing.readBy.includes(reader)) existing.readBy.push(reader);
    }
  }
  return merged;
}
