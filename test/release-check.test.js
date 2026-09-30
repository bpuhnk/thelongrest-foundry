import { describe, expect, it } from "vitest";

import { REPO, checkRelease, notesFor } from "../scripts/release-check.mjs";

const manifest = (v = "0.1.0", tag = `v${v}`) => ({
  id: "the-long-rest", version: v,
  manifest: `${REPO}/releases/latest/download/module.json`,
  download: `${REPO}/releases/download/${tag}/module.zip`,
  esmodules: ["scripts/the-long-rest.js"],
  languages: [{ lang: "en", path: "lang/en.json" }],
});
const ENTRIES = ["module.json", "LICENSE", "README.md", "scripts/", "scripts/the-long-rest.js", "lang/", "lang/en.json", "templates/", "templates/settings.hbs"];
const CHANGELOG = "# Changelog\n\n## 0.2.0-beta.1\n\n- beta\n\n## 0.1.0\n\n- first\n";
const input = (o = {}) => ({ tag: "v0.1.0", pkgVersion: "0.1.0", manifest: manifest(), zipManifest: manifest(), zipEntries: ENTRIES, changelog: CHANGELOG, ...o });

describe("checkRelease", () => {
  it("passes when tag, package, manifest, zip and changelog agree", () => {
    expect(checkRelease(input())).toEqual({ ok: true, version: "0.1.0", prerelease: false, notes: "- first" });
  });

  it("a hyphenated version is a prerelease", () => {
    const v = "0.2.0-beta.1";
    expect(checkRelease(input({ tag: `v${v}`, pkgVersion: v, manifest: manifest(v), zipManifest: manifest(v) }))).toMatchObject({ ok: true, prerelease: true, notes: "- beta" });
  });

  it.each([
    ["a non-semver tag", { tag: "release-1" }, /isn't v<semver>/],
    ["a tag that doesn't match package.json", { tag: "v0.1.1" }, /package.json is 0.1.0/],
    ["a download URL for another tag", { manifest: manifest("0.1.0", "v0.0.9"), zipManifest: manifest("0.1.0", "v0.0.9") }, /download URL/],
    ["a zip whose module.json differs", { zipManifest: { ...manifest(), version: "0.0.1" } }, /inside module.zip differs/],
    ["a zip missing the script", { zipEntries: ENTRIES.filter((e) => e !== "scripts/the-long-rest.js") }, /missing scripts\/the-long-rest.js/],
    ["a zip with a stray file", { zipEntries: [...ENTRIES, ".env"] }, /unexpected files: \.env/],
    ["a zip with a source map", { zipEntries: [...ENTRIES, "scripts/the-long-rest.js.map"] }, /unexpected files/],
    ["no changelog section", { changelog: "# Changelog\n" }, /no "## 0.1.0" section/],
  ])("refuses %s", (_l, o, message) => {
    const r = checkRelease(input(o));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(message);
  });
});

describe("notesFor", () => {
  it("takes one version's section, and doesn't confuse 0.1.0 with 0.1.00 or 10.1.0", () => {
    const log = "## 10.1.0\n\nten\n\n## 0.1.00\n\nnope\n\n## 0.1.0\n\nyes\n";
    expect(notesFor(log, "0.1.0")).toBe("yes");
  });
});
