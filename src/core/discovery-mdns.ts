/**
 * mDNS discovery backend — UDP broadcast beacon fallback.
 *
 * Since the `multicast-dns` package is not a dependency, this backend
 * uses a simple UDP broadcast beacon instead:
 *   - Sends a UDP broadcast to port 19877 every 30 seconds
 *   - Listens for beacons from other peers on the same port
 *   - discover() listens for one beacon cycle and returns results
 *
 * If multicast-dns is added as a dependency in the future, a proper
 * mDNS implementation can replace this with _agent-comms._tcp service
 * broadcast and query/response.
 */

import * as dgram from "node:dgram";
import type {
  DiscoveredMesh,
  DiscoveryBackend,
  AdvertiseOptions,
} from "./discovery.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BEACON_PORT = 19877;
const BEACON_INTERVAL_MS = 30_000;
const DEFAULT_DISCOVER_TIMEOUT_MS = 5_000;

interface BeaconPayload {
  type: "agent-comms-beacon";
  name: string;
  port: number;
  agents?: number;
  policies?: string[];
}

// ---------------------------------------------------------------------------
// mDNS (UDP beacon) backend
// ---------------------------------------------------------------------------

export interface MdnsDiscoveryBackendOptions {
  /** The UDP port beacons are bound, sent and heard on. Defaults to the shared beacon port; overridable so tests take an OS-assigned free port rather than contending with a real machine presence. */
  port?: number;
  /** Creates the backend's UDP socket. Defaults to dgram.createSocket; overridable so tests can observe every socket the backend opens and closes. */
  createSocket?: (options: dgram.SocketOptions) => dgram.Socket;
}

export class MdnsDiscoveryBackend implements DiscoveryBackend {
  readonly name = "mdns";

  private readonly port: number;
  private readonly createSocket: (options: dgram.SocketOptions) => dgram.Socket;
  /** The one bind this backend has in flight or has completed: every caller needing the socket awaits this same promise, so concurrent advertise and discover calls share one socket rather than each binding their own. Cleared when the socket is closed or its bind fails, so the next caller binds afresh. */
  private listening: Promise<dgram.Socket> | undefined;
  /** The bound socket, set once its bind completes and cleared when it is closed. */
  private socket: dgram.Socket | undefined;
  private beaconTimer: ReturnType<typeof setInterval> | undefined;
  private currentPayload: BeaconPayload | undefined;

  constructor(options: Readonly<MdnsDiscoveryBackendOptions> = {}) {
    this.port = options.port ?? BEACON_PORT;
    this.createSocket = options.createSocket ?? dgram.createSocket;
  }

  async startAdvertising(opts: Readonly<AdvertiseOptions>): Promise<string> {
    const id = `mdns-${String(opts.port)}`;

    this.currentPayload = {
      type: "agent-comms-beacon",
      name: opts.name,
      port: opts.port,
      policies: opts.policy === "name-only" ? ["name-only"] : ["full"],
    };

    const socket = await this.ensureListening();
    // A stop() that arrived while the socket was binding has already closed it; beaconing now would start a timer nothing ever clears.
    if (this.socket === socket) this.startBeacon();

    return id;
  }

  async stopAdvertising(): Promise<void> {
    await this.settleBinding();
    this.stopBeacon();
    this.currentPayload = undefined;

    // Only close the socket if we're not also discovering
    await this.releaseIfIdle();
  }

  /** Stop all beacon activity and close the socket. */
  async stop(): Promise<void> {
    await this.settleBinding();
    this.stopBeacon();
    this.currentPayload = undefined;
    await this.closeSocket();
  }

  async discover(
    timeout: number = DEFAULT_DISCOVER_TIMEOUT_MS,
  ): Promise<DiscoveredMesh[]> {
    const discovered = new Map<string, DiscoveredMesh>();

    const socket = await this.ensureListening();

    // Collect beacons for the specified duration
    const handler = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      const mesh = this.parseBeacon(msg, rinfo);
      if (mesh) {
        const key = `${mesh.host}:${String(mesh.port)}`;
        discovered.set(key, mesh);
      }
    };

    socket.on("message", handler);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, timeout);
    });

    socket.off("message", handler);
    await this.releaseIfIdle();

    return [...discovered.values()];
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async ensureListening(): Promise<dgram.Socket> {
    this.listening ??= this.bindSocket();
    return this.listening;
  }

  /** Creates and binds the backend's one socket. A failed bind closes the socket it created (Node leaves a socket whose bind failed open) and rejects, so the caller learns the beacon port is unusable instead of waiting forever on a bind callback that never fires. */
  private async bindSocket(): Promise<dgram.Socket> {
    const socket = this.createSocket({
      type: "udp4",
      reuseAddr: true,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(this.port, () => {
          socket.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.listening = undefined;
      socket.close();
      throw error;
    }

    socket.setBroadcast(true);
    // An error on a bound socket leaves it bound and usable, so it is neither closed nor replaced: replacing it is what used to leave the old socket open beside a new one. The listener exists because an "error" event with none would crash the process.
    socket.on("error", () => undefined);
    this.socket = socket;
    return socket;
  }

  /** Waits for a bind still in flight to finish, so the socket it produces is the one a stop closes rather than one that appears after the stop has returned. */
  private async settleBinding(): Promise<void> {
    if (this.listening !== undefined) {
      await Promise.allSettled([this.listening]);
    }
  }

  /** Close the UDP socket and wait for the underlying handle to actually release before resolving. The fields are cleared first, so a caller arriving while the close is in progress binds a fresh socket rather than reusing a closing one. */
  private async closeSocket(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;

    this.socket = undefined;
    this.listening = undefined;
    await new Promise<void>((resolve) => {
      socket.close(() => {
        resolve();
      });
    });
  }

  /** Closes the socket once nothing uses it: no advertisement and no discover() still listening on it. */
  private async releaseIfIdle(): Promise<void> {
    if (this.currentPayload === undefined && !this.hasActiveListeners()) {
      await this.closeSocket();
    }
  }

  private stopBeacon(): void {
    if (this.beaconTimer !== undefined) {
      clearInterval(this.beaconTimer);
      this.beaconTimer = undefined;
    }
  }

  private startBeacon(): void {
    if (this.beaconTimer !== undefined) {
      clearInterval(this.beaconTimer);
    }

    // Send immediately, then on interval
    this.sendBeacon();
    this.beaconTimer = setInterval(() => {
      this.sendBeacon();
    }, BEACON_INTERVAL_MS);
  }

  private sendBeacon(): void {
    if (!this.currentPayload || !this.socket) return;

    const payload = Buffer.from(JSON.stringify(this.currentPayload));
    // Broadcast to the beacon port on the standard broadcast address
    this.socket.send(payload, this.port, "255.255.255.255", (err) => {
      if (err) {
        // Broadcast failures are non-fatal — the network may not
        // support broadcast (e.g. some cloud environments).
      }
    });
  }

  private parseBeacon(
    msg: Buffer,
    rinfo: dgram.RemoteInfo,
  ): DiscoveredMesh | undefined {
    try {
      const parsed: unknown = JSON.parse(msg.toString());

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("type" in parsed) ||
        typeof parsed.type !== "string" ||
        parsed.type !== "agent-comms-beacon"
      ) {
        return undefined;
      }

      if (!("port" in parsed) || typeof parsed.port !== "number")
        return undefined;
      if (!("name" in parsed) || typeof parsed.name !== "string")
        return undefined;
      const result: DiscoveredMesh = {
        host: rinfo.address,
        port: parsed.port,
        name: parsed.name,
      };
      if ("agents" in parsed && typeof parsed.agents === "number")
        result.agentCount = parsed.agents;
      if (
        "policies" in parsed &&
        Array.isArray(parsed.policies) &&
        parsed.policies.every((v) => typeof v === "string")
      )
        result.policies = parsed.policies;
      return result;
    } catch {
      return undefined;
    }
  }

  private hasActiveListeners(): boolean {
    // Check if there are message listeners beyond our own
    if (!this.socket) return false;
    return this.socket.listenerCount("message") > 0;
  }
}
