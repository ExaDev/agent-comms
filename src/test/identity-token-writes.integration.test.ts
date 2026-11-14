/**
 * Writes to one slot file's token records: several processes saving at once keep every update, and a bridge running under an identity that is not the file's keeps its tokens out of the file.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import {
  loadGroupTokens,
  loadOrCreateIdentity,
  loadRoomTokens,
  releaseIdentityLock,
  saveGroupToken,
  saveIssuedRoomGrant,
  loadIssuedRoomGrant,
  saveRoomToken,
  type IdentitySlot,
} from "../core/identity-store.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

const WORKER_SCRIPT = path.join(
  import.meta.dirname,
  "identity-token-race-worker.ts",
);
const WORKER_COUNT = 8;
const TOKENS_PER_WORKER = 25;
/** Time for every worker's own start-up to finish before the shared deadline. */
const START_DELAY_MS = 1500;
const TEST_TIMEOUT_MS = 60_000;
/** A device-id in hex is the SHA-256 of its key: 32 bytes. */
const DEVICE_ID_BYTES = 32;
const MEMBER_HEX = "ab".repeat(DEVICE_ID_BYTES);
const ISSUED_TOKEN_ID_BYTE = 7;
const ISSUED_TOKEN_ID = Uint8Array.from([ISSUED_TOKEN_ID_BYTE]);

// Structurally valid stand-in: the store only serialises the byte-string fields.
const TOKEN: CapabilityToken = [
  Uint8Array.from([1]),
  {},
  null,
  Uint8Array.from([2]),
];

const slots: IdentitySlot[] = [];

afterEach(() => {
  for (const slot of slots.splice(0)) releaseIdentityLock(slot);
});

async function runWorker(
  dir: string,
  index: number,
  startAt: number,
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        WORKER_SCRIPT,
        dir,
        String(index),
        String(TOKENS_PER_WORKER),
        String(startAt),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => {
      resolve({ exitCode, stderr });
    });
  });
}

test(
  "processes saving tokens into one slot file at once lose none of them",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const dir = scratchDirectory("agent-comms-token-writes-");
    const slot: IdentitySlot = { harness: "token-race", cwd: "/tmp/race", dir };
    slots.push(slot);
    // The file exists first, so every worker takes the update path.
    loadOrCreateIdentity(slot);
    releaseIdentityLock(slot);

    const startAt = Date.now() + START_DELAY_MS;
    const results = await Promise.all(
      Array.from({ length: WORKER_COUNT }, async (_, index) =>
        runWorker(dir, index, startAt),
      ),
    );

    expect(results.filter((r) => r.exitCode !== 0)).toEqual([]);
    expect(Object.keys(loadRoomTokens(slot))).toHaveLength(
      WORKER_COUNT * TOKENS_PER_WORKER,
    );
  },
);

/** Puts a lock naming a live process of its own over the slot, so the next load in this process loses it. */
async function holdSlotFromAnotherProcess(
  slot: Readonly<IdentitySlot>,
): Promise<{ exit: () => Promise<void> }> {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 60000)"],
    { stdio: "ignore" },
  );
  if (child.pid === undefined) throw new Error("no pid for the holder");
  const lock = fs
    .readdirSync(slot.dir ?? "")
    .find((f) => f.endsWith(".lock") && !f.endsWith(".write.lock"));
  if (lock === undefined) throw new Error("expected the slot lock");
  fs.writeFileSync(path.join(slot.dir ?? "", lock), `${String(child.pid)}\n`);
  return {
    exit: async () =>
      new Promise((resolve) => {
        child.on("exit", () => {
          resolve();
        });
        child.kill("SIGKILL");
      }),
  };
}

test("a bridge running under an ephemeral identity keeps its tokens out of the slot file and does not read the holder's", async () => {
  const dir = scratchDirectory("agent-comms-ephemeral-tokens-");
  const slot: IdentitySlot = { harness: "ephemeral", cwd: "/tmp/e", dir };
  slots.push(slot);

  loadOrCreateIdentity(slot);
  saveRoomToken(slot, "held-by-owner", TOKEN);
  const file = path.join(
    dir,
    fs.readdirSync(dir).find((f) => f.endsWith(".json")) ?? "",
  );
  const before = fs.readFileSync(file, "utf-8");

  const holder = await holdSlotFromAnotherProcess(slot);
  try {
    loadOrCreateIdentity(slot);
    expect(Object.keys(loadRoomTokens(slot))).toEqual([]);

    saveRoomToken(slot, "mine", TOKEN);
    saveGroupToken(slot, "my-group", TOKEN);
    saveIssuedRoomGrant(slot, "mine", MEMBER_HEX, ISSUED_TOKEN_ID);

    // The ephemeral bridge reads back exactly what it saved, and only that.
    expect(Object.keys(loadRoomTokens(slot))).toEqual(["mine"]);
    expect(Object.keys(loadGroupTokens(slot))).toEqual(["my-group"]);
    expect(loadIssuedRoomGrant(slot, "mine", MEMBER_HEX)).toBeDefined();
    // The holder's file is byte-for-byte what its owner wrote.
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  } finally {
    await holder.exit();
  }
});
