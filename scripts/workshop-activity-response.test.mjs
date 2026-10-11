import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import { patchActivityResponse } from "../tools/i18n/abc-strings/activity-response.mjs";
import { ByteReader, buildTag, compressSwf, decompressSwf, encodeU30, parseTags } from "../tools/i18n/abc-strings/lib.mjs";
import { patchSwfBuffer } from "../tools/i18n/abc-strings/patch.mjs";
import { literalOptions, runLiteralOverlay } from "./workshop-literals.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const u = encodeU30, byte = n => Buffer.from([n]), cat = (...parts) => Buffer.concat(parts);
// Exact guarded method body, embedded only in a synthetic ABC; no Flash player is executed.
const originalCode = Buffer.from("f104f0f103d030ef011c00f103ef011d01f303ef011e02f603f0f303d166675d786678878078d6f0f403d25d7e667e667fd0668001464d0229f0f503d25d7e667e668101d066ad01464d0229f0f6035daf01d1664866b00146af010180af01d7f0f7035d8d01d366b101468d01012cc701140b0000f0f903d066a3012661b201f0fb035d8d01d366b301468d0101668c0124000e150000f0fd035d9a01669a01469b0100d366b301462a0129f0ff0347", "hex");
const sharedCode = Buffer.from([0x2c, 0xc7, 1, 0x29, 0x47]);

function calendarAbc({ methodIndex = 33, traitKind = 65, privateKind = 5, methodName = "calendar:CalendarManager/private:__activityLoadComplete", code = originalCode } = {}) {
  const strings = Array.from({ length: 394 }, (_, i) => `s${i}`); strings[0] = "";
  Object.assign(strings, { 1: "calendar:CalendarManager", 2: "calendar", 3: "CalendarManager", 199: "True", 256: methodName,
    299: "void", 300: "__activityLoadComplete", 301: "_reciveActive", 302: "isAttend", 303: "String", 304: "value", 305: "LoaderEvent" });
  const pool = cat(u(strings.length), ...strings.slice(1).map(text => { const bytes = Buffer.from(text); return cat(u(bytes.length), bytes); }));
  const namespaces = cat(u(3), byte(privateKind), u(1), byte(22), u(2));
  const names = Array.from({ length: 226 }, (_, i) => ({ kind: 7, ns: 2, text: i }));
  Object.assign(names, { 2: { kind: 7, ns: 2, text: 3 }, 13: { kind: 7, ns: 2, text: 299 }, 28: { kind: 7, ns: 2, text: 305 },
    141: { kind: 7, ns: 2, text: 303 }, 163: { kind: 7, ns: 1, text: 301 }, 177: { kind: 14, text: 304 },
    178: { kind: 7, ns: 2, text: 302 }, 200: { kind: 7, ns: 1, text: 300 } });
  const multinames = cat(u(names.length), ...names.slice(1).map(n => n.kind === 14 ? cat(byte(14), u(n.text), u(1)) : cat(byte(7), u(n.ns), u(n.text))));
  const methods = cat(u(48), ...Array.from({ length: 48 }, (_, i) => i === 33
    ? cat(u(1), u(13), u(28), u(256), byte(128), u(10)) : cat(u(0), u(13), u(0), byte(0))));
  const trait = cat(u(200), byte(traitKind), u(0), u(methodIndex), ...(traitKind & 64 ? [u(0)] : []));
  const instance = cat(u(1), u(2), u(4), byte(0), u(0), u(0), u(1), trait);
  const bodies = cat(u(48), ...Array.from({ length: 48 }, (_, i) => {
    const body = i === 33 ? code : i === 5 ? sharedCode : byte(0x47);
    return cat(u(i), u(i === 33 ? 3 : 1), u(i === 33 ? 4 : 1), u(4), u(5), u(body.length), body, u(0), u(0));
  }));
  // Include a valid encoded 32-bit constant to cover the distinction from u30 counts/indices.
  return cat(Buffer.from([16, 0, 46, 0]), u(2), u(0xffffffff), u(1), u(1), pool, namespaces, u(2), u(1), u(2), multinames,
    methods, u(0), instance, u(1), u(0), u(1), u(2), u(0), bodies);
}
function abcTag(name, abc) { return buildTag(82, cat(Buffer.alloc(4), Buffer.from(name), byte(0), abc)); }
const displayAbc = cat(Buffer.from([16, 0, 46, 0, 1, 1, 1]), u(2), u(9), Buffer.from("Confirmar"), Buffer.from([1, 1, 1, 0, 0, 0, 0, 0]));
function fixtureSwf(options, copies = 1, tagName = "calendar/CalendarManager") {
  return compressSwf("CWS", 10, cat(Buffer.from([8, 0, 0, 24, 1, 0]), buildTag(9, Buffer.from([12, 34, 56])),
    abcTag("display/labels", displayAbc), ...Array.from({ length: copies }, () => abcTag(tagName, calendarAbc(options))), buildTag(0, Buffer.alloc(0))));
}
function abcOf(swf) {
  const { body } = decompressSwf(swf);
  for (const tag of parseTags(body).tags.filter(t => t.code === 82)) {
    const r = new ByteReader(body.subarray(tag.bodyStart, tag.bodyEnd)); r.u32();
    if (r.cstring() === "calendar/CalendarManager") return r.bytes(r.buf.length - r.pos);
  }
}
function privateFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ddt-activity-response-")), repoRoot = join(dir, "source"), runtimeRoot = join(dir, "runtime");
  assert.ok(realpathSync(dir).startsWith(resolve(tmpdir()) + "\\") || realpathSync(dir).startsWith(resolve(tmpdir()) + "/"));
  assert.ok(dirname(dir) === resolve(tmpdir()) && dir.startsWith(join(tmpdir(), "ddt-activity-response-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ["research/i18n", "tools/i18n/abc-strings", "apps/api/assets/flash"]) mkdirSync(join(repoRoot, folder), { recursive: true });
  writeFileSync(join(repoRoot, "research/i18n/zh-CN-literals.json"), JSON.stringify({ "Xác nhận": "确定" }));
  writeFileSync(join(repoRoot, "tools/i18n/abc-strings/translations.json"), JSON.stringify({ "Xác nhận": "Confirmar" }));
  const original = fixtureSwf(); for (const name of ["2.png", "3.png", "DDT_Loading.swf"]) writeFileSync(join(repoRoot, "apps/api/assets/flash", name), original);
  const ledger = join(runtimeRoot, "client-overlay-literals.json"), overlay = join(runtimeRoot, "client-overlay");
  return { repoRoot, runtimeRoot, ledger, overlay, original, run: options => runLiteralOverlay({ repoRoot, runtimeRoot, ...options }) };
}
function legacy(f) {
  f.run({ command: "install" }); const journal = JSON.parse(readFileSync(f.ledger)); delete journal.activityResponse;
  writeFileSync(f.ledger, JSON.stringify(journal, null, 2)); return journal;
}

test("options require an explicit activity switch and reject unknown or partial rollback options", () => {
  assert.deepEqual(literalOptions([]), { command: "verify", activityResponse: false });
  assert.deepEqual(literalOptions(["verify", "--activity-response"]), { command: "verify", activityResponse: true });
  for (const args of [["--offset=111"], ["verify", "install"], ["--activity-response", "--activity-response"], ["rollback", "--activity-response"]]) assert.throws(() => literalOptions(args));
});

test("only the callback operand and appended lowercase constant change; shared True and other tags survive", () => {
  const before = fixtureSwf(), result = patchActivityResponse(before), after = result.out;
  assert.equal(result.changed, true); assert.equal(result.unchangedMethods, 47);
  const a = parseTags(decompressSwf(before).body), b = parseTags(decompressSwf(after).body);
  assert.deepEqual(a.headerPrefix, b.headerPrefix); assert.equal(a.tags.length, b.tags.length);
  assert.deepEqual(a.tags.filter((_, i) => i !== 2).map(t => t.raw), b.tags.filter((_, i) => i !== 2).map(t => t.raw));
  const old = abcOf(before), patched = abcOf(after), newCode = Buffer.from(originalCode); newCode[111] = 0x8a; newCode[112] = 3;
  assert.ok(patched.includes(sharedCode)); assert.ok(patched.includes(newCode)); assert.equal(patched.includes(originalCode), false);
  assert.ok(old.includes(cat(u(4), Buffer.from("True")))); assert.ok(patched.includes(cat(u(4), Buffer.from("True"))));
  assert.ok(patched.includes(cat(u(4), Buffer.from("true"))));
  const again = patchActivityResponse(after); assert.equal(again.changed, false); assert.deepEqual(again.out, after);
});

test("unknown class/tag, duplicate target, private trait, method identity and body digest are rejected", () => {
  assert.throws(() => patchActivityResponse(fixtureSwf(undefined, 0)), /one CalendarManager/);
  assert.throws(() => patchActivityResponse(fixtureSwf(undefined, 1, "other/CalendarManager")), /one CalendarManager/);
  assert.throws(() => patchActivityResponse(fixtureSwf(undefined, 2)), /one CalendarManager/);
  for (const options of [{ methodIndex: 32 }, { traitKind: 66 }, { privateKind: 22 }, { methodName: "calendar:CalendarManager/private:calendarSignComplete" }])
    assert.throws(() => patchActivityResponse(fixtureSwf(options)));
  const changed = Buffer.from(originalCode); changed[124] = 0x27;
  assert.throws(() => patchActivityResponse(fixtureSwf({ code: changed })), /code digest/);
  assert.throws(() => patchActivityResponse(fixtureSwf().subarray(0, 200)));
});

test("legacy default output stays byte-identical; explicit upgrade is repeatable and keeps original backup paths", t => {
  const f = privateFixture(t), old = legacy(f), ledgerBefore = readFileSync(f.ledger);
  const saved = old.files.map(x => ({ ...x, bytes: readFileSync(x.backup) }));
  const expected = patchSwfBuffer(f.original, { "Xác nhận": "确定", Confirmar: "确定" }).out;
  const defaults = f.run(); assert.equal(defaults.unchanged, true); assert.equal(defaults.activityResponse, false);
  for (const file of defaults.files) assert.deepEqual(readFileSync(join(f.overlay, file.name)), expected);
  const preview = f.run({ activityResponse: true }); assert.equal(preview.pendingTransition, true); assert.equal(preview.activityResponseInstalled, false);
  assert.deepEqual(readFileSync(f.ledger), ledgerBefore); assert.deepEqual(readFileSync(join(f.overlay, "2.png")), expected);
  const applied = f.run({ command: "install", activityResponse: true }); assert.equal(applied.activityResponseInstalled, true); assert.equal(applied.unchanged, false);
  const upgraded = JSON.parse(readFileSync(f.ledger)); assert.equal(upgraded.activityResponse, true);
  assert.deepEqual(upgraded.files.map(x => x.backup), old.files.map(x => x.backup));
  for (const item of saved) assert.deepEqual(readFileSync(item.backup), item.bytes);
  for (const name of ["3.png", "DDT_Loading.swf"]) assert.deepEqual(readFileSync(join(f.overlay, name)), expected);
  const appliedBytes = readFileSync(f.ledger); const repeated = f.run({ command: "install" });
  assert.equal(repeated.unchanged, true); assert.equal(repeated.activityResponse, true); assert.deepEqual(readFileSync(f.ledger), appliedBytes);
  assert.equal(f.run().unchanged, true);
});

test("recorded semantic flag is recomputed and cannot conceal a mismatching old output", t => {
  const f = privateFixture(t), journal = legacy(f); journal.activityResponse = true; writeFileSync(f.ledger, JSON.stringify(journal));
  const before = readFileSync(f.ledger), bytes = readFileSync(join(f.overlay, "2.png"));
  assert.throws(() => f.run({ command: "install", activityResponse: true }), /recorded literal\/consumer output/);
  assert.deepEqual(readFileSync(f.ledger), before); assert.deepEqual(readFileSync(join(f.overlay, "2.png")), bytes);
});

test("a ledger publication failure restores current bytes and leaves the old ledger/backups intact", t => {
  const f = privateFixture(t), journal = legacy(f), before = readFileSync(f.ledger);
  const overlay = journal.files.map(x => [x.name, readFileSync(join(f.overlay, x.name))]);
  const backups = journal.files.map(x => [x.backup, readFileSync(x.backup)]);
  const rename = fs.renameSync; let injected = 0;
  const stub = mock.method(fs, "renameSync", (from, to) => {
    if (to === f.ledger) { injected++; throw new Error("synthetic ledger rename failure"); }
    return rename(from, to);
  });
  try { assert.throws(() => f.run({ command: "install", activityResponse: true }), /synthetic ledger rename failure/); }
  finally { stub.mock.restore(); }
  assert.equal(injected, 1); assert.deepEqual(readFileSync(f.ledger), before);
  for (const [name, bytes] of overlay) assert.deepEqual(readFileSync(join(f.overlay, name)), bytes);
  for (const [path, bytes] of backups) assert.deepEqual(readFileSync(path), bytes);
  assert.equal(existsSync(f.ledger + `.workshop-${process.pid}`), false);
});

test("unknown overlay changes are preserved, and complete rollback restores the existing pre-overlay file", t => {
  const f = privateFixture(t); mkdirSync(f.overlay, { recursive: true }); writeFileSync(join(f.overlay, "2.png"), f.original);
  f.run({ command: "install", activityResponse: true });
  const good = readFileSync(join(f.overlay, "2.png")), foreign = cat(good, byte(12)); writeFileSync(join(f.overlay, "2.png"), foreign);
  const ledger = readFileSync(f.ledger); assert.throws(() => f.run(), /changed deployment preserved/);
  assert.deepEqual(readFileSync(join(f.overlay, "2.png")), foreign); assert.deepEqual(readFileSync(f.ledger), ledger);
  writeFileSync(join(f.overlay, "2.png"), good); assert.equal(f.run({ command: "rollback" }).rolledBack, true);
  assert.deepEqual(readFileSync(join(f.overlay, "2.png")), f.original);
  for (const name of ["3.png", "DDT_Loading.swf"]) assert.equal(existsSync(join(f.overlay, name)), false);
  assert.equal(existsSync(f.ledger), false);
});

test("real local configuration is verified offline without installing or writing its overlay/ledger", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."), runtimeRoot = resolve(repoRoot, "../../runtime");
  const path = join(runtimeRoot, "client-overlay-literals.json");
  if (!existsSync(path)) return;
  const before = readFileSync(path), journal = JSON.parse(before), originalHashes = journal.files.map(x => [x.name, hash(readFileSync(join(runtimeRoot, "client-overlay", x.name))), hash(readFileSync(x.backup))]);
  const defaults = runLiteralOverlay({ repoRoot, runtimeRoot }), candidate = runLiteralOverlay({ repoRoot, runtimeRoot, activityResponse: true });
  assert.equal(defaults.unchanged, true); assert.equal(candidate.renderingAccepted, false);
  assert.equal(candidate.files.find(x => x.name === "2.png").activityResponse.branchesAndExceptionsPreserved, true);
  if (!journal.activityResponse) { assert.equal(candidate.activityResponseInstalled, false); assert.equal(candidate.pendingTransition, true); }
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(journal.files.map(x => [x.name, hash(readFileSync(join(runtimeRoot, "client-overlay", x.name))), hash(readFileSync(x.backup))]), originalHashes);
});
