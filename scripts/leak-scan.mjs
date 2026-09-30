// Leak scan: nothing private may reach the public tree (or, with --history, any commit).
//
// This file ships in the public repo, so it holds only GENERIC rules. The patterns specific to this
// project's private infrastructure and people live in a gitignored JSON file,
// `.leak-patterns.local.json` at the repo root (or the path in LEAK_PATTERNS_FILE):
//   [{ "pattern": "<regex source>", "flags": "gi", "label": "an internal hostname" }, …]
// `--require-private` refuses to run without that file; the pre-push hook and scripts/publish.mjs
// always pass it, so a release can never be scanned without the private list. Findings never print a
// private pattern, only its label and the first characters of the match.
//
// History: by default EVERY reachable commit gets ALL rules. That's what publish.mjs uses on its clean
// clone, which holds only the release commit + the public history. `--private-history=unpushed:<remote>`
// scans only the commits not yet on <remote>, i.e. exactly what's about to be pushed. The pre-push hook
// uses that: the private development history is never published (releases are squashed), already
// holds private names and web-merge author emails, and rescanning it can't un-push anything.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const GENERIC_RULES = [
  [/\btlr_[A-Za-z0-9_-]{20,}/g, "an API token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "a private key"],
  [/\bAKIA[0-9A-Z]{16}\b|\bsk-ant-[A-Za-z0-9-]{10,}|\bghp_[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, "a credential"],
  [/\/home\/[a-z][a-z0-9_-]*\//gi, "a home-directory path"],
  [/[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|example\.(com|org|test))[A-Za-z0-9.-]+\.[a-z]{2,}/gi, "an email address"],
];
// Deliberate test markers that look like secrets but are not.
const ALLOW = [/tlr_TEST_TOKEN_should_never_leak_[0-9a-f]+/, /^noreply@anthropic\.com$/];

/**
 * Commit MESSAGES exempt from the history scan, by full sha, each with its reason. Only the message is
 * exempt: the commit's diff is still scanned like every other change.
 * - c2407188…: a message in the private development history with a low-sensitivity internal
 *   reference. That history is never published: releases are one squashed commit per release
 *   (scripts/publish.mjs), and that commit is scanned in full, message included. Decided 2026-09-30.
 */
const EXEMPT_MESSAGES = new Map([["c2407188cece94d055695396ab2a250a90a29f71", "a known internal name, never published"]]);

/** The private patterns file: LEAK_PATTERNS_FILE, else `.leak-patterns.local.json` in `root`. */
export const privatePatternsPath = (root) => process.env.LEAK_PATTERNS_FILE || join(root, ".leak-patterns.local.json");

/** Load the private rules, or null when the file is absent. A malformed file is an error, never ignored. */
export function loadPrivateRules(file) {
  if (!existsSync(file)) return null;
  const list = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(list) || !list.length) throw new Error("the private patterns file must be a non-empty JSON array");
  return list.map((p, i) => {
    if (typeof p?.pattern !== "string" || typeof p?.label !== "string") throw new Error(`private pattern #${i + 1} needs "pattern" and "label"`);
    const flags = [...new Set(`${p.flags ?? ""}g`)].join("");
    return [new RegExp(p.pattern, flags), p.label];
  });
}

/** Findings for one named text: "<name>: <label> (<first chars>…)". */
export function scanText(name, text, rules) {
  const out = [];
  for (const [re, what] of rules) {
    for (const m of text.matchAll(re)) {
      if (ALLOW.some((a) => a.test(m[0]))) continue;
      out.push(`${name}: ${what} (${m[0].slice(0, 6)}…)`);
    }
  }
  return out;
}

/** Scan a git checkout: tracked files, and with `history` every reachable commit (message + diff). */
export function scanRepo({ cwd, history = false, requirePrivate = false, privateHistoryRemote = null }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  const root = git("rev-parse", "--show-toplevel").trim();
  const file = privatePatternsPath(root);
  const privateRules = loadPrivateRules(file);
  if (!privateRules && requirePrivate) throw new Error(`the private patterns file is missing (${file}); refusing to scan without it`);
  const rules = [...GENERIC_RULES, ...(privateRules ?? [])];

  const skip = (f) => f === "scripts/leak-scan.mjs" || f === "package-lock.json";
  const sources = git("ls-files").split("\n").filter(Boolean).filter((f) => !skip(f) && existsSync(join(root, f))).map((f) => [f, readFileSync(join(root, f), "utf8")]);
  // The scanner itself is scanned for the PRIVATE patterns only (its generic rules are regex sources
  // that would match themselves): it ships publicly, so it must never name what it hunts for.
  const self = join(root, "scripts/leak-scan.mjs");
  const findings = privateRules && existsSync(self) ? scanText("scripts/leak-scan.mjs", readFileSync(self, "utf8"), privateRules) : [];
  let historySources = 0;
  if (history) {
    const excluded = ["--", ".", ":!scripts/leak-scan.mjs", ":!package-lock.json"];
    // Which commits get the private rules: all of them, or only those not yet on the given remote.
    const privateFor = privateHistoryRemote
      ? new Set(git("rev-list", "--all", "--not", `--remotes=${privateHistoryRemote}`).split("\n").filter(Boolean))
      : null;
    for (const sha of git("rev-list", "--all").split("\n").filter(Boolean)) {
      const short = sha.slice(0, 7);
      if (privateFor && !privateFor.has(sha)) continue; // already on the remote: out of this push's reach
      const commitRules = rules;
      const scanned = [];
      if (!EXEMPT_MESSAGES.has(sha)) scanned.push([`git history ${short} (message)`, git("log", "-1", "--format=%an <%ae>%n%B", sha)]);
      else scanned.push([`git history ${short} (author)`, git("log", "-1", "--format=%an <%ae>", sha)]);
      // Only the lines a commit ADDS: a removed line's text belongs to the parent, scanned on its own.
      const added = git("show", "--format=", "-p", sha, ...excluded).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
      scanned.push([`git history ${short} (diff)`, added]);
      for (const [name, text] of scanned) findings.push(...scanText(name, text, commitRules));
      historySources += scanned.length;
    }
  }
  for (const [name, text] of sources) findings.push(...scanText(name, text, rules));
  return { findings: [...new Set(findings)], sources: sources.length + historySources, privateRules: privateRules?.length ?? 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const history = process.argv.includes("--history");
  try {
    const scope = process.argv.find((a) => a.startsWith("--private-history="))?.split("=")[1] ?? "all";
    if (scope !== "all" && !/^unpushed:[\w.-]+$/.test(scope)) throw new Error(`--private-history must be "all" or "unpushed:<remote>"`);
    const r = scanRepo({ cwd: process.cwd(), history, requirePrivate: process.argv.includes("--require-private"), privateHistoryRemote: scope === "all" ? null : scope.slice("unpushed:".length) });
    if (r.findings.length) {
      console.error(`Leak scan FAILED (${r.findings.length}):\n  ${r.findings.join("\n  ")}`);
      process.exit(1);
    }
    const priv = r.privateRules ? `${r.privateRules} private pattern(s)` : "generic rules only (no private patterns file)";
    console.log(`Leak scan clean: ${r.sources} source(s)${history ? ` incl. history (${EXEMPT_MESSAGES.size} commit message exempt by sha)` : ""}; ${priv}.`);
  } catch (err) {
    console.error(`Leak scan ERROR: ${err?.message ?? err}`);
    process.exit(1);
  }
}
