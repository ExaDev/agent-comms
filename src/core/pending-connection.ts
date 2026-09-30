/**
 * A connect_request held open awaiting a human decision, how long it may wait, and what happens when it waits too long: WireMeshTransport's pending-connection bookkeeping, split out of wire-mesh-transport.ts to keep it under the repo's max-lines cap.
 */

import type {
  AcceptedMeshSession,
  IncomingManageRequest,
} from "wire-mesh-core/domain/mesh-session";
import type { ListenerPolicy } from "./transport.js";

/** How long a connect_request may sit awaiting a human decision before this side gives up and rejects it automatically. Generous on purpose -- this bounds a human approval window, not a network timeout: 5 minutes covers a person genuinely being away from the terminal for a few minutes, while still guaranteeing every unanswered request eventually resolves instead of accumulating in pendingConnections indefinitely. */
const PENDING_CONNECTION_TIMEOUT_MINUTES = 5;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
export const DEFAULT_PENDING_CONNECTION_TIMEOUT_MS =
  PENDING_CONNECTION_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** A human decision on a connect_request: "accept" resumes the still-blocked consumeQuarantined loop as a fully trusted session; "reject" (also used when the requester disconnects before a decision is made) unblocks it to close instead. */
export type ConnectionDecision = "accept" | "reject";

export interface PendingConnection {
  respond: IncomingManageRequest["respond"];
  dataPort: number;
  name: string;
  fingerprint: string;
  policy: ListenerPolicy | undefined;
  /** Held so acceptConnection can trackSession it synchronously, before firing onIntroduction -- that event's own handler (mesh-store's handleIntroduction) sends a reply on this same handle immediately, which needs peerSessions already populated. Waiting for consumeQuarantined's own suspended loop to resume and do it would race: resolve() below only wakes that loop on a later microtask tick, after onIntroduction has already fired. */
  session: AcceptedMeshSession;
  /** Settles the Promise consumeQuarantined is blocked on for this connect_request -- the mechanism by which acceptConnection/rejectConnection resume a loop suspended mid-iteration, without ever needing to re-obtain (and so needing to reason about the identity of) a second iterator over the same session's incomingManageRequests. */
  resolve: (decision: ConnectionDecision) => void;
  /** Auto-rejects this request after the configured pending-connection timeout if no human decision arrives first. Cleared by acceptConnection/rejectConnection/watchForDisconnect's own disconnect path, whichever settles the request first -- an entry is only ever removed from pendingConnections once, so this timer firing after another path already resolved it is structurally impossible, not merely guarded against. */
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/** Auto-rejects a connect_request that has sat unanswered past WireMeshTransport's pendingConnectionTimeoutMs: the same respond-then-resolve shape rejectConnection uses (a real error response, not a silent hang), since unlike watchForDisconnect's own cleanup path the requester's session is still very much alive and waiting to hear back. A no-op if the request was already settled by acceptConnection/rejectConnection/disconnect before this timer fired, since entries are deleted exactly once, by whichever path settles first. */
export function expirePendingConnection(
  pendingConnections: Map<string, PendingConnection>,
  id: string,
): void {
  const pending = pendingConnections.get(id);
  if (pending === undefined) {
    return;
  }
  pendingConnections.delete(id);
  void pending
    .respond({
      result: "error",
      code: "timeout",
      message: "no human decision within the pending-connection timeout",
    })
    .catch(() => undefined);
  pending.resolve("reject");
}
