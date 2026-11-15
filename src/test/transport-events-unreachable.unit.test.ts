/**
 * A peer the transport reports as unreachable reaches the peer lifecycle, which forgets it (agent-comms#587).
 */

import { expect, it, vi } from "vitest";
import { createTransportEvents } from "../core/transport-events.js";
import type { TransportEventTargets } from "../core/transport-events.js";

it("hands the unreachable peer to the peer lifecycle and to nothing else", () => {
  const handlePeerUnreachable = vi.fn();
  const events = createTransportEvents({
    peerLifecycle: { handlePeerUnreachable },
    reportError: vi.fn(),
  } as unknown as TransportEventTargets);

  const peer = {
    id: "some-peer",
    port: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
  };

  events.onPeerUnreachable?.(peer);

  expect(handlePeerUnreachable).toHaveBeenCalledExactlyOnceWith(peer);
});
