/**
 * ElectionSessions: WireMeshTransport's set of live, trusted sessions to peers on this machine, the only sessions coordinator claims are read from and gossiped over (agent-comms#341), since the elected role's duties are per machine. Split out of wire-mesh-transport.ts to keep it under the repo's max-lines cap.
 *
 * A session counts as machine-local when it was accepted on a loopback-only listener (the data server or the default well-known port listener) or dialled at a peer's data server or the well-known port, both of which only ever listen on loopback. A session reached through connectToRemote or an addListener-created listener may cross machines and is never enrolled, and neither is one admitted through an approved connect_request, whose dialling side is a connectToRemote session and so never enrols it either.
 *
 * Every session this transport opens is watched from the moment it opens, whether or not it is ever enrolled: a frame is delivered only when its session is enrolled at the moment the frame is read, and is dropped otherwise. So a quarantined session's claims from before its introduce are discarded rather than replayed once it introduces itself, and a session that is never enrolled does not accumulate the frames its peer sends.
 */

import type { AcceptedMeshSession } from "wire-mesh-core/domain/mesh-session";
import type { CoordinatorFrame } from "wire-mesh-core/generated/protocol";
import type { ConnectionHandle, TransportEvents } from "./transport.js";

export class ElectionSessions {
  /** Each enrolled session, with the handle its claims are reported under. */
  private readonly enrolled = new Map<
    AcceptedMeshSession,
    Readonly<ConnectionHandle>
  >();

  constructor(
    private readonly events: Readonly<
      Pick<
        TransportEvents,
        "onCoordinatorClaim" | "onElectionSessionEnrolled" | "onError"
      >
    >,
  ) {}

  /** Starts reading every coordinator-frame the session's peer gossips, for as long as the session lives, handing each to onCoordinatorClaim only while the session is enrolled. Called exactly once per session, as soon as it is opened and before anything could enrol it. */
  watch(
    session: AcceptedMeshSession,
    handle: Readonly<ConnectionHandle>,
  ): void {
    void (async () => {
      for await (const frame of session.coordinatorFrames) {
        if (this.enrolled.has(session)) {
          this.events.onCoordinatorClaim(handle, frame);
        }
      }
    })();
  }

  /** Enrols a trusted machine-local session, then fires onElectionSessionEnrolled so this side tells the peer which claim it accepts. Both ends of every machine-local session enrol it, so each tells the other. */
  enrol(
    session: AcceptedMeshSession,
    handle: Readonly<ConnectionHandle>,
  ): void {
    this.enrolled.set(session, handle);
    this.events.onElectionSessionEnrolled(handle);
  }

  /** Forgets a closed session. A no-op for one never enrolled. */
  delete(session: AcceptedMeshSession): void {
    this.enrolled.delete(session);
  }

  clear(): void {
    this.enrolled.clear();
  }

  /** The device-ids of every peer this side has at least one enrolled session to: the peers that take part in the election with it. */
  peerIds(): ReadonlySet<string> {
    return new Set([...this.enrolled.values()].map((handle) => handle.id));
  }

  /** Gossips a claim over every enrolled session. A send fails only on a connection that is already closing, and each failure is reported; the peer is told the incumbent again when its next session is enrolled. */
  async broadcast(frame: Readonly<CoordinatorFrame>): Promise<void> {
    await Promise.all(
      [...this.enrolled].map(async ([session, handle]) =>
        this.sendOver(session, handle, frame),
      ),
    );
  }

  /** Sends a claim over every enrolled session to one peer, as an announcement or an answer its peer is waiting to converge on; a peer with no enrolled session is not machine-local and never carries a claim. */
  async sendTo(
    peerId: string,
    frame: Readonly<CoordinatorFrame>,
  ): Promise<void> {
    await Promise.all(
      [...this.enrolled]
        .filter(([, handle]) => handle.id === peerId)
        .map(async ([session, handle]) =>
          this.sendOver(session, handle, frame),
        ),
    );
  }

  private async sendOver(
    session: AcceptedMeshSession,
    handle: Readonly<ConnectionHandle>,
    frame: Readonly<CoordinatorFrame>,
  ): Promise<void> {
    await session.sendCoordinatorClaim(frame).catch((error: unknown) => {
      this.events.onError?.(
        error instanceof Error
          ? error
          : new Error(`sendCoordinatorClaim(${handle.id}): ${String(error)}`),
      );
    });
  }
}
