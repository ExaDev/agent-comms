/**
 * Shared constants and helpers for MeshStore and its collaborator classes — module-level constants, types, and free functions with no `this` dependency, split out purely to keep mesh-store.ts under the repo's max-lines cap.
 */

import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { RevocationView } from "wire-mesh-core/domain/revocation-view";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import type { IdentitySlot } from "./identity-store.js";
import type { AccountLedger } from "./account-ledger.js";
import type { UserIdentityOptions } from "./user-identity.js";
import type { MachineIdentityOptions } from "./machine-identity.js";

/** The identity/clock/persistence collaborators MeshStore mints and persists room-membership grants against. Set via setIdentity(), mirroring the transport's own setTransport() contract. dataStorage backs this device's own room-notice oplog (P5, agent-comms#50): the same KeyValueStorage instance WireMeshTransport's own dataStorage constructor parameter is wired with, so a durable sendRoomMessage and the transport's own data-domain responder read and write the identical log. userIdentity/userIdentityOptions are the user-principal identity (user-identity.ts, agent-comms#160) this store's own bridge slot shares with every other bridge of this account, distinct from `identity`, which is this specific bridge's own per-slot device identity; userIdentity is what a dm:send grant (agent-comms#162) is minted and verified against. accountLedger is the account's replicated, encrypted grant ledger (account-ledger.ts, agent-comms#344), where every grant this principal mints is recorded so any machine holding the account key can revoke it. userIdentityOptions locates the file userIdentity was loaded from, which the account's own join flow (account-join.ts) reads to seal the key for a joining machine and writes to import one it joins. machineIdentity is this account's machine identity for the host (machine-identity.ts, agent-comms#343), shared by every bridge the account runs there: the second grouping issuer this store's device is vouched for by. machineIdentityOptions locates the file it was loaded from, where the machine's self display name (agent-comms#345) is kept. */
export interface MeshStoreIdentity {
  identity: IdentityPort;
  clock: Clock;
  slot: IdentitySlot;
  revocation: RevocationView;
  dataStorage: KeyValueStorage;
  userIdentity: IdentityPort;
  accountLedger: AccountLedger;
  /** Where userIdentity's key lives on this machine, for the account's own join flow (account-join.ts) to seal it for a joining machine and to import one it joins. */
  userIdentityOptions: Readonly<UserIdentityOptions>;
  machineIdentity: IdentityPort;
  machineIdentityOptions: Readonly<MachineIdentityOptions>;
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

/** Lifetime of a freshly minted dm:send grant (agent-comms#162) -- the same 30-day generosity ROOM_TOKEN_LIFETIME_MS applies, for the same reason: no periodic re-issue-on-refresh mechanism exists yet for this grant kind either, so a short expiry would just let ordinary admissions go stale with nothing to renew them. */
const DM_SEND_GRANT_LIFETIME_DAYS = 30;
export const DM_SEND_GRANT_LIFETIME_MS =
  DM_SEND_GRANT_LIFETIME_DAYS *
  HOURS_PER_DAY *
  MINUTES_PER_HOUR *
  SECONDS_PER_MINUTE *
  MS_PER_SECOND;

/** The outcome of a pending room.join request: a human's accept or reject (reject carries an optional reason, mirroring rejectConnection's own equivalent room-independent decision), or expiry when nobody decided within the approval window. */
export type RoomJoinDecision =
  | { kind: "accept" }
  | { kind: "reject"; reason?: string }
  | { kind: "expired" };

/**
 * Bound on pending delivery events held per target agent. Events beyond the bound drop oldest-first: a long-offline agent's queue cannot grow without limit in memory or in synced snapshots (#28).
 */
export const MAX_QUEUED_DELIVERIES_PER_AGENT = 100;

/** Bound on directed room-domain requests held for retry per unreachable member. Requests beyond the bound drop oldest-first, and each drop is reported to its own sender as a terminal delivery status, so a message given up on is never left looking merely pending. */
export const MAX_PENDING_ROOM_REQUESTS_PER_MEMBER = 100;

/** How long a directed room-domain request may sit in the retry queue before it is given up on and its sender told it expired. Generous enough to outlast a peer restarting, a laptop sleeping overnight, or a hub outage, all of which a retry genuinely does fix; short enough that a message to a device that is never coming back stops being reported as pending indefinitely. */
const PENDING_ROOM_REQUEST_TTL_HOURS = 24;
export const PENDING_ROOM_REQUEST_TTL_MS =
  PENDING_ROOM_REQUEST_TTL_HOURS *
  MINUTES_PER_HOUR *
  SECONDS_PER_MINUTE *
  MS_PER_SECOND;

/** The coordinator's own bind host -- always loopback, since the mesh coordinator role only ever needs to be reachable from other local peers on this machine. Shared between mesh-store.ts's own init() and PeerLifecycle's handleBecomeCoordinator. */
export const COORDINATOR_HOST = "127.0.0.1";

/** The production relay hub this machine's gateway dials once it becomes the local mesh coordinator (agent-comms#154). Configuration: MeshStore's own constructor accepts an override, threaded from createBridgeMesh/createBridgeMeshSync, for tests and any future non-default deployment; a user picks a different hub for every bridge on the machine with HUB_URL_ENV_VAR (see resolveHubUrl) -- this is only the default. */
export const DEFAULT_HUB_URL = "wss://mesh.exadev.io/";

/** The environment variable that points every bridge started from this environment at a self-hosted hub (for example `npx wire-mesh`) instead of DEFAULT_HUB_URL. */
export const HUB_URL_ENV_VAR = "AGENT_COMMS_HUB_URL";

/**
 * The hub a bridge dials when its caller passes no explicit hubUrl: HUB_URL_ENV_VAR when it is set and not blank, DEFAULT_HUB_URL otherwise.
 *
 * A value that is not a ws:// or wss:// URL throws rather than falling back to DEFAULT_HUB_URL: someone who set the variable meant to keep their traffic off the public hub, so silently dialling it anyway would be the worst outcome.
 */
export function resolveHubUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env[HUB_URL_ENV_VAR]?.trim();
  if (configured === undefined || configured === "") return DEFAULT_HUB_URL;
  let protocol: string;
  try {
    protocol = new URL(configured).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "ws:" && protocol !== "wss:") {
    throw new Error(
      `${HUB_URL_ENV_VAR} must be a ws:// or wss:// URL, got "${configured}"`,
    );
  }
  return configured;
}

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
