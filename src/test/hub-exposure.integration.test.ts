/**
 * What a store puts on the relay hub, seen the way anyone connected to a public hub sees it (agent-comms#293): a bare client that trusts nobody and records every advert the hub broadcasts to it. A store holds a hub session only when its machine trusts someone and its agent is not a ghost, and advertises its agent, presence, hosted rooms and versions only when that agent is visible, so a store with nothing to say to another machine puts nothing on the hub, and a hidden agent only its device advert.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import {
  AGENT_CARD_GOSSIP_KEY,
  AGENT_SELF_GOSSIP_KEY,
  HOSTED_ROOMS_GOSSIP_KEY,
  PRESENCE_GOSSIP_KEY,
  PUBLIC_ROOMS_GOSSIP_KEY,
} from "../core/gossip-extensions.js";
import type { Visibility } from "../core/types.js";
import {
  observeHub,
  realHubOverWs,
  TeardownStack,
  waitForCondition,
} from "./hub-helpers.js";
import { wireTestTransport } from "./test-transport.js";

/** A device-id is a 64-character lowercase hex SHA-256 digest. */
const DEVICE_ID_HEX_LENGTH = 64;

let nextPort = 24_300;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

/** Short enough that several gossip rounds fit inside a test's own watch window. */
const FAST_GOSSIP_INTERVAL_MS = 50;

/** How long a store that must stay silent is watched for: many gossip rounds and several link polls. */
const SILENCE_WATCH_MS = 1500;

const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

/** A store on its own machine that dials hubUrl, with an agent of the given visibility registered when one is asked for. */
async function startStore(
  hubUrl: string,
  visibility: Visibility | undefined,
): Promise<MeshStore> {
  const store = new MeshStore({ coordinatorPort: freshPort(), hubUrl });
  await wireTestTransport(store, {
    presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
  });
  await store.init();
  cleanups.push(async () => store.shutdown());
  if (visibility !== undefined) {
    await store.registerAgent({
      name: `${visibility}-agent`,
      harness: "test",
      cwd: `/test/${visibility}`,
      pid: process.pid,
      visibility,
      tags: [],
    });
  }
  return store;
}

/** The working directory startStore registers a visible agent with. */
const VISIBLE_CWD = "/test/visible";

/** Trusts an arbitrary remote device, which is all it takes for a store to have something to say to another machine. */
const SOME_REMOTE_DEVICE = "f".repeat(DEVICE_ID_HEX_LENGTH);

describe("what a store puts on the hub", () => {
  it("puts nothing on the hub while its machine trusts nobody, not even its device id", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const observer = await observeHub(hub.url);
    cleanups.push(observer.close);

    const store = await startStore(hub.url, "visible");
    await sleep(SILENCE_WATCH_MS);

    expect(observer.advertsFor(store.peerId)).toEqual([]);
    expect(hub.connectionCount()).toBe(1);
  });

  it("puts nothing on the hub for a store with no agent yet, even when its machine trusts someone", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const observer = await observeHub(hub.url);
    cleanups.push(observer.close);

    const store = await startStore(hub.url, undefined);
    store.addTrustedGateway(SOME_REMOTE_DEVICE);
    await sleep(SILENCE_WATCH_MS);

    expect(observer.advertsFor(store.peerId)).toEqual([]);
  });

  it("puts nothing on the hub for a ghost agent, even when its machine trusts someone", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const observer = await observeHub(hub.url);
    cleanups.push(observer.close);

    const store = await startStore(hub.url, "ghost");
    store.addTrustedGateway(SOME_REMOTE_DEVICE);
    await sleep(SILENCE_WATCH_MS);

    expect(observer.advertsFor(store.peerId)).toEqual([]);
    expect(hub.connectionCount()).toBe(1);
  });

  it("puts only its device advert on the hub for a hidden agent: no agent, presence or hosted rooms", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const observer = await observeHub(hub.url);
    cleanups.push(observer.close);

    const store = await startStore(hub.url, "hidden");
    store.addTrustedGateway(SOME_REMOTE_DEVICE);
    await waitForCondition(() => observer.advertsFor(store.peerId).length > 0);
    await sleep(SILENCE_WATCH_MS);

    for (const advert of observer.advertsFor(store.peerId)) {
      expect(advert[AGENT_SELF_GOSSIP_KEY]).toBeUndefined();
      expect(advert[PRESENCE_GOSSIP_KEY]).toBeUndefined();
      expect(advert[HOSTED_ROOMS_GOSSIP_KEY]).toBeUndefined();
    }
  });

  it("advertises a visible agent's card, presence and public room names once its machine trusts someone, and nothing about where it runs", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const observer = await observeHub(hub.url);
    cleanups.push(observer.close);

    const store = await startStore(hub.url, "visible");
    // A project room whose description names the working directory, hosted by this store: the very thing that gave the directory away through room/hosted.
    await store.createRoom({
      name: "project",
      type: "public",
      owner: store.peerId,
      description: `Project room for ${VISIBLE_CWD}`,
    });
    await store.createRoom({
      name: "confidential",
      type: "private",
      owner: store.peerId,
      description: "not for the hub",
    });
    store.addTrustedGateway(SOME_REMOTE_DEVICE);

    await waitForCondition(() =>
      observer
        .advertsFor(store.peerId)
        .some(
          (advert) =>
            advert[AGENT_CARD_GOSSIP_KEY] !== undefined &&
            advert[PRESENCE_GOSSIP_KEY] !== undefined &&
            advert[PUBLIC_ROOMS_GOSSIP_KEY] !== undefined,
        ),
    );
    await sleep(SILENCE_WATCH_MS);

    const adverts = observer.advertsFor(store.peerId);
    for (const advert of adverts) {
      expect(advert[AGENT_SELF_GOSSIP_KEY]).toBeUndefined();
      expect(advert[HOSTED_ROOMS_GOSSIP_KEY]).toBeUndefined();
      const publicRooms: unknown = advert[PUBLIC_ROOMS_GOSSIP_KEY];
      if (publicRooms !== undefined) {
        // Only the public room, and only where it is and what it is called: not the private one, not any description.
        expect(publicRooms).toEqual([
          { path: `${store.peerId}/project`, name: "project" },
        ]);
      }
      const card: unknown = advert[AGENT_CARD_GOSSIP_KEY];
      if (card !== undefined) {
        expect(
          Object.keys(card as object)
            .filter((key) => key !== "membership")
            .sort(),
        ).toEqual(["harness", "name"]);
      }
      // Nothing anywhere in what the hub hands out may contain the directory, whichever field it would ride in.
      expect(
        JSON.stringify(advert, (_key, value: unknown) =>
          value instanceof Uint8Array ? Array.from(value) : value,
        ),
      ).not.toContain(VISIBLE_CWD);
    }
  });

  it("joins the hub as soon as trust is added and leaves it when the trust is withdrawn", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const observer = await observeHub(hub.url);
    cleanups.push(observer.close);
    const store = await startStore(hub.url, "visible");
    expect(hub.connectionCount()).toBe(1);

    store.addTrustedGateway(SOME_REMOTE_DEVICE);
    await waitForCondition(() => hub.connectionCount() === 2);

    store.removeTrustedGateway(SOME_REMOTE_DEVICE);
    await waitForCondition(() => hub.connectionCount() === 1);
  });
});
