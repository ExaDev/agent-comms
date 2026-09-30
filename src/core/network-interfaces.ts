/**
 * This host's network interfaces in the provider-neutral shape the mesh_interfaces action reports (MeshStore.getNetworkInterfaces's body, split out to keep mesh-store.ts under the repo's max-lines cap).
 */

import * as os from "node:os";
import type { NetworkInterface } from "./types.js";

/** Every address on every interface of this host, as os.networkInterfaces reports them. */
export function listNetworkInterfaces(): NetworkInterface[] {
  const interfaces = os.networkInterfaces();
  const result: NetworkInterface[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (addrs === undefined) continue;
    for (const addr of addrs) {
      result.push({
        name,
        address: addr.address,
        family: addr.family,
        internal: addr.internal,
      });
    }
  }
  return result;
}
