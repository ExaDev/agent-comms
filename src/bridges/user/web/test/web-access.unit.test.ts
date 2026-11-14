/**
 * The two cases of the web server's network exposure gate (agent-comms#346) that depend on the running process: a generated token is random, and this machine's own hostname is read from the operating system. Every other case is in the conformance corpus (conformance/function/web-access.json).
 */

import { describe, expect, it } from "vitest";
import * as os from "node:os";
import {
  accessCookieName,
  authorise,
  generateAccessToken,
  tokensMatch,
} from "../web-access.js";

const PORT = 41234;
const BIND = "192.168.1.10";

describe("generateAccessToken", () => {
  it("generates distinct tokens", () => {
    expect(generateAccessToken()).not.toBe(generateAccessToken());
  });

  it("generates a token that matches itself", () => {
    const token = generateAccessToken();
    expect(tokensMatch(token, token)).toBe(true);
  });
});

describe("authorise", () => {
  it("accepts this machine's own hostname as the Host", () => {
    const token = generateAccessToken();
    const machine = os.hostname().replace(/\.local$/i, "");
    const decision = authorise(
      {
        token,
        bindHost: BIND,
        port: PORT,
        localClientAddresses: () => new Set(),
      },
      {
        method: "GET",
        url: "/",
        remoteAddress: "192.168.1.50",
        headers: {
          host: `${machine}.local:${String(PORT)}`,
          authorization: `Bearer ${token}`,
          cookie: `${accessCookieName(PORT)}=${token}`,
        },
      },
    );
    expect(decision).toEqual({ kind: "allow" });
  });
});
