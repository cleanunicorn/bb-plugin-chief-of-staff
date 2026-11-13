// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, unmount } from "./dom";

const realtime = vi.hoisted(() => ({ handlers: new Map<string, () => void>() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: (topic: string, handler: () => void) => { realtime.handlers.set(topic, handler); },
}));
import { LIVE_REFRESH_DEBOUNCE_MS, LIVE_REFRESH_MAX_WAIT_MS, useLiveRefresh } from "../hooks/useLiveRefresh";

const refetch = vi.fn(async () => {});
function Probe({ onChange }: { onChange: () => Promise<void> }) {
  useLiveRefresh(onChange);
  return null;
}
const changed = () => act(() => { realtime.handlers.get("cos-changed")!(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(async () => {
  vi.useFakeTimers();
  refetch.mockClear();
  realtime.handlers.clear();
  await mount(<Probe onChange={refetch} />);
});
afterEach(async () => {
  await unmount();
  vi.useRealTimers();
});

it("waits 500 ms after the last of a burst of changes, then refetches once", async () => {
  expect(LIVE_REFRESH_DEBOUNCE_MS).toBe(500);
  for (let i = 0; i < 5; i++) {
    await changed();
    await advance(100);
  }
  expect(refetch).not.toHaveBeenCalled();
  await advance(399);
  expect(refetch).not.toHaveBeenCalled();
  await advance(1);
  expect(refetch).toHaveBeenCalledTimes(1);
});

it("refetches again for a change after a quiet period", async () => {
  await changed();
  await advance(500);
  await advance(2_000);
  await changed();
  await advance(500);
  expect(refetch).toHaveBeenCalledTimes(2);
});

it("calls the latest refetch", async () => {
  const later = vi.fn(async () => {});
  await changed();
  await mount(<Probe onChange={later} />);
  await advance(500);
  expect(refetch).not.toHaveBeenCalled();
  expect(later).toHaveBeenCalledTimes(1);
});

it("does not refetch after unmounting", async () => {
  await changed();
  await unmount();
  await advance(1_000);
  expect(refetch).not.toHaveBeenCalled();
});

it("refetches at least every 2 s while changes keep coming", async () => {
  expect(LIVE_REFRESH_MAX_WAIT_MS).toBe(2_000);
  for (let i = 0; i < 20; i++) {
    await changed();
    await advance(200);
  }
  // 4 s of changes 200 ms apart: one refetch at 2 s, one at 4 s (covering the last change).
  expect(refetch).toHaveBeenCalledTimes(2);
  await advance(1_000);
  expect(refetch).toHaveBeenCalledTimes(2);
});
