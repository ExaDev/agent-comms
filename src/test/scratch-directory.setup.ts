// Vitest setup file: removes the directories a test file made through `scratchDirectory` once the file's tests have finished. It is registered before the test file's own hooks, and vitest runs after-hooks in reverse order of registration, so this runs after the file's own `afterAll` hooks have shut down whatever was using those directories.
import { afterAll } from "vitest";
import { removeAllScratchDirectories } from "./scratch-directory.helper.js";

afterAll(() => {
  removeAllScratchDirectories();
});
