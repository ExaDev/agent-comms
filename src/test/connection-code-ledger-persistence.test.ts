/**
 * Unit tests for the connection-code ledger's own per-slot JSON persistence (agent-comms#188), mirroring identity-store.test.ts's own loadGatewayTrust/saveGatewayTrust coverage for the sibling gateway-trust file.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "vitest";
import {
  loadConnectionCodeLedger,
  saveConnectionCodeLedger,
  type IdentitySlot,
} from "../core/identity-store.js";

function tempSlot(harness: string): IdentitySlot {
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "agent-comms-connection-code-ledger-test-"),
  );
  return { harness, cwd: "/tmp/project", dir };
}

test("loadConnectionCodeLedger is empty for a slot that has never saved a ledger", () => {
  const slot = tempSlot("test");
  expect(loadConnectionCodeLedger(slot)).toEqual({ issued: {}, redeemed: {} });
});

test("loadConnectionCodeLedger does not require an identity to have been created first", () => {
  const slot = tempSlot("test");
  expect(() => {
    saveConnectionCodeLedger(slot, {
      issued: {
        nonce1: { expiresAt: "2026-01-01T00:00:00.000Z", deviceId: "aabbcc" },
      },
      redeemed: {},
    });
  }).not.toThrow();
  expect(loadConnectionCodeLedger(slot).issued).toEqual({
    nonce1: { expiresAt: "2026-01-01T00:00:00.000Z", deviceId: "aabbcc" },
  });
});

test("saveConnectionCodeLedger persists both issued and redeemed maps, loadConnectionCodeLedger reloads the same data", () => {
  const slot = tempSlot("test");
  saveConnectionCodeLedger(slot, {
    issued: {
      nonce1: {
        expiresAt: "2026-01-01T00:00:00.000Z",
        deviceId: "aabbcc",
        signature:
          "-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----",
      },
    },
    redeemed: { nonce2: "2026-01-02T00:00:00.000Z" },
  });

  expect(loadConnectionCodeLedger(slot)).toEqual({
    issued: {
      nonce1: {
        expiresAt: "2026-01-01T00:00:00.000Z",
        deviceId: "aabbcc",
        signature:
          "-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----",
      },
    },
    redeemed: { nonce2: "2026-01-02T00:00:00.000Z" },
  });
});

test("saveConnectionCodeLedger overwrites the previously saved ledger rather than merging with it", () => {
  const slot = tempSlot("test");
  saveConnectionCodeLedger(slot, {
    issued: {
      nonce1: { expiresAt: "2026-01-01T00:00:00.000Z", deviceId: "aabbcc" },
    },
    redeemed: {},
  });
  saveConnectionCodeLedger(slot, {
    issued: {},
    redeemed: { nonce1: "2026-01-01T00:00:00.000Z" },
  });

  expect(loadConnectionCodeLedger(slot)).toEqual({
    issued: {},
    redeemed: { nonce1: "2026-01-01T00:00:00.000Z" },
  });
});

test("loadConnectionCodeLedger ignores a malformed issued record rather than throwing", () => {
  const slot = tempSlot("test");
  const { dir } = { dir: slot.dir };
  fs.mkdirSync(dir as string, { recursive: true });
  fs.writeFileSync(
    path.join(
      dir as string,
      `connection-codes-${slot.harness}--_tmp_project.json`,
    ),
    JSON.stringify({ issued: { bad: { deviceId: "aabbcc" } }, redeemed: {} }),
  );
  expect(loadConnectionCodeLedger(slot)).toEqual({ issued: {}, redeemed: {} });
});

test("loadConnectionCodeLedger returns empty for an unparseable file", () => {
  const slot = tempSlot("test");
  fs.mkdirSync(slot.dir as string, { recursive: true });
  fs.writeFileSync(
    path.join(
      slot.dir as string,
      `connection-codes-${slot.harness}--_tmp_project.json`,
    ),
    "not json",
  );
  expect(loadConnectionCodeLedger(slot)).toEqual({ issued: {}, redeemed: {} });
});
