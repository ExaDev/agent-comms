/**
 * Persistent bridge identity: load-or-create the TLS key material for a (harness, cwd) slot so the certificate fingerprint — and therefore the peer and agent ID — survives restarts.
 *
 * Mesh state stays in memory and on the wire; the only thing on disk is this local credential, the same trust model as an SSH key. A lock file holding a PID keeps two live bridges in one slot from sharing an identity, which would put duplicate peer IDs on the mesh; the second bridge runs with an ephemeral identity (the behaviour before persistence) instead. Bridges without a graceful shutdown hook can skip releasing the lock: a stale lock is detected by probing the recorded PID, the same way the coordinator probes for stale agents.
 *
 * Persisting the key material rather than a bare agent ID is what makes restarts work: delivery routing fires when agentId === peerId, and peerId is the live certificate fingerprint, so an ID without its key can never match the running peer.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateIdentity,
  getCertificateFingerprint,
  deriveDeviceId,
  CERTIFICATE_VALIDITY_MS,
} from "./identity.js";
import type { PeerIdentity } from "./identity.js";

/** A bridge's identity slot: one persisted identity per harness and cwd. */
export interface IdentitySlot {
  harness: string;
  cwd: string;
  /** Directory override for tests. */
  dir?: string;
}

/** Renew during the final twelfth of the certificate's validity. */
const RENEWAL_MARGIN_MS = CERTIFICATE_VALIDITY_MS / 12;

interface StoredIdentity {
  privateKey: string;
  certificate: string;
  expiresAt: string;
}

function isStoredIdentity(value: unknown): value is StoredIdentity {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("privateKey" in value) ||
    !("certificate" in value) ||
    !("expiresAt" in value)
  )
    return false;
  return (
    typeof value.privateKey === "string" &&
    typeof value.certificate === "string" &&
    typeof value.expiresAt === "string"
  );
}

/** Replace path separators and other filesystem-hostile characters. */
function slugifyCwd(cwd: string): string {
  return cwd.replace(/[\\/:*?"<>|]/g, "_");
}

function slotPaths(slot: IdentitySlot): {
  dir: string;
  identityFile: string;
  lockFile: string;
} {
  const dir = slot.dir ?? path.join(os.homedir(), ".agent-comms");
  const base = `identity-${slot.harness}--${slugifyCwd(slot.cwd)}`;
  return {
    dir,
    identityFile: path.join(dir, `${base}.json`),
    lockFile: path.join(dir, `${base}.lock`),
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the PID holding the lock, or undefined when absent or unreadable. */
function readLockPid(lockFile: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(lockFile, "utf-8");
  } catch {
    return undefined;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) ? pid : undefined;
}

function writeLock(lockFile: string): void {
  fs.writeFileSync(lockFile, `${String(process.pid)}\n`, "utf-8");
}

function persistIdentity(identityFile: string, identity: PeerIdentity): void {
  const stored: StoredIdentity = {
    privateKey: identity.privateKey,
    certificate: identity.certificate,
    expiresAt: new Date(Date.now() + CERTIFICATE_VALIDITY_MS).toISOString(),
  };
  fs.writeFileSync(identityFile, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Load the persisted identity for the slot, creating it on first use, and take the slot lock. Returns an ephemeral identity when the slot is already held by another live process.
 */
export function loadOrCreateIdentity(slot: IdentitySlot): PeerIdentity {
  const { dir, identityFile, lockFile } = slotPaths(slot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const heldBy = readLockPid(lockFile);
  if (heldBy !== undefined && heldBy !== process.pid && isPidAlive(heldBy)) {
    console.error(
      `agent-comms: identity slot ${slot.harness} (${slot.cwd}) is held by live pid ${String(heldBy)}; running with an ephemeral identity`,
    );
    return generateIdentity();
  }

  const identity =
    loadStoredIdentity(identityFile) ?? createIdentity(identityFile);
  writeLock(lockFile);
  return identity;
}

/** Load and validate the stored key material, renewing near certificate expiry. */
function loadStoredIdentity(identityFile: string): PeerIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(identityFile, "utf-8"));
  } catch {
    return undefined;
  }
  if (!isStoredIdentity(parsed)) return undefined;

  const expiresAt = Date.parse(parsed.expiresAt);
  if (Number.isNaN(expiresAt) || Date.now() > expiresAt - RENEWAL_MARGIN_MS) {
    return undefined;
  }

  try {
    return {
      privateKey: parsed.privateKey,
      certificate: parsed.certificate,
      fingerprint: getCertificateFingerprint(parsed.certificate),
      deviceId: deriveDeviceId(parsed.privateKey),
    };
  } catch (err) {
    console.error(
      `agent-comms: stored identity at ${identityFile} is unreadable (${err instanceof Error ? err.message : String(err)}); generating a fresh identity`,
    );
    return undefined;
  }
}

function createIdentity(identityFile: string): PeerIdentity {
  const identity = generateIdentity();
  persistIdentity(identityFile, identity);
  return identity;
}

/**
 * Release the slot lock on graceful shutdown. A lock held by another PID (taken over after this process crashed and restarted) is left alone.
 */
export function releaseIdentityLock(slot: IdentitySlot): void {
  const { lockFile } = slotPaths(slot);
  if (readLockPid(lockFile) === process.pid) {
    fs.rmSync(lockFile, { force: true });
  }
}
