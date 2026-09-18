// @vitest-environment jsdom
/**
 * Component interaction tests for CreateRoomForm.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateRoomForm } from "../components/CreateRoomForm.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { renderWithMantine } from "./render-with-mantine.js";

beforeEach(() => {
  stubMantineJsdomGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CreateRoomForm interactions", () => {
  it("calls onCancel when cancel button is clicked", async () => {
    const user = userEvent.setup();
    let cancelled = false;
    renderWithMantine(
      <CreateRoomForm
        visible={true}
        onSubmit={() => {}}
        onCancel={() => {
          cancelled = true;
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelled).toBe(true);
  });

  it("calls onSubmit with form values when submitted", async () => {
    const user = userEvent.setup();
    let submitted:
      | {
          name: string;
          type: "public" | "private" | "secret";
          description: string;
        }
      | undefined;
    renderWithMantine(
      <CreateRoomForm
        visible={true}
        onSubmit={(name, type, description) => {
          submitted = { name, type, description };
        }}
        onCancel={() => {}}
      />,
    );

    await user.type(screen.getByLabelText(/Room name/), "test-room");
    await user.click(screen.getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Private" }));
    await user.type(
      screen.getByLabelText("Description (optional)"),
      "A test room",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(submitted).toEqual({
      name: "test-room",
      type: "private",
      description: "A test room",
    });
  });

  it("does not submit when name is empty", async () => {
    const user = userEvent.setup();
    let submitted = false;
    renderWithMantine(
      <CreateRoomForm
        visible={true}
        onSubmit={() => {
          submitted = true;
        }}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(submitted).toBe(false);
  });
});
