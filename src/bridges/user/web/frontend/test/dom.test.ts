/* eslint-disable @typescript-eslint/no-floating-promises */
/**
 * Unit tests for dom.ts — DOM helper functions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  clearChildren,
  createElement,
  escapeHtml,
  formatTime,
  querySelector,
  requireElement,
} from "../dom.js";

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
      const { doc, cleanup } = createDoc();
      try {
        assert.strictEqual(
          escapeHtml(doc, "<script>alert('xss')</script>"),
          "&lt;script&gt;alert('xss')&lt;/script&gt;",
        );
      } finally {
        cleanup();
      }
    });

    it("passes through safe text unchanged", () => {
      const { doc, cleanup } = createDoc();
      try {
        assert.strictEqual(escapeHtml(doc, "hello world"), "hello world");
      } finally {
        cleanup();
      }
    });
  });

  describe("formatTime", () => {
    it("extracts HH:MM:SS from ISO string", () => {
      assert.strictEqual(formatTime("2025-05-23T14:30:45.123Z"), "14:30:45");
    });
  });

  describe("createElement", () => {
    it("creates element with attributes and children", () => {
      const { doc, cleanup } = createDoc();
      try {
        const el = createElement(doc, "div", { class: "test" }, "hello");
        assert.strictEqual(el.tagName, "DIV");
        assert.strictEqual(el.getAttribute("class"), "test");
        assert.strictEqual(el.textContent, "hello");
      } finally {
        cleanup();
      }
    });

    it("creates element without attributes or children", () => {
      const { doc, cleanup } = createDoc();
      try {
        const el = createElement(doc, "span");
        assert.strictEqual(el.tagName, "SPAN");
        assert.strictEqual(el.childNodes.length, 0);
      } finally {
        cleanup();
      }
    });

    it("appends Node children", () => {
      const { doc, cleanup } = createDoc();
      try {
        const child = doc.createElement("strong");
        child.textContent = "bold";
        const el = createElement(doc, "p", undefined, child);
        assert.strictEqual(el.querySelector("strong")?.textContent, "bold");
      } finally {
        cleanup();
      }
    });
  });

  describe("clearChildren", () => {
    it("removes all children from an element", () => {
      const { doc, cleanup } = createDoc();
      try {
        const parent = doc.createElement("div");
        parent.appendChild(doc.createElement("span"));
        parent.appendChild(doc.createElement("span"));
        assert.strictEqual(parent.childNodes.length, 2);

        clearChildren(parent);
        assert.strictEqual(parent.childNodes.length, 0);
      } finally {
        cleanup();
      }
    });
  });

  describe("querySelector", () => {
    it("returns element when found", () => {
      const { doc, cleanup } = createDoc();
      try {
        const parent = doc.createElement("div");
        const child = doc.createElement("span");
        child.id = "target";
        parent.appendChild(child);
        doc.body.appendChild(parent);

        const result = querySelector(doc, "#target");
        assert.ok(result);
        assert.strictEqual(result.id, "target");
      } finally {
        cleanup();
      }
    });

    it("returns undefined when not found", () => {
      const { doc, cleanup } = createDoc();
      try {
        const result = querySelector(doc, "#nonexistent");
        assert.strictEqual(result, undefined);
      } finally {
        cleanup();
      }
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
