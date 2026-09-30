// Before a GitHub Release: prove the tag, package.json, the built manifest and the zip agree, and
// that the release has notes. Pure `checkRelease` (unit tested) + a CLI used by the release workflow:
//   node scripts/release-check.mjs v0.1.0   → prints the release notes to dist/RELEASE_NOTES.md
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REPO = "https://github.com/bpuhnk/thelongrest-foundry";

/** The `## <version>` section of CHANGELOG.md (without its heading), or null. */
export function notesFor(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## \\[?v?${version.replace(/\./g, "\\.")}\\]?(\\s|$)`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  return body || null;
}

/**
 * @param {{ tag: string, pkgVersion: string, manifest: any, zipManifest: any, zipEntries: string[], changelog: string }} input
 * @returns {{ ok: true, version: string, prerelease: boolean, notes: string } | { ok: false, errors: string[] }}
 */
export function checkRelease({ tag, pkgVersion, manifest, zipManifest, zipEntries, changelog }) {
  const errors = [];
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? "");
  if (!m) return { ok: false, errors: [`The tag "${tag}" isn't v<semver>.`] };
  const version = m[1];
  if (pkgVersion !== version) errors.push(`package.json is ${pkgVersion}, the tag is ${tag}.`);
  if (manifest?.id !== "the-long-rest") errors.push(`The manifest id is "${manifest?.id}".`);
  if (manifest?.version !== version) errors.push(`The manifest version is ${manifest?.version}.`);
  if (manifest?.manifest !== `${REPO}/releases/latest/download/module.json`) errors.push(`The manifest URL is ${manifest?.manifest}.`);
  if (manifest?.download !== `${REPO}/releases/download/${tag}/module.zip`) errors.push(`The download URL is ${manifest?.download}.`);
  if (JSON.stringify(zipManifest) !== JSON.stringify(manifest)) errors.push("The module.json inside module.zip differs from the released one.");
  for (const f of [...(manifest?.esmodules ?? []), ...(manifest?.languages ?? []).map((l) => l.path), "module.json", "LICENSE", "templates/settings.hbs"]) {
    if (!zipEntries.includes(f)) errors.push(`module.zip is missing ${f}.`);
  }
  const stray = zipEntries.filter((f) => !/^(module\.json|LICENSE|README\.md|scripts\/[^/]+\.js|lang\/[^/]+\.json|templates\/[^/]+\.hbs|styles\/[^/]+\.css)$/.test(f) && !f.endsWith("/"));
  if (stray.length) errors.push(`module.zip has unexpected files: ${stray.join(", ")}.`);
  const notes = notesFor(changelog ?? "", version);
  if (!notes) errors.push(`CHANGELOG.md has no "## ${version}" section.`);
  return errors.length ? { ok: false, errors } : { ok: true, version, prerelease: version.includes("-"), notes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  const manifest = JSON.parse(readFileSync("dist/module.json", "utf8"));
  const zipManifest = JSON.parse(execFileSync("unzip", ["-p", "module.zip", "module.json"], { encoding: "utf8" }));
  const zipEntries = execFileSync("unzip", ["-Z1", "module.zip"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const r = checkRelease({
    tag,
    pkgVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
    manifest,
    zipManifest,
    zipEntries,
    changelog: readFileSync("CHANGELOG.md", "utf8"),
  });
  if (!r.ok) {
    for (const e of r.errors) console.error(`release-check: ${e}`);
    process.exit(1);
  }
  writeFileSync("dist/RELEASE_NOTES.md", `${r.notes}\n`);
  console.log(`release-check: ${tag} OK${r.prerelease ? " (prerelease)" : ""}`);
}
