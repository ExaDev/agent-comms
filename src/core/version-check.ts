/**
 * Detects when a newer agent-comms release exists on npm than the one currently running -- see issue #166. A stale checkout (e.g. a manually pulled git checkout left behind while npm moves on) surfaces its own drift via CommsTool's whoami/update output (see tool.ts) rather than silently splitting mesh generations. Every failure mode (offline, registry down, timeout, malformed response) is swallowed here: a bridge with no network access behaves exactly as if no newer release were known, never as an error.
 */

/** Minimal shape of a fetch() call, injectable so tests never need a real network round trip or a global fetch stub. */
export type FetchLike = (
  input: string,
  init?: Readonly<RequestInit>,
) => Promise<Response>;

const NPM_REGISTRY_LATEST_VERSION_URL =
  "https://registry.npmjs.org/agent-comms/latest";

/** How long a single npm registry lookup may take before it's treated as a failure -- generous for a slow connection, short enough that a hung request can never pile up across successive interval checks. */
const REGISTRY_FETCH_TIMEOUT_MS = 5000;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const CHECK_INTERVAL_HOURS = 6;

/** How often VersionDriftChecker re-checks npm once started. Deliberately slow: this is a background courtesy warning that piggybacks on whoami/update output (see tool.ts), not a thing any caller waits on, so there's no benefit to checking more often than a bridge process is likely to stay running for. */
export const DEFAULT_CHECK_INTERVAL_MS =
  CHECK_INTERVAL_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

interface NpmRegistryLatestResponse {
  version: string;
}

function isNpmRegistryLatestResponse(
  value: unknown,
): value is NpmRegistryLatestResponse {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value)) return false;
  return typeof value.version === "string";
}

/** Fetches the "latest" dist-tag version currently published to npm, or undefined on any failure (offline, timeout, non-2xx, malformed body) -- callers never need their own try/catch around this. */
export async function fetchLatestPublishedVersion(options?: {
  registryUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<string | undefined> {
  const { registryUrl = NPM_REGISTRY_LATEST_VERSION_URL, fetchImpl = fetch } =
    options ?? {};
  try {
    const response = await fetchImpl(registryUrl, {
      signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!isNpmRegistryLatestResponse(body)) return undefined;
    return body.version;
  } catch {
    return undefined;
  }
}

const VERSION_CORE_PART_COUNT = 3;

/** Parses a "x.y.z[-prerelease][+build]" version string's numeric major/minor/patch parts, ignoring any prerelease/build suffix -- agent-comms releases are always plain x.y.z (semantic-release's own default), so a fuller semver-precedence comparator (prerelease ordering, build-metadata rules) would be speculative generality with no real input that needs it. Returns undefined for a string that isn't three dot-separated non-negative integers. */
function parseVersionCore(
  version: string,
): [number, number, number] | undefined {
  const core = version.split(/[+-]/, 1)[0] ?? "";
  const parts = core.split(".");
  if (parts.length !== VERSION_CORE_PART_COUNT) return undefined;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  const isValid = [major, minor, patch].every(
    (part) => Number.isInteger(part) && part >= 0,
  );
  if (!isValid) return undefined;
  return [major, minor, patch];
}

/** True when latest is a strictly greater release than current, by major.minor.patch precedence. Returns false for either string that doesn't parse as a plain x.y.z version -- a malformed comparison has no safe "yes, warn" answer. */
export function isNewerVersion(current: string, latest: string): boolean {
  const currentCore = parseVersionCore(current);
  const latestCore = parseVersionCore(latest);
  if (currentCore === undefined || latestCore === undefined) return false;
  const [currentMajor, currentMinor, currentPatch] = currentCore;
  const [latestMajor, latestMinor, latestPatch] = latestCore;
  if (latestMajor !== currentMajor) return latestMajor > currentMajor;
  if (latestMinor !== currentMinor) return latestMinor > currentMinor;
  return latestPatch > currentPatch;
}

export interface VersionDriftCheckerOptions {
  currentVersion: string;
  intervalMs?: number;
  fetchLatestVersion?: () => Promise<string | undefined>;
}

/**
 * Periodically (and once immediately on start()) compares the running version against npm's published "latest" dist-tag, caching the most recent successful lookup so CommsTool's whoami/update output can surface a "newer release available" note without either of them ever waiting on a network call. A failed check leaves the previously cached result untouched -- see this file's own header for why a failure is never surfaced as an error.
 */
export class VersionDriftChecker {
  private readonly currentVersion: string;
  private readonly intervalMs: number;
  private readonly fetchLatestVersion: () => Promise<string | undefined>;
  private latestKnownVersion: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: Readonly<VersionDriftCheckerOptions>) {
    this.currentVersion = options.currentVersion;
    this.intervalMs = options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.fetchLatestVersion =
      options.fetchLatestVersion ?? (async () => fetchLatestPublishedVersion());
  }

  /** Runs one check immediately (fire-and-forget -- start() itself never waits on the network) and schedules a recurring check every intervalMs. The interval is unref'd so it can never keep a bridge process alive on its own. No-op if already started. */
  start(): void {
    if (this.timer !== undefined) return;
    void this.check();
    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Stops the recurring check, if running. Safe to call even if start() was never called. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The most recently observed newer release, or undefined when none is known -- either no successful check has completed yet, or the running version is already current (or ahead). */
  getNewerVersionIfAny(): string | undefined {
    if (this.latestKnownVersion === undefined) return undefined;
    return isNewerVersion(this.currentVersion, this.latestKnownVersion)
      ? this.latestKnownVersion
      : undefined;
  }

  /** Runs a single check, tolerating a rejection from a caller-supplied fetchLatestVersion as well as the soft-failure (undefined) contract fetchLatestPublishedVersion's own default already guarantees -- start()'s own fire-and-forget call, and the recurring interval callback, both rely on this never throwing regardless of which fetch implementation is wired in. */
  private async check(): Promise<void> {
    try {
      const latest = await this.fetchLatestVersion();
      if (latest !== undefined) this.latestKnownVersion = latest;
    } catch {
      // Swallowed deliberately -- see this file's own header on failing soft.
    }
  }
}
