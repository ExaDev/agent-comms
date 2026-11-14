/**
 * CommsTool's gateway_generate_connection_code/gateway_redeem_connection_code handlers (agent-comms#188), extracted out of tool.ts's own class body purely to keep that file under its own line-count budget -- these two handlers have no dependency on CommsTool's other state (agentId/harness/cwd context every other handler takes), so free functions taking the store and action directly are a cleaner shape than private methods would have been anyway.
 */

import type { CommsResult, MeshOnlyFeatures } from "./tool.js";
import { tryMeshAction } from "./tool.js";
import type { CommsAction, ConnectionCode } from "./types.js";

/** The command a person runs to redeem a code the tool refuses. Named in every refusal and in the text a generated code is handed over with. */
export const GATEWAY_REDEEM_COMMAND = "agent-comms gateway redeem";

/**
 * Generates a fresh connection code vouching for this store's own device-id, optionally PGP-signed with a caller-supplied private key. See ConnectionCodeLedger.generate's own doc comment for what each option means. The code is handed over with the instruction that the counterpart redeems it with the GATEWAY_REDEEM_COMMAND command, since the tool that would otherwise redeem it refuses an unsigned code.
 */
export async function handleGatewayGenerateConnectionCode(
  store: Readonly<MeshOnlyFeatures>,
  action: CommsAction & { action: "gateway_generate_connection_code" },
): Promise<CommsResult> {
  if (!store.generateConnectionCode) {
    return {
      content: "Connection codes are not available on this store.",
      isError: true,
    };
  }
  const generateConnectionCode = store.generateConnectionCode.bind(store);
  return tryMeshAction("generate connection code", async () => {
    const code = await generateConnectionCode({
      ...(action.ttlMs !== undefined && { ttlMs: action.ttlMs }),
      ...(action.privateKey !== undefined && {
        privateKeyArmored: action.privateKey,
      }),
      ...(action.passphrase !== undefined && {
        passphrase: action.passphrase,
      }),
    });
    const signedNote =
      code.signature !== undefined ? " (PGP-signed)" : " (unsigned)";
    return `Connection code generated${signedNote}, valid until ${code.expiresAt}. Share it with the counterpart out of band; it can be redeemed once, and the counterpart redeems it by running \`${GATEWAY_REDEEM_COMMAND}\` in a terminal (an agent's tool refuses an unsigned code and a signed one it was not given a key or fingerprint for):\n${JSON.stringify(code)}`;
  });
}

/** The result for a code this tool refuses: nothing is redeemed or trusted, and the person is told what to run. */
function refusal(reason: string): CommsResult {
  return {
    content: `${reason} Redeem it yourself, in a terminal, with \`${GATEWAY_REDEEM_COMMAND}\`, which shows the device it vouches for and asks you to confirm.`,
    isError: true,
  };
}

/**
 * Validates a candidate connection code (assembled from action's own code/expiresAt/device/signature fields) and, on success, trusts the device-id it vouches for. An unsigned code is a bearer hint, never authentication: whoever produced the text decided which device-id it names, and an agent can be steered by text another agent wrote, so this tool never redeems one: it refuses a code with no signature, and a signed code unless action supplies a publicKey or a fingerprint that pins the signer, and the refusal names GATEWAY_REDEEM_COMMAND, which a person runs in a terminal. Supplying a publicKey or fingerprint also requires the code to be signed. When the candidate carries a signature but action supplies a fingerprint with no publicKey, fetches the signer's public key from a keyserver first via fetchPgpPublicKeyByFingerprintImpl, injected rather than imported directly so a test can supply a fake resolver instead of making a real network call.
 */
export async function handleGatewayRedeemConnectionCode(
  store: Readonly<MeshOnlyFeatures>,
  action: CommsAction & { action: "gateway_redeem_connection_code" },
  fetchPgpPublicKeyByFingerprintImpl: (fingerprint: string) => Promise<string>,
): Promise<CommsResult> {
  if (!store.redeemConnectionCode) {
    return {
      content: "Connection codes are not available on this store.",
      isError: true,
    };
  }
  if (action.signature === undefined) {
    return refusal(
      "This connection code is not signed. An unsigned code names whatever device its text says, whoever wrote it, so this tool does not redeem one.",
    );
  }
  if (action.publicKey === undefined && action.fingerprint === undefined) {
    return refusal(
      "This connection code is signed, but no publicKey or fingerprint was supplied to say whose signature to accept, and a signature checked against no one proves nothing.",
    );
  }
  const candidate: ConnectionCode = {
    code: action.code,
    expiresAt: action.expiresAt,
    deviceId: action.device,
    signature: action.signature,
  };

  let publicKeyArmored = action.publicKey;
  if (publicKeyArmored === undefined && action.fingerprint !== undefined) {
    try {
      publicKeyArmored = await fetchPgpPublicKeyByFingerprintImpl(
        action.fingerprint,
      );
    } catch (err) {
      return {
        content: `Failed to fetch PGP public key for fingerprint ${action.fingerprint}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  const redeemConnectionCode = store.redeemConnectionCode.bind(store);
  return tryMeshAction("redeem connection code", async () => {
    const result = await redeemConnectionCode(candidate, {
      ...(publicKeyArmored !== undefined && { publicKeyArmored }),
      ...(action.fingerprint !== undefined && {
        expectedFingerprint: action.fingerprint,
      }),
    });
    return `Trusted remote gateway device ${result.deviceId} via connection code (signature verified, signing key fingerprint ${result.fingerprint ?? "unknown"}).`;
  });
}
