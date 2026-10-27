import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { decode, cdeDecodeOptions } from "cbor2";
import { createNodeFsStorage } from "wire-mesh-core/adapters/node-fs-storage";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { readEntries } from "wire-mesh-core/domain/data-sync";
import { bytesFromHex } from "wire-mesh-core/domain/device-id";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { verifyRoomNotice } from "wire-mesh-core/domain/room";
import type { RoomNotice } from "wire-mesh-core/generated/protocol";
import {
  createBridgeMesh,
  loadIdentityForFront,
  releaseIdentityLock,
  type CommsStore,
  type SendRoomMessageOptions,
} from "../core/index.js";
import { oplogDirFor } from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

describe("public room-send durability", () => {
  it.each([undefined, false, true])(
    "records a notice only when durable is true (received %j)",
    async (durable) => {
      const root = scratchDirectory("mesh-durable-");
      const slot = { harness: "durable-test", cwd: root, dataDir: root };
      const mesh = await createBridgeMesh(slot, {
        fetchLatestVersion: async () => undefined,
      });
      try {
        const store: CommsStore = mesh.store;
        const room = await store.createRoom({
          name: "durable-room",
          type: "public",
          owner: mesh.store.peerId,
          description: "",
        });
        const options: SendRoomMessageOptions = { durable };
        const sent = await store.sendRoomMessage(
          room.id,
          mesh.store.peerId,
          "public durable message",
          options,
        );
        expect(sent.message.content).toBe("public durable message");

        const entries = await readEntries(
          createNodeFsStorage({ dir: oplogDirFor(slot) }),
          Uint8Array.from(bytesFromHex(mesh.store.peerId)),
          0,
        );
        expect(entries).toHaveLength(durable === true ? 1 : 0);
        if (entries[0] !== undefined) {
          const notice = decode<RoomNotice>(entries[0], cdeDecodeOptions);
          const verdict = await verifyRoomNotice(notice, {
            identity: await toIdentityPort(loadIdentityForFront(slot)),
            clock: createSystemClock(),
            revocation: createRevocationView(),
          });
          expect(verdict.ok).toBe(true);
          if (!verdict.ok) return;
          expect(verdict.claims.room).toBe(room.id);
          expect(new TextDecoder().decode(verdict.claims.content)).toBe(
            sent.message.content,
          );
        }
      } finally {
        await mesh.store.shutdown();
        releaseIdentityLock(slot);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
