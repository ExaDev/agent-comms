/**
 * Component interaction tests for JoinForm.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render as preactRender } from "preact";
import { act } from "preact/test-utils";
import { Window } from "happy-dom";
import { JoinForm } from "../components/JoinForm.js";

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

describe("JoinForm interactions", () => {
  it("renders hidden when not visible", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <JoinForm
          visible={false}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
        container,
      );
      const form = container.querySelector("#join-form") as HTMLElement;
      assert.ok(form.classList.contains("hidden"));
    } finally {
      cleanup();
    }
  });

  it("does not call onSubmit when room name is empty", () => {
    const { container, cleanup } = setup();
    try {
      let submitted = false;
      preactRender(
        <JoinForm
          visible={true}
          onSubmit={() => {
            submitted = true;
          }}
          onCancel={() => {}}
        />,
        container,
      );
      const btn = container.querySelector(
        ".join-submit",
      ) as HTMLElement;
      btn.click();
      assert.strictEqual(submitted, false);
    } finally {
      cleanup();
    }
  });

  it("renders input and submit button when visible", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <JoinForm
          visible={true}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
        container,
      );
      const input = container.querySelector(
        "input.join-input",
      ) as HTMLInputElement;
      assert.ok(input);
      assert.strictEqual(input.getAttribute("placeholder"), "Room name...");

      const btn = container.querySelector(
        "button.join-submit",
      ) as HTMLElement;
      assert.ok(btn);
      assert.strictEqual(btn.textContent, "Join");
    } finally {
      cleanup();
    }
  });
});
