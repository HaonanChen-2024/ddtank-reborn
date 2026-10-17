import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncNotes } from "./sync-notes.mjs";

function fixture(t) {
  const parent = path.resolve(process.env.WORKSHOP_NOTES_TEST_ROOT ?? os.tmpdir()); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "notes-sync-"));
  t.after(() => { const rel = path.relative(parent, fs.realpathSync(root)); assert.ok(rel.startsWith("notes-sync-") && !rel.includes(path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const project = path.join(root, "project"), repo = path.join(project, "source/repo"), mirror = path.join(root, "mirror");
  const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  fs.mkdirSync(mirror, { recursive: true });
  for (const name of ["执行计划.md", "执行记录.md", "本地运行与维护.md"]) put(path.join(repo, "docs", name), "短文档：" + name + "\n");
  put(path.join(repo, "docs/archive/date/执行计划.md"), Buffer.from("原始\r\n正文\r\n"));
  put(path.join(repo, "docs/archive/date/manifest.json"), "{}\n");
  put(path.join(project, "执行计划.md"), "项目旧正文\r\n"); put(path.join(mirror, "执行计划.md"), "镜像旧正文\r\n");
  put(path.join(project, "素材台账.md"), "台账\n"); put(path.join(project, "docs/素材台账/items.csv"), "id,name\r\n1,测试\r\n");
  put(path.join(mirror, "个人补充.md"), "保留");
  const run = write => syncNotes({ repo, project, mirror, write });
  return { root, repo, project, mirror, put, run };
}
test("default check writes nothing and plans repo-owned notes plus project-owned ledger", t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.project, "执行计划.md")), result = f.run(false);
  assert.equal(result.mode, "check"); assert.equal(result.files, 12); assert.equal(result.changed, 12);
  assert.equal(result.backupRoot, null); assert.deepEqual(fs.readFileSync(path.join(f.project, "执行计划.md")), before);
  assert.equal(fs.existsSync(path.join(f.project, "runtime")), false); assert.equal(fs.existsSync(path.join(f.mirror, "执行记录.md")), false);
});
test("write retains replaced originals, mirrors canonical bytes and keeps extra files", t => {
  const f = fixture(t), projectOld = fs.readFileSync(path.join(f.project, "执行计划.md")), mirrorOld = fs.readFileSync(path.join(f.mirror, "执行计划.md"));
  const result = f.run(true); assert.deepEqual(result.differences, []); assert.deepEqual(result.conflicts, []); assert.equal(result.deletedFiles, 0);
  assert.deepEqual(fs.readFileSync(path.join(result.backupRoot, "project/执行计划.md")), projectOld);
  assert.deepEqual(fs.readFileSync(path.join(result.backupRoot, "mirror/执行计划.md")), mirrorOld);
  for (const target of [path.join(f.project, "docs/本地运行与维护.md"), path.join(f.mirror, "本地运行与维护.md")]) assert.deepEqual(fs.readFileSync(target), fs.readFileSync(path.join(f.repo, "docs/本地运行与维护.md")));
  assert.deepEqual(fs.readFileSync(path.join(f.mirror, "归档/date/执行计划.md")), fs.readFileSync(path.join(f.repo, "docs/archive/date/执行计划.md")));
  assert.equal(fs.readFileSync(path.join(f.mirror, "个人补充.md"), "utf8"), "保留");
  assert.equal(f.run(true).changed, 0);
});
test("archive conflict prevents every write and preserves both versions", t => {
  const f = fixture(t), target = path.join(f.mirror, "归档/date/执行计划.md"); f.put(target, "不同历史");
  const before = fs.readFileSync(path.join(f.project, "执行计划.md"));
  assert.equal(f.run(false).conflicts.length, 1); assert.throws(() => f.run(true), /history archive differs/);
  assert.deepEqual(fs.readFileSync(path.join(f.project, "执行计划.md")), before); assert.equal(fs.readFileSync(target, "utf8"), "不同历史");
  assert.equal(fs.existsSync(path.join(f.project, "runtime")), false);
});
test("missing canonical source and overlapping roots fail before replacement", t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.project, "执行计划.md"));
  fs.rmSync(path.join(f.repo, "docs/本地运行与维护.md")); assert.throws(() => f.run(true), /ENOENT/);
  assert.deepEqual(fs.readFileSync(path.join(f.project, "执行计划.md")), before);
  assert.throws(() => syncNotes({ repo: f.repo, project: f.project, mirror: f.project, write: true }), /overlap/);
});
