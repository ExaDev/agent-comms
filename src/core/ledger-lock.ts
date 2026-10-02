/**
 * Mutual exclusion for appending to one machine's writer log of the account ledger (agent-comms#344). A data-domain log is single-writer: two appends reading the same head would both write the next sequence number and fork the log. Every bridge on a machine shares that machine's writer log, and several stores can live in one process (the cc-peer front fronts many sessions), so appends are serialised both within this process (a promise chain per lock) and across processes (a PID lock file, pid-lock-file.ts, the same claim identity-store.ts uses for a bridge slot).
 */

import { releaseLockFile, tryAcquireLock } from "./pid-lock-file.js";

/** Runs `critical` with exclusive access to whatever this lock guards. */
export interface LedgerLock {
  run: <T>(critical: () => Promise<T>) => Promise<T>;
}

const MS_PER_SECOND = 1000;
/** How long an append waits for another process's append to finish. An append is one small file write, so a holder still busy after this long has hung or is wedged, and failing loudly beats waiting forever. */
const LOCK_WAIT_SECONDS = 10;
const LOCK_WAIT_MS = LOCK_WAIT_SECONDS * MS_PER_SECOND;
/** Between attempts to claim a lock another live process holds: short against an append's own cost, long enough not to spin. */
const LOCK_RETRY_MS = 20;

const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** The tail of each lock's queue in this process, keyed by what the lock guards. */
const tails = new Map<string, Promise<unknown>>();

async function serialised<T>(
  key: string,
  critical: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const next = previous.then(critical, critical);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  try {
    return await next;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

async function claimFile(lockFile: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const claim = tryAcquireLock(lockFile);
    if (claim.acquired) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `account ledger lock ${lockFile} is still held by pid ${String(claim.heldBy)} after ${String(LOCK_WAIT_SECONDS)}s`,
      );
    }
    await sleep(LOCK_RETRY_MS);
  }
}

/** A lock shared by every process on this machine that names the same lock file. */
export function createFileLedgerLock(lockFile: string): LedgerLock {
  return {
    run: async (critical) =>
      serialised(lockFile, async () => {
        await claimFile(lockFile);
        try {
          return await critical();
        } finally {
          releaseLockFile(lockFile);
        }
      }),
  };
}

let nextInProcessLock = 0;

/** A lock with no file behind it, for a ledger whose storage lives only in this process's memory. */
export function createInProcessLedgerLock(): LedgerLock {
  nextInProcessLock += 1;
  const key = `in-process:${String(nextInProcessLock)}`;
  return { run: async (critical) => serialised(key, critical) };
}
