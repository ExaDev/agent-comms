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

function delay(ms: number): Promise<void> {
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

describe("findFreePort", () => {
  it("returns the base port when it is available", async () => {
    // Use a high port that's very unlikely to be in use
    const port = await findFreePort(49000);
    expect(typeof port).toBe("number");
    expect(port).toBe(49000);
  });

  it("walks to the next port when the base is taken", async () => {
    const unblock = await blockPort(49100);
    try {
      const port = await findFreePort(49100);
      expect(typeof port).toBe("number");
      expect(port).toBe(49101);
    } finally {
      await unblock();
    }
  });

  it("skips multiple taken ports", async () => {
    const unblock1 = await blockPort(49200);
    const unblock2 = await blockPort(49201);
    const unblock3 = await blockPort(49202);
    try {
      const port = await findFreePort(49200);
      expect(typeof port).toBe("number");
      expect(port).toBe(49203);
    } finally {
      await unblock1();
      await unblock2();
      await unblock3();
    }
  });

  it("returns undefined when all ports in range are taken", async () => {
    // Block 3 ports with maxAttempts=3
    const blockers: (() => Promise<void>)[] = [];
    for (let i = 0; i < 3; i++) {
      blockers.push(await blockPort(49300 + i));
    }
    try {
      const port = await findFreePort(49300, 3);
      expect(port).toBe(undefined);
    } finally {
      for (const unblock of blockers) {
        await unblock();
      }
    }
  });

  it("respects the maxAttempts parameter", async () => {
    // Block 2 ports but allow 5 attempts — should walk past them
    const unblock1 = await blockPort(49400);
    const unblock2 = await blockPort(49401);
    try {
      const port = await findFreePort(49400, 5);
      expect(typeof port).toBe("number");
      expect(port).toBe(49402);
    } finally {
      await unblock1();
      await unblock2();
    }
  });
});
