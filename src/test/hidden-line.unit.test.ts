/**
 * Unit tests for the keystrokes the hidden passphrase prompt accepts (account-cli.ts): which end the line, which edit it, and which are refused because they would be kept invisibly.
 */

import { describe, expect, it } from "vitest";
import { hiddenLineStep, type HiddenLineStep } from "../account-cli.js";

/** Feeds each character in turn, stopping at the first step that is not still typing. */
function type(keys: string): HiddenLineStep {
  let step: HiddenLineStep = { kind: "typing", value: "" };
  for (const character of keys) {
    if (step.kind !== "typing") return step;
    step = hiddenLineStep(step.value, character);
  }
  return step;
}

describe("hidden line keystrokes", () => {
  it("ends the line on Enter", () => {
    expect(type("secret\r")).toEqual({ kind: "done", value: "secret" });
  });

  it("ends the line on Ctrl-D when something was typed", () => {
    expect(type("secret\u0004")).toEqual({ kind: "done", value: "secret" });
  });

  it("cancels on Ctrl-D with nothing typed", () => {
    expect(type("\u0004")).toMatchObject({ kind: "failed" });
  });

  it("cancels on Ctrl-C", () => {
    expect(type("sec\u0003")).toEqual({ kind: "failed", message: "Cancelled" });
  });

  it("treats Ctrl-H like Delete", () => {
    expect(type("secrex\bt\r")).toEqual({ kind: "done", value: "secret" });
    expect(type("secrex\u007ft\r")).toEqual({ kind: "done", value: "secret" });
  });

  it("refuses an arrow key rather than keeping its escape sequence", () => {
    expect(type("sec\u001b[Dret\r")).toMatchObject({ kind: "failed" });
  });

  it("refuses any other control character", () => {
    expect(type("sec\tret\r")).toMatchObject({ kind: "failed" });
  });
});
