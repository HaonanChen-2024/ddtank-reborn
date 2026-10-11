import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { inflateRawSync } from "node:zlib";
import { patchBagLayoutArchive, patchBagLayoutXml, patchGameoverTitleXml, runLayoutCommand, zipRecords } from "./workshop-bag-layout.mjs";

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

const gameoverXml = '<custom classname="flash.geom.Point" stylename="takeoutCard.SmallCardViewPos" x="500" y="50"/><bitmapData resourceLink="asset.takeoutCard.TitleBitmap" x="250" y="-20" smoothing="true"/><custom stylename="takeoutCard.SmallCardViewCountDownPos" x="126" y="-39"/>';
test("SmallCards title moves only the reviewed x and rejects wrong or duplicate layout owners", () => {
  assert.equal(patchGameoverTitleXml(Buffer.from(gameoverXml)).toString(), gameoverXml.replace('x="250"', 'x="180"'));
  for (const xml of [gameoverXml.replace('x="250"', 'x="251"'), gameoverXml.replace('y="-20"', 'y="0"'), gameoverXml.replace('x="500"', 'x="499"'), gameoverXml.replace('TitleBitmap', 'WrongBitmap'), gameoverXml + '<bitmapData resourceLink="asset.takeoutCard.TitleBitmap" x="250" y="-20"/>']) assert.throws(() => patchGameoverTitleXml(Buffer.from(xml)), /position changed|expected one original/);
});

function entryBytes(bytes, name) {
  const entry = zipRecords(bytes).records.find(record => record.name === name);
  return inflateRawSync(bytes.subarray(entry.data, entry.data + entry.compressedSize));
}
test("bag label alignment upgrades an owned legacy journal while retaining the gameover patch", async () => {
  const { fixture, target } = fixtureRoot();
  try {
    const old = await runLayoutCommand("install", fixture, source, { gameoverTitle: true });
    const before = readFileSync(target);
    const next = await runLayoutCommand("install", fixture, source, { bagLabelAlignment: true });
    assert.notEqual(next.sha256, old.sha256);
    assert.deepEqual(next.patchFlags, { gameoverTitle: true, bagLabelAlignment: true });
    assert.deepEqual(entryBytes(readFileSync(target), "gameOver.xml"), entryBytes(before, "gameOver.xml"));
    const bag = entryBytes(readFileSync(target), "bagAndInfo.xml").toString();
    for (const name of ["personanHideGlassCheckBox", "personanHideHatCheckBox", "personanHideSuitCheckBox", "personanHideWingCheckBox"]) {
      const tag = [...bag.matchAll(/<component\b[^>]*\/>/g)].find(([tag]) => tag.includes(`stylename="${name}"`))[0];
      assert.match(tag, /\bfieldX="18"/);
      assert.match(tag, /\bfieldY="-1"/);
    }
    assert.equal((await runLayoutCommand("install", fixture, source)).unchanged, true);
    assert.equal((await runLayoutCommand("verify", fixture, source)).sha256, next.sha256);
    await runLayoutCommand("rollback", fixture, source);
    assert.equal(existsSync(target), false);
  } finally { rmSync(fixture, { recursive: true }); }
});
test("combined archive preserves bag effects and every unrelated compressed entry", async () => {
  const bag = await patchBagLayoutArchive(sourceBytes), combined = await patchBagLayoutArchive(sourceBytes, { gameoverTitle: true });
  assert.deepEqual(entryBytes(combined.output, "bagAndInfo.xml"), entryBytes(bag.output, "bagAndInfo.xml"));
  assert.deepEqual(entryBytes(combined.output, "gameOver.xml"), patchGameoverTitleXml(entryBytes(sourceBytes, "gameOver.xml")));
  const before = zipRecords(sourceBytes).records, after = zipRecords(combined.output).records;
  assert.equal(combined.summary.preservedCompressedEntries, 99);
  for (let i = 0; i < before.length; i++) if (!["bagAndInfo.xml", "gameOver.xml"].includes(before[i].name)) assert.deepEqual(combined.output.subarray(after[i].local, after[i].data + after[i].compressedSize), sourceBytes.subarray(before[i].local, before[i].data + before[i].compressedSize));
  await assert.rejects(patchBagLayoutArchive(sourceBytes, { unknown: true }), /unknown layout patch flag/);
  await assert.rejects(patchBagLayoutArchive(sourceBytes, { gameoverTitle: "yes" }), /invalid gameover title flag/);
});

function fixtureRoot() {
  const root = join(runtime, "client-text-followup"); mkdirSync(root, { recursive: true });
  const fixture = mkdtempSync(join(root, "layout-test-"));
  assert.ok(resolve(fixture).startsWith(resolve(root) + sep));
  return { fixture, target: join(fixture, "client-overlay/ui/vietnam/xml/xml.png"), ledger: join(fixture, "client-text-followup/layout-overlay.json") };
}
test("legacy ledger upgrades once without changing its backup and defaults retain the enabled title", async () => {
  const { fixture, target, ledger } = fixtureRoot();
  try {
    const bag = await runLayoutCommand("install", fixture, source), oldLedger = readFileSync(ledger), old = JSON.parse(oldLedger), oldOverlay = readFileSync(target);
    assert.equal(old.patchFlags, undefined);
    const candidate = await runLayoutCommand("verify", fixture, source, { gameoverTitle: true });
    assert.equal(candidate.installed, false); assert.equal(candidate.unchanged, false);
    assert.deepEqual(readFileSync(ledger), oldLedger); assert.deepEqual(readFileSync(target), oldOverlay);
    const upgraded = await runLayoutCommand("install", fixture, source, { gameoverTitle: true });
    assert.notEqual(upgraded.sha256, bag.sha256); assert.equal(upgraded.unchanged, false);
    const current = JSON.parse(readFileSync(ledger)); assert.equal(current.backup, old.backup); assert.deepEqual(readFileSync(old.backup), sourceBytes);
    const newLedger = readFileSync(ledger), newOverlay = readFileSync(target);
    for (const command of ["install", "verify"]) { const result = await runLayoutCommand(command, fixture, source); assert.equal(result.sha256, upgraded.sha256); assert.equal(result.patchFlags.gameoverTitle, true); assert.equal(result.unchanged, true); }
    assert.deepEqual(readFileSync(ledger), newLedger); assert.deepEqual(readFileSync(target), newOverlay);
    await assert.rejects(runLayoutCommand("install", fixture, source, { gameoverTitle: false }), /only enables/);
    assert.equal((await runLayoutCommand("rollback", fixture, source)).backupRetained, true);
    assert.equal(existsSync(target), false); assert.equal(existsSync(ledger), false); assert.deepEqual(readFileSync(old.backup), sourceBytes);
  } finally { rmSync(fixture, { recursive: true }); }
});

test("migration refuses changed source, backup and old summary before writing", async () => {
  const { fixture, target, ledger } = fixtureRoot(), sourceCopy = join(fixture, "source.png"); writeFileSync(sourceCopy, sourceBytes);
  try {
    await runLayoutCommand("install", fixture, sourceCopy);
    const oldLedger = readFileSync(ledger), old = JSON.parse(oldLedger), oldOverlay = readFileSync(target);
    writeFileSync(sourceCopy, Buffer.from("changed source"));
    await assert.rejects(runLayoutCommand("install", fixture, sourceCopy, { gameoverTitle: true }), /source changed since install/); writeFileSync(sourceCopy, sourceBytes);
    writeFileSync(old.backup, Buffer.from("changed backup"));
    await assert.rejects(runLayoutCommand("install", fixture, sourceCopy, { gameoverTitle: true }), /backup changed/); writeFileSync(old.backup, sourceBytes);
    writeFileSync(ledger, JSON.stringify({ ...old, bytes: old.bytes + 1 }));
    await assert.rejects(runLayoutCommand("install", fixture, sourceCopy, { gameoverTitle: true }), /previous layout summary changed: bytes/); writeFileSync(ledger, oldLedger);
    writeFileSync(ledger, JSON.stringify({ ...old, patchFlags: { gameoverTitle: true } }));
    await assert.rejects(runLayoutCommand("install", fixture, sourceCopy, { gameoverTitle: true }), /previous layout summary changed/); writeFileSync(ledger, oldLedger);
    assert.deepEqual(readFileSync(target), oldOverlay); assert.deepEqual(readFileSync(ledger), oldLedger);
    assert.equal((await runLayoutCommand("verify", fixture, sourceCopy)).unchanged, true);
  } finally { rmSync(fixture, { recursive: true }); }
  const fresh = fixtureRoot(), wrongSource = join(fresh.fixture, "wrong-source.png"); writeFileSync(wrongSource, Buffer.from("unreviewed"));
  try { await assert.rejects(runLayoutCommand("install", fresh.fixture, wrongSource, { gameoverTitle: true }), /unreviewed layout source/); assert.equal(existsSync(fresh.target), false); assert.equal(existsSync(fresh.ledger), false); }
  finally { rmSync(fresh.fixture, { recursive: true }); }
});

test("journal rename failure restores the prior overlay and exact legacy ledger bytes", async t => {
  const { fixture, target, ledger } = fixtureRoot();
  try {
    await runLayoutCommand("install", fixture, source);
    const oldLedger = readFileSync(ledger), oldOverlay = readFileSync(target), old = JSON.parse(oldLedger), rename = fs.renameSync;
    let fail = true;
    t.mock.method(fs, "renameSync", (from, to) => {
      if (to === ledger && fail) { fail = false; assert.notDeepEqual(readFileSync(target), oldOverlay, "failure must happen after writing the new overlay"); throw new Error("injected journal rename failure"); }
      return rename(from, to);
    }); syncBuiltinESMExports();
    await assert.rejects(runLayoutCommand("install", fixture, source, { gameoverTitle: true }), /injected journal rename failure/);
    assert.equal(fail, false); assert.deepEqual(readFileSync(target), oldOverlay); assert.deepEqual(readFileSync(ledger), oldLedger); assert.deepEqual(readFileSync(old.backup), sourceBytes);
    assert.equal((await runLayoutCommand("verify", fixture, source)).unchanged, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(fixture, { recursive: true }); }
});

test("overlay drift after async old-summary validation blocks install and rollback", async t => {
  const { fixture, target, ledger } = fixtureRoot();
  try {
    await runLayoutCommand("install", fixture, source);
    const oldLedger = readFileSync(ledger), oldOverlay = readFileSync(target), external = Buffer.from("external overlay during ZIP verification"), read = fs.readFileSync;
    let reads = 0;
    t.mock.method(fs, "readFileSync", (file, ...args) => {
      if (file === target && ++reads === 2) writeFileSync(target, external);
      return read(file, ...args);
    }); syncBuiltinESMExports();
    for (const command of ["install", "rollback"]) {
      writeFileSync(target, oldOverlay); reads = 0;
      await assert.rejects(runLayoutCommand(command, fixture, source, command === "install" ? { gameoverTitle: true } : {}), /overlay changed during verification/);
      assert.equal(reads, 2); assert.deepEqual(read(target), external); assert.deepEqual(read(ledger), oldLedger);
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(fixture, { recursive: true }); }
});
