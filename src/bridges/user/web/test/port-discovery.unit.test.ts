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
 * These tests deliberately use fixed port numbers (kept below PORT_RANGE_SAFE_CEILING, see below) so findFreePort's own sequential-scan behaviour is exercised deterministically. That keeps them clear of the OS's own ephemeral/dynamic port allocation range, but retrying briefly on EADDRINUSE is kept as a second line of defence for any other transient bind contention (e.g. another process on the same fixed port left over from a prior run) without weakening what the test actually asserts.
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

/** Ceiling every fixture port below must stay under: the lower bound of the ephemeral/dynamic port range both Linux (default 32768-60999, via net.ipv4.ip_local_port_range) and macOS (default 49152-65535, via net.inet.ip.portrange.first/last) draw from when the kernel auto-assigns a source port to an outbound connection. A fixture port inside either range can be transiently claimed by a completely unrelated process's outbound socket at the exact moment a test tries to bind it as a listening server, producing a genuine EADDRINUSE race no amount of retrying fully closes out. Staying below it removes the collision domain outright rather than tolerating it. */
const PORT_RANGE_SAFE_CEILING = 32768;

/** Base port for the "base port is free" scenario. */
const TEST_PORT_AVAILABLE_BASE = 20000;
/** Base port for the "single port taken" scenario. */
const TEST_PORT_SINGLE_TAKEN_BASE = 20100;
/** The port findFreePort should land on once TEST_PORT_SINGLE_TAKEN_BASE is blocked. */
const TEST_PORT_SINGLE_TAKEN_RESULT = 20101;
/** Base port for the "multiple consecutive ports taken" scenario. */
const TEST_PORT_MULTIPLE_TAKEN_BASE = 20200;
/** Second port blocked in the "multiple consecutive ports taken" scenario. */
const TEST_PORT_MULTIPLE_TAKEN_SECOND = 20201;
/** Third port blocked in the "multiple consecutive ports taken" scenario. */
const TEST_PORT_MULTIPLE_TAKEN_THIRD = 20202;
/** The port findFreePort should land on once all three ports above are blocked. */
const TEST_PORT_MULTIPLE_TAKEN_RESULT = 20203;
/** Base port for the "every port in range is taken" scenario. */
const TEST_PORT_ALL_TAKEN_BASE = 20300;
/** How many consecutive ports get blocked, and the maxAttempts passed to findFreePort, in the "every port in range is taken" scenario -- both are the same number by design so the scan exhausts exactly the blocked range. */
const TEST_ALL_TAKEN_PORT_COUNT = 3;
/** Base port for the "maxAttempts allows walking past taken ports" scenario. */
const TEST_PORT_MAX_ATTEMPTS_BASE = 20400;
/** Second port blocked in the "maxAttempts allows walking past taken ports" scenario. */
const TEST_PORT_MAX_ATTEMPTS_SECOND = 20401;
/** maxAttempts passed to findFreePort in the "maxAttempts allows walking past taken ports" scenario -- deliberately larger than the number of blocked ports so the scan walks past them. */
const TEST_MAX_ATTEMPTS_LIMIT = 5;
/** The port findFreePort should land on once both ports above are blocked. */
const TEST_PORT_MAX_ATTEMPTS_RESULT = 20402;

/** Port a test transiently occupies to prove blockPort's own EADDRINUSE retry, not luck, is what recovers. */
const TEST_PORT_TRANSIENT_CONTENTION = 20500;

/** Every literal fixture port declared above, gathered so the ephemeral-range invariant can be checked once for all of them rather than per-constant. */
const ALL_FIXTURE_PORTS = [
  TEST_PORT_AVAILABLE_BASE,
  TEST_PORT_SINGLE_TAKEN_BASE,
  TEST_PORT_SINGLE_TAKEN_RESULT,
  TEST_PORT_MULTIPLE_TAKEN_BASE,
  TEST_PORT_MULTIPLE_TAKEN_SECOND,
  TEST_PORT_MULTIPLE_TAKEN_THIRD,
  TEST_PORT_MULTIPLE_TAKEN_RESULT,
  TEST_PORT_ALL_TAKEN_BASE,
  TEST_PORT_MAX_ATTEMPTS_BASE,
  TEST_PORT_MAX_ATTEMPTS_SECOND,
  TEST_PORT_MAX_ATTEMPTS_RESULT,
  TEST_PORT_TRANSIENT_CONTENTION,
];

describe("findFreePort fixture ports", () => {
  it("all stay below the OS ephemeral port range", () => {
    for (const port of ALL_FIXTURE_PORTS) {
      expect(port).toBeLessThan(PORT_RANGE_SAFE_CEILING);
    }
  });
});

describe("blockPort", () => {
  it("recovers from a transient EADDRINUSE instead of failing on the first attempt", async () => {
    const contender = http.createServer();
    await new Promise<void>((resolve, reject) => {
      contender.on("error", reject);
      contender.listen(TEST_PORT_TRANSIENT_CONTENTION, "127.0.0.1", () => {
        resolve();
      });
    });
    // Release the port partway through blockPort's own retry window, well before it gives up, so the recovery below is provably the retry loop's own doing rather than the contender happening to already be gone before blockPort's first attempt.
    setTimeout(() => {
      contender.close();
    }, BLOCK_PORT_RETRY_DELAY_MS * 2);

    const unblock = await blockPort(TEST_PORT_TRANSIENT_CONTENTION);
    await unblock();
  });
});

describe("findFreePort", () => {
  it("returns the base port when it is available", async () => {
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
