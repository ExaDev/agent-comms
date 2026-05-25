/**
 * Unit tests for dom.ts — DOM utility functions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
      assert.strictEqual(
        escapeHtml("<script>alert('xss')</script>"),
        "&lt;script&gt;alert('xss')&lt;/script&gt;",
      );
    });

    it("passes through safe text unchanged", () => {
      assert.strictEqual(escapeHtml("hello world"), "hello world");
    });
  });

  describe("formatTime", () => {
    it("extracts HH:MM:SS from ISO string", () => {
      assert.strictEqual(formatTime("2025-05-23T14:30:45.123Z"), "14:30:45");
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
        assert.strictEqual(result.id, "required");
      } finally {
        cleanup();
      }
    });

    it("throws when element not found", () => {
      const { doc, cleanup } = createDoc();
      try {
        assert.throws(
          () => requireElement(doc, "#missing"),
          /Required element not found/,
        );
      } finally {
        cleanup();
      }
    });
  });
});
