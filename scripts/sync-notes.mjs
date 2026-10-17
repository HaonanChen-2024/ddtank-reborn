import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (root, target) => { const rel = path.relative(root, target); return rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel); };
function targetPath(root, relative) {
  const target = path.resolve(root, relative);
  assert.ok(inside(root, target), "note target escapes its root");
  // Never follow an existing junction/symlink to write outside the declared notes root.
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) assert.ok(!fs.lstatSync(current).isSymbolicLink(), "note path contains a symlink/junction");
  }
  return target;
}
function filesWithin(root) {
  if (!fs.existsSync(root)) return [];
  const names = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      assert.ok(!item.isSymbolicLink(), "note source contains a symlink/junction");
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file); else if (item.isFile()) names.push(path.relative(root, file));
    }
  }
  walk(root); return names.sort();
}
export function syncNotes({ repo, project, mirror, write = false }) {
  repo = path.resolve(repo); project = path.resolve(project); mirror = path.resolve(mirror);
  assert.ok(fs.existsSync(repo) && fs.existsSync(project) && fs.existsSync(mirror), "repository, project and mirror roots must exist");
  for (const root of [repo, project, mirror]) assert.ok(!fs.lstatSync(root).isSymbolicLink(), "notes root must not be a symlink/junction");
  assert.ok(project !== mirror && !inside(project, mirror) && !inside(mirror, project), "project and mirror must not overlap");
  const pairs = [];
  const add = (from, targetRoot, rel, scope, immutable = false) => pairs.push({ from, to: targetPath(targetRoot, rel), rel: rel.replaceAll("\\", "/"), scope, immutable });
  for (const [source, projectFile, mirrorFile] of [
    ["docs/执行计划.md", "执行计划.md", "执行计划.md"],
    ["docs/执行记录.md", "docs/执行记录.md", "执行记录.md"],
    ["docs/本地运行与维护.md", "docs/本地运行与维护.md", "本地运行与维护.md"],
  ]) {
    const from = targetPath(repo, source);
    add(from, project, projectFile, "project"); add(from, mirror, mirrorFile, "mirror");
  }
  const archiveRoot = targetPath(repo, "docs/archive"), archiveFiles = filesWithin(archiveRoot);
  assert.ok(archiveFiles.length, "repository history archive is required before short-note synchronization");
  for (const rel of archiveFiles) for (const [root, scope] of [[project, "project"], [mirror, "mirror"]]) add(path.join(archiveRoot, rel), root, "docs/归档/" + rel, scope, true);
  // Mirror keeps the established top-level 归档 path instead of project/docs/归档.
  for (const pair of pairs.filter(pair => pair.scope === "mirror" && pair.immutable)) { pair.rel = pair.rel.slice(5); pair.to = targetPath(mirror, pair.rel); }
  // The existing material ledger remains project-owned; no duplication into repo.
  if (fs.existsSync(path.join(project, "素材台账.md"))) add(path.join(project, "素材台账.md"), mirror, "素材台账.md", "mirror");
  for (const rel of filesWithin(path.join(project, "docs/素材台账"))) add(path.join(project, "docs/素材台账", rel), mirror, "素材台账/" + rel, "mirror");
  const seen = new Set();
  const plan = pairs.map(pair => {
    assert.ok(!seen.has(pair.to.toLowerCase()), "duplicate note target"); seen.add(pair.to.toLowerCase());
    const bytes = fs.readFileSync(pair.from), previous = fs.existsSync(pair.to) ? fs.readFileSync(pair.to) : null;
    return { ...pair, bytes, previous, sourceSha256: sha(bytes), oldSha256: previous ? sha(previous) : null, differs: !previous?.equals(bytes) };
  });
  const conflicts = plan.filter(p => p.immutable && p.previous && p.differs).map(p => ({ scope: p.scope, path: p.rel }));
  if (write) assert.equal(conflicts.length, 0, "existing history archive differs; preserve it and choose a new dated archive");
  const changed = plan.filter(p => p.differs), backupRoot = changed.length && write ? targetPath(project, "runtime/notes-sync-backups/" + new Date().toISOString().replaceAll(/[:.]/g, "-")) : null;
  if (write) {
    // Complete the read/backup phase before replacing any visible note.
    for (const p of changed) {
      assert.equal(sha(fs.readFileSync(p.from)), p.sourceSha256, "note source changed after planning");
      if (p.previous) {
        assert.equal(sha(fs.readFileSync(p.to)), p.oldSha256, "note target changed after planning");
        const backup = targetPath(backupRoot, p.scope + "/" + p.rel);
        fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.writeFileSync(backup, p.previous, { flag: "wx" });
        assert.deepEqual(fs.readFileSync(backup), p.previous);
      }
    }
    for (const p of changed) {
      if (p.previous) assert.equal(sha(fs.readFileSync(p.to)), p.oldSha256, "note target changed while backups were written");
      else assert.ok(!fs.existsSync(p.to), "note target appeared after planning");
      fs.mkdirSync(path.dirname(p.to), { recursive: true }); fs.writeFileSync(p.to, p.bytes);
      assert.equal(sha(fs.readFileSync(p.to)), p.sourceSha256);
    }
  }
  const differences = plan.filter(p => !fs.existsSync(p.to) || sha(fs.readFileSync(p.to)) !== p.sourceSha256).map(p => ({ scope: p.scope, path: p.rel }));
  return { mode: write ? "write-and-check" : "check", canonicalNotes: "repository docs", files: plan.length, changed: changed.length, differences, conflicts, backupRoot, deletedFiles: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), arg = name => args.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (args.includes("--help")) console.log("node scripts/sync-notes.mjs --mirror=<Obsidian项目目录> [--project=<项目目录>] [--write]\n默认只检查；--write从repo同步三份短文档/历史归档到项目与镜像，素材台账只从项目同步到镜像；保留被替换旧文件，不删除目标额外文件。");
  else {
    assert.ok(args.every(x => x === "--write" || x.startsWith("--project=") || x.startsWith("--mirror=")), "unknown notes option");
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), project = path.resolve(arg("project") ?? path.join(repo, "../.."));
    const mirror = arg("mirror") ?? process.env.WORKSHOP_NOTES_MIRROR;
    assert.ok(mirror, "provide --mirror=<Obsidian project directory> or WORKSHOP_NOTES_MIRROR");
    const result = syncNotes({ repo, project, mirror, write: args.includes("--write") }); console.log(JSON.stringify(result, null, 2));
    if (result.differences.length || result.conflicts.length) process.exitCode = 1;
  }
}
