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
export const ROOM_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** A human's decision on a pending room.join request -- reject carries an optional reason, mirroring rejectConnection's own equivalent room-independent decision. */
export type RoomJoinDecision =
  { kind: "accept" } | { kind: "reject"; reason?: string };

/**
 * Bound on pending delivery events held per target agent. Events beyond the bound drop oldest-first: a long-offline agent's queue cannot grow without limit in memory or in synced snapshots (#28).
 */
export const MAX_QUEUED_DELIVERIES_PER_AGENT = 100;

/**
 * Merge an incoming append-only message history into the local one: add entries the local list does not have and union read receipts on the ones it does. Local ordering is preserved; unseen entries are appended.
 */
export function mergeMessageHistories<
  T extends { id: string; readBy: string[] },
>(local: T[], incoming: T[]): void {
  const byId = new Map(local.map((m) => [m.id, m]));
  for (const msg of incoming) {
    const existing = byId.get(msg.id);
    if (existing === undefined) {
      local.push(msg);
      byId.set(msg.id, msg);
      continue;
    }
    for (const reader of msg.readBy) {
      if (!existing.readBy.includes(reader)) existing.readBy.push(reader);
    }
  }
}
