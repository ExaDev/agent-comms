// @vitest-environment jsdom
/**
 * Component interaction tests for JoinForm.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JoinForm } from "../components/JoinForm.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { renderWithMantine } from "./render-with-mantine.js";

beforeEach(() => {
  stubMantineJsdomGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JoinForm interactions", () => {
  it("renders nothing when not visible", () => {
    renderWithMantine(
      <JoinForm visible={false} onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(screen.queryByLabelText("Room name")).not.toBeInTheDocument();
  });

  it("does not call onSubmit when room name is empty", async () => {
    const user = userEvent.setup();
    let submitted = false;
    renderWithMantine(
      <JoinForm
        visible={true}
        onSubmit={() => {
          submitted = true;
        }}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(submitted).toBe(false);
  });

  it("renders input and submit button when visible", () => {
    renderWithMantine(
      <JoinForm visible={true} onSubmit={() => {}} onCancel={() => {}} />,
    );
    const input = screen.getByLabelText("Room name");
    expect(input).toHaveAttribute("placeholder", "Room name...");
    expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
  });

  it("calls onSubmit with the trimmed room name", async () => {
    const user = userEvent.setup();
    let submittedName: string | undefined;
    renderWithMantine(
      <JoinForm
        visible={true}
        onSubmit={(name) => {
          submittedName = name;
        }}
        onCancel={() => {}}
      />,
    );
    await user.type(screen.getByLabelText("Room name"), "my-room");
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(submittedName).toBe("my-room");
  });
});
