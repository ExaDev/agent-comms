/**
 * Unit tests for port-discovery.ts — sequential port probing.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { findFreePort } from "../port-discovery.js";

/** How many times to retry a single bind attempt against a transient EADDRINUSE before giving up for real. */
const BLOCK_PORT_MAX_ATTEMPTS = 10;
/** Delay between retries, long enough for a port an unrelated process grabbed as its own ephemeral source port to be released again. Raised from 50ms/5 attempts (a ~250ms total window) after that budget still wasn't always enough on a loaded CI runner -- 10 attempts at 100ms gives a ~1s window before genuinely giving up. */
const BLOCK_PORT_RETRY_DELAY_MS = 100;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Create a server that blocks a specific port. Returns a cleanup function.
 *
 * These tests deliberately use fixed high port numbers so findFreePort's own sequential-scan behaviour is exercised deterministically, but that range overlaps the OS's own ephemeral/dynamic port allocation range -- an unrelated process anywhere on the machine opening an ordinary outbound connection can be kernel-assigned the exact port a test wants to bind as a server, entirely independent of anything this test suite itself does, and release it again moments later. Retrying briefly on EADDRINUSE handles that real, transient condition without weakening what the test actually asserts.
 */
async function blockPort(port: number): Promise<() => Promise<void>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const server = http.createServer();
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => {
          resolve(async () => {
            return new Promise<void>((res) => {
              server.close(() => res());
            });
          });
        });
      });
    } catch (error) {
      const isAddrInUse =
        isErrnoException(error) && error.code === "EADDRINUSE";
      if (!isAddrInUse || attempt >= BLOCK_PORT_MAX_ATTEMPTS) {
        throw error;
      }
      await delay(BLOCK_PORT_RETRY_DELAY_MS);
    }
  }
}

/** Base port for the "base port is free" scenario. */
const TEST_PORT_AVAILABLE_BASE = 49000;
/** Base port for the "single port taken" scenario. */
const TEST_PORT_SINGLE_TAKEN_BASE = 49100;
/** The port findFreePort should land on once TEST_PORT_SINGLE_TAKEN_BASE is blocked. */
const TEST_PORT_SINGLE_TAKEN_RESULT = 49101;
/** Base port for the "multiple consecutive ports taken" scenario. */
const TEST_PORT_MULTIPLE_TAKEN_BASE = 49200;
/** Second port blocked in the "multiple consecutive ports taken" scenario. */
const TEST_PORT_MULTIPLE_TAKEN_SECOND = 49201;
/** Third port blocked in the "multiple consecutive ports taken" scenario. */
const TEST_PORT_MULTIPLE_TAKEN_THIRD = 49202;
/** The port findFreePort should land on once all three ports above are blocked. */
const TEST_PORT_MULTIPLE_TAKEN_RESULT = 49203;
/** Base port for the "every port in range is taken" scenario. */
const TEST_PORT_ALL_TAKEN_BASE = 49300;
/** How many consecutive ports get blocked, and the maxAttempts passed to findFreePort, in the "every port in range is taken" scenario -- both are the same number by design so the scan exhausts exactly the blocked range. */
const TEST_ALL_TAKEN_PORT_COUNT = 3;
/** Base port for the "maxAttempts allows walking past taken ports" scenario. */
const TEST_PORT_MAX_ATTEMPTS_BASE = 49400;
/** Second port blocked in the "maxAttempts allows walking past taken ports" scenario. */
const TEST_PORT_MAX_ATTEMPTS_SECOND = 49401;
/** maxAttempts passed to findFreePort in the "maxAttempts allows walking past taken ports" scenario -- deliberately larger than the number of blocked ports so the scan walks past them. */
const TEST_MAX_ATTEMPTS_LIMIT = 5;
/** The port findFreePort should land on once both ports above are blocked. */
const TEST_PORT_MAX_ATTEMPTS_RESULT = 49402;

describe("findFreePort", () => {
  it("returns the base port when it is available", async () => {
    // Use a high port that's very unlikely to be in use
    const port = await findFreePort(TEST_PORT_AVAILABLE_BASE);
    expect(typeof port).toBe("number");
    expect(port).toBe(TEST_PORT_AVAILABLE_BASE);
  });

  it("walks to the next port when the base is taken", async () => {
    const unblock = await blockPort(TEST_PORT_SINGLE_TAKEN_BASE);
    try {
      const port = await findFreePort(TEST_PORT_SINGLE_TAKEN_BASE);
      expect(typeof port).toBe("number");
      expect(port).toBe(TEST_PORT_SINGLE_TAKEN_RESULT);
    } finally {
      await unblock();
    }
  });

  it("skips multiple taken ports", async () => {
    const unblock1 = await blockPort(TEST_PORT_MULTIPLE_TAKEN_BASE);
    const unblock2 = await blockPort(TEST_PORT_MULTIPLE_TAKEN_SECOND);
    const unblock3 = await blockPort(TEST_PORT_MULTIPLE_TAKEN_THIRD);
    try {
      const port = await findFreePort(TEST_PORT_MULTIPLE_TAKEN_BASE);
      expect(typeof port).toBe("number");
      expect(port).toBe(TEST_PORT_MULTIPLE_TAKEN_RESULT);
    } finally {
      await unblock1();
      await unblock2();
      await unblock3();
    }
  });

  it("returns undefined when all ports in range are taken", async () => {
    // Block TEST_ALL_TAKEN_PORT_COUNT ports with maxAttempts=TEST_ALL_TAKEN_PORT_COUNT
    const blockers: (() => Promise<void>)[] = [];
    for (let i = 0; i < TEST_ALL_TAKEN_PORT_COUNT; i++) {
      blockers.push(await blockPort(TEST_PORT_ALL_TAKEN_BASE + i));
    }
    try {
      const port = await findFreePort(
        TEST_PORT_ALL_TAKEN_BASE,
        TEST_ALL_TAKEN_PORT_COUNT,
      );
      expect(port).toBe(undefined);
    } finally {
      for (const unblock of blockers) {
        await unblock();
      }
    }
  });

  it("respects the maxAttempts parameter", async () => {
    // Block 2 ports but allow TEST_MAX_ATTEMPTS_LIMIT attempts — should walk past them
    const unblock1 = await blockPort(TEST_PORT_MAX_ATTEMPTS_BASE);
    const unblock2 = await blockPort(TEST_PORT_MAX_ATTEMPTS_SECOND);
    try {
      const port = await findFreePort(
        TEST_PORT_MAX_ATTEMPTS_BASE,
        TEST_MAX_ATTEMPTS_LIMIT,
      );
      expect(typeof port).toBe("number");
      expect(port).toBe(TEST_PORT_MAX_ATTEMPTS_RESULT);
    } finally {
      await unblock1();
      await unblock2();
    }
  });
});
