/**
 * The per-install pairing secret that admits the hosted dashboard (web-access.ts).
 *
 * The hosted dashboard's origin is shared by every page published under the same account, so an origin check alone cannot say which page is calling. A page on that origin is admitted only when it also presents the secret this module keeps: a random value the bridge generated, held in an owner-only file beside the bridge's other state, shown to a person only on the bridge's own loopback pairing page and handed from there to the dashboard in a URL fragment, which no server receives and no log records.
 *
 * Design, in one place:
 * - Generation: 32 bytes from the platform's cryptographic random source, written as 64 lower-case hex characters, with owner-only permissions in an owner-only directory. A file that is missing or does not hold exactly that form is replaced by a fresh secret, which un-pairs every browser: the safe direction.
 * - Presentation: an HTTP request carries it in the `X-Agent-Comms-Pairing` header. A WebSocket upgrade carries it as an offered subprotocol, `agent-comms-pairing.<secret>`, because the browser's WebSocket API cannot set headers and a query string would put the secret in logs and history. The server answers every such upgrade with the fixed subprotocol `agent-comms`, so the secret is never echoed.
 * - Comparison: constant time over fixed-length digests.
 * - Revocation: `rotatePairingSecret` writes a new secret. The running bridge reads the file again whenever its modification time or size changes, so a rotation takes effect on the next request without a restart.
 * - Pairing: once per browser profile, by a step that proves the person is at this machine: the pairing page is served only to a client on this machine that carries no hosted-dashboard Origin, so a page on the hosted origin cannot fetch or frame it, and it hands the secret over only when the person presses its button, by opening the hosted dashboard at an exact, fixed address with the secret in the fragment. The dashboard stores it in its own storage, removes the fragment from the address, and sends it from then on.
 * - Limit: the dashboard keeps the secret in the storage of its own origin, which every page of that origin can read. The secret separates a page that was never paired in this browser from one that was; it cannot separate pages that share the dashboard's storage. A separation between pages of one origin needs the dashboard on an origin of its own.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveDataDir } from "../../../core/data-directory.js";
import { writeFileAtomic } from "../../../core/atomic-file.js";
import {
  MESH_SUBPROTOCOL,
  PAIRING_FRAGMENT_PARAM,
  PAIRING_HEADER,
  PAIRING_SECRET_PATTERN,
  PAIRING_SUBPROTOCOL_PREFIX,
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

/** The file the secret lives in, beside the bridge's other persistent state. */
export function pairingSecretFile(dir?: string): string {
  return path.join(resolveDataDir({ dir }), "web-pairing-secret");
}

function newSecret(): string {
  return crypto.randomBytes(PAIRING_SECRET_BYTES).toString("hex");
}

function writeSecret(file: string, secret: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: SECRET_DIR_MODE });
  writeFileAtomic(file, `${secret}\n`, SECRET_FILE_MODE);
}

/**
 * Replaces the secret with a fresh one, so every browser that was paired has to pair again. Returns nothing: the secret is shown only by the pairing page.
 */
export function rotatePairingSecret(dir?: string): void {
  writeSecret(pairingSecretFile(dir), newSecret());
}

/** Reads the secret a file holds, or undefined when the file is missing or does not hold the expected form. */
function readSecret(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, "utf-8").trim();
    return PAIRING_SECRET_PATTERN.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The secret a running bridge checks requests against. */
export interface PairingSecretStore {
  /** The current secret. Read again when the file changed, so a rotation by another process is seen at once. */
  current: () => string;
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
    writeSecret(file, secret);
    if (existed) options?.onReplaced?.(file);
    return { secret, stamp: stampOf() ?? "" };
  };

  return {
    current: () => {
      const stamp = stampOf();
      if (
        cached === undefined ||
        stamp === undefined ||
        stamp !== cached.stamp
      ) {
        cached = load();
      }
      return cached.secret;
    },
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

/** The secret a request presents: the pairing header, else the secret in an offered pairing subprotocol. Undefined when it presents none. */
export function presentedPairingSecret(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): string | undefined {
  const header = headers[PAIRING_HEADER];
  const fromHeader = typeof header === "string" ? header : header?.[0];
  if (fromHeader !== undefined) return fromHeader;
  for (const protocol of offeredSubprotocols(
    headers["sec-websocket-protocol"],
  )) {
    if (protocol.startsWith(PAIRING_SUBPROTOCOL_PREFIX)) {
      return protocol.slice(PAIRING_SUBPROTOCOL_PREFIX.length);
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
