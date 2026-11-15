/**
 * An answer to a dial that is not the peer, or that cannot show it is, is reported and its connection closed, and what dialled is told there is nobody to talk to.
 */

import { expect, it, vi } from "vitest";
import type { Connection } from "wire-mesh-core/ports/transport";
import { dialPeer } from "../core/peer-link-error.js";

const DEVICE_ID_BYTES = 32;
const PEER = { id: "ab".repeat(DEVICE_ID_BYTES), port: 4242 };

function answeringWithoutDeviceId(): {
  connection: Connection;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn().mockResolvedValue(undefined);
  const connection: Connection = {
    send: async () => Promise.resolve(),
    receive: async function* () {
      yield* [];
    },
    close,
  };
  return { connection, close };
}

it("reports an answer that names no device id, naming the port, and closes it", async () => {
  const { connection, close } = answeringWithoutDeviceId();
  const errors: Error[] = [];

  const result = await dialPeer(
    { connect: async () => connection },
    "127.0.0.1",
    PEER,
    (error) => {
      errors.push(error);
    },
  );

  expect(result).toBeUndefined();
  expect(close).toHaveBeenCalledTimes(1);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toContain("no device id");
  expect(errors[0]?.message).toContain(String(PEER.port));
});
