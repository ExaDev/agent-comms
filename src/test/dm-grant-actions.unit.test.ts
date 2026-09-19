/**
 * Unit tests for the dm_admit, dm_use_grant and dm_revoke tool actions, against a fake store so no mesh is involved.
 */
import { describe, expect, it, vi } from "vitest";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import { dmAdmit, dmRevoke, dmUseGrant } from "../core/dm-grant-actions.js";
import { encodeTokenText } from "../core/token-text.js";

/** A device-id is a 64-character lowercase hex SHA-256 digest. */
const DEVICE_ID_HEX_LENGTH = 64;
const SENDER = "a".repeat(DEVICE_ID_HEX_LENGTH);
const RECEIVER = "b".repeat(DEVICE_ID_HEX_LENGTH);

const bytes = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(new TextEncoder().encode(text));
const GRANT: CapabilityToken = [
  bytes("protected"),
  {},
  bytes("payload"),
  bytes("signature"),
];

describe("dmAdmit", () => {
  it("mints a grant for the named device and returns it with the exact call the sender should make", async () => {
    const admitAgentForDm = vi.fn(async () => Promise.resolve(GRANT));

    const result = await dmAdmit(
      { admitAgentForDm },
      { action: "dm_admit", target: SENDER },
      RECEIVER,
    );

    expect(admitAgentForDm).toHaveBeenCalledWith(SENDER);
    expect(result.isError).toBe(false);
    expect(result.content).toContain(encodeTokenText(GRANT));
    expect(result.content).toContain(`dm_use_grant with target ${RECEIVER}`);
  });

  it("reports that grants are unavailable on a store that cannot mint them", async () => {
    const result = await dmAdmit(
      {},
      { action: "dm_admit", target: SENDER },
      RECEIVER,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });
});

describe("dmUseGrant", () => {
  it("presents the decoded grant to the counterpart and reports DM access", async () => {
    const requestDmAccess = vi.fn(async () => Promise.resolve());

    const result = await dmUseGrant(
      { requestDmAccess },
      {
        action: "dm_use_grant",
        target: RECEIVER,
        grant: encodeTokenText(GRANT),
      },
    );

    expect(requestDmAccess).toHaveBeenCalledWith(RECEIVER, GRANT);
    expect(result.isError).toBe(false);
    expect(result.content).toContain(RECEIVER);
  });

  it("refuses text that is not a token before contacting anyone", async () => {
    const requestDmAccess = vi.fn(async () => Promise.resolve());

    await expect(
      dmUseGrant(
        { requestDmAccess },
        { action: "dm_use_grant", target: RECEIVER, grant: "not a token" },
      ),
    ).rejects.toThrow(/not a valid capability token/);
    expect(requestDmAccess).not.toHaveBeenCalled();
  });

  it("reports that grants are unavailable on a store that cannot present them", async () => {
    const result = await dmUseGrant(
      {},
      {
        action: "dm_use_grant",
        target: RECEIVER,
        grant: encodeTokenText(GRANT),
      },
    );
    expect(result.isError).toBe(true);
  });
});

describe("dmRevoke", () => {
  it("revokes the named device's grant and says so", async () => {
    const revokeAgentDmAccess = vi.fn(async () => Promise.resolve());

    const result = await dmRevoke(
      { revokeAgentDmAccess },
      { action: "dm_revoke", target: SENDER },
    );

    expect(revokeAgentDmAccess).toHaveBeenCalledWith(SENDER);
    expect(result.isError).toBe(false);
    expect(result.content).toContain(SENDER);
  });

  it("reports that revoking is unavailable on a store that cannot", async () => {
    const result = await dmRevoke({}, { action: "dm_revoke", target: SENDER });
    expect(result.isError).toBe(true);
  });
});
