import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GENERIC_RULES, loadPrivateRules, scanRepo, scanText } from "../scripts/leak-scan.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const dirs = [];
// These tests control LEAK_PATTERNS_FILE themselves; publish's clean-clone run sets it for the whole
// suite, so save it, clear it per test, and restore it after.
const inherited = process.env.LEAK_PATTERNS_FILE;
beforeEach(() => { delete process.env.LEAK_PATTERNS_FILE; });
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (inherited === undefined) delete process.env.LEAK_PATTERNS_FILE;
  else process.env.LEAK_PATTERNS_FILE = inherited;
});

/** A throwaway repo with a scanner copy, a tracked file, and (optionally) a private patterns file. */
function repo({ file = "clean text\n", patterns = [{ pattern: "\\bSECRETNAME\\b", flags: "g", label: "a private name" }] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tlr-leak-test-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "T");
  git(root, "config", "user.email", "1+t@users.noreply.github.com");
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/leak-scan.mjs"), readFileSync(resolve("scripts/leak-scan.mjs")));
  writeFileSync(join(root, "a.txt"), file);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  if (patterns) {
    writeFileSync(join(root, "patterns.json"), JSON.stringify(patterns));
    process.env.LEAK_PATTERNS_FILE = join(root, "patterns.json");
  }
  return root;
}

describe("loadPrivateRules", () => {
  it("absent → null; malformed → an error (never silently ignored); the g flag is always set", () => {
    expect(loadPrivateRules("/nonexistent/patterns.json")).toBeNull();
    const d = mkdtempSync(join(tmpdir(), "tlr-leak-rules-"));
    dirs.push(d);
    writeFileSync(join(d, "bad.json"), JSON.stringify([{ pattern: "x" }]));
    expect(() => loadPrivateRules(join(d, "bad.json"))).toThrow(/needs "pattern" and "label"/);
    writeFileSync(join(d, "ok.json"), JSON.stringify([{ pattern: "abc", flags: "i", label: "L" }]));
    const [[re, label]] = loadPrivateRules(join(d, "ok.json"));
    expect([re.flags.includes("g"), re.flags.includes("i"), label]).toEqual([true, true, "L"]);
  });
});

describe("scanRepo with the private patterns file", () => {
  it("catches a private pattern from the file in a tracked file", () => {
    const r = repo({ file: "hello SECRETNAME\n" });
    expect(scanRepo({ cwd: r }).findings).toEqual(["a.txt: a private name (SECRET…)"]);
  });

  it("catches a private pattern inside the (public) scanner itself", () => {
    const r = repo();
    writeFileSync(join(r, "scripts/leak-scan.mjs"), `${readFileSync(join(r, "scripts/leak-scan.mjs"), "utf8")}\n// SECRETNAME\n`);
    expect(scanRepo({ cwd: r }).findings).toContain("scripts/leak-scan.mjs: a private name (SECRET…)");
  });

  it("without the file: generic rules only, and --require-private refuses", () => {
    const r = repo({ file: "hello SECRETNAME\n", patterns: null });
    expect(scanRepo({ cwd: r }).findings).toEqual([]);
    expect(() => scanRepo({ cwd: r, requirePrivate: true })).toThrow(/private patterns file is missing/);
  });

  it("history: all commits by default; with privateHistoryRemote only the unpushed ones", () => {
    const r = repo();
    const remote = join(r, "..", `${r.split("/").pop()}-remote.git`);
    dirs.push(remote);
    git(r, "init", "-q", "--bare", remote);
    writeFileSync(join(r, "a.txt"), "SECRETNAME\n");
    git(r, "commit", "-q", "-am", "pushed, holds the name");
    git(r, "remote", "add", "origin", remote);
    git(r, "push", "-q", "origin", "main");
    writeFileSync(join(r, "a.txt"), "clean\n");
    git(r, "commit", "-q", "-am", "unpushed: SECRETNAME in the message");
    const all = scanRepo({ cwd: r, history: true }).findings;
    expect(all.some((f) => f.includes("(diff)"))).toBe(true); // the pushed commit's diff
    expect(all.some((f) => f.includes("(message)"))).toBe(true); // the unpushed commit's message
    const unpushed = scanRepo({ cwd: r, history: true, privateHistoryRemote: "origin" }).findings;
    expect(unpushed.filter((f) => f.includes("(diff)") && f.includes("SECRET"))).toEqual([]);
    expect(unpushed.some((f) => f.includes("(message)"))).toBe(true);
  });

  it("the generic rules name no project-specific host, path or id", () => {
    const src = GENERIC_RULES.map(([re]) => re.source).join("\n");
    expect(src).not.toMatch(/host|pop-|supabase|spike|stub|[0-9a-f]{8}/i);
  });
});

// Runs wherever the private patterns file exists: the private checkout, and publish's --verify clean
// clone (which passes it in LEAK_PATTERNS_FILE). Skipped in public CI, which doesn't have it.
const localPatterns = inherited || resolve(".leak-patterns.local.json");
describe.skipIf(!existsSync(localPatterns))("this checkout against the private patterns", () => {
  it("the committed scanner and the whole tracked tree contain none of the private strings", () => {
    const rules = loadPrivateRules(localPatterns);
    expect(scanText("scripts/leak-scan.mjs", readFileSync(resolve("scripts/leak-scan.mjs"), "utf8"), rules)).toEqual([]);
    process.env.LEAK_PATTERNS_FILE = localPatterns;
    expect(scanRepo({ cwd: process.cwd(), requirePrivate: true }).findings).toEqual([]);
  });
});
