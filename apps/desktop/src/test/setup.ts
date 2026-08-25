import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest.config.ts keeps globals off, so @testing-library/react's automatic
// afterEach(cleanup) never registers itself — do it explicitly instead.
afterEach(cleanup);

// jsdom ships no matchMedia. Resolve `(min-width: Npx)` against innerWidth so
// responsive code under test behaves the way it would in a real window, and a
// test can drive it by setting window.innerWidth.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    const listeners = new Set<() => void>();
    const mql: MediaQueryList = {
      get matches() {
        return min ? window.innerWidth >= Number(min[1]) : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_t: string, l: EventListenerOrEventListenerObject) =>
        void listeners.add(l as () => void),
      removeEventListener: (_t: string, l: EventListenerOrEventListenerObject) =>
        void listeners.delete(l as () => void),
      addListener: (l) => void (l && listeners.add(l as unknown as () => void)),
      removeListener: (l) => void (l && listeners.delete(l as unknown as () => void)),
      dispatchEvent: () => true,
    };
    return mql;
  };
}
