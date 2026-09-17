/**
 * Unit tests for version-check.ts — isNewerVersion, fetchLatestPublishedVersion, VersionDriftChecker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isNewerVersion,
  fetchLatestPublishedVersion,
  VersionDriftChecker,
  DEFAULT_CHECK_INTERVAL_MS,
} from "../version-check.js";
import type { FetchLike } from "../version-check.js";

const TEST_INTERVAL_MS = 1000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const ONE_HOUR_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const REGISTRY_DOWN_RETRY_CALL_COUNT = 1;
const STOPPED_CHECKER_ADVANCE_INTERVAL_COUNT = 5;
const STOPPED_CHECKER_ADVANCE_MS =
  TEST_INTERVAL_MS * STOPPED_CHECKER_ADVANCE_INTERVAL_COUNT;
const THIRD_INTERVAL_CHECK_CALL_COUNT = 3;

describe("isNewerVersion", () => {
  it("is true when the latest major is greater", () => {
    expect(isNewerVersion("1.2.3", "2.0.0")).toBe(true);
  });

  it("is true when major is equal but the latest minor is greater", () => {
    expect(isNewerVersion("1.2.3", "1.3.0")).toBe(true);
  });

  it("is true when major and minor are equal but the latest patch is greater", () => {
    expect(isNewerVersion("1.2.3", "1.2.4")).toBe(true);
  });

  it("is false when the versions are identical", () => {
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
  });

  it("is false when the current version is already ahead", () => {
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(false);
  });

  it("is false when either version does not parse as a plain x.y.z version", () => {
    expect(isNewerVersion("1.2.3", "not-a-version")).toBe(false);
    expect(isNewerVersion("not-a-version", "1.2.3")).toBe(false);
    expect(isNewerVersion("1.2", "1.3.0")).toBe(false);
  });

  it("compares only the numeric core, ignoring a prerelease or build suffix", () => {
    expect(isNewerVersion("1.2.3", "1.2.4-beta.1")).toBe(true);
    expect(isNewerVersion("1.2.3+build5", "1.2.4")).toBe(true);
  });
});

describe("fetchLatestPublishedVersion", () => {
  it("returns the version from a successful registry response", async () => {
    const fakeFetch: FetchLike = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 }),
      ),
    );
    const version = await fetchLatestPublishedVersion(
      "https://example.invalid/agent-comms/latest",
      fakeFetch,
    );
    expect(version).toBe("9.9.9");
  });

  it("fails soft (returns undefined) when the fetch rejects, e.g. offline", async () => {
    const fakeFetch: FetchLike = vi.fn(async () =>
      Promise.reject(new Error("network unreachable")),
    );
    const version = await fetchLatestPublishedVersion(
      "https://example.invalid/agent-comms/latest",
      fakeFetch,
    );
    expect(version).toBeUndefined();
  });

  it("fails soft when the registry responds with a non-2xx status", async () => {
    const fakeFetch: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response("not found", { status: 404 })),
    );
    const version = await fetchLatestPublishedVersion(
      "https://example.invalid/agent-comms/latest",
      fakeFetch,
    );
    expect(version).toBeUndefined();
  });

  it("fails soft when the response body has no version field", async () => {
    const fakeFetch: FetchLike = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ notVersion: "x" }), { status: 200 }),
      ),
    );
    const version = await fetchLatestPublishedVersion(
      "https://example.invalid/agent-comms/latest",
      fakeFetch,
    );
    expect(version).toBeUndefined();
  });

  it("fails soft when the response body is not valid JSON", async () => {
    const fakeFetch: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response("not json", { status: 200 })),
    );
    const version = await fetchLatestPublishedVersion(
      "https://example.invalid/agent-comms/latest",
      fakeFetch,
    );
    expect(version).toBeUndefined();
  });
});

describe("VersionDriftChecker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has no known newer version before start() has run", () => {
    const checker = new VersionDriftChecker({
      currentVersion: "1.0.0",
      fetchLatestVersion: async () => Promise.resolve("2.0.0"),
    });
    expect(checker.getNewerVersionIfAny()).toBeUndefined();
  });

  it("surfaces a newer version discovered by the immediate start() check", async () => {
    const checker = new VersionDriftChecker({
      currentVersion: "1.0.0",
      fetchLatestVersion: async () => Promise.resolve("1.1.0"),
    });
    checker.start();
    await vi.waitFor(() => {
      expect(checker.getNewerVersionIfAny()).toBe("1.1.0");
    });
    checker.stop();
  });

  it("reports no drift when the fetched latest is not newer than the running version", async () => {
    const checker = new VersionDriftChecker({
      currentVersion: "2.0.0",
      fetchLatestVersion: async () => Promise.resolve("1.9.0"),
    });
    checker.start();
    await vi.waitFor(() => {
      expect(checker.getNewerVersionIfAny()).toBeUndefined();
    });
    checker.stop();
  });

  it("keeps the previously cached result when a later check fails", async () => {
    let callCount = 0;
    const checker = new VersionDriftChecker({
      currentVersion: "1.0.0",
      intervalMs: TEST_INTERVAL_MS,
      fetchLatestVersion: async () => {
        callCount += 1;
        if (callCount === REGISTRY_DOWN_RETRY_CALL_COUNT)
          return Promise.resolve("1.1.0");
        return Promise.reject(new Error("registry down"));
      },
    });
    checker.start();
    await vi.waitFor(() => {
      expect(checker.getNewerVersionIfAny()).toBe("1.1.0");
    });
    await vi.advanceTimersByTimeAsync(TEST_INTERVAL_MS);
    expect(checker.getNewerVersionIfAny()).toBe("1.1.0");
    checker.stop();
  });

  it("re-checks on the configured interval", async () => {
    const fetchLatestVersion = vi.fn(async () => Promise.resolve("1.0.0"));
    const checker = new VersionDriftChecker({
      currentVersion: "1.0.0",
      intervalMs: TEST_INTERVAL_MS,
      fetchLatestVersion,
    });
    checker.start();
    await vi.waitFor(() => {
      expect(fetchLatestVersion).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(TEST_INTERVAL_MS);
    expect(fetchLatestVersion).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(TEST_INTERVAL_MS);
    expect(fetchLatestVersion).toHaveBeenCalledTimes(
      THIRD_INTERVAL_CHECK_CALL_COUNT,
    );
    checker.stop();
  });

  it("stop() prevents further checks", async () => {
    const fetchLatestVersion = vi.fn(async () => Promise.resolve("1.0.0"));
    const checker = new VersionDriftChecker({
      currentVersion: "1.0.0",
      intervalMs: TEST_INTERVAL_MS,
      fetchLatestVersion,
    });
    checker.start();
    await vi.waitFor(() => {
      expect(fetchLatestVersion).toHaveBeenCalledTimes(1);
    });
    checker.stop();
    await vi.advanceTimersByTimeAsync(STOPPED_CHECKER_ADVANCE_MS);
    expect(fetchLatestVersion).toHaveBeenCalledTimes(1);
  });

  it("start() is a no-op when already started", async () => {
    const fetchLatestVersion = vi.fn(async () => Promise.resolve("1.0.0"));
    const checker = new VersionDriftChecker({
      currentVersion: "1.0.0",
      intervalMs: TEST_INTERVAL_MS,
      fetchLatestVersion,
    });
    checker.start();
    checker.start();
    await vi.waitFor(() => {
      expect(fetchLatestVersion).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(TEST_INTERVAL_MS);
    expect(fetchLatestVersion).toHaveBeenCalledTimes(2);
    checker.stop();
  });

  it("defaults to a multi-hour interval when none is given", () => {
    expect(DEFAULT_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(ONE_HOUR_MS);
  });
});
