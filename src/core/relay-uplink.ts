/**
 * The connection a relay hub takes to its upstream hub as its uplink (agent-comms#342), built over a hub session that already owns that connection.
 *
 * A HubSession drives the connection to the public hub through wire-mesh-core's session, whose own receive loop is the one consumer of the connection's frames. The relay hub's handleUplink needs a frame stream of its own, so the session's per-frame observer feeds each frame it reads into this uplink as well, and sends from the hub go out over the same underlying connection. Closing the uplink ends the stream the hub reads and leaves the underlying connection to the session that owns it.
 */

import type { Frame } from "wire-mesh-core/generated/protocol";
import type { Connection } from "wire-mesh-core/ports/transport";

/** What the owner of the upstream connection drives: each frame it reads from upstream, and the end of the connection. */
export interface UplinkFeed {
  /** Hands the hub one frame read from upstream. Ignored once the uplink has ended. */
  feed: (frame: Readonly<Frame>) => void;
  /** Ends the stream the hub reads, which makes it forget the uplink. Idempotent. */
  end: () => void;
}

export interface Uplink {
  /** The connection handed to the relay hub's handleUplink. */
  connection: Connection;
  feed: UplinkFeed;
}

/** Builds the uplink over an upstream connection some other session owns: sends go to it directly, receives come from what the owner feeds in. */
export function createUplink(upstream: Readonly<Connection>): Uplink {
  const backlog: Frame[] = [];
  const waiters: ((result: IteratorResult<Frame>) => void)[] = [];
  let ended = false;

  const feed: UplinkFeed = {
    feed(frame) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter === undefined) {
        backlog.push(frame);
      } else {
        waiter({ value: frame, done: false });
      }
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ value: undefined, done: true });
      }
    },
  };

  const stream: AsyncIterable<Frame> = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<Frame>> =>
          new Promise((resolve) => {
            const next = backlog.shift();
            if (next !== undefined) {
              resolve({ value: next, done: false });
            } else if (ended) {
              resolve({ value: undefined, done: true });
            } else {
              waiters.push(resolve);
            }
          }),
      };
    },
  };

  return {
    connection: {
      send: async (frame) => upstream.send(frame),
      receive: () => stream,
      close: async () => {
        feed.end();
        return Promise.resolve();
      },
    },
    feed,
  };
}
