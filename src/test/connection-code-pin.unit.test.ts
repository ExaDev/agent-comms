/**
 * Connection codes under a caller's pin: a pinned redemption never accepts an unsigned code, nor a signed one whose signature was removed.
 */

import * as openpgp from "openpgp";
import { beforeAll, describe, expect, it } from "vitest";
import { runAccountCommand, type AccountCliIo } from "../account-cli.js";
import {
  ConnectionCodeError,
  ConnectionCodeLedger,
} from "../core/connection-code.js";

const DEVICE_HEX = "aabbccdd";
let signingKey: { privateKey: string; publicKey: string };

beforeAll(async () => {
  signingKey = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: "Alice", email: "alice@example.com" }],
    format: "armored",
  });
});

async function fingerprintOf(publicKey: string): Promise<string> {
  return (await openpgp.readKey({ armoredKey: publicKey })).getFingerprint();
}

describe("redeeming with a pin the caller supplied", () => {
  it("refuses an unsigned code when a fingerprint is supplied", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX);

    await expect(
      ledger.redeem(code, {
        expectedFingerprint: await fingerprintOf(signingKey.publicKey),
      }),
    ).rejects.toMatchObject({ reason: "signature_missing" });
  });

  it("refuses an unsigned code when a public key is supplied", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX);

    await expect(
      ledger.redeem(code, { publicKeyArmored: signingKey.publicKey }),
    ).rejects.toMatchObject({ reason: "signature_missing" });
  });

  it("refuses a signed code whose signature was removed", async () => {
    const ledger = new ConnectionCodeLedger();
    const signed = await ledger.generate(DEVICE_HEX, {
      privateKeyArmored: signingKey.privateKey,
    });
    const { signature: _signature, ...stripped } = signed;

    await expect(
      ledger.redeem(stripped, {
        publicKeyArmored: signingKey.publicKey,
        expectedFingerprint: await fingerprintOf(signingKey.publicKey),
      }),
    ).rejects.toBeInstanceOf(ConnectionCodeError);
  });

  it("does not spend the code when it refuses, so the code still redeems without a pin", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX);

    await expect(
      ledger.redeem(code, { expectedFingerprint: "aa" }),
    ).rejects.toMatchObject({ reason: "signature_missing" });
    await expect(ledger.redeem(code)).resolves.toEqual({
      deviceId: DEVICE_HEX,
    });
  });

  it("still redeems an unsigned code when nothing is supplied to check it against", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX);

    await expect(ledger.redeem(code)).resolves.toEqual({
      deviceId: DEVICE_HEX,
    });
  });

  it("still redeems a signed code that verifies against the pinned key", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX, {
      privateKeyArmored: signingKey.privateKey,
    });

    const result = await ledger.redeem(code, {
      publicKeyArmored: signingKey.publicKey,
      expectedFingerprint: await fingerprintOf(signingKey.publicKey),
    });

    expect(result.deviceId).toBe(DEVICE_HEX);
  });

  it("refuses an unsigned invite from `account join --fingerprint` with a message that says why", async () => {
    const ledger = new ConnectionCodeLedger();
    const code = await ledger.generate(DEVICE_HEX);
    const io: AccountCliIo = {
      readSecret: async () => Promise.resolve(JSON.stringify(code)),
      log: () => undefined,
      env: {},
      openStore: async () =>
        Promise.resolve({
          account: {
            invite: async () => Promise.reject(new Error("not used")),
            join: async (candidate, options) => {
              await ledger.redeem(candidate, options);
              return { principal: "p" };
            },
          },
          close: async () => Promise.resolve(),
        }),
    };

    await expect(
      runAccountCommand(["join", "--fingerprint", "aabbcc"], io),
    ).rejects.toThrow("is not signed");
  });
});
