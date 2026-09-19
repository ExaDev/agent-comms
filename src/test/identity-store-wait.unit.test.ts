/**
 * Unit test for the interleaving readStoredIdentityWaitingForConcurrentCreate must survive: the slot's identity file is read (absent), then the file is created and its creator exits, and only then is the lock file read (holder no longer alive). Concluding "no identity" from the lock alone would miss the file that appeared in between, so the file has to be checked once more.
 *
 * node:fs is wrapped so a hook can create the identity file at the exact moment the lock file is read, which is the only way to land that interleaving deterministically.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import {
  loadOrCreateIdentity,
  loadRoomTokens,
  saveRoomToken,
} from "../core/identity-store.js";

const hooks = vi.hoisted(() => ({
  onRead: undefined as ((filePath: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    default: actual,
    readFileSync: (
      filePath: fs.PathOrFileDescriptor,
      options: BufferEncoding,
    ) => {
      hooks.onRead?.(String(filePath));
      return actual.readFileSync(filePath, options);
    },
  };
});

// A structurally valid stand-in: saveRoomToken only serialises a CapabilityToken's byte-string fields.
const FAKE_TOKEN: CapabilityToken = [
  Uint8Array.from([1]),
  {},
  null,
  Uint8Array.from([2]),
];

/** The pid of a process that has already exited, so the lock it "holds" is stale. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("child had no pid");
  return child.pid;
}

describe("saveRoomToken racing a concurrent identity creation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    hooks.onRead = undefined;
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function scratchDir(): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "identity-wait-"));
    dirs.push(dir);
    return dir;
  }

  it("finds an identity file that appeared, with its creator already gone, between the file read and the lock read", () => {
    // Real identity text to "appear": made in a separate slot so nothing shares state with the slot under test.
    const sourceSlot = {
      harness: "wait",
      cwd: "/tmp/source",
      dir: scratchDir(),
    };
    loadOrCreateIdentity(sourceSlot);
    const identityText = fs.readFileSync(
      path.join(
        sourceSlot.dir,
        fs.readdirSync(sourceSlot.dir).find((f) => f.endsWith(".json")) ?? "",
      ),
      "utf-8",
    );

    const slot = { harness: "wait", cwd: "/tmp/target", dir: scratchDir() };
    const targetBase = path.join(slot.dir, "identity-wait--_tmp_target");
    fs.writeFileSync(`${targetBase}.lock`, `${String(deadPid())}\n`);

    hooks.onRead = (filePath) => {
      if (!filePath.endsWith(".lock")) return;
      hooks.onRead = undefined;
      fs.writeFileSync(`${targetBase}.json`, identityText);
    };

    saveRoomToken(slot, "race-room", FAKE_TOKEN);

    expect(Object.keys(loadRoomTokens(slot))).toEqual(["race-room"]);
  });
});
