/**
 * Persistent machine identity (agent-comms#343): one keypair per host, the third identity scope beside a bridge slot's device identity (identity-store.ts) and the account's user principal (user-identity.ts). It is structurally another grouping issuer, like the principal: it vouches for the devices living on this host with the same group:member proofs (membership-proof.ts), so a peer can group devices by machine and trust or stop trusting a whole host in one act.
 *
 * Stored at ~/.agent-comms/machine-identity.json (mode 0600). Every bridge on the host reads the same file, so every device here is vouched for by the same machine key. The key is generated locally on first use and never derived from hardware (issuer-identity-file.ts says why); re-homing a rebuilt host is a deliberate copy of this file.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { PeerIdentity } from "./identity.js";
import { loadOrCreateIssuerIdentity } from "./issuer-identity-file.js";

export interface MachineIdentityOptions {
  /** Directory override for tests; defaults to ~/.agent-comms, beside the user identity and every bridge slot. */
  dir?: string;
}

/** The machine identity file for options. */
export function machineIdentityFile(
  options?: Readonly<MachineIdentityOptions>,
): string {
  const dir = options?.dir ?? path.join(os.homedir(), ".agent-comms");
  return path.join(dir, "machine-identity.json");
}

/** Loads this host's machine identity, creating it on first use (exclusive create, renewal in place, a corrupt file regenerated). */
export function loadOrCreateMachineIdentity(
  options?: Readonly<MachineIdentityOptions>,
): PeerIdentity {
  return loadOrCreateIssuerIdentity(machineIdentityFile(options));
}
