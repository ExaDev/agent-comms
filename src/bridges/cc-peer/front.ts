/**
 * Pure decision logic for the default cc-peer front (agent-comms#157): a machine's coordinator bridge relays every local Claude Code session that doesn't already front itself, using the same (harness, cwd) identity slot that session's own agent-comms bridge would use, so addressing carries over unchanged the moment that session's own bridge appears.
 *
 * Kept free of any real cc-peer/MeshStore construction so it's testable without a real local Claude Code session, a real filesystem, or real sockets -- see front-runtime.ts for the stateful controller and the real wiring built on top of these functions.
 */

import type { IdentitySlot } from "../../core/identity-store.js";

/** The slice of cc-peer's own RegistryEntry this module needs. Narrowed rather than importing cc-peer's type directly so this file has no compile-time dependency on the cc-peer package (only front-runtime.ts, which does the real construction, needs that). */
export interface CcPeerRosterEntryLike {
  pid: number;
  cwd: string;
  name?: string | undefined;
  /** cc-peer's own registry entries for library-backed peers (this front itself, the one-shot `bridge cc-peer` command, an alias-pool worker) always carry the literal string "cc-peer" here -- see buildRegistryEntry in cc-peer's own source. A real interactive Claude Code session, which registers itself natively rather than through the cc-peer library, reports its own Claude Code version instead. */
  version: string;
  messagingSocketPath: string;
}

/** True for a roster entry that is itself a cc-peer-library-backed peer (this front's own shared identity, the one-shot bridge command, an alias-pool worker) rather than a real interactive Claude Code session -- see CcPeerRosterEntryLike.version's own doc comment for the mechanism. The front must never try to front one of these: it would compute a spurious claude-code identity slot for a process that isn't a Claude Code session at all, and relay cc-peer traffic into it that nothing there ever reads. */
export function isCcPeerLibraryPeer(
  entry: Readonly<CcPeerRosterEntryLike>,
): boolean {
  return entry.version === "cc-peer";
}

/** The identity slot a session's own agent-comms bridge would hold if it started right now -- the same (harness, cwd) pair every real claude-code bridge entry point (bridges/claude-code/channel.ts) already constructs. */
export function computeFrontSlot(cwd: string): IdentitySlot {
  return { harness: "claude-code", cwd };
}

/**
 * Filters a cc-peer roster down to the real Claude Code sessions this front should attach to right now: excludes other cc-peer-library peers, and excludes any session whose own slot is already held by a live PID (that session already fronts itself, via its own agent-comms bridge). probeSlotOwner is injected rather than imported directly so this stays a pure function over its inputs -- the real probe (identity-store.ts's probeSlotOwner) reads the filesystem, which has no place in a decision function tested purely over data.
 */
export function selectSessionsToFront(
  roster: readonly CcPeerRosterEntryLike[],
  probeSlotOwner: (slot: Readonly<IdentitySlot>) => number | undefined,
): CcPeerRosterEntryLike[] {
  return roster.filter((entry) => {
    if (isCcPeerLibraryPeer(entry)) return false;
    const slot = computeFrontSlot(entry.cwd);
    return probeSlotOwner(slot) === undefined;
  });
}

/**
 * Finds which currently-fronted session an inbound cc-peer message came from, by matching the envelope's own `from` field (always the literal string "uds:" followed by the sender's own listening socket path, per cc-peer's own send() -- see CcPeer.send in cc-peer's source) against each fronted session's messagingSocketPath. Generic over the fronted-session record type so front-runtime.ts's real records (which carry a live MeshStore/CommsTool alongside the roster entry) can be matched directly without this module needing to know their shape.
 */
export function matchInboundMessageSession<
  T extends { readonly messagingSocketPath: string },
>(
  fronted: Readonly<Iterable<T>>,
  message: Readonly<{ from?: string }>,
): T | undefined {
  if (message.from === undefined) return undefined;
  for (const record of fronted) {
    if (message.from === `uds:${record.messagingSocketPath}`) return record;
  }
  return undefined;
}
