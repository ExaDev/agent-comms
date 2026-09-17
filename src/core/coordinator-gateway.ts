/**
 * CoordinatorGateway — attaches the cross-machine gateway role to this machine's local coordinator (agent-comms#154, agent-comms#153's first leg). A bridge that becomes the mesh's local coordinator, whether by a fresh bind (MeshStore's own init()) or a takeover (PeerLifecycle's own handleBecomeCoordinator), also becomes the machine's gateway: it dials the hub and holds the connection for as long as it holds the coordinator role. Losing the role, gracefully or by crash, drops the connection; the next coordinator re-dials as part of taking over. Hub-side state is therefore rebuilt from scratch on every takeover -- messages in flight during the gap are lost, the same loss class as a coordinator crash today, now on the data path. Forwarding local agents onto the hub and merging its directory back (agent-comms#155) is deliberately not this class's concern; it owns only the connection lifecycle.
 */

export interface CoordinatorGatewayDeps {
  /** The hub URL this machine's gateway dials -- configuration, defaulting to DEFAULT_HUB_URL (mesh-store-shared.ts). */
  hubUrl: string;
  /** Dials the hub. Backed by the transport's own optional connectHub -- a transport with no gateway capability is never asked to redial by anything else in this class. */
  connectHub: (url: string) => Promise<void>;
  /** Drops the held hub connection, if any. Backed by the transport's own optional disconnectHub. */
  disconnectHub: () => Promise<void>;
  /** Reports a hub-dial failure. Never invoked for anything else -- onBecameCoordinator's own guarantee (see its doc comment) is that a hub problem is always reported this way, never thrown, so this is the only signal a caller gets that the gateway role didn't actually connect. */
  onError?: (error: Error) => void;
}

export class CoordinatorGateway {
  private connected = false;

  constructor(private readonly deps: Readonly<CoordinatorGatewayDeps>) {}

  /** Whether this side currently holds the gateway role: it has dialled the hub and has not since lost coordinator status. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Dials the hub for this machine's gateway role. Idempotent: a call while already connected is a no-op, since nothing in this codebase's own coordinator-election machinery re-fires "became coordinator" without an intervening onLostCoordinator -- this guard is defensive, not a known double-fire path. Never throws: local coordinator election (the whole reason this side is calling this at all) must not depend on the hub being reachable, so a dial failure is reported via deps.onError and swallowed here, leaving isConnected false so a later onBecameCoordinator call retries rather than being blocked by the earlier failure's own idempotency guard. */
  async onBecameCoordinator(): Promise<void> {
    if (this.connected) return;
    try {
      await this.deps.connectHub(this.deps.hubUrl);
      this.connected = true;
    } catch (error) {
      this.deps.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /** Drops this machine's held hub connection. A no-op if this side never became the gateway, or already lost the role -- MeshStore.shutdown() calls this unconditionally regardless of coordinator status, so this guard is what makes that safe rather than a redundant extra close. */
  async onLostCoordinator(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.deps.disconnectHub();
  }
}
