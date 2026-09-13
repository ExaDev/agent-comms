/**
 * Component interaction tests for JoinForm.
 */

import { describe, it, expect } from "vitest";
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
        <JoinForm visible={false} onSubmit={() => {}} onCancel={() => {}} />,
        container,
      );
      const form = container.querySelector("#join-form")!;
      expect(form.classList.contains("hidden")).toBeTruthy();
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
      const btn = container.querySelector(".join-submit")!;
      btn.click();
      expect(submitted).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("renders input and submit button when visible", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <JoinForm visible={true} onSubmit={() => {}} onCancel={() => {}} />,
        container,
      );
      const input = container.querySelector("input.join-input")!;
      expect(input).toBeTruthy();
      expect(input.getAttribute("placeholder")).toBe("Room name...");

      const btn = container.querySelector("button.join-submit")!;
      expect(btn).toBeTruthy();
      expect(btn.textContent).toBe("Join");
    } finally {
      cleanup();
    }
  });
});
