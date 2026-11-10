// Runtime code decides whether a step runs an agent with agentWork (or
// isWriter / isAuthoredAgent), never by its raw type: an automatic Model step
// has type "model" but runs an agent, and a raw `step.type === "agent"` check
// silently skips it (see the lost-spawn recovery bug fixed in #76). Effects and
// retries also carry type "agent"; those comparisons are fine.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
/** Receivers whose `.type` is an Effect, not a Step. */
const EFFECT_RECEIVERS = new Set(["effect", "e", "retry"]);
const RAW_CHECK = /([\w$]+)\??\.type\s*[!=]==?\s*["']agent["']/g;

/** `file:line  code` for each raw step-type check in `source`. */
export function rawAgentChecks(file: string, source: string): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(RAW_CHECK)) if (!EFFECT_RECEIVERS.has(m[1]!)) hits.push(`${file}:${i + 1}  ${line.trim()}`);
  });
  return hits;
}

describe("agent-work guard", () => {
  it("finds no raw step-type agent checks in runtime code outside workflow.ts", () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== "workflow.ts");
    const hits = files.flatMap((f) => rawAgentChecks(`src/${f}`, readFileSync(join(SRC, f), "utf8")));
    expect(hits, "use agentWork / isWriter / isAuthoredAgent from src/workflow.ts").toEqual([]);
  });

  it("flags step receivers and allows effect receivers", () => {
    const sample = [
      `if (!item || step?.type !== "agent") return null;`,
      `const ok = s.type === "agent" && s.writes;`,
      `if (effect.type === "agent") send();`,
      `if (n.retry?.effect.type === "agent") retry();`,
      `if (retry?.type !== "agent") break;`,
      `for (const e of fx) if (e.type === "agent") e.fresh = true;`,
    ].join("\n");
    expect(rawAgentChecks("x.ts", sample).map((h) => h.split("  ")[0])).toEqual(["x.ts:1", "x.ts:2"]);
  });
});
