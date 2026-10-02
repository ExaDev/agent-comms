/**
 * `agent-comms account <export|import|invite|join>` (agent-comms#344): the deliberate, consented ways the account key that lets one user principal span machines leaves or reaches a machine. Export and import carry the key as a passphrase-sealed bundle (account-bundle.ts), written to a new owner-only file and never printed; the passphrase comes from AGENT_COMMS_ACCOUNT_PASSPHRASE when set, else from a prompt that does not echo. Invite and join carry it over the mesh (account-join-cli.ts). All four are commands a person runs, never agent_comms tool actions, so nothing an agent is told can move the account and no key or invite lands in an agent's transcript.
 */

import * as fs from "node:fs";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  inviteToAccount,
  joinAccount,
  type AccountCliStore,
} from "./account-join-cli.js";
import { openAccountBundle, sealAccountBundle } from "./core/account-bundle.js";
import {
  importAccountKey,
  loadOrCreateUserIdentity,
  readAccountContents,
  type UserIdentityOptions,
} from "./core/user-identity.js";

/** Where a script supplies the passphrase instead of typing it. */
export const ACCOUNT_PASSPHRASE_ENV = "AGENT_COMMS_ACCOUNT_PASSPHRASE";

/** A bundle holds the account key, so its file is readable by its owner alone. */
const BUNDLE_FILE_MODE = 0o600;

export const ACCOUNT_USAGE = [
  "Usage: agent-comms account export <file>",
  "       agent-comms account import <file>",
  "       agent-comms account invite [--ttl-minutes <n>] [--sign-key <file>]",
  "       agent-comms account join [--public-key <file>] [--fingerprint <hex>]",
].join("\n");

export interface AccountCliIo {
  /** Reads a secret (a passphrase, an invite) without echoing it. */
  readSecret: (prompt: string) => Promise<string>;
  log: (line: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  /** Starts a store on this machine's mesh for invite and join, which need one to reach the other machine. */
  openStore: () => Promise<AccountCliStore>;
}

async function passphrase(
  io: Readonly<AccountCliIo>,
  confirm: boolean,
): Promise<string> {
  const fromEnv = io.env[ACCOUNT_PASSPHRASE_ENV];
  if (fromEnv !== undefined) return fromEnv;
  const first = await io.readSecret("Account bundle passphrase: ");
  if (!confirm) return first;
  const second = await io.readSecret("Repeat the passphrase: ");
  if (first !== second) throw new Error("The passphrases do not match");
  return first;
}

function principalOf(identity: Readonly<{ deviceId: Uint8Array }>): string {
  return deviceIdToHex(Uint8Array.from(identity.deviceId));
}

/** Runs one `account` subcommand. Throws with a message fit to show the person on any failure: an unknown subcommand or option, a file that already exists (an export never overwrites), a weak or wrong passphrase, a file that is not a bundle, or an invite that is malformed or refused. */
export async function runAccountCommand(
  args: readonly string[],
  io: Readonly<AccountCliIo>,
  userIdentityOptions: Readonly<UserIdentityOptions> = {},
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "invite") {
    await inviteToAccount(rest, io);
    return;
  }
  if (subcommand === "join") {
    await joinAccount(rest, io);
    return;
  }
  const [file, ...extra] = rest;
  if (file === undefined || extra.length > 0) throw new Error(ACCOUNT_USAGE);
  if (subcommand === "export") {
    const identity = loadOrCreateUserIdentity(userIdentityOptions);
    const bundle = sealAccountBundle(
      readAccountContents(userIdentityOptions),
      await passphrase(io, true),
    );
    fs.writeFileSync(file, `${bundle}\n`, {
      encoding: "utf-8",
      mode: BUNDLE_FILE_MODE,
      flag: "wx",
    });
    io.log(
      `Exported account ${principalOf(identity)} to ${file}. Anyone with this file and its passphrase holds the account; import it on your other machine with \`agent-comms account import ${file}\`, then delete it.`,
    );
    return;
  }
  if (subcommand === "import") {
    const contents = openAccountBundle(
      fs.readFileSync(file, "utf-8"),
      await passphrase(io, false),
    );
    const { identity, replacedFile } = importAccountKey(
      userIdentityOptions,
      contents,
    );
    io.log(`This machine now holds account ${principalOf(identity)}.`);
    if (replacedFile !== undefined) {
      io.log(
        `The account it held before was moved to ${replacedFile}; it is still the only key that can revoke what that account issued.`,
      );
    }
    io.log("Restart running agent-comms bridges so they use it.");
    return;
  }
  throw new Error(ACCOUNT_USAGE);
}

/** What one keypress does to a hidden line being typed. */
export type HiddenLineStep =
  | { kind: "typing"; value: string }
  | { kind: "done"; value: string }
  | { kind: "failed"; message: string };

const END_OF_TEXT = "\u0003";
const END_OF_TRANSMISSION = "\u0004";
const BACKSPACE = "\b";
const DELETE = "\u007f";
/** Every character ordered before this one is a C0 control character, none of which a passphrase can hold. */
const FIRST_PRINTABLE = " ";

/** Applies one character typed at a hidden prompt to the line so far. Enter, or Ctrl-D on a line with something on it, ends the line; Ctrl-C, and Ctrl-D on an empty line, cancel it. Backspace and Delete remove the last character. An escape sequence (an arrow or function key) or any other control character is refused rather than kept, since it would end up in the value invisibly and could never be typed the same way again. */
export function hiddenLineStep(
  value: string,
  character: string,
): HiddenLineStep {
  if (character === "\r" || character === "\n") return { kind: "done", value };
  if (character === END_OF_TEXT)
    return { kind: "failed", message: "Cancelled" };
  if (character === END_OF_TRANSMISSION) {
    return value === ""
      ? { kind: "failed", message: "Cancelled: no input before end of input" }
      : { kind: "done", value };
  }
  if (character === BACKSPACE || character === DELETE) {
    // A terminal's backspace removes one visible character, which may be several code points.
    const graphemes = Array.from(
      new Intl.Segmenter().segment(value),
      ({ segment }) => segment,
    );
    return { kind: "typing", value: graphemes.slice(0, -1).join("") };
  }
  // Escape, which starts every arrow and function key's sequence, is one of these.
  if (character < FIRST_PRINTABLE) {
    return {
      kind: "failed",
      message:
        "Arrow keys, Escape and other control keys cannot be used at this prompt, since they would be kept in it invisibly; start again and type it plainly",
    };
  }
  return { kind: "typing", value: value + character };
}

/** Reads one line from a terminal with echo off, keystroke by keystroke as hiddenLineStep describes. Throws when stdin is not a terminal, since there is nowhere to prompt; a bundle passphrase can then come from ACCOUNT_PASSPHRASE_ENV instead. */
export async function readHiddenLine(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    throw new Error(
      `No terminal to ask on (${prompt.trim()}); a bundle passphrase can be set in ${ACCOUNT_PASSPHRASE_ENV} instead`,
    );
  }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf-8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    // Replaced once the listener exists, so the listener can detach itself.
    let finish = (): void => undefined;
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        const step = hiddenLineStep(value, character);
        if (step.kind === "typing") {
          value = step.value;
          continue;
        }
        finish();
        if (step.kind === "done") resolve(step.value);
        else reject(new Error(step.message));
        return;
      }
    };
    finish = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    stdin.on("data", onData);
  });
}
