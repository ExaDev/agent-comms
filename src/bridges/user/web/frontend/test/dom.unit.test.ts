/**
 * Unit tests for dom.ts — DOM utility functions.
 */

import { describe, it, expect } from "vitest";
import { escapeHtml, formatTime, requireElement } from "../dom.js";
import { Window } from "happy-dom";

function createDoc(): { doc: Document; cleanup: () => void } {
  const window = new Window();
  return {
    doc: window.document as unknown as Document,
    cleanup: () => {
      window.close();
    },
  };
}

describe("dom", () => {
  describe("escapeHtml", () => {
    it("escapes <, >, &, quotes", () => {
      expect(escapeHtml("<script>alert('xss')</script>")).toBe(
        "&lt;script&gt;alert('xss')&lt;/script&gt;",
      );
    });

    it("passes through safe text unchanged", () => {
      expect(escapeHtml("hello world")).toBe("hello world");
    });
  });

  describe("formatTime", () => {
    it("extracts HH:MM:SS from ISO string", () => {
      expect(formatTime("2025-05-23T14:30:45.123Z")).toBe("14:30:45");
    });
  });

  describe("requireElement", () => {
    it("returns element when found", () => {
      const { doc, cleanup } = createDoc();
      try {
        const el = doc.createElement("div");
        el.id = "required";
        doc.body.appendChild(el);

        const result = requireElement(doc, "#required");
        expect(result.id).toBe("required");
      } finally {
        cleanup();
      }
    });

    it("throws when element not found", () => {
      const { doc, cleanup } = createDoc();
      try {
        expect(() => requireElement(doc, "#missing")).toThrow(
          /Required element not found/,
        );
      } finally {
        cleanup();
      }
    });
  });
});
