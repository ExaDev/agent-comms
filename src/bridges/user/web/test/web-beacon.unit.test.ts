/**
 * The LAN beacon advertises the web UI's host (by source address) and port, and never the access token (agent-comms#346).
 */

import { afterEach, expect, it } from "vitest";
import * as dgram from "node:dgram";
import { freeLocalPort, TeardownStack } from "../../../../test/hub-helpers.js";
import { startWebBeacon, WEB_BEACON_TYPE } from "../web-beacon.js";

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

it("sends one datagram naming the peer and the web port, with nothing else", async () => {
  const port = await freeLocalPort();
  const received = new Promise<string>((resolve) => {
    const listener = dgram.createSocket("udp4");
    cleanups.push(async () => {
      listener.close();
    });
    listener.on("message", (message) => {
      resolve(message.toString());
    });
    listener.bind(port, "127.0.0.1");
  });
  const beacon = startWebBeacon({
    peerId: "peer-1",
    webPort: 4321,
    port,
    address: "127.0.0.1",
  });
  cleanups.push(async () => {
    beacon.stop();
  });

  const payload: unknown = JSON.parse(await received);
  expect(payload).toEqual({
    type: WEB_BEACON_TYPE,
    peerId: "peer-1",
    webPort: 4321,
  });
});
