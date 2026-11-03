/**
 * The discovery manager every MeshStore starts with: the LAN beacon backend and the tailnet probe backend. Kept apart from discovery.ts because each backend imports that module's types, and from mesh-store.ts so the store names no concrete backend.
 */

import { DiscoveryManager } from "./discovery.js";
import { MdnsDiscoveryBackend } from "./discovery-mdns.js";
import { TailscaleDiscoveryBackend } from "./discovery-tailscale.js";

/** Builds a DiscoveryManager with the mDNS beacon and Tailscale backends registered. */
export function createDefaultDiscovery(): DiscoveryManager {
  const discovery = new DiscoveryManager();
  discovery.registerBackend(new MdnsDiscoveryBackend());
  discovery.registerBackend(new TailscaleDiscoveryBackend());
  return discovery;
}
