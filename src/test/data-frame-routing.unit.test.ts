/**
 * routeRelayedDataFrame's gates (agent-comms#358): a core/data frame that arrived through a relay pairing is acted on only when it names one of the account's writer logs and its authenticated sender holds the same account.
 */

import { describe, expect, it, vi } from "vitest";
import type { DataHaveFrame } from "wire-mesh-core/generated/protocol";
import type { AccountLedgerReplica } from "../core/account-ledger.js";
import {
  routeRelayedDataFrame,
  type AccountReplication,
  type HubDataChannel,
} from "../core/data-frame-routing.js";

const SENDER = "sender-device";
const LOG_ID_BYTES = Uint8Array.from({ length: 4 }, (_, i) => i);

function haveFrame(): DataHaveFrame {
  return {
    type: "data-have",
    peer: LOG_ID_BYTES,
    "head-seq": 0,
  };
}

function setup(
  options: Readonly<{ ownsLog: boolean; isAccountPeer: boolean }>,
) {
  const reply = haveFrame();
  const handleDataFrame = vi.fn(async () => reply);
  const ledger: AccountLedgerReplica = {
    ownsLog: () => options.ownsLog,
    handleDataFrame,
    announcements: async () => [],
  };
  const account: AccountReplication = {
    ledger: () => ledger,
    isAccountPeer: async () => options.isAccountPeer,
  };
  const send = vi.fn(async (): Promise<void> => {
    // Resolves with nothing, like a send that succeeded.
  });
  const hub: HubDataChannel = { peers: () => [], send };
  return { account, hub, handleDataFrame, send, reply };
}

describe("routeRelayedDataFrame", () => {
  it("answers an account peer's frame for an account log through the same pairing", async () => {
    const { account, hub, handleDataFrame, send, reply } = setup({
      ownsLog: true,
      isAccountPeer: true,
    });
    const frame = haveFrame();

    await routeRelayedDataFrame(
      { account, hub, onError: undefined },
      SENDER,
      frame,
    );

    expect(handleDataFrame).toHaveBeenCalledWith(frame);
    expect(send).toHaveBeenCalledWith(SENDER, reply);
  });

  it("drops a frame from a device that does not hold the account", async () => {
    const { account, hub, handleDataFrame, send } = setup({
      ownsLog: true,
      isAccountPeer: false,
    });

    await routeRelayedDataFrame(
      { account, hub, onError: undefined },
      SENDER,
      haveFrame(),
    );

    expect(handleDataFrame).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("drops a frame about a log that is not one of the account's", async () => {
    const { account, hub, handleDataFrame, send } = setup({
      ownsLog: false,
      isAccountPeer: true,
    });

    await routeRelayedDataFrame(
      { account, hub, onError: undefined },
      SENDER,
      haveFrame(),
    );

    expect(handleDataFrame).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a failure to answer and does not throw", async () => {
    const { account, hub, send } = setup({
      ownsLog: true,
      isAccountPeer: true,
    });
    send.mockRejectedValue(new Error("no pairing"));
    const errors: Error[] = [];

    await routeRelayedDataFrame(
      {
        account,
        hub,
        onError: (error) => {
          errors.push(error);
        },
      },
      SENDER,
      haveFrame(),
    );

    expect(errors.map((error) => error.message)).toEqual(["no pairing"]);
  });
});
