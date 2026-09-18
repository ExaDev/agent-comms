// jsdom implements neither matchMedia, ResizeObserver, nor Element.scrollIntoView -- Mantine's MantineProvider reads matchMedia to detect the OS colour-scheme preference, its ScrollArea (used by MessageList and Sidebar) reads ResizeObserver to decide when scrollbars are needed, and its Combobox (used by Select) calls scrollIntoView on a timer while navigating options. Every jsdom+Mantine test suite needs all three stubs.

import { vi } from "vitest";

export function matchMediaStub(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn<() => void>(),
    removeListener: vi.fn<() => void>(),
    addEventListener: vi.fn<() => void>(),
    removeEventListener: vi.fn<() => void>(),
    dispatchEvent: vi.fn<() => boolean>(() => true),
  };
}

export class ResizeObserverStub {
  observe(): void {
    // no-op
  }
  unobserve(): void {
    // no-op
  }
  disconnect(): void {
    // no-op
  }
}

/** Stand-in viewport size for document.body/documentElement -- large enough that floating-ui's clipping check always finds an ordinary-sized reference element genuinely inside it. */
const STUB_VIEWPORT_WIDTH = 1024;
const STUB_VIEWPORT_HEIGHT = 768;

/** Stand-in size for every other element -- arbitrary but non-zero, which is all floating-ui's clipping check needs. */
const STUB_ELEMENT_WIDTH = 120;
const STUB_ELEMENT_HEIGHT = 32;

function isRoot(el: Element): boolean {
  return el === document.body || el === document.documentElement;
}

export function stubMantineJsdomGlobals(): void {
  vi.stubGlobal("matchMedia", matchMediaStub);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = () => {
    // no-op
  };
  // jsdom never lays anything out, so every element's real getBoundingClientRect is all-zero -- floating-ui's own "hide" middleware (which Mantine's Select dropdown uses) computes the viewport from documentElement.clientWidth/clientHeight (also 0 under jsdom, not window.innerWidth/innerHeight), so it treats the all-zero reference rect as clipped outside an all-zero viewport and sets referenceHidden, which PopoverDropdown then renders as an inline display:none -- hiding the options from every role-based query even though they're in the DOM. Giving the root element real client dimensions and every other element a real (smaller) bounding rect is the standard workaround: it gives floating-ui's clipping check a real viewport to consider the reference actually inside.
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: Element) {
      return isRoot(this) ? STUB_VIEWPORT_WIDTH : STUB_ELEMENT_WIDTH;
    },
  });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      return isRoot(this) ? STUB_VIEWPORT_HEIGHT : STUB_ELEMENT_HEIGHT;
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const width = isRoot(this) ? STUB_VIEWPORT_WIDTH : STUB_ELEMENT_WIDTH;
    const height = isRoot(this) ? STUB_VIEWPORT_HEIGHT : STUB_ELEMENT_HEIGHT;
    return {
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON() {
        return this;
      },
    };
  };
}
