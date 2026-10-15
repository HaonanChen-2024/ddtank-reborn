#!/usr/bin/env node
// Patch one deployment ZIP entry; original AS3 events, SWFs and every other entry stay intact.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRuntime = resolve(repo, "../../runtime");
const defaultSource = join(repo, "apps/api/assets/flash/ui/vietnam/xml/xml.png");
const sourceSha256 = "ff80654d2e4cac4369b9eba5c8854853621a0d9e766fce1dd39833d924f2579d";
const entryName = "bagAndInfo.xml";
const labelStyle = "personalInfoCheckBoxText";
const checkStyles = ["personanHideGlassCheckBox", "personanHideHatCheckBox", "personanHideSuitCheckBox", "personanHideWingCheckBox"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// Reuse the installed ZIP library; this local workflow does not install dependencies.
let JSZip;
for (const packageFile of [join(repo, "package.json"), join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json")]) {
  try { JSZip = createRequire(packageFile)("jszip"); break; } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
}
assert.ok(JSZip, "existing jszip unavailable; no dependencies were installed");

function component(text, style, attributes) {
  let found = 0;
  const result = text.replace(/<component\b[^>]*\/>/g, tag => {
    if (!tag.includes(`stylename="${style}"`)) return tag;
    found++;
    for (const [name, value] of Object.entries(attributes)) {
      const attribute = new RegExp(`\\b${name}="[^"]*"`);
      if (attribute.test(tag)) tag = tag.replace(attribute, `${name}="${value}"`);
      else tag = tag.replace(/\/>$/, ` ${name}="${value}"/>`);
    }
    return tag;
  });
  assert.equal(found, 1, `expected one original component: ${style}`);
  return result;
}

export function patchBagLayoutXml(bytes, { bagLabelAlignment = false } = {}) {
  const original = bytes.toString("utf8");
  assert.deepEqual(Buffer.from(original), bytes, "layout is not lossless UTF-8");
  // FilterFrameText defaults to autoSize=left. Keep it for the SNS style that inherits a checkbox.
  let text = component(original, labelStyle, { width: 28, height: 18, autoSize: "left" });
  for (let i = 0; i < checkStyles.length; i++) {
    text = component(text, checkStyles[i], { width: 46, height: 18, x: i % 2 ? 374 : 324, y: i < 2 ? 300 : 324, ...(bagLabelAlignment ? { fieldX: 18 } : {}) });
  }
  return Buffer.from(text);
}

// Coordinates from the reference coreI.xml; paired with its original Chinese tip bitmaps.
export function patchOriginalTooltipLayoutXml(bytes) {
  const original = bytes.toString("utf8");
  assert.deepEqual(Buffer.from(original), bytes, "tooltip layout is not lossless UTF-8");
  let text = component(original, "core.GoodsTipTxt", { x: 32, y: -4 });
  text = component(text, "core.GoodsTipTypeTxt", { x: 32, y: -4 });
  text = component(text, "core.goodTip.BoundImage", { x: 125, y: 45 });
  return Buffer.from(text);
}

export function patchGameoverTitleXml(bytes) {
  const original = bytes.toString("utf8");
  assert.deepEqual(Buffer.from(original), bytes, "layout is not lossless UTF-8");
  const parents = [...original.matchAll(/<custom\b[^>]*\/>/g)].filter(([tag]) => tag.includes('stylename="takeoutCard.SmallCardViewPos"'));
  assert.equal(parents.length, 1, "expected one original SmallCardView position");
  assert.ok(/\bclassname="flash.geom.Point"/.test(parents[0][0]) && /\bx="500"/.test(parents[0][0]) && /\by="50"/.test(parents[0][0]), "SmallCardView position changed; preserved");
  let found = 0;
  const text = original.replace(/<bitmapData\b[^>]*\/>/g, tag => {
    if (!tag.includes('resourceLink="asset.takeoutCard.TitleBitmap"')) return tag;
    found++;
    assert.ok(/\bx="250"/.test(tag) && /\by="-20"/.test(tag), "SmallCards title position changed; preserved");
    return tag.replace(/\bx="250"/, 'x="180"');
  });
  assert.equal(found, 1, "expected one original SmallCards title bitmap");
  return Buffer.from(text);
}

export function patchHallActivityLayoutXml(bytes) {
  const original = bytes.toString("utf8");
  assert.deepEqual(Buffer.from(original), bytes, "layout is not lossless UTF-8");
  let found = 0;
  const text = original.replace(/<custom\b[^>]*\/>/g, tag => {
    if (!tag.includes('stylename="hallIcon.hallRightIconViewPos"')) return tag;
    found++;
    assert.ok(/\bclassname="flash.geom.Point"/.test(tag) && /\bx="850"/.test(tag) && /\by="10"/.test(tag), "hall activity parent position changed; preserved");
    // Move the original parent anchor; its children and AS3 click handlers stay intact.
    return tag.replace(/\bx="850"/, 'x="820"').replace(/\by="10"/, 'y="82"');
  });
  assert.equal(found, 1, "expected one original hall activity parent position");
  return Buffer.from(text);
}

// Only the matching single-slot ABC branch consumes these new styles. Original
// calendar styles stay byte-for-byte intact, including the multi-slot layout.
const calendarExchangePoints = [
  ["Calendar.Activity.ExchangeDetailSize", 414, 236],
  ["Calendar.Activity.ExchangeFixedPos", 57, 300],
  ["CalendarGrid.GoodsExchangeView.CompactPos", 25, 0],
  ["CalendarGrid.GoodsExchangeView.CompactTitleSize", 300, 22],
  ["CalendarGrid.GoodsExchangeView.CompactExplainSize", 350, 28],
];

export function patchCalendarExchangeXml(bytes) {
  const original = bytes.toString("utf8");
  assert.deepEqual(Buffer.from(original), bytes, "layout is not lossless UTF-8");
  const tags = [...original.matchAll(/<(?:component|custom)\b[^>]*\/>/g)].map(([tag]) => tag);
  const named = style => tags.filter(tag => tag.includes(`stylename="${style}"`));
  for (const [style, expected] of [
    ["Calendar.ActivityDetailList", { width: "414", height: "368" }],
    ["CalendarGrid.GoodsExchangeView.Pos", { x: "25", y: "25" }],
    ["CalendarGrid.GoodsExchangeView.cellSize", { x: "63", y: "63" }],
  ]) {
    const matches = named(style);
    assert.equal(matches.length, 1, `expected one original calendar style: ${style}`);
    for (const [key, value] of Object.entries(expected)) assert.ok(matches[0].includes(`${key}="${value}"`), `original calendar style changed: ${style}.${key}; preserved`);
  }
  const additions = calendarExchangePoints.map(([style, x, y]) => `<custom classname="flash.geom.Point" stylename="${style}" x="${x}" y="${y}" />`);
  const existing = calendarExchangePoints.map(([style]) => named(style));
  if (existing.some(matches => matches.length)) {
    for (let i = 0; i < existing.length; i++) assert.deepEqual(existing[i], [additions[i]], "partial or changed calendar exchange styles; preserved");
    return bytes;
  }
  assert.equal(original.split("</customDisplay>").length, 2, "expected one calendar customDisplay section");
  return Buffer.from(original.replace("</customDisplay>", additions.map(tag => `\t\t${tag}`).join("\r\n") + "\r\n\t</customDisplay>"));
}

// JSZip handles decoding/CRC validation. Read only classic-ZIP framing to preserve untouched compressed bytes.
export function zipRecords(bytes) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length, "invalid ZIP end record");
  assert.equal(bytes.readUInt32LE(end + 4), 0, "multi-disk ZIP unsupported");
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  assert.notEqual(count, 65535, "ZIP64 unsupported");
  assert.equal(offset + bytes.readUInt32LE(end + 12), end, "unexpected ZIP central directory");
  const records = [];
  let position = offset;
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(position), 0x02014b50, "invalid ZIP entry record");
    const nameLength = bytes.readUInt16LE(position + 28);
    const length = 46 + nameLength + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
    const name = bytes.toString("utf8", position + 46, position + 46 + nameLength);
    const local = bytes.readUInt32LE(position + 42), compressedSize = bytes.readUInt32LE(position + 20);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50, "invalid ZIP local record");
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    assert.ok(data + compressedSize <= offset && position + length <= end, "ZIP entry outside data bounds");
    records.push({ name, position, length, local, data, compressedSize });
    position += length;
  }
  assert.equal(position, end);
  assert.equal(new Set(records.map(record => record.name)).size, records.length, "duplicate ZIP entries");
  return { end, offset, records };
}

async function patchLayoutEntry(bytes, entryName, patchXml) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const original = zipRecords(bytes), target = original.records.find(record => record.name === entryName);
  assert.ok(target, `original ${entryName} absent`);
  assert.equal(bytes.readUInt16LE(target.local + 6) & 9, 0, "encrypted/data-descriptor target unsupported");
  assert.equal(bytes.readUInt16LE(target.local + 8), 8, "expected original DEFLATE layout entry");
  const sourceXml = await zip.file(entryName).async("nodebuffer"), patchedXml = patchXml(sourceXml);
  const compressed = deflateRawSync(patchedXml, { level: 9 }), checksum = crc32(patchedXml) >>> 0;
  const delta = compressed.length - target.compressedSize;
  const data = Buffer.concat([bytes.subarray(0, target.data), compressed, bytes.subarray(target.data + target.compressedSize, original.offset)]);
  data.writeUInt32LE(checksum, target.local + 14);
  data.writeUInt32LE(compressed.length, target.local + 18);
  data.writeUInt32LE(patchedXml.length, target.local + 22);
  const central = Buffer.from(bytes.subarray(original.offset, original.end));
  for (const record of original.records) {
    const pos = record.position - original.offset;
    if (record.local > target.local) central.writeUInt32LE(record.local + delta, pos + 42);
    if (record === target) {
      central.writeUInt32LE(checksum, pos + 16);
      central.writeUInt32LE(compressed.length, pos + 20);
      central.writeUInt32LE(patchedXml.length, pos + 24);
    }
  }
  const tail = Buffer.from(bytes.subarray(original.end));
  tail.writeUInt32LE(original.offset + delta, 16);
  const output = Buffer.concat([data, central, tail]);
  const outputZip = await JSZip.loadAsync(output, { checkCRC32: true }), outputRecords = zipRecords(output);
  assert.deepEqual(outputRecords.records.map(record => record.name), original.records.map(record => record.name));
  for (let i = 0; i < original.records.length; i++) {
    const before = original.records[i], after = outputRecords.records[i];
    if (before === target) continue;
    assert.deepEqual(output.subarray(after.local, after.data + after.compressedSize), bytes.subarray(before.local, before.data + before.compressedSize), `non-target compressed entry changed: ${before.name}`);
    assert.deepEqual(await outputZip.file(before.name).async("nodebuffer"), await zip.file(before.name).async("nodebuffer"), `non-target entry content changed: ${before.name}`);
  }
  assert.deepEqual(await outputZip.file(entryName).async("nodebuffer"), patchedXml);
  return { output, summary: { sourceSha256: hash(bytes), sha256: hash(output), bytes: output.length, entry: entryName,
    entries: original.records.length, preservedEntries: original.records.length - 1, preservedCompressedEntries: original.records.length - 1 } };
}

function patchFlags(flags = {}) {
  assert.ok(flags && typeof flags === "object" && !Array.isArray(flags) && Object.keys(flags).every(key => ["gameoverTitle", "bagLabelAlignment", "calendarExchangeLayout", "hallActivityLayout", "originalTooltipLayout"].includes(key)), "unknown layout patch flag");
  assert.ok(flags.gameoverTitle === undefined || typeof flags.gameoverTitle === "boolean", "invalid gameover title flag");
  assert.ok(flags.bagLabelAlignment === undefined || typeof flags.bagLabelAlignment === "boolean", "invalid bag label alignment flag");
  assert.ok(flags.calendarExchangeLayout === undefined || typeof flags.calendarExchangeLayout === "boolean", "invalid calendar exchange layout flag");
  assert.ok(flags.hallActivityLayout === undefined || typeof flags.hallActivityLayout === "boolean", "invalid hall activity layout flag");
  assert.ok(flags.originalTooltipLayout === undefined || typeof flags.originalTooltipLayout === "boolean", "invalid original tooltip layout flag");
  return { gameoverTitle: flags.gameoverTitle ?? false, ...(flags.bagLabelAlignment ? { bagLabelAlignment: true } : {}), ...(flags.calendarExchangeLayout ? { calendarExchangeLayout: true } : {}), ...(flags.hallActivityLayout ? { hallActivityLayout: true } : {}), ...(flags.originalTooltipLayout ? { originalTooltipLayout: true } : {}) };
}

export async function patchBagLayoutArchive(bytes, flags = {}) {
  const selected = patchFlags(flags), bag = await patchLayoutEntry(bytes, entryName, source => patchBagLayoutXml(source, selected));
  const summary = { ...bag.summary, labelField: { width: 28, height: 18, autoSize: "left" }, columnX: [324, 374], rowY: [300, 324], renderingAccepted: false };
  if (selected.bagLabelAlignment) { summary.patchFlags = selected; summary.checkboxFieldX = 18; }
  let output = bag.output;
  if (selected.gameoverTitle) {
    const title = await patchLayoutEntry(output, "gameOver.xml", patchGameoverTitleXml);
    output = title.output;
    Object.assign(summary, { sha256: title.summary.sha256, bytes: output.length,
      preservedEntries: summary.entries - 2, preservedCompressedEntries: summary.entries - 2,
      patchFlags: selected, changedEntries: [entryName, "gameOver.xml"], gameoverTitle: { resourceLink: "asset.takeoutCard.TitleBitmap", x: 180, y: -20 } });
  }
  if (selected.calendarExchangeLayout) {
    const calendar = await patchLayoutEntry(output, "calendar.xml", patchCalendarExchangeXml);
    output = calendar.output;
    const changedEntries = [...(summary.changedEntries ?? [entryName]), "calendar.xml"];
    Object.assign(summary, { sha256: calendar.summary.sha256, bytes: output.length,
      preservedEntries: summary.entries - changedEntries.length, preservedCompressedEntries: summary.entries - changedEntries.length,
      patchFlags: selected, changedEntries, calendarExchangeLayout: { scope: "ActiveType1-single-slot", addedStyles: calendarExchangePoints.map(([name]) => name), requiresMatchingAbc: true } });
  }
  if (selected.hallActivityLayout) {
    const hall = await patchLayoutEntry(output, "ddthallIcon.xml", patchHallActivityLayoutXml);
    output = hall.output;
    const changedEntries = [...(summary.changedEntries ?? [entryName]), "ddthallIcon.xml"];
    Object.assign(summary, { sha256: hall.summary.sha256, bytes: output.length,
      preservedEntries: summary.entries - changedEntries.length, preservedCompressedEntries: summary.entries - changedEntries.length,
      patchFlags: selected, changedEntries, hallActivityLayout: { style: "hallIcon.hallRightIconViewPos", x: 820, y: 82 } });
  }
  if (selected.originalTooltipLayout) {
    const tips = await patchLayoutEntry(output, "coreI.xml", patchOriginalTooltipLayoutXml);
    output = tips.output;
    const changedEntries = [...(summary.changedEntries ?? [entryName]), "coreI.xml"];
    Object.assign(summary, { sha256: tips.summary.sha256, bytes: output.length,
      preservedEntries: summary.entries - changedEntries.length, preservedCompressedEntries: summary.entries - changedEntries.length,
      patchFlags: selected, changedEntries, originalTooltipLayout: { valueX: 32, valueY: -4, boundX: 125, boundY: 45, requiresMatchingOriginalArt: true } });
  }
  return { output, summary };
}

function replace(target, bytes) {
  mkdirSync(dirname(target), { recursive: true });
  const fresh = target + `.workshop-${randomUUID()}`;
  try { writeFileSync(fresh, bytes, { flag: "wx" }); renameSync(fresh, target); }
  finally { if (existsSync(fresh)) unlinkSync(fresh); }
}

export async function runLayoutCommand(command, runtime = defaultRuntime, source = defaultSource, options = {}) {
  assert.ok(["verify", "install", "rollback"].includes(command), "usage: workshop-bag-layout.mjs verify|install|rollback");
  const requested = patchFlags(options);
  assert.ok(options.gameoverTitle === undefined || requested.gameoverTitle, "gameover title option only enables the reviewed patch");
  assert.ok(options.bagLabelAlignment === undefined || requested.bagLabelAlignment, "bag label option only enables the reviewed patch");
  assert.ok(options.calendarExchangeLayout === undefined || requested.calendarExchangeLayout, "calendar exchange layout option only enables the reviewed patch");
  assert.ok(options.hallActivityLayout === undefined || requested.hallActivityLayout, "hall activity layout option only enables the reviewed patch");
  assert.ok(options.originalTooltipLayout === undefined || requested.originalTooltipLayout, "original tooltip layout option only enables the reviewed patch");
  assert.ok(command !== "rollback" || Object.keys(options).length === 0, "rollback does not take patch flags");
  const target = join(runtime, "client-overlay/ui/vietnam/xml/xml.png"), journalFile = join(runtime, "client-text-followup/layout-overlay.json");
  const backupRoot = resolve(runtime, "client-text-followup/layout-backups");
  const previousJournal = existsSync(journalFile) ? readFileSync(journalFile) : null;
  const previous = previousJournal ? JSON.parse(previousJournal.toString("utf8")) : null;
  const previousFlags = patchFlags(previous?.patchFlags), sourceBytes = readFileSync(source);
  const checkOwned = async () => {
    if (previous) {
      assert.equal(previous.target, target, "layout journal target differs; preserved");
      assert.ok(resolve(previous.backup).startsWith(backupRoot + sep), "layout backup outside owned directory");
      assert.deepEqual(readFileSync(journalFile), previousJournal, "layout journal changed during verification; preserved");
      assert.equal(hash(readFileSync(target)), previous.sha256, "layout overlay changed since install; preserved");
      const backup = readFileSync(previous.backup);
      assert.equal(hash(backup), previous.sourceSha256, "layout backup changed; preserved");
      assert.equal(hash(readFileSync(source)), previous.sourceSha256, "layout source changed since install; preserved");
      const prior = await patchBagLayoutArchive(backup, previousFlags);
      for (const [key, value] of Object.entries(prior.summary)) assert.deepEqual(previous[key], value, `previous layout summary changed: ${key}; preserved`);
      assert.deepEqual(readFileSync(journalFile), previousJournal, "layout journal changed during verification; preserved");
      assert.equal(hash(readFileSync(target)), previous.sha256, "layout overlay changed during verification; preserved");
      assert.equal(hash(readFileSync(previous.backup)), previous.sourceSha256, "layout backup changed during verification; preserved");
    } else assert.ok(!existsSync(target) && !existsSync(journalFile), "unowned/custom layout overlay preserved");
    assert.equal(hash(readFileSync(source)), sourceSha256, "unreviewed layout source; preserved");
  };
  await checkOwned();
  if (command === "rollback") {
    assert.ok(previous, "no layout overlay journal");
    if (previous.hadOverlay) replace(target, readFileSync(previous.backup)); else unlinkSync(target);
    unlinkSync(journalFile);
    return { rolledBack: true, backupRetained: true, restartRequired: true };
  }
  const selected = patchFlags({ ...previousFlags, ...options });
  const result = await patchBagLayoutArchive(sourceBytes, selected), unchanged = Boolean(previous && previous.sha256 === result.summary.sha256);
  if (command === "install" && !unchanged) {
    await checkOwned();
    const current = previous ? readFileSync(target) : null;
    const backup = previous?.backup ?? join(backupRoot, `${Date.now()}-${randomUUID()}-xml.png`);
    if (!previous) { mkdirSync(backupRoot, { recursive: true }); writeFileSync(backup, sourceBytes, { flag: "wx" }); }
    const journal = Buffer.from(JSON.stringify({ ...result.summary, target, backup, hadOverlay: previous?.hadOverlay ?? false, installedAt: new Date().toISOString() }, null, 2) + "\n");
    try {
      replace(target, result.output);
      assert.equal(hash(readFileSync(target)), result.summary.sha256);
      replace(journalFile, journal);
      assert.deepEqual(readFileSync(journalFile), journal);
    } catch (error) {
      if (existsSync(target) && hash(readFileSync(target)) === result.summary.sha256) { if (current) replace(target, current); else unlinkSync(target); }
      if (previousJournal) { if (!existsSync(journalFile) || readFileSync(journalFile).equals(journal)) replace(journalFile, previousJournal); }
      else if (existsSync(journalFile) && readFileSync(journalFile).equals(journal)) unlinkSync(journalFile);
      throw error;
    }
  }
  return { ...result.summary, installed: command === "install" || unchanged, unchanged, restartRequired: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(3);
  assert.ok(new Set(flags).size === flags.length && flags.every(flag => ["--gameover-title", "--bag-label-alignment", "--calendar-exchange-layout", "--hall-activity-layout", "--original-tooltip-layout"].includes(flag)), "unknown or duplicate layout option");
  console.log(JSON.stringify(await runLayoutCommand(process.argv[2] ?? "verify", defaultRuntime, defaultSource, { ...(flags.includes("--gameover-title") ? { gameoverTitle: true } : {}), ...(flags.includes("--bag-label-alignment") ? { bagLabelAlignment: true } : {}), ...(flags.includes("--calendar-exchange-layout") ? { calendarExchangeLayout: true } : {}), ...(flags.includes("--hall-activity-layout") ? { hallActivityLayout: true } : {}), ...(flags.includes("--original-tooltip-layout") ? { originalTooltipLayout: true } : {}) })));
}
