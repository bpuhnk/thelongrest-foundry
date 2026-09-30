// Build dist/ (module.json + bundled script + lang + LICENSE/README) and module.zip.
// Fails if the bundle contains eval / new Function: the module must never run strings as code.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/scripts", { recursive: true });

await build({ entryPoints: ["src/main.js"], bundle: true, format: "esm", target: "es2022", outfile: "dist/scripts/the-long-rest.js", legalComments: "inline", logLevel: "warning" });

const bundle = readFileSync("dist/scripts/the-long-rest.js", "utf8");
if (/\beval\s*\(|new\s+Function\s*\(/.test(bundle)) {
  console.error("Build refused: the bundle contains eval / new Function.");
  process.exit(1);
}

writeFileSync("dist/module.json", readFileSync("module.template.json", "utf8").replaceAll("{{version}}", pkg.version));
cpSync("src/lang", "dist/lang", { recursive: true });
cpSync("templates", "dist/templates", { recursive: true });
cpSync("LICENSE", "dist/LICENSE");
cpSync("README.md", "dist/README.md");
rmSync("module.zip", { force: true });
execFileSync("zip", ["-qr", "../module.zip", "."], { cwd: "dist" });
console.log(`built v${pkg.version}: dist/ + module.zip`);
