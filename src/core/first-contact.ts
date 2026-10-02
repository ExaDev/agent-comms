/**
 * FirstContact: default-on machine-local mesh formation without a coordinator (agent-comms#341). A small UDP presence on the shared beacon port (19877, the same port and payload shape discovery-mdns.ts's own backend uses, so both interoperate on the wire) that lets two peers on the same network find and dial each other directly.
 *
 * The protocol is two packets. A beacon, sent immediately at start and on the same interval discovery-mdns.ts beacons on: `{"type":"agent-comms-beacon","name":...,"port":...,"peerId":...}`, carrying this store's own DATA port, the port a discovering peer actually dials (the coordinator port was never the thing to advertise here: formation needs peers, not a rendezvous). A probe (`{"type":"agent-comms-probe"}`), sent once at start so a joining peer does not wait out a full beacon interval: any peer hearing it answers at once with a fresh beacon.
 *
 * Every packet goes to two destinations, never to a unicast address. Peers on the same host all share one UDP port (reuseAddr), and a unicast datagram to a shared port reaches only ONE of the sockets bound to it, which one being platform-dependent: a probe answer sent back to its prober would land on the answerer itself. Loopback multicast (FIRST_CONTACT_GROUP joined on 127.0.0.1) reaches every socket bound to the port and needs no live network, so it carries same-host formation; limited broadcast reaches other machines on the LAN. That is also why a probe is answered with a broadcast beacon rather than a reply to the prober: the reply has to be heard by the prober's socket specifically, and only a many-receiver destination guarantees it.
 *
 * Discovered peers are handed to the caller's onPeerDiscovered as (peerId, host, data port), and the caller feeds them through the existing peer_list path (PeerLifecycle.handlePeerList), which already dials every peer it learns about; each established connection then shares its own peer list, so the data-connection graph forms transitively by flooding and no rendezvous peer-list handout is needed. A peer's own beacon reaching itself (loopback delivery, or a second bridge in the same slot) is dropped by peerId, not by address, because a multi-homed host can legitimately hear itself on more than one interface address.
 *
 * Deliberately independent of DiscoveryManager: that manager is the opt-in, tool-facing advertise/discover surface (mesh_advertise/mesh_discover) with its own visibility semantics, and default-on formation must not change what those actions mean. This module owns its socket lifecycle entirely (start/stop), keeps no state beyond it, and never blocks a caller: probe answers and discovery callbacks arrive asynchronously on the socket's own events.
 */

import * as dgram from "node:dgram";
import type { PeerInfo } from "./wire-protocol.js";
import { isWebBeaconPayload } from "./web-beacon.js";

/** The shared beacon port, the same one discovery-mdns.ts's backend uses: one presence per machine-local network, interoperable payloads. */
export const FIRST_CONTACT_PORT = 19877;

/** The administratively scoped multicast group (239.255.0.0/16, organisation-local scope) joined on the loopback interface, so every same-host socket bound to the beacon port hears every packet whatever the state of the network. */
export const FIRST_CONTACT_GROUP = "239.255.19.77";

/** The loopback interface the group is joined and sent on, and the address same-host multicast packets arrive from. */
const LOOPBACK_INTERFACE = "127.0.0.1";

/** The limited-broadcast address that carries beacons and probes to other machines on the LAN. */
export const BROADCAST_ADDRESS = "255.255.255.255";

/** How often the beacon repeats once started; matching discovery-mdns.ts's own interval so the two presences behave alike on the wire. */
export const FIRST_CONTACT_INTERVAL_MS = 30_000;

/** The one shape every beacon carries. Extension-safe for other consumers: parsers must ignore fields they do not know (discovery-mdns.ts's parseBeacon already does). */
interface BeaconPayload {
  type: "agent-comms-beacon";
  /** This store's own peer id, so a peer can drop its own beacon reaching it back. */
  peerId: string;
  /** This store's data-server port: the port a discovering peer dials. */
  port: number;
  name: string;
}

/** A peer this side discovered and can dial directly. */
export interface DiscoveredPeer {
  peerId: string;
  host: string;
  port: number;
}

export interface FirstContactOptions {
  /** This store's own peer id, for the self-beacon guard. */
  peerId: string;
  /** This store's own data-server port, the port beacons advertise. */
  dataPort: number;
  /** A human-readable name for the beacon payload, matching discovery-mdns.ts's own name field. */
  name: string;
  /** Called once per discovered peer (deduplicated by peerId within this instance's lifetime). */
  onPeerDiscovered: (peer: Readonly<DiscoveredPeer>) => void;
  /** Called for every web UI beacon heard (agent-comms#353), with the host taken from the datagram's source address. Not deduplicated: a beacon repeats on the presence's own interval, and the receiver refreshes its entry each time. Absent means this presence ignores web beacons, today's behaviour before the receiving side existed. */
  onWebBeacon?: (
    beacon: Readonly<{ peerId: string; host: string; webPort: number }>,
  ) => void;
  /** The UDP port the presence binds, beacons, and probes on. Defaults to FIRST_CONTACT_PORT; overridable so tests take an OS-assigned free port rather than contending with a real machine presence. */
  port?: number;
  /** Reported, never fatal: a network where broadcast is unavailable (some cloud environments) simply yields no discovery. */
  onError?: (error: Error) => void;
}

export class FirstContact {
  private socket: dgram.Socket | undefined;
  private beaconTimer: ReturnType<typeof setInterval> | undefined;
  private readonly seenPeerIds = new Set<string>();

  constructor(private readonly opts: Readonly<FirstContactOptions>) {}

  /** Starts the presence: bind, beacon once and on interval, and broadcast one probe round so nearby peers answer at once instead of on their next beacon. Never throws: a bind failure (another process holds the port without reuse, or the network forbids it) is reported through onError and simply leaves this peer discoverable by others' probes unanswered. */
  start(): void {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", (err: Error) => {
      this.opts.onError?.(err);
    });
    socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      this.handlePacket(msg, rinfo);
    });
    socket.bind(this.opts.port ?? FIRST_CONTACT_PORT, () => {
      socket.setBroadcast(true);
      try {
        socket.addMembership(FIRST_CONTACT_GROUP, LOOPBACK_INTERFACE);
        socket.setMulticastInterface(LOOPBACK_INTERFACE);
        socket.setMulticastLoopback(true);
      } catch (error) {
        // Reported, not fatal: a host whose loopback interface cannot carry multicast (a Linux container without it, say) still gets LAN broadcast, so the presence degrades to cross-machine discovery rather than failing outright.
        this.opts.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      this.sendBeacon();
      this.sendProbe();
      this.beaconTimer = setInterval(() => {
        this.sendBeacon();
      }, FIRST_CONTACT_INTERVAL_MS);
    });
    this.socket = socket;
  }

  /** Stops the presence and releases the port. Idempotent. */
  stop(): void {
    if (this.beaconTimer !== undefined) {
      clearInterval(this.beaconTimer);
      this.beaconTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.close();
    }
  }

  private handlePacket(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const parsed: unknown = this.parseJson(msg);
    if (isWebBeaconPayload(parsed)) {
      if (parsed.peerId === this.opts.peerId) return;
      this.opts.onWebBeacon?.({
        peerId: parsed.peerId,
        host: rinfo.address,
        webPort: parsed.webPort,
      });
      return;
    }
    if (!isBeaconPayload(parsed)) {
      // A probe from another peer: answer at once with a fresh beacon on the same many-receiver destinations (see the header comment on why never a unicast reply), so the prober does not wait out our interval.
      if (isProbePayload(parsed)) {
        this.sendBeacon();
      }
      return;
    }
    if (parsed.peerId === this.opts.peerId) return;
    if (this.seenPeerIds.has(parsed.peerId)) return;
    this.seenPeerIds.add(parsed.peerId);
    this.opts.onPeerDiscovered({
      peerId: parsed.peerId,
      host: rinfo.address,
      port: parsed.port,
    });
  }

  private sendBeacon(): void {
    const port = this.opts.port ?? FIRST_CONTACT_PORT;
    this.sendBeaconTo(FIRST_CONTACT_GROUP, port);
    this.sendBeaconTo(BROADCAST_ADDRESS, port);
  }

  private sendBeaconTo(address: string, port: number): void {
    const socket = this.socket;
    if (socket === undefined) return;
    const payload: BeaconPayload = {
      type: "agent-comms-beacon",
      peerId: this.opts.peerId,
      port: this.opts.dataPort,
      name: this.opts.name,
    };
    socket.send(JSON.stringify(payload), port, address, (err) => {
      if (err) {
        this.opts.onError?.(err);
      }
    });
  }

  private sendProbe(): void {
    const socket = this.socket;
    if (socket === undefined) return;
    const probe = JSON.stringify({ type: "agent-comms-probe" });
    const port = this.opts.port ?? FIRST_CONTACT_PORT;
    for (const address of [FIRST_CONTACT_GROUP, BROADCAST_ADDRESS]) {
      socket.send(probe, port, address, (err) => {
        if (err) {
          this.opts.onError?.(err);
        }
      });
    }
  }

  private parseJson(msg: Buffer): unknown {
    try {
      return JSON.parse(msg.toString());
    } catch {
      return undefined;
    }
  }
}

function isBeaconPayload(value: unknown): value is BeaconPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || value.type !== "agent-comms-beacon") return false;
  if (!("peerId" in value) || typeof value.peerId !== "string") return false;
  if (!("port" in value) || typeof value.port !== "number") return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  return true;
}

function isProbePayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return "type" in value && value.type === "agent-comms-probe";
}

/** How much of the peer id the beacon's human-readable name carries: enough to tell two beacons apart in a packet capture, not an identity claim (the full peerId field beside it is that). */
const BEACON_NAME_PEER_ID_CHARS = 8;

/**
 * The store-side half of the wiring (agent-comms#341), kept here rather than in mesh-store.ts so that file stays under the repo's max-lines cap, the same reason its other collaborators were split out: constructs, starts, and returns the presence, mapping each discovered peer into a PeerInfo (host from the beacon's source address, port from its payload) for the caller to feed into the ordinary peer-list flood.
 */
export function startFirstContact(
  input: Readonly<{
    peerId: string;
    dataPort: number;
    port: number;
    onPeer: (peer: Readonly<PeerInfo>) => void;
    onWebBeacon?: FirstContactOptions["onWebBeacon"];
    onError: (error: Error) => void;
  }>,
): FirstContact {
  const presence = new FirstContact({
    peerId: input.peerId,
    dataPort: input.dataPort,
    name: `agent-comms-${input.peerId.slice(0, BEACON_NAME_PEER_ID_CHARS)}`,
    port: input.port,
    ...(input.onWebBeacon !== undefined
      ? { onWebBeacon: input.onWebBeacon }
      : {}),
    onPeerDiscovered: (peer) => {
      input.onPeer({
        id: peer.peerId,
        port: peer.port,
        startedAt: new Date().toISOString(),
        host: peer.host,
      });
    },
    onError: input.onError,
  });
  presence.start();
  return presence;
}
