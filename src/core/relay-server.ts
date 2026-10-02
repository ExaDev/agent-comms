/**
 * RelayServer: the relay role a bridge serves to its machine and local network (agent-comms#342), wire-mesh-core's transport-agnostic relay-hub domain logic (the same createRelayHub the public hub runs) behind a WebSocket listener. It forwards between its own directly connected clients and, when given an uplink, carries them over it to the upstream hub and back (attachUplink), so a device on the upstream hub and a client of this relay reach each other with each end's own device-id intact. It never routes beyond that: relay payloads are end-to-end encrypted between the two devices using it, so what the relay learns is who talks to whom, never what they say.
 *
 * Admission is deny-by-default, like every other cross-machine decision here: a connection is registered with the hub only once it gossips an advert for a device isAdmitted accepts, and every gossiped advert naming a device it does not accept is dropped before the hub sees it. A connection that never gossips an admitted device can neither be named by a relay-connect nor relay anything, and learns nothing, since the hub's catch-up is sent only in answer to a registered connection's gossip.
 */

import { createServer, type Server } from "node:http";
import * as os from "node:os";
import { WebSocketServer } from "ws";
import { createRelayHub, type RelayHub } from "wire-mesh-core/domain/relay-hub";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  deriveDeviceId,
  verifyWithPublicKey,
} from "wire-mesh-core/adapters/node-identity";
import type { Frame } from "wire-mesh-core/generated/protocol";
import type { Connection } from "wire-mesh-core/ports/transport";
import { wrapWsSocket } from "./ws-dial.js";
import { createUplink, type UplinkFeed } from "./relay-uplink.js";

/** The wildcard IPv4 address: listening on it serves every interface, loopback and the local network alike. */
export const ALL_INTERFACES_HOST = "0.0.0.0";

/** The loopback address every relay also offers, so a peer on the same machine reaches it without leaving the host. */
const LOOPBACK_HOST = "127.0.0.1";

export interface RelayServerOptions {
  /** The interface to listen on: ALL_INTERFACES_HOST to serve the local network, or a single address (a test serves loopback only). */
  host: string;
  /** Whether a device (hex) may use this relay. */
  isAdmitted: (deviceHex: string) => boolean;
  /** Reports a failure of the uplink, which is otherwise detached from any caller. */
  onError: (error: Error) => void;
}

export class RelayServer {
  private readonly hub: RelayHub = createRelayHub({
    identity: { verify: verifyWithPublicKey, deriveDeviceId },
  });
  private readonly http: Server = createServer();
  private readonly wss = new WebSocketServer({ server: this.http });
  private port = 0;
  /** Settles once the previous uplink has been forgotten by the hub, which refuses a second while one is attached. */
  private uplinkDone: Promise<void> = Promise.resolve();

  constructor(private readonly options: Readonly<RelayServerOptions>) {
    this.wss.on("connection", (socket) => {
      socket.binaryType = "arraybuffer";
      void this.serve(wrapWsSocket(socket));
    });
  }

  /** Binds an OS-assigned port and resolves once listening. */
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(0, this.options.host, () => {
        this.http.off("error", reject);
        resolve();
      });
    });
    const address = this.http.address();
    if (address === null || typeof address === "string") {
      throw new Error("RelayServer: expected a TCP listen address");
    }
    this.port = address.port;
    // Never what keeps a process alive: the bridge that serves the relay decides when it exits.
    this.http.unref();
  }

  /** Takes the connection to the upstream hub as this relay's uplink (wire-mesh-core's relay-hub fronting, wire-mesh#311): the clients registered here become reachable through the upstream hub and can reach the devices registered there, each end keeping its own device-id. The upstream connection belongs to the caller's own session, so the frames it reads are fed in through the returned feed, and ending the feed detaches the uplink. */
  attachUplink(upstream: Readonly<Connection>): UplinkFeed {
    const uplink = createUplink(upstream);
    this.uplinkDone = this.uplinkDone
      .then(async () => this.hub.handleUplink(uplink.connection))
      .catch((error: unknown) => {
        this.options.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    return uplink.feed;
  }

  /** The URLs this relay is reachable at, for its relay offer: loopback always, and each external IPv4 interface too when it listens on every interface. */
  addresses(): string[] {
    const hosts =
      this.options.host === ALL_INTERFACES_HOST
        ? [LOOPBACK_HOST, ...externalIpv4Addresses()]
        : [this.options.host];
    return hosts.map((host) => `ws://${host}:${String(this.port)}/`);
  }

  /** How many clients are connected, admitted or not. */
  connectionCount(): number {
    return this.wss.clients.size;
  }

  /** Closes every client and the listener. */
  async stop(): Promise<void> {
    this.hub.stop();
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      this.http.close(() => {
        resolve();
      });
    });
  }

  /** Drives one connection: filters its gossip to admitted devices, registers it with the hub on its first admitted advert, and hands the hub every frame from then on. */
  private async serve(connection: Readonly<Connection>): Promise<void> {
    let registered = false;
    try {
      for await (const frame of connection.receive()) {
        const admitted = this.admit(frame);
        if (admitted === undefined) continue;
        if (!registered) {
          if (admitted.type !== "gossip") continue;
          this.hub.registerConnection(connection);
          registered = true;
        }
        await this.hub.onFrame(connection, admitted);
      }
    } catch {
      // A connection that fails mid-stream is simply gone; its registration is cleaned up below.
    } finally {
      if (registered) this.hub.onDisconnect(connection);
    }
  }

  /** The frame to pass on, or undefined to drop it: gossip keeps only admitted adverts, and nothing else passes before the connection has gossiped one. */
  private admit(frame: Frame): Frame | undefined {
    if (frame.type !== "gossip") return frame;
    const peers = frame.peers.filter((advert) =>
      this.options.isAdmitted(deviceIdToHex(advert.device)),
    );
    if (peers.length === 0) return undefined;
    return { ...frame, peers };
  }
}

function externalIpv4Addresses(): string[] {
  const result: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    if (addresses === undefined) continue;
    for (const address of addresses) {
      if (address.family === "IPv4" && !address.internal) {
        result.push(address.address);
      }
    }
  }
  return result;
}
