/**
 * transport-events -- builds the TransportEvents object a bridge hands its WireMeshTransport, dispatching each transport event to whichever MeshStore collaborator owns it. A free function over the collaborators rather than a method on MeshStore, split out purely to keep mesh-store.ts under the repo's max-lines cap, the same reason agent-registry.ts, delivery-engine.ts and their siblings were split out of it.
 */

import type { TransportEvents } from "./transport.js";
import type { ConnectionApproval } from "./connection-approval.js";
import type { CoordinatorRole } from "./coordinator-role.js";
import type { DeliveryEngine } from "./delivery-engine.js";
import type { PeerLifecycle } from "./peer-lifecycle.js";
import type { RoomProtocol } from "./room-protocol.js";

/** The MeshStore collaborators each transport event is dispatched to. reportError is the store's own error channel, an arrow field that reads the mutable onError each time it runs, so a handler a caller sets after this object was built is still the one that receives the error. */
export interface TransportEventTargets {
  peerLifecycle: PeerLifecycle;
  connectionApproval: ConnectionApproval;
  deliveryEngine: DeliveryEngine;
  roomProtocol: RoomProtocol;
  coordinatorRole: CoordinatorRole;
  reportError: (error: unknown) => void;
}

/** The TransportEvents object bridges pass to the transport constructor. */
export function createTransportEvents(
  store: Readonly<TransportEventTargets>,
): TransportEvents {
  // Every handler below runs on what a peer sent, so a failure in one is reported through the store and never left as an unhandled rejection.
  const detach = (work: Readonly<Promise<unknown>>): void => {
    work.catch(store.reportError);
  };
  return {
    onMessage: (handle, msg) => {
      detach(store.peerLifecycle.handleDataMessage(handle, msg));
    },
    onPeerConnected: (handle, info) => {
      detach(store.peerLifecycle.handlePeerConnected(handle, info));
    },
    onPeerDisconnected: (handle) => {
      store.peerLifecycle.handlePeerDisconnected(handle);
    },
    onIntroduction: (handle, msg) => {
      detach(store.peerLifecycle.handleIntroduction(handle, msg));
    },
    onPeerList: (peers) => {
      store.peerLifecycle.handlePeerList(peers);
    },
    onPeerJoined: (peer) => {
      store.peerLifecycle.handlePeerJoined(peer);
    },
    onBecomeCoordinator: (peerList) => {
      // A handover this side cannot honour (the outgoing coordinator's port never freed, say) leaves the mesh without a coordinator until the next crash race, which is worth reporting rather than losing to an unhandled rejection.
      void store.peerLifecycle
        .handleBecomeCoordinator(peerList)
        .catch(store.reportError);
    },
    onConnectionRequest: (handle, request) => {
      store.connectionApproval.handleConnectionRequest(handle, request);
    },
    onError: store.reportError,
    onRevocationAnnounce: (entry) => {
      detach(store.deliveryEngine.handleRevocationAnnounce(entry));
    },
    onCoordinatorClaim: (handle, frame) => {
      void store.coordinatorRole
        .handleClaim(handle, frame)
        .catch(store.reportError);
    },
    onElectionSessionEnrolled: (handle) => {
      void store.coordinatorRole.announceTo(handle).catch(store.reportError);
    },
    onPresenceAdvert: (handle, status) => {
      store.deliveryEngine.handlePresenceAdvert(handle.id, status);
    },
    onDeviceReachable: (deviceHex) => {
      detach(store.roomProtocol.flushPendingRoomRequests(deviceHex));
    },
  };
}
