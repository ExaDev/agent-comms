/**
 * A lock file holding the PID of the process that claimed it: the exclusivity guard for a bridge's identity slot (identity-store.ts) and for appends to the machine's account ledger (ledger-lock.ts). A lock whose recorded process has died is stale and may be taken over, so a holder that crashed never wedges the lock.
 *
 * Every claim writes the PID, a random nonce, the host name and the process's start marker, one per line. The nonce keeps two claims from ever leaving identical content even when a PID is reused. The host and the start marker are what a later claimant checks before judging the holder dead: a lock is taken over only when its holder can be shown dead, so a holder on another host (the directory is shared) and a holder whose PID still names the process that recorded it are left alone, and a PID that now names a process that started at another time is a holder that died. A lock written without them (an older build) is judged by its PID on this host alone. Two hosts that report the same host name are not told apart. Removing a stale lock is the one step that could delete a newer, live claim by mistake (the stale file can be released and re-claimed between reading it and removing it), so it happens only under a second, takeover lock file, and only when the lock still holds exactly the content that was read and judged stale. A live holder releasing its own lock never needs the takeover lock: only its own claim can be at that name while it holds it.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { processStartMarker } from "./process-start.js";
import { CommsError } from "./store.js";

/** Random bytes in each claim's content, enough that two claims never collide. */
const CLAIM_NONCE_BYTES = 16;

/** Whether a process with this pid exists on this host. A process this one is not allowed to signal exists, so it counts as alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isErrorCode(err, "EPERM");
  }
}

/** The host name every claim records, read once. */
const OWN_HOST = os.hostname();
let ownStartMarker: { value: string | undefined } | undefined;

function ownMarker(): string | undefined {
  ownStartMarker ??= { value: processStartMarker(process.pid) };
  return ownStartMarker.value;
}

interface LockHolder {
  pid: number | undefined;
  host: string | undefined;
  start: string | undefined;
}

function holderOf(content: string): LockHolder {
  const [, , host, start] = content.split("\n");
  return {
    pid: pidOf(content),
    host: host === undefined || host === "" ? undefined : host,
    start: start === undefined || start === "" ? undefined : start,
  };
}

/** Whether the holder a lock records cannot be shown dead: it runs on another host, or it runs here and its pid names a live process that started when the claim recorded (or the claim recorded no start). A lock with no readable pid has no holder. */
function holderMayBeAlive(holder: Readonly<LockHolder>): boolean {
  if (holder.pid === undefined) return false;
  if (holder.host !== undefined && holder.host !== OWN_HOST) return true;
  if (!isPidAlive(holder.pid)) return false;
  if (holder.start === undefined) return true;
  const current = processStartMarker(holder.pid);
  return current === undefined || current === holder.start;
}

/** The pid recorded by the lock at lockFile when its holder cannot be shown dead (see holderMayBeAlive), including this process; undefined when there is no lock or its holder is shown dead. */
export function liveLockHolder(lockFile: string): number | undefined {
  const content = readLockContent(lockFile);
  if (content === undefined) return undefined;
  const holder = holderOf(content);
  return holderMayBeAlive(holder) ? holder.pid : undefined;
}

function readLockContent(lockFile: string): string | undefined {
  try {
    return fs.readFileSync(lockFile, "utf-8");
  } catch (err) {
    if (isErrorCode(err, "ENOENT")) return undefined;
    throw err;
  }
}

function pidOf(content: string): number | undefined {
  const pid = Number.parseInt(content.trim(), 10);
  return Number.isInteger(pid) ? pid : undefined;
}

function readLockPid(lockFile: string): number | undefined {
  const content = readLockContent(lockFile);
  return content === undefined ? undefined : pidOf(content);
}

function isErrorCode(err: unknown, code: string): boolean {
  if (!(err instanceof Error) || !("code" in err)) return false;
  return err.code === code;
}

/**
 * Atomically claims `file` for this process via write-temp-then-hardlink: link() is POSIX-guaranteed atomic and exclusive (it fails with EEXIST if the target name already exists), and because the temp file's content is fully written before the link is created, the file's content can never be observed incomplete the instant its name exists, unlike a bare open(O_CREAT|O_EXCL) followed by a separate write(). Returns false when the name is already taken.
 */
function claimExclusive(file: string): boolean {
  const tmpFile = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(
    tmpFile,
    `${[String(process.pid), randomBytes(CLAIM_NONCE_BYTES).toString("hex"), OWN_HOST, ownMarker() ?? ""].join("\n")}\n`,
    "utf-8",
  );
  try {
    fs.linkSync(tmpFile, file);
    return true;
  } catch (err) {
    if (!isErrorCode(err, "EEXIST")) throw err;
    return false;
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

/** Whether content names a holder that can be shown to no longer be holding the lock: one that has died (see holderMayBeAlive), this process itself on this host (which claims a lock only after releasing it, so a lock naming it is left over from before), or no readable PID at all. */
function isStale(content: string): boolean {
  const holder = holderOf(content);
  const isThisProcess =
    holder.pid === process.pid &&
    (holder.host === undefined || holder.host === OWN_HOST);
  return isThisProcess || !holderMayBeAlive(holder);
}

/** Removes `file` if it still holds exactly `content`, the content a caller read and judged stale. Any newer claim has different content (each carries its own nonce), so it is left alone. */
function removeIfUnchanged(file: string, content: string): void {
  if (readLockContent(file) === content) fs.rmSync(file, { force: true });
}

/**
 * Removes lockFile when it still holds `staleContent`, under the takeover lock so that no other process removes a stale lock at the same moment, which is what makes reading the content and removing the file one step. Returns false when another process holds the takeover lock: it is removing the same stale lock, and the caller retries afterwards. A takeover lock left behind by a process that died inside this function is itself removed the same way, without a takeover lock of its own, so two processes clearing that doubly crashed state at the same instant could both go on to remove lockFile; both would still see the same stale content there, so neither removes a live claim.
 */
function removeStaleLock(lockFile: string, staleContent: string): boolean {
  const takeoverFile = `${lockFile}.takeover`;
  if (!claimExclusive(takeoverFile)) {
    const takeover = readLockContent(takeoverFile);
    if (takeover !== undefined && isStale(takeover)) {
      removeIfUnchanged(takeoverFile, takeover);
    }
    return false;
  }
  try {
    removeIfUnchanged(lockFile, staleContent);
    return true;
  } finally {
    fs.rmSync(takeoverFile, { force: true });
  }
}

/**
 * Attempts to claim lockFile for this process. Returns the current holder when a different live process holds it. A lock found missing after a failed claim was released in between, so it is claimed again rather than treated as stale; a stale lock (see isStale) is taken over only through removeStaleLock, so a claim another process made after the stale one was read is never deleted. Losing any of these races to another process reports that process as the holder.
 */
export function tryAcquireLock(
  lockFile: string,
): { acquired: true } | { acquired: false; heldBy: number | undefined } {
  if (claimExclusive(lockFile)) return { acquired: true };
  const content = readLockContent(lockFile);
  if (content !== undefined && !isStale(content)) {
    return { acquired: false, heldBy: pidOf(content) };
  }
  if (content !== undefined && !removeStaleLock(lockFile, content)) {
    return { acquired: false, heldBy: readLockPid(lockFile) };
  }
  if (claimExclusive(lockFile)) return { acquired: true };
  return { acquired: false, heldBy: readLockPid(lockFile) };
}

/** Total time a writer waits for another process's write to the same file to finish. A write is one small file read and one atomic rename, so this is far above its real cost, and bounded so a holder that never releases cannot wedge every other writer. */
export const WRITE_LOCK_WAIT_MS = 5000;
/** Poll interval while waiting for a write lock. */
const WRITE_LOCK_POLL_MS = 10;
/** One Int32 element's worth of bytes: all Atomics.wait needs to block on. */
const INT32_BYTE_LENGTH = 4;
/** The `code` of the error thrown when a write lock stays held beyond the wait budget. */
export const WRITE_LOCK_TIMEOUT = "WRITE_LOCK_TIMEOUT";

/** Thrown when the write lock of a file stays held by a live process beyond WRITE_LOCK_WAIT_MS. Nothing was written. */
export class WriteLockTimeoutError extends CommsError {
  constructor(public readonly file: string) {
    super(
      `Timed out waiting for another process to finish writing ${file}; nothing was written. If no other agent-comms process is running, remove ${writeLockFor(file)}.`,
      WRITE_LOCK_TIMEOUT,
    );
    this.name = "WriteLockTimeoutError";
  }
}

/** Blocks this thread for `ms` milliseconds. Only for callers that are themselves synchronous. */
export function sleepSync(ms: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(INT32_BYTE_LENGTH)),
    0,
    0,
    ms,
  );
}

/**
 * The lock file serialising writes to `file`. Its name ends in `.write-lock`, which no lock file this package names for a bridge slot (`.lock`) or any other file ends in, so it cannot equal another file's name whatever the slot's working directory is called.
 */
export function writeLockFor(file: string): string {
  return `${file}.write-lock`;
}

/**
 * Runs `action` holding the write lock of `file`, so the read-modify-write it performs cannot interleave with another process's. The lock is not reentrant: `action` must not take the same lock again (this process would count as having left it stale). A lock whose holder process has died is taken over (see tryAcquireLock). Throws WriteLockTimeoutError when the lock stays held by a live process beyond WRITE_LOCK_WAIT_MS. Blocks this thread while it waits, so a caller that is asynchronous uses withWriteLockAsync.
 */
export function withWriteLock<T>(file: string, action: () => T): T {
  const lockFile = writeLockFor(file);
  const deadline = Date.now() + WRITE_LOCK_WAIT_MS;
  while (!tryAcquireLock(lockFile).acquired) {
    if (Date.now() >= deadline) throw new WriteLockTimeoutError(file);
    sleepSync(WRITE_LOCK_POLL_MS);
  }
  try {
    return action();
  } finally {
    releaseLockFile(lockFile);
  }
}

/** withWriteLock for an asynchronous caller: waits on timers, so the event loop keeps running while another process holds the lock. `action` is synchronous, so the lock is never held across an await. */
export async function withWriteLockAsync<T>(
  file: string,
  action: () => T,
): Promise<T> {
  const lockFile = writeLockFor(file);
  const deadline = Date.now() + WRITE_LOCK_WAIT_MS;
  while (!tryAcquireLock(lockFile).acquired) {
    if (Date.now() >= deadline) throw new WriteLockTimeoutError(file);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, WRITE_LOCK_POLL_MS);
    });
  }
  try {
    return action();
  } finally {
    releaseLockFile(lockFile);
  }
}

/** Removes lockFile if this process holds it; a lock another process has since taken over, on this host or another, is left alone. The release half of tryAcquireLock. */
export function releaseLockFile(lockFile: string): void {
  const content = readLockContent(lockFile);
  if (content === undefined) return;
  const holder = holderOf(content);
  if (
    holder.pid === process.pid &&
    (holder.host === undefined || holder.host === OWN_HOST)
  ) {
    fs.rmSync(lockFile, { force: true });
  }
}
