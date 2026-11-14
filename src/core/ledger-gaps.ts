/**
 * Gap detection for the account ledger's replicated writer logs (agent-comms#344), with no wire change. A `data-have` frame already carries the head sequence of the log it names, so each machine can see how far every peer says a log goes. A machine that stays behind that head for several rounds in a row, while the entries it asks for do not arrive, has a log something is withholding or dropping: a revocation could be in the missing part.
 *
 * What is kept: for each log, each live source's own announced head. A source is a peer this side reached over a direct session or over the relay hub. Each replication round compares those heads with this side's own and counts the rounds a log has stayed behind without advancing. At LEDGER_STALL_ROUNDS the log is reported as stalled, and again only if the gap grew and LEDGER_REPORT_REPEAT_ROUNDS rounds have passed, and the entries are asked of every source that announced a higher head, not only the one that answered first. A log that catches up, or whose announcing sources have gone, is forgotten.
 *
 * What is bounded: the logs tracked (MAX_TRACKED_LEDGER_LOGS, preferring logs this side already holds), how far ahead of this side's head an announced head may be (MAX_ANNOUNCED_HEAD_DISTANCE), how many reports of an ignored announcement are remembered, and how often a repeated report is made. Reports of ignored announcements are remembered apart from the logs, so forgetting a log never makes a report repeat.
 *
 * What it cannot see: a single path that withholds everything, including the higher head, since the head is learned from the same frames; a log beyond the tracked limit that this side does not hold; a head more than MAX_ANNOUNCED_HEAD_DISTANCE ahead, which is ignored; a log that is slow but still advancing, which is never behind for LEDGER_STALL_ROUNDS rounds without moving; and a machine that reaches no peer of the account at all, whose rounds are not counted.
 */

import { bytesToHex } from "wire-mesh-core/domain/device-id";
import type { DataRequestFrame } from "wire-mesh-core/generated/protocol";

/** How many consecutive replication rounds a log may stay behind an announced head, without a new entry arriving, before it is reported as stalled. */
export const LEDGER_STALL_ROUNDS = 3;

/** How many rounds pass before a gap that has grown since it was last reported is reported again, so a peer that raises its head every round gets one report per interval and not one per round. */
export const LEDGER_REPORT_REPEAT_ROUNDS = 10;

/** The most writer logs tracked at once. The account's logs are one per machine that ever wrote, so this is far above any real account. At the limit a log this side holds takes the place of one it does not, and any other log announced is not tracked, which is reported at most once per LEDGER_REPORT_REPEAT_ROUNDS rounds. */
export const MAX_TRACKED_LEDGER_LOGS = 256;

/** How many out-of-range reports are remembered per tracked log; the oldest is forgotten first. */
const REMEMBERED_REPORTS_PER_LOG = 4;
const MAX_REMEMBERED_REPORTS =
  REMEMBERED_REPORTS_PER_LOG * MAX_TRACKED_LEDGER_LOGS;

/** The furthest an announced head may be ahead of this side's own and still be believed. Heads count ledger entries, which are grants and revocations, and a reply carries a bounded batch, so a head further ahead than this is not an honest gap: it is not recorded, and is reported once. */
export const MAX_ANNOUNCED_HEAD_DISTANCE = 1_000_000;

/** A log this side is behind, reported once it has stayed so for LEDGER_STALL_ROUNDS rounds. */
export interface StalledLedgerLog {
  /** The writer log's id, hex. */
  log: string;
  /** This side's head sequence for it. */
  localHead: number;
  /** The highest head any live source announced. */
  announcedHead: number;
  /** The rounds it has stayed behind. */
  rounds: number;
}

/** What the tracker needs from its owner. */
export interface LedgerGapDeps {
  /** Sends a request for the entries after `frame["from-seq"]` of a log to one source, directly or through the hub. A rejection is reported and does not stop the others. */
  request: (source: string, frame: Readonly<DataRequestFrame>) => Promise<void>;
  /** Whether a source is still reachable: its announced heads are forgotten when it is not. */
  isLive: (source: string) => boolean;
  /** Where a stall is reported, and a failed request. */
  onError: (error: Error) => void;
}

interface LogState {
  /** The log's id as the wire carries it, for the request frames. */
  id: Uint8Array<ArrayBuffer>;
  /** The head each source announced. */
  heads: Map<string, number>;
  /** This side's head at the last round, and how many rounds in a row it has been behind without it moving. */
  lastLocal: number | undefined;
  rounds: number;
  /** The gap reported last, so a report repeats only when the gap grows, and the round it was reported in, so it repeats at most once per LEDGER_REPORT_REPEAT_ROUNDS. */
  reportedGap: number;
  reportedAtRound: number | undefined;
}

/** What a round is told about how it went. */
export interface LedgerRoundOptions {
  /** True when this machine reached no peer of the account this round: no offer went out, so nothing was asked of anyone. The round still notices a log that has caught up, but it is not counted as a round the log stayed behind. */
  offline?: boolean;
}

export class LedgerGapTracker {
  private readonly logs = new Map<string, LogState>();
  private roundNumber = 0;
  private overLimitReportedAtRound: number | undefined;
  /** The logs this side held at the last round, which a log announced at the tracking limit is preferred for. */
  private held: ReadonlySet<string> = new Set();
  /** The `log:source` of every out-of-range announcement reported, oldest first, kept apart from the logs so that a log forgotten and announced again is not reported again. */
  private readonly reportedOutOfRange = new Set<string>();

  constructor(private readonly deps: Readonly<LedgerGapDeps>) {}

  /** Records the head `source` announced for a log. Called for every `data-have` an account peer sends for one of the account's logs. */
  noteHave(source: string, log: Uint8Array, head: number): void {
    const key = bytesToHex(log);
    let state = this.logs.get(key);
    if (state === undefined) {
      if (this.logs.size >= MAX_TRACKED_LEDGER_LOGS && !this.makeRoomFor(key)) {
        this.reportOverLimit();
        return;
      }
      state = {
        id: Uint8Array.from(log),
        heads: new Map(),
        lastLocal: undefined,
        rounds: 0,
        reportedGap: 0,
        reportedAtRound: undefined,
      };
      this.logs.set(key, state);
    }
    state.heads.set(source, head);
  }

  /** Makes room for a log at the tracking limit by dropping a tracked log this side holds nothing of, and only when this side holds the new one. */
  private makeRoomFor(key: string): boolean {
    if (!this.held.has(key)) return false;
    for (const other of this.logs.keys()) {
      if (this.held.has(other)) continue;
      this.logs.delete(other);
      return true;
    }
    return false;
  }

  private reportOverLimit(): void {
    const last = this.overLimitReportedAtRound;
    if (
      last !== undefined &&
      this.roundNumber - last < LEDGER_REPORT_REPEAT_ROUNDS
    ) {
      return;
    }
    this.overLimitReportedAtRound = this.roundNumber;
    this.deps.onError(
      new Error(
        `the account ledger announces more than ${String(MAX_TRACKED_LEDGER_LOGS)} writer logs, which is more than any account has: the logs beyond them that this machine holds nothing of are ignored, so one of them that stays behind is not reported`,
      ),
    );
  }

  /** Remembers that an out-of-range announcement was reported, and whether it had been before. */
  private firstReportOfOutOfRange(key: string, source: string): boolean {
    const id = `${key}:${source}`;
    if (this.reportedOutOfRange.has(id)) return false;
    this.reportedOutOfRange.add(id);
    if (this.reportedOutOfRange.size > MAX_REMEMBERED_REPORTS) {
      const [oldest] = this.reportedOutOfRange;
      if (oldest !== undefined) this.reportedOutOfRange.delete(oldest);
    }
    return true;
  }

  /**
   * One replication round: compares every announced head with this side's (`localHeads`, by log id hex, absent for a log this side holds nothing of), counts the rounds each log stays behind without advancing, and on reaching LEDGER_STALL_ROUNDS reports it and asks every source that announced a higher head for the entries. Resolves once the requests have been sent.
   */
  async round(
    localHeads: ReadonlyMap<string, number>,
    options: Readonly<LedgerRoundOptions> = {},
  ): Promise<void> {
    this.roundNumber += 1;
    this.held = new Set(localHeads.keys());
    const requests: Promise<void>[] = [];
    for (const [key, state] of this.logs) {
      const local = localHeads.get(key) ?? 0;
      for (const [source, head] of [...state.heads]) {
        if (!this.deps.isLive(source)) {
          state.heads.delete(source);
        } else if (head - local > MAX_ANNOUNCED_HEAD_DISTANCE) {
          state.heads.delete(source);
          if (this.firstReportOfOutOfRange(key, source)) {
            this.deps.onError(
              new Error(
                `a peer announced head ${String(head)} for account ledger log ${key}, which is out of range for a log this machine holds up to entry ${String(local)} of, and the announcement is ignored`,
              ),
            );
          }
        } else {
          this.reportedOutOfRange.delete(`${key}:${source}`);
        }
      }
      const announced = Math.max(0, ...state.heads.values());
      if (announced <= local) {
        this.logs.delete(key);
        continue;
      }
      if (options.offline === true) continue;
      if (state.lastLocal === local) {
        state.rounds += 1;
      } else {
        state.rounds = 1;
        state.reportedGap = 0;
      }
      state.lastLocal = local;
      if (state.rounds < LEDGER_STALL_ROUNDS) continue;
      const gap = announced - local;
      const due =
        state.reportedAtRound === undefined ||
        this.roundNumber - state.reportedAtRound >= LEDGER_REPORT_REPEAT_ROUNDS;
      if (gap > state.reportedGap && due) {
        state.reportedGap = gap;
        state.reportedAtRound = this.roundNumber;
        this.deps.onError(
          new Error(
            `account ledger log ${key} has stayed behind for ${String(state.rounds)} rounds: this machine holds up to entry ${String(local)} and a peer announces ${String(announced)}; a grant or a revocation in the missing entries is not applied here, and the entries are being asked of every peer that announced them`,
          ),
        );
      }
      for (const [source, head] of state.heads) {
        if (head <= local) continue;
        requests.push(
          this.deps
            .request(source, {
              type: "data-request",
              peer: state.id,
              "from-seq": local,
            })
            .catch((error: unknown) => {
              this.deps.onError(
                error instanceof Error ? error : new Error(String(error)),
              );
            }),
        );
      }
    }
    await Promise.all(requests);
  }

  /** The logs that have stayed behind for LEDGER_STALL_ROUNDS rounds or more as of the last round, for whoami. */
  stalled(): StalledLedgerLog[] {
    const out: StalledLedgerLog[] = [];
    for (const [key, state] of this.logs) {
      if (state.rounds < LEDGER_STALL_ROUNDS) continue;
      const announced = Math.max(0, ...state.heads.values());
      out.push({
        log: key,
        localHead: state.lastLocal ?? 0,
        announcedHead: announced,
        rounds: state.rounds,
      });
    }
    return out;
  }
}
