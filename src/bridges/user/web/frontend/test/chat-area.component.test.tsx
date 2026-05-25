/**
 * Component interaction tests for ChatArea.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render as preactRender } from "preact";
import { Window } from "happy-dom";
import { ChatArea } from "../components/ChatArea.js";
import type { DisplayMessage } from "../types.js";

let windowRef: Window | undefined;

function setup(): { container: HTMLElement; cleanup: () => void } {
  windowRef = new Window();
  const doc = (windowRef as unknown as { document: Document }).document;
  (globalThis as Record<string, unknown>).document = doc;
  const container = doc.createElement("div");
  return {
    container,
    cleanup: () => {
      delete (globalThis as Record<string, unknown>).document;
      windowRef?.close();
      windowRef = undefined;
    },
  };
}

describe("ChatArea interactions", () => {
  it("calls onLeaveRoom when leave button is clicked", () => {
    const { container, cleanup } = setup();
    try {
      let leftCalled = false;
      preactRender(
        <ChatArea
          messages={[]}
          currentRoom="room-1"
          dmTarget={undefined}
          onSendAction={() => {}}
          onLeaveRoom={() => {
            leftCalled = true;
          }}
        />,
        container,
      );
      const btn = container.querySelector(".leave-btn")!;
      assert.ok(btn);
      btn.click();
      assert.strictEqual(leftCalled, true);
    } finally {
      cleanup();
    }
  });

  it("does not render leave button when no room is active", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <ChatArea
          messages={[]}
          currentRoom={undefined}
          dmTarget={undefined}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
        />,
        container,
      );
      assert.strictEqual(container.querySelector(".leave-btn"), null);
    } finally {
      cleanup();
    }
  });

  it("renders send button", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <ChatArea
          messages={[]}
          currentRoom={undefined}
          dmTarget={undefined}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
        />,
        container,
      );
      const btn = container.querySelector("#send-btn")!;
      assert.ok(btn);
      assert.strictEqual(btn.textContent, "Send");
    } finally {
      cleanup();
    }
  });

  it("renders messages", () => {
    const messages: DisplayMessage[] = [
      {
        type: "chat",
        sender: "A",
        content: "Hi",
        timestamp: "2025-05-23T14:30:45Z",
      },
      { type: "system", text: "Joined" },
    ];
    const { container, cleanup } = setup();
    try {
      preactRender(
        <ChatArea
          messages={messages}
          currentRoom="r1"
          dmTarget={undefined}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
        />,
        container,
      );
      assert.strictEqual(container.querySelectorAll(".msg").length, 2);
    } finally {
      cleanup();
    }
  });
});
