/**
 * Tailscale discovery backend — probes tailnet peers for mesh coordinators.
 *
 * Queries the Tailscale local API to get tailnet peers, then probes each
 * peer's port 19876 with a TCP connection attempt (timeout 500ms).
 * If reachable, the peer is added as a discovered mesh.
 *
 * No broadcasting is needed — Tailscale already knows all peers.
 * startAdvertising() is a no-op since the coordinator already listens
 * on the Tailscale IP.
 */

import * as http from "node:http";
import * as net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  DiscoveredMesh,
  DiscoveryBackend,
  AdvertiseOptions,
} from "./discovery.js";

const execFileAsync = promisify(execFile);
const TCP_PROBE_TIMEOUT_MS = 500;
const DEFAULT_DISCOVER_TIMEOUT_MS = 5_000;
const COORDINATOR_PORT = 19876;
const TAILSCALE_API_PORT = 49156;

// ---------------------------------------------------------------------------
// Tailscale peer types (from tailscale status --json)
// ---------------------------------------------------------------------------

interface TailscalePeer {
  TailscaleIPs?: string[];
  HostName?: string;
  DNSName?: string;
  Online?: boolean;
  UserID?: string;
}

interface TailscaleStatus {
  Peer?: Record<string, TailscalePeer>;
  Self?: TailscalePeer;
}

function parseTailscaleStatus(raw: unknown): TailscaleStatus {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Invalid TailscaleStatus: expected object");
  }
  return raw satisfies TailscaleStatus;
}

// ---------------------------------------------------------------------------
// Tailscale backend
// ---------------------------------------------------------------------------

export class TailscaleDiscoveryBackend implements DiscoveryBackend {
  readonly name = "tailscale";

  /** No-op — the coordinator already listens on the Tailscale IP. */
  startAdvertising(opts: AdvertiseOptions): Promise<string> {
    return Promise.resolve(`tailscale-${String(opts.port)}`);
  }

  /** No-op — nothing to stop. */
  stopAdvertising(id: string): Promise<void> {
    void id;
    return Promise.resolve();
  }

  /** Stop discovery — no-op since Tailscale has no persistent state to clean up. */
  stop(): Promise<void> {
    // Tailscale discovery is stateless — each discover() call probes peers fresh.
    // No persistent connections or timers to tear down.
    return Promise.resolve();
  }

  /**
   * Discover meshes on the tailnet by probing peers.
   * Returns peers that respond to a TCP connection on port 19876.
   */
  async discover(timeout?: number): Promise<DiscoveredMesh[]> {
    void timeout;

    const peers = await this.getPeers();
    if (peers.length === 0) return [];

    const probes = peers.map((peer) => this.probePeer(peer));
    const results = await Promise.allSettled(probes);

    const discovered: DiscoveredMesh[] = [];
    for (const result of results) {
      if (result.status === "fulfilled" && result.value !== undefined) {
        discovered.push(result.value);
      }
    }

    return discovered;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Get tailnet peers via `tailscale status --json`.
   * Falls back to the local API at localhost:49156 if the CLI is unavailable.
   */
  private async getPeers(): Promise<{ ip: string; hostname: string }[]> {
    const status = await this.fetchTailscaleStatus();
    if (!status?.Peer) return [];

    const peers: { ip: string; hostname: string }[] = [];
    for (const [, peer] of Object.entries(status.Peer)) {
      if (!peer.Online) continue;
      const ips = peer.TailscaleIPs;
      if (!ips || ips.length === 0) continue;
      // Use the first IPv4 address
      const ip = ips.find((addr) => addr.includes(".")) ?? ips[0];
      if (!ip) continue;
      const hostname =
        peer.HostName ?? peer.DNSName?.replace(/\.tailnet.*$/, "") ?? ip;
      peers.push({ ip, hostname });
    }

    return peers;
  }

  /**
   * Fetch Tailscale status. Tries the CLI first, falls back to the local API.
   */
  private async fetchTailscaleStatus(): Promise<TailscaleStatus | undefined> {
    // Try CLI first
    try {
      const { stdout } = await execFileAsync("tailscale", ["status", "--json"]);
      return parseTailscaleStatus(JSON.parse(stdout));
    } catch {
      // CLI not available — try the local API
    }

    // Fall back to local API
    try {
      return await this.fetchLocalApi();
    } catch {
      return undefined;
    }
  }

  /** Query the Tailscale local API at localhost:49156. */
  private fetchLocalApi(): Promise<TailscaleStatus> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://localhost:${String(TAILSCALE_API_PORT)}/localapi/v0/status`,
        { timeout: DEFAULT_DISCOVER_TIMEOUT_MS },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            try {
              resolve(
                parseTailscaleStatus(
                  JSON.parse(Buffer.concat(chunks).toString()),
                ),
              );
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Tailscale local API timeout"));
      });
    });
  }

  /** Probe a single Tailscale peer for a listening mesh coordinator. */
  private probePeer(peer: {
    ip: string;
    hostname: string;
  }): Promise<DiscoveredMesh | undefined> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(undefined);
      }, TCP_PROBE_TIMEOUT_MS);

      socket.connect(COORDINATOR_PORT, peer.ip, () => {
        clearTimeout(timer);
        socket.destroy();
        resolve({
          host: peer.ip,
          port: COORDINATOR_PORT,
          name: peer.hostname,
        });
      });

      socket.on("error", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(undefined);
      });
    });
  }
}
