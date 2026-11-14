/**
 * The start marker of a process tells two processes that share a pid apart, so it is stable for one process and differs between two that started at different times.
 */

import { expect, test } from "vitest";
import { processStartMarker } from "../core/process-start.js";
import { deadPid, spawnLiveProcess } from "./live-process.helper.js";

test("a live process has a non-empty marker that stays the same", () => {
  const marker = processStartMarker(process.pid);

  expect(marker).toBeTruthy();
  expect(processStartMarker(process.pid)).toBe(marker);
});

test("a process that has exited has no marker", async () => {
  expect(processStartMarker(await deadPid())).toBeUndefined();
});

test("a marker never contains a line break", async () => {
  const holder = spawnLiveProcess();
  try {
    expect(processStartMarker(holder.pid)).not.toMatch(/[\r\n]/);
  } finally {
    await holder.exit();
  }
});
