/**
 * WireMeshTransport's own core/data frame dispatch (data-have, data-request, data-entries), split out under the repo's max-lines cap the same way gossip-directory.ts and hub-forwarding.ts were each split from the same owning file.
 */

import {
  handleDataEntries,
  handleDataHave,
  handleDataRequest,
} from "wire-mesh-core/domain/data-sync";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { isDataFrame } from "wire-mesh-core/domain/hub-mailbox";
import type { DataDomainFrame } from "wire-mesh-core/domain/mesh-session";
import type {
  DataHaveFrame,
  DataRequestFrame,
  Frame,
} from "wire-mesh-core/generated/protocol";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import type { AccountLedgerReplica } from "./account-ledger.js";
import { readMembershipProof } from "./gossip-directory.js";
import type { WireMeshTransportOptions } from "./wire-mesh-transport-options.js";

/** The most entries one data-entries reply carries, for every log this side answers for, the account ledger's included: a longer log catches up over several rounds, so the bound only caps one frame's size. */
export const DATA_ENTRIES_RESPONSE_LIMIT = 100;

/** What the router needs to replicate the account's grant ledger (agent-comms#344). */
export interface AccountReplication {
  /** The ledger, read on every frame and every announcement round because it opens after the transport is built and is replaced when the machine joins another account. Undefined until it has opened. */
  ledger: () => AccountLedgerReplica | undefined;
  /** Whether the peer whose session authenticated it as `deviceHex` holds the same account. Only such a peer is offered the ledger or answered for it, so a device of another account never stores the ciphertext or follows its head. */
  isAccountPeer: (deviceHex: string) => Promise<boolean>;
}

/** How core/data frames reach a device that this side meets only through the relay hub, over a relay pairing sealed end to end between the two devices: the hub carries ciphertext and never sees a frame. */
export interface HubDataChannel {
  /** The devices (hex) the hub's gossiped directory has admitted, whether or not this side also has a direct session to them. */
  peers: () => readonly string[];
  /** Sends one frame to `deviceHex` through the hub. Rejects when no hub session is live. */
  send: (deviceHex: string, frame: DataDomainFrame) => Promise<void>;
}

/** The hub data channel over whatever hub session `hub()` currently returns, read on each call because the router is built before the hub it talks through. */
export function hubDataChannel(
  hub: () => {
    peers: () => readonly string[];
    sendDataFrame: (
      deviceHex: string,
      frame: Readonly<DataDomainFrame>,
    ) => Promise<void>;
  },
): HubDataChannel {
  return {
    peers: () => hub().peers(),
    send: async (deviceHex, frame) => hub().sendDataFrame(deviceHex, frame),
  };
}

/** Builds the router's account replication from the transport option: a peer is an account peer when the membership proof in its gossiped advert (looked up through `advertOf`) verifies against this machine's own principal. Undefined when the transport has no account ledger. */
export function accountReplicationFrom(
  options: Readonly<WireMeshTransportOptions>["accountReplication"],
  advertOf: (
    deviceHex: string,
  ) => Readonly<Record<string, unknown>> | undefined,
): AccountReplication | undefined {
  if (options === undefined) return undefined;
  return {
    ledger: options.getLedger,
    isAccountPeer: async (deviceHex) => {
      const advert = advertOf(deviceHex);
      const proof =
        advert === undefined
          ? undefined
          : readMembershipProof(advert, "membership");
      return proof === undefined
        ? false
        : options.isAccountMember({ proof, deviceHex });
    },
  };
}

/** Routes one frame received on a raw data connection, tracking the connection against its peer's device-id along the way (connectionsByPeer, mutated in place) so a later data-have, data-request or data-entries send addressed to that same peer reuses it. Nothing further happens until the sender is a tracked peer session. A frame naming one of the account's writer logs goes to the account ledger when the sender holds the same account and is dropped otherwise, without reaching dataStorage either way; any other data frame goes to wire-mesh-core's own core/data handlers over dataStorage, and is dropped when this side has no dataStorage. Any handler error is reported via onError and swallowed, never thrown, since this runs inside the transport's own onFrame callback with no caller awaiting it directly. */
export async function routeDataFrame(
  deps: Readonly<{
    connectionsByPeer: Map<string, Readonly<Connection>>;
    dataStorage: KeyValueStorage | undefined;
    account: Readonly<AccountReplication> | undefined;
    peerSessions: ReadonlyMap<string, unknown>;
    onError: ((error: Error) => void) | undefined;
  }>,
  connection: Readonly<Connection>,
  frame: Frame,
): Promise<void> {
  const peerDeviceId = connection.peerDeviceId;
  if (peerDeviceId === undefined) return;
  const deviceIdHex = deviceIdToHex(peerDeviceId);
  deps.connectionsByPeer.set(deviceIdHex, connection);
  if (!deps.peerSessions.has(deviceIdHex)) return;
  try {
    const ledger = deps.account?.ledger();
    if (
      isDataFrame(frame) &&
      ledger !== undefined &&
      deps.account !== undefined &&
      ledger.ownsLog(frame.peer)
    ) {
      if (!(await deps.account.isAccountPeer(deviceIdHex))) return;
      const reply = await ledger.handleDataFrame(frame);
      if (reply !== null) await connection.send(reply);
      return;
    }
    if (deps.dataStorage === undefined) return;
    if (frame.type === "data-have") {
      const request = await handleDataHave(deps.dataStorage, frame);
      if (request !== null) await connection.send(request);
    } else if (frame.type === "data-request") {
      const entries = await handleDataRequest(
        deps.dataStorage,
        frame,
        DATA_ENTRIES_RESPONSE_LIMIT,
      );
      if (entries !== null) await connection.send(entries);
    } else if (frame.type === "data-entries") {
      await handleDataEntries(deps.dataStorage, frame);
    }
  } catch (error: unknown) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Handles one core/data frame that arrived through a relay pairing, from the device the pairing's secure channel authenticated as `fromDeviceHex`. Only a frame naming one of the account's writer logs, from a device that holds the same account, is acted on, and any answer goes back through the same pairing; every other relayed data frame is dropped, since a device met only through the hub has no standing to read or write this side's other logs. Any handler error is reported via onError and swallowed, as in routeDataFrame. */
export async function routeRelayedDataFrame(
  deps: Readonly<{
    account: Readonly<AccountReplication> | undefined;
    hub: Readonly<HubDataChannel> | undefined;
    onError: ((error: Error) => void) | undefined;
  }>,
  fromDeviceHex: string,
  frame: Readonly<DataDomainFrame>,
): Promise<void> {
  const { account, hub } = deps;
  if (account === undefined || hub === undefined) return;
  try {
    const ledger = account.ledger();
    if (ledger?.ownsLog(frame.peer) !== true) return;
    if (!(await account.isAccountPeer(fromDeviceHex))) return;
    const reply = await ledger.handleDataFrame(frame);
    if (reply !== null) await hub.send(fromDeviceHex, reply);
  } catch (error: unknown) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Offers every account writer log this machine holds to every device that holds the same account and that this side can reach (agent-comms#344): over a live, trusted data connection, or, for a device it meets only through the relay hub, over a relay pairing. Such a device that is behind asks for what it is missing, which is the data-domain fan-out that carries each machine's grants and revocations to every other. A device reachable both ways is offered the logs once, directly. Called on the gossip cadence, so a machine that was away when an entry was written still catches up the next time it is reachable. A send that fails is reported and the rest carry on; the next round retries it. */
export async function announceAccountLedger(
  deps: Readonly<{
    connectionsByPeer: ReadonlyMap<string, Readonly<Connection>>;
    account: Readonly<AccountReplication>;
    hub: Readonly<HubDataChannel> | undefined;
    peerSessions: ReadonlyMap<string, unknown>;
    onError: ((error: Error) => void) | undefined;
  }>,
): Promise<void> {
  const ledger = deps.account.ledger();
  if (ledger === undefined) return;
  const frames = await ledger.announcements();
  if (frames.length === 0) return;
  const reportError = (error: unknown): void => {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)));
  };
  const direct = new Set<string>();
  const offers: Promise<void>[] = [];
  for (const [deviceHex, connection] of deps.connectionsByPeer) {
    if (!deps.peerSessions.has(deviceHex)) continue;
    if (!(await deps.account.isAccountPeer(deviceHex))) continue;
    direct.add(deviceHex);
    for (const frame of frames) {
      try {
        await connection.send(frame);
      } catch (error: unknown) {
        reportError(error);
      }
    }
  }
  const { hub } = deps;
  if (hub === undefined) return;
  for (const deviceHex of hub.peers()) {
    if (direct.has(deviceHex)) continue;
    if (!(await deps.account.isAccountPeer(deviceHex))) continue;
    // Each device is offered concurrently: a pairing to a device that is not there waits out its own handshake, which must not hold up the others.
    offers.push(
      (async () => {
        for (const frame of frames) {
          try {
            await hub.send(deviceHex, frame);
          } catch (error: unknown) {
            reportError(error);
          }
        }
      })(),
    );
  }
  await Promise.all(offers);
}

export interface DataFrameRouterDeps {
  dataStorage: KeyValueStorage | undefined;
  /** Absent for a transport with no account ledger. */
  account: Readonly<AccountReplication> | undefined;
  /** The transport's own trusted sessions, keyed by device-id hex: the gate every data frame and every announcement passes. */
  peerSessions: ReadonlyMap<string, unknown>;
  onError: ((error: Error) => void) | undefined;
  /** Absent for a transport that never dials a relay hub. */
  hub: Readonly<HubDataChannel> | undefined;
  /** How often the account ledger is offered to peers: the transport's own re-advertise cadence. */
  announceIntervalMs: number;
}

/** WireMeshTransport's core/data state and dispatch, split out under the repo's max-lines cap: the connection each peer's frames arrive on, routing of every data frame received, the mechanical send primitive, and the periodic offer of the account ledger's writer logs, and the same exchange with a device met only through the relay hub. */
export class DataFrameRouter {
  /** Backs this side's own responder for an incoming data-have, data-request or data-entries frame about any log other than the account ledger's (agent-comms#50's P5 integration). When undefined, such frames are dropped; the account ledger's are routed either way. For those logs, deciding when to proactively call sendDataFrame at all (the catch-up policy: which peers' logs to track, when to send an initial data-have) stays the caller's business and this field only backs the mechanical parts (answering a have or request, storing entries); the account ledger's own offers are the router's, sent every announceIntervalMs. */
  private readonly dataStorage: KeyValueStorage | undefined;

  /** Every peer this side has ever received a frame from, keyed by device-id hex, tracking the raw wire-mesh-core Connection each frame arrived on: what sendDataFrame needs, since neither AcceptedMeshSession nor MeshSession exposes a generic "send an arbitrary frame" method the way the raw Connection itself does. Registered eagerly on the very first frame from a connection (including one still in quarantine, e.g. before connect_request approval) so a later sendDataFrame call can reach it; routeDataFrame's own trust gate (peerSessions.has) is what actually decides whether to act on anything received this way, not this map. */
  private readonly connectionsByPeer = new Map<string, Connection>();

  private announceInterval: ReturnType<typeof setInterval> | undefined;

  /** Whether an announcement round is still running, so a round slowed by an unreachable hub peer is not stacked on by the next tick. */
  private announcing = false;

  constructor(private readonly deps: Readonly<DataFrameRouterDeps>) {
    this.dataStorage = deps.dataStorage;
    const { account } = deps;
    if (account === undefined) return;
    this.announceInterval = setInterval(() => {
      if (this.announcing) return;
      this.announcing = true;
      announceAccountLedger({
        connectionsByPeer: this.connectionsByPeer,
        account,
        hub: deps.hub,
        peerSessions: deps.peerSessions,
        onError: deps.onError,
      })
        .catch((error: unknown) => {
          deps.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        })
        .finally(() => {
          this.announcing = false;
        });
    }, deps.announceIntervalMs);
    this.announceInterval.unref();
  }

  /** See routeDataFrame. */
  async route(connection: Readonly<Connection>, frame: Frame): Promise<void> {
    await routeDataFrame(
      {
        connectionsByPeer: this.connectionsByPeer,
        dataStorage: this.dataStorage,
        account: this.deps.account,
        peerSessions: this.deps.peerSessions,
        onError: this.deps.onError,
      },
      connection,
      frame,
    );
  }

  /** See routeRelayedDataFrame. An arrow property, so the transport can hand it to the hub session as a callback. */
  readonly routeRelayed = async (
    fromDeviceHex: string,
    frame: Readonly<DataDomainFrame>,
  ): Promise<void> => {
    await routeRelayedDataFrame(
      {
        account: this.deps.account,
        hub: this.deps.hub,
        onError: this.deps.onError,
      },
      fromDeviceHex,
      frame,
    );
  };

  /** Sends one frame on the connection peerDeviceHex's frames last arrived on. Throws if none has arrived from it yet. */
  async send(
    peerDeviceHex: string,
    frame: Readonly<DataHaveFrame> | Readonly<DataRequestFrame>,
  ): Promise<void> {
    const connection = this.connectionsByPeer.get(peerDeviceHex);
    if (connection === undefined) {
      throw new Error(
        `WireMeshTransport: no live connection for peer ${peerDeviceHex}`,
      );
    }
    await connection.send(frame);
  }

  /** Stops offering the account ledger. A router that never started offering it has no timer to clear. */
  stop(): void {
    if (this.announceInterval === undefined) return;
    clearInterval(this.announceInterval);
    this.announceInterval = undefined;
  }
}
