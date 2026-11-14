/**
 * The content of a message sent through the tool is limited to the one size every path that takes message text shares, counted in UTF-8 bytes, and a message over it is refused with a clear error before anything is sent.
 */

import { describe, expect, it } from "vitest";
import { buildAction } from "../core/bridge.js";
import {
  MAX_MESSAGE_BYTES,
  MESSAGE_TOO_LARGE,
} from "../core/message-limits.js";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { wireTestTransport } from "./test-transport.js";

/** Two bytes in UTF-8, one UTF-16 code unit. */
const TWO_BYTE_CHAR = "é";
const BYTES_PER_TWO_BYTE_CHAR = 2;

async function toolWithAgent(): Promise<{
  tool: CommsTool;
  ctx: { agentId: string; harness: string; cwd: string; pid: number };
  sent: () => number;
}> {
  const store = new MeshStore();
  await wireTestTransport(store);
  const agent = await store.registerAgent({
    name: "sender",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  let sends = 0;
  const sendRoomMessage = store.sendRoomMessage.bind(store);
  store.sendRoomMessage = async (...args) => {
    sends += 1;
    return sendRoomMessage(...args);
  };
  const sendDm = store.sendDm.bind(store);
  store.sendDm = async (...args) => {
    sends += 1;
    return sendDm(...args);
  };
  return {
    tool: new CommsTool(store),
    ctx: { agentId: agent.id, harness: "pi", cwd: "/tmp/p", pid: process.pid },
    sent: () => sends,
  };
}

const ACTIONS = ["send", "dm"] as const;

describe.each(ACTIONS)("the %s action", (action) => {
  it("refuses content one byte over the limit, naming the limit, without sending", async () => {
    const { tool, ctx, sent } = await toolWithAgent();

    const result = await tool.handle(
      ctx,
      buildAction({
        action,
        target: "somewhere",
        content: "a".repeat(MAX_MESSAGE_BYTES + 1),
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(MESSAGE_TOO_LARGE);
    expect(result.content).toContain(String(MAX_MESSAGE_BYTES));
    expect(sent()).toBe(0);
  });

  it("counts bytes, not characters", async () => {
    const { tool, ctx, sent } = await toolWithAgent();

    const result = await tool.handle(
      ctx,
      buildAction({
        action,
        target: "somewhere",
        content: TWO_BYTE_CHAR.repeat(
          MAX_MESSAGE_BYTES / BYTES_PER_TWO_BYTE_CHAR + 1,
        ),
      }),
    );

    expect(result.content).toContain(MESSAGE_TOO_LARGE);
    expect(sent()).toBe(0);
  });

  it("does not refuse content of exactly the limit for its size", async () => {
    const { tool, ctx, sent } = await toolWithAgent();

    const result = await tool.handle(
      ctx,
      buildAction({
        action,
        target: "somewhere",
        content: "a".repeat(MAX_MESSAGE_BYTES),
      }),
    );

    expect(result.content).not.toContain(MESSAGE_TOO_LARGE);
    expect(sent()).toBe(1);
  });

  it("never repeats the content in the error", async () => {
    const { tool, ctx } = await toolWithAgent();

    const result = await tool.handle(
      ctx,
      buildAction({
        action,
        target: "somewhere",
        content: "x".repeat(MAX_MESSAGE_BYTES + 1),
      }),
    );

    expect(result.content.length).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});
