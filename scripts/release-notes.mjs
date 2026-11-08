#!/usr/bin/env node
// Usage: node scripts/release-notes.mjs v1.2.3
// Verifies the tag matches package.json and that CHANGELOG.md has a section for
// it, then prints that section's body to stdout. Exits non-zero on mismatch.
import { readFileSync } from "node:fs";

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("Usage: release-notes.mjs vMAJOR.MINOR.PATCH");
  process.exit(2);
}
const version = tag.slice(1);

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.version !== version) {
  console.error(`Tag ${tag} does not match package.json version ${pkg.version}.`);
  process.exit(1);
}

const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start === -1) {
  console.error(`CHANGELOG.md has no "## ${version}" section. Rename "## Unreleased" before tagging.`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
if (end === -1) end = lines.length;
const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) {
  console.error(`The "## ${version}" changelog section is empty.`);
  process.exit(1);
}
console.log(body);
