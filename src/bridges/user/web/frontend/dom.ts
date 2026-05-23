/**
 * Minimal DOM helpers — no framework, just typed wrappers.
 *
 * All functions take a Document parameter for testability (jsdom/happy-dom).
 * In the browser, pass the global `document`.
 */

/**
 * Query selector scoped to a root element.
 * Returns `undefined` if not found (not null).
 */
export function querySelector(
  root: ParentNode,
  selector: string,
): HTMLElement | undefined {
  const el = root.querySelector<HTMLElement>(selector);
  return el ?? undefined;
}

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
  if (tag && el.tagName.toLowerCase() !== tag) {
    throw new Error(
      `Element ${selector} must be <${tag}>, got <${el.tagName.toLowerCase()}>`,
    );
  }
  return el;
}

/**
 * HTML-escape a string for safe insertion via textContent→innerHTML round-trip.
 */
export function escapeHtml(doc: Document, text: string): string {
  const div = doc.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Create an HTML element with optional attributes and children.
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs?: Record<string, string>,
  ...children: (string | Node)[]
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (typeof child === "string") {
      el.appendChild(doc.createTextNode(child));
    } else {
      el.appendChild(child);
    }
  }
  return el;
}

/**
 * Remove all children from an element.
 */
export function clearChildren(el: HTMLElement): void {
  el.innerHTML = "";
}

/**
 * Append a child and return the parent for chaining.
 */
export function appendTo(parent: HTMLElement, child: Node): HTMLElement {
  parent.appendChild(child);
  return parent;
}

/**
 * Format an ISO timestamp to HH:MM:SS for display.
 */
export function formatTime(timestamp: string): string {
  return timestamp.slice(11, 19);
}
