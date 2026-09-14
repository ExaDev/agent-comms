/**
 * DOM utilities for the web UI.
 *
 * escapeHtml and formatTime are used by message rendering.
 * requireElement is used by the entry point to grab the root mount point.
 */

/**
 * Query selector that throws if the element is missing.
 * Use for elements that must exist in the HTML shell.
 */
export function requireElement(root: ParentNode, selector: string): HTMLElement;
export function requireElement<K extends keyof HTMLElementTagNameMap>(
  root: ParentNode,
  selector: string,
  tag: K,
): HTMLElementTagNameMap[K];
export function requireElement(
  root: ParentNode,
  selector: string,
  tag?: string,
): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Required element not found: ${selector}`);
  if (tag !== undefined && el.tagName.toLowerCase() !== tag) {
    throw new Error(
      `Element ${selector} must be <${tag}>, got <${el.tagName.toLowerCase()}>`,
    );
  }
  return el;
}

/**
 * HTML-escape a string for safe insertion.
 * With Preact JSX, text content is auto-escaped — this is only needed
 * when constructing raw HTML strings.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Format an ISO timestamp to HH:MM:SS for display.
 */
const ISO_TIME_OF_DAY_START = 11;
const ISO_TIME_OF_DAY_END = 19;

export function formatTime(timestamp: string): string {
  return timestamp.slice(ISO_TIME_OF_DAY_START, ISO_TIME_OF_DAY_END);
}

/**
 * Get an input or select element from an event target.
 * Avoids type assertions by using instanceof narrowing.
 */
export function inputFromEvent(e: Event): HTMLInputElement | HTMLSelectElement {
  const target = e.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement
  ) {
    return target;
  }
  throw new Error("Event target is not an input element");
}
