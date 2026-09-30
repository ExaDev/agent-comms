/**
 * ElectionSessions: WireMeshTransport's set of live, trusted sessions to peers on this machine, the only sessions coordinator claims are read from and gossiped over (agent-comms#341), since the elected role's duties are per machine. Split out of wire-mesh-transport.ts to keep it under the repo's max-lines cap.
 *
 * A session counts as machine-local when it was accepted on a loopback-only listener (the data server or the default coordinator listener) or dialled at a peer's data server or the well-known port, both of which only ever listen on loopback; a session reached through connectToRemote or an addListener-created listener may cross machines and is never enrolled.
 */

import type { AcceptedMeshSession } from "wire-mesh-core/domain/mesh-session";
import type { CoordinatorFrame } from "wire-mesh-core/generated/protocol";
import type { ConnectionHandle, TransportEvents } from "./transport.js";

export class ElectionSessions {
  private readonly sessions = new Set<AcceptedMeshSession>();

  constructor(
    private readonly events: Readonly<
      Pick<TransportEvents, "onCoordinatorClaim" | "onError">
    >,
  ) {}

  /** Enrols a machine-local session and hands every coordinator-frame its peer gossips to onCoordinatorClaim, for as long as the session lives. */
  enrol(
    session: AcceptedMeshSession,
    handle: Readonly<ConnectionHandle>,
  ): void {
    this.sessions.add(session);
    void (async () => {
      for await (const frame of session.coordinatorFrames) {
        this.events.onCoordinatorClaim(handle, frame);
      }
    })();
  }

  /** Forgets a closed session. A no-op for one never enrolled. */
  delete(session: AcceptedMeshSession): void {
    this.sessions.delete(session);
  }

  clear(): void {
    this.sessions.clear();
  }

  /** Gossips a claim over every enrolled session, best-effort: a peer that misses it learns the incumbent from the next claim or announcement it receives. */
  async broadcast(frame: Readonly<CoordinatorFrame>): Promise<void> {
    await Promise.all(
      [...this.sessions].map(async (session) =>
        session.sendCoordinatorClaim(frame).catch(() => undefined),
      ),
    );
  }

  /** Sends a claim over one session, when it is enrolled; a session that is not machine-local never carries a claim. A failure is reported, since a directed claim is an announcement or an answer its peer is waiting to converge on. */
  async send(
    session: AcceptedMeshSession | undefined,
    handle: Readonly<ConnectionHandle>,
    frame: Readonly<CoordinatorFrame>,
  ): Promise<void> {
    if (session === undefined || !this.sessions.has(session)) return;
    await session.sendCoordinatorClaim(frame).catch((error: unknown) => {
      this.events.onError?.(
        error instanceof Error
          ? error
          : new Error(`sendCoordinatorClaim(${handle.id}): ${String(error)}`),
      );
    });
  }
}
