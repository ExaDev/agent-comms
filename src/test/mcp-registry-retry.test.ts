import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  MAX_TOTAL_RETRY_MS,
  isNpmPropagationLag,
  nextRetryDelayMs,
} from "../core/mcp-registry-retry.js";

describe("nextRetryDelayMs", () => {
  it("doubles the previous delay", () => {
    assert.equal(
      nextRetryDelayMs(INITIAL_RETRY_DELAY_MS),
      INITIAL_RETRY_DELAY_MS * 2,
    );
  });

  it("caps at MAX_RETRY_DELAY_MS", () => {
    assert.equal(nextRetryDelayMs(MAX_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS);
    assert.equal(nextRetryDelayMs(MAX_RETRY_DELAY_MS * 10), MAX_RETRY_DELAY_MS);
  });

  it("accumulates to comfortably exceed the previous, confirmed-insufficient 225-second retry budget (agent-comms v2.18.0's release job exhausted a fixed [15, 30, 60, 120] schedule while npm's own CDN still hadn't propagated the just-published version)", () => {
    const previousBudgetMs = (15 + 30 + 60 + 120) * 1000;
    let delayMs = INITIAL_RETRY_DELAY_MS;
    let totalMs = 0;
    while (totalMs < MAX_TOTAL_RETRY_MS) {
      totalMs += delayMs;
      delayMs = nextRetryDelayMs(delayMs);
    }
    assert.ok(totalMs > previousBudgetMs);
    assert.ok(totalMs >= MAX_TOTAL_RETRY_MS);
  });
});

describe("isNpmPropagationLag", () => {
  it("recognises the MCP registry's own npm-propagation-lag error text", () => {
    const output =
      "registry validation failed for package 0 (agent-comms): NPM package 'agent-comms' exists, but version '2.18.0' was not found (status: 404). A newly published release can take a moment to appear on the registry. Wait and retry, or publish version '2.18.0' before registering it";
    assert.equal(isNpmPropagationLag(output), true);
  });

  it("does not misclassify an unrelated failure as propagation lag", () => {
    assert.equal(isNpmPropagationLag("permission denied"), false);
  });
});
