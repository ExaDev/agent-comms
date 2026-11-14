/**
 * A connection code, or a stored record of one, whose expiry names no instant is invalid rather than never expiring.
 */

import { describe, expect, it } from "vitest";
import { ConnectionCodeLedger } from "../core/connection-code.js";
import type { IdentitySlot } from "../core/identity-store.js";
import {
  loadConnectionCodeLedger,
  saveConnectionCodeLedger,
} from "../core/identity-store.js";
import { parseIsoTimestampMs } from "../core/iso-timestamp.js";
import { CommsActionSchema, ConnectionCodeSchema } from "../core/types.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

const DEVICE_HEX = "aabbccdd";
const ONE_MINUTE_MS = 60_000;
/** Text that is not an ISO 8601 timestamp, or names no instant, in the forms a stored or pasted code might plausibly carry it. */
const UNPARSEABLE_EXPIRIES = [
  "",
  "soon",
  "tomorrow",
  "2099",
  "Jan 1 2099",
  "2099-01-01",
  "2099-13-01T00:00:00.000Z",
  "2099-01-01T25:00:00.000Z",
  "2099-01-01 00:00:00Z",
  "NaN",
] as const;

function slot(): IdentitySlot {
  return {
    harness: "hardening",
    cwd: "/tmp/project",
    dir: scratchDirectory("agent-comms-connection-code-hardening-"),
  };
}

describe("a connection code whose expiry does not parse", () => {
  it.each(UNPARSEABLE_EXPIRIES)(
    "is refused at redemption as invalid, not treated as never expiring: %j",
    async (expiresAt) => {
      const ledger = new ConnectionCodeLedger();
      const code = await ledger.generate(DEVICE_HEX);

      await expect(ledger.redeem({ ...code, expiresAt })).rejects.toMatchObject(
        { reason: "invalid_expiry" },
      );
    },
  );

  it.each(UNPARSEABLE_EXPIRIES)(
    "does not satisfy the connection code schema: %j",
    (expiresAt) => {
      expect(
        ConnectionCodeSchema.is({ code: "c", expiresAt, deviceId: "d" }),
      ).toBe(false);
      expect(
        CommsActionSchema.safeParse({
          action: "gateway_redeem_connection_code",
          code: "c",
          expiresAt,
          device: "d",
        }).success,
      ).toBe(false);
    },
  );

  it("is accepted by the schema in the form this package writes it", async () => {
    const code = await new ConnectionCodeLedger().generate(DEVICE_HEX);
    expect(ConnectionCodeSchema.is(code)).toBe(true);
    expect(parseIsoTimestampMs("2099-01-01T00:00:00+01:00")).toBe(
      Date.parse("2098-12-31T23:00:00.000Z"),
    );
  });

  it("is not loaded from a persisted ledger, and a persisted redeemed entry with such an expiry is dropped", () => {
    const s = slot();
    const future = new Date(Date.now() + ONE_MINUTE_MS).toISOString();
    saveConnectionCodeLedger(s, {
      issued: {
        good: { expiresAt: future, deviceId: DEVICE_HEX },
        bad: { expiresAt: "soon", deviceId: DEVICE_HEX },
      },
      redeemed: { good: future, bad: "soon" },
    });

    const loaded = loadConnectionCodeLedger(s);

    expect(Object.keys(loaded.issued)).toEqual(["good"]);
    expect(Object.keys(loaded.redeemed)).toEqual(["good"]);
  });
});
