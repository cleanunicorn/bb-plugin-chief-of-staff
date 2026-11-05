// Host entry: executes commands on the enrolled BB host that owns a workspace.
// Loaded by the host daemon; the server reaches it via bb.hosts.experimental_client.
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract";

function tail(buf: Buffer[], max: number): { text: string; truncated: boolean } {
  const joined = Buffer.concat(buf);
  if (joined.length <= max) return { text: joined.toString("utf8"), truncated: false };
  return { text: joined.subarray(joined.length - max).toString("utf8"), truncated: true };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async exec(input, context) {
      const started = Date.now();
      const env = { ...process.env, ...(input.env ?? {}), GIT_TERMINAL_PROMPT: "0", CI: "1" };
      const child = input.shell
        ? spawn("sh", ["-c", input.command], { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(input.command, input.args, { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      const keep = input.maxOutputBytes * 2;
      child.stdout.on("data", (chunk: Buffer) => {
        out.push(chunk);
        outBytes += chunk.length;
        while (outBytes > keep && out.length > 1) outBytes -= out.shift()!.length;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        err.push(chunk);
        errBytes += chunk.length;
        while (errBytes > keep && err.length > 1) errBytes -= err.shift()!.length;
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, input.timeoutMs);
      const onAbort = () => child.kill("SIGKILL");
      context.signal.addEventListener("abort", onAbort, { once: true });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal }));
      }).finally(() => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", onAbort);
      });
      const stdout = tail(out, input.maxOutputBytes);
      const stderr = tail(err, input.maxOutputBytes);
      return {
        exitCode: result.code,
        signal: result.signal,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - started,
        timedOut,
      };
    },
    async readFile(input) {
      try {
        const info = await stat(input.path);
        if (!info.isFile()) return { exists: false, content: "", truncated: false };
        const content = await readFile(input.path, "utf8");
        return {
          exists: true,
          content: content.length > input.maxBytes ? content.slice(0, input.maxBytes) : content,
          truncated: content.length > input.maxBytes,
        };
      } catch {
        return { exists: false, content: "", truncated: false };
      }
    },
  },
});
