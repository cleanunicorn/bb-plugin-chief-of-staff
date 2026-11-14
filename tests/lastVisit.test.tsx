// @vitest-environment jsdom
// The browser's last visit and this tab's baseline for "Since you were here" (#110).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BASELINE_KEY, LAST_VISIT_KEY, NEW_VISIT_AFTER_MS, markLeft, useVisitBaseline, visitBaseline } from "../components/cos/lastVisit";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

it("is a first visit with nothing stored, and remembers that for this tab", () => {
  expect(visitBaseline(NOW)).toBeNull();
  expect(sessionStorage.getItem(BASELINE_KEY)).toBe("none");
  // The visit goes on: leaving and coming back soon (a dashboard tab switch) keeps the first visit.
  markLeft(NOW);
  expect(visitBaseline(NOW + 60_000)).toBeNull();
});

it("starts from the browser's last visit", () => {
  localStorage.setItem(LAST_VISIT_KEY, ago(3 * 3_600_000));
  expect(visitBaseline(NOW)).toBe(ago(3 * 3_600_000));
  expect(sessionStorage.getItem(BASELINE_KEY)).toBe(ago(3 * 3_600_000));
});

it("keeps this tab's baseline across tab switches, refetches and reloads within the visit", () => {
  localStorage.setItem(LAST_VISIT_KEY, ago(3 * 3_600_000));
  const baseline = visitBaseline(NOW);
  // Switching dashboard tabs or reloading writes the last visit; the baseline stays.
  markLeft(NOW + 5_000);
  expect(localStorage.getItem(LAST_VISIT_KEY)).toBe(new Date(NOW + 5_000).toISOString());
  expect(visitBaseline(NOW + 10_000)).toBe(baseline);
  expect(visitBaseline(NOW + 10_000 + NEW_VISIT_AFTER_MS - 6_000)).toBe(baseline);
});

it("starts a new visit from when the dashboard was left, after a long time away", () => {
  localStorage.setItem(LAST_VISIT_KEY, ago(3 * 3_600_000));
  visitBaseline(NOW);
  markLeft(NOW + 1_000);
  const back = NOW + 1_000 + NEW_VISIT_AFTER_MS;
  expect(visitBaseline(back)).toBe(new Date(NOW + 1_000).toISOString());
  expect(sessionStorage.getItem(BASELINE_KEY)).toBe(new Date(NOW + 1_000).toISOString());
});

it("ignores a stored value that is not a time", () => {
  localStorage.setItem(LAST_VISIT_KEY, "garbage");
  expect(visitBaseline(NOW)).toBeNull();
  sessionStorage.setItem(BASELINE_KEY, "also garbage");
  expect(visitBaseline(NOW)).toBeNull();
});

it("treats storage that throws as a first visit, without crashing", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  expect(visitBaseline(NOW)).toBeNull();
  expect(() => markLeft(NOW)).not.toThrow();
});

it("treats storage that cannot even be reached as a first visit", () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
  vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
  expect(visitBaseline(NOW)).toBeNull();
  expect(() => markLeft(NOW)).not.toThrow();
});

// ---------- the hook ----------

let seen: (string | null)[] = [];
function Probe() {
  seen.push(useVisitBaseline());
  return null;
}

async function mountProbe() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => { root.render(<Probe />); });
  return { unmount: () => act(async () => { root.unmount(); el.remove(); }) };
}

const setVisibility = (state: "hidden" | "visible") => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
};

it("writes the last visit on pagehide, on hiding the page and on unmount", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  try {
    seen = [];
    const probe = await mountProbe();
    expect(seen.at(-1)).toBeNull();
    expect(localStorage.getItem(LAST_VISIT_KEY)).toBeNull();
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(LAST_VISIT_KEY)).toBe(new Date(NOW).toISOString());
    vi.setSystemTime(NOW + 60_000);
    await act(async () => setVisibility("hidden"));
    expect(localStorage.getItem(LAST_VISIT_KEY)).toBe(new Date(NOW + 60_000).toISOString());
    vi.setSystemTime(NOW + 120_000);
    await probe.unmount();
    expect(localStorage.getItem(LAST_VISIT_KEY)).toBe(new Date(NOW + 120_000).toISOString());
  } finally {
    vi.useRealTimers();
  }
});

it("moves to a new visit when the page comes back after a long time hidden", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  try {
    localStorage.setItem(LAST_VISIT_KEY, ago(5 * 3_600_000));
    seen = [];
    const probe = await mountProbe();
    expect(seen.at(-1)).toBe(ago(5 * 3_600_000));
    await act(async () => setVisibility("hidden"));
    vi.setSystemTime(NOW + 5 * 60_000);
    await act(async () => setVisibility("visible"));
    expect(seen.at(-1)).toBe(ago(5 * 3_600_000));
    await act(async () => setVisibility("hidden"));
    vi.setSystemTime(NOW + 5 * 60_000 + NEW_VISIT_AFTER_MS);
    await act(async () => setVisibility("visible"));
    expect(seen.at(-1)).toBe(new Date(NOW + 5 * 60_000).toISOString());
    await probe.unmount();
  } finally {
    vi.useRealTimers();
  }
});
