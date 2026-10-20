#!/usr/bin/env node
/**
 * Release notes composer for the GitHub "release" workflow (repo ops).
 *
 * Body = Highlights (the matching README roadmap headline, e.g. the
 * M6.2 ✅ bullet's first line) + Changes (one bullet per commit since the
 * previous v* tag) + Full changelog link. Consumed by .github/workflows/
 * release.yml via `--notes-file`; local use is fine too:
 *
 *   node scripts/release-notes.mjs --version v0.6.2-m6.2 --prev v0.6.1-m6.1 \
 *        --repo AnilRana675/MystoTune
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
function arg(name, fallback = "") {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? fallback).replace(/^v/, "") : fallback;
}

const version = arg("--version");
const prev = arg("--prev");
const repo = arg("--repo");

const parts = [];

/* Highlights: version X.Y.* keys the M<minor>.<patch> ✅ bullet headline. */
const m = /^(\d+)\.(\d+)\.(\d+)\b/.exec(version);
if (m) {
  try {
    const md = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const key = `**M${m[2]}.${m[3]} ✅`;
    const start = md.indexOf(key);
    if (start >= 0) {
      /* slice inside the bold span: "M6.2 ✅ guided setup website (doc 7.5-7.9)" */
      const close = md.indexOf("**", start + key.length);
      const headline = close > start + 2 ? md.slice(start + 2, close).trim() : "";
      if (headline) parts.push(`## Highlights\n\n- ${headline}\n`);
    }
  } catch {
    /* README unavailable — skip */
  }
}

/* Changes: one bullet per commit since the previous tag (all commits for the
 * first release, which is exactly the "initial release" changelog). */
let commits = "";
try {
  commits = execFileSync(
    "git",
    ["log", prev ? `v${prev}..HEAD` : "HEAD", "--no-merges", "--pretty=format:- %h %s"],
    { maxBuffer: 2 << 20 },
  ).toString();
} catch {
  /* no tag range available in this checkout — note it instead of silently
   * dropping the section */
  commits = "_commit range unavailable in this checkout_";
}
if (commits.trim()) parts.push(`## Changes\n\n${commits}\n`);

const link = prev
  ? `https://github.com/${repo}/compare/v${prev}...v${version}`
  : `https://github.com/${repo}/commits/v${version}`;
parts.push(`## Full changelog\n\n${link}\n`);

process.stdout.write(parts.join("\n"));
