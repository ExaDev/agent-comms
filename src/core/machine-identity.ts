/**
 * Persistent machine identity (agent-comms#343): one keypair per OS account per host, the third identity scope beside a bridge slot's device identity (identity-store.ts) and the account's user principal (user-identity.ts). It is structurally another grouping issuer, like the principal: it vouches for the devices living on this host with the same group:member proofs (membership-proof.ts), so a peer can group devices by machine and trust or stop trusting a whole host in one act.
 *
 * Stored at ~/.agent-comms/machine-identity.json (mode 0600), so it belongs to the OS account whose home directory holds it: every bridge that account runs on the host reads the same file and is vouched for by the same machine key, while another account on the same host mints a machine key of its own and appears as a separate machine. Until the principal becomes portable across hosts (agent-comms#344) this is the same scope as the user principal; a key naming the host across every account needs a signer outside any one account and is agent-comms#367. The key is generated locally on first use and never derived from hardware (issuer-identity-file.ts says why); re-homing a rebuilt host is a deliberate copy of this file.
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

/** Loads this account's machine identity for this host, creating it on first use (exclusive create, renewal in place, an unusable file refused rather than regenerated). */
export function loadOrCreateMachineIdentity(
  options?: Readonly<MachineIdentityOptions>,
): PeerIdentity {
  return loadOrCreateIssuerIdentity(machineIdentityFile(options));
}
