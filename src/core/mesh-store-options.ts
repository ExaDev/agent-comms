/**
 * MeshStore's own constructor options, split out purely to keep mesh-store.ts under the repo's max-lines cap, the same reason WireMeshTransportOptions was split into its own wire-mesh-transport-options.ts.
 */

import type { IdentitySlot } from "./identity-store.js";

/** Construction options for MeshStore. */
export interface MeshStoreOptions {
  /** Localhost TCP port the coordinator role is contested on. Defaults to DEFAULT_COORDINATOR_PORT. */
  readonly coordinatorPort?: number | undefined;
  /** The relay hub this store holds its own session on from init until shutdown, so it is reachable from other machines whatever role it plays locally. Left out, the store never contacts a hub: only the bridge entry points name the production hub (bridge-mesh.ts), so a store built by anything else, a test included, stays local. */
  readonly hubUrl?: string | undefined;
  /** How long a room.join (including a first-contact DM request) may await a human decision, on this store as the receiver and on the transport it is wired to as the sender. Defaults to ROOM_JOIN_APPROVAL_TIMEOUT_MS; a test shortens it. */
  readonly roomJoinApprovalTimeoutMs?: number | undefined;
  /** How old a gossip-discovered device's own last-heard advert may be before listAgents stops trusting whatever presence status it last carried and reports the device offline instead (agent-comms#301). Defaults to DEFAULT_PRESENCE_STALE_AFTER_MS; a test shortens it to observe staleness without waiting out the real default. */
  readonly presenceStaleAfterMs?: number | undefined;
  /** Locates this store's persisted bootstrap state. The connectionCodes ledger is per slot. gatewayTrust is shared by every slot in the slot's identity directory, so all stores on a machine (each fronted session included) advertise under one operator decision. */
  readonly slot?: Readonly<IdentitySlot>;
}
