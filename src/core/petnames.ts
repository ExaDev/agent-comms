/**
 * Petnames (agent-comms#345): the viewer's own labels for device-ids, the third naming tier beside a subject's self-asserted name and the short id. A petname lives only in the viewer's own storage and is never gossiped, never put in an advert and never sent to a peer, which is why it needs no trust decision and has no collision problem: it is nobody's claim but yours.
 *
 * Constructed with an identity location, the map is one JSON file per identity directory (~/.agent-comms/petnames.json by default), shared by every bridge the viewer runs on the machine, like the gateway trust file, and read afresh on every call, so a label set in one bridge is seen by the others at once. Without a location it is in memory only, which is what most tests use.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_DISPLAY_NAME_LENGTH, parseDisplayName } from "./display-name.js";
import { CommsError } from "./store.js";

/** Owner-only read and write: what a person calls their contacts is theirs. */
const PETNAMES_FILE_MODE = 0o600;
/** Owner-only directory, matching identity-store.ts's own base directory. */
const PETNAMES_DIR_MODE = 0o700;

export interface PetnamesLocation {
  /** Directory override; defaults to ~/.agent-comms. */
  dir?: string | undefined;
}

function isPetnameRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((label) => typeof label === "string");
}

export class Petnames {
  private readonly file: string | undefined;
  private readonly memory = new Map<string, string>();

  constructor(location?: Readonly<PetnamesLocation>) {
    this.file =
      location === undefined
        ? undefined
        : path.join(
            location.dir ?? path.join(os.homedir(), ".agent-comms"),
            "petnames.json",
          );
  }

  /** Every label the viewer has set, keyed by lowercase device-id. */
  list(): Map<string, string> {
    if (this.file === undefined) return new Map(this.memory);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"));
    } catch {
      // No file yet, or one that is unreadable or not JSON: nothing is labelled, the same treatment loadGatewayTrust gives its file.
      return new Map();
    }
    return isPetnameRecord(parsed)
      ? new Map(Object.entries(parsed))
      : new Map<string, string>();
  }

  /** Labels deviceHex (hex, case-insensitive) as name, replacing any earlier label. Throws INVALID_NAME for a name parseDisplayName refuses. Returns the label as stored. */
  set(deviceHex: string, name: string): string {
    const label = parseDisplayName(name);
    if (label === undefined) {
      throw new CommsError(
        `A petname must be non-empty, at most ${String(MAX_DISPLAY_NAME_LENGTH)} characters, and free of control characters.`,
        "INVALID_NAME",
      );
    }
    const labels = this.list();
    labels.set(deviceHex.toLowerCase(), label);
    this.save(labels);
    return label;
  }

  /** Removes deviceHex's label. Returns whether there was one. */
  clear(deviceHex: string): boolean {
    const labels = this.list();
    const removed = labels.delete(deviceHex.toLowerCase());
    if (removed) this.save(labels);
    return removed;
  }

  private save(labels: ReadonlyMap<string, string>): void {
    if (this.file === undefined) {
      this.memory.clear();
      for (const [device, label] of labels) this.memory.set(device, label);
      return;
    }
    fs.mkdirSync(path.dirname(this.file), {
      recursive: true,
      mode: PETNAMES_DIR_MODE,
    });
    // Written to a sibling and renamed into place, so a bridge reading concurrently sees the old map or the new one, never a partial file.
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(
      tmp,
      `${JSON.stringify(Object.fromEntries(labels), null, 2)}\n`,
      { encoding: "utf-8", mode: PETNAMES_FILE_MODE },
    );
    fs.renameSync(tmp, this.file);
  }
}
