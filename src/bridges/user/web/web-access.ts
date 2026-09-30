/**
 * Network exposure policy for the bridge web server (agent-comms#346).
 *
 * The default is loopback only, with no token. Setting AGENT_COMMS_WEB_HOST to a non-loopback address is the explicit opt-in to LAN reachability. Because the server exposes every mutating action (POST /api/action and the /ws/mesh oRPC socket), a non-loopback bind always comes with a per-process secret token. Every request, from any client, must carry a Host header naming this server (the DNS rebinding defence: a rebound name resolves here but arrives with the attacker's name in Host). A client on this machine (loopback, or one of this machine's own interface addresses) needs nothing more. Any other client must also present the token (as a bearer token, or as the cookie a one-time `?token=` URL exchange sets) and, when it carries an Origin, carry one that names the same host.
 */

import * as crypto from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";

/** The environment variable that opts the web server into binding beyond loopback. Its value is an IP address literal to bind: `0.0.0.0` or `::` for every interface, or one interface's own address. */
export const WEB_HOST_ENV = "AGENT_COMMS_WEB_HOST";

/** The default bind address, reachable from this machine only. */
export const LOOPBACK_HOST = "127.0.0.1";

/** The prefix of the cookie a `?token=` exchange sets. Cookies are scoped to a host and not to a port (RFC 6265 section 8.5), and every bridge on a machine runs its own server on its own port with its own token, so the name carries the port to keep one browser's cookies for two bridges from overwriting each other. */
export const ACCESS_COOKIE_PREFIX = "agent_comms_web_token";

/** The name of the cookie a server listening on `port` sets and reads. */
export function accessCookieName(port: number): string {
  return `${ACCESS_COOKIE_PREFIX}_${String(port)}`;
}

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

/** The names a client on this machine uses for loopback, always accepted in Host whatever the bind. */
const LOOPBACK_HOSTNAMES = ["localhost", LOOPBACK_HOST, LOOPBACK_V6];

/** The radix IPv6 groups are written in, and the bits and mask of one byte of the IPv4 address a mapped group pair spells. */
const HEX_RADIX = 16;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;

/** True for any address in 127.0.0.0/8, for ::1, and for an IPv4-mapped form of either (what a dual-stack socket reports for an IPv4 client). */
export function isLoopbackAddress(address: string): boolean {
  const unmapped = address.startsWith(IPV4_MAPPED_PREFIX)
    ? address.slice(IPV4_MAPPED_PREFIX.length)
    : address;
  return unmapped === LOOPBACK_V6 || unmapped.startsWith(LOOPBACK_V4_PREFIX);
}

/**
 * The canonical spelling of an IP address literal: IPv6 in its compressed form, and an IPv4-mapped IPv6 address as plain IPv4. Every spelling of one address (`::0`, `0:0:0:0:0:0:0:0`, `::ffff:0.0.0.0`) then compares equal, which classification and the Host allow-list rely on. A scoped address (`fe80::1%en0`) is returned unchanged: it is neither a wildcard nor a loopback.
 */
export function canonicalAddress(address: string): string {
  if (net.isIPv4(address) || address.includes("%")) return address;
  const compressed = new URL(`http://[${address}]`).hostname.slice(1, -1);
  if (!compressed.startsWith(IPV4_MAPPED_PREFIX)) return compressed;
  const tail = compressed.slice(IPV4_MAPPED_PREFIX.length);
  if (net.isIPv4(tail)) return tail;
  return tail
    .split(":")
    .flatMap((group) => {
      const value = Number.parseInt(group, HEX_RADIX);
      return [value >> BYTE_BITS, value & BYTE_MASK];
    })
    .join(".");
}

/** True when `host` binds every interface, in any spelling (see canonicalAddress). */
export function isWildcardHost(host: string): boolean {
  const canonical = canonicalAddress(host);
  return canonical === IPV4_WILDCARD || canonical === IPV6_WILDCARD;
}

/** The host part of an `http` URL for `address`: IPv6 literals are bracketed. */
export function urlHost(address: string): string {
  return net.isIPv6(address) ? `[${address}]` : address;
}

/** The URL a client on this machine opens for a server bound to `bindHost` on `port`. A wildcard bind is reached on loopback, which needs no token. */
export function localWebUrl(bindHost: string, port: number): string {
  const host = isWildcardHost(bindHost) ? LOOPBACK_HOST : bindHost;
  return `http://${urlHost(host)}:${String(port)}`;
}

/**
 * Resolves the address the web server binds. An explicit `host` option wins, then the environment variable, then loopback. The result is the canonical spelling of the address. Anything that is not an IP address literal throws: a typo must not silently fall back to a different exposure than the operator asked for.
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
  return canonicalAddress(requested);
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

/** The addresses of this machine's own network interfaces. */
export function ownInterfaceAddresses(): ReadonlySet<string> {
  const addresses = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      addresses.add(canonicalAddress(entry.address));
    }
  }
  return addresses;
}

/** The exposure a running server is under. */
export interface AccessPolicy {
  /** The token every client not on this machine must present. Undefined for a loopback bind, which no such client can reach. */
  readonly token: string | undefined;
  readonly bindHost: string;
  /** The port the server listens on; assigned once it is listening when the OS chose it. */
  port: number;
  /** The addresses whose clients count as on this machine besides loopback, read per request. A client connecting to this machine's own LAN address arrives from that address and not from loopback, so without this the `web_url` of a server bound to one interface address would answer 401 to the operator. Tests replace it to stand in for a remote client. */
  readonly localClientAddresses: () => ReadonlySet<string>;
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

/** Every hostname a client may legitimately use to reach this server: loopback names, the addresses it is bound to and this machine's own name (plus its `.local` mDNS form). Never a name an outside party could make resolve here, which is what DNS rebinding relies on, and never the wildcard address itself, which a page in a local browser can also reach. */
function allowedHostnames(bindHost: string): Set<string> {
  const names = new Set<string>(LOOPBACK_HOSTNAMES);
  if (isWildcardHost(bindHost)) {
    for (const address of ownInterfaceAddresses()) names.add(address);
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

/** A Host header names either an IP literal (compared in canonical form) or a DNS name (compared as is). */
function canonicalAddressOrName(hostname: string): string {
  return net.isIP(hostname) === 0 ? hostname : canonicalAddress(hostname);
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
  const hostname = canonicalAddressOrName(
    parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
  );
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

function cookieToken(
  headers: AccessRequest["headers"],
  cookieName: string,
): string | undefined {
  const cookies = headerValue(headers, "cookie");
  if (cookies === undefined) return undefined;
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === cookieName) return rest.join("=");
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
  token: string,
  headers: AccessRequest["headers"],
): boolean {
  const presented = [
    bearerToken(headers),
    cookieToken(headers, accessCookieName(policy.port)),
  ];
  return presented.some(
    (candidate) => candidate !== undefined && tokensMatch(candidate, token),
  );
}

/** True for a client on this machine: loopback, or one of this machine's own interface addresses. */
function isOwnClient(
  policy: Readonly<AccessPolicy>,
  remoteAddress: string | undefined,
): boolean {
  if (remoteAddress === undefined) return false;
  return (
    isLoopbackAddress(remoteAddress) ||
    policy.localClientAddresses().has(canonicalAddress(remoteAddress))
  );
}

/**
 * Decides whether a request may proceed. The Host header must name this server, for every client. A client on this machine is then allowed. Any other client needs the token (a bearer token or the cookie), and any Origin it sends must be this server; a GET carrying the right `?token=` instead exchanges it for the cookie.
 */
export function authorise(
  policy: Readonly<AccessPolicy>,
  request: AccessRequest,
): AccessDecision {
  if (!hostHeaderAllowed(policy, request.headers)) {
    return { kind: "deny", status: HTTP_FORBIDDEN, message: "Forbidden host" };
  }
  if (isOwnClient(policy, request.remoteAddress)) return { kind: "allow" };
  const { token } = policy;
  if (token === undefined) {
    return { kind: "deny", status: HTTP_UNAUTHORIZED, message: "Unauthorized" };
  }
  if (presentedCredential(policy, token, request.headers)) {
    return originAllowed(request.headers)
      ? { kind: "allow" }
      : { kind: "deny", status: HTTP_FORBIDDEN, message: "Forbidden origin" };
  }
  if (request.method === "GET") {
    const url = new URL(request.url, "http://placeholder");
    const offered = url.searchParams.get(ACCESS_QUERY_PARAM);
    if (offered !== null && tokensMatch(offered, token)) {
      url.searchParams.delete(ACCESS_QUERY_PARAM);
      return {
        kind: "exchange",
        status: HTTP_FOUND,
        cookie: `${accessCookieName(policy.port)}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        location: `${url.pathname}${url.search}`,
      };
    }
  }
  return { kind: "deny", status: HTTP_UNAUTHORIZED, message: "Unauthorized" };
}

/** The URLs an operator can open on the LAN, each carrying the token for the one-time exchange. A wildcard bind lists every external IPv4 address of this machine; a specific bind lists that address. */
export function accessUrls(
  policy: Readonly<AccessPolicy> & { readonly token: string },
): string[] {
  const hosts: string[] = [];
  if (isWildcardHost(policy.bindHost)) {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const entry of addresses ?? []) {
        if (!entry.internal && entry.family === "IPv4")
          hosts.push(entry.address);
      }
    }
  } else {
    hosts.push(urlHost(policy.bindHost));
  }
  return hosts.map(
    (host) =>
      `http://${host}:${String(policy.port)}/?${ACCESS_QUERY_PARAM}=${policy.token}`,
  );
}
