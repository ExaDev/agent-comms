/**
 * CommsTool's dm_admit, dm_use_grant and dm_revoke action handlers -- the tool surface for agent-comms#162's dm:send grants, split out of tool.ts purely to keep it under the repo's max-lines cap.
 *
 * A grant lets one device send its first DM to another without the receiver deciding on the spot: the receiver admits the sender ahead of time (dm_admit) and hands over the grant it returns, the sender presents it (dm_use_grant), and the receiver's own user principal verifies it instead of asking a person. dm_revoke withdraws it.
 */

import type { CommsAction } from "./types.js";
import type { CommsResult, MeshOnlyFeatures } from "./tool.js";
import { decodeTokenText, encodeTokenText } from "./token-text.js";

/** Uniform "grants aren't available on this store" result, mirroring the other MeshOnlyFeatures action handlers. */
function grantsUnavailable(): CommsResult {
  return {
    content: "DM grants are not available on this store.",
    isError: true,
  };
}

/** Admits action.target to DM this user ahead of time. `receiverId` is this agent's own device-id, which the returned instructions name so the sender can quote them back verbatim. */
export async function dmAdmit(
  store: Readonly<Pick<MeshOnlyFeatures, "admitAgentForDm">>,
  action: CommsAction & { action: "dm_admit" },
  receiverId: string,
): Promise<CommsResult> {
  if (!store.admitAgentForDm) return grantsUnavailable();
  const grant = await store.admitAgentForDm(action.target);
  return {
    content: [
      `Admitted ${action.target} to DM you without asking again.`,
      `Give them this grant, and have them call dm_use_grant with target ${receiverId} and this grant:`,
      encodeTokenText(grant),
    ].join("\n"),
    isError: false,
  };
}

/** Presents action.grant to action.target so this device's DMs to it are admitted without a decision. Throws INVALID_TOKEN, before contacting anyone, when the grant text is not a token. */
export async function dmUseGrant(
  store: Readonly<Pick<MeshOnlyFeatures, "requestDmAccess">>,
  action: CommsAction & { action: "dm_use_grant" },
): Promise<CommsResult> {
  if (!store.requestDmAccess) return grantsUnavailable();
  const grant = decodeTokenText(action.grant);
  await store.requestDmAccess(action.target, grant);
  return {
    content: `DM access to ${action.target} granted; you can now dm it.`,
    isError: false,
  };
}

/** Withdraws the grant admitted for action.target, if one was ever issued. */
export async function dmRevoke(
  store: Readonly<Pick<MeshOnlyFeatures, "revokeAgentDmAccess">>,
  action: CommsAction & { action: "dm_revoke" },
): Promise<CommsResult> {
  if (!store.revokeAgentDmAccess) return grantsUnavailable();
  await store.revokeAgentDmAccess(action.target);
  return {
    content: `Revoked ${action.target}'s DM grant.`,
    isError: false,
  };
}
