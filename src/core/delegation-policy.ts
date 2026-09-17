/**
 * Issuer-side delegation policy (agent-comms#163): deciding which capability verbs an issuer never lets a bearer redelegate, expressed entirely with wire-mesh-core's own shipped primitives. A capability on the policy's nonDelegable set is always minted with delegationsRemaining forced to 0 -- the grant is usable by its own bearer but cannot be passed further down the chain -- regardless of what the caller would otherwise request; mintCapabilityToken needs no change for this, since delegationsRemaining: 0 already means exactly "no further hops" (tokens-CpLDI5Fo.d.mts's own MintCapabilityTokenOptions.delegationsRemaining doc comment).
 *
 * Per-agent overrides are deliberately just a second, bearer-keyed nonDelegable set that entirely REPLACES the policy's own default for that one bearer, never merges with it. This needs no bookkeeping of its own: every bearer's grant is already its own independent mint (mintCapabilityToken places no bound tying separate bearers' root-level grants together), so narrowing one bearer's policy is simply supplying a different nonDelegable set to that bearer's own resolution -- there is no prior per-bearer state to merge into, and an override naming zero verbs makes every capability delegable for that one bearer without touching the default any other bearer still resolves against.
 */

/**
 * One issuer's non-delegable policy: `nonDelegable` is the default set of capability verbs this issuer never lets any bearer redelegate; `perAgentOverrides` narrows that default per bearer (device-id hex), replacing it outright for that bearer's own resolution rather than merging with it.
 */
export interface DelegationPolicy {
  readonly nonDelegable: ReadonlySet<string>;
  readonly perAgentOverrides?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Resolves the delegationsRemaining value to actually mint for bearer's grant of capability under policy, given whatever delegationsRemaining the caller would otherwise request. Returns 0 when capability is on the bearer's own effective nonDelegable set (its per-agent override when policy defines one for that bearer, otherwise policy's own default set) -- overriding requested outright, the same "issuer refuses to mint an invalid delegation rather than let the far end discover it later" posture mintCapabilityToken's own parent narrowing already applies. Returns requested unchanged for every other capability.
 */
export function resolveDelegationsRemaining(
  policy: Readonly<DelegationPolicy>,
  capability: string,
  bearer: string,
  requested: number | undefined,
): number | undefined {
  const effectiveNonDelegable =
    policy.perAgentOverrides?.get(bearer) ?? policy.nonDelegable;
  return effectiveNonDelegable.has(capability) ? 0 : requested;
}
