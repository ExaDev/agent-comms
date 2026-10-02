/**
 * Integration tests for joining a machine to an account (agent-comms#344), over a real hub between separate machines: the account issues an invite, a new machine redeems it and then holds the account, a machine that already trusted the account's principal covers the new machine's devices with no step of its own, and the issuer answers each invite only once.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "wire-mesh-core/ports/clock";
import { DEFAULT_CONNECTION_CODE_TTL_MS } from "../core/connection-code.js";
import { MeshStore } from "../core/mesh-store.js";
import { loadUserDisplayName } from "../core/user-identity.js";
import type { Visibility } from "../core/types.js";
import { runAccountCommand, type AccountCliIo } from "../account-cli.js";
import { freeLocalPort, realHubOverWs, TeardownStack } from "./hub-helpers.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

/** A device-id is a 64-character lowercase hex SHA-256 digest. */
const DEVICE_ID_HEX_LENGTH = 64;
/** Short enough that a gossip re-advertisement fires within a test's own wait budget. */
const FAST_GOSSIP_INTERVAL_MS = 50;

const cleanups = new TeardownStack();
const dirs: string[] = [];
/** Each machine's user identity directory, by its store. */
const userDirs = new WeakMap<MeshStore, string>();

afterEach(async () => {
  await cleanups.run();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function userDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "account-join-user-"));
  dirs.push(dir);
  return dir;
}

function userDirOf(store: MeshStore): string {
  const dir = userDirs.get(store);
  if (dir === undefined) throw new Error("store was not made by machine()");
  return dir;
}

/** A clock a test moves forward by hand, starting at the real time. */
function steppingClock(): Clock & { advance: (ms: number) => void } {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance: (ms) => {
      offset += ms;
    },
  };
}

/** One machine: its own local mesh, its own user identity, one agent (visible unless told otherwise) so it holds a hub session once it trusts anyone. */
async function machine(
  hubUrl: string,
  name: string,
  options: Readonly<{ clock?: Clock; visibility?: Visibility }> = {},
): Promise<MeshStore> {
  const store = new MeshStore({
    coordinatorPort: await freeLocalPort(),
    hubUrl,
  });
  const { clock, visibility = "visible" } = options;
  const dir = userDir();
  userDirs.set(store, dir);
  await wireTestTransport(store, {
    presenceReadvertiseIntervalMs: FAST_GOSSIP_INTERVAL_MS,
    userIdentityOptions: { dir },
    machineIdentityOptions: { dir },
    clock,
  });
  await store.init();
  cleanups.push(async () => store.shutdown());
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility,
    tags: [],
  });
  return store;
}

/** The `account` commands' io for a test, running them against `store` and collecting what they print. */
function commandIo(
  store: MeshStore,
  readSecret: (prompt: string) => Promise<string>,
  log: (line: string) => void,
): AccountCliIo {
  return {
    readSecret,
    log,
    env: {},
    openStore: async () =>
      Promise.resolve({
        account: store.account,
        close: async () => Promise.resolve(),
      }),
  };
}

function principalOf(store: MeshStore): string {
  const principal = store.getUserPrincipalId();
  if (principal === undefined) throw new Error("store has no identity yet");
  return principal;
}

describe("account join", () => {
  it("makes a new machine hold the account, and a machine trusting the account covers its devices", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const account = await machine(hub.url, "account-home");
    const newMachine = await machine(hub.url, "new-machine");
    const observer = await machine(hub.url, "observer");
    const accountPrincipal = principalOf(account);
    expect(principalOf(newMachine)).not.toBe(accountPrincipal);
    observer.addTrustedGatewayPrincipal(accountPrincipal);
    account.addTrustedGatewayPrincipal(principalOf(observer));

    const invite = await account.account.invite();
    const joined = await newMachine.account.join(invite.code);

    expect(await invite.settled).toBe("redeemed");
    expect(joined.principal).toBe(accountPrincipal);
    expect(principalOf(newMachine)).toBe(accountPrincipal);
    expect(joined.replacedFile).toBeDefined();
    await waitFor(async () => {
      const agents = await observer.listAgents(observer.peerId);
      return agents.some((agent) => agent.id === newMachine.peerId);
    }, "the observer to list the new machine's agent");
    expect(observer.listVerifiedMembers()).toContainEqual({
      device: newMachine.peerId,
      issuer: accountPrincipal,
      kind: "principal",
    });
  });

  it("hands the account's name to the machine that joins it", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const account = await machine(hub.url, "account-home");
    const newMachine = await machine(hub.url, "new-machine");
    await account.naming.setPrincipalName("work account");

    const invite = await account.account.invite();
    await newMachine.account.join(invite.code);

    expect(loadUserDisplayName({ dir: userDirOf(newMachine) })).toBe(
      "work account",
    );
  });

  it("keeps the label given on join as the issuing machine's petname for the joining machine", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const account = await machine(hub.url, "account-home");
    const newMachine = await machine(hub.url, "new-machine");
    const newMachineId = newMachine.getMachineId();

    const invite = await account.account.invite();
    await newMachine.account.join(invite.code, { label: "studio mac" });

    expect(account.naming.listPetnames().get(newMachineId ?? "")).toBe(
      "studio mac",
    );
    expect(newMachine.naming.listPetnames().size).toBe(0);
  });

  it("refuses an unusable label before redeeming anything, leaving the invite for another try", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const account = await machine(hub.url, "account-home");
    const newMachine = await machine(hub.url, "new-machine");
    const own = principalOf(newMachine);

    const invite = await account.account.invite();
    await expect(
      newMachine.account.join(invite.code, { label: "bad\u001b[2Jlabel" }),
    ).rejects.toMatchObject({ code: "INVALID_NAME" });

    expect(newMachine.gatewayTrust.isTrusted(account.peerId)).toBe(false);
    expect(principalOf(newMachine)).toBe(own);
    await newMachine.account.join(invite.code, { label: "studio mac" });
    expect(principalOf(newMachine)).toBe(principalOf(account));
  });

  it("refuses a join request whose label breaks the rules without spending the invite, even from a peer that skips its own check", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const account = await machine(hub.url, "account-home");
    const invite = await account.account.invite();
    const request = async (params: Record<string, unknown>) =>
      account.account.handleJoinRequest({
        requestId: 1,
        command: {
          verb: "account:join",
          params: { verb: "account.join", code: invite.code.code, ...params },
        },
        scope: { kind: "node" },
        respond: async () => Promise.resolve(),
      });

    expect(
      await request({ label: "x", machine: "not-a-device-id" }),
    ).toMatchObject({ result: "error", code: "invalid_label" });
    expect(
      await request({
        label: "bad\u001bname",
        machine: "a".repeat(DEVICE_ID_HEX_LENGTH),
      }),
    ).toMatchObject({ result: "error", code: "invalid_label" });
    expect(
      await request({ machine: "a".repeat(DEVICE_ID_HEX_LENGTH) }),
    ).toMatchObject({
      result: "error",
      code: "invalid_label",
    });
    expect(account.naming.listPetnames().size).toBe(0);
    expect(await request({})).toMatchObject({ result: "ok" });
  });

  it("answers an invite once, so a second machine redeeming the same invite is refused", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const account = await machine(hub.url, "account-home");
    const first = await machine(hub.url, "first");
    const second = await machine(hub.url, "second");
    const secondPrincipal = principalOf(second);

    const invite = await account.account.invite();
    await first.account.join(invite.code);

    await expect(second.account.join(invite.code)).rejects.toMatchObject({
      code: "INVITE_REFUSED",
    });
    expect(principalOf(second)).toBe(secondPrincipal);
    // Redeeming trusted the issuing device only so the key request could reach it; the refused join withdraws that again.
    expect(second.gatewayTrust.isTrusted(account.peerId)).toBe(false);
  });

  it("refuses an invite once the issuer's clock passes its expiry, and settles it as expired", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const clock = steppingClock();
    const account = await machine(hub.url, "account-home", { clock });
    const late = await machine(hub.url, "late");
    const latePrincipal = principalOf(late);

    const invite = await account.account.invite();
    clock.advance(DEFAULT_CONNECTION_CODE_TTL_MS);

    await expect(late.account.join(invite.code)).rejects.toMatchObject({
      code: "INVITE_REFUSED",
    });
    expect(await invite.settled).toBe("expired");
    expect(principalOf(late)).toBe(latePrincipal);
  });

  it("refuses to issue an invite valid for longer than the cap", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const account = await machine(hub.url, "account-home");

    await expect(
      account.account.invite({ ttlMs: DEFAULT_CONNECTION_CODE_TTL_MS + 1 }),
    ).rejects.toMatchObject({ code: "INVITE_TTL_TOO_LONG" });
  });

  it("joins through the account invite and join commands, with only hidden agents as the account commands run", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const account = await machine(hub.url, "account-home", {
      visibility: "hidden",
    });
    const newMachine = await machine(hub.url, "new-machine", {
      visibility: "hidden",
    });
    const inviteOutput: string[] = [];
    let printInvite: (line: string) => void = () => undefined;
    const printedInvite = new Promise<string>((resolve) => {
      printInvite = resolve;
    });
    const noSecret = async (): Promise<string> =>
      Promise.reject(new Error("the invite command reads no secret"));

    const inviting = runAccountCommand(
      ["invite"],
      commandIo(account, noSecret, (line) => {
        inviteOutput.push(line);
        if (line.startsWith("{")) printInvite(line);
      }),
    );
    const invite = await printedInvite;
    const joinOutput: string[] = [];
    await runAccountCommand(
      ["join"],
      commandIo(
        newMachine,
        async () => Promise.resolve(invite),
        (line) => {
          joinOutput.push(line);
        },
      ),
    );
    await inviting;

    expect(principalOf(newMachine)).toBe(principalOf(account));
    expect(joinOutput[0]).toBe(
      `This machine now holds account ${principalOf(account)}.`,
    );
    expect(inviteOutput.at(-1)).toBe(
      "The invite was redeemed: the new machine now holds this account.",
    );
  });

  it("takes --label on account join and the issuer keeps it as its name for the new machine", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const account = await machine(hub.url, "account-home", {
      visibility: "hidden",
    });
    const newMachine = await machine(hub.url, "new-machine", {
      visibility: "hidden",
    });
    let printInvite: (line: string) => void = () => undefined;
    const printedInvite = new Promise<string>((resolve) => {
      printInvite = resolve;
    });
    const noSecret = async (): Promise<string> =>
      Promise.reject(new Error("the invite command reads no secret"));

    const inviting = runAccountCommand(
      ["invite"],
      commandIo(account, noSecret, (line) => {
        if (line.startsWith("{")) printInvite(line);
      }),
    );
    const invite = await printedInvite;
    await runAccountCommand(
      ["join", "--label", "studio mac"],
      commandIo(
        newMachine,
        async () => Promise.resolve(invite),
        () => undefined,
      ),
    );
    await inviting;

    expect(
      account.naming.listPetnames().get(newMachine.getMachineId() ?? ""),
    ).toBe("studio mac");
  });

  it("refuses an account join given something that is not an invite", async () => {
    const hub = await realHubOverWs();
    cleanups.push(hub.close);
    const newMachine = await machine(hub.url, "new-machine");
    const before = principalOf(newMachine);

    await expect(
      runAccountCommand(
        ["join"],
        commandIo(
          newMachine,
          async () => Promise.resolve('{"code":"x"}'),
          () => undefined,
        ),
      ),
    ).rejects.toThrow(/not an account invite/);
    expect(principalOf(newMachine)).toBe(before);
  });
});
