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

export function patchBagLayoutXml(bytes) {
  const original = bytes.toString("utf8");
  assert.deepEqual(Buffer.from(original), bytes, "layout is not lossless UTF-8");
  // FilterFrameText defaults to autoSize=left. Keep it for the SNS style that inherits a checkbox.
  let text = component(original, labelStyle, { width: 28, height: 18, autoSize: "left" });
  for (let i = 0; i < checkStyles.length; i++) {
    text = component(text, checkStyles[i], { width: 46, height: 18, x: i % 2 ? 374 : 324, y: i < 2 ? 300 : 324 });
  }
  return Buffer.from(text);
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

export async function patchBagLayoutArchive(bytes) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const original = zipRecords(bytes), target = original.records.find(record => record.name === entryName);
  assert.ok(target, "original bagAndInfo.xml absent");
  assert.equal(bytes.readUInt16LE(target.local + 6) & 9, 0, "encrypted/data-descriptor target unsupported");
  assert.equal(bytes.readUInt16LE(target.local + 8), 8, "expected original DEFLATE layout entry");
  const sourceXml = await zip.file(entryName).async("nodebuffer"), patchedXml = patchBagLayoutXml(sourceXml);
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
    entries: original.records.length, preservedEntries: original.records.length - 1, preservedCompressedEntries: original.records.length - 1,
    labelField: { width: 28, height: 18, autoSize: "left" }, columnX: [324, 374], rowY: [300, 324], renderingAccepted: false } };
}

function replace(target, bytes) {
  mkdirSync(dirname(target), { recursive: true });
  const fresh = target + `.workshop-${randomUUID()}`;
  try { writeFileSync(fresh, bytes, { flag: "wx" }); renameSync(fresh, target); }
  finally { if (existsSync(fresh)) unlinkSync(fresh); }
}

export async function runLayoutCommand(command, runtime = defaultRuntime, source = defaultSource) {
  assert.ok(["verify", "install", "rollback"].includes(command), "usage: workshop-bag-layout.mjs verify|install|rollback");
  const target = join(runtime, "client-overlay/ui/vietnam/xml/xml.png"), journalFile = join(runtime, "client-text-followup/layout-overlay.json");
  const backupRoot = resolve(runtime, "client-text-followup/layout-backups");
  const previous = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, "utf8")) : null;
  if (previous) {
    assert.equal(previous.target, target, "layout journal target differs; preserved");
    assert.ok(resolve(previous.backup).startsWith(backupRoot + sep), "layout backup outside owned directory");
    assert.equal(hash(readFileSync(target)), previous.sha256, "layout overlay changed since install; preserved");
    assert.equal(hash(readFileSync(previous.backup)), previous.sourceSha256, "layout backup changed; preserved");
    assert.equal(hash(readFileSync(source)), previous.sourceSha256, "layout source changed since install; preserved");
  } else assert.ok(!existsSync(target), "unowned/custom layout overlay preserved");
  if (command === "rollback") {
    assert.ok(previous, "no layout overlay journal");
    if (previous.hadOverlay) replace(target, readFileSync(previous.backup)); else unlinkSync(target);
    unlinkSync(journalFile);
    return { rolledBack: true, backupRetained: true, restartRequired: true };
  }
  const sourceBytes = readFileSync(source), result = await patchBagLayoutArchive(sourceBytes);
  if (previous) assert.equal(previous.sha256, result.summary.sha256, "source/layout patch changed; previous deployment preserved");
  if (command === "install" && !previous) {
    assert.ok(!existsSync(target) && !existsSync(journalFile), "layout overlay appeared during verification; preserved");
    mkdirSync(backupRoot, { recursive: true });
    const backup = join(backupRoot, `${Date.now()}-${randomUUID()}-xml.png`);
    writeFileSync(backup, sourceBytes, { flag: "wx" });
    try {
      replace(target, result.output);
      assert.equal(hash(readFileSync(target)), result.summary.sha256);
      writeFileSync(journalFile, JSON.stringify({ ...result.summary, target, backup, hadOverlay: false, installedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
    } catch (error) {
      if (existsSync(target) && hash(readFileSync(target)) === result.summary.sha256) unlinkSync(target);
      throw error;
    }
  }
  return { ...result.summary, installed: Boolean(previous) || command === "install", unchanged: Boolean(previous), restartRequired: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runLayoutCommand(process.argv[2] ?? "verify")));
}
