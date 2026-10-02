/**
 * A lock file holding the PID of the process that claimed it: the exclusivity guard for a bridge's identity slot (identity-store.ts) and for appends to the machine's account ledger (ledger-lock.ts). A lock whose recorded process has died is stale and may be taken over, so a holder that crashed never wedges the lock.
 *
 * Every claim writes the PID plus a random nonce, so two claims never leave identical content even when a PID is reused. Removing a stale lock is the one step that could delete a newer, live claim by mistake (the stale file can be released and re-claimed between reading it and removing it), so it happens only under a second, takeover lock file, and only when the lock still holds exactly the content that was read and judged stale. A live holder releasing its own lock never needs the takeover lock: only its own claim can be at that name while it holds it.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";

/** Random bytes in each claim's content, enough that two claims never collide. */
const CLAIM_NONCE_BYTES = 16;

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

/** Read the PID holding the lock, or undefined when absent or unreadable. */
export function readLockPid(lockFile: string): number | undefined {
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
    `${String(process.pid)}\n${randomBytes(CLAIM_NONCE_BYTES).toString("hex")}\n`,
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

/** Whether content names a process that can no longer be holding the lock: one that has died, this process itself (which claims a lock only after releasing it, so a lock naming it is left over from before), or no readable PID at all. */
function isStale(content: string): boolean {
  const pid = pidOf(content);
  return pid === undefined || pid === process.pid || !isPidAlive(pid);
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

/** Removes lockFile if this process holds it; a lock another PID has since taken over is left alone. The release half of tryAcquireLock. */
export function releaseLockFile(lockFile: string): void {
  if (readLockPid(lockFile) === process.pid) {
    fs.rmSync(lockFile, { force: true });
  }
}
