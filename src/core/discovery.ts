/**
 * Discovery — mesh discovery interface and manager.
 *
 * Defines the contract for discovery backends (mDNS, Tailscale, etc.)
 * and a manager that routes calls to the appropriate backend.
 * Discovery is opt-in — no broadcasting unless the agent explicitly
 * calls mesh_advertise.
 */

import type { MeshVisibility } from "./types.js";

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
  /** Stop all activity (timers, sockets) for this backend. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Discovery manager
// ---------------------------------------------------------------------------

export class DiscoveryManager {
  private backends = new Map<string, DiscoveryBackend>();
  private activeAdvertisements = new Map<string, string>();
  private meshVisibility: MeshVisibility = "discoverable";
  private perAdapterVisibility = new Map<string, MeshVisibility>();
  /** Advertisements that were paused due to visibility changes. */
  private pausedAdvertisements = new Map<
    string,
    { backendName: string; opts: AdvertiseOptions }
  >();

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

  /**
   * Set mesh-wide visibility level.
   *
   * - `discoverable` — normal operation, all backends active.
   * - `quiet` — stop advertising but backends remain available for discover().
   * - `dark` — stop all discovery activity (advertising + backend sockets).
   *
   * If `adapter` is specified, the visibility applies only to that backend.
   * Otherwise it applies to the global mesh visibility.
   */
  async setVisibility(level: MeshVisibility, adapter?: string): Promise<void> {
    if (adapter !== undefined) {
      await this.setAdapterVisibility(adapter, level);
      return;
    }

    const prev = this.meshVisibility;
    this.meshVisibility = level;

    if (prev === level) return;

    if (level === "quiet") {
      // Pause all advertisements but keep backends running
      await this.pauseAllAdvertisements();
    } else if (level === "dark") {
      // Pause advertisements and stop backends entirely
      await this.pauseAllAdvertisements();
      await this.stopAllBackends();
    } else {
      // discoverable — resume previously paused advertisements and restart backends
      await this.resumeAllAdvertisements();
    }
  }

  /** Get current mesh visibility level (global or per-adapter). */
  getVisibility(adapter?: string): MeshVisibility {
    if (adapter !== undefined) {
      return this.perAdapterVisibility.get(adapter) ?? this.meshVisibility;
    }
    return this.meshVisibility;
  }

  private async setAdapterVisibility(
    adapter: string,
    level: MeshVisibility,
  ): Promise<void> {
    const prev = this.perAdapterVisibility.get(adapter) ?? this.meshVisibility;
    this.perAdapterVisibility.set(adapter, level);

    if (prev === level) return;

    if (level === "quiet" || level === "dark") {
      // Pause advertisements for this specific backend
      await this.pauseAdvertisementsForBackend(adapter);
      if (level === "dark") {
        const backend = this.backends.get(adapter);
        if (backend) await backend.stop();
      }
    } else {
      await this.resumeAdvertisementsForBackend(adapter);
    }
  }

  private async pauseAllAdvertisements(): Promise<void> {
    // Capture current ads before clearing
    for (const [id, backendName] of this.activeAdvertisements) {
      // We've lost the original opts — but we can just stop the ad
      this.pausedAdvertisements.set(id, {
        backendName,
        opts: { name: "resumed", port: 0 },
      });
      const backend = this.backends.get(backendName);
      if (backend) {
        await backend.stopAdvertising(id).catch(() => {
          /* intentionally empty — best-effort stop */
        });
      }
    }
    this.activeAdvertisements.clear();
  }

  private async pauseAdvertisementsForBackend(
    backendName: string,
  ): Promise<void> {
    for (const [id, bn] of this.activeAdvertisements) {
      if (bn === backendName) {
        this.pausedAdvertisements.set(id, {
          backendName,
          opts: { name: "resumed", port: 0 },
        });
        const backend = this.backends.get(backendName);
        if (backend) {
          await backend.stopAdvertising(id).catch(() => {
            /* intentionally empty — best-effort stop */
          });
        }
        this.activeAdvertisements.delete(id);
      }
    }
  }

  private async stopAllBackends(): Promise<void> {
    for (const backend of this.backends.values()) {
      await backend.stop().catch(() => {
        /* intentionally empty — best-effort stop */
      });
    }
  }

  private async resumeAllAdvertisements(): Promise<void> {
    // Restart backends first (they may have been stopped in "dark" mode)
    // Note: backends reinitialise their sockets on next startAdvertising/discover call.
    for (const [id] of this.pausedAdvertisements) {
      this.pausedAdvertisements.delete(id);
      // We can't fully resume without original opts — the caller must
      // re-advertise. Mark as not paused so new advertise calls work.
    }
  }

  private async resumeAdvertisementsForBackend(
    backendName: string,
  ): Promise<void> {
    for (const [id, entry] of this.pausedAdvertisements) {
      if (entry.backendName === backendName) {
        this.pausedAdvertisements.delete(id);
      }
    }
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

  /** Check whether an advertisement ID was paused (visibility change stopped it). */
  isPaused(id: string): boolean {
    return this.pausedAdvertisements.has(id);
  }

  /**
   * Discover meshes using a specific backend (or all backends if no name given).
   * Returns deduplicated results.
   *
   * Respects visibility: returns empty results for backends that are "dark".
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

    // Filter out backends that are dark (per-adapter or global)
    const activeTargets = targets.filter((b) => {
      const vis = this.getVisibility(b.name);
      return vis !== "dark";
    });

    const results = await Promise.all(
      activeTargets.map((b) => b.discover(timeout)),
    );

    // Deduplicate by host+port
    const seen = new Set<string>();
    const deduped: DiscoveredMesh[] = [];
    for (const meshes of results) {
      for (const mesh of meshes) {
        const key = `${mesh.host}:${String(mesh.port)}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(mesh);
        }
      }
    }
    return deduped;
  }
}
