/**
 * CommsTool's gateway_generate_connection_code/gateway_redeem_connection_code handlers (agent-comms#188), extracted out of tool.ts's own class body purely to keep that file under its own line-count budget -- these two handlers have no dependency on CommsTool's other state (agentId/harness/cwd context every other handler takes), so free functions taking the store and action directly are a cleaner shape than private methods would have been anyway.
 */

import type { CommsResult, MeshOnlyFeatures } from "./tool.js";
import { tryMeshAction } from "./tool.js";
import type { CommsAction, ConnectionCode } from "./types.js";

/**
 * Generates a fresh connection code vouching for this store's own device-id, optionally PGP-signed with a caller-supplied private key. See ConnectionCodeLedger.generate's own doc comment for what each option means.
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
    return `Connection code generated${signedNote}, valid until ${code.expiresAt}. Share it with the counterpart out of band; it can be redeemed once:\n${JSON.stringify(code)}`;
  });
}

/**
 * Validates a candidate connection code (assembled from action's own code/expiresAt/device/signature fields) and, on success, trusts the device-id it vouches for. When the candidate carries a signature but action supplies a fingerprint with no publicKey, fetches the signer's public key from a keyserver first via fetchPgpPublicKeyByFingerprintImpl -- injected rather than imported directly so a test can supply a fake resolver instead of making a real network call.
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
  const candidate: ConnectionCode = {
    code: action.code,
    expiresAt: action.expiresAt,
    deviceId: action.device,
    ...(action.signature !== undefined && { signature: action.signature }),
  };

  let publicKeyArmored = action.publicKey;
  if (
    candidate.signature !== undefined &&
    publicKeyArmored === undefined &&
    action.fingerprint !== undefined
  ) {
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
    const fingerprintNote =
      result.fingerprint !== undefined
        ? ` (signature verified, signing key fingerprint ${result.fingerprint})`
        : " (no signature; freshness only)";
    return `Trusted remote gateway device ${result.deviceId} via connection code${fingerprintNote}.`;
  });
}
