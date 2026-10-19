/**
 * A failure on the data connection to one specific peer, carrying which peer and what the transport was doing so the error channel's consumers can say something actionable instead of repeating a raw socket message.
 */

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
