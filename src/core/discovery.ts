/**
 * Discovery — mesh discovery interface and manager.
 *
 * Defines the contract for discovery backends (mDNS, Tailscale, etc.)
 * and a manager that routes calls to the appropriate backend.
 * Discovery is opt-in — no broadcasting unless the agent explicitly
 * calls mesh_advertise.
 */

import type { MeshVisibility } from "./types.js";
import { nanoid } from "./nanoid.js";

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
  startAdvertising: (opts: Readonly<AdvertiseOptions>) => Promise<string>;
  stopAdvertising: (id: string) => Promise<void>;
  discover: (timeout?: number) => Promise<DiscoveredMesh[]>;
  /** Stop all activity (timers, sockets) for this backend. */
  stop: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Discovery manager
// ---------------------------------------------------------------------------

/** An advertisement DiscoveryManager currently considers live -- the caller-visible external id, which backend to it, the backend's own internal id (needed to address stopAdvertising/a future re-advertisement), and the original opts (needed to genuinely re-advertise on resume, not just forget the advertisement ever happened). */
interface ActiveAdvertisement {
  backendName: string;
  backendId: string;
  opts: AdvertiseOptions;
}

export class DiscoveryManager {
  private readonly backends = new Map<string, DiscoveryBackend>();
  /** Keyed by the stable, caller-visible external id DiscoveryManager itself mints -- deliberately never the backend's own returned id, since a backend is free to return a different id on every startAdvertising call (a real, un-mocked backend calling it deterministically is incidental, not a contract this class may rely on) and a caller must be able to keep using the same id it was given across a pause/resume cycle. */
  private readonly activeAdvertisements = new Map<
    string,
    ActiveAdvertisement
  >();
  private meshVisibility: MeshVisibility = "discoverable";
  private readonly perAdapterVisibility = new Map<string, MeshVisibility>();
  /** Advertisements paused due to a visibility change, keyed by the same external id -- carries the real original opts (not a placeholder) so resuming can genuinely call startAdvertising again. */
  private readonly pausedAdvertisements = new Map<
    string,
    { backendName: string; opts: AdvertiseOptions }
  >();

  /** Register a discovery backend. */
  registerBackend(backend: Readonly<DiscoveryBackend>): void {
    this.backends.set(backend.name, backend);
  }

  /** Start advertising on a specific backend. Returns a stable external advertisement id, distinct from whatever id the backend itself returns internally. */
  async advertise(
    backendName: string,
    opts: Readonly<AdvertiseOptions>,
  ): Promise<string> {
    const backend = this.backends.get(backendName);
    if (!backend) {
      throw new Error(
        `Unknown discovery backend: "${backendName}". Available: ${[...this.backends.keys()].join(", ")}`,
      );
    }
    const backendId = await backend.startAdvertising(opts);
    const id = nanoid();
    this.activeAdvertisements.set(id, { backendName, backendId, opts });
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
    // Capture current ads' real opts before clearing, so resume can genuinely re-advertise rather than merely forgetting the pause happened.
    for (const [id, active] of this.activeAdvertisements) {
      this.pausedAdvertisements.set(id, {
        backendName: active.backendName,
        opts: active.opts,
      });
      const backend = this.backends.get(active.backendName);
      if (backend) {
        await backend.stopAdvertising(active.backendId).catch(() => {
          /* intentionally empty — best-effort stop */
        });
      }
    }
    this.activeAdvertisements.clear();
  }

  private async pauseAdvertisementsForBackend(
    backendName: string,
  ): Promise<void> {
    for (const [id, active] of this.activeAdvertisements) {
      if (active.backendName === backendName) {
        this.pausedAdvertisements.set(id, {
          backendName,
          opts: active.opts,
        });
        const backend = this.backends.get(backendName);
        if (backend) {
          await backend.stopAdvertising(active.backendId).catch(() => {
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
    // Backends reinitialise their own sockets/timers on the next startAdvertising call -- nothing extra needed here beyond actually calling it, which is the whole fix: resuming used to just forget the pause happened rather than genuinely re-advertising.
    for (const [id, entry] of this.pausedAdvertisements) {
      this.pausedAdvertisements.delete(id);
      const backend = this.backends.get(entry.backendName);
      if (!backend) continue;
      const backendId = await backend.startAdvertising(entry.opts);
      this.activeAdvertisements.set(id, {
        backendName: entry.backendName,
        backendId,
        opts: entry.opts,
      });
    }
  }

  private async resumeAdvertisementsForBackend(
    backendName: string,
  ): Promise<void> {
    for (const [id, entry] of this.pausedAdvertisements) {
      if (entry.backendName !== backendName) continue;
      this.pausedAdvertisements.delete(id);
      const backend = this.backends.get(backendName);
      if (!backend) continue;
      const backendId = await backend.startAdvertising(entry.opts);
      this.activeAdvertisements.set(id, {
        backendName,
        backendId,
        opts: entry.opts,
      });
    }
  }

  /** Stop a previously started advertisement, addressed by its stable external id. */
  async stopAdvertising(id: string): Promise<void> {
    const active = this.activeAdvertisements.get(id);
    if (active === undefined) return;
    const backend = this.backends.get(active.backendName);
    if (!backend) return;
    await backend.stopAdvertising(active.backendId);
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
      activeTargets.map(async (b) => b.discover(timeout)),
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
