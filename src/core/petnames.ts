/**
 * Petnames (agent-comms#345): the viewer's own labels for device-ids, the third naming tier beside a subject's self-asserted name and the short id. A petname lives only in the viewer's own storage and is never gossiped, never put in an advert and never sent to a peer, which is why it needs no trust decision and has no collision problem: it is nobody's claim but yours.
 *
 * Constructed with an identity location, the map is one JSON file per identity directory (~/.agent-comms/petnames.json by default), shared by every bridge the viewer runs on the machine, like the gateway trust file, and read afresh on every call, so a label set in one bridge is seen by the others at once. Without a location it is in memory only, which is what most tests use.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { parseDisplayName } from "./display-name.js";
import { isDeviceIdHex } from "./room-path.js";
import { CommsError, requireDisplayName } from "./store.js";

/** Owner-only read and write: what a person calls their contacts is theirs. */
const PETNAMES_FILE_MODE = 0o600;
/** Owner-only directory, matching identity-store.ts's own base directory. */
const PETNAMES_DIR_MODE = 0o700;

export interface PetnamesLocation {
  /** Directory override; defaults to ~/.agent-comms. */
  dir?: string | undefined;
}

/** Narrows a caught value to Node's own errno-carrying Error subtype, so ENOENT can be told apart from every other read failure without an `as` assertion. */
function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

/** The labels in a parsed petnames file: every entry keyed by a full device-id whose label parseDisplayName accepts, stored as it returns it. Any other entry (a hand-edited typo, a damaged value) is left out on its own, so it never costs the valid labels beside it. Throws when the file's top level is not a JSON object, since then no entry in it can be read at all. */
function labelsIn(file: string, parsed: unknown): Map<string, string> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not hold a JSON object of petnames`);
  }
  const labels = new Map<string, string>();
  for (const [device, raw] of Object.entries(parsed)) {
    if (!isDeviceIdHex(device) || typeof raw !== "string") continue;
    const label = parseDisplayName(raw);
    if (label !== undefined) labels.set(device, label);
  }
  return labels;
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

  /** Every label the viewer has set, keyed by lowercase device-id. A missing file means nothing is labelled yet. An entry that is not a usable label for a full device-id is left out (labelsIn). Throws when the file exists but cannot be read or is not a JSON object, rather than treating it as empty, since the next set or clear would then write that empty map over every label in it. */
  list(): Map<string, string> {
    if (this.file === undefined) return new Map(this.memory);
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf-8");
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return new Map();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${this.file} is not valid JSON`, { cause: err });
    }
    return labelsIn(this.file, parsed);
  }

  /** Labels deviceHex (a full device-id, hex, case-insensitive) as name, replacing any earlier label. Throws INVALID_DEVICE for anything but a full device-id, since a label keyed by a typo or a short id would apply to nothing, and INVALID_NAME for a name parseDisplayName refuses. Returns the label as stored. */
  set(deviceHex: string, name: string): string {
    const device = deviceHex.toLowerCase();
    if (!isDeviceIdHex(device)) {
      throw new CommsError(
        `${JSON.stringify(deviceHex)} is not a device-id: pass the full 64-character hex id.`,
        "INVALID_DEVICE",
      );
    }
    const label = requireDisplayName(name, "A petname");
    const labels = this.list();
    labels.set(device, label);
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
    // Atomic, so a bridge reading concurrently sees the old map or the new one, never a partial file.
    writeFileAtomic(
      this.file,
      `${JSON.stringify(Object.fromEntries(labels), null, 2)}\n`,
      PETNAMES_FILE_MODE,
    );
  }
}
