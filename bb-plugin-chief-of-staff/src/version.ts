// Version bump strategies for the release step.
export type VersionStrategy = "patch" | "minor" | "major" | "calver" | "conventional";

export function parseSemver(tag: string, prefix: string): [number, number, number] | null {
  const raw = tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function conventionalBump(titles: string[]): "major" | "minor" | "patch" {
  let bump: "major" | "minor" | "patch" = "patch";
  for (const title of titles) {
    if (/^[a-z]+(\(.+\))?!:/.test(title) || /BREAKING CHANGE/i.test(title)) return "major";
    if (/^feat(\(.+\))?:/.test(title)) bump = "minor";
  }
  return bump;
}

export function nextVersion(current: string | null, strategy: VersionStrategy, opts: { prefix: string; now?: Date; mergedTitles?: string[]; existingCalverTags?: string[] }): string {
  if (strategy === "calver") {
    const d = opts.now ?? new Date();
    const base = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
    const taken = new Set((opts.existingCalverTags ?? []).map((t) => (t.startsWith(opts.prefix) ? t.slice(opts.prefix.length) : t)));
    if (!taken.has(base)) return base;
    let n = 1;
    while (taken.has(`${base}.${n}`)) n += 1;
    return `${base}.${n}`;
  }
  const parsed = current ? parseSemver(current, opts.prefix) : null;
  const [major, minor, patch] = parsed ?? [0, 0, 0];
  const bump = strategy === "conventional" ? conventionalBump(opts.mergedTitles ?? []) : strategy;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function renderChangelog(version: string, pulls: { number: number; title: string; author: string | null; url: string }[], date: Date): string {
  const lines = [`## ${version} (${date.toISOString().slice(0, 10)})`, ""];
  if (!pulls.length) lines.push("- No merged pull requests since the last release.");
  for (const pr of pulls) lines.push(`- ${pr.title} ([#${pr.number}](${pr.url}))${pr.author ? ` by @${pr.author}` : ""}`);
  return lines.join("\n");
}
