/**
 * `agent-comms account invite` and `agent-comms account join` (agent-comms#344): joining a new machine to the account over the mesh (see core/account-join.ts for the flow). Each runs a store of its own for as long as the command runs. An invite is printed to this terminal only, and the command keeps its store up until the invite is redeemed or expires, since invites live only in the issuing store's memory. A join reads the invite at a prompt that does not echo, so it never sits in shell history.
 */

import * as fs from "node:fs";
import type { AccountJoin } from "./core/account-join.js";
import { createBridgeMesh } from "./core/bridge-mesh.js";
import { createMeshErrorReporter } from "./core/error-reporting.js";
import {
  releaseIdentityLock,
  type IdentitySlot,
} from "./core/identity-store.js";
import type { GenerateConnectionCodeOptions } from "./core/connection-code.js";
import type { RedeemConnectionCodeOptions } from "./core/connection-code.js";
import { ConnectionCodeSchema, type ConnectionCode } from "./core/types.js";
import { ACCOUNT_USAGE, type AccountCliIo } from "./account-cli.js";

/** A store started for one invite or join, and its shutdown. */
export interface AccountCliStore {
  account: Pick<AccountJoin, "invite" | "join">;
  close: () => Promise<void>;
}

/** The identity slot harness these commands' own store runs under, apart from every bridge's. */
const ACCOUNT_CLI_HARNESS = "account";

/** Starts a store on this machine's mesh, holding the machine's account, with one hidden agent: that is what gives it a hub session once it trusts the other machine, and a hidden agent is reachable by device id without being listed. */
export async function openMachineAccountStore(): Promise<AccountCliStore> {
  const slot: IdentitySlot = {
    harness: ACCOUNT_CLI_HARNESS,
    cwd: process.cwd(),
  };
  const { store } = await createBridgeMesh(slot);
  store.onError = createMeshErrorReporter();
  await store.init();
  const agent = await store.registerAgent({
    name: ACCOUNT_CLI_HARNESS,
    harness: ACCOUNT_CLI_HARNESS,
    cwd: slot.cwd,
    pid: process.pid,
    visibility: "hidden",
    tags: [],
  });
  return {
    account: store.account,
    close: async () => {
      await store.setAgentOffline(agent.id);
      await store.shutdown();
      releaseIdentityLock(slot);
    },
  };
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;

/** Parses `--name value` pairs, allowing only `allowed` names, each at most once. */
function parseOptions(
  args: readonly string[],
  allowed: readonly string[],
): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (
      name === undefined ||
      !name.startsWith("--") ||
      !allowed.includes(name.slice(2)) ||
      options.has(name.slice(2)) ||
      value === undefined
    ) {
      throw new Error(ACCOUNT_USAGE);
    }
    options.set(name.slice(2), value);
  }
  return options;
}

function ttlMsFrom(minutes: string | undefined): number | undefined {
  if (minutes === undefined) return undefined;
  const parsed = Number(minutes);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `--ttl-minutes must be a whole number of minutes above zero, not ${minutes}`,
    );
  }
  return parsed * MS_PER_MINUTE;
}

async function signingOptions(
  keyFile: string | undefined,
  io: Readonly<AccountCliIo>,
): Promise<
  Pick<GenerateConnectionCodeOptions, "privateKeyArmored" | "passphrase">
> {
  if (keyFile === undefined) return {};
  const privateKeyArmored = fs.readFileSync(keyFile, "utf-8");
  const passphrase = await io.readSecret(
    "PGP key passphrase (press Enter if it has none): ",
  );
  return passphrase === ""
    ? { privateKeyArmored }
    : { privateKeyArmored, passphrase };
}

/** Issues an invite, prints it, and returns once it has been redeemed or has expired. */
export async function inviteToAccount(
  args: readonly string[],
  io: Readonly<AccountCliIo>,
): Promise<void> {
  const options = parseOptions(args, ["ttl-minutes", "sign-key"]);
  const ttlMs = ttlMsFrom(options.get("ttl-minutes"));
  const signing = await signingOptions(options.get("sign-key"), io);
  const store = await io.openStore();
  try {
    const { code, settled } = await store.account.invite({
      ...(ttlMs !== undefined && { ttlMs }),
      ...signing,
    });
    io.log(
      `Account invite, valid until ${code.expiresAt} and for one use. Whoever redeems it takes a full copy of this account, so give it only to your own new machine, out of band, and run \`agent-comms account join\` there. Keep this command running until then.`,
    );
    io.log(JSON.stringify(code));
    const outcome = await settled;
    io.log(
      outcome === "redeemed"
        ? "The invite was redeemed: the new machine now holds this account."
        : "The invite expired unused.",
    );
  } finally {
    await store.close();
  }
}

const NOT_AN_INVITE =
  "That is not an account invite: paste the whole line `agent-comms account invite` printed";

function parseInvite(raw: string): ConnectionCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(NOT_AN_INVITE);
  }
  if (!ConnectionCodeSchema.is(parsed)) {
    throw new Error(NOT_AN_INVITE);
  }
  return parsed;
}

function verifyingOptions(
  options: ReadonlyMap<string, string>,
): RedeemConnectionCodeOptions {
  const keyFile = options.get("public-key");
  const fingerprint = options.get("fingerprint");
  return {
    ...(keyFile !== undefined && {
      publicKeyArmored: fs.readFileSync(keyFile, "utf-8"),
    }),
    ...(fingerprint !== undefined && { expectedFingerprint: fingerprint }),
  };
}

/** Reads an invite at a prompt and makes this machine hold the account it came from. With --label, the issuing machine keeps the label as its own name for this one. */
export async function joinAccount(
  args: readonly string[],
  io: Readonly<AccountCliIo>,
): Promise<void> {
  const options = parseOptions(args, ["public-key", "fingerprint", "label"]);
  const label = options.get("label");
  const joinOptions = {
    ...verifyingOptions(options),
    ...(label !== undefined && { label }),
  };
  const invite = parseInvite(await io.readSecret("Account invite: "));
  const store = await io.openStore();
  try {
    const result = await store.account.join(invite, joinOptions);
    io.log(`This machine now holds account ${result.principal}.`);
    if (result.replacedFile !== undefined) {
      io.log(
        `The account it held before was moved to ${result.replacedFile}; it is still the only key that can revoke what that account issued.`,
      );
    }
    io.log("Restart running agent-comms bridges so they use it.");
  } finally {
    await store.close();
  }
}
