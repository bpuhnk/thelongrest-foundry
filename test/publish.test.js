import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUTHOR, assertNoReplyAuthor, assertPublicTarget, publish, releaseMessage } from "../scripts/publish.mjs";

describe("assertPublicTarget: where a publish may push", () => {
  const remotes = { origin: "https://github.com/me/ws.git", public: "https://github.com/me/pub.git", twin: "https://github.com/me/ws.git" };
  const visibility = (url) => ({ "https://github.com/me/ws.git": "PRIVATE", "https://github.com/me/pub.git": "PUBLIC" })[url] ?? null;
  it.each([
    [null, /named remote/],
    ["origin", /private workspace/],
    ["nope", /No git remote/],
    ["twin", /origin's URL/],
  ])("refuses remote %s", (remote, re) => expect(() => assertPublicTarget({ remote, remotes, visibility })).toThrow(re));
  it("refuses a target that isn't PUBLIC, and an origin that isn't PRIVATE", () => {
    expect(() => assertPublicTarget({ remote: "public", remotes, visibility: () => "PRIVATE" })).toThrow(/isn't a PUBLIC repo/);
    expect(() => assertPublicTarget({ remote: "public", remotes, visibility: (u) => (u.includes("pub") ? "PUBLIC" : "PUBLIC") })).toThrow(/origin isn't the PRIVATE/);
  });
  it("allows a public, differently named, differently addressed remote", () => {
    expect(assertPublicTarget({ remote: "public", remotes, visibility })).toBe(remotes.public);
  });
});

describe("identity and message", () => {
  it("the author is neutral and a GitHub no-reply address; the message is fixed", () => {
    expect(AUTHOR.name).toBe("The Long Rest");
    expect(() => assertNoReplyAuthor(AUTHOR.email)).not.toThrow();
    expect(() => assertNoReplyAuthor("someone@" + "example.com")).toThrow(/no-reply/);
    expect(releaseMessage("0.1.0")).toBe("The Long Rest for Foundry VTT v0.1.0\n");
  });
});

describe("publish, end to end against local repos (no network)", () => {
  const dirs = [];
  // Each test repo carries its own patterns file; an inherited LEAK_PATTERNS_FILE (publish's own
  // --verify run sets one) would override it, so clear it per test and restore it after.
  const inherited = process.env.LEAK_PATTERNS_FILE;
  beforeEach(() => { delete process.env.LEAK_PATTERNS_FILE; });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (inherited === undefined) delete process.env.LEAK_PATTERNS_FILE;
    else process.env.LEAK_PATTERNS_FILE = inherited;
  });
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "tlr-pub-test-"));
    dirs.push(root);
    const priv = join(root, "private");
    const pub = join(root, "public.git");
    git(root, "init", "-q", "-b", "main", priv);
    git(root, "init", "-q", "--bare", "-b", "main", pub);
    git(priv, "config", "user.name", "Dev");
    git(priv, "config", "user.email", "1+dev@users.noreply.github.com");
    writeFileSync(join(priv, "package.json"), JSON.stringify({ version: "0.1.0" }));
    writeFileSync(join(priv, "a.txt"), "one\n");
    writeFileSync(join(priv, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(priv, "ignored.txt"), "never published\n");
    git(priv, "add", "package.json", "a.txt", ".gitignore");
    git(priv, "commit", "-q", "-m", "private commit message: internal detail");
    writeFileSync(join(priv, "a.txt"), "two\n");
    git(priv, "commit", "-q", "-am", "another private message");
    // The private leak patterns file lives untracked in the private checkout.
    writeFileSync(join(priv, ".leak-patterns.local.json"), JSON.stringify([{ pattern: "\\bNEVERPRESENT\\b", label: "a private name" }]));
    git(priv, "remote", "add", "origin", "https://github.com/me/ws.git");
    git(priv, "remote", "add", "public", pub);
    const visibility = (u) => (u === pub ? "PUBLIC" : u.includes("ws") ? "PRIVATE" : null);
    return { priv, pub, visibility };
  };
  const quiet = () => {};
  const noChecks = () => [];

  it("the dry run builds nothing and lists only committed files (not ignored or untracked ones)", () => {
    const { priv } = setup();
    writeFileSync(join(priv, "untracked.txt"), "x");
    const r = publish({ repo: priv, ref: "HEAD", log: quiet });
    expect(r.pushed).toBe(false);
    expect(r.files.sort()).toEqual([".gitignore", "a.txt", "package.json"]);
  });

  it("pushes ONE commit with the reviewed tree, no private ancestry, a neutral author and the fixed message", () => {
    const { priv, pub, visibility } = setup();
    const tree = git(priv, "rev-parse", "HEAD^{tree}");
    const r = publish({ repo: priv, ref: "HEAD", remote: "public", push: true, reviewedTree: tree, visibility, checks: noChecks, log: quiet });
    expect(r.pushed).toBe(true);
    expect(git(pub, "rev-list", "--all").split("\n")).toHaveLength(1); // only the release commit
    expect(git(pub, "rev-parse", "main^{tree}")).toBe(tree);
    expect(git(pub, "log", "-1", "--format=%an <%ae>|%cn|%B", "main")).toBe(`The Long Rest <${AUTHOR.email}>|The Long Rest|The Long Rest for Foundry VTT v0.1.0`);
    expect(git(pub, "log", "--all", "--format=%B")).not.toMatch(/private|internal/);
    expect(git(pub, "tag", "-l")).toBe("v0.1.0");
  });

  it("the next release is one more commit on top of the public main (fast-forward, never forced)", () => {
    const { priv, pub, visibility } = setup();
    publish({ repo: priv, ref: "HEAD", remote: "public", push: true, reviewedTree: git(priv, "rev-parse", "HEAD^{tree}"), visibility, checks: noChecks, log: quiet });
    writeFileSync(join(priv, "package.json"), JSON.stringify({ version: "0.1.1" }));
    git(priv, "commit", "-q", "-am", "bump");
    const r = publish({ repo: priv, ref: "HEAD", remote: "public", push: true, reviewedTree: git(priv, "rev-parse", "HEAD^{tree}"), visibility, checks: noChecks, log: quiet });
    expect(git(pub, "rev-list", "--count", "main")).toBe("2");
    expect(r.parent).toBe(git(pub, "rev-parse", "main~1"));
  });

  it("refuses: a reviewed-tree mismatch, origin, an unchanged tree, a dirty working tree", () => {
    const { priv, visibility } = setup();
    const tree = git(priv, "rev-parse", "HEAD^{tree}");
    expect(() => publish({ repo: priv, ref: "HEAD", remote: "public", push: true, reviewedTree: "0".repeat(40), visibility, checks: noChecks, log: quiet })).toThrow(/reviewed-tree/);
    expect(() => publish({ repo: priv, ref: "HEAD", remote: "origin", push: true, reviewedTree: tree, visibility, checks: noChecks, log: quiet })).toThrow(/private workspace/);
    publish({ repo: priv, ref: "HEAD", remote: "public", push: true, reviewedTree: tree, visibility, checks: noChecks, log: quiet });
    expect(() => publish({ repo: priv, ref: "HEAD", remote: "public", push: true, reviewedTree: tree, visibility, checks: noChecks, log: quiet })).toThrow(/nothing to publish/);
    writeFileSync(join(priv, "a.txt"), "dirty\n");
    expect(() => publish({ repo: priv, ref: "HEAD", log: quiet })).toThrow(/uncommitted/);
  });

  it("the push is atomic: a rejected tag leaves the public main unmoved (and the release retryable)", () => {
    const { priv, pub, visibility } = setup();
    // Someone already created v0.1.0 on the public remote (pointing elsewhere).
    const other = join(dirs[0], "other");
    git(dirs[0], "init", "-q", "-b", "main", other);
    writeFileSync(join(other, "x.txt"), "x\n");
    git(other, "add", "x.txt");
    git(other, "-c", "user.name=o", "-c", "user.email=1+o@users.noreply.github.com", "commit", "-q", "-m", "other");
    git(other, "push", "-q", pub, "HEAD:refs/tags/v0.1.0");
    const tree = git(priv, "rev-parse", "HEAD^{tree}");
    expect(() => publish({ repo: priv, ref: "HEAD", remote: "public", push: true, reviewedTree: tree, visibility, checks: noChecks, log: quiet })).toThrow();
    expect(() => git(pub, "rev-parse", "--verify", "-q", "refs/heads/main")).toThrow(); // main was NOT pushed
    // Once the stray tag is gone, the same release goes through (not stuck on "nothing to publish").
    git(pub, "tag", "-d", "v0.1.0");
    expect(publish({ repo: priv, ref: "HEAD", remote: "public", push: true, reviewedTree: tree, visibility, checks: noChecks, log: quiet }).pushed).toBe(true);
    expect(git(pub, "rev-parse", "main^{tree}")).toBe(tree);
  });

  it("verify/push refuse without the private patterns file; the checks receive its path", () => {
    const { priv, visibility } = setup();
    const tree = git(priv, "rev-parse", "HEAD^{tree}");
    const needsFile = () => [["node", ["-e", "process.exit(process.env.LEAK_PATTERNS_FILE && require('fs').existsSync(process.env.LEAK_PATTERNS_FILE) ? 0 : 3)"]]];
    expect(publish({ repo: priv, ref: "HEAD", remote: "public", verify: true, visibility, checks: needsFile, log: quiet }).pushed).toBe(false);
    rmSync(join(priv, ".leak-patterns.local.json"));
    expect(() => publish({ repo: priv, ref: "HEAD", remote: "public", verify: true, visibility, checks: needsFile, log: quiet })).toThrow(/private leak patterns file is missing/);
    expect(() => publish({ repo: priv, ref: "HEAD", remote: "public", push: true, reviewedTree: tree, visibility, checks: needsFile, log: quiet })).toThrow(/private leak patterns file is missing/);
  });

  it("a failing check refuses before anything is pushed", () => {
    const { priv, pub, visibility } = setup();
    const failing = () => [["node", ["-e", "process.exit(1)"]]];
    expect(() => publish({ repo: priv, ref: "HEAD", remote: "public", push: true, reviewedTree: git(priv, "rev-parse", "HEAD^{tree}"), visibility, checks: failing, log: quiet })).toThrow();
    expect(git(pub, "rev-list", "--all")).toBe("");
  });
});
