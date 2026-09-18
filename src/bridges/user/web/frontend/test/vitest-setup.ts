// Registers jest-dom's matchers (toBeInTheDocument, etc.) on vitest's own expect, and unmounts every React root @testing-library/react rendered after each test -- without this, DOM from one test's render() call is still mounted when the next test in the same file queries the document, since this project doesn't set vitest's `test.globals: true` (RTL's own auto-cleanup relies on detecting a global afterEach).

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
