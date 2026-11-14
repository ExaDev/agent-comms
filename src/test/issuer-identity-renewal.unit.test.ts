/**
 * Renewing an identity file's certificate re-reads the record under the file's write lock before rewriting it, so a field another process wrote since the first read survives the renewal.
 */
import * as fs from "node:fs";
import { expect, it } from "vitest";
import {
  isStoredIssuerKey,
  loadOrCreateIssuerIdentity,
  type StoredIssuerKey,
} from "../core/issuer-identity-file.js";
import {
  loadOrCreateMachineIdentity,
  machineIdentityFile,
} from "../core/machine-identity.js";
import { writeLockFor } from "../core/pid-lock-file.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

it("keeps a field written between the first read and the renewal, and reads again with the lock held", () => {
  const dir = scratchDirectory("agent-comms-renewal-");
  loadOrCreateMachineIdentity({ dir });
  const file = machineIdentityFile({ dir });
  const record = JSON.parse(fs.readFileSync(file, "utf-8")) as object;
  const expiresAtEpoch = new Date(0).toISOString();
  fs.writeFileSync(
    file,
    JSON.stringify({ ...record, expiresAt: expiresAtEpoch }),
  );

  let reads = 0;
  const lockHeldOnReread: boolean[] = [];
  const guard = (value: unknown): value is StoredIssuerKey => {
    reads += 1;
    if (reads === 1) {
      // Another process names the machine after this one has read the record.
      fs.writeFileSync(
        file,
        JSON.stringify({
          ...record,
          expiresAt: expiresAtEpoch,
          displayName: "late",
        }),
      );
    } else {
      lockHeldOnReread.push(fs.existsSync(writeLockFor(file)));
    }
    return isStoredIssuerKey(value);
  };

  loadOrCreateIssuerIdentity(file, guard);

  const after = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    displayName?: string;
    expiresAt: string;
  };
  expect(after.displayName).toBe("late");
  expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.now());
  expect(lockHeldOnReread).toEqual([true]);
});

it("fails the renewal when the file has gone since it was first read, and does not write the earlier copy back", () => {
  const dir = scratchDirectory("agent-comms-renewal-removed-");
  loadOrCreateMachineIdentity({ dir });
  const file = machineIdentityFile({ dir });
  const record = JSON.parse(fs.readFileSync(file, "utf-8")) as object;
  fs.writeFileSync(
    file,
    JSON.stringify({ ...record, expiresAt: new Date(0).toISOString() }),
  );
  const guard = (value: unknown): value is StoredIssuerKey => {
    // An operator moves the file aside after this process has read it.
    fs.rmSync(file, { force: true });
    return isStoredIssuerKey(value);
  };

  expect(() => loadOrCreateIssuerIdentity(file, guard)).toThrow(
    /was removed while its certificate was being renewed/,
  );
  expect(fs.existsSync(file)).toBe(false);
});
