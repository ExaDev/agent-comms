/**
 * Default sink for a mesh store's error channel. MeshStore.onError carries every failure the mesh handles internally (a hub dial that was refused, a gossip send that failed, a default-front session that could not attach), and nothing shows them unless a bridge assigns a handler, so a bridge without a UI of its own routes them to stderr.
 */

import { shortId } from "./display-name.js";
import { errnoCode, PeerLinkError } from "./peer-link-error.js";

/** The causes of a refused or dropped connection to a peer, which all mean the process behind that address has gone. */
const PEER_GONE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
]);

/** The causes of a first-contact broadcast that found no network to leave through. */
const NO_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
]);

/** A mesh error as a person should read it: `message` says what happened, what it most likely means and whether anything needs doing, and `key` identifies the condition so a repeat of it can be recognised. */
export interface DescribedMeshError {
  key: string;
  message: string;
}

function describePeerLinkError(
  error: Readonly<PeerLinkError>,
): DescribedMeshError {
  const peer = shortId(error.peerId);
  const code = errnoCode(error);
  if (error.action === "send") {
    return {
      key: `peer-send:${error.peerId}`,
      message: `The connection to peer ${peer} dropped while a message was being sent (${error.cause instanceof Error ? error.cause.message : String(error.cause)}). The peer most likely exited or restarted.`,
    };
  }
  if (code !== undefined && PEER_GONE_CODES.has(code)) {
    return {
      key: `peer-gone:${error.peerId}`,
      message: `Could not connect to peer ${peer} on port ${String(error.port)} (${code}). Its agent most likely exited or restarted, leaving a stale address behind, and no action is needed. If a peer that should be running stays unreachable, check that nothing is blocking connections to localhost.`,
    };
  }
  return {
    key: `peer-dial:${error.peerId}`,
    message: `Could not connect to peer ${peer} on port ${String(error.port)}: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
  };
}

/** Recognises the mesh failures that have a known meaning and a usual remedy, and returns them described for a person. Anything else is `undefined` and is reported as it came. */
export function describeMeshError(
  error: Readonly<Error>,
): DescribedMeshError | undefined {
  if (error instanceof PeerLinkError) return describePeerLinkError(error);
  const code = errnoCode(error);
  if (code !== undefined && NO_NETWORK_CODES.has(code)) {
    return {
      key: `no-network:${code}`,
      message: `Could not reach the local network to look for agents on other machines (${code}). Check that the network is connected; agents on this machine still find each other, and discovery of other machines resumes once a network is available.`,
    };
  }
  return undefined;
}

/** The single line a mesh error is reported as. */
export function formatMeshError(error: Readonly<Error>): string {
  return `agent-comms: ${describeMeshError(error)?.message ?? error.message}\n`;
}

/** Builds the handler a bridge assigns to `store.onError`, writing each error to `write` as one line. `write` defaults to the process's stderr, which stdio bridges keep clear of protocol traffic. A recognised condition is written once per reporter: a stale peer or a missing network repeats on every dial and beacon, and a second line says nothing the first did not. Errors with no known meaning are always written. Returns the handler rather than assigning it, so the caller does the assignment itself, like wireDefaultCcPeerFront does for onCoordinatorRoleChanged. */
export function createMeshErrorReporter(
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): (error: Error) => void {
  const reported = new Set<string>();
  return (error) => {
    const described = describeMeshError(error);
    if (described !== undefined) {
      if (reported.has(described.key)) return;
      reported.add(described.key);
    }
    write(formatMeshError(error));
  };
}
