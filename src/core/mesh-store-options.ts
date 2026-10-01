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
  /** The UDP port init() binds the first-contact presence on (agent-comms#341): beacons, probes, and discovered peers fed into the ordinary peer-list flood, so a mesh forms with no coordinator at all. Left out, the store runs no presence: only the bridge entry points set it (bridge-mesh.ts, FIRST_CONTACT_PORT by default), so a store built by anything else, a test included, stays inert and never cross-discovers another store. A bridge-level test overrides it with an OS-assigned free port. */
  readonly firstContactPort?: number | undefined;
  /** How long this store waits for an incumbent's coordinator claim to reach it before claiming the elected role itself (agent-comms#341): after the holder departs, after accepting a claim naming a holder it has no session to, and before a store that may meet others through first contact claims a vacant role. Defaults to ROOM_REQUEST_TIMEOUT_MS; a test shortens it. */
  readonly coordinatorClaimWaitMs?: number | undefined;
  /** Locates this store's persisted bootstrap state. The connectionCodes ledger is per slot. gatewayTrust is shared by every slot in the slot's identity directory, so all stores on a machine (each fronted session included) advertise under one operator decision. */
  readonly slot?: Readonly<IdentitySlot>;
}
