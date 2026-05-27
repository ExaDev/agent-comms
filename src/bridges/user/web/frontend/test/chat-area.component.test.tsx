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
          connected={true}
          onSendAction={() => {}}
          onLeaveRoom={() => {
            leftCalled = true;
          }}
          onConnectToMesh={() => {}}
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
          connected={true}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
          onConnectToMesh={() => {}}
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
          connected={true}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
          onConnectToMesh={() => {}}
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
          connected={true}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
          onConnectToMesh={() => {}}
        />,
        container,
      );
      assert.strictEqual(container.querySelectorAll(".msg").length, 2);
    } finally {
      cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // Connect prompt — deferred mesh connection UI
  // -----------------------------------------------------------------------

  it("renders connect prompt when disconnected with no messages", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <ChatArea
          messages={[]}
          currentRoom={undefined}
          dmTarget={undefined}
          connected={false}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
          onConnectToMesh={() => {}}
        />,
        container,
      );
      const prompt = container.querySelector(".connect-prompt");
      assert.ok(prompt, "should render .connect-prompt");
      const btn = container.querySelector(".connect-btn");
      assert.ok(btn, "should render .connect-btn");
      assert.strictEqual(btn?.textContent, "Connect to local mesh");
    } finally {
      cleanup();
    }
  });

  it("does not render connect prompt when connected", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <ChatArea
          messages={[]}
          currentRoom={undefined}
          dmTarget={undefined}
          connected={true}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
          onConnectToMesh={() => {}}
        />,
        container,
      );
      assert.strictEqual(
        container.querySelector(".connect-prompt"),
        null,
        "should not render .connect-prompt when connected",
      );
    } finally {
      cleanup();
    }
  });

  it("does not render connect prompt when disconnected but messages exist", () => {
    const messages: DisplayMessage[] = [
      { type: "system", text: "Previous session" },
    ];
    const { container, cleanup } = setup();
    try {
      preactRender(
        <ChatArea
          messages={messages}
          currentRoom={undefined}
          dmTarget={undefined}
          connected={false}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
          onConnectToMesh={() => {}}
        />,
        container,
      );
      assert.strictEqual(
        container.querySelector(".connect-prompt"),
        null,
        "should not render .connect-prompt when messages exist",
      );
    } finally {
      cleanup();
    }
  });

  it("calls onConnectToMesh when connect button is clicked", () => {
    const { container, cleanup } = setup();
    try {
      let connectCalled = false;
      preactRender(
        <ChatArea
          messages={[]}
          currentRoom={undefined}
          dmTarget={undefined}
          connected={false}
          onSendAction={() => {}}
          onLeaveRoom={() => {}}
          onConnectToMesh={() => {
            connectCalled = true;
          }}
        />,
        container,
      );
      const btn = container.querySelector(".connect-btn")!;
      assert.ok(btn);
      btn.click();
      assert.strictEqual(connectCalled, true);
    } finally {
      cleanup();
    }
  });
});
