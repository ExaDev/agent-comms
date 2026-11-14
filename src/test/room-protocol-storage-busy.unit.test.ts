/**
 * A room invite whose token cannot be stored because the identity file's write lock stays held is answered as storage_busy, not by a thrown error that would end the session's request loop.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";
import { bytesToHex, deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { generateIdentity } from "../core/identity.js";
import { writeLockFor } from "../core/pid-lock-file.js";
import { ownerNamedRoomPath } from "../core/room-path.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { spawnLiveProcess } from "./live-process.helper.js";
import {
  handle,
  makeHarness,
  manageRequest,
  mintRoomToken,
} from "./room-protocol.helper.js";

const TEST_TIMEOUT_MS = 30_000;

it(
  "answers a room.invite as storage_busy while the write lock is held by a live process",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const h = await makeHarness();
    const owner = generateIdentity();
    const ownerHex = bytesToHex(Uint8Array.from(owner.deviceId));
    const roomPath = ownerNamedRoomPath(ownerHex, "general");
    const token = await mintRoomToken(
      await toIdentityPort(owner),
      h.ids.ownerId,
      roomPath,
    );
    const identityFile = fs
      .readdirSync(h.slotDir)
      .find((f) => f.endsWith(".json"));
    if (identityFile === undefined) throw new Error("no identity file");
    const holder = spawnLiveProcess();
    fs.writeFileSync(
      writeLockFor(path.join(h.slotDir, identityFile)),
      `${String(holder.pid)}\n`,
    );
    try {
      const invite = h.protocol.roomVerbHandlers["room.invite"];
      if (invite === undefined) throw new Error("expected room.invite handler");

      const outcome = await invite(
        manageRequest({
          scope: { kind: "room", path: roomPath },
          params: {
            verb: "room.invite",
            invitee: deviceIdFromHex(h.ids.ownerId),
            token,
          },
        }),
        handle(h.ids.memberId),
      );

      expect(outcome).toEqual({ result: "error", code: "storage_busy" });
    } finally {
      await holder.exit();
    }
  },
);
