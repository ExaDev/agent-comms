/**
 * Unit tests for fetchPgpPublicKeyByFingerprint (agent-comms#188), against an injected fake fetch rather than a real network call.
 */

import { describe, expect, it, vi } from "vitest";
import { fetchPgpPublicKeyByFingerprint } from "../core/pgp-keyserver.js";

const ARMORED_KEY =
  "-----BEGIN PGP PUBLIC KEY BLOCK-----\nfake\n-----END PGP PUBLIC KEY BLOCK-----";

describe("fetchPgpPublicKeyByFingerprint", () => {
  it("fetches the armored key from keys.openpgp.org's by-fingerprint endpoint", async () => {
    const fakeFetch = vi.fn(async () =>
      Promise.resolve(new Response(ARMORED_KEY, { status: 200 })),
    );

    const result = await fetchPgpPublicKeyByFingerprint(
      "aabbccddeeff00112233445566778899aabbccd",
      fakeFetch,
    );

    expect(result).toBe(ARMORED_KEY);
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://keys.openpgp.org/vks/v1/by-fingerprint/AABBCCDDEEFF00112233445566778899AABBCCD",
    );
  });

  it("normalises a fingerprint with spaces and colons before building the URL", async () => {
    const fakeFetch = vi.fn(async () =>
      Promise.resolve(new Response(ARMORED_KEY, { status: 200 })),
    );

    await fetchPgpPublicKeyByFingerprint(
      "aabb:ccdd:eeff:0011:2233:4455:6677:8899:aabb:ccd ",
      fakeFetch,
    );

    expect(fakeFetch).toHaveBeenCalledWith(
      "https://keys.openpgp.org/vks/v1/by-fingerprint/AABBCCDDEEFF00112233445566778899AABBCCD",
    );
  });

  it("throws when the keyserver responds with a non-2xx status", async () => {
    const fakeFetch = vi.fn(async () =>
      Promise.resolve(new Response("not found", { status: 404 })),
    );

    await expect(
      fetchPgpPublicKeyByFingerprint("00", fakeFetch),
    ).rejects.toThrow(/404/);
  });
});
