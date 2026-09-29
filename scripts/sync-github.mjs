import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ReplitConnectors } from "@replit/connectors-sdk";

const owner = "bcm";
const repo = "front-row";
const branch = "main";
const publish = process.argv.slice(2).join(" ") === "--publish";

if (process.argv.length > 2 && !publish) {
  console.error("Usage: npm run github:sync [-- --publish]");
  process.exit(1);
}

// Only application files tracked by Git are eligible. Replit uploads, agent
// notes, and local secret files must never be copied to the public repository.
const rootFiles = new Set([
  ".gitignore", ".replit", "README.md", "components.json", "drizzle.config.ts",
  "package.json", "package-lock.json", "postcss.config.js", "replit.md",
  "tailwind.config.ts", "tsconfig.json", "vite.config.ts",
]);
const sourceDirectories = ["client/", "server/", "shared/", "scripts/"];

function allowed(path) {
  if (!rootFiles.has(path) && !sourceDirectories.some((dir) => path.startsWith(dir))) {
    return false;
  }
  return !path.split("/").some((part) =>
    /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|.*(?:secret|credential).*)$/i.test(part)
  );
}

function blobSha(buffer) {
  return createHash("sha1")
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest("hex");
}

const connectors = new ReplitConnectors();
const base = `/repos/${owner}/${repo}`;

async function api(path, init = {}) {
  const response = await connectors.proxy("github", `${base}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json" },
  });
  if (!response.ok) {
    const message = (await response.text()).slice(0, 500);
    throw new Error(`GitHub ${init.method || "GET"} ${path} failed (${response.status}): ${message}`);
  }
  return response.json();
}

async function main() {
  const repository = await api("");
  if (repository.private || repository.default_branch !== branch) {
    throw new Error(`Expected a public ${owner}/${repo} repository with ${branch} as its default branch.`);
  }

  const ref = await api(`/git/ref/heads/${branch}`);
  const head = ref.object.sha;
  const commit = await api(`/git/commits/${head}`);
  const remoteTree = await api(`/git/trees/${commit.tree.sha}?recursive=1`);
  if (remoteTree.truncated) throw new Error("GitHub returned an incomplete file list; refusing to sync.");

  const remoteFiles = new Map(
    remoteTree.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.sha])
  );
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0").filter(Boolean).filter(allowed);
  const localFiles = new Map();
  for (const path of tracked) {
    try {
      const content = await readFile(path);
      localFiles.set(path, { content, sha: blobSha(content) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const changes = [];
  for (const [path, file] of localFiles) {
    if (file.sha !== remoteFiles.get(path)) {
      changes.push({ path, action: remoteFiles.has(path) ? "update" : "add", content: file.content });
    }
  }
  for (const path of remoteFiles.keys()) {
    if (allowed(path) && !localFiles.has(path)) changes.push({ path, action: "delete" });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  if (changes.length === 0) {
    console.log("GitHub is already up to date.");
    return;
  }

  console.log(`${changes.length} change(s) for https://github.com/${owner}/${repo}:`);
  for (const change of changes) console.log(`  ${change.action.padEnd(6)} ${change.path}`);
  if (!publish) {
    console.log("\nPreview only. To publish these changes, run: npm run github:sync -- --publish");
    return;
  }

  const tree = [];
  for (const change of changes) {
    if (change.action === "delete") {
      tree.push({ path: change.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(change.content);
      tree.push({ path: change.path, mode: "100644", type: "blob", content });
    } catch {
      const blob = await api("/git/blobs", {
        method: "POST",
        body: JSON.stringify({ content: change.content.toString("base64"), encoding: "base64" }),
      });
      tree.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
    }
  }
  const nextTree = await api("/git/trees", {
    method: "POST",
    body: JSON.stringify({ base_tree: commit.tree.sha, tree }),
  });
  const nextCommit = await api("/git/commits", {
    method: "POST",
    body: JSON.stringify({
      message: `Sync Front Row source (${changes.length} files)`,
      tree: nextTree.sha,
      parents: [head],
    }),
  });
  // This is a fast-forward update. If GitHub changed in the meantime, it fails
  // instead of overwriting somebody else's work.
  await api(`/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: nextCommit.sha, force: false }),
  });
  console.log(`Published: https://github.com/${owner}/${repo}/commit/${nextCommit.sha}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});