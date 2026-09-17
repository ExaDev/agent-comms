/**
 * listener-registry -- WireMeshTransport's own operator-registered listener bookkeeping (addListener/removeListener/listListeners, plus the advertisedAddresses list they feed), split out under the repo's max-lines cap the same reason hub-session.ts, connection-approval.ts, room-router.ts, peer-lifecycle.ts, and gossip-directory.ts were each split from the same file. Free functions over a TrackedListener registry (WireMeshTransport's own coordinatorListeners Map, passed in directly) rather than a class, since WireMeshTransport already owns and mutates that Map itself and every other piece of split-out state in this file follows the same shape. Deliberately excludes the default bootstrap coordinator listener (startDataServer/becomeCoordinator's own concern) -- this registry only ever tracks listeners an operator explicitly registered via addListener.
 */

import { nanoid } from "./nanoid.js";
import type {
  Connection,
  Listener,
  Transport,
} from "wire-mesh-core/ports/transport";
import type { ListenerInfo, ListenerPolicy } from "./transport.js";

/** Length of the random id minted for a tracked listener -- shared with WireMeshTransport's own becomeCoordinator, which mints an id for the default bootstrap listener the same way, outside this registry. */
export const LISTENER_ID_LENGTH = 8;

export interface TrackedListener {
  listener: Listener;
  policy: ListenerPolicy;
  host: string;
  port: number;
  isDefault: boolean;
}

/** Reads the port a listener actually bound, from its own reported address -- never the port it was asked to bind, which is 0 whenever the caller wanted the OS to assign a free one. Bookkeeping that stores the requested port instead silently reports 0 for every OS-assigned listener. */
export function listenerPort(listener: Readonly<Listener>): number {
  const port = listener.address.split(":").pop();
  return port === undefined ? 0 : Number(port);
}

/** Registers a new listener at host:port under the given policy, tracking it in coordinatorListeners (mutated in place) and dispatching every accepted connection to onAccepted -- WireMeshTransport.addListener's own body, unchanged in behaviour. */
export async function registerListener(
  wireTransport: Readonly<Pick<Transport, "listen">>,
  coordinatorListeners: Map<string, TrackedListener>,
  host: string,
  port: number,
  policy: ListenerPolicy,
  onAccepted: (connection: Readonly<Connection>) => void,
): Promise<string> {
  const id = nanoid(LISTENER_ID_LENGTH);
  const listener = await wireTransport.listen(
    `${host}:${String(port)}`,
    onAccepted,
  );
  coordinatorListeners.set(id, {
    listener,
    policy,
    host,
    port: listenerPort(listener),
    isDefault: false,
  });
  return id;
}

/** Closes and untracks a previously registered listener -- WireMeshTransport.removeListener's own body, unchanged in behaviour. Throws if id names the default bootstrap listener (never registered through registerListener, so never removable through this path); a no-op if id names no tracked listener at all. */
export async function unregisterListener(
  coordinatorListeners: Map<string, TrackedListener>,
  defaultListenerId: string | undefined,
  id: string,
): Promise<void> {
  if (id === defaultListenerId) {
    throw new Error("Cannot remove the default listener");
  }
  const tracked = coordinatorListeners.get(id);
  if (tracked === undefined) return;
  coordinatorListeners.delete(id);
  await tracked.listener.close();
}

/** Every currently tracked listener, in the shape ListenerInfo exposes externally -- WireMeshTransport.listListeners's own body, unchanged in behaviour. */
export function listTrackedListeners(
  coordinatorListeners: ReadonlyMap<string, Readonly<TrackedListener>>,
): ListenerInfo[] {
  return [...coordinatorListeners.entries()].map(([id, tracked]) => ({
    id,
    host: tracked.host,
    port: tracked.port,
    policy: tracked.policy,
    isDefault: tracked.isDefault,
  }));
}

/** This side's own directly-reachable "host:port" candidates (wire-mesh#38), passed into every acceptMeshSession call's own self-advert -- WireMeshTransport's own advertisedAddresses getter body, unchanged in behaviour. Deliberately excludes the default bootstrap coordinator listener -- it always binds COORDINATOR_HOST (127.0.0.1, hardcoded, never configurable), which is meaningless to advertise to a remote peer -- and includes only listeners an operator explicitly registered via addListener, which by construction represent a deliberate "make me reachable from elsewhere" declaration. */
export function advertisedListenerAddresses(
  coordinatorListeners: ReadonlyMap<string, Readonly<TrackedListener>>,
): string[] {
  return [...coordinatorListeners.values()]
    .filter((tracked) => !tracked.isDefault)
    .map((tracked) => `${tracked.host}:${String(tracked.port)}`);
}
