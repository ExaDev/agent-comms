/**
 * Unit tests for createMeshErrorReporter -- the default sink for a mesh store's error channel in the bridges that have no UI of their own.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createMeshErrorReporter,
  describeMeshError,
  formatMeshError,
} from "../core/error-reporting.js";
import { shortId } from "../core/display-name.js";
import { PeerLinkError } from "../core/peer-link-error.js";

const PEER_ID =
  "7d5bb622d5890adc2c4b63e8fd95fb27319be5f3876657b072f1a8a38f2cdbee";
const OTHER_PEER_ID = "a".repeat(PEER_ID.length);
// An arbitrary data port, named so the assertions read as the dialled address.
const DATA_PORT = 41001;

/** An error shaped like the ones Node's sockets raise, with the errno code on the error itself. */
function errno(code: string, message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

describe("formatMeshError", () => {
  it("reports an error as one prefixed, newline-terminated line", () => {
    expect(formatMeshError(new Error("listen EADDRINUSE"))).toBe(
      "agent-comms: listen EADDRINUSE\n",
    );
  });
});

describe("describeMeshError", () => {
  it("explains a refused dial as a stale peer address, naming the peer and port", () => {
    const error = new PeerLinkError(
      "dial",
      PEER_ID,
      DATA_PORT,
      errno("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:41001"),
    );

    const described = describeMeshError(error);

    expect(described?.message).toContain(shortId(PEER_ID));
    expect(described?.message).toContain(String(DATA_PORT));
    expect(described?.message).toContain("most likely exited or restarted");
  });

  it("treats a reset dial like a refused one", () => {
    const error = new PeerLinkError(
      "dial",
      PEER_ID,
      DATA_PORT,
      errno("ECONNRESET", "read ECONNRESET"),
    );

    expect(describeMeshError(error)?.message).toContain("stale address");
  });

  it("keeps the transport's own reason for a dial failure it has no explanation for", () => {
    const error = new PeerLinkError(
      "dial",
      PEER_ID,
      DATA_PORT,
      errno("ETIMEDOUT", "connect ETIMEDOUT 127.0.0.1:41001"),
    );

    const described = describeMeshError(error);

    expect(described?.message).toContain("connect ETIMEDOUT 127.0.0.1:41001");
    expect(described?.message).not.toContain("stale address");
  });

  it("explains a send cut off by a disconnect, naming the peer", () => {
    const error = new PeerLinkError(
      "send",
      PEER_ID,
      undefined,
      new Error("disconnected before a response arrived"),
    );

    const described = describeMeshError(error);

    expect(described?.message).toContain(shortId(PEER_ID));
    expect(described?.message).toContain(
      "disconnected before a response arrived",
    );
  });

  it("explains a broadcast with nowhere to go as a missing network", () => {
    const described = describeMeshError(
      errno("ENETUNREACH", "send ENETUNREACH 255.255.255.255:19877"),
    );

    expect(described?.message).toContain("ENETUNREACH");
    expect(described?.message).toContain("network");
  });

  it("recognises nothing in an error it has no meaning for", () => {
    expect(describeMeshError(new Error("listen EADDRINUSE"))).toBeUndefined();
  });

  it("keys a condition by the peer it is about", () => {
    const refused = (peerId: string, port: number) =>
      describeMeshError(
        new PeerLinkError("dial", peerId, port, errno("ECONNREFUSED", "x")),
      )?.key;

    expect(refused(PEER_ID, DATA_PORT)).toBe(refused(PEER_ID, DATA_PORT + 1));
    expect(refused(PEER_ID, DATA_PORT)).not.toBe(
      refused(OTHER_PEER_ID, DATA_PORT),
    );
  });
});

describe("createMeshErrorReporter", () => {
  it("writes each error to the sink as one prefixed line", () => {
    const write = vi.fn<(line: string) => void>();
    const report = createMeshErrorReporter(write);

    report(new Error("listen EADDRINUSE"));
    report(new Error("hub unreachable"));

    expect(write.mock.calls).toEqual([
      ["agent-comms: listen EADDRINUSE\n"],
      ["agent-comms: hub unreachable\n"],
    ]);
  });

  it("writes to the real process stderr by default", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      createMeshErrorReporter()(new Error("boom"));
      expect(stderr).toHaveBeenCalledWith("agent-comms: boom\n");
    } finally {
      stderr.mockRestore();
    }
  });

  it("writes a recognised condition once however often it repeats, even when the port changes", () => {
    const write = vi.fn<(line: string) => void>();
    const report = createMeshErrorReporter(write);
    const refused = (port: number) =>
      new PeerLinkError("dial", PEER_ID, port, errno("ECONNREFUSED", "x"));

    report(refused(DATA_PORT));
    report(refused(DATA_PORT + 1));
    report(refused(DATA_PORT + 2));

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("writes the same condition for a different peer", () => {
    const write = vi.fn<(line: string) => void>();
    const report = createMeshErrorReporter(write);

    report(
      new PeerLinkError("dial", PEER_ID, DATA_PORT, errno("ECONNREFUSED", "x")),
    );
    report(
      new PeerLinkError(
        "dial",
        OTHER_PEER_ID,
        DATA_PORT,
        errno("ECONNREFUSED", "x"),
      ),
    );

    expect(write).toHaveBeenCalledTimes(2);
  });

  it("writes every error it has no meaning for", () => {
    const write = vi.fn<(line: string) => void>();
    const report = createMeshErrorReporter(write);

    report(new Error("hub unreachable"));
    report(new Error("hub unreachable"));

    expect(write).toHaveBeenCalledTimes(2);
  });
});
