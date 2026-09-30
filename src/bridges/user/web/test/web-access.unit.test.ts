/**
 * Unit tests for the web server's network exposure gate (agent-comms#346): bind resolution, the constant-time token comparison, and the per-request decision for loopback and non-loopback clients.
 */

import { describe, expect, it } from "vitest";
import * as os from "node:os";
import {
  ACCESS_COOKIE_NAME,
  authorise,
  generateAccessToken,
  isLoopbackAddress,
  LOOPBACK_HOST,
  requiresAccessToken,
  resolveWebBindHost,
  tokensMatch,
  WEB_HOST_ENV,
  type AccessPolicy,
  type AccessRequest,
} from "../web-access.js";

const HTTP_FOUND = 302;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const PORT = 41234;
const LAN_CLIENT = "192.168.1.50";
const BIND = "192.168.1.10";
const HOST_HEADER = `${BIND}:${String(PORT)}`;

function policy(): AccessPolicy {
  return { token: generateAccessToken(), bindHost: BIND, port: PORT };
}

function request(overrides: Partial<AccessRequest>): AccessRequest {
  return {
    method: "GET",
    url: "/",
    remoteAddress: LAN_CLIENT,
    headers: { host: HOST_HEADER },
    ...overrides,
  };
}

describe("resolveWebBindHost", () => {
  it("defaults to loopback with no option and no environment variable", () => {
    expect(resolveWebBindHost(undefined, {})).toBe(LOOPBACK_HOST);
  });

  it("takes the environment variable as the opt-in", () => {
    expect(resolveWebBindHost(undefined, { [WEB_HOST_ENV]: "0.0.0.0" })).toBe(
      "0.0.0.0",
    );
  });

  it("prefers an explicit option over the environment", () => {
    expect(resolveWebBindHost("::", { [WEB_HOST_ENV]: "0.0.0.0" })).toBe("::");
  });

  it("rejects a value that is not an IP address instead of falling back", () => {
    expect(() =>
      resolveWebBindHost(undefined, { [WEB_HOST_ENV]: "lan" }),
    ).toThrow(WEB_HOST_ENV);
  });
});

describe("requiresAccessToken", () => {
  it.each(["127.0.0.1", "127.0.0.5", "::1"])("%s needs no token", (host) => {
    expect(requiresAccessToken(host)).toBe(false);
  });

  it.each(["0.0.0.0", "::", "192.168.1.10"])("%s needs a token", (host) => {
    expect(requiresAccessToken(host)).toBe(true);
  });
});

describe("isLoopbackAddress", () => {
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("%s is loopback", (a) => {
    expect(isLoopbackAddress(a)).toBe(true);
  });

  it.each(["192.168.1.50", "::ffff:192.168.1.50", "fe80::1"])(
    "%s is not loopback",
    (a) => {
      expect(isLoopbackAddress(a)).toBe(false);
    },
  );
});

describe("tokensMatch", () => {
  it("accepts an identical token", () => {
    const token = generateAccessToken();
    expect(tokensMatch(token, token)).toBe(true);
  });

  it("rejects a prefix, an extension, a different token and the empty string without throwing on length", () => {
    const token = generateAccessToken();
    expect(tokensMatch(token.slice(0, -1), token)).toBe(false);
    expect(tokensMatch(`${token}0`, token)).toBe(false);
    expect(tokensMatch(generateAccessToken(), token)).toBe(false);
    expect(tokensMatch("", token)).toBe(false);
  });

  it("generates distinct tokens", () => {
    expect(generateAccessToken()).not.toBe(generateAccessToken());
  });
});

describe("authorise", () => {
  it("allows everything when there is no policy (a loopback bind)", () => {
    expect(
      authorise(undefined, request({ headers: { host: "evil.example" } })),
    ).toEqual({ kind: "allow" });
  });

  it("allows a loopback client without a token or a matching Host, even under a policy", () => {
    const decision = authorise(
      policy(),
      request({ remoteAddress: "127.0.0.1", headers: { host: "localhost" } }),
    );
    expect(decision).toEqual({ kind: "allow" });
  });

  it("answers 401 to a non-loopback client with no token", () => {
    expect(authorise(policy(), request({}))).toMatchObject({
      kind: "deny",
      status: HTTP_UNAUTHORIZED,
    });
  });

  it("answers 401 to a wrong bearer token", () => {
    const decision = authorise(
      policy(),
      request({
        headers: { host: HOST_HEADER, authorization: "Bearer wrong" },
      }),
    );
    expect(decision).toMatchObject({ kind: "deny", status: HTTP_UNAUTHORIZED });
  });

  it("allows a correct bearer token", () => {
    const p = policy();
    const decision = authorise(
      p,
      request({
        headers: { host: HOST_HEADER, authorization: `Bearer ${p.token}` },
      }),
    );
    expect(decision).toEqual({ kind: "allow" });
  });

  it("allows a correct cookie and rejects a wrong one", () => {
    const p = policy();
    expect(
      authorise(
        p,
        request({
          headers: {
            host: HOST_HEADER,
            cookie: `a=b; ${ACCESS_COOKIE_NAME}=${p.token}`,
          },
        }),
      ),
    ).toEqual({ kind: "allow" });
    expect(
      authorise(
        p,
        request({
          headers: {
            host: HOST_HEADER,
            cookie: `${ACCESS_COOKIE_NAME}=wrong`,
          },
        }),
      ),
    ).toMatchObject({ kind: "deny", status: HTTP_UNAUTHORIZED });
  });

  it("exchanges a correct ?token= on a GET for a cookie and a redirect without the token", () => {
    const p = policy();
    const decision = authorise(
      p,
      request({ url: `/room?x=1&token=${p.token}` }),
    );
    expect(decision).toEqual({
      kind: "exchange",
      status: HTTP_FOUND,
      cookie: `${ACCESS_COOKIE_NAME}=${p.token}; HttpOnly; SameSite=Strict; Path=/`,
      location: "/room?x=1",
    });
  });

  it("does not exchange a wrong ?token=, nor any ?token= on a POST", () => {
    const p = policy();
    expect(authorise(p, request({ url: "/?token=wrong" }))).toMatchObject({
      kind: "deny",
      status: HTTP_UNAUTHORIZED,
    });
    expect(
      authorise(
        p,
        request({ method: "POST", url: `/api/action?token=${p.token}` }),
      ),
    ).toMatchObject({ kind: "deny", status: HTTP_UNAUTHORIZED });
  });

  it("rejects a Host naming another domain with 403 even when the token is right (DNS rebinding)", () => {
    const p = policy();
    const decision = authorise(
      p,
      request({
        headers: {
          host: `rebind.example:${String(PORT)}`,
          authorization: `Bearer ${p.token}`,
        },
      }),
    );
    expect(decision).toMatchObject({ kind: "deny", status: HTTP_FORBIDDEN });
  });

  it("rejects a Host on the right address but the wrong port, and a missing Host", () => {
    const p = policy();
    const authorization = `Bearer ${p.token}`;
    expect(
      authorise(p, request({ headers: { host: `${BIND}:1`, authorization } })),
    ).toMatchObject({ kind: "deny", status: HTTP_FORBIDDEN });
    expect(authorise(p, request({ headers: { authorization } }))).toMatchObject(
      { kind: "deny", status: HTTP_FORBIDDEN },
    );
  });

  it("accepts this machine's own hostname as the Host", () => {
    const p = policy();
    const machine = os.hostname().replace(/\.local$/i, "");
    const decision = authorise(
      p,
      request({
        headers: {
          host: `${machine}.local:${String(PORT)}`,
          authorization: `Bearer ${p.token}`,
        },
      }),
    );
    expect(decision).toEqual({ kind: "allow" });
  });

  it("rejects a cross-origin request carrying a valid cookie", () => {
    const p = policy();
    const decision = authorise(
      p,
      request({
        headers: {
          host: HOST_HEADER,
          cookie: `${ACCESS_COOKIE_NAME}=${p.token}`,
          origin: `http://${BIND}:9999`,
        },
      }),
    );
    expect(decision).toMatchObject({ kind: "deny", status: HTTP_FORBIDDEN });
  });

  it("allows a same-origin request carrying a valid cookie", () => {
    const p = policy();
    const decision = authorise(
      p,
      request({
        headers: {
          host: HOST_HEADER,
          cookie: `${ACCESS_COOKIE_NAME}=${p.token}`,
          origin: `http://${HOST_HEADER}`,
        },
      }),
    );
    expect(decision).toEqual({ kind: "allow" });
  });
});
