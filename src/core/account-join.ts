/**
 * Joining a machine to an account (agent-comms#344): one deliberate act per new machine. A machine holding the account issues an account invite, an ordinary connection code (connection-code.ts) it also remembers as an invite; the person carries it to the new machine, which redeems it. Redeeming trusts the issuing device exactly as any connection code does, then asks that device, over the mesh's end-to-end authenticated request path (directly or relayed by the hub), for the account key, which comes back sealed under a key only the invite's holder can derive. The new machine then holds the account: its devices mint membership proofs as the account, so every machine already trusting the account's principal covers them with no per-pair step, and it replicates and can revoke from the account's grant ledger.
 *
 * The issuing device enforces the invite for real, not only the redeemer: it answers each invite once and never after its expiry, so a copied invite is worth nothing once used or stale, and it refuses to issue one that would stay valid for longer than an ordinary connection code (DEFAULT_CONNECTION_CODE_TTL_MS), which is already sized for a person relaying it by hand, since an invite is the account key to whoever redeems it first. Invites live only in the issuing store's memory, so a restart of that store before the invite is used cancels it.
 *
 * Neither half is an agent_comms tool action: an invite hands over the account key and a join replaces the machine's account, so both are `agent-comms account invite` and `agent-comms account join`, run by the person at the terminal (account-cli.ts), where nothing an agent is told can trigger them and the invite is never written into an agent's transcript.
 */

import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import {
  openAccountKeyFromInvite,
  sealAccountKeyForInvite,
  type AccountInviteSecret,
} from "./account-bundle.js";
import { openAccountLedger } from "./account-ledger-store.js";
import {
  DEFAULT_CONNECTION_CODE_TTL_MS,
  type ConnectionCodeLedger,
  type GenerateConnectionCodeOptions,
  type RedeemConnectionCodeOptions,
} from "./connection-code.js";
import type { GatewayTrust } from "./gateway-trust.js";
import type { MeshStoreIdentity } from "./mesh-store-shared.js";
import { CommsError } from "./store.js";
import type { MeshTransport } from "./transport.js";
import type { ConnectionCode } from "./types.js";
import { importAccountKey, readAccountPrivateKey } from "./user-identity.js";
import { toIdentityPort } from "./wire-mesh-identity.js";

/** The request verb an invite's redeemer sends its issuer (params.verb), and the capability verb the manage-command carries only to satisfy manage-command.verb's grammar: the handler checks the invite itself, never a token. */
export const ACCOUNT_JOIN_VERB = "account.join";
const ACCOUNT_JOIN_CAPABILITY_VERB = "account:join";

/** The outcomes sendRoomRequest gives when this side has no route to the device yet, as opposed to an answer from the device. */
const NO_ROUTE_CODES: ReadonlySet<string> = new Set([
  "no_route",
  "not_connected",
]);
const MS_PER_SECOND = 1000;
/** How long a join waits for a route to the issuing device to come up: a hub dial and its first directory exchange take seconds, so this is generous without leaving a person waiting on an unreachable issuer for long. */
const JOIN_ROUTE_WAIT_SECONDS = 30;
const JOIN_ROUTE_WAIT_MS = JOIN_ROUTE_WAIT_SECONDS * MS_PER_SECOND;
/** Between attempts to reach the issuing device: short against the wait, long enough not to spin. */
const JOIN_ROUTE_RETRY_MS = 250;

/** What became of an invite: answered with the account key, or expired unanswered. */
export type AccountInviteOutcome = "redeemed" | "expired";

export interface AccountInvite {
  code: ConnectionCode;
  /** Settles once the invite has been answered or has expired, whichever comes first. */
  settled: Promise<AccountInviteOutcome>;
}

interface PendingInvite {
  secret: AccountInviteSecret;
  settle: (outcome: AccountInviteOutcome) => void;
}

export interface AccountJoinDeps {
  requireIdentity: () => MeshStoreIdentity;
  requireTransport: () => MeshTransport;
  getPeerId: () => string;
  connectionCodes: ConnectionCodeLedger;
  gatewayTrust: GatewayTrust;
  /** Re-evaluates whether the store should hold a hub session, after trust changes. */
  reconsiderHub: () => void;
  /** Redeems a connection code the ordinary way (freshness, single use, optional signature) and trusts the device it vouches for. */
  redeemConnectionCode: (
    candidate: Readonly<ConnectionCode>,
    options: Readonly<RedeemConnectionCodeOptions>,
  ) => Promise<unknown>;
  /** Re-attaches the store to the account it now holds, so its own proofs and ledger switch at once. */
  setIdentity: (identity: MeshStoreIdentity) => void;
}

export interface AccountJoinResult {
  /** The account's principal id (hex) this machine now holds. */
  principal: string;
  /** Where the account this machine held before was set aside, when it held a different one. */
  replacedFile?: string;
}

export class AccountJoin {
  /** Invites this store issued that are neither answered nor known to have expired, keyed by their nonce. */
  private readonly invites = new Map<string, PendingInvite>();

  constructor(private readonly deps: Readonly<AccountJoinDeps>) {}

  /** Issues an account invite vouching for this store's own device, valid for options.ttlMs (at most DEFAULT_CONNECTION_CODE_TTL_MS, the default). Throws INVITE_TTL_TOO_LONG for a longer one. Also trusts the account's own principal, so this machine holds a hub session the joining machine can reach it through, and admits the joined machine's devices once their proofs name the account. */
  async invite(
    options: Readonly<Omit<GenerateConnectionCodeOptions, "now">> = {},
  ): Promise<AccountInvite> {
    const ttlMs = options.ttlMs ?? DEFAULT_CONNECTION_CODE_TTL_MS;
    if (ttlMs > DEFAULT_CONNECTION_CODE_TTL_MS) {
      throw new CommsError(
        `An account invite can stay valid for at most ${String(DEFAULT_CONNECTION_CODE_TTL_MS)} ms, since whoever redeems it first takes the account key`,
        "INVITE_TTL_TOO_LONG",
      );
    }
    const { clock } = this.deps.requireIdentity();
    this.pruneExpired();
    const code = await this.deps.connectionCodes.generate(
      this.deps.getPeerId(),
      { ...options, ttlMs, now: clock.now() },
    );
    const settled = new Promise<AccountInviteOutcome>((resolve) => {
      this.invites.set(code.code, {
        secret: {
          code: code.code,
          expiresAt: code.expiresAt,
          deviceId: code.deviceId,
        },
        settle: resolve,
      });
    });
    // Settles `settled` on expiry even when nothing else calls in to prune; unref'd so a pending invite never keeps a process alive by itself.
    setTimeout(() => {
      this.pruneExpired();
    }, ttlMs).unref();
    this.trustOwnAccount();
    return { code, settled };
  }

  /** Answers an account.join request: the account key sealed for the named invite, once, and only before the invite expires. Every other request, including a second use of the same invite, is refused without saying whether the invite ever existed. */
  readonly handleJoinRequest = async (
    request: Readonly<IncomingManageRequest>,
  ): Promise<ManageOutcome> => {
    this.pruneExpired();
    const { params } = request.command;
    const code: unknown = "code" in params ? params.code : undefined;
    const invite =
      typeof code === "string" ? this.invites.get(code) : undefined;
    if (invite === undefined) {
      return Promise.resolve({ result: "error", code: "invalid_invite" });
    }
    this.invites.delete(invite.secret.code);
    const { userIdentityOptions } = this.deps.requireIdentity();
    const sealed = sealAccountKeyForInvite(
      readAccountPrivateKey(userIdentityOptions),
      invite.secret,
    );
    invite.settle("redeemed");
    return Promise.resolve({ result: "ok", sealed });
  };

  /** Drops every invite whose expiry has passed by this store's clock, settling each as expired. */
  private pruneExpired(): void {
    const now = this.deps.requireIdentity().clock.now();
    for (const [nonce, invite] of this.invites) {
      if (Date.parse(invite.secret.expiresAt) > now) continue;
      this.invites.delete(nonce);
      invite.settle("expired");
    }
  }

  /** Redeems an account invite and makes this machine hold the account it names. Throws INVITE_REFUSED when the issuing device will not answer it (used, expired, cancelled by a restart, or unreachable), and whatever redeeming the connection code itself throws before that. Redeeming trusts the issuing device so the key request can reach it; when the join then fails, that trust is withdrawn again unless the device was already trusted before, so a refused or unanswered invite leaves this machine trusting no one new. */
  async join(
    candidate: Readonly<ConnectionCode>,
    options: Readonly<RedeemConnectionCodeOptions> = {},
  ): Promise<AccountJoinResult> {
    const trustedBefore = this.deps.gatewayTrust.isTrusted(candidate.deviceId);
    await this.deps.redeemConnectionCode(candidate, options);
    try {
      return await this.takeAccount(candidate);
    } catch (error) {
      if (!trustedBefore) {
        this.deps.gatewayTrust.remove(candidate.deviceId);
        this.deps.reconsiderHub();
      }
      throw error;
    }
  }

  /** The half of join after the invite's issuer is trusted: fetch the account key from it and switch this machine to that account. */
  private async takeAccount(
    candidate: Readonly<ConnectionCode>,
  ): Promise<AccountJoinResult> {
    const outcome = await this.requestAccountKey(candidate);
    const sealed: unknown =
      outcome.result === "ok" ? outcome.sealed : undefined;
    if (typeof sealed !== "string") {
      throw new CommsError(
        `The issuing device refused the account invite (${outcome.result === "error" ? (outcome.message ?? outcome.code) : "no key in its answer"})`,
        "INVITE_REFUSED",
      );
    }
    const privateKeyPem = openAccountKeyFromInvite(sealed, candidate);
    const current = this.deps.requireIdentity();
    const { identity, replacedFile } = importAccountKey(
      current.userIdentityOptions,
      privateKeyPem,
    );
    this.deps.setIdentity({
      ...current,
      userIdentity: await toIdentityPort(identity),
      accountLedger: await openAccountLedger({
        userIdentityOptions: current.userIdentityOptions,
        userIdentity: identity,
        clock: current.clock,
      }),
    });
    this.trustOwnAccount();
    const principal = deviceIdToHex(Uint8Array.from(identity.deviceId));
    return replacedFile === undefined
      ? { principal }
      : { principal, replacedFile };
  }

  /** Asks the invite's issuing device for the account key. Redeeming the invite has only just trusted that device, so the route to it (a hub session this store opens because it now trusts someone) may still be coming up: a request that found no route yet is retried until JOIN_ROUTE_WAIT_MS has passed, and any answer from the device itself is returned as it is. */
  private async requestAccountKey(
    invite: Readonly<ConnectionCode>,
  ): Promise<ManageOutcome> {
    const { clock } = this.deps.requireIdentity();
    const deadline = clock.now() + JOIN_ROUTE_WAIT_MS;
    for (;;) {
      const outcome = await this.deps.requireTransport().sendRoomRequest(
        invite.deviceId,
        {
          verb: ACCOUNT_JOIN_CAPABILITY_VERB,
          params: { verb: ACCOUNT_JOIN_VERB, code: invite.code },
        },
        { kind: "node" },
      );
      const noRouteYet =
        outcome.result === "error" && NO_ROUTE_CODES.has(outcome.code);
      if (!noRouteYet || clock.now() >= deadline) return outcome;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, JOIN_ROUTE_RETRY_MS);
      });
    }
  }

  private trustOwnAccount(): void {
    const { userIdentity } = this.deps.requireIdentity();
    this.deps.gatewayTrust.addPrincipal(deviceIdToHex(userIdentity.deviceId));
    this.deps.reconsiderHub();
  }
}
