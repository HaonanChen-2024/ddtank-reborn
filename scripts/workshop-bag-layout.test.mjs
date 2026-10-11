import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { patchBagLayoutArchive, patchBagLayoutXml, runLayoutCommand, zipRecords } from "./workshop-bag-layout.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."), runtime = resolve(repo, "../../runtime");
const source = join(repo, "apps/api/assets/flash/ui/vietnam/xml/xml.png"), sourceBytes = readFileSync(source);

test("real layout archive retains every other entry's original compressed bytes and contents", async () => {
  const result = await patchBagLayoutArchive(sourceBytes);
  assert.equal(result.summary.entries, 101);
  assert.equal(result.summary.preservedCompressedEntries, 100);
  assert.deepEqual(readFileSync(source), sourceBytes);
  assert.equal(zipRecords(result.output).records.length, 101);
});

test("bag-specific geometry keeps long-label autosizing and rejects missing controls", () => {
  const label = '<component stylename="personalInfoCheckBoxText" width="104" height="21"/>';
  const styles = ["personanHideGlassCheckBox", "personanHideHatCheckBox", "personanHideSuitCheckBox", "personanHideWingCheckBox"];
  const xml = Buffer.from(label + styles.map(style => `<component stylename="${style}" width="103" height="28" x="0" y="0"/>`).join(""));
  const output = patchBagLayoutXml(xml).toString();
  assert.match(output, /autoSize="left"/);
  assert.equal((output.match(/height="18"/g) ?? []).length, 5);
  assert.equal((output.match(/x="374"/g) ?? []).length, 2);
  assert.equal((output.match(/y="324"/g) ?? []).length, 2);
  assert.equal((output.match(/y="300"/g) ?? []).length, 2);
  assert.deepEqual(patchBagLayoutXml(Buffer.from(output)), Buffer.from(output));
  assert.throws(() => patchBagLayoutXml(Buffer.from(label)), /expected one original component/);
});

test("install is repeatable, unknown overlays block writes, and rollback retains the original backup", async () => {
  const root = join(runtime, "client-text-followup"); mkdirSync(root, { recursive: true });
  const fixture = mkdtempSync(join(root, "layout-test-"));
  assert.ok(resolve(fixture).startsWith(resolve(root) + sep) && /^layout-test-/.test(fixture.slice(root.length + 1)));
  const target = join(fixture, "client-overlay/ui/vietnam/xml/xml.png");
  try {
    const installed = await runLayoutCommand("install", fixture, source);
    assert.equal(installed.installed, true);
    assert.equal((await runLayoutCommand("install", fixture, source)).unchanged, true);
    assert.equal((await runLayoutCommand("verify", fixture, source)).sha256, installed.sha256);
    const journal = JSON.parse(readFileSync(join(fixture, "client-text-followup/layout-overlay.json"), "utf8"));
    const good = readFileSync(target), changed = Buffer.from("user-owned overlay");
    writeFileSync(target, changed);
    await assert.rejects(runLayoutCommand("rollback", fixture, source), /changed since install; preserved/);
    await assert.rejects(runLayoutCommand("install", fixture, source), /changed since install; preserved/);
    assert.deepEqual(readFileSync(target), changed);
    writeFileSync(target, good);
    assert.equal((await runLayoutCommand("rollback", fixture, source)).backupRetained, true);
    assert.equal(existsSync(target), false);
    assert.deepEqual(readFileSync(journal.backup), sourceBytes);
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, changed);
    await assert.rejects(runLayoutCommand("install", fixture, source), /unowned\/custom layout overlay preserved/);
    assert.deepEqual(readFileSync(target), changed);
  } finally { rmSync(fixture, { recursive: true }); }
});
