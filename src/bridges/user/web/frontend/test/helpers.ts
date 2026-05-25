/**
 * Shared test helpers for frontend component tests.
 */

/**
 * Query selector that returns HTMLElement.
 * Throws if element not found. Uses duck-typing suitable for
 * happy-dom (where elements are not instanceof HTMLElement).
 */
function isHtmlElement(el: Element): el is HTMLElement {
  return "click" in el && "style" in el;
}

export function qs(parent: ParentNode, selector: string): HTMLElement {
  const el = parent.querySelector(selector);
  if (el === null) {
    throw new Error(`HTMLElement not found: ${selector}`);
  }
  if (isHtmlElement(el)) {
    return el;
  }
  throw new Error(
    `Element ${selector} is not an HTMLElement: ${el.constructor.name}`,
  );
}
