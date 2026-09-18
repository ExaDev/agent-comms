// @vitest-environment jsdom
/**
 * Structural unit tests for CreateRoomForm.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { CreateRoomForm } from "../components/CreateRoomForm.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { renderWithMantine } from "./render-with-mantine.js";

beforeEach(() => {
  stubMantineJsdomGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CreateRoomForm", () => {
  it("renders nothing when not visible", () => {
    renderWithMantine(
      <CreateRoomForm
        visible={false}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/Room name/)).not.toBeInTheDocument();
  });

  it("renders form with name, type, and description inputs", () => {
    renderWithMantine(
      <CreateRoomForm visible={true} onSubmit={() => {}} onCancel={() => {}} />,
    );

    const nameInput = screen.getByLabelText(/Room name/);
    expect(nameInput).toHaveAttribute("placeholder", "e.g. project-alpha");

    const typeSelect = screen.getByRole("combobox", { name: "Type" });
    expect(typeSelect).toHaveValue("Public");

    expect(screen.getByLabelText("Description (optional)")).toBeInTheDocument();
  });

  it("renders submit and cancel buttons", () => {
    renderWithMantine(
      <CreateRoomForm visible={true} onSubmit={() => {}} onCancel={() => {}} />,
    );

    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});
