/**
 * Shared test helpers for frontend component tests.
 */

/**
 * Query selector that returns HTMLElement.
 * Throws if element not found. Uses type narrowing suitable for
 * happy-dom (where elements are not instanceof HTMLElement).
 */
export function qs(parent: ParentNode, selector: string): HTMLElement {
  const el = parent.querySelector(selector);
  if (el === null) {
    throw new Error(`HTMLElement not found: ${selector}`);
  }
  if ("click" in el && "style" in el) {
    return el as HTMLElement;
  }
  throw new Error(
    `Element ${selector} is not an HTMLElement: ${el.constructor.name}`,
  );
}
