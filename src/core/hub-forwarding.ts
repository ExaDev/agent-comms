/**
 * hub-forwarding -- agent-comms#155's gateway forwarding, split from wire-mesh-transport.ts under the repo's max-lines cap. Outbound: filters a directory of gossiped local devices down to the ones eligible for cross-machine advertisement (an agent/self-bearing entry, meaning only ever a "visible" agent -- see AGENT_SELF_GOSSIP_KEY's own doc for why no separate visibility check is needed here) and pushes them onto a connected HubSession, best-effort. Local-to-remote routing: falls a room-domain request back through the hub's own relay-connect/relay-data pairing when its target isn't a local peer session.
 */

import type {
  CapabilityScope,
  CapabilityToken,
  ManageCommand,
  PeerAdvert,
} from "wire-mesh-core/generated/protocol";
import type {
  AcceptedMeshSession,
  DirectoryEntry,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import type { HubSession } from "./hub-session.js";
import { AGENT_SELF_GOSSIP_KEY } from "./gossip-extensions.js";

/** Forwards every directory entry carrying an agent/self extension onto hub, if hub currently holds a live connection AND at least one remote gateway is currently trusted -- a no-op otherwise. The trust gate (agent-comms#156, GatewayTrust.hasAny's own doc) is coarse by necessity: wire-mesh-core's relay-hub broadcasts a gossip frame to every connected peer with no per-recipient targeting, so "advertise only to allowlisted remote gateways" can only be approximated as "advertise nothing at all until the operator has trusted someone" -- it is not a per-recipient filter. Called both from WireMeshTransport's own watchForDisconnect (as each local peer session's directory changes) and from connectHub's own initial catch-up push, so this side's already-known local devices reach the hub immediately on taking over the gateway role rather than waiting for their own next periodic gossip tick. Forwards unconditionally on every call once past the gates above (no caching or dedup against a previous call), mirroring relay-hub.ts's own "forward every gossip frame, as received" philosophy: an advert's own snapshot-seconds/addresses are meant to keep propagating as a liveness heartbeat, so suppressing a "duplicate" would silently stop legitimate freshness updates from reaching remote gateways. A forward that fails is reported via onError and swallowed, matching every other best-effort gossip send in this codebase. */
export function forwardAdvertsToHub(
  hub: Readonly<Pick<HubSession, "isConnected" | "advertiseDevices">>,
  directory: readonly DirectoryEntry[],
  onError: ((error: Error) => void) | undefined,
  hasAnyTrustedGateway: () => boolean,
): void {
  if (!hub.isConnected) return;
  if (!hasAnyTrustedGateway()) return;
  const eligible = directory.filter(
    (entry) => entry.advert[AGENT_SELF_GOSSIP_KEY] !== undefined,
  );
  if (eligible.length === 0) return;
  hub.advertiseDevices(eligible).catch((error: unknown) => {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  });
}

/** Catches the hub up with every local device already known at the moment this side becomes the gateway (connectHub's own trailing call, right after hub.connect resolves) -- without this, a device whose own last gossip arrived before this coordinator took over the gateway role would never be (re-)advertised until its own next periodic gossip tick (hub-side state is rebuilt from scratch on every takeover, per coordinator-gateway.ts's own class doc). Reuses forwardAdvertsToHub's own eligibility filter and trust gate, so only ever a visible, agent/self-bearing device is pushed, and only once a remote gateway is trusted, exactly as an ordinary directory-change forward would. */
export function pushHubCatchUp(
  hub: Readonly<Pick<HubSession, "isConnected" | "advertiseDevices">>,
  knownDevices: ReadonlyMap<string, Readonly<PeerAdvert>>,
  onError: ((error: Error) => void) | undefined,
  hasAnyTrustedGateway: () => boolean,
): void {
  const catchUp = [...knownDevices.values()].map((advert) => ({
    device: advert.device,
    advert,
  }));
  forwardAdvertsToHub(hub, catchUp, onError, hasAnyTrustedGateway);
}

/** Builds a forwardToLocalPeer callback closing over peerSessions -- a factory rather than a plain function taking peerSessions as its own first parameter, so the returned callback's shape matches HubSessionDeps.forwardToLocalPeer's own fixed external contract exactly (deviceHex, command, scope, token?) with no positional-binding tricks needed at the call site. Sends a room-domain manage-request to a LOCAL peer session only, never falling back to hub routing -- HubSession's own toDevice-forwarding leg (agent-comms#184: a hub-relayed request explicitly addressed to a non-gateway local peer this gateway also fronts). Returns undefined when no local session exists for that device-id, in which case HubSession falls back to dispatching the request against this gateway's own local state instead. */
export function makeSendToLocalPeer(
  peerSessions: ReadonlyMap<
    string,
    Readonly<Pick<AcceptedMeshSession, "sendManageRequest">>
  >,
): (
  memberId: string,
  command: ManageCommand,
  scope: Readonly<CapabilityScope>,
  token?: CapabilityToken,
) => Promise<ManageOutcome> | undefined {
  // Deliberately not `async`: the "no local session" signal is a synchronous `undefined` (HubSession branches on `forwarded !== undefined` to decide whether to fall back to local dispatch), and an async wrapper would turn it into a Promise that is always defined.
  return (
    memberId,
    command,
    scope,
    token,
  ): Promise<ManageOutcome> | undefined => {
    const session = peerSessions.get(memberId);
    if (session === undefined) return undefined;
    return session.sendManageRequest(command, scope, undefined, token);
  };
}

/** Routes a room-domain request through the hub's relay-connect/relay-data pairing when memberId isn't a local peer session -- WireMeshTransport.sendRoomRequest's own fallback, since the member may be a remote agent reachable only via this machine's gateway connection (agent-comms#155's local-to-remote leg). WireMeshTransport.sendRoomRequest itself gates memberId against the gateway trust boundary (agent-comms#156) before ever calling this, so by the time this runs memberId is already known-trusted -- this function stays focused on the hub-connectivity outcome alone. Resolves the same not_connected outcome sendRoomRequest already returned before the hub existed at all when this side isn't currently the gateway. */
export async function routeRoomRequestViaHub(options: {
  hub: Readonly<Pick<HubSession, "isConnected" | "sendRoomRequest">>;
  memberId: string;
  command: ManageCommand;
  scope: Readonly<CapabilityScope>;
  token?: CapabilityToken | undefined;
}): Promise<ManageOutcome> {
  const { hub, memberId, command, scope, token } = options;
  if (!hub.isConnected) return { result: "error", code: "not_connected" };
  return hub.sendRoomRequest(memberId, command, scope, token);
}

/** Dials the hub and immediately pushes a catch-up of every already-known local device onto it (agent-comms#154's own hub-connection-establishment sequence, kept together here rather than split across two call-site statements in WireMeshTransport.connectHub) -- without the trailing catch-up, a device whose own last gossip arrived before this coordinator took over the gateway role would stay invisible on the hub until its own next periodic gossip tick. */
export async function connectHubGateway(options: {
  hub: Readonly<
    Pick<HubSession, "isConnected" | "advertiseDevices" | "connect">
  >;
  url: string;
  knownDevices: ReadonlyMap<string, Readonly<PeerAdvert>>;
  onError: ((error: Error) => void) | undefined;
  hasAnyTrustedGateway: () => boolean;
}): Promise<void> {
  const { hub, url, knownDevices, onError, hasAnyTrustedGateway } = options;
  await hub.connect(url);
  pushHubCatchUp(hub, knownDevices, onError, hasAnyTrustedGateway);
}
