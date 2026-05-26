/**
 * Discovery — mesh discovery interface and manager.
 *
 * Defines the contract for discovery backends (mDNS, Tailscale, etc.)
 * and a manager that routes calls to the appropriate backend.
 * Discovery is opt-in — no broadcasting unless the agent explicitly
 * calls mesh_advertise.
 */

// ---------------------------------------------------------------------------
// Discovered mesh
// ---------------------------------------------------------------------------

export interface DiscoveredMesh {
  /** Host address of the discovered mesh coordinator. */
  host: string;
  /** Port the coordinator is listening on. */
  port: number;
  /** Human-readable mesh name (from mDNS TXT record or Tailscale hostname). */
  name: string;
  /** Number of agents in the mesh (if available). */
  agentCount?: number;
  /** Connection policies available (if advertised). */
  policies?: string[];
}

// ---------------------------------------------------------------------------
// Advertise options
// ---------------------------------------------------------------------------

export interface AdvertiseOptions {
  /** Service name for mDNS / identifier for the mesh. */
  name: string;
  /** Port to advertise. */
  port: number;
  /** Network adapter/address to broadcast on. */
  adapter?: string;
  /** What information to reveal in discovery responses. */
  policy?: "full" | "name-only";
}

// ---------------------------------------------------------------------------
// Discovery backend interface
// ---------------------------------------------------------------------------

export interface DiscoveryBackend {
  readonly name: string;
  startAdvertising(opts: AdvertiseOptions): Promise<string>;
  stopAdvertising(id: string): Promise<void>;
  discover(timeout?: number): Promise<DiscoveredMesh[]>;
}

// ---------------------------------------------------------------------------
// Discovery manager
// ---------------------------------------------------------------------------

export class DiscoveryManager {
  private backends = new Map<string, DiscoveryBackend>();
  private activeAdvertisements = new Map<string, string>();

  /** Register a discovery backend. */
  registerBackend(backend: DiscoveryBackend): void {
    this.backends.set(backend.name, backend);
  }

  /** Start advertising on a specific backend. Returns an advertisement ID. */
  async advertise(
    backendName: string,
    opts: AdvertiseOptions,
  ): Promise<string> {
    const backend = this.backends.get(backendName);
    if (!backend) {
      throw new Error(
        `Unknown discovery backend: "${backendName}". Available: ${[...this.backends.keys()].join(", ")}`,
      );
    }
    const id = await backend.startAdvertising(opts);
    this.activeAdvertisements.set(id, backendName);
    return id;
  }

  /** Stop a previously started advertisement. */
  async stopAdvertising(id: string): Promise<void> {
    const backendName = this.activeAdvertisements.get(id);
    if (!backendName) return;
    const backend = this.backends.get(backendName);
    if (!backend) return;
    await backend.stopAdvertising(id);
    this.activeAdvertisements.delete(id);
  }

  /**
   * Discover meshes using a specific backend (or all backends if no name given).
   * Returns deduplicated results.
   */
  async discover(
    backendName?: string,
    timeout?: number,
  ): Promise<DiscoveredMesh[]> {
    const targets =
      backendName !== undefined
        ? [this.backends.get(backendName)].filter(
            (b): b is DiscoveryBackend => b !== undefined,
          )
        : [...this.backends.values()];

    const results = await Promise.all(
      targets.map((b) => b.discover(timeout)),
    );

    // Deduplicate by host+port
    const seen = new Set<string>();
    const deduped: DiscoveredMesh[] = [];
    for (const meshes of results) {
      for (const mesh of meshes) {
        const key = `${mesh.host}:${mesh.port}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(mesh);
        }
      }
    }
    return deduped;
  }
}
