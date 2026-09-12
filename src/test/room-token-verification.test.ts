import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNodeIdentity } from "wire-mesh-core/adapters/node-identity";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  mintCapabilityToken,
  mintRevocationEntry,
} from "wire-mesh-core/domain/tokens";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import { ownerNamedRoomPath, dmRoomPath } from "../core/room-path.js";
import { verifyRoomToken } from "../core/room-token-verification.js";

const ES256 = -7;
const HOUR_MS = 3_600_000;

function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

async function generateEs256Identity(): Promise<IdentityPort> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return createNodeIdentity(keyPair.privateKey, publicKeyBytes, ES256);
}

function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

let issuedTokenIds = 0;
function nextTokenId(): Uint8Array<ArrayBuffer> {
  issuedTokenIds += 1;
  return buf([issuedTokenIds]);
}

const NOW_MS = 1_893_456_000_000;
const EXPIRES_MS = NOW_MS + HOUR_MS;

async function mintRoomMemberToken(
  issuer: IdentityPort,
  bearer: IdentityPort,
  roomPath: string,
  tokenId: Uint8Array<ArrayBuffer> = nextTokenId(),
): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity: issuer,
    clock: fixedClock(NOW_MS),
    tokenId,
    bearer: bearer.deviceId,
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires: EXPIRES_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);
  return verdict.token;
}

describe("verifyRoomToken", () => {
  it("accepts a token rooted at the named room's own owner", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, member, roomPath);

    const verdict = await verifyRoomToken(token, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: member.deviceId,
      roomPath,
    });

    assert.equal(verdict.ok, true);
  });

  it("refuses a token rooted at the wrong device for a named room", async () => {
    const owner = await generateEs256Identity();
    const impostor = await generateEs256Identity();
    const member = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    // Minted by the impostor, not the room's actual owner -- rootIssuer will be the impostor's own device-id, not the path's owner.
    const token = await mintRoomMemberToken(impostor, member, roomPath);

    const verdict = await verifyRoomToken(token, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: member.deviceId,
      roomPath,
    });

    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "wrong_chain_root");
  });

  it("accepts a DM token rooted at the verifying identity itself", async () => {
    const me = await generateEs256Identity();
    const them = await generateEs256Identity();
    const roomPath = dmRoomPath(
      deviceIdToHex(me.deviceId),
      deviceIdToHex(them.deviceId),
    );
    // I (the verifier) issue the token that lets `them` send to me.
    const token = await mintRoomMemberToken(me, them, roomPath);

    const verdict = await verifyRoomToken(token, {
      identity: me,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: them.deviceId,
      roomPath,
    });

    assert.equal(verdict.ok, true);
  });

  it("refuses a DM token rooted at neither participant nor the verifier", async () => {
    const me = await generateEs256Identity();
    const them = await generateEs256Identity();
    const stranger = await generateEs256Identity();
    const roomPath = dmRoomPath(
      deviceIdToHex(me.deviceId),
      deviceIdToHex(them.deviceId),
    );
    // A stranger self-issues a token for this DM path -- must never verify, since the DM path's only acceptable root is the verifier itself.
    const token = await mintRoomMemberToken(stranger, them, roomPath);

    const verdict = await verifyRoomToken(token, {
      identity: me,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: them.deviceId,
      roomPath,
    });

    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "wrong_chain_root");
  });

  it("refuses a token scoped to a different room path", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const actualRoomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const otherRoomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "other-room",
    );
    const token = await mintRoomMemberToken(owner, member, actualRoomPath);

    const verdict = await verifyRoomToken(token, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: member.deviceId,
      roomPath: otherRoomPath,
    });

    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "wrong_scope_path");
  });

  it("refuses a token with an unrelated capability and an unrelated scope kind", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const verdict1 = await mintCapabilityToken({
      identity: owner,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: member.deviceId,
      capability: "exec:pty",
      scope: { kind: "folder" },
      expires: EXPIRES_MS,
    });
    if (!verdict1.ok) throw new Error(`mint failed: ${verdict1.reason}`);

    const verdict = await verifyRoomToken(verdict1.token, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: member.deviceId,
      roomPath,
    });

    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "wrong_capability");
  });

  it("refuses a token with the wrong capability even when its scope is correctly shaped for the room", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    // Nonsensical, but not structurally prevented at mint time: capability and scope disagree about what this token actually grants. Neither scope.kind nor scope.path alone can catch this -- only checking the capability itself can.
    const verdict1 = await mintCapabilityToken({
      identity: owner,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: member.deviceId,
      capability: "exec:pty",
      scope: { kind: "room", path: roomPath },
      expires: EXPIRES_MS,
    });
    if (!verdict1.ok) throw new Error(`mint failed: ${verdict1.reason}`);

    const verdict = await verifyRoomToken(verdict1.token, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: member.deviceId,
      roomPath,
    });

    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "wrong_capability");
  });

  it("refuses a token bearing a different device than the authenticated connection", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const impostor = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, member, roomPath);

    const verdict = await verifyRoomToken(token, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedBearer: impostor.deviceId,
      roomPath,
    });

    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "bearer_mismatch");
  });

  it("refuses an expired token", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, member, roomPath);

    const verdict = await verifyRoomToken(token, {
      identity: owner,
      clock: fixedClock(EXPIRES_MS + HOUR_MS),
      revocation: createRevocationView(),
      expectedBearer: member.deviceId,
      roomPath,
    });

    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "expired");
  });

  it("refuses a revoked token", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const tokenId = nextTokenId();
    const token = await mintRoomMemberToken(owner, member, roomPath, tokenId);

    const revocation = createRevocationView();
    const entry = await mintRevocationEntry({
      identity: owner,
      tokenId,
      revokedAt: NOW_MS,
    });
    await revocation.record(entry, { identity: owner });

    const verdict = await verifyRoomToken(token, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation,
      expectedBearer: member.deviceId,
      roomPath,
    });

    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "revoked");
  });
});
