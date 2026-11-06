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
      // detached: the child leads its own process group, so a timeout can kill
      // the whole tree (sh -c "make ..." spawns grandchildren that hold the pipes).
      const options = { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], detached: true };
      const child = input.shell ? spawn("sh", ["-c", input.command], options) : spawn(input.command, input.args, options);
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
      const killTree = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, input.timeoutMs);
      context.signal.addEventListener("abort", killTree, { once: true });
      let exitGrace: NodeJS.Timeout | undefined;
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal }));
        // A process that escaped the group (setsid, a daemon) can keep the pipes
        // open after the child exits; don't let it hold the call past its deadline.
        child.on("exit", (code, signal) => {
          exitGrace = setTimeout(() => resolve({ code, signal }), 5_000);
        });
      }).finally(() => {
        clearTimeout(timer);
        clearTimeout(exitGrace);
        context.signal.removeEventListener("abort", killTree);
        child.stdout.destroy();
        child.stderr.destroy();
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
