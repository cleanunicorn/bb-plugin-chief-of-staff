import { describe, expect, it } from "vitest";
import entry from "../host";

const exec = (entry as unknown as { handlers: { exec: (input: unknown, ctx: unknown) => Promise<{ timedOut: boolean; durationMs: number; stdout: string }> } }).handlers.exec;
const ctx = () => ({ signal: new AbortController().signal });

describe("host exec", () => {
  it("kills grandchildren on timeout instead of hanging on their open pipes", async () => {
    const result = await exec({ command: "sleep 30 & sleep 30; echo never", shell: true, cwd: "/tmp", timeoutMs: 300, maxOutputBytes: 10_000 }, ctx());
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(5_000);
  }, 10_000);

  it("returns output of a normal command", async () => {
    const result = await exec({ command: "echo hi", shell: true, cwd: "/tmp", timeoutMs: 5_000, maxOutputBytes: 10_000 }, ctx());
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe("hi");
  });
});
