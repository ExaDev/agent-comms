/**
 * A failure on the data connection to one specific peer, carrying which peer and what the transport was doing so the error channel's consumers can say something actionable instead of repeating a raw socket message.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { Connection, Transport } from "wire-mesh-core/ports/transport";

/** What the transport was doing on the connection to the peer when it failed. */
export type PeerLinkAction = "dial" | "send";

export class PeerLinkError extends Error {
  /**
   * @param action - What the transport was doing when the connection failed.
   * @param peerId - The full device-id of the peer the connection was to.
   * @param port - The data port that was dialled; absent for a failure on an established connection, which no longer names one.
   * @param cause - The transport's own error, kept intact so its errno `code` stays readable.
   */
  constructor(
    readonly action: PeerLinkAction,
    readonly peerId: string,
    readonly port: number | undefined,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      action === "dial"
        ? `connectToPeer(${peerId}, port ${String(port)}): ${reason}`
        : `send(${peerId}) failed: ${reason}`,
      { cause },
    );
    this.name = "PeerLinkError";
  }
}

/**
 * Dials a peer's data server and checks that what answered is the peer: it holds the key the peer's id names. Anything else is reported to `onError` and the connection closed, and the answer is undefined. A dial that fails is reported as a PeerLinkError; an answer with no device id, or another one, as an Error naming the port.
 */
export async function dialPeer(
  wireTransport: Readonly<Pick<Transport, "connect">>,
  host: string,
  peer: Readonly<{ id: string; port: number }>,
  onError: ((error: Error) => void) | undefined,
): Promise<{ connection: Connection; deviceIdHex: string } | undefined> {
  const connection = await wireTransport
    .connect(`${host}:${String(peer.port)}`)
    .catch((error: unknown) => {
      onError?.(new PeerLinkError("dial", peer.id, peer.port, error));
      return undefined;
    });
  if (connection === undefined) return undefined;
  const peerDeviceId = connection.peerDeviceId;
  if (peerDeviceId === undefined) {
    onError?.(
      new Error(
        `connectToPeer: peer at port ${String(peer.port)} presented no device id, expected ${peer.id}`,
      ),
    );
    await connection.close();
    return undefined;
  }
  const deviceIdHex = deviceIdToHex(peerDeviceId);
  if (deviceIdHex !== peer.id) {
    // The peer we reached does not hold the key peer.id claims to name: refuse exactly like a mismatched fingerprint would have under the previous transport.
    onError?.(
      new Error(
        `connectToPeer: peer at port ${String(peer.port)} authenticated as ${deviceIdHex}, expected ${peer.id}`,
      ),
    );
    await connection.close();
    return undefined;
  }
  return { connection, deviceIdHex };
}

/** The errno code (`ECONNREFUSED`, `ENETUNREACH`, ...) of an error or the first error in its cause chain that has one. */
export function errnoCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    if ("code" in current && typeof current.code === "string")
      return current.code;
    current = current.cause;
  }
  return undefined;
}
