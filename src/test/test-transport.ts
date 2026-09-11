/** Wires a real TlsTransport with a freshly generated identity onto a freshly constructed MeshStore -- the same setTransport() call every production bridge makes immediately after construction. MeshStore has no default transport, so every test that constructs one needs this (or an equivalent explicit setTransport() call) before init() or any other transport-using method runs. */

import { TlsTransport } from "../core/tls-transport.js";
import { generateIdentity } from "../core/identity.js";
import type { MeshStore } from "../core/mesh-store.js";

export function wireTestTransport(store: MeshStore): void {
  const identity = generateIdentity();
  // Every real bridge sets peerId to the identity's own certificate fingerprint before wiring the transport -- TlsTransport's cert-pinning trust model means a peer's advertised ID and the fingerprint the other side actually authenticates the connection against must be the same value, or introduction/state-sync never recognises the peer as itself.
  store.peerId = identity.fingerprint;
  store.setTransport(new TlsTransport(store.events, identity));
}
