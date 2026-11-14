/**
 * The per-install pairing secret that admits the hosted dashboard (web-access.ts).
 *
 * The hosted dashboard's origin is shared by every page published under the same account, so an origin check alone cannot say which page is calling, and a listener on a port of the range cannot be told from the bridge by the handshake alone. Both directions are therefore authenticated by a secret this module keeps: a random value the bridge generated, held in an owner-only file beside the bridge's other state, shown to a person only on the bridge's own loopback pairing page and handed from there to the dashboard in a URL fragment, which no server receives and no log records.
 *
 * Design, in one place:
 * - Generation: 32 bytes from the platform's cryptographic random source, written as 64 lower-case hex characters, with owner-only permissions in an owner-only directory. A file that is missing is created exclusively, so two bridges starting together settle on one secret. A file that does not hold exactly that form, or whose mode or owner is not the owner-only one it was written with, is replaced by a fresh secret, which un-pairs every browser: the safe direction.
 * - The secret never crosses a socket. The dashboard opens `/ws/hello` on a port and sends a fresh nonce; the bridge answers with its own nonce and a proof, an HMAC-SHA-256 keyed with the secret over the role, both nonces and the port; the dashboard checks that proof (so a listener that does not hold the secret is not taken for the bridge, and receives nothing but a nonce) and only then sends its own proof, over the nonces in the same order under the other role. The bridge checks it and answers with a single-use ticket that lives a few seconds, which the dashboard offers as a subprotocol, `agent-comms-ticket.<ticket>`, on the mesh socket. The server answers every such upgrade with the fixed subprotocol `agent-comms`, so the ticket is never echoed.
 * - Comparison: constant time (`timingSafeEqual`) over fixed-length values.
 * - Revocation: `rotatePairingSecret` writes a new secret. The running bridge reads the file again whenever its modification time or size changes, so a rotation refuses every later ticket and proof without a restart, and the server closes every socket it admitted under the old secret (server.ts).
 * - Pairing: once per browser profile, by a step that proves the person is at this machine: the pairing page is served only to a client on this machine that carries no hosted-dashboard Origin, so a page on the hosted origin cannot fetch or frame it, and it hands the secret over only when the person presses its button, by opening the hosted dashboard at an exact, fixed address with the secret in the fragment. The dashboard stores it in its own storage, removes the fragment from the address, and uses it only as the key of the proof.
 * - Limit: the dashboard keeps the secret in the storage of its own origin, which every page of that origin can read. The secret separates a page that was never paired in this browser from one that was; it cannot separate pages that share the dashboard's storage. A separation between pages of one origin needs the dashboard on an origin of its own.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveDataDir } from "../../../core/data-directory.js";
import {
  createFileExclusive,
  writeFileAtomic,
} from "../../../core/atomic-file.js";
import {
  MESH_SUBPROTOCOL,
  PAIRING_FRAGMENT_PARAM,
  PAIRING_SECRET_PATTERN,
  TICKET_SUBPROTOCOL_PREFIX,
} from "./pairing-protocol.js";

/** The origin of the hosted dashboard, and the exact address pairing opens it at: the origin and the path its deployment serves it from. The address is a constant and never taken from a request. */
export const HOSTED_DASHBOARD_URL = "https://exadev.github.io/agent-comms/";

/** The route the bridge serves its pairing page at. */
export const PAIRING_PAGE_PATH = "/pair";

/** Random bytes in a secret: 256 bits. */
const PAIRING_SECRET_BYTES = 32;

/** Owner-only file and directory modes, as for every other file holding a credential. */
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;
/** The mode bits that give a group or anyone else access. */
const GROUP_AND_OTHER_BITS = 0o077;

/** The file the secret lives in, beside the bridge's other persistent state. */
export function pairingSecretFile(dir?: string): string {
  return path.join(resolveDataDir({ dir }), "web-pairing-secret");
}

function newSecret(): string {
  return crypto.randomBytes(PAIRING_SECRET_BYTES).toString("hex");
}

/** Whether a file or directory is owned by this user and closed to everyone else. Always true where the platform has no such ownership (Windows). */
function isOwnerOnly(stat: Readonly<fs.Stats>): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  return stat.uid === uid && (stat.mode & GROUP_AND_OTHER_BITS) === 0;
}

/** Creates the directory owner-only, and closes an existing one of this user's that was left open to others. A directory that belongs to someone else is not this bridge's to keep a secret in. */
function ensureSecretDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
  const stat = fs.statSync(dir);
  if (isOwnerOnly(stat)) return;
  if (stat.uid !== process.getuid?.()) {
    throw new Error(
      `${dir} does not belong to this user, so the pairing secret is not kept in it`,
    );
  }
  fs.chmodSync(dir, SECRET_DIR_MODE);
}

function writeSecret(file: string, secret: string): void {
  ensureSecretDir(path.dirname(file));
  writeFileAtomic(file, `${secret}\n`, SECRET_FILE_MODE);
}

/**
 * Replaces the secret with a fresh one, so every browser that was paired has to pair again and every socket admitted under the old one is closed. Returns nothing: the secret is shown only by the pairing page.
 */
export function rotatePairingSecret(dir?: string): void {
  writeSecret(pairingSecretFile(dir), newSecret());
}

/** Reads the secret a file holds, or undefined when the file is missing, does not hold the expected form, or is open to anyone but its owner (a secret that anyone else could have read is not kept). */
function readSecret(file: string): string | undefined {
  try {
    if (!isOwnerOnly(fs.statSync(file))) return undefined;
    const text = fs.readFileSync(file, "utf-8").trim();
    return PAIRING_SECRET_PATTERN.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The secret a running bridge proves possession of. */
export interface PairingSecretStore {
  /** The current secret. Read again when the file changed, so a rotation by another process is seen at once. */
  current: () => string;
  /** A number that changes whenever `current` has returned a different secret from the one before. Read after `current`, so a holder of an earlier secret can tell it has been replaced. */
  generation: () => number;
}

/**
 * Opens the pairing secret at `options.dir` (default: the bridge's data directory), creating it when it does not exist or is unusable. `onReplaced` is told when an existing file had to be replaced, so the operator hears that browsers must pair again.
 */
export function openPairingSecret(
  options?: Readonly<{
    dir?: string | undefined;
    onReplaced?: (file: string) => void;
  }>,
): PairingSecretStore {
  const file = pairingSecretFile(options?.dir);
  let cached: { secret: string; stamp: string } | undefined;
  let generation = 0;

  const stampOf = (): string | undefined => {
    try {
      const stat = fs.statSync(file);
      return `${String(stat.mtimeMs)}:${String(stat.size)}`;
    } catch {
      return undefined;
    }
  };

  const load = (): { secret: string; stamp: string } => {
    const existing = readSecret(file);
    if (existing !== undefined) {
      return { secret: existing, stamp: stampOf() ?? "" };
    }
    const existed = fs.existsSync(file);
    const secret = newSecret();
    if (existed) {
      writeSecret(file, secret);
      options?.onReplaced?.(file);
      return { secret, stamp: stampOf() ?? "" };
    }
    ensureSecretDir(path.dirname(file));
    // Created exclusively, so a bridge that starts at the same moment settles on this secret or the other's and not two.
    if (createFileExclusive(file, `${secret}\n`, SECRET_FILE_MODE)) {
      return { secret, stamp: stampOf() ?? "" };
    }
    const winner = readSecret(file);
    if (winner === undefined) {
      writeSecret(file, secret);
      return { secret, stamp: stampOf() ?? "" };
    }
    return { secret: winner, stamp: stampOf() ?? "" };
  };

  return {
    current: () => {
      const stamp = stampOf();
      if (
        cached === undefined ||
        stamp === undefined ||
        stamp !== cached.stamp
      ) {
        const loaded = load();
        if (cached !== undefined && loaded.secret !== cached.secret) {
          generation += 1;
        }
        cached = loaded;
      }
      return cached.secret;
    },
    generation: () => generation,
  };
}

/** The offered subprotocols of an upgrade, as the `Sec-WebSocket-Protocol` header lists them. */
function offeredSubprotocols(
  header: string | readonly string[] | undefined,
): string[] {
  const value = typeof header === "string" ? header : header?.join(",");
  return value === undefined
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
}

/** The ticket a mesh upgrade presents in an offered ticket subprotocol, or undefined when it presents none. */
export function presentedTicket(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): string | undefined {
  for (const protocol of offeredSubprotocols(
    headers["sec-websocket-protocol"],
  )) {
    if (protocol.startsWith(TICKET_SUBPROTOCOL_PREFIX)) {
      return protocol.slice(TICKET_SUBPROTOCOL_PREFIX.length);
    }
  }
  return undefined;
}

/**
 * Which subprotocol a WebSocket server selects: the fixed mesh subprotocol when the client offers it, and none otherwise (a client that offers no protocols, as a page served by the bridge itself does not, gets none). The offered secret is never selected.
 */
export function selectMeshSubprotocol(
  protocols: ReadonlySet<string>,
): string | false {
  return protocols.has(MESH_SUBPROTOCOL) ? MESH_SUBPROTOCOL : false;
}

/** The address the pairing page sends the person to: the hosted dashboard, with the secret in the fragment. */
export function dashboardPairingUrl(secret: string): string {
  return `${HOSTED_DASHBOARD_URL}#${PAIRING_FRAGMENT_PARAM}=${secret}`;
}

/**
 * The pairing page. It carries the secret only inside a link that opens the dashboard at its fixed address, and a person has to press it. It tells no one anything on its own and may not be framed.
 */
export function pairingPageHtml(secret: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Pair the hosted dashboard</title>
</head>
<body>
<h1>Pair the hosted dashboard</h1>
<p>This browser is on the machine running the bridge. Pairing lets the hosted dashboard at ${HOSTED_DASHBOARD_URL} talk to this bridge from this browser profile.</p>
<p>Only pair a browser you use yourself. The link below hands the dashboard a secret; run <code>agent-comms pairing rotate</code> to revoke every pairing.</p>
<p><a rel="noopener noreferrer" href="${dashboardPairingUrl(secret)}">Pair this browser</a></p>
</body>
</html>
`;
}

/** Headers for the pairing page: not framed, not cached, not sent as a referrer, and not run as script. */
export const PAIRING_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
