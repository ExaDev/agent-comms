/**
 * Unit tests for the web server's network exposure gate (agent-comms#346): bind resolution, the constant-time token comparison, and the per-request decision for loopback and non-loopback clients.
 */

import { describe, expect, it } from "vitest";
import * as os from "node:os";
import {
  accessCookieName,
  accessUrls,
  authorise,
  canonicalAddress,
  generateAccessToken,
  HOSTED_DASHBOARD_ORIGIN,
  isLoopbackAddress,
  isWildcardHost,
  localWebUrl,
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

const COOKIE_NAME = accessCookieName(PORT);

/** A policy for a LAN bind whose machine has no interface addresses, so every non-loopback client is a remote device. */
function policy(overrides: Readonly<Partial<AccessPolicy>> = {}): AccessPolicy {
  return {
    token: generateAccessToken(),
    bindHost: BIND,
    port: PORT,
    localClientAddresses: () => new Set(),
    ...overrides,
  };
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

  it.each(["::0", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "::ffff:0:0"])(
    "canonicalises the wildcard spelling %s so it is classified as a wildcard",
    (spelling) => {
      const host = resolveWebBindHost(spelling, {});
      expect(isWildcardHost(host)).toBe(true);
      expect(requiresAccessToken(host)).toBe(true);
    },
  );

  it("rejects a value that is not an IP address instead of falling back", () => {
    expect(() =>
      resolveWebBindHost(undefined, { [WEB_HOST_ENV]: "lan" }),
    ).toThrow(WEB_HOST_ENV);
  });
});

describe("canonicalAddress", () => {
  it.each([
    ["::0", "::"],
    ["0:0:0:0:0:0:0:1", "::1"],
    ["::ffff:127.0.0.1", "127.0.0.1"],
    ["::ffff:7f00:1", "127.0.0.1"],
    ["192.168.1.10", "192.168.1.10"],
    ["fe80::1%en0", "fe80::1%en0"],
  ])("spells %s as %s", (input, expected) => {
    expect(canonicalAddress(input)).toBe(expected);
  });
});

describe("isWildcardHost", () => {
  it.each(["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0"])(
    "%s binds every interface",
    (host) => {
      expect(isWildcardHost(host)).toBe(true);
    },
  );

  it.each(["192.168.1.10", "127.0.0.1", "::1", "fe80::1%en0"])(
    "%s binds one interface",
    (host) => {
      expect(isWildcardHost(host)).toBe(false);
    },
  );
});

describe("localWebUrl", () => {
  it("maps a wildcard bind to loopback and keeps a specific bind", () => {
    expect(localWebUrl("0.0.0.0", PORT)).toBe(`http://127.0.0.1:${PORT}`);
    expect(localWebUrl("::", PORT)).toBe(`http://127.0.0.1:${PORT}`);
    expect(localWebUrl(BIND, PORT)).toBe(`http://${BIND}:${PORT}`);
  });

  it("brackets an IPv6 bind", () => {
    expect(localWebUrl("::1", PORT)).toBe(`http://[::1]:${PORT}`);
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
  it("allows a loopback client with a loopback Host and no token, under a loopback bind", () => {
    const loopbackBind = policy({ token: undefined, bindHost: LOOPBACK_HOST });
    for (const host of ["localhost", LOOPBACK_HOST, "[::1]"]) {
      expect(
        authorise(
          loopbackBind,
          request({
            remoteAddress: "127.0.0.1",
            headers: { host: `${host}:${String(PORT)}` },
          }),
        ),
      ).toEqual({ kind: "allow" });
    }
  });

  it("rejects a rebound Host from a loopback client, under a loopback bind and under a LAN bind", () => {
    for (const p of [
      policy({ token: undefined, bindHost: LOOPBACK_HOST }),
      policy(),
    ]) {
      expect(
        authorise(
          p,
          request({
            remoteAddress: "127.0.0.1",
            headers: { host: `rebind.example:${String(PORT)}` },
          }),
        ),
      ).toMatchObject({ kind: "deny", status: HTTP_FORBIDDEN });
    }
  });

  it("rejects the wildcard address as a Host even from loopback, under a wildcard bind", () => {
    expect(
      authorise(
        policy({ bindHost: "0.0.0.0" }),
        request({
          remoteAddress: "127.0.0.1",
          headers: { host: `0.0.0.0:${String(PORT)}` },
        }),
      ),
    ).toMatchObject({ kind: "deny", status: HTTP_FORBIDDEN });
  });

  it("allows a loopback client without a token under a LAN bind", () => {
    const decision = authorise(
      policy(),
      request({
        remoteAddress: "127.0.0.1",
        headers: { host: `localhost:${String(PORT)}` },
      }),
    );
    expect(decision).toEqual({ kind: "allow" });
  });

  it("allows a client connecting from one of this machine's own interface addresses without a token", () => {
    const decision = authorise(
      policy({ localClientAddresses: () => new Set([BIND]) }),
      request({ remoteAddress: BIND }),
    );
    expect(decision).toEqual({ kind: "allow" });
  });

  it("answers 401 to a remote client under a loopback bind, which has no token to present", () => {
    expect(
      authorise(
        policy({ token: undefined, bindHost: LOOPBACK_HOST }),
        request({ headers: { host: `localhost:${String(PORT)}` } }),
      ),
    ).toMatchObject({ kind: "deny", status: HTTP_UNAUTHORIZED });
  });

  it("scopes the cookie to the server's port so two servers on one host keep separate cookies", () => {
    const portA = 41001;
    const portB = 41002;
    const a = policy({ port: portA });
    const b = policy({ port: portB });
    const both = `${accessCookieName(portA)}=${a.token}; ${accessCookieName(portB)}=${b.token}`;
    const via = (p: Readonly<AccessPolicy>, port: number, cookie: string) =>
      authorise(
        p,
        request({ headers: { host: `${BIND}:${String(port)}`, cookie } }),
      );
    expect(via(a, portA, both)).toEqual({ kind: "allow" });
    expect(via(b, portB, both)).toEqual({ kind: "allow" });
    expect(accessCookieName(portA)).not.toBe(accessCookieName(portB));
    expect(
      via(a, portA, `${accessCookieName(portB)}=${b.token}`),
    ).toMatchObject({ kind: "deny", status: HTTP_UNAUTHORIZED });
    expect(
      via(b, portB, `${accessCookieName(portA)}=${a.token}`),
    ).toMatchObject({ kind: "deny", status: HTTP_UNAUTHORIZED });
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
            cookie: `a=b; ${COOKIE_NAME}=${p.token}`,
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
            cookie: `${COOKIE_NAME}=wrong`,
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
      cookie: `${COOKIE_NAME}=${p.token}; HttpOnly; SameSite=Lax; Path=/`,
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
          cookie: `${COOKIE_NAME}=${p.token}`,
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
          cookie: `${COOKIE_NAME}=${p.token}`,
          origin: `http://${HOST_HEADER}`,
        },
      }),
    );
    expect(decision).toEqual({ kind: "allow" });
  });

  it("rejects a foreign Origin from a loopback client, under a loopback bind and a wildcard bind", () => {
    for (const bindHost of [LOOPBACK_HOST, "0.0.0.0"]) {
      const decision = authorise(
        policy({ token: undefined, bindHost }),
        request({
          remoteAddress: "127.0.0.1",
          headers: {
            host: `127.0.0.1:${String(PORT)}`,
            origin: "https://evil.example",
          },
        }),
      );
      expect(decision).toMatchObject({ kind: "deny", status: HTTP_FORBIDDEN });
    }
  });

  it("rejects a foreign Origin from a client on this machine's own interface address", () => {
    const decision = authorise(
      policy({ localClientAddresses: () => new Set([LAN_CLIENT]) }),
      request({
        headers: { host: HOST_HEADER, origin: "https://evil.example" },
      }),
    );
    expect(decision).toMatchObject({ kind: "deny", status: HTTP_FORBIDDEN });
  });

  it("rejects an https Origin whose host and port match this server", () => {
    const decision = authorise(
      policy({ token: undefined, bindHost: LOOPBACK_HOST }),
      request({
        remoteAddress: "127.0.0.1",
        headers: {
          host: `127.0.0.1:${String(PORT)}`,
          origin: `https://127.0.0.1:${String(PORT)}`,
        },
      }),
    );
    expect(decision).toMatchObject({ kind: "deny", status: HTTP_FORBIDDEN });
  });

  it("allows an http Origin naming a loopback name on the bound port from a loopback client", () => {
    const decision = authorise(
      policy({ token: undefined, bindHost: LOOPBACK_HOST }),
      request({
        remoteAddress: "127.0.0.1",
        headers: {
          host: `127.0.0.1:${String(PORT)}`,
          origin: `http://localhost:${String(PORT)}`,
        },
      }),
    );
    expect(decision).toEqual({ kind: "allow" });
  });

  it("allows the hosted dashboard's Origin from a loopback client only", () => {
    const loopback = authorise(
      policy({ token: undefined, bindHost: LOOPBACK_HOST }),
      request({
        remoteAddress: "127.0.0.1",
        headers: {
          host: `127.0.0.1:${String(PORT)}`,
          origin: HOSTED_DASHBOARD_ORIGIN,
        },
      }),
    );
    expect(loopback).toEqual({ kind: "allow" });
    const p = policy();
    const remote = authorise(
      p,
      request({
        headers: {
          host: HOST_HEADER,
          cookie: `${COOKIE_NAME}=${p.token}`,
          origin: HOSTED_DASHBOARD_ORIGIN,
        },
      }),
    );
    expect(remote).toMatchObject({ kind: "deny", status: HTTP_FORBIDDEN });
  });

  it("accepts the Bearer scheme in any letter case and rejects other schemes", () => {
    const p = policy();
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      expect(
        authorise(
          p,
          request({
            headers: {
              host: HOST_HEADER,
              authorization: `${scheme} ${String(p.token)}`,
            },
          }),
        ),
      ).toEqual({ kind: "allow" });
    }
    expect(
      authorise(
        p,
        request({
          headers: {
            host: HOST_HEADER,
            authorization: `Basic ${String(p.token)}`,
          },
        }),
      ),
    ).toMatchObject({ kind: "deny", status: HTTP_UNAUTHORIZED });
  });
});

describe("accessUrls", () => {
  const MAC = "00:00:00:00:00:00";

  function v4(address: string, internal: boolean): os.NetworkInterfaceInfoIPv4 {
    return {
      address,
      family: "IPv4",
      internal,
      netmask: "255.255.255.0",
      mac: MAC,
      cidr: null,
    };
  }

  function v6(address: string): os.NetworkInterfaceInfoIPv6 {
    return {
      address,
      family: "IPv6",
      internal: false,
      netmask: "ffff:ffff:ffff:ffff::",
      mac: MAC,
      cidr: null,
      scopeid: 0,
    };
  }

  const loopback = { lo0: [v4("127.0.0.1", true)] };
  const lan = {
    en0: [v4("192.168.1.10", false), v6("fe80::1"), v6("2001:db8::10")],
    ...loopback,
  };

  function listFor(
    bindHost: string,
    interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  ): string[] {
    return accessUrls(
      { ...policy({ bindHost }), token: "t" },
      () => interfaces,
    );
  }

  it("lists external IPv4 and non-link-local IPv6 addresses, bracketed, under the IPv6 wildcard", () => {
    expect(listFor("::", lan)).toEqual([
      `http://192.168.1.10:${String(PORT)}/?token=t`,
      `http://[2001:db8::10]:${String(PORT)}/?token=t`,
    ]);
  });

  it("lists only IPv4 addresses under the IPv4 wildcard, which accepts no IPv6 connection", () => {
    expect(listFor("0.0.0.0", lan)).toEqual([
      `http://192.168.1.10:${String(PORT)}/?token=t`,
    ]);
  });

  it("lists nothing when a wildcard bind finds no external address", () => {
    expect(listFor("0.0.0.0", loopback)).toEqual([]);
  });

  it("lists the bound address under a specific bind", () => {
    expect(listFor(BIND, loopback)).toEqual([
      `http://${BIND}:${String(PORT)}/?token=t`,
    ]);
  });
});
