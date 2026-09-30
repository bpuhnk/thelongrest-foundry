// Publish a release to the PUBLIC repo as ONE squashed commit (plan P7.2).
//
// This private repo is the workspace and is never published. A release takes the exact tree of a
// private ref (what the lead reviewed), makes ONE commit of it whose only parent is the public repo's
// main (none for the first release), verifies that commit in isolation, and pushes it only when asked.
// No private commit, message or PR ref can travel: the new commit descends from none of them.
//
//   node scripts/publish.mjs --ref <ref>                           dry run: the target + the file list
//   node scripts/publish.mjs --ref <ref> --remote <name> --verify  + all checks, still pushes nothing
//   node scripts/publish.mjs --ref <ref> --remote <name> --push --reviewed-tree <sha>
//
// Guarantees:
// - clean export: the commit's tree holds only committed files (never untracked or ignored ones);
// - one commit: a neutral author/committer ("The Long Rest", a GitHub no-reply address) and a fixed
//   message ("The Long Rest for Foundry VTT v<version>");
// - verification in a throwaway clone holding ONLY the public history + this commit: the full leak
//   scan over the tree and the history (the commit message included; the private repo's exemption
//   can't apply there) WITH the private patterns file, which is required (LEAK_PATTERNS_FILE or this
//   checkout's gitignored .leak-patterns.local.json), plus the tests, the build and the release
//   check. Any finding refuses;
// - --push needs a NAMED remote that is not `origin`, doesn't share origin's URL, is PUBLIC while
//   origin is PRIVATE (checked with gh; after the planned rename, GitHub redirects the old origin URL,
//   so a URL alone proves nothing), plus --reviewed-tree equal to the published tree;
// - one ATOMIC push of main + the tag (both or neither); no force path, and the commit must
//   fast-forward the public main.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const AUTHOR = { name: "The Long Rest", email: "5034059+bpuhnk@users.noreply.github.com" };
export const releaseMessage = (version) => `The Long Rest for Foundry VTT v${version}\n`;

/** The public history carries no personal email: only GitHub's no-reply addresses. */
export function assertNoReplyAuthor(email) {
  if (!/^(\d+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$/.test(email ?? "")) {
    throw new Error(`The author email must be a GitHub no-reply address (got "${email}").`);
  }
}

/**
 * Where a push may go. `remotes` maps name → url, `visibility(url)` returns "PUBLIC" | "PRIVATE" | null.
 * Pure (the checks are injected), so the refusals are unit tested.
 */
export function assertPublicTarget({ remote, remotes, visibility }) {
  if (!remote) throw new Error("Pushing needs a named remote (--remote <name>).");
  if (remote === "origin") throw new Error("Refusing to push to origin: that's the private workspace.");
  const url = remotes[remote];
  if (!url) throw new Error(`No git remote named "${remote}".`);
  if (remotes.origin && url === remotes.origin) throw new Error(`The remote "${remote}" has origin's URL: refusing.`);
  const target = visibility(url);
  if (target !== "PUBLIC") throw new Error(`The remote "${remote}" isn't a PUBLIC repo (${target ?? "unknown"}): refusing.`);
  if (remotes.origin && visibility(remotes.origin) !== "PRIVATE") throw new Error("origin isn't the PRIVATE workspace: check the remotes before publishing.");
  return url;
}

const git = (cwd, args, opts = {}) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, ...opts }).trim();
const run = (cwd, cmd, args, env = process.env) => execFileSync(cmd, args, { cwd, stdio: "inherit", env });

function ghVisibility(url) {
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url);
  if (!m) return null;
  try {
    return execFileSync("gh", ["repo", "view", m[1], "--json", "visibility", "-q", ".visibility"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Build (and, with verify/push, check) the public release commit in a throwaway repo. Exported for the
 * integration test, which drives it against local repos with injected remote checks.
 */
export const CHECKS = (tag) => [
  // ALL history (the clone holds only public commits) with the PRIVATE patterns required.
  ["node", ["scripts/leak-scan.mjs", "--history", "--require-private"]],
  ["npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]],
  ["npm", ["test"]],
  ["npm", ["run", "build"]],
  ["node", ["scripts/release-check.mjs", tag]],
];

export function publish({ repo, ref, remote = null, verify = false, push = false, reviewedTree = null, visibility = ghVisibility, checks = CHECKS, log = console.log }) {
  if (git(repo, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("The working tree has uncommitted changes.");
  const commit = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const tree = git(repo, ["rev-parse", `${commit}^{tree}`]);
  const version = JSON.parse(git(repo, ["show", `${commit}:package.json`])).version;
  const tag = `v${version}`;
  if (/^v\d/.test(ref) && ref !== tag) throw new Error(`The ref ${ref} doesn't match package.json's version (${version}).`);
  assertNoReplyAuthor(AUTHOR.email);
  const files = git(repo, ["ls-tree", "-r", "--name-only", commit]).split("\n").filter(Boolean);

  const remotes = Object.fromEntries(git(repo, ["remote", "-v"]).split("\n").filter((l) => l.endsWith("(push)")).map((l) => l.split(/\s+/).slice(0, 2)));
  const url = push || verify ? (push ? assertPublicTarget({ remote, remotes, visibility }) : remotes[remote] ?? null) : null;

  log(`publish: ${tag} from ${ref} (${commit.slice(0, 7)}), tree ${tree}`);
  log(`publish: target ${remote ? `${remote} → ${remotes[remote] ?? "(no such remote)"}` : "(none: dry run)"}`);
  log(`publish: ${files.length} files:\n  ${files.join("\n  ")}`);
  if (!verify && !push) {
    log("publish: DRY RUN. Nothing built or pushed. Add --remote <name> --verify to run the checks.");
    return { tree, tag, files, pushed: false };
  }
  if (!url) throw new Error(`No git remote named "${remote}".`);
  // The private leak patterns (gitignored in this checkout, or LEAK_PATTERNS_FILE) are REQUIRED: a
  // release is never scanned with only the generic rules the public scanner carries.
  const patterns = resolve(process.env.LEAK_PATTERNS_FILE || join(repo, ".leak-patterns.local.json"));
  if (!existsSync(patterns)) throw new Error(`The private leak patterns file is missing (${patterns}); refusing to verify or publish without it.`);

  const work = mkdtempSync(join(tmpdir(), "tlr-publish-"));
  try {
    git(work, ["init", "-q", "-b", "main"]);
    // The public history (if any) is the ONLY parent. The private commit is fetched just to have its
    // tree; nothing private is reachable from the commit made below, so no push can carry any.
    let parent = null;
    if (git(work, ["ls-remote", "--heads", url, "main"])) {
      git(work, ["fetch", "-q", url, "main"]);
      parent = git(work, ["rev-parse", "FETCH_HEAD"]);
      if (git(work, ["rev-parse", `${parent}^{tree}`]) === tree) throw new Error("The public main already has exactly this tree: nothing to publish.");
    }
    git(work, ["fetch", "-q", resolve(repo), commit]);
    const env = { ...process.env, GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email };
    const made = git(work, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], { input: releaseMessage(version), env });
    git(work, ["update-ref", "refs/heads/main", made]);

    // Verify in a CLEAN clone that holds only the public history + this one commit.
    const check = join(work, "check");
    git(work, ["clone", "-q", "--no-local", "--branch", "main", work, check]);
    const expected = parent ? Number(git(check, ["rev-list", "--count", parent])) + 1 : 1;
    if (git(check, ["rev-list", "--all"]).split("\n").length !== expected) throw new Error("The verification clone holds unexpected commits.");
    if (git(check, ["rev-parse", "HEAD^{tree}"]) !== tree) throw new Error("The verification clone's tree differs from the reviewed tree.");
    log(`publish: built ${made.slice(0, 7)} (${parent ? `parent ${parent.slice(0, 7)}` : "no parent: first release"}); verifying…`);
    const checkEnv = { ...process.env, LEAK_PATTERNS_FILE: patterns };
    for (const [cmd, args] of checks(tag)) run(check, cmd, args, checkEnv);

    if (!push) {
      log(`publish: verified; nothing pushed. To publish: --push --reviewed-tree ${tree}`);
      return { commit: made, tree, parent, tag, files, pushed: false };
    }
    if (reviewedTree !== tree) throw new Error(`--reviewed-tree (${reviewedTree}) isn't the tree being published (${tree}).`);
    git(work, ["tag", "-a", tag, "-m", `The Long Rest for Foundry VTT ${tag}`, made], { env });
    // ONE atomic push of main + the tag: either both land or neither does, so a rejected tag (it
    // already exists, the network drops) can't leave main public without its tag, a release that a
    // re-run would refuse as "nothing to publish". No force anywhere: a non-fast-forward is refused.
    run(work, "git", ["push", "--atomic", url, `${made}:refs/heads/main`, `refs/tags/${tag}`]);
    log(`publish: pushed ${tag} (${made.slice(0, 7)}) to ${remote}; its release workflow takes it from here.`);
    return { commit: made, tree, parent, tag, files, pushed: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      ref: { type: "string" },
      remote: { type: "string" },
      verify: { type: "boolean", default: false },
      push: { type: "boolean", default: false },
      "reviewed-tree": { type: "string" },
    },
  });
  if (!values.ref) {
    console.error("usage: node scripts/publish.mjs --ref <ref> [--remote <name> --verify] [--remote <name> --push --reviewed-tree <sha>]");
    process.exit(2);
  }
  try {
    publish({ repo: process.cwd(), ref: values.ref, remote: values.remote ?? null, verify: values.verify, push: values.push, reviewedTree: values["reviewed-tree"] ?? null });
  } catch (err) {
    console.error(`publish: ${err?.message ?? err}`);
    process.exit(1);
  }
}
