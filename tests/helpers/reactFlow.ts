// What React Flow needs to render in jsdom (https://reactflow.dev/learn/advanced-use/testing).
import { vi } from "vitest";

class ResizeObserverStub {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) { this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  unobserve() {}
  disconnect() {}
}
class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([1-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? +scale : 1;
  }
}

/** Call in beforeEach; vi.unstubAllGlobals() undoes the globals. */
export function stubReactFlowDom() {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixReadOnlyStub);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return 100; } },
    offsetWidth: { configurable: true, get() { return 200; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}
