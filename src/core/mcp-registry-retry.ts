// Pure retry logic for scripts/publish-mcp-registry.ts, kept here rather than in the script itself so it's testable under src/test/ -- tsconfig.json's rootDir is src/, so a test there can't import from scripts/ (outside that root), while a script importing from src/ is the normal direction. The script itself keeps the actual Date.now()/spawnSync-driven retry loop, which is inherently imperative and time-based; this module holds only the two decisions that loop makes that are worth asserting deterministically.

// The MCP registry validates a publish against the npm registry, where the version semantic-release published seconds earlier may not be visible yet. The registry's own error text says to wait and retry, so retry that failure specifically instead of failing the release job on propagation lag.
//
// Confirmed insufficient in production (ExaDev/agent-comms, 2026-09-13, v2.18.0): the original fixed [15, 30, 60, 120] schedule (225s total) exhausted and failed the release job while npm's own CDN still hadn't propagated the just-published version -- a real, observed lag longer than that budget, not a hypothetical one. The release job carries no timeout-minutes of its own, so there's no tight external deadline forcing a small retry budget.
export const INITIAL_RETRY_DELAY_MS = 15_000;
export const MAX_RETRY_DELAY_MS = 120_000;
export const RETRY_BACKOFF_MULTIPLIER = 2;
export const MAX_TOTAL_RETRY_MS = 15 * 60 * 1000;

/** The next delay in the doubling-with-cap backoff schedule, given the delay just used. */
export function nextRetryDelayMs(previousDelayMs: number): number {
  return Math.min(
    previousDelayMs * RETRY_BACKOFF_MULTIPLIER,
    MAX_RETRY_DELAY_MS,
  );
}

/** Recognises the MCP registry's own npm-propagation-lag error text -- the specific, recoverable failure worth retrying, as opposed to any other publish failure. */
export function isNpmPropagationLag(output: string): boolean {
  return (
    output.includes("was not found") &&
    output.includes("A newly published release can take a moment")
  );
}
