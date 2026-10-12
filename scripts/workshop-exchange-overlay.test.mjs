import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import { patchExchangeState } from "../tools/i18n/abc-strings/exchange-state.mjs";
import { literalOptions, runLiteralOverlay } from "./workshop-literals.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["2.png", "3.png", "DDT_Loading.swf"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const read = file => JSON.parse(readFileSync(file, "utf8"));

// Real SWF inputs, but all installer outputs and injected failures stay in this owned temp fixture.
function fixture(t, existing = []) {
  const dir = mkdtempSync(join(tmpdir(), "ddt-exchange-overlay-"));
  const assertOwned = () => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(dir.startsWith(join(tmpdir(), "ddt-exchange-overlay-")));
  };
  assertOwned();
  t.after(() => { assertOwned(); rmSync(dir, { recursive: true, force: true }); });
  const repoRoot = join(dir, "source"), runtimeRoot = join(dir, "runtime");
  for (const name of ["research/i18n/zh-CN-literals.json", "tools/i18n/abc-strings/translations.json", ...names.map(n => "apps/api/assets/flash/" + n)]) {
    const destination = join(repoRoot, name); mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(repo, name)));
  }
  const overlay = join(runtimeRoot, "client-overlay"), ledger = join(runtimeRoot, "client-overlay-literals.json");
  for (const name of existing) {
    assert.ok(names.includes(name)); mkdirSync(overlay, { recursive: true });
    writeFileSync(join(overlay, name), readFileSync(join(repoRoot, "apps/api/assets/flash", name)));
  }
  return { dir, repoRoot, runtimeRoot, overlay, ledger, run: options => runLiteralOverlay({ repoRoot, runtimeRoot, ...options }) };
}
function snapshot(root, timestamps = false) {
  if (!existsSync(root)) return null;
  const entries = [];
  function visit(path) {
    for (const child of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, child.name);
      if (child.isDirectory()) { entries.push({ path: relative(root, full), directory: true }); visit(full); }
      else entries.push({ path: relative(root, full), sha256: sha(readFileSync(full)), ...(timestamps ? { mtimeNs: statSync(full, { bigint: true }).mtimeNs } : {}) });
    }
  }
  visit(root); return entries;
}
function buffers(f) { return Object.fromEntries(names.map(name => [name, readFileSync(join(f.overlay, name))])); }
function assertSameFiles(f, before) { for (const name of names) assert.deepEqual(readFileSync(join(f.overlay, name)), before[name], name); }
function backups(journal) { return journal.files.map(entry => ({ path: entry.backup, sha256: sha(readFileSync(entry.backup)), hadOverlay: entry.hadOverlay })); }

test("exchange CLI option is explicit, rejects duplicates/unknown arguments and cannot narrow rollback", () => {
  assert.deepEqual(literalOptions(["--exchange-state"]), { command: "verify", activityResponse: false, exchangeState: true });
  assert.deepEqual(literalOptions(["install", "--activity-response", "--activity-state", "--exchange-state"]),
    { command: "install", activityResponse: true, activityState: true, exchangeState: true });
  for (const args of [["--exchange-state", "--exchange-state"], ["rollback", "--exchange-state"], ["verify", "install"], ["--exchange-state=true"], ["--exchange-states"]]) assert.throws(() => literalOptions(args));
});

test("fresh exchange verify implies response and state but creates no overlay, ledger, backup or source write", t => {
  const f = fixture(t), before = snapshot(f.dir, true);
  const plain = f.run(), pending = f.run({ exchangeState: true });
  assert.equal(pending.installed, false); assert.equal(pending.pendingTransition, true);
  for (const key of ["activityResponse", "activityState", "exchangeState"]) {
    assert.equal(pending[key], true); assert.equal(pending[key + "Installed"], false);
  }
  assert.notEqual(pending.files.find(x => x.name === "2.png").sha256, plain.files.find(x => x.name === "2.png").sha256);
  for (const name of ["3.png", "DDT_Loading.swf"]) assert.equal(pending.files.find(x => x.name === name).sha256, plain.files.find(x => x.name === name).sha256);
  assert.deepEqual(snapshot(f.dir, true), before); assert.equal(existsSync(f.runtimeRoot), false);
});

test("fresh exchange install records all implied consumers while unrelated outputs stay display-only", t => {
  const f = fixture(t), plain = f.run(), sourceBefore = snapshot(f.repoRoot, true);
  const result = f.run({ command: "install", exchangeState: true }), journal = read(f.ledger);
  for (const key of ["activityResponse", "activityState", "exchangeState"]) { assert.equal(result[key + "Installed"], true); assert.equal(journal[key], true); }
  assert.equal(result.pendingTransition, false); assert.equal(result.renderingAccepted, false);
  const again = patchExchangeState(readFileSync(join(f.overlay, "2.png"))); assert.equal(again.changed, false);
  for (const name of ["3.png", "DDT_Loading.swf"]) {
    const entry = journal.files.find(x => x.name === name);
    assert.equal(entry.sha256, plain.files.find(x => x.name === name).sha256);
    assert.equal(entry.activityResponse, undefined); assert.equal(entry.activityState, undefined); assert.equal(entry.exchangeState, undefined);
  }
  assert.deepEqual(snapshot(f.repoRoot, true), sourceBefore);
});

test("old activityState overlay upgrades only 2.png, preserves original backups and verify is read-only", t => {
  const f = fixture(t); f.run({ command: "install", activityState: true });
  const old = read(f.ledger), oldBytes = buffers(f), oldBackups = backups(old), before = snapshot(f.dir, true);
  assert.equal(old.exchangeState, undefined);
  const pending = f.run({ exchangeState: true });
  assert.equal(pending.activityResponseInstalled, true); assert.equal(pending.activityStateInstalled, true);
  assert.equal(pending.exchangeStateInstalled, false); assert.equal(pending.pendingTransition, true);
  assert.deepEqual(snapshot(f.dir, true), before);
  const expected = patchExchangeState(oldBytes["2.png"]); assert.equal(expected.changed, true);
  f.run({ command: "install", exchangeState: true });
  const upgraded = read(f.ledger); assert.equal(upgraded.exchangeState, true); assert.equal(upgraded.installedAt, old.installedAt);
  assert.deepEqual(readFileSync(join(f.overlay, "2.png")), expected.out); assert.deepEqual(backups(upgraded), oldBackups);
  for (const name of ["3.png", "DDT_Loading.swf"]) assert.deepEqual(readFileSync(join(f.overlay, name)), oldBytes[name]);
  const after = snapshot(f.dir, true);
  for (const options of [{}, { command: "install" }, { activityState: true }, { command: "install", activityResponse: true }, { exchangeState: true }]) {
    const repeat = f.run(options); assert.equal(repeat.unchanged, true); assert.equal(repeat.exchangeStateInstalled, true); assert.equal(repeat.pendingTransition, false);
    assert.deepEqual(snapshot(f.dir, true), after, "omitting new flag must preserve both installed semantics and bytes");
  }
});

test("rollback restores pre-existing overlay bytes, removes newly owned files and retains backups", t => {
  const f = fixture(t, ["3.png"]), original = readFileSync(join(f.overlay, "3.png")), sourceBefore = snapshot(f.repoRoot, true);
  f.run({ command: "install", exchangeState: true }); const before = backups(read(f.ledger));
  assert.deepEqual(f.run({ command: "rollback" }), { rolledBack: true, files: 3, restartRequired: true });
  assert.equal(existsSync(f.ledger), false); assert.equal(existsSync(join(f.overlay, "2.png")), false); assert.equal(existsSync(join(f.overlay, "DDT_Loading.swf")), false);
  assert.deepEqual(readFileSync(join(f.overlay, "3.png")), original);
  for (const backup of before) assert.equal(sha(readFileSync(backup.path)), backup.sha256);
  assert.deepEqual(snapshot(f.repoRoot, true), sourceBefore);
});

test("unknown exchange ledger flag values and impossible consumer dependency combinations are refused without writes", t => {
  const f = fixture(t); f.run({ command: "install", activityState: true }); const old = read(f.ledger);
  const cases = [
    ...[null, "true", 1, [], {}].map(exchangeState => ({ journal: { ...old, exchangeState }, error: /unknown exchange-state journal flag/ })),
    { journal: { ...old, activityState: false, exchangeState: true }, error: /requires its calendar state fix/ },
    { journal: { ...old, activityResponse: false, exchangeState: true }, error: /requires its response fix/ },
  ];
  for (const { journal, error } of cases) {
    writeFileSync(f.ledger, JSON.stringify(journal)); const before = snapshot(f.dir, true);
    for (const options of [{}, { command: "install", exchangeState: true }, { command: "rollback" }]) assert.throws(() => f.run(options), error);
    assert.deepEqual(snapshot(f.dir, true), before);
  }
});

test("forged exchange flag cannot reinterpret an old activityState output as already patched", t => {
  const f = fixture(t); f.run({ command: "install", activityState: true }); const journal = read(f.ledger);
  journal.exchangeState = true; writeFileSync(f.ledger, JSON.stringify(journal)); const before = snapshot(f.dir, true);
  assert.throws(() => f.run(), /recorded literal\/consumer output changed/);
  assert.throws(() => f.run({ command: "install", exchangeState: true }), /recorded literal\/consumer output changed/);
  assert.deepEqual(snapshot(f.dir, true), before);
});

test("tampered owned deployment and backup are preserved and rejected, including rollback", t => {
  const f = fixture(t); f.run({ command: "install", exchangeState: true }); const journal = read(f.ledger);
  const target = join(f.overlay, "2.png"), original = readFileSync(target);
  writeFileSync(target, Buffer.concat([original, Buffer.from([1])])); let before = snapshot(f.dir, true);
  for (const command of ["verify", "install", "rollback"]) assert.throws(() => f.run({ command }), /changed deployment preserved/);
  assert.deepEqual(snapshot(f.dir, true), before);
  writeFileSync(target, original); const backup = journal.files.find(x => x.name === "2.png").backup;
  writeFileSync(backup, Buffer.concat([readFileSync(backup), Buffer.from([1])])); before = snapshot(f.dir, true);
  for (const command of ["verify", "install", "rollback"]) assert.throws(() => f.run({ command }), /backup changed/);
  assert.deepEqual(snapshot(f.dir, true), before);
});

for (const failAfterPublication of [false, true]) test(`exchange upgrade publication failure ${failAfterPublication ? "after" : "before"} ledger rename restores old bytes and permits retry`, t => {
  const f = fixture(t); f.run({ command: "install", activityState: true });
  const before = snapshot(f.dir), old = buffers(f), rename = fs.renameSync; let injected = 0;
  const stub = mock.method(fs, "renameSync", (from, to) => {
    if (to === f.ledger && injected === 0) {
      injected++; if (failAfterPublication) rename(from, to);
      throw new Error("synthetic exchange publication failure");
    }
    return rename(from, to);
  });
  try { assert.throws(() => f.run({ command: "install", exchangeState: true }), /synthetic exchange publication failure/); }
  finally { stub.mock.restore(); }
  assert.equal(injected, 1); assertSameFiles(f, old); assert.deepEqual(snapshot(f.dir), before);
  const retried = f.run({ command: "install", exchangeState: true }); assert.equal(retried.exchangeStateInstalled, true);
  for (const name of ["3.png", "DDT_Loading.swf"]) assert.deepEqual(readFileSync(join(f.overlay, name)), old[name]);
});
