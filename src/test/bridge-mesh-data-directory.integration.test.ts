import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import {
  createBridgeMesh,
  createBridgeMeshFromIdentity,
  createBridgeMeshSync,
  createBridgeMeshSyncFromIdentity,
  type BridgeMesh,
  type BridgeMeshOptions,
  type BridgeMeshSync,
} from "../core/bridge-mesh.js";
import {
  loadIdentityForFront,
  loadRoomTokens,
  probeSlotOwner,
  releaseIdentityLock,
  type IdentitySlot,
} from "../core/identity-store.js";
import { DATA_DIR_ENV_VAR } from "../core/data-directory.js";
import {
  loadOrCreateUserIdentity,
  loadUserDisplayName,
} from "../core/user-identity.js";
import {
  loadMachineDisplayName,
  loadOrCreateMachineIdentity,
} from "../core/machine-identity.js";
import { openAccountLedger } from "../core/account-ledger-store.js";
import { runAccountCommand, type AccountCliIo } from "../account-cli.js";
import {
  freeLocalPort,
  TeardownStack,
  unreachableHubUrl,
} from "./hub-helpers.js";
import { waitFor } from "./test-transport.js";

let root: string;
let defaultDir: string;
const cleanups = new TeardownStack();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-comms-data-dir-"));
  defaultDir = path.join(root, "environment-default");
  vi.stubEnv(DATA_DIR_ENV_VAR, defaultDir);
});

afterEach(async () => {
  try {
    await cleanups.run();
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function meshOptions(): Promise<BridgeMeshOptions> {
  return {
    coordinatorPort: await freeLocalPort(),
    firstContactPort: await freeLocalPort(),
    hubUrl: await unreachableHubUrl(),
    fetchLatestVersion: async () => undefined,
  };
}

function track(mesh: BridgeMesh, slot: Readonly<IdentitySlot>): BridgeMesh {
  cleanups.push(async () => {
    await mesh.store.shutdown();
    releaseIdentityLock(slot);
  });
  return mesh;
}

async function attach(mesh: BridgeMeshSync): Promise<BridgeMesh> {
  await mesh.attachIdentity();
  return mesh;
}

const factories = [
  { name: "createBridgeMesh", create: createBridgeMesh, ownsLock: true },
  {
    name: "createBridgeMeshSync",
    create: async (
      slot: Readonly<IdentitySlot>,
      options: Readonly<BridgeMeshOptions>,
    ) => attach(createBridgeMeshSync(slot, options)),
    ownsLock: true,
  },
  {
    name: "createBridgeMeshFromIdentity",
    create: async (
      slot: Readonly<IdentitySlot>,
      options: Readonly<BridgeMeshOptions>,
    ) =>
      createBridgeMeshFromIdentity(loadIdentityForFront(slot), slot, options),
    ownsLock: false,
  },
  {
    name: "createBridgeMeshSyncFromIdentity",
    create: async (
      slot: Readonly<IdentitySlot>,
      options: Readonly<BridgeMeshOptions>,
    ) =>
      attach(
        createBridgeMeshSyncFromIdentity(
          loadIdentityForFront(slot),
          slot,
          options,
        ),
      ),
    ownsLock: false,
  },
];

/** File contents, not just names, so a write into an existing installation is detected. */
function snapshot(dir: string): [string, string][] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry): [string, string] => {
      const file = path.join(entry.parentPath, entry.name);
      return [
        path.relative(dir, file),
        fs.readFileSync(file).toString("base64"),
      ];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

it.each(factories)(
  "$name keeps keys, names, trust and grants in dataDir",
  async ({ create, ownsLock }) => {
    loadOrCreateUserIdentity();
    loadOrCreateMachineIdentity();
    const before = snapshot(defaultDir);
    const dataDir = path.join(root, "application");
    const dir = path.join(root, "legacy-slot");
    const slot: IdentitySlot = {
      harness: "data-dir-test",
      cwd: root,
      dataDir,
      dir,
    };
    const { store } = track(await create(slot, await meshOptions()), slot);

    expect(probeSlotOwner(slot)).toBe(ownsLock ? process.pid : undefined);
    expect(fs.existsSync(dir)).toBe(false);
    expect(store.getUserPrincipalId()).toBeDefined();
    expect(store.getMachineId()).toBeDefined();
    await store.naming.setPrincipalName("application account");
    await store.naming.setMachineName("application machine");
    store.naming.setPetname(store.peerId, "application device");
    store.addTrustedGateway(store.peerId);
    await store.admitAgentForDm(store.peerId);
    await store.generateConnectionCode();

    expect(loadUserDisplayName({ dir: dataDir })).toBe("application account");
    expect(loadMachineDisplayName({ dir: dataDir })).toBe(
      "application machine",
    );
    const files = snapshot(dataDir).map(([file]) => file);
    expect(files).toContain("user-identity.json");
    expect(files).toContain("machine-identity.json");
    expect(files).toContain("gateway-trust.json");
    expect(files).toContain("petnames.json");
    expect(files.some((file) => file.startsWith("identity-"))).toBe(true);
    expect(files.some((file) => file.startsWith("account-ledger-"))).toBe(true);
    expect(files.some((file) => file.startsWith("connection-codes-"))).toBe(
      true,
    );
    expect(snapshot(defaultDir)).toEqual(before);
  },
);

it("separate data directories give the same slot separate device, account and machine keys", async () => {
  const aSlot = {
    harness: "same-slot",
    cwd: root,
    dataDir: path.join(root, "a"),
  };
  const bSlot = { ...aSlot, dataDir: path.join(root, "b") };
  const a = track(
    await createBridgeMesh(aSlot, await meshOptions()),
    aSlot,
  ).store;
  const b = track(
    await createBridgeMesh(bSlot, await meshOptions()),
    bSlot,
  ).store;
  expect(a.peerId).not.toBe(b.peerId);
  expect(a.getUserPrincipalId()).not.toBe(b.getUserPrincipalId());
  expect(a.getMachineId()).not.toBe(b.getMachineId());
  expect(fs.existsSync(defaultDir)).toBe(false);
});

it("the environment selects the shared folder, while legacy slot.dir keeps its existing scope", async () => {
  const defaultSlot = { harness: "environment", cwd: root };
  const a = track(
    await createBridgeMesh(defaultSlot, await meshOptions()),
    defaultSlot,
  ).store;
  const dir = path.join(root, "legacy-slot");
  const legacySlot = { harness: "legacy", cwd: root, dir };
  const b = track(
    await createBridgeMesh(legacySlot, await meshOptions()),
    legacySlot,
  ).store;
  expect(b.getUserPrincipalId()).toBe(a.getUserPrincipalId());
  expect(b.getMachineId()).toBe(a.getMachineId());
  expect(fs.existsSync(path.join(dir, "user-identity.json"))).toBe(false);
  expect(snapshot(dir).some(([file]) => file.startsWith("identity-"))).toBe(
    true,
  );
  expect(
    snapshot(defaultDir).some(([file]) =>
      file.startsWith("identity-environment"),
    ),
  ).toBe(true);
});

it("account export and import use the environment's directory", async () => {
  const bundle = path.join(root, "account.bundle");
  const io: AccountCliIo = {
    readSecret: async () => "A private test account passphrase",
    log: () => undefined,
    env: {},
    openStore: async () => {
      throw new Error("export/import must not start a mesh");
    },
  };
  await runAccountCommand(["export", bundle], io);
  const original = fs.readFileSync(
    path.join(defaultDir, "user-identity.json"),
    "utf-8",
  );
  const importedDir = path.join(root, "imported");
  vi.stubEnv(DATA_DIR_ENV_VAR, importedDir);
  await runAccountCommand(["import", bundle], io);
  expect(loadOrCreateUserIdentity({ dir: importedDir }).deviceId).toEqual(
    loadOrCreateUserIdentity({ dir: defaultDir }).deviceId,
  );
  expect(
    fs.readFileSync(path.join(defaultDir, "user-identity.json"), "utf-8"),
  ).toBe(original);
});

it("two real peers share an account and exchange a room message; restart keeps keys, room tokens, trust and grants", async () => {
  const dataDir = path.join(root, "shared");
  const slotA = { harness: "peer-a", cwd: root, dataDir };
  const slotB = { ...slotA, harness: "peer-b" };
  const options = await meshOptions();
  const a = track(await createBridgeMesh(slotA, options), slotA).store;
  const b = track(await createBridgeMesh(slotB, options), slotB).store;
  expect(a.peerId).not.toBe(b.peerId);
  expect(a.getUserPrincipalId()).toBe(b.getUserPrincipalId());
  expect(a.getMachineId()).toBe(b.getMachineId());
  await a.init();
  await b.init();
  for (const [store, slot] of [
    [a, slotA],
    [b, slotB],
  ] as const) {
    await store.registerAgent({
      name: slot.harness,
      harness: slot.harness,
      cwd: root,
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
  }
  const room = await a.createRoom({
    name: "private-folder-room",
    type: "public",
    owner: a.peerId,
    description: "Directory smoke test",
  });
  const joined = b.joinRoom(room.id, b.peerId);
  await waitFor(
    () =>
      a
        .listPendingRoomJoins()
        .some((request) => request.requesterId === b.peerId),
    "the room owner's pending join",
  );
  a.acceptRoomJoin(room.id, b.peerId);
  await joined;
  const received: string[] = [];
  b.addDeliveryListener((_id, event) => {
    if (event.type === "room_message") received.push(event.message.content);
  });
  await a.sendRoomMessage(room.id, a.peerId, "isolated folder message");
  await waitFor(
    () => received.includes("isolated folder message"),
    "the room message over the real mesh",
  );
  const tokens = loadRoomTokens(slotB);
  expect(tokens[room.id]).toBeDefined();
  await b.admitAgentForDm(a.peerId);
  b.addTrustedGateway(a.peerId);
  b.naming.setPetname(a.peerId, "first peer");
  const oldId = b.peerId;
  const oldPrincipal = b.getUserPrincipalId();
  const oldMachine = b.getMachineId();
  await b.shutdown();
  releaseIdentityLock(slotB);
  const restarted = track(await createBridgeMesh(slotB, options), slotB).store;
  expect(restarted.peerId).toBe(oldId);
  expect(restarted.getUserPrincipalId()).toBe(oldPrincipal);
  expect(restarted.getMachineId()).toBe(oldMachine);
  expect(loadRoomTokens(slotB)).toEqual(tokens);
  expect(restarted.listTrustedGateways()).toContain(a.peerId);
  expect(restarted.naming.listPetnames().get(a.peerId)).toBe("first peer");
  const ledger = await openAccountLedger({
    userIdentityOptions: { dir: dataDir },
    userIdentity: loadOrCreateUserIdentity({ dir: dataDir }),
    clock: createSystemClock(),
  });
  expect(await ledger.outstandingGrants("dm", a.peerId)).toHaveLength(1);
  await restarted.revokeAgentDmAccess(a.peerId);
  expect(await ledger.outstandingGrants("dm", a.peerId)).toEqual([]);
  expect(fs.existsSync(defaultDir)).toBe(false);
});
