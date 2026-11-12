// What React Flow needs to render in jsdom (https://reactflow.dev/learn/advanced-use/testing).
import { vi } from "vitest";

/** Like a browser, reports every element observed in the same task in one callback, so React Flow's opening fit sees all the steps. */
class ResizeObserverStub {
  private pending: Element[] = [];
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    if (this.pending.push(target) > 1) return;
    queueMicrotask(() => {
      const targets = this.pending;
      this.pending = [];
      if (targets.length) this.callback(targets.map((t) => ({ target: t }) as ResizeObserverEntry), this as unknown as ResizeObserver);
    });
  }
  unobserve(target: Element) { this.pending = this.pending.filter((t) => t !== target); }
  disconnect() { this.pending = []; }
}
class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
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
