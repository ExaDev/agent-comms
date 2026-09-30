/**
 * Network exposure policy for the bridge web server (agent-comms#346).
 *
 * The default is loopback only, with no authentication, exactly as before. Setting AGENT_COMMS_WEB_HOST to a non-loopback address is the explicit opt-in to LAN reachability. Because the server exposes every mutating action (POST /api/action and the /ws/mesh oRPC socket), a non-loopback bind always comes with a per-process secret token: every request from a non-loopback client must present it (as a bearer token, or as the cookie a one-time `?token=` URL exchange sets), carry a Host header naming an address this server is bound to (DNS rebinding defence), and, when it carries an Origin, carry one that names the same host. Requests from loopback clients skip all three checks, so a local browser or agent behaves as it always did.
 */

import * as crypto from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";

/** The environment variable that opts the web server into binding beyond loopback. Its value is an IP address literal to bind: `0.0.0.0` or `::` for every interface, or one interface's own address. */
export const WEB_HOST_ENV = "AGENT_COMMS_WEB_HOST";

/** The default bind address, reachable from this machine only. */
export const LOOPBACK_HOST = "127.0.0.1";

/** The name of the cookie a `?token=` exchange sets. */
export const ACCESS_COOKIE_NAME = "agent_comms_web_token";

/** The query parameter a one-time URL exchange carries the token in. */
export const ACCESS_QUERY_PARAM = "token";

/** Random bytes in the access token: 256 bits, so guessing is infeasible however many requests a LAN peer can send. */
const ACCESS_TOKEN_BYTES = 32;

/** The port a Host header with no explicit port names (HTTP). */
const HTTP_DEFAULT_PORT = 80;

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_FOUND = 302;

const BEARER_PREFIX = "Bearer ";

const LOOPBACK_V4_PREFIX = "127.";
const IPV4_MAPPED_PREFIX = "::ffff:";
const LOOPBACK_V6 = "::1";
const IPV4_WILDCARD = "0.0.0.0";
const IPV6_WILDCARD = "::";

/** True for any address in 127.0.0.0/8, for ::1, and for an IPv4-mapped form of either (what a dual-stack socket reports for an IPv4 client). */
export function isLoopbackAddress(address: string): boolean {
  const unmapped = address.startsWith(IPV4_MAPPED_PREFIX)
    ? address.slice(IPV4_MAPPED_PREFIX.length)
    : address;
  return unmapped === LOOPBACK_V6 || unmapped.startsWith(LOOPBACK_V4_PREFIX);
}

export function isWildcardHost(host: string): boolean {
  return host === IPV4_WILDCARD || host === IPV6_WILDCARD;
}

/**
 * Resolves the address the web server binds. An explicit `host` option wins, then the environment variable, then loopback. Anything that is not an IP address literal throws: a typo must not silently fall back to a different exposure than the operator asked for.
 */
export function resolveWebBindHost(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const requested = explicit ?? env[WEB_HOST_ENV];
  if (requested === undefined || requested === "") return LOOPBACK_HOST;
  if (net.isIP(requested) === 0) {
    throw new Error(
      `${WEB_HOST_ENV} must be an IP address (for example 0.0.0.0), received "${requested}"`,
    );
  }
  return requested;
}

/** True when binding `host` makes the server reachable from another machine, so the access token applies. */
export function requiresAccessToken(host: string): boolean {
  return !isLoopbackAddress(host);
}

export function generateAccessToken(): string {
  return crypto.randomBytes(ACCESS_TOKEN_BYTES).toString("hex");
}

/**
 * Constant-time token comparison. Both sides are hashed to a fixed length first, because crypto.timingSafeEqual requires equal-length inputs and comparing lengths directly would leak the expected token's length.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const digest = (value: string): Buffer =>
    crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}

/** The exposure a running server is under: the token every non-loopback request must present, and the address and port it is actually bound to. */
export interface AccessPolicy {
  readonly token: string;
  readonly bindHost: string;
  /** The port the server listens on; assigned once it is listening when the OS chose it. */
  port: number;
}

/** The parts of an incoming request the gate looks at. Shared by HTTP requests and WebSocket upgrades (an upgrade is an HTTP request). */
export interface AccessRequest {
  readonly method: string;
  readonly url: string;
  readonly remoteAddress: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export type AccessDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly status: number; readonly message: string }
  | {
      /** The one-time URL exchange: set the cookie and redirect to a URL without the token, so it does not stay in the address bar or history. */
      readonly kind: "exchange";
      readonly status: number;
      readonly cookie: string;
      readonly location: string;
    };

function headerValue(
  headers: AccessRequest["headers"],
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Every hostname a LAN client may legitimately use to reach this server: the addresses it is bound to and this machine's own name (plus its `.local` mDNS form). Never a name an outside party could make resolve here, which is what DNS rebinding relies on. */
function allowedHostnames(bindHost: string): Set<string> {
  const names = new Set<string>();
  if (isWildcardHost(bindHost)) {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const entry of addresses ?? []) {
        names.add(entry.address.toLowerCase());
      }
    }
  } else {
    names.add(bindHost.toLowerCase());
  }
  const machine = os
    .hostname()
    .toLowerCase()
    .replace(/\.local$/, "");
  names.add(machine);
  names.add(`${machine}.local`);
  return names;
}

function parseAuthority(
  authority: string,
): { hostname: string; port: number } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = parsed.port === "" ? HTTP_DEFAULT_PORT : Number(parsed.port);
  return { hostname, port };
}

function hostHeaderAllowed(
  policy: Readonly<AccessPolicy>,
  headers: AccessRequest["headers"],
): boolean {
  const host = headerValue(headers, "host");
  if (host === undefined) return false;
  const authority = parseAuthority(host);
  if (authority === undefined) return false;
  if (authority.port !== policy.port) return false;
  return allowedHostnames(policy.bindHost).has(authority.hostname);
}

/** An Origin, when the browser sends one, must be this very server: otherwise a page from elsewhere on the LAN could drive it with the operator's cookie. */
function originAllowed(headers: AccessRequest["headers"]): boolean {
  const origin = headerValue(headers, "origin");
  if (origin === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return (
    parsed.host.toLowerCase() === headerValue(headers, "host")?.toLowerCase()
  );
}

function cookieToken(headers: AccessRequest["headers"]): string | undefined {
  const cookies = headerValue(headers, "cookie");
  if (cookies === undefined) return undefined;
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ACCESS_COOKIE_NAME) return rest.join("=");
  }
  return undefined;
}

function bearerToken(headers: AccessRequest["headers"]): string | undefined {
  const authorization = headerValue(headers, "authorization");
  if (authorization === undefined) return undefined;
  return authorization.startsWith(BEARER_PREFIX)
    ? authorization.slice(BEARER_PREFIX.length)
    : undefined;
}

function presentedCredential(
  policy: Readonly<AccessPolicy>,
  headers: AccessRequest["headers"],
): boolean {
  const presented = [bearerToken(headers), cookieToken(headers)];
  return presented.some(
    (candidate) =>
      candidate !== undefined && tokensMatch(candidate, policy.token),
  );
}

/**
 * Decides whether a request may proceed. With no policy (a loopback bind) or a loopback client, always allow. Otherwise the Host header must name this server, a bearer token or cookie must match, and any Origin must be this server; a GET carrying the right `?token=` instead exchanges it for the cookie.
 */
export function authorise(
  policy: AccessPolicy | undefined,
  request: AccessRequest,
): AccessDecision {
  if (policy === undefined) return { kind: "allow" };
  if (
    request.remoteAddress !== undefined &&
    isLoopbackAddress(request.remoteAddress)
  ) {
    return { kind: "allow" };
  }
  if (!hostHeaderAllowed(policy, request.headers)) {
    return { kind: "deny", status: HTTP_FORBIDDEN, message: "Forbidden host" };
  }
  if (presentedCredential(policy, request.headers)) {
    return originAllowed(request.headers)
      ? { kind: "allow" }
      : { kind: "deny", status: HTTP_FORBIDDEN, message: "Forbidden origin" };
  }
  if (request.method === "GET") {
    const url = new URL(request.url, "http://placeholder");
    const offered = url.searchParams.get(ACCESS_QUERY_PARAM);
    if (offered !== null && tokensMatch(offered, policy.token)) {
      url.searchParams.delete(ACCESS_QUERY_PARAM);
      return {
        kind: "exchange",
        status: HTTP_FOUND,
        cookie: `${ACCESS_COOKIE_NAME}=${policy.token}; HttpOnly; SameSite=Strict; Path=/`,
        location: `${url.pathname}${url.search}`,
      };
    }
  }
  return { kind: "deny", status: HTTP_UNAUTHORIZED, message: "Unauthorized" };
}

/** The URLs an operator can open on the LAN, each carrying the token for the one-time exchange. A wildcard bind lists every external IPv4 address of this machine; a specific bind lists that address. */
export function accessUrls(policy: Readonly<AccessPolicy>): string[] {
  const hosts: string[] = [];
  if (isWildcardHost(policy.bindHost)) {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const entry of addresses ?? []) {
        if (!entry.internal && entry.family === "IPv4")
          hosts.push(entry.address);
      }
    }
  } else {
    hosts.push(
      net.isIPv6(policy.bindHost) ? `[${policy.bindHost}]` : policy.bindHost,
    );
  }
  return hosts.map(
    (host) =>
      `http://${host}:${String(policy.port)}/?${ACCESS_QUERY_PARAM}=${policy.token}`,
  );
}
