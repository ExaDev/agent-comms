/**
 * Unit tests for CreateRoomForm component.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render as preactRender } from "preact";
import { Window } from "happy-dom";
import { CreateRoomForm } from "../components/CreateRoomForm.js";

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

describe("CreateRoomForm", () => {
  it("renders nothing when not visible", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <CreateRoomForm
          visible={false}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
        container,
      );
      const form = container.querySelector("form");
      assert.strictEqual(form, null);
    } finally {
      cleanup();
    }
  });

  it("renders form with name, type, and description inputs", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <CreateRoomForm
          visible={true}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
        container,
      );

      const nameInput = container.querySelector(
        "input[name='room-name']",
      ) as HTMLInputElement;
      assert.ok(nameInput, "room name input should exist");
      assert.strictEqual(
        nameInput.getAttribute("placeholder"),
        "e.g. project-alpha",
      );

      const typeSelect = container.querySelector(
        "select[name='room-type']",
      ) as HTMLSelectElement;
      assert.ok(typeSelect, "room type select should exist");
      assert.strictEqual(typeSelect.value, "public");

      const descInput = container.querySelector(
        "input[name='room-description']",
      ) as HTMLInputElement;
      assert.ok(descInput, "description input should exist");
    } finally {
      cleanup();
    }
  });

  it("renders all three room type options", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <CreateRoomForm
          visible={true}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
        container,
      );

      const options = container.querySelectorAll("select option");
      assert.strictEqual(options.length, 3);
      assert.ok(options[0]);
      assert.ok(options[1]);
      assert.ok(options[2]);
      assert.strictEqual(options[0].getAttribute("value"), "public");
      assert.strictEqual(options[1].getAttribute("value"), "private");
      assert.strictEqual(options[2].getAttribute("value"), "secret");
    } finally {
      cleanup();
    }
  });

  it("renders submit and cancel buttons", () => {
    const { container, cleanup } = setup();
    try {
      preactRender(
        <CreateRoomForm
          visible={true}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
        container,
      );

      const submitBtn = container.querySelector(
        "button.create-room-submit",
      ) as HTMLElement;
      assert.ok(submitBtn);
      assert.strictEqual(submitBtn.textContent, "Create");

      const cancelBtn = container.querySelector(
        "button.create-room-cancel",
      ) as HTMLElement;
      assert.ok(cancelBtn);
      assert.strictEqual(cancelBtn.textContent, "Cancel");
    } finally {
      cleanup();
    }
  });
});
