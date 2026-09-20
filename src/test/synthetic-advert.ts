// A structurally complete peer-advert for tests of code that only reads an advert's own fields and never verifies it: directory merging, admission policy, mesh-graph assembly. The identity-key and signature are filler, so an advert built here would fail wire-mesh-core's own verification. Verification is exercised by wire-mesh-core's own tests, and any test that needs a hub or session to accept an advert must let that session sign its own.

import type { DeviceId, PeerAdvert } from "wire-mesh-core/generated/protocol";

/** COSE algorithm identifier for ES256 (RFC 9053), the value a real identity-key carries. */
const ALG_ES256 = -7;

/** The filler key and signature carry no meaning, so a single zero byte is enough to satisfy their bstr type. */
const FILLER_BYTES = new Uint8Array(new ArrayBuffer(1));

export interface SyntheticAdvertOptions {
  readonly snapshotSeconds?: number;
  /** Domain-qualified extension keys, exactly as a real advert's open tail carries them. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export function syntheticAdvert(
  device: DeviceId,
  options: Readonly<SyntheticAdvertOptions> = {},
): PeerAdvert {
  return {
    ...options.extensions,
    device,
    addresses: [],
    "snapshot-seconds": options.snapshotSeconds ?? 0,
    "identity-key": { alg: ALG_ES256, "public-key": FILLER_BYTES },
    signature: FILLER_BYTES,
  };
}
