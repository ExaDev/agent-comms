/**
 * Unit tests for the issuer-side delegation policy (core/delegation-policy, agent-comms#163): deciding which capability verbs an issuer never lets a bearer redelegate, and how a caller narrows that decision per bearer.
 */

import { test, expect } from "vitest";
import { resolveDelegationsRemaining } from "../core/delegation-policy.js";
import type { DelegationPolicy } from "../core/delegation-policy.js";

const ALICE = "alice-device-id";
const BOB = "bob-device-id";
const REQUESTED_DELEGATIONS_REMAINING = 5;
const NO_DELEGATIONS_REMAINING = 0;

test("a capability on the policy's default nonDelegable set is always minted with delegationsRemaining 0", () => {
  const policy: DelegationPolicy = {
    nonDelegable: new Set(["room:member"]),
  };

  expect(
    resolveDelegationsRemaining(
      policy,
      "room:member",
      ALICE,
      REQUESTED_DELEGATIONS_REMAINING,
    ),
  ).toBe(NO_DELEGATIONS_REMAINING);
});

test("a capability absent from the default nonDelegable set passes the requested value through unchanged", () => {
  const policy: DelegationPolicy = {
    nonDelegable: new Set(["room:member"]),
  };

  expect(
    resolveDelegationsRemaining(
      policy,
      "dm:send",
      ALICE,
      REQUESTED_DELEGATIONS_REMAINING,
    ),
  ).toBe(REQUESTED_DELEGATIONS_REMAINING);
});

test("an undefined requested value passes through unchanged for a delegable capability", () => {
  const policy: DelegationPolicy = {
    nonDelegable: new Set(["room:member"]),
  };

  expect(
    resolveDelegationsRemaining(policy, "dm:send", ALICE, undefined),
  ).toBeUndefined();
});

test("a per-agent override entirely replaces the default nonDelegable set for that bearer, never merges with it", () => {
  const policy: DelegationPolicy = {
    nonDelegable: new Set(["room:member"]),
    perAgentOverrides: new Map([[ALICE, new Set(["dm:send"])]]),
  };

  // Alice's own override names dm:send, not room:member -- so room:member, present only in the policy's default set, no longer applies to her once her own override is in effect.
  expect(
    resolveDelegationsRemaining(
      policy,
      "room:member",
      ALICE,
      REQUESTED_DELEGATIONS_REMAINING,
    ),
  ).toBe(REQUESTED_DELEGATIONS_REMAINING);
  expect(
    resolveDelegationsRemaining(
      policy,
      "dm:send",
      ALICE,
      REQUESTED_DELEGATIONS_REMAINING,
    ),
  ).toBe(NO_DELEGATIONS_REMAINING);
});

test("a per-agent override for one bearer never affects a different bearer's own resolution", () => {
  const policy: DelegationPolicy = {
    nonDelegable: new Set(["room:member"]),
    perAgentOverrides: new Map([[ALICE, new Set(["dm:send"])]]),
  };

  expect(
    resolveDelegationsRemaining(
      policy,
      "room:member",
      BOB,
      REQUESTED_DELEGATIONS_REMAINING,
    ),
  ).toBe(NO_DELEGATIONS_REMAINING);
  expect(
    resolveDelegationsRemaining(
      policy,
      "dm:send",
      BOB,
      REQUESTED_DELEGATIONS_REMAINING,
    ),
  ).toBe(REQUESTED_DELEGATIONS_REMAINING);
});

test("an empty per-agent override set makes every capability delegable for that bearer", () => {
  const policy: DelegationPolicy = {
    nonDelegable: new Set(["room:member"]),
    perAgentOverrides: new Map([[ALICE, new Set()]]),
  };

  expect(
    resolveDelegationsRemaining(
      policy,
      "room:member",
      ALICE,
      REQUESTED_DELEGATIONS_REMAINING,
    ),
  ).toBe(REQUESTED_DELEGATIONS_REMAINING);
});
