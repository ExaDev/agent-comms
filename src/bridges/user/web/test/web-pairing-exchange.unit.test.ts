/**
 * The bridge's half of the proof exchange: the proof keys over the role, both nonces in order and the port; a ticket is single use, short lived and tied to the secret in force; and one hello socket answers only a well-formed exchange under the right secret, refusing every other message the same way.
 */

import { EventEmitter } from "node:events";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDirectory } from "../../../../test/scratch-directory.helper.js";
import { proofFor } from "../pairing-handshake.js";
import { HEX_32_PATTERN, type ProofTranscript } from "../pairing-protocol.js";
import {
  HELLO_TIMEOUT_MS,
  MAX_PENDING_TICKETS,
  ROTATION_SWEEP_MS,
  TICKET_LIFETIME_MS,
  computeProof,
  createHostedSocketGuard,
  createTicketBook,
  proofMatches,
  serveHello,
} from "../web-pairing-exchange.js";
import { openPairingSecret, rotatePairingSecret } from "../web-pairing.js";

const HEX_LENGTH = 64;
const SECRET = "a".repeat(HEX_LENGTH);
const OTHER_SECRET = "b".repeat(HEX_LENGTH);
const CLIENT_NONCE = "1".repeat(HEX_LENGTH);
const BRIDGE_NONCE = "2".repeat(HEX_LENGTH);
const OTHER_NONCE = "3".repeat(HEX_LENGTH);
const MS_PER_SECOND = 1000;
const PORT = 19_877;
const OTHER_PORT = 19_878;
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_NORMAL = 1000;
const ONE_MS = 1;

function freshDir(): string {
  return path.join(scratchDirectory("agent-comms-exchange-"), "state");
}

describe("the proof", () => {
  it("matches the same exchange under the same secret", () => {
    const proof = computeProof(SECRET, {
      role: "bridge",
      clientNonce: CLIENT_NONCE,
      bridgeNonce: BRIDGE_NONCE,
      port: PORT,
    });

    expect(proof).toMatch(HEX_32_PATTERN);
    expect(
      proofMatches(proof, SECRET, {
        role: "bridge",
        clientNonce: CLIENT_NONCE,
        bridgeNonce: BRIDGE_NONCE,
        port: PORT,
      }),
    ).toBe(true);
  });

  const GENUINE: ProofTranscript = {
    role: "bridge",
    clientNonce: CLIENT_NONCE,
    bridgeNonce: BRIDGE_NONCE,
    port: PORT,
  };

  it.each([
    ["another secret", OTHER_SECRET, GENUINE],
    ["the other role", SECRET, { ...GENUINE, role: "client" }],
    [
      "swapped nonces",
      SECRET,
      { ...GENUINE, clientNonce: BRIDGE_NONCE, bridgeNonce: CLIENT_NONCE },
    ],
    ["another client nonce", SECRET, { ...GENUINE, clientNonce: OTHER_NONCE }],
    ["another bridge nonce", SECRET, { ...GENUINE, bridgeNonce: OTHER_NONCE }],
    ["another port", SECRET, { ...GENUINE, port: OTHER_PORT }],
  ] as const)("does not match when %s differs", (_name, secret, transcript) => {
    const proof = computeProof(SECRET, GENUINE);

    expect(proofMatches(proof, secret, transcript)).toBe(false);
  });

  it("is refused when it is not a proof's length", () => {
    expect(
      proofMatches("ab", SECRET, {
        role: "bridge",
        clientNonce: CLIENT_NONCE,
        bridgeNonce: BRIDGE_NONCE,
        port: PORT,
      }),
    ).toBe(false);
    expect(
      proofMatches("", SECRET, {
        role: "bridge",
        clientNonce: CLIENT_NONCE,
        bridgeNonce: BRIDGE_NONCE,
        port: PORT,
      }),
    ).toBe(false);
  });

  it("is the same value the browser's Web Crypto computes, for either role", async () => {
    for (const role of ["bridge", "client"] as const) {
      expect(
        await proofFor(SECRET, {
          role: role,
          clientNonce: CLIENT_NONCE,
          bridgeNonce: BRIDGE_NONCE,
          port: PORT,
        }),
      ).toBe(
        computeProof(SECRET, {
          role: role,
          clientNonce: CLIENT_NONCE,
          bridgeNonce: BRIDGE_NONCE,
          port: PORT,
        }),
      );
    }
  });
});

describe("the tickets", () => {
  it("admits a ticket once and never again", () => {
    const book = createTicketBook(openPairingSecret({ dir: freshDir() }));
    const ticket = book.issue();

    expect(ticket).toMatch(HEX_32_PATTERN);
    expect(book.consume(ticket)).toBe(true);
    expect(book.consume(ticket)).toBe(false);
  });

  it("refuses a ticket nobody issued, and no ticket", () => {
    const book = createTicketBook(openPairingSecret({ dir: freshDir() }));
    book.issue();

    expect(book.consume("0".repeat(HEX_LENGTH))).toBe(false);
    expect(book.consume(undefined)).toBe(false);
  });

  it("refuses a ticket once its lifetime has passed, and the one a refused ticket was not", () => {
    let now = 0;
    const book = createTicketBook(
      openPairingSecret({ dir: freshDir() }),
      () => now,
    );
    const stale = book.issue();
    const fresh = book.issue();
    now = TICKET_LIFETIME_MS - ONE_MS;
    const lastMoment = book.issue();

    now = TICKET_LIFETIME_MS;
    expect(book.consume(stale)).toBe(false);
    expect(book.consume(fresh)).toBe(false);
    expect(book.consume(lastMoment)).toBe(true);
  });

  it("issues no more than the cap at once, and issues again once some are spent or have lapsed", () => {
    let now = 0;
    const book = createTicketBook(
      openPairingSecret({ dir: freshDir() }),
      () => now,
    );
    const issued = Array.from({ length: MAX_PENDING_TICKETS }, () =>
      book.issue(),
    );

    expect(book.issue()).toBeUndefined();
    expect(book.consume(issued[0])).toBe(true);
    expect(book.issue()).toBeDefined();
    expect(book.issue()).toBeUndefined();
    now = TICKET_LIFETIME_MS;
    expect(book.issue()).toBeDefined();
  });

  it("refuses a ticket issued under a secret that has since been replaced, and spends it", () => {
    const dir = freshDir();
    const secret = openPairingSecret({ dir });
    const book = createTicketBook(secret);
    const ticket = book.issue();

    rotatePairingSecret(dir);

    expect(book.consume(ticket)).toBe(false);
    expect(book.consume(ticket)).toBe(false);
  });

  it("accepts a ticket issued under the secret now in force after another was replaced", () => {
    const dir = freshDir();
    const book = createTicketBook(openPairingSecret({ dir }));
    rotatePairingSecret(dir);
    const ticket = book.issue();

    expect(book.consume(ticket)).toBe(true);
  });
});

interface FakeSocket extends EventEmitter {
  sent: string[];
  closed: number[];
  terminated: boolean;
  send: (data: string, callback?: () => void) => void;
  close: (code?: number) => void;
  terminate: () => void;
}

function fakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.sent = [];
  socket.closed = [];
  socket.terminated = false;
  socket.send = (data, callback) => {
    socket.sent.push(data);
    callback?.();
  };
  socket.close = (code) => {
    socket.closed.push(code ?? 0);
    socket.emit("close");
  };
  socket.terminate = () => {
    socket.terminated = true;
  };
  return socket;
}

function say(socket: FakeSocket, message: unknown, binary = false): void {
  socket.emit("message", Buffer.from(JSON.stringify(message)), binary);
}

describe("one hello socket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function serve(dir = freshDir()): {
    socket: FakeSocket;
    dir: string;
    tickets: ReturnType<typeof createTicketBook>;
  } {
    const secret = openPairingSecret({ dir });
    const tickets = createTicketBook(secret);
    const socket = fakeSocket();
    serveHello(socket, { secret, tickets, port: () => PORT });
    return { socket, dir, tickets };
  }

  function secretOf(dir: string): string {
    return openPairingSecret({ dir }).current();
  }

  function reply(socket: FakeSocket): { nonce: string; proof: string } {
    return JSON.parse(socket.sent[0] ?? "{}") as {
      nonce: string;
      proof: string;
    };
  }

  it("answers a nonce with its own nonce and a proof the dashboard can check, then a ticket for a right proof, and closes", () => {
    const { socket, dir, tickets } = serve();
    const secret = secretOf(dir);

    say(socket, { type: "hello", nonce: CLIENT_NONCE });
    const answer = reply(socket);
    expect(
      proofMatches(answer.proof, secret, {
        role: "bridge",
        clientNonce: CLIENT_NONCE,
        bridgeNonce: answer.nonce,
        port: PORT,
      }),
    ).toBe(true);
    say(socket, {
      type: "auth",
      proof: computeProof(secret, {
        role: "client",
        clientNonce: CLIENT_NONCE,
        bridgeNonce: answer.nonce,
        port: PORT,
      }),
    });

    const ticket = (JSON.parse(socket.sent[1] ?? "{}") as { ticket: string })
      .ticket;
    expect(tickets.consume(ticket)).toBe(true);
    expect(socket.closed).toEqual([CLOSE_NORMAL]);
  });

  it("sends the secret nowhere in what it says", () => {
    const { socket, dir } = serve();
    const secret = secretOf(dir);

    say(socket, { type: "hello", nonce: CLIENT_NONCE });
    const answer = reply(socket);
    say(socket, {
      type: "auth",
      proof: computeProof(secret, {
        role: "client",
        clientNonce: CLIENT_NONCE,
        bridgeNonce: answer.nonce,
        port: PORT,
      }),
    });

    expect(socket.sent.join("")).not.toContain(secret);
  });

  it("uses a nonce of its own for every exchange", () => {
    const dir = freshDir();
    const first = serve(dir);
    const second = serve(dir);

    say(first.socket, { type: "hello", nonce: CLIENT_NONCE });
    say(second.socket, { type: "hello", nonce: CLIENT_NONCE });

    expect(reply(first.socket).nonce).not.toBe(reply(second.socket).nonce);
    expect(reply(first.socket).proof).not.toBe(reply(second.socket).proof);
  });

  function refused(socket: FakeSocket): void {
    expect(socket.closed).toEqual([CLOSE_POLICY_VIOLATION]);
    expect(socket.sent.filter((text) => text.includes("ticket"))).toEqual([]);
  }

  it.each([
    [
      "a binary message",
      (s: FakeSocket) => {
        say(s, { type: "hello", nonce: CLIENT_NONCE }, true);
      },
    ],
    [
      "text that is not JSON",
      (s: FakeSocket) => {
        s.emit("message", Buffer.from("{ no"), false);
      },
    ],
    [
      "an auth before a hello",
      (s: FakeSocket) => {
        say(s, { type: "auth", proof: OTHER_NONCE });
      },
    ],
    [
      "a hello with a short nonce",
      (s: FakeSocket) => {
        say(s, { type: "hello", nonce: "ab" });
      },
    ],
    [
      "a hello with a nonce in upper case",
      (s: FakeSocket) => {
        say(s, { type: "hello", nonce: "A".repeat(HEX_LENGTH) });
      },
    ],
    [
      "an array",
      (s: FakeSocket) => {
        say(s, []);
      },
    ],
    [
      "null",
      (s: FakeSocket) => {
        say(s, null);
      },
    ],
  ])("refuses %s", (_name, act) => {
    const { socket } = serve();

    act(socket);

    refused(socket);
  });

  it("refuses a proof under another secret", () => {
    const { socket } = serve();
    say(socket, { type: "hello", nonce: CLIENT_NONCE });
    const answer = reply(socket);

    say(socket, {
      type: "auth",
      proof: computeProof(OTHER_SECRET, {
        role: "client",
        clientNonce: CLIENT_NONCE,
        bridgeNonce: answer.nonce,
        port: PORT,
      }),
    });

    refused(socket);
  });

  it("refuses a proof computed for another port", () => {
    const { socket, dir } = serve();
    say(socket, { type: "hello", nonce: CLIENT_NONCE });
    const answer = reply(socket);

    say(socket, {
      type: "auth",
      proof: computeProof(secretOf(dir), {
        role: "client",
        clientNonce: CLIENT_NONCE,
        bridgeNonce: answer.nonce,
        port: OTHER_PORT,
      }),
    });

    refused(socket);
  });

  it("refuses the bridge's own proof offered back as the dashboard's", () => {
    const { socket } = serve();
    say(socket, { type: "hello", nonce: CLIENT_NONCE });
    const answer = reply(socket);

    say(socket, { type: "auth", proof: answer.proof });

    refused(socket);
  });

  it("refuses a proof recorded from an earlier exchange", () => {
    const dir = freshDir();
    const earlier = serve(dir);
    say(earlier.socket, { type: "hello", nonce: CLIENT_NONCE });
    const recorded = computeProof(secretOf(dir), {
      role: "client",
      clientNonce: CLIENT_NONCE,
      bridgeNonce: reply(earlier.socket).nonce,
      port: PORT,
    });
    const later = serve(dir);
    say(later.socket, { type: "hello", nonce: CLIENT_NONCE });

    say(later.socket, { type: "auth", proof: recorded });

    refused(later.socket);
  });

  it("refuses a proof when the secret was replaced between the hello and the auth", () => {
    const { socket, dir, tickets } = serve();
    const secret = secretOf(dir);
    say(socket, { type: "hello", nonce: CLIENT_NONCE });
    const answer = reply(socket);

    rotatePairingSecret(dir);
    say(socket, {
      type: "auth",
      proof: computeProof(secret, {
        role: "client",
        clientNonce: CLIENT_NONCE,
        bridgeNonce: answer.nonce,
        port: PORT,
      }),
    });

    refused(socket);
    expect(tickets.issue()).toBeDefined();
  });

  it("refuses when too many tickets are waiting", () => {
    const dir = freshDir();
    const secret = openPairingSecret({ dir });
    const tickets = createTicketBook(secret);
    for (let n = 0; n < MAX_PENDING_TICKETS; n++) tickets.issue();
    const socket = fakeSocket();
    serveHello(socket, { secret, tickets, port: () => PORT });
    say(socket, { type: "hello", nonce: CLIENT_NONCE });
    const answer = reply(socket);

    say(socket, {
      type: "auth",
      proof: computeProof(secret.current(), {
        role: "client",
        clientNonce: CLIENT_NONCE,
        bridgeNonce: answer.nonce,
        port: PORT,
      }),
    });

    refused(socket);
  });

  it("refuses a second hello", () => {
    const { socket } = serve();
    say(socket, { type: "hello", nonce: CLIENT_NONCE });

    say(socket, { type: "hello", nonce: OTHER_NONCE });

    refused(socket);
  });

  it("closes a socket that says nothing within the timeout, and not before", () => {
    const { socket } = serve();

    vi.advanceTimersByTime(HELLO_TIMEOUT_MS - ONE_MS);
    expect(socket.closed).toEqual([]);
    vi.advanceTimersByTime(ONE_MS);

    refused(socket);
  });

  it("closes a socket that began an exchange and never finished it", () => {
    const { socket } = serve();
    say(socket, { type: "hello", nonce: CLIENT_NONCE });

    vi.advanceTimersByTime(HELLO_TIMEOUT_MS);

    refused(socket);
  });

  it("ends its connection on a socket error", () => {
    const { socket } = serve();

    socket.emit("error", new Error("reset"));

    expect(socket.terminated).toBe(true);
  });
});

describe("the sockets admitted to the hosted dashboard", () => {
  function fakeAdmitted(): EventEmitter & {
    closed: number[];
    close: (code?: number) => void;
  } {
    const socket = new EventEmitter() as EventEmitter & {
      closed: number[];
      close: (code?: number) => void;
    };
    socket.closed = [];
    socket.close = (code) => {
      socket.closed.push(code ?? 0);
      socket.emit("close");
    };
    return socket;
  }

  it("keeps a socket while its secret is in force, and closes it when the secret is replaced", () => {
    const dir = freshDir();
    const guard = createHostedSocketGuard(openPairingSecret({ dir }));
    const socket = fakeAdmitted();
    guard.track(socket);

    expect(guard.check(socket)).toBe(true);
    guard.sweep();
    expect(socket.closed).toEqual([]);

    rotatePairingSecret(dir);

    expect(guard.check(socket)).toBe(false);
    expect(socket.closed).toEqual([CLOSE_POLICY_VIOLATION]);
  });

  it("closes an idle socket on the sweep, every socket that was admitted under the old secret, and none admitted after", () => {
    const dir = freshDir();
    const guard = createHostedSocketGuard(openPairingSecret({ dir }));
    const before = [fakeAdmitted(), fakeAdmitted()];
    for (const socket of before) guard.track(socket);

    rotatePairingSecret(dir);
    const after = fakeAdmitted();
    guard.track(after);
    guard.sweep();

    expect(before.map((socket) => socket.closed)).toEqual([
      [CLOSE_POLICY_VIOLATION],
      [CLOSE_POLICY_VIOLATION],
    ]);
    expect(after.closed).toEqual([]);
  });

  it("does not hold a socket that closed itself", () => {
    const dir = freshDir();
    const guard = createHostedSocketGuard(openPairingSecret({ dir }));
    const socket = fakeAdmitted();
    guard.track(socket);
    socket.close();

    rotatePairingSecret(dir);
    guard.sweep();

    expect(socket.closed).toEqual([0]);
  });

  it("sweeps often enough that a revoked socket does not outlive a rotation by long", () => {
    expect(ROTATION_SWEEP_MS).toBeLessThanOrEqual(MS_PER_SECOND);
  });
});
