/**
 * The access check for a request target that names no URL: a remote client is refused with 400 and the check never throws, since a throw out of the request listener would end the process; a client on this machine never reaches the URL.
 */

import { describe, expect, it } from "vitest";
import { authorise, type AccessPolicy } from "../web-access.js";

const PORT = 41234;
const BIND = "192.168.1.10";
const REMOTE_CLIENT = "192.168.1.50";
const HTTP_BAD_REQUEST = 400;

function policy(localAddresses: ReadonlySet<string>): AccessPolicy {
  return {
    token: "token-for-the-test",
    bindHost: BIND,
    port: PORT,
    localClientAddresses: () => localAddresses,
  };
}

function request(url: string) {
  return {
    method: "GET",
    url,
    remoteAddress: REMOTE_CLIENT,
    headers: { host: `${BIND}:${String(PORT)}` },
  };
}

describe("authorise for a request target that names no URL", () => {
  it.each(["//", "///", "//?x=1"])(
    "refuses %s from a remote client without throwing",
    (target) => {
      const decision = authorise(policy(new Set()), request(target));

      expect(decision).toMatchObject({
        kind: "deny",
        status: HTTP_BAD_REQUEST,
      });
    },
  );

  it("still admits a client on this machine, which never reaches the URL", () => {
    const decision = authorise(policy(new Set([REMOTE_CLIENT])), request("//"));

    expect(decision.kind).toBe("allow");
  });
});
