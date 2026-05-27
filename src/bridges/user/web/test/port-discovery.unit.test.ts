/**
 * Unit tests for port-discovery.ts — sequential port probing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { findFreePort } from "../port-discovery.js";

/** Create a server that blocks a specific port. Returns a cleanup function. */
function blockPort(port: number): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
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
}

describe("findFreePort", () => {
  it("returns the base port when it is available", async () => {
    // Use a high port that's very unlikely to be in use
    const port = await findFreePort(49000);
    assert.strictEqual(typeof port, "number");
    assert.strictEqual(port, 49000);
  });

  it("walks to the next port when the base is taken", async () => {
    const unblock = await blockPort(49100);
    try {
      const port = await findFreePort(49100);
      assert.strictEqual(typeof port, "number");
      assert.strictEqual(port, 49101);
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
      assert.strictEqual(typeof port, "number");
      assert.strictEqual(port, 49203);
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
      assert.strictEqual(port, undefined);
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
      assert.strictEqual(typeof port, "number");
      assert.strictEqual(port, 49402);
    } finally {
      await unblock1();
      await unblock2();
    }
  });
});
