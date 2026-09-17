// Shared helpers for the hub-mode integration test: canonical-CBOR bytes for frames crossing the test's own ws bridge.
import { cdeEncodeOptions, encode } from "cbor2";
import type { Frame } from "wire-mesh-core/generated/protocol";

export function cbor2ToBytes(frame: Frame): Uint8Array {
  return new Uint8Array(encode(frame, cdeEncodeOptions));
}
