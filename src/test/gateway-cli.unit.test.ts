/**
 * `agent-comms gateway redeem`: it refuses without a terminal, shows the device and whether the code is signed before asking, trusts only on a typed yes, and trusts through the same ledger call as the tool.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { runGatewayCommand, type GatewayCliIo } from "../gateway-cli.js";
import { ConnectionCodeLedger } from "../core/connection-code.js";
import { GatewayTrust } from "../core/gateway-trust.js";
import type { ConnectionCode } from "../core/types.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

/** A device-id is 32 bytes. */
const DEVICE_ID_BYTES = 32;
const DEVICE = "ab".repeat(DEVICE_ID_BYTES);

function io(
  overrides: Readonly<{
    terminal?: boolean;
    code?: string;
    answer?: string;
    redeem?: GatewayCliIo["redeem"];
  }>,
) {
  const lines: string[] = [];
  const asked: string[] = [];
  const readSecret = vi.fn(async () => Promise.resolve(overrides.code ?? ""));
  const value: GatewayCliIo = {
    stdinIsTerminal: overrides.terminal ?? true,
    readSecret,
    ask: async (question) => {
      asked.push(question);
      return Promise.resolve(overrides.answer ?? "");
    },
    log: (line) => {
      lines.push(line);
    },
    ...(overrides.redeem !== undefined && { redeem: overrides.redeem }),
  };
  return { value, lines, asked, readSecret };
}

async function unsignedCode(): Promise<ConnectionCode> {
  return new ConnectionCodeLedger().generate(DEVICE);
}

function stubRedeem() {
  return vi.fn<NonNullable<GatewayCliIo["redeem"]>>(async () =>
    Promise.resolve({ deviceId: DEVICE }),
  );
}

describe("agent-comms gateway redeem", () => {
  it("refuses when stdin is not a terminal, before reading anything", async () => {
    const redeem = stubRedeem();
    const surroundings = io({ terminal: false, redeem });

    await expect(
      runGatewayCommand(["redeem"], surroundings.value),
    ).rejects.toThrow("needs a terminal");

    expect(surroundings.readSecret).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    [["trust"]],
    [["redeem", "--bogus", "x"]],
    [["redeem", "--public-key"]],
  ])("refuses the arguments %j with the usage", async (args) => {
    await expect(
      runGatewayCommand(args, io({ redeem: stubRedeem() }).value),
    ).rejects.toThrow("Usage: agent-comms gateway redeem");
  });

  it("refuses text that is not a connection code", async () => {
    const redeem = stubRedeem();

    await expect(
      runGatewayCommand(["redeem"], io({ code: "{ nope", redeem }).value),
    ).rejects.toThrow("not a connection code");
    await expect(
      runGatewayCommand(
        ["redeem"],
        io({ code: '{"code":"c","expiresAt":"soon","deviceId":"d"}', redeem })
          .value,
      ),
    ).rejects.toThrow("not a connection code");
    expect(redeem).not.toHaveBeenCalled();
  });

  it("shows the device and says an unsigned code is unsigned, before it asks", async () => {
    const code = await unsignedCode();
    const surroundings = io({
      code: JSON.stringify(code),
      answer: "no",
      redeem: stubRedeem(),
    });

    await expect(
      runGatewayCommand(["redeem"], surroundings.value),
    ).rejects.toThrow("Not confirmed");

    expect(surroundings.lines.join("\n")).toContain(DEVICE);
    expect(surroundings.lines.join("\n")).toContain("NOT signed");
    expect(surroundings.asked[0]).toContain(DEVICE);
  });

  it.each(["", "y", "no", "yes please", "Yes!"])(
    "trusts nothing on the answer %j",
    async (answer) => {
      const redeem = stubRedeem();
      const code = await unsignedCode();

      await expect(
        runGatewayCommand(
          ["redeem"],
          io({ code: JSON.stringify(code), answer, redeem }).value,
        ),
      ).rejects.toThrow("Not confirmed");

      expect(redeem).not.toHaveBeenCalled();
    },
  );

  it.each(["yes", " YES ", "Yes"])(
    "redeems on the answer %j and says what it trusted",
    async (answer) => {
      const redeem = stubRedeem();
      const code = await unsignedCode();
      const surroundings = io({ code: JSON.stringify(code), answer, redeem });

      await runGatewayCommand(["redeem"], surroundings.value);

      expect(redeem).toHaveBeenCalledWith(code, {});
      expect(surroundings.lines.at(-1)).toContain(`Trusted device ${DEVICE}`);
    },
  );

  it("passes a fingerprint and the contents of a key file to the redemption", async () => {
    const redeem = stubRedeem();
    const keyFile = path.join(
      scratchDirectory("agent-comms-gateway-cli-"),
      "key.asc",
    );
    fs.writeFileSync(keyFile, "armored key text");
    const code = { ...(await unsignedCode()), signature: "sig" };

    await runGatewayCommand(
      ["redeem", "--public-key", keyFile, "--fingerprint", "aabb"],
      io({ code: JSON.stringify(code), answer: "yes", redeem }).value,
    );

    expect(redeem).toHaveBeenCalledWith(code, {
      publicKeyArmored: "armored key text",
      expectedFingerprint: "aabb",
    });
  });
});

describe("agent-comms gateway redeem on this machine", () => {
  let dir: string;
  beforeEach(() => {
    dir = scratchDirectory("agent-comms-gateway-cli-disk-");
    vi.stubEnv("AGENT_COMMS_DATA_DIR", dir);
  });

  it("adds the device to the trusted set every bridge reads, and spends the code", async () => {
    const code = await unsignedCode();
    const surroundings = io({ code: JSON.stringify(code), answer: "yes" });

    await runGatewayCommand(["redeem"], surroundings.value);

    expect(new GatewayTrust({ location: { dataDir: dir } }).list()).toEqual([
      DEVICE,
    ]);
    await expect(
      runGatewayCommand(
        ["redeem"],
        io({ code: JSON.stringify(code), answer: "yes" }).value,
      ),
    ).rejects.toThrow("already been redeemed");
    vi.unstubAllEnvs();
  });

  it("trusts nothing when the answer is not yes", async () => {
    const code = await unsignedCode();

    await expect(
      runGatewayCommand(
        ["redeem"],
        io({ code: JSON.stringify(code), answer: "no" }).value,
      ),
    ).rejects.toThrow("Not confirmed");

    expect(new GatewayTrust({ location: { dataDir: dir } }).list()).toEqual([]);
    vi.unstubAllEnvs();
  });
});
