/**
 * LAN advertisement of a bridge's web UI (agent-comms#346).
 *
 * A send-only UDP beacon on the first-contact port announcing where this bridge's web UI listens. It carries the peer id and the web port and nothing else: the receiver learns the host from the datagram's source address, and the access token is never advertised, so seeing the beacon grants no access. The type is distinct from first-contact's own `agent-comms-beacon`, which peers parse for a data port to dial; first-contact ignores any other type, so the two never interfere.
 */

import * as dgram from "node:dgram";
import {
  BROADCAST_ADDRESS,
  FIRST_CONTACT_INTERVAL_MS,
  FIRST_CONTACT_PORT,
} from "../../../core/first-contact.js";

/** The beacon type, distinct from first-contact's `agent-comms-beacon`. */
export const WEB_BEACON_TYPE = "agent-comms-web-beacon";

export interface WebBeaconPayload {
  type: typeof WEB_BEACON_TYPE;
  peerId: string;
  webPort: number;
}

export interface WebBeaconOptions {
  peerId: string;
  webPort: number;
  /** The UDP port beacons are sent to. Defaults to the first-contact port; tests pass an OS-assigned free port. */
  port?: number | undefined;
  /** The destination address. Defaults to limited broadcast; tests pass a loopback address so no real network is needed. */
  address?: string;
  onError?: (error: Error) => void;
}

export interface WebBeacon {
  stop: () => void;
}

/** Starts beaconing immediately and on first-contact's interval. A send failure (broadcast unavailable on this network) is reported through onError and never fatal. */
export function startWebBeacon(options: Readonly<WebBeaconOptions>): WebBeacon {
  const socket = dgram.createSocket({ type: "udp4" });
  const destinationPort = options.port ?? FIRST_CONTACT_PORT;
  const address = options.address ?? BROADCAST_ADDRESS;
  const payload: WebBeaconPayload = {
    type: WEB_BEACON_TYPE,
    peerId: options.peerId,
    webPort: options.webPort,
  };
  const message = JSON.stringify(payload);
  const reportError = (error: Error): void => {
    options.onError?.(error);
  };
  socket.on("error", reportError);
  const send = (): void => {
    socket.send(message, destinationPort, address, (error) => {
      if (error) reportError(error);
    });
  };
  socket.bind(0, () => {
    if (address === BROADCAST_ADDRESS) socket.setBroadcast(true);
    send();
  });
  const timer = setInterval(send, FIRST_CONTACT_INTERVAL_MS);
  timer.unref();
  return {
    stop(): void {
      clearInterval(timer);
      socket.close();
    },
  };
}
