import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import { ByteReader, buildTag, compressSwf, decompressSwf, parseTags } from "../tools/i18n/abc-strings/lib.mjs";
import { parseActivityAbc, patchActivityResponse } from "../tools/i18n/abc-strings/activity-response.mjs";
import { calendarOwnerPrefix, calendarStatePrefix, decodeCalendarCode, patchActivityState } from "../tools/i18n/abc-strings/activity-state.mjs";
import { literalOptions, runLiteralOverlay } from "./workshop-literals.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."), sha = x => createHash("sha256").update(x).digest("hex");
const original = readFileSync(join(repo, "apps/api/assets/flash/2.png"));
const response = patchActivityResponse(original).out;
const state = patchActivityState(response).out;
function abc(swf, target) {
  const { body } = decompressSwf(swf);
  for (const tag of parseTags(body).tags) if (tag.code === 82) {
    const r = new ByteReader(body.subarray(tag.bodyStart, tag.bodyEnd)); r.u32();
    if (r.cstring() === target) return parseActivityAbc(r.bytes(r.buf.length - r.pos));
  }
  assert.fail(target);
}

// Execute the injected AVM2 instruction stream against isolated plain fixtures, never a game/Flash runtime.
// This checks branch paths and actual stack/register bounds instead of testing a duplicate JS merge function.
function execute(code, p, { selfId, manager, xml, thisObject, complete = () => {}, full = false }) {
  const instructions = new Map(decodeCalendarCode(code).map(x => [x.offset, x]));
  const stack = [], locals = [thisObject ?? { _onCompleteCall: () => {}, onAnalyzeComplete: complete }, xml];
  if (!full && p === managerAbc) locals[0] = manager;
  const scopes = full ? [] : [{}, { 2: xml }];
  const classes = { PlayerManager: { Instance: { Self: { ID: selfId } } }, CalendarManager: { getInstance: () => manager }, Error,
    XML: function(value) { return value; }, DateUtils: { dealWithStringDate: value => value } };
  const property = id => p.strings[p.names[id].name]; let pc = 0, steps = 0, peak = 0;
  const pop = () => { assert.ok(stack.length, "stack underflow"); return stack.pop(); };
  while (pc < code.length) {
    assert.ok(++steps < 10000, "finite fixture did not terminate"); const i = instructions.get(pc); assert.ok(i); pc = i.end;
    const n = i.operands[0]; let object, value, args;
    switch (i.op) {
      case 0xd0: stack.push(locals[0]); break;
      case 0xd1: stack.push(locals[1]); break;
      case 0xd2: stack.push(locals[2]); break;
      case 0xd6: locals[2] = pop(); break;
      case 0x60: stack.push(classes[property(n)]); break;
      case 0x62: stack.push(locals[n]); break;
      case 0x63: locals[n] = pop(); break;
      case 0x65: stack.push(scopes[n]); break;
      case 0x6c: object = pop(); stack.push(object[n]); break;
      case 0x6d: value = pop(); object = pop(); object[n] = value; break;
      case 0x57: stack.push({}); break;
      case 0x2a: value = pop(); stack.push(value, value); break;
      case 0x30: scopes.push(pop()); break;
      case 0x5d: case 0x5e: stack.push(property(n) in classes ? classes : locals[0]); break;
      case 0x4a: args = stack.splice(stack.length - i.operands[1], i.operands[1]); object = pop(); stack.push(new object[property(n)](...args)); break;
      case 0x66:
        if (p.names[n].kind === 27) { value = pop(); object = pop(); stack.push(object[value]); }
        else { object = pop(); stack.push(object[property(n)]); } break;
      case 0x61: case 0x68: value = pop(); object = pop(); object[property(n)] = value; break;
      case 0x46: case 0x4f:
        args = stack.splice(stack.length - i.operands[1], i.operands[1]); object = pop();
        value = object[property(n)](...args); if (i.op === 0x46) stack.push(value); break;
      case 0x42: args = stack.splice(stack.length - n, n); object = pop(); stack.push(new object(...args)); break;
      case 0x03: throw pop();
      case 0x24: stack.push(n); break;
      case 0x26: stack.push(true); break;
      case 0x27: stack.push(false); break;
      case 0x20: stack.push(null); break;
      case 0x29: pop(); break;
      case 0x47: pc = code.length; break;
      case 0xf0: case 0xf1: case 0xef: case 0x80: case 0x82: case 0x09: break;
      case 0x2c: stack.push(p.strings[n]); break;
      case 0x73: stack.push(Number(pop()) | 0); break;
      case 0x85: stack.push(String(pop())); break;
      case 0xc2: locals[n]++; break;
      case 0x10: pc += n; break;
      case 0x12: if (!pop()) pc += n; break;
      case 0x13: value = pop(); if (pop() === value) pc += n; break;
      case 0x14: value = pop(); if (pop() !== value) pc += n; break;
      case 0x18: value = pop(); if (pop() >= value) pc += n; break;
      default: assert.fail(`unexecuted opcode ${i.op}`);
    }
    peak = Math.max(peak, stack.length); assert.ok(peak <= 3); assert.ok(locals.length <= 12);
  }
  assert.equal(stack.length, 0); return { peak, registers: locals.length };
}
const managerAbc = abc(state, "calendar/CalendarManager"), analyzerAbc = abc(state, "ddt/data/analyze/CalendarSignAnalyze");
function model(owner = 111) {
  const list = [1, 2, 3, 4].map(HasKey => ({ ActiveID: HasKey + 100, HasKey, isAttend: false }));
  return { calendarStateUserId: owner, _eventActives: list, get eventActives() { return this._eventActives; } };
}
function snapshot(owner, values) { return { UserID: String(owner), Item: Object.assign({ length: () => values.length }, values) }; }
function merge(manager, selfId, owner, rows) { return execute(calendarStatePrefix(), analyzerAbc, { manager, selfId, xml: snapshot(owner, rows) }); }
const claim = (id = 103, HasKey = 3, isAttend = "true") => ({ ActiveID: String(id), HasKey: String(HasKey), isAttend });

test("AVM2 backward jumps require Label even when a non-label target is a valid instruction boundary", () => {
  // This passed the previous instruction-boundary-only check, but Ruffle rejects it with VerifyError #1021.
  const missingLabel = Buffer.from([0x24, 0, 0x63, 5, 0xc2, 5, 0x10, 0xf6, 0xff, 0xff]);
  assert.throws(() => decodeCalendarCode(missingLabel), /backward branch target must be an AVM2 Label/);
  for (const [p, method, count] of [[managerAbc, 21, 1], [analyzerAbc, 7, 2]]) {
    const body = p.bodies.find(x => x.method === method), instructions = decodeCalendarCode(body.code);
    const back = instructions.filter(x => x.op >= 0x0c && x.op <= 0x1a && x.operands[0] < 0);
    assert.equal(back.length, count);
    for (const jump of back) assert.equal(body.code[jump.end + jump.operands[0]], 0x09);
  }
});

test("private state applies only to matching HasKey3 original objects and preserves same-session success", () => {
  const m = model(), originalList = m.eventActives, info = m.eventActives[2];
  merge(m, 111, 111, [claim(101, 1), claim(102, 2), claim(), claim(104, 4), claim(999)]);
  assert.equal(m.eventActives, originalList); assert.equal(m.eventActives[2], info);
  assert.deepEqual(m.eventActives.map(x => x.isAttend), [false, false, true, false]);
  merge(m, 111, 111, [claim(103, 3, "false")]); assert.equal(info.isAttend, true);
  const empty = model(); merge(empty, 111, 111, [claim(103, 3, "True"), claim(103, 4)]); assert.equal(empty.eventActives[2].isAttend, false);
  merge(empty, 111, 111, []); assert.equal(empty.eventActives[2].isAttend, false);
});

test("account switch clears only HasKey3 before request and rejects previous account's late response", () => {
  const m = model(); m.eventActives.forEach(x => x.isAttend = true);
  execute(calendarOwnerPrefix(), managerAbc, { manager: m, selfId: 112 });
  assert.equal(m.calendarStateUserId, 112); assert.deepEqual(m.eventActives.map(x => x.isAttend), [true, true, false, true]);
  merge(m, 112, 111, [claim()]); assert.equal(m.eventActives[2].isAttend, false);
  merge(m, 112, 112, [claim()]); assert.equal(m.eventActives[2].isAttend, true);
  execute(calendarOwnerPrefix(), managerAbc, { manager: m, selfId: 112 });
  merge(m, 112, 112, [claim(103, 3, "false")]); assert.equal(m.eventActives[2].isAttend, true);
  const wrongOwner = model(111); merge(wrongOwner, 112, 112, [claim()]); assert.equal(wrongOwner.eventActives[2].isAttend, false);
});

test("full patched analyze and original parent completion discard late response without altering current calendar or blocking loader", () => {
  const parent = abc(original, "com/pickgliss/loader/DataAnalyzer"), complete = parent.bodies.find(x => x.method === 3);
  const body = analyzerAbc.bodies.find(x => x.method === 7);
  for (const [selfId, owner, responseOwner, accepted] of [[112, 112, 111, false], [112, 111, 112, false], [112, 112, 112, true]]) {
    const m = model(owner), oldDay = { now: "current date", count: 9, dayLog: "current calendar" }, calendar = { ...oldDay };
    let loaderComplete = 0, businessComplete = 0, errors = 0;
    const analyzer = { _date: null, _signCount: 0, _dayLog: null,
      _onCompleteCall: a => { businessComplete++; calendar.now = a._date; calendar.count = a._signCount; calendar.dayLog = a._dayLog.split(","); },
      analyzeCompleteCall: () => { loaderComplete++; }, analyzeErrorCall: () => { errors++; },
      onAnalyzeComplete: () => execute(complete.code, parent, { thisObject: analyzer, full: true }),
      onAnalyzeError: () => { errors++; } };
    const xml = { ...snapshot(responseOwner, [claim()]), value: "true", nowDate: "new date",
      DailyLogList: { UserAwardLog: 2, DayLog: "True,False" }, luckyNum: -1, myLuckyNum: -1 };
    execute(body.code, analyzerAbc, { manager: m, selfId, xml, thisObject: analyzer, full: true });
    assert.equal(loaderComplete, 1); assert.equal(businessComplete, accepted ? 1 : 0); assert.equal(errors, 0);
    assert.equal(analyzer._onCompleteCall, null); assert.equal(analyzer.analyzeCompleteCall, null);
    assert.equal(m.eventActives[2].isAttend, accepted);
    assert.deepEqual(calendar, accepted ? { now: "new date", count: 2, dayLog: ["True", "False"] } : oldDay);
  }
});

test("two exact methods change; lowercase response, public startup list and every other tag/method survive", () => {
  const before = parseTags(decompressSwf(response).body), after = parseTags(decompressSwf(state).body);
  assert.deepEqual(before.headerPrefix, after.headerPrefix); assert.equal(before.tags.length, after.tags.length);
  let count = 0;
  for (let i = 0; i < before.tags.length; i++) if (!before.tags[i].raw.equals(after.tags[i].raw)) count++;
  assert.equal(count, 2);
  for (const [name, method] of [["calendar/CalendarManager", 21], ["ddt/data/analyze/CalendarSignAnalyze", 7]]) {
    const old = abc(response, name), next = abc(state, name);
    for (const body of old.bodies.filter(x => x.method !== method)) assert.deepEqual(next.bodies.find(x => x.method === body.method).code, body.code);
    const code = next.bodies.find(x => x.method === method); const instructions = decodeCalendarCode(code.code);
    const offsets = new Set([...instructions.map(x => x.offset), code.length]);
    for (const e of code.exceptionTable) { assert.ok(e.from < e.to); for (const pos of [e.from, e.to, e.target]) assert.ok(offsets.has(pos)); }
    for (const i of instructions.filter(x => [0x62, 0x63, 0xc2].includes(x.op))) assert.ok(i.operands[0] < code.localCount);
  }
  const p = abc(state, "calendar/CalendarManager"); assert.equal(p.strings[199], "True"); assert.equal(p.strings[394], "true");
  assert.equal(p.strings[167], "UserCalendar.ashx"); assert.ok(p.strings.includes("ActiveList.xml"));
  assert.deepEqual(patchActivityState(state).out, state);
  assert.throws(() => patchActivityState(original), /response fix/);
  const { body, sig, version } = decompressSwf(response), parsed = parseTags(body);
  const corrupt = parsed.tags.map(t => {
    if (t.code !== 82) return t.raw; const r = new ByteReader(body.subarray(t.bodyStart, t.bodyEnd)); r.u32();
    if (r.cstring() !== "ddt/data/analyze/CalendarSignAnalyze") return t.raw;
    const payload = Buffer.from(body.subarray(t.bodyStart, t.bodyEnd)), p = parseActivityAbc(payload.subarray(r.pos)); payload[r.pos + p.bodies[7].offset + 10] ^= 1;
    return buildTag(82, payload);
  });
  assert.throws(() => patchActivityState(compressSwf(sig, version, Buffer.concat([parsed.headerPrefix, ...corrupt, parsed.trailing]))), /unknown calendar method/);
  for (const target of ["calendar/CalendarManager", "ddt/data/analyze/CalendarSignAnalyze"]) {
    const { body, sig, version } = decompressSwf(state), parsed = parseTags(body);
    const corrupt = parsed.tags.map(t => {
      if (t.code !== 82) return t.raw; const r = new ByteReader(body.subarray(t.bodyStart, t.bodyEnd)); r.u32();
      if (r.cstring() !== target) return t.raw;
      const payload = Buffer.from(body.subarray(t.bodyStart, t.bodyEnd)), p = parseActivityAbc(payload.subarray(r.pos));
      if (target === "calendar/CalendarManager") {
        const block = p.traitBlocks.find(x => x.owner === 2); payload[r.pos + block.end - 2] = 0; // remove the int slot's type
      } else payload[r.pos + p.namePoolEnd - 2] = 2; // replace inherited protected callback namespace with public
      return buildTag(82, payload);
    });
    assert.throws(() => patchActivityState(compressSwf(sig, version, Buffer.concat([parsed.headerPrefix, ...corrupt, parsed.trailing]))), /unknown calendar (?:owner slot|state names)/);
  }
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ddt-calendar-overlay-"));
  assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(dir.startsWith(join(tmpdir(), "ddt-calendar-overlay-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repoRoot = join(dir, "source"), runtimeRoot = join(dir, "runtime");
  for (const name of ["research/i18n/zh-CN-literals.json", "tools/i18n/abc-strings/translations.json", ...["2.png", "3.png", "DDT_Loading.swf"].map(x => "apps/api/assets/flash/" + x)]) {
    const path = join(repoRoot, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, readFileSync(join(repo, name)));
  }
  const run = opts => runLiteralOverlay({ repoRoot, runtimeRoot, ...opts });
  run({ command: "install", activityResponse: true });
  return { run, runtimeRoot, ledger: join(runtimeRoot, "client-overlay-literals.json"), file: join(runtimeRoot, "client-overlay/2.png") };
}

test("optional install upgrades existing Chinese/response overlay, preserves backups and is repeatable", t => {
  assert.deepEqual(literalOptions(["verify", "--activity-state"]), { command: "verify", activityResponse: false, activityState: true });
  assert.throws(() => literalOptions(["rollback", "--activity-state"])); assert.throws(() => literalOptions(["--activity-state", "--activity-state"]));
  const f = fixture(t), old = readFileSync(f.ledger), journal = JSON.parse(old), bytes = readFileSync(f.file);
  const backups = journal.files.map(x => [x.backup, sha(readFileSync(x.backup))]);
  assert.equal(f.run().unchanged, true); assert.equal(f.run({ activityState: true }).pendingTransition, true);
  assert.deepEqual(readFileSync(f.ledger), old); assert.deepEqual(readFileSync(f.file), bytes);
  const installed = f.run({ command: "install", activityState: true }); assert.equal(installed.activityStateInstalled, true);
  const updated = readFileSync(f.ledger); assert.equal(f.run({ command: "install" }).unchanged, true); assert.equal(f.run().unchanged, true);
  assert.deepEqual(readFileSync(f.ledger), updated);
  assert.deepEqual(JSON.parse(updated).files.map(x => [x.backup, sha(readFileSync(x.backup))]), backups);
  for (const name of ["3.png", "DDT_Loading.swf"]) assert.equal(JSON.parse(updated).files.find(x => x.name === name).sha256, journal.files.find(x => x.name === name).sha256);
});

test("publication failure restores old overlay/journal and foreign installed changes are preserved", t => {
  const f = fixture(t), ledger = readFileSync(f.ledger), bytes = readFileSync(f.file), rename = fs.renameSync;
  const stub = mock.method(fs, "renameSync", (from, to) => { if (to === f.ledger) throw new Error("calendar publication failure"); return rename(from, to); });
  try { assert.throws(() => f.run({ command: "install", activityState: true }), /calendar publication failure/); } finally { stub.mock.restore(); }
  assert.deepEqual(readFileSync(f.ledger), ledger); assert.deepEqual(readFileSync(f.file), bytes);
  const foreign = Buffer.concat([bytes, Buffer.from([1])]); writeFileSync(f.file, foreign);
  assert.throws(() => f.run({ command: "install", activityState: true }), /changed deployment preserved/);
  assert.deepEqual(readFileSync(f.file), foreign); assert.deepEqual(readFileSync(f.ledger), ledger);
});
