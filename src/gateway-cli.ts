/**
 * `agent-comms gateway redeem` (the human route for a connection code): trusts the device a connection code vouches for, after a person has seen which device it is and whether the code is signed, and has typed `yes`.
 *
 * The `gateway_redeem_connection_code` tool refuses an unsigned code, and a signed one it is given no key or fingerprint for, because the tool's caller is an agent and an agent can be steered by text another agent wrote. Redeeming such a code is a decision about whom this machine trusts, so it is a command a person runs: it needs a terminal on stdin, never reads the code from an argument or the environment, and acts only on an explicit yes. A signed code can still be verified here with `--public-key` and `--fingerprint`, exactly as `account join` does.
 */

import * as fs from "node:fs";
import {
  ConnectionCodeLedger,
  type RedeemConnectionCodeOptions,
  type RedeemConnectionCodeResult,
} from "./core/connection-code.js";
import { GatewayTrust } from "./core/gateway-trust.js";
import type { IdentitySlot } from "./core/identity-store.js";
import { ConnectionCodeSchema, type ConnectionCode } from "./core/types.js";

export const GATEWAY_USAGE =
  "Usage: agent-comms gateway redeem [--public-key <file>] [--fingerprint <hex>]";

/** Where a person-redeemed code's single-use record is kept: a slot of its own, so it never shares a record with a bridge's. The trusted set it adds to is the data directory's one shared file, which every bridge reads. */
const GATEWAY_CLI_SLOT: Readonly<IdentitySlot> = {
  harness: "gateway-cli",
  cwd: "redeem",
};

/** What the command needs of its surroundings, so a test can run it without a terminal. */
export interface GatewayCliIo {
  /** Whether stdin is a terminal. */
  stdinIsTerminal: boolean;
  /** Reads a line without echoing it, as the code is pasted. */
  readSecret: (prompt: string) => Promise<string>;
  /** Asks a question and reads the answer, as typed. */
  ask: (question: string) => Promise<string>;
  log: (line: string) => void;
  /** Redeems the code and trusts its device. Defaults to the machine's own ledger and trust file. */
  redeem?: (
    candidate: Readonly<ConnectionCode>,
    options: Readonly<RedeemConnectionCodeOptions>,
  ) => Promise<RedeemConnectionCodeResult>;
}

const NOT_A_CODE =
  "That is not a connection code: paste the whole JSON line the other machine printed";

function parseCode(raw: string): ConnectionCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(NOT_A_CODE);
  }
  if (!ConnectionCodeSchema.is(parsed)) throw new Error(NOT_A_CODE);
  return parsed;
}

function parseOptions(args: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (
      name === undefined ||
      !["--public-key", "--fingerprint"].includes(name) ||
      options.has(name) ||
      value === undefined
    ) {
      throw new Error(GATEWAY_USAGE);
    }
    options.set(name, value);
  }
  return options;
}

/** Redeems against this machine's own single-use record and trusted set. */
async function redeemOnThisMachine(
  candidate: Readonly<ConnectionCode>,
  options: Readonly<RedeemConnectionCodeOptions>,
): Promise<RedeemConnectionCodeResult> {
  const result = await new ConnectionCodeLedger(GATEWAY_CLI_SLOT).redeem(
    candidate,
    options,
  );
  new GatewayTrust({ location: GATEWAY_CLI_SLOT }).add(result.deviceId);
  return result;
}

/**
 * Runs `gateway redeem`. Throws, with a message fit to show the person, when stdin is not a terminal, when the arguments or the pasted text are wrong, when the person does not answer yes (nothing is trusted or recorded), and for every reason a connection code can be refused. Prints the device the code vouches for, and whether it is signed, before it asks.
 */
export async function runGatewayCommand(
  args: readonly string[],
  io: Readonly<GatewayCliIo>,
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "redeem") throw new Error(GATEWAY_USAGE);
  const options = parseOptions(rest);
  if (!io.stdinIsTerminal) {
    throw new Error(
      "agent-comms gateway redeem needs a terminal: it asks you to confirm which device to trust, and nothing piped into it can answer for you",
    );
  }
  const candidate = parseCode(await io.readSecret("Connection code: "));
  const keyFile = options.get("--public-key");
  const fingerprint = options.get("--fingerprint");
  const signed = candidate.signature !== undefined;
  io.log(`This code vouches for device ${candidate.deviceId}.`);
  io.log(
    signed
      ? "It is signed. The signature is checked against the key or fingerprint you gave, if you gave one."
      : "It is NOT signed. Nothing proves who wrote it: the device above is whatever the text says.",
  );
  const answer = await io.ask(
    `Trust device ${candidate.deviceId} on this machine? Type yes to continue: `,
  );
  if (answer.trim().toLowerCase() !== "yes") {
    throw new Error("Not confirmed: nothing was trusted");
  }
  const result = await (io.redeem ?? redeemOnThisMachine)(candidate, {
    ...(keyFile !== undefined && {
      publicKeyArmored: fs.readFileSync(keyFile, "utf-8"),
    }),
    ...(fingerprint !== undefined && { expectedFingerprint: fingerprint }),
  });
  io.log(
    `Trusted device ${result.deviceId}${result.fingerprint === undefined ? " (unsigned code)" : ` (signature verified, signing key fingerprint ${result.fingerprint})`}. Running bridges pick it up on their next check.`,
  );
}
