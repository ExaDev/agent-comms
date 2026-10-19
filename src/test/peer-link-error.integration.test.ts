/**
 * A dial to a peer whose process is gone reaches the error channel as a typed PeerLinkError whose errno survives the transport, which is what lets the reporter tell a stale peer address from any other dial failure.
 */
import { describe, expect, test } from "vitest";
import { describeMeshError } from "../core/error-reporting.js";
import { generateIdentity } from "../core/identity.js";
import { errnoCode, PeerLinkError } from "../core/peer-link-error.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import { freeLocalPort } from "./hub-helpers.js";
import { noopTransportEvents, waitFor } from "./test-transport.js";

describe("WireMeshTransport dial failures", () => {
  test("a refused dial is reported as a PeerLinkError carrying ECONNREFUSED", async () => {
    const errors: Error[] = [];
    const transport = new WireMeshTransport(
      noopTransportEvents({ onError: (e) => void errors.push(e) }),
      generateIdentity(),
    );
    try {
      const deadPort = await freeLocalPort();
      await transport.connectToPeer(
        {
          id: "unreachable-peer",
          port: deadPort,
          startedAt: new Date().toISOString(),
        },
        "self",
      );

      await waitFor(
        () => errors.length > 0,
        "the transport reports the failed dial",
      );
      const [error] = errors;
      expect(error).toBeInstanceOf(PeerLinkError);
      expect(errnoCode(error)).toBe("ECONNREFUSED");
      expect(
        error === undefined ? undefined : describeMeshError(error)?.message,
      ).toContain("stale address");
    } finally {
      await transport.shutdown();
    }
  });
});
