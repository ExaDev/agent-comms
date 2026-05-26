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
import type { DiscoveredMesh, DiscoveryBackend, AdvertiseOptions } from "./discovery.js";

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

export class MdnsDiscoveryBackend implements DiscoveryBackend {
  readonly name = "mdns";

  private socket: dgram.Socket | undefined;
  private beaconTimer: ReturnType<typeof setInterval> | undefined;
  private currentPayload: BeaconPayload | undefined;
  private isListening = false;

  async startAdvertising(opts: AdvertiseOptions): Promise<string> {
    const id = `mdns-${opts.port}`;

    this.currentPayload = {
      type: "agent-comms-beacon",
      name: opts.name,
      port: opts.port,
      policies:
        opts.policy === "name-only" ? ["name-only"] : ["full"],
    };

    await this.ensureListening();
    this.startBeacon();

    return id;
  }

  async stopAdvertising(id: string): Promise<void> {
    void id;

    if (this.beaconTimer !== undefined) {
      clearInterval(this.beaconTimer);
      this.beaconTimer = undefined;
    }

    this.currentPayload = undefined;

    // Only close the socket if we're not also discovering
    if (this.socket && !this.hasActiveListeners()) {
      this.socket.close();
      this.socket = undefined;
      this.isListening = false;
    }
  }

  /** Stop all beacon activity and close the socket. */
  async stop(): Promise<void> {
    if (this.beaconTimer !== undefined) {
      clearInterval(this.beaconTimer);
      this.beaconTimer = undefined;
    }

    this.currentPayload = undefined;

    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
      this.isListening = false;
    }
  }

  async discover(
    timeout: number = DEFAULT_DISCOVER_TIMEOUT_MS,
  ): Promise<DiscoveredMesh[]> {
    const discovered = new Map<string, DiscoveredMesh>();

    await this.ensureListening();

    // Collect beacons for the specified duration
    const handler = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      const mesh = this.parseBeacon(msg, rinfo);
      if (mesh) {
        const key = `${mesh.host}:${mesh.port}`;
        discovered.set(key, mesh);
      }
    };

    this.socket!.on("message", handler);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, timeout);
    });

    this.socket!.off("message", handler);
    this.cleanupSocket();

    return [...discovered.values()];
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async ensureListening(): Promise<void> {
    if (this.isListening && this.socket) return;

    const socket = dgram.createSocket({
      type: "udp4",
      reuseAddr: true,
    });

    socket.on("error", () => {
      // Binding errors are non-fatal for discovery — the beacon simply
      // won't reach anyone on this interface.
      this.isListening = false;
    });

    await new Promise<void>((resolve) => {
      socket.bind(BEACON_PORT, () => {
        socket.setBroadcast(true);
        this.isListening = true;
        resolve();
      });
    });

    this.socket = socket;
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
    this.socket.send(
      payload,
      BEACON_PORT,
      "255.255.255.255",
      (err) => {
        if (err) {
          // Broadcast failures are non-fatal — the network may not
          // support broadcast (e.g. some cloud environments).
        }
      },
    );
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
        (parsed as { type: string }).type !== "agent-comms-beacon"
      ) {
        return undefined;
      }

      const beacon = parsed as BeaconPayload;
      const result: DiscoveredMesh = {
        host: rinfo.address,
        port: beacon.port,
        name: beacon.name,
      };
      if (beacon.agents !== undefined) result.agentCount = beacon.agents;
      if (beacon.policies !== undefined) result.policies = beacon.policies;
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

  private cleanupSocket(): void {
    if (
      this.socket &&
      !this.currentPayload &&
      !this.hasActiveListeners()
    ) {
      this.socket.close();
      this.socket = undefined;
      this.isListening = false;
    }
  }
}
