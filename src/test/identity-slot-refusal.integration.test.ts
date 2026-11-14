/**
 * A slot file that exists but cannot be used is refused and left alone: loading it never replaces the key it held, and the slot lock is not left taken. Only a missing file starts a new identity.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  loadIdentityForFront,
  loadOrCreateIdentity,
  probeSlotOwner,
  releaseIdentityLock,
  type IdentitySlot,
} from "../core/identity-store.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

/** The error code an unusable identity file is refused with. */
const UNUSABLE_CODE = "IDENTITY_RECORD_UNUSABLE";

const slots: IdentitySlot[] = [];

afterEach(() => {
  for (const slot of slots.splice(0)) releaseIdentityLock(slot);
});

function freshSlot(): { slot: IdentitySlot; file: string } {
  const dir = scratchDirectory("agent-comms-slot-refusal-");
  const slot: IdentitySlot = { harness: "refusal", cwd: "/tmp/project", dir };
  slots.push(slot);
  // The file name is the store's own, learnt by creating an identity there once.
  loadOrCreateIdentity(slot);
  releaseIdentityLock(slot);
  const found = fs.readdirSync(dir).find((f) => f.endsWith(".json"));
  if (found === undefined) throw new Error("expected an identity file");
  return { slot, file: path.join(dir, found) };
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** Puts `replacement` where the slot's identity file is, as bytes. */
function overwrite(file: string, replacement: string): void {
  fs.writeFileSync(file, replacement);
}

const FAR_FUTURE_MS = 1_000_000_000_000;
const VALID_SHAPE_UNUSABLE_KEY = JSON.stringify({
  privateKey: "not a key",
  certificate: "not a certificate",
  expiresAt: new Date(Date.now() + FAR_FUTURE_MS).toISOString(),
});

const UNUSABLE_FILES: readonly (readonly [string, string])[] = [
  ["text that is not JSON", "{ this is not json"],
  ["JSON of the wrong shape", JSON.stringify({ privateKey: 1 })],
  ["fields of the right type that hold no key", VALID_SHAPE_UNUSABLE_KEY],
  [
    "a key that cannot be certified again, near expiry",
    JSON.stringify({
      privateKey: "not a key",
      certificate: "not a certificate",
      expiresAt: new Date(0).toISOString(),
    }),
  ],
];

test.each(UNUSABLE_FILES)(
  "loadOrCreateIdentity refuses %s and leaves the file as it was",
  (_name, content) => {
    const { slot, file } = freshSlot();
    overwrite(file, content);

    const err = thrownBy(() => loadOrCreateIdentity(slot));

    expect(err).toMatchObject({ code: UNUSABLE_CODE });
    expect(err instanceof Error ? err.message : "").toContain(file);
    expect(fs.readFileSync(file, "utf-8")).toBe(content);
    // A refused load must not leave this process holding the slot.
    expect(probeSlotOwner(slot)).toBeUndefined();
  },
);

test.each(UNUSABLE_FILES)(
  "loadIdentityForFront refuses %s and leaves the file as it was",
  (_name, content) => {
    const { slot, file } = freshSlot();
    overwrite(file, content);

    expect(thrownBy(() => loadIdentityForFront(slot))).toMatchObject({
      code: UNUSABLE_CODE,
    });
    expect(fs.readFileSync(file, "utf-8")).toBe(content);
  },
);

test("a file that cannot be read is refused, not treated as missing", () => {
  const { slot, file } = freshSlot();
  fs.rmSync(file);
  fs.mkdirSync(file);

  expect(thrownBy(() => loadOrCreateIdentity(slot))).toMatchObject({
    code: UNUSABLE_CODE,
  });
  expect(fs.statSync(file).isDirectory()).toBe(true);
});

test("the refusal names what to do", () => {
  const { slot, file } = freshSlot();
  overwrite(file, "{");
  const err = thrownBy(() => loadOrCreateIdentity(slot));
  const message = err instanceof Error ? err.message : "";
  expect(message).toContain("Restore it from a backup");
  expect(message).toContain("move it aside");
});

test("a missing file still starts a new identity", () => {
  const { slot, file } = freshSlot();
  fs.rmSync(file);

  const created = loadOrCreateIdentity(slot);

  expect(created.deviceId.length).toBeGreaterThan(0);
  expect(fs.existsSync(file)).toBe(true);
});

test("a valid file is still loaded unchanged", () => {
  const { slot } = freshSlot();
  const first = loadOrCreateIdentity(slot);
  releaseIdentityLock(slot);
  const second = loadOrCreateIdentity(slot);
  expect(Buffer.from(second.deviceId).equals(Buffer.from(first.deviceId))).toBe(
    true,
  );
});

test("a bridge that cannot load its identity exits with the message and no stack trace", async () => {
  const { slot, file } = freshSlot();
  overwrite(file, "{");
  const script = [
    'import { main } from "./src/cli-main.ts";',
    "main({ args: ['bridge', 'mcp'], stdinIsTerminal: false, bridge: { slot: JSON.parse(process.env.SLOT ?? '{}') } });",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", script],
    {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      env: { ...process.env, SLOT: JSON.stringify(slot) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("exit", resolve);
  });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("does not hold a usable identity record");
  expect(stderr).not.toContain("    at ");
});
