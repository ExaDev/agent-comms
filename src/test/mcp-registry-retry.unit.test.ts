import { describe, it, expect } from "vitest";
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  MAX_TOTAL_RETRY_MS,
  isRetryablePublishFailure,
  nextRetryDelayMs,
} from "../core/mcp-registry-retry.js";

const DELAY_DOUBLING_FACTOR = 2;
const MULTIPLIER_WELL_BEYOND_MAX_DELAY = 10;
const MS_PER_SECOND = 1000;
const LEGACY_SCHEDULE_STEP_1_SECONDS = 15;
const LEGACY_SCHEDULE_STEP_2_SECONDS = 30;
const LEGACY_SCHEDULE_STEP_3_SECONDS = 60;
const LEGACY_SCHEDULE_STEP_4_SECONDS = 120;

describe("nextRetryDelayMs", () => {
  it("doubles the previous delay", () => {
    expect(nextRetryDelayMs(INITIAL_RETRY_DELAY_MS)).toBe(
      INITIAL_RETRY_DELAY_MS * DELAY_DOUBLING_FACTOR,
    );
  });

  it("caps at MAX_RETRY_DELAY_MS", () => {
    expect(nextRetryDelayMs(MAX_RETRY_DELAY_MS)).toBe(MAX_RETRY_DELAY_MS);
    expect(
      nextRetryDelayMs(MAX_RETRY_DELAY_MS * MULTIPLIER_WELL_BEYOND_MAX_DELAY),
    ).toBe(MAX_RETRY_DELAY_MS);
  });

  it("accumulates to comfortably exceed the previous, confirmed-insufficient 225-second retry budget (agent-comms v2.18.0's release job exhausted a fixed [15, 30, 60, 120] schedule while npm's own CDN still hadn't propagated the just-published version)", () => {
    const previousBudgetMs =
      (LEGACY_SCHEDULE_STEP_1_SECONDS +
        LEGACY_SCHEDULE_STEP_2_SECONDS +
        LEGACY_SCHEDULE_STEP_3_SECONDS +
        LEGACY_SCHEDULE_STEP_4_SECONDS) *
      MS_PER_SECOND;
    let delayMs = INITIAL_RETRY_DELAY_MS;
    let totalMs = 0;
    while (totalMs < MAX_TOTAL_RETRY_MS) {
      totalMs += delayMs;
      delayMs = nextRetryDelayMs(delayMs);
    }
    expect(totalMs > previousBudgetMs).toBeTruthy();
    expect(totalMs >= MAX_TOTAL_RETRY_MS).toBeTruthy();
  });
});

describe("isRetryablePublishFailure", () => {
  it("recognises the MCP registry's own npm-propagation-lag error text", () => {
    const output =
      "registry validation failed for package 0 (agent-comms): NPM package 'agent-comms' exists, but version '2.18.0' was not found (status: 404). A newly published release can take a moment to appear on the registry. Wait and retry, or publish version '2.18.0' before registering it";
    expect(isRetryablePublishFailure(output)).toBe(true);
  });

  it("recognises a transient 5xx from the registry's own infrastructure -- confirmed as a real, second retryable failure mode (ExaDev/agent-comms, 2026-09-13, v2.18.1): the registry returned a genuine HTTP 504 that resolved itself on a plain re-run seconds later, but the retry logic at the time only recognised the propagation-lag text above and failed the release job immediately instead of retrying it", () => {
    const output = "Error: publish failed: server returned status 504: <html>";
    expect(isRetryablePublishFailure(output)).toBe(true);
  });

  it("does not retry a 4xx other than the specific propagation-lag 404 -- a genuinely invalid publish request, which retrying can never fix", () => {
    const output =
      "Error: publish failed: server returned status 400: Bad Request";
    expect(isRetryablePublishFailure(output)).toBe(false);
  });

  it("does not misclassify an unrelated failure as retryable", () => {
    expect(isRetryablePublishFailure("permission denied")).toBe(false);
  });

  it("recognises a raw connection-level failure with no HTTP status, confirmed in production (ExaDev/agent-comms, run 35249771867, v3.9.0): a dial-tcp i/o timeout reaching the registry, which matches neither the propagation-lag text nor the 5xx status pattern above since no HTTP response was ever received", () => {
    const output =
      'Error: publish failed: error sending request: Post "https://registry.modelcontextprotocol.io/v0/publish": dial tcp 34.61.200.254:443: i/o timeout';
    expect(isRetryablePublishFailure(output)).toBe(true);
  });

  it("recognises a connection-refused failure as the same class of connection-level error", () => {
    const output =
      'Error: publish failed: error sending request: Post "https://registry.modelcontextprotocol.io/v0/publish": dial tcp 34.61.200.254:443: connect: connection refused';
    expect(isRetryablePublishFailure(output)).toBe(true);
  });

  it("recognises a 401 caused by the login JWT expiring mid-retry-window, confirmed in production (ExaDev/agent-comms, run 35239013253, v3.9.0): mcp-publisher logs in once before the retry loop starts, and a retry attempt late in the 15-minute budget can present a token that has since expired", () => {
    const output =
      'Error: publish failed: server returned status 401: {"title":"Unauthorized","status":401,"detail":"Invalid or expired Registry JWT token","instance":"/v0/publish"}';
    expect(isRetryablePublishFailure(output)).toBe(true);
  });

  it("does not retry a 401 that is a genuine authorisation failure rather than an expired token, since retrying an unrecognised or wrongly-scoped credential can never fix it", () => {
    const output =
      'Error: publish failed: server returned status 401: {"title":"Unauthorized","status":401,"detail":"Registry JWT token does not grant publish access to this namespace","instance":"/v0/publish"}';
    expect(isRetryablePublishFailure(output)).toBe(false);
  });
});
