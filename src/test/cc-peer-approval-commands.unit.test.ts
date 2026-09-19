/**
 * Unit tests for the approval commands a cc-peer session sends back to answer a join or DM request, and the relayed text that tells it exactly what to send.
 */
import { describe, expect, it, vi } from "vitest";
import {
  answerJoinRequest,
  formatCcPeerDelivery,
  parseApprovalCommand,
} from "../bridges/cc-peer/approval-commands.js";
import type { DeliveryEvent } from "../core/types.js";

/** A device-id is a 64-character lowercase hex digest. */
const DEVICE_ID_HEX_LENGTH = 64;
const REQUESTER = "a".repeat(DEVICE_ID_HEX_LENGTH);
const OTHER = "b".repeat(DEVICE_ID_HEX_LENGTH);
const DM_ROOM = `${OTHER}+${REQUESTER}`;
const PEER_NAME = "agent-comms-front";

describe("parseApprovalCommand", () => {
  it("parses an accept naming the room and the requester", () => {
    expect(parseApprovalCommand(`accept ${DM_ROOM} ${REQUESTER}`)).toEqual({
      kind: "accept",
      room: DM_ROOM,
      requesterId: REQUESTER,
    });
  });

  it("parses a reject, keeping everything after the requester as the reason", () => {
    expect(
      parseApprovalCommand(`reject ${DM_ROOM} ${REQUESTER} not now, sorry`),
    ).toEqual({
      kind: "reject",
      room: DM_ROOM,
      requesterId: REQUESTER,
      reason: "not now, sorry",
    });
  });

  it("omits the reason when a reject has none", () => {
    expect(parseApprovalCommand(`reject ${DM_ROOM} ${REQUESTER}`)).toEqual({
      kind: "reject",
      room: DM_ROOM,
      requesterId: REQUESTER,
    });
  });

  it("is case-insensitive on the verb and tolerant of surrounding whitespace", () => {
    expect(
      parseApprovalCommand(`  ACCEPT   ${DM_ROOM}   ${REQUESTER}  \n`),
    ).toEqual({ kind: "accept", room: DM_ROOM, requesterId: REQUESTER });
  });

  it("returns undefined for anything that is not a well-formed command, so ordinary messages still relay", () => {
    for (const body of [
      "hello there",
      "accept",
      `accept ${DM_ROOM}`,
      `accept ${DM_ROOM} not-a-device-id`,
      `please accept ${DM_ROOM} ${REQUESTER}`,
      `acceptance ${DM_ROOM} ${REQUESTER}`,
      "",
    ]) {
      expect(parseApprovalCommand(body)).toBeUndefined();
    }
  });
});

describe("formatCcPeerDelivery", () => {
  const request: DeliveryEvent = {
    type: "room_join_request",
    room: DM_ROOM,
    requesterId: REQUESTER,
  };

  it("tells the session which peer to message and the exact accept and reject commands for a join request", () => {
    const text = formatCcPeerDelivery(request, PEER_NAME);

    expect(text).toContain(REQUESTER);
    expect(text).toContain(`"${PEER_NAME}"`);
    expect(text).toContain(`accept ${DM_ROOM} ${REQUESTER}`);
    expect(text).toContain(`reject ${DM_ROOM} ${REQUESTER}`);
  });

  it("leaves every other event exactly as the shared formatter renders it", () => {
    const event: DeliveryEvent = {
      type: "member_joined",
      room: "owner/room",
      agent: "someone",
    };
    expect(formatCcPeerDelivery(event, PEER_NAME)).toBe(
      "someone joined owner/room",
    );
  });
});

describe("answerJoinRequest", () => {
  const ctx = {
    agentId: "agent-1",
    harness: "claude-code",
    cwd: "/tmp/project",
    pid: 1,
  };

  it("runs room_accept for an accept command and returns the tool's own text", async () => {
    const handle = vi.fn(async () =>
      Promise.resolve({ content: "Accepted.", isError: false }),
    );

    const text = await answerJoinRequest(
      { tool: { handle }, ctx },
      { kind: "accept", room: DM_ROOM, requesterId: REQUESTER },
    );

    expect(handle).toHaveBeenCalledWith(ctx, {
      action: "room_accept",
      room: DM_ROOM,
      requesterId: REQUESTER,
    });
    expect(text).toBe("Accepted.");
  });

  it("runs room_reject with the reason for a reject command", async () => {
    const handle = vi.fn(async () =>
      Promise.resolve({ content: "Rejected.", isError: false }),
    );

    await answerJoinRequest(
      { tool: { handle }, ctx },
      { kind: "reject", room: DM_ROOM, requesterId: REQUESTER, reason: "busy" },
    );

    expect(handle).toHaveBeenCalledWith(ctx, {
      action: "room_reject",
      room: DM_ROOM,
      requesterId: REQUESTER,
      reason: "busy",
    });
  });

  it("returns a failure's own text so the session learns why nothing happened", async () => {
    const handle = vi.fn(async () =>
      Promise.resolve({
        content: "Failed to accept: No pending room.join",
        isError: true,
      }),
    );

    const text = await answerJoinRequest(
      { tool: { handle }, ctx },
      { kind: "accept", room: DM_ROOM, requesterId: REQUESTER },
    );

    expect(text).toBe("Failed to accept: No pending room.join");
  });
});
