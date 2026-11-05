// Shared RPC contract between server.ts and host.ts.
// The host entry runs shell commands (git, gh, check/deploy commands) on an
// enrolled BB host, inside a workspace path the server names explicitly.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const execInputSchema = z.object({
  /** Program to run (no shell). */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Working directory. Must exist on the host. */
  cwd: z.string().min(1),
  /** Extra environment variables. Values are never logged by either side. */
  env: z.record(z.string(), z.string()).optional(),
  /** Run through `sh -c` with `command` as the script; `args` ignored. */
  shell: z.boolean().default(false),
  timeoutMs: z.number().int().positive().max(30 * 60_000).default(10 * 60_000),
  /** Bound output kept per stream (tail). */
  maxOutputBytes: z.number().int().positive().max(2_000_000).default(200_000),
});

export const execOutputSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number(),
  timedOut: z.boolean(),
});

export const hostContract = defineRpcContract({
  exec: { input: execInputSchema, output: execOutputSchema },
  readFile: {
    input: z.object({ path: z.string().min(1), maxBytes: z.number().int().positive().default(64_000) }),
    output: z.object({ exists: z.boolean(), content: z.string(), truncated: z.boolean() }),
  },
});

export type ExecInput = z.input<typeof execInputSchema>;
export type ExecOutput = z.output<typeof execOutputSchema>;
