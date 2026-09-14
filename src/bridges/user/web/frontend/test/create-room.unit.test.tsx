/**
 * Unit tests for CreateRoomForm component.
 */

import { describe, it, expect } from "vitest";
import { render as preactRender } from "preact";
import { Window } from "happy-dom";
import { CreateRoomForm } from "../components/CreateRoomForm.js";

/** Number of room-type `<option>`s the form renders: public, private, secret. */
const ROOM_TYPE_OPTION_COUNT = 3;

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
      expect(form).toBe(null);
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

      const nameInput = container.querySelector("input[name='room-name']")!;
      expect(nameInput, "room name input should exist").toBeTruthy();
      expect(nameInput.getAttribute("placeholder")).toBe("e.g. project-alpha");

      const typeSelect = container.querySelector("select[name='room-type']")!;
      expect(typeSelect, "room type select should exist").toBeTruthy();
      expect(typeSelect.value).toBe("public");

      const descInput = container.querySelector(
        "input[name='room-description']",
      )!;
      expect(descInput, "description input should exist").toBeTruthy();
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
      expect(options.length).toBe(ROOM_TYPE_OPTION_COUNT);
      expect(options[0].getAttribute("value")).toBe("public");
      expect(options[1].getAttribute("value")).toBe("private");
      expect(options[2].getAttribute("value")).toBe("secret");
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

      const submitBtn = container.querySelector("button.create-room-submit")!;
      expect(submitBtn).toBeTruthy();
      expect(submitBtn.textContent).toBe("Create");

      const cancelBtn = container.querySelector("button.create-room-cancel")!;
      expect(cancelBtn).toBeTruthy();
      expect(cancelBtn.textContent).toBe("Cancel");
    } finally {
      cleanup();
    }
  });
});
