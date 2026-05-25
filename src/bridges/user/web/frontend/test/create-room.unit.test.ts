/**
 * Unit tests for CreateRoomForm component.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render as preactRender } from "preact";
import { Window } from "happy-dom";
import { CreateRoomForm } from "../components/CreateRoomForm.js";

function setup(): { container: HTMLElement; cleanup: () => void } {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const container = doc.createElement("div");
  return {
    container,
    cleanup: () => {
      window.close();
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
