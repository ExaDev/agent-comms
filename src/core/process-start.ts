/**
 * A marker for when a process started, so a lock that records it tells its holder from an unrelated process that was later given the same pid.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/** Zero-based index of the start time among the fields of /proc/<pid>/stat that follow the parenthesised command name (field 22 of the file, field 3 being the first after the name). */
const PROC_STAT_START_TIME_INDEX = 19;
/** How long the process table listing may take; it reads one entry and returns at once on a healthy host. */
const PS_TIMEOUT_MS = 2000;

/**
 * An opaque string that is the same for as long as the process lives and differs from the marker of any process that started at another time, or undefined when the process does not exist or this host offers no way to read it. Two markers are only compared with each other for equality.
 *
 * Linux reads the kernel's own start time (clock ticks since boot, so it holds across a clock change); elsewhere the process table's start time is read through `ps`, which has whole-second resolution, so a pid reused within the same second as its predecessor is not told apart.
 */
export function processStartMarker(pid: number): string | undefined {
  return process.platform === "linux" ? procStartTime(pid) : psStartTime(pid);
}

function procStartTime(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    // The command name is parenthesised and may itself hold spaces and parentheses, so the fields are counted from the last closing one.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[PROC_STAT_START_TIME_INDEX];
  } catch {
    return undefined;
  }
}

function psStartTime(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PS_TIMEOUT_MS,
    }).trim();
    return out === "" ? undefined : out.replace(/\s+/g, " ");
  } catch {
    return undefined;
  }
}
