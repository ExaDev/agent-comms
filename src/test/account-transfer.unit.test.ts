/**
 * Unit tests for the account key's export and import (agent-comms#344): the passphrase-sealed bundle, the `account export`/`account import` commands built on it, and what importing does to the machine it lands on.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  MIN_ACCOUNT_PASSPHRASE_LENGTH,
  openAccountBundle,
  openAccountKeyFromInvite,
  sealAccountBundle,
  sealAccountKeyForInvite,
} from "../core/account-bundle.js";
import { openAccountLedger } from "../core/account-ledger-store.js";
import { generateIdentity } from "../core/identity.js";
import { randomId } from "../core/random-id.js";
import {
  importAccountKey,
  loadOrCreateLedgerWriterNonce,
  loadOrCreateUserIdentity,
} from "../core/user-identity.js";
import { generateWriterNonce } from "../core/account-ledger-crypto.js";
import {
  ACCOUNT_PASSPHRASE_ENV,
  runAccountCommand,
  type AccountCliIo,
} from "../account-cli.js";

const PASSPHRASE = "correct horse battery staple";

function tempDir(): string {
  return fs.mkdtempSync(path.join(tmpdir(), "agent-comms-account-transfer-"));
}

function principalIn(dir: string): string {
  return deviceIdToHex(
    Uint8Array.from(loadOrCreateUserIdentity({ dir }).deviceId),
  );
}

function io(passphrase: string): AccountCliIo & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    readSecret: async () => Promise.resolve(passphrase),
    log: (line) => {
      lines.push(line);
    },
    env: {},
    openStore: async () =>
      Promise.reject(new Error("export and import open no store")),
  };
}

describe("account bundle", () => {
  const privateKey = generateIdentity().privateKey;

  it("round-trips the key under the right passphrase", () => {
    const bundle = sealAccountBundle(privateKey, PASSPHRASE);

    expect(openAccountBundle(bundle, PASSPHRASE)).toBe(privateKey);
  });

  it("never holds the key in the clear", () => {
    const bundle = sealAccountBundle(privateKey, PASSPHRASE);

    expect(bundle).not.toContain("PRIVATE KEY");
    expect(Buffer.from(bundle, "base64url").toString("utf-8")).not.toContain(
      "PRIVATE KEY",
    );
  });

  it("refuses the wrong passphrase", () => {
    const bundle = sealAccountBundle(privateKey, PASSPHRASE);

    expect(() => openAccountBundle(bundle, `${PASSPHRASE}!`)).toThrow(
      expect.objectContaining({ code: "WRONG_PASSPHRASE" }),
    );
  });

  it("refuses a passphrase shorter than the minimum", () => {
    expect(() =>
      sealAccountBundle(
        privateKey,
        "x".repeat(MIN_ACCOUNT_PASSPHRASE_LENGTH - 1),
      ),
    ).toThrow(expect.objectContaining({ code: "WEAK_PASSPHRASE" }));
  });

  it("refuses text that is not a bundle", () => {
    expect(() => openAccountBundle("hello", PASSPHRASE)).toThrow(
      expect.objectContaining({ code: "INVALID_BUNDLE" }),
    );
  });

  it("opens a key sealed for an invite only under that same invite", () => {
    const invite = {
      code: "abc",
      expiresAt: "2030-01-01T00:00:00.000Z",
      deviceId: "aa",
    };
    const sealed = sealAccountKeyForInvite(privateKey, invite);

    expect(openAccountKeyFromInvite(sealed, invite)).toBe(privateKey);
    expect(() =>
      openAccountKeyFromInvite(sealed, { ...invite, code: "abd" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_BUNDLE" }));
  });
});

describe("account export and import", () => {
  it("round-trips the account from one machine to another", async () => {
    const machineA = tempDir();
    const machineB = tempDir();
    const file = path.join(tempDir(), "account.bundle");
    const principal = principalIn(machineA);

    await runAccountCommand(["export", file], io(PASSPHRASE), {
      dir: machineA,
    });
    await runAccountCommand(["import", file], io(PASSPHRASE), {
      dir: machineB,
    });

    expect(principalIn(machineB)).toBe(principal);
    expect(fs.readFileSync(file, "utf-8")).not.toContain("PRIVATE KEY");
  });

  it("gives the importing machine its own ledger writer, never the exporting machine's", async () => {
    const machineA = tempDir();
    const machineB = tempDir();
    const file = path.join(tempDir(), "account.bundle");
    loadOrCreateUserIdentity({ dir: machineA });
    const nonceA = loadOrCreateLedgerWriterNonce(
      { dir: machineA },
      generateWriterNonce,
    );

    await runAccountCommand(["export", file], io(PASSPHRASE), {
      dir: machineA,
    });
    await runAccountCommand(["import", file], io(PASSPHRASE), {
      dir: machineB,
    });

    const nonceB = loadOrCreateLedgerWriterNonce(
      { dir: machineB },
      generateWriterNonce,
    );
    expect(nonceB).not.toEqual(nonceA);
  });

  it("lets the imported machine read the ledger it replicates from the exporting one", async () => {
    const machineA = tempDir();
    const machineB = tempDir();
    const file = path.join(tempDir(), "account.bundle");
    const clock = createSystemClock();
    const ledgerA = await openAccountLedger({
      userIdentityOptions: { dir: machineA },
      userIdentity: loadOrCreateUserIdentity({ dir: machineA }),
      clock,
    });
    const tokenId = randomId();
    await ledgerA.recordGrant("device", "device-a", tokenId);

    await runAccountCommand(["export", file], io(PASSPHRASE), {
      dir: machineA,
    });
    await runAccountCommand(["import", file], io(PASSPHRASE), {
      dir: machineB,
    });
    const ledgerB = await openAccountLedger({
      userIdentityOptions: { dir: machineB },
      userIdentity: loadOrCreateUserIdentity({ dir: machineB }),
      clock,
    });
    for (const have of await ledgerA.announcements()) {
      const request = await ledgerB.handleDataFrame(have);
      if (request?.type !== "data-request") continue;
      const entries = await ledgerA.handleDataFrame(request);
      if (entries !== null) await ledgerB.handleDataFrame(entries);
    }

    const grants = await ledgerB.outstandingGrants("device", "device-a");
    expect(grants.map((grant) => grant.tokenId)).toEqual([tokenId]);
  });

  it("sets aside a different account the importing machine already held", async () => {
    const machineA = tempDir();
    const machineB = tempDir();
    const file = path.join(tempDir(), "account.bundle");
    const previous = principalIn(machineB);
    const output = io(PASSPHRASE);

    await runAccountCommand(["export", file], io(PASSPHRASE), {
      dir: machineA,
    });
    await runAccountCommand(["import", file], output, { dir: machineB });

    const replaced = path.join(
      machineB,
      `user-identity.replaced-${previous}.json`,
    );
    expect(fs.existsSync(replaced)).toBe(true);
    expect(principalIn(machineB)).toBe(principalIn(machineA));
    expect(output.lines.join("\n")).toContain(replaced);
  });

  it("does not overwrite an existing file on export", async () => {
    const machineA = tempDir();
    const file = path.join(tempDir(), "account.bundle");
    fs.writeFileSync(file, "keep me");

    await expect(
      runAccountCommand(["export", file], io(PASSPHRASE), { dir: machineA }),
    ).rejects.toThrow(/EEXIST/);
    expect(fs.readFileSync(file, "utf-8")).toBe("keep me");
  });

  it("takes the passphrase from the environment when it is set", async () => {
    const machineA = tempDir();
    const machineB = tempDir();
    const file = path.join(tempDir(), "account.bundle");
    const fromEnv = {
      ...io("not the passphrase at all"),
      env: { [ACCOUNT_PASSPHRASE_ENV]: PASSPHRASE },
    };

    await runAccountCommand(["export", file], fromEnv, { dir: machineA });
    await runAccountCommand(["import", file], io(PASSPHRASE), {
      dir: machineB,
    });

    expect(principalIn(machineB)).toBe(principalIn(machineA));
  });

  it("imports back and forth between two accounts, keeping each replaced one set aside", () => {
    const machine = tempDir();
    const first = loadOrCreateUserIdentity({ dir: machine });
    const second = generateIdentity();
    const firstHex = deviceIdToHex(Uint8Array.from(first.deviceId));
    const secondHex = deviceIdToHex(Uint8Array.from(second.deviceId));

    importAccountKey({ dir: machine }, second.privateKey);
    importAccountKey({ dir: machine }, first.privateKey);
    const result = importAccountKey({ dir: machine }, second.privateKey);

    expect(principalIn(machine)).toBe(secondHex);
    expect(result.replacedFile).toBe(
      path.join(machine, `user-identity.replaced-${firstHex}.json`),
    );
    expect(fs.readdirSync(machine).sort()).toEqual(
      [
        "user-identity.json",
        `user-identity.replaced-${firstHex}.json`,
        `user-identity.replaced-${secondHex}.json`,
      ].sort(),
    );
  });

  it("refuses to set an account aside over a file holding a different key", () => {
    const machine = tempDir();
    const held = loadOrCreateUserIdentity({ dir: machine });
    const heldHex = deviceIdToHex(Uint8Array.from(held.deviceId));
    const setAsideFile = path.join(
      machine,
      `user-identity.replaced-${heldHex}.json`,
    );
    const damaged = `${JSON.stringify({ privateKey: generateIdentity().privateKey, certificate: "x", expiresAt: new Date().toISOString() })}\n`;
    fs.writeFileSync(setAsideFile, damaged);

    expect(() =>
      importAccountKey({ dir: machine }, generateIdentity().privateKey),
    ).toThrow(expect.objectContaining({ code: "ACCOUNT_SET_ASIDE_CONFLICT" }));
    expect(fs.readFileSync(setAsideFile, "utf-8")).toBe(damaged);
    expect(principalIn(machine)).toBe(heldHex);
  });

  it("changes nothing when the machine already holds the imported account", () => {
    const machineA = tempDir();
    const identity = loadOrCreateUserIdentity({ dir: machineA });

    const result = importAccountKey({ dir: machineA }, identity.privateKey);

    expect(result.replacedFile).toBeUndefined();
    expect(fs.readdirSync(machineA)).toEqual(["user-identity.json"]);
  });
});
