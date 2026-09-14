// Pure retry logic for scripts/publish-mcp-registry.ts, kept here rather than in the script itself so it's testable under src/test/ -- tsconfig.json's rootDir is src/, so a test there can't import from scripts/ (outside that root), while a script importing from src/ is the normal direction. The script itself keeps the actual Date.now()/spawnSync-driven retry loop, which is inherently imperative and time-based; this module holds only the two decisions that loop makes that are worth asserting deterministically.

// The MCP registry validates a publish against the npm registry, where the version semantic-release published seconds earlier may not be visible yet. The registry's own error text says to wait and retry, so retry that failure specifically instead of failing the release job on propagation lag.
//
// Confirmed insufficient in production (ExaDev/agent-comms, 2026-09-13, v2.18.0): the original fixed [15, 30, 60, 120] schedule (225s total) exhausted and failed the release job while npm's own CDN still hadn't propagated the just-published version -- a real, observed lag longer than that budget, not a hypothetical one. The release job carries no timeout-minutes of its own, so there's no tight external deadline forcing a small retry budget.
export const INITIAL_RETRY_DELAY_MS = 15_000;
export const MAX_RETRY_DELAY_MS = 120_000;
export const RETRY_BACKOFF_MULTIPLIER = 2;
const MAX_TOTAL_RETRY_MINUTES = 15;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
export const MAX_TOTAL_RETRY_MS =
  MAX_TOTAL_RETRY_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** The next delay in the doubling-with-cap backoff schedule, given the delay just used. */
export function nextRetryDelayMs(previousDelayMs: number): number {
  return Math.min(
    previousDelayMs * RETRY_BACKOFF_MULTIPLIER,
    MAX_RETRY_DELAY_MS,
  );
}

/** The MCP registry's own npm-propagation-lag error text -- the version semantic-release just published may not be visible to the registry's own npm lookup for a few seconds. */
function isNpmPropagationLag(output: string): boolean {
  return (
    output.includes("was not found") &&
    output.includes("A newly published release can take a moment")
  );
}

// Confirmed as a second, distinct retryable failure mode in the same run this retry logic was first fixed for (ExaDev/agent-comms, 2026-09-13, v2.18.1): the registry returned a genuine HTTP 504 (a transient gateway timeout on the registry's own infrastructure, not anything to do with npm propagation), and the retry logic at the time only recognised the propagation-lag text above, so it failed the release job immediately instead of retrying a condition that resolved itself on a plain re-run seconds later. Any 5xx is the registry's own server failing to complete the request, not this side's request being wrong -- exactly the class of error a retry can plausibly fix, unlike a 4xx (this side asked for something invalid) other than the specific propagation-lag 404 already handled above.
const SERVER_ERROR_STATUS_PATTERN = /server returned status 5\d{2}\b/;

function isRetryableServerError(output: string): boolean {
  return SERVER_ERROR_STATUS_PATTERN.test(output);
}

/** Recognises a publish failure worth retrying (npm propagation lag, or a transient 5xx from the registry's own infrastructure) as opposed to any other failure -- a genuinely invalid publish request, for instance, which retrying can never fix. */
export function isRetryablePublishFailure(output: string): boolean {
  return isNpmPropagationLag(output) || isRetryableServerError(output);
}
