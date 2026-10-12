// Optional post-login Calendar state consumer. Only two exact ABC owners are changed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ByteReader, buildTag, compressSwf, decompressSwf, encodeU30 } from "./lib.mjs";
import { parseTags } from "./lib.mjs";
import { parseActivityAbc } from "./activity-response.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const u = encodeU30, cat = (...parts) => Buffer.concat(parts), b = n => Buffer.from([n]);
const MANAGER = "calendar/CalendarManager", ANALYZER = "ddt/data/analyze/CalendarSignAnalyze";
const REQUEST_SHA = "4a563bd4b0f2424717352774b59fff55a6074bec41e4f55725adf880ae1ed72e";
const ANALYZE_SHA = "4c28c59793860593efd10432d6f3c6a77247adc917848df61dc3a3e47c2d2c19";
const RESPONSE_SHA = "68153276b9940b86be0b41da077eccb972f008be49fdaa069a99124033b7d8b1";
const OWNER = "calendarStateUserId";

// Deliberately limited to the opcodes in these original methods and the two additions.
export function decodeCalendarCode(code) {
  const r = new ByteReader(code), instructions = [];
  while (r.pos < code.length) {
    const start = r.pos, op = r.bytes(1)[0], operands = [];
    if (op >= 0x0c && op <= 0x1a) operands.push(r.bytes(3).readIntLE(0, 3));
    else if ([0xf1, 0xf0, 0x5d, 0x5e, 0x60, 0x61, 0x62, 0x63, 0x66, 0x68, 0x6c, 0x6d, 0x80, 0x2c, 0x58, 0x5a, 0x08, 0xc2, 0x49, 0x42].includes(op)) operands.push(r.u30());
    else if ([0x46, 0x4a, 0x4f].includes(op)) operands.push(r.u30(), r.u30());
    else if ([0x24, 0x65].includes(op)) operands.push(r.bytes(1)[0]);
    else if (op === 0xef) operands.push(r.bytes(1)[0], r.u30(), r.bytes(1)[0], r.u30());
    else assert.ok([0xd0, 0xd1, 0xd2, 0xd3, 0xd5, 0xd6, 0xd7, 0x30, 0x29, 0x26, 0x27, 0x47, 0x48, 0x57, 0x2a, 0x20, 0x82, 0x85, 0x2b, 0x1d, 0x73, 0x03, 0x09].includes(op), `unknown calendar opcode ${op.toString(16)}`);
    instructions.push({ offset: start, op, operands, end: r.pos });
  }
  const boundaries = new Set([...instructions.map(x => x.offset), code.length]);
  for (const i of instructions.filter(x => x.op >= 0x0c && x.op <= 0x1a)) {
    const target = i.end + i.operands[0];
    assert.ok(boundaries.has(target), "branch is not on an instruction boundary");
    // AVM2/Ruffle requires a Label for a backward target not already seen as a jump target.
    // Emit/require one for every loop, independent of verifier traversal order (VerifyError #1021).
    assert.ok(i.operands[0] >= 0 || code[target] === 0x09, "backward branch target must be an AVM2 Label");
  }
  return instructions;
}

function assembler() {
  const parts = [], labels = new Map(), jumps = []; let size = 0;
  const put = bytes => { parts.push(bytes); size += bytes.length; };
  return {
    op(op, ...args) { put(cat(b(op), ...args.map(u))); },
    label(name, loop = false) { assert.ok(!labels.has(name)); labels.set(name, size); if (loop) put(b(0x09)); },
    branch(op, label) { jumps.push({ offset: size, label }); put(cat(b(op), Buffer.alloc(3))); },
    finish() {
      const code = cat(...parts);
      for (const jump of jumps) { assert.ok(labels.has(jump.label)); code.writeIntLE(labels.get(jump.label) - jump.offset - 4, jump.offset + 1, 3); }
      decodeCalendarCode(code); return code;
    },
  };
}

// Match UserCalendar's explicit state owners. Type is a different legacy field;
// ActiveType distinguishes ordinary claims from one-time material exchanges.
function eligibleState(a, local, names, skip, label, xml = false) {
  const field = id => { a.op(0x62, local); a.op(0x66, id); if (xml) a.op(0x73); };
  field(names.type); a.op(0x24, 0); a.branch(0x14, `${label}Exchange`);
  field(names.key); a.op(0x24, 3); a.branch(0x14, skip); a.branch(0x10, `${label}Accepted`);
  a.label(`${label}Exchange`);
  field(names.type); a.op(0x24, 1); a.branch(0x14, skip);
  field(names.key); a.op(0x24, 6); a.branch(0x14, skip);
  field(names.only); a.op(0x24, 1); a.branch(0x14, skip);
  a.label(`${label}Accepted`);
}

// request(): clear only this feature's previous account state BEFORE launching the personal request.
// The original URLVariables already contain Self.ID, MD5(Account.Password), and rnd.
export function calendarOwnerPrefix() {
  const a = assembler(), o = (...x) => a.op(...x), j = (...x) => a.branch(...x);
  o(0x60, 36); o(0x66, 8); o(0x66, 37); o(0x66, 228); o(0x63, 3);
  o(0xd0); o(0x66, 226); o(0x62, 3); j(0x13, "done");
  o(0xd0); o(0x66, 33); o(0x63, 4); o(0x62, 4); j(0x12, "owner"); o(0x24, 0); o(0x63, 5);
  a.label("loop", true); o(0x62, 5); o(0x62, 4); o(0x66, 140); j(0x18, "owner");
  o(0x62, 4); o(0x62, 5); o(0x66, 116); o(0x63, 6);
  eligibleState(a, 6, { type: 229, key: 227, only: 230 }, "next", "ownerState");
  o(0x62, 6); o(0x27); o(0x61, 178);
  a.label("next"); o(0xc2, 5); j(0x10, "loop");
  a.label("owner"); o(0xd0); o(0x62, 3); o(0x61, 226); a.label("done");
  return a.finish();
}

// analyze(): reject another account's response, then merge only supported claims' true values into original objects.
// No replacement arrays, forced button state, claim requests, or downgrade of a successful same-session callback.
export function calendarStatePrefix() {
  const a = assembler(), o = (...x) => a.op(...x), j = (...x) => a.branch(...x);
  o(0x65, 1); o(0x6c, 2); o(0x66, 57); o(0x73); o(0x63, 11);
  o(0x60, 53); o(0x66, 54); o(0x66, 55); o(0x66, 56); o(0x62, 11); j(0x14, "reject");
  o(0x60, 40); o(0x46, 41, 0); o(0x63, 4);
  o(0x62, 4); o(0x66, 52); o(0x62, 11); j(0x14, "reject");
  o(0x62, 4); o(0x66, 42); o(0x63, 5); o(0x62, 5); j(0x12, "done");
  o(0x65, 1); o(0x6c, 2); o(0x66, 50); o(0x63, 8); o(0x24, 0); o(0x63, 6);
  a.label("outer", true); o(0x62, 6); o(0x62, 5); o(0x66, 43); j(0x18, "done");
  o(0x62, 5); o(0x62, 6); o(0x66, 51); o(0x63, 7);
  eligibleState(a, 7, { type: 59, key: 44, only: 60 }, "nextOuter", "objectState");
  o(0x24, 0); o(0x63, 9);
  a.label("inner", true); o(0x62, 9); o(0x62, 8); o(0x46, 43, 0); j(0x18, "nextOuter");
  o(0x62, 8); o(0x62, 9); o(0x66, 51); o(0x63, 10);
  eligibleState(a, 10, { type: 61, key: 47, only: 62 }, "nextInner", "xmlState", true);
  o(0x62, 7); o(0x66, 59); o(0x62, 10); o(0x66, 61); o(0x73); j(0x14, "nextInner");
  o(0x62, 7); o(0x66, 45); o(0x62, 10); o(0x66, 48); o(0x73); j(0x14, "nextInner");
  o(0x62, 10); o(0x66, 49); o(0x85); o(0x2c, 27); j(0x14, "nextInner");
  o(0x62, 7); o(0x26); o(0x61, 46);
  a.label("nextInner"); o(0xc2, 9); j(0x10, "inner");
  a.label("nextOuter"); o(0xc2, 6); j(0x10, "outer");
  // Complete the loader without calling calendarSignComplete with unset fields.
  a.label("reject"); o(0xd0); o(0x20); o(0x61, 58); o(0xd0); o(0x4f, 20, 0); o(0x47);
  a.label("done"); return a.finish();
}

function insertCode(code, at, addition) {
  const instructions = decodeCalendarCode(code), result = cat(code.subarray(0, at), addition, code.subarray(at));
  assert.ok(instructions.some(x => x.offset === at));
  const shift = n => n >= at ? n + addition.length : n;
  for (const i of instructions.filter(x => x.op >= 0x0c && x.op <= 0x1a))
    result.writeIntLE(shift(i.end + i.operands[0]) - (shift(i.offset) + 4), shift(i.offset) + 1, 3);
  decodeCalendarCode(result); return result;
}
function edits(bytes, replacements) {
  let out = bytes, previous = bytes.length;
  for (const edit of replacements.sort((a, b) => b.start - a.start)) {
    assert.ok(edit.end <= previous && edit.start <= edit.end); previous = edit.start;
    out = cat(out.subarray(0, edit.start), edit.bytes, out.subarray(edit.end));
  }
  return out;
}
const stringPool = strings => cat(u(strings.length), ...strings.slice(1).map(s => { const bytes = Buffer.from(s); return cat(u(bytes.length), bytes); }));
const qname = (namespace, name, attribute = false) => cat(b(attribute ? 13 : 7), u(namespace), u(name));
function modifiedBody(bytes, target, code, locals, at, added) {
  const shift = n => n >= at ? n + added : n;
  return cat(u(target.method), u(target.maxStack), u(locals), u(target.initialScope), u(target.maxScope), u(code.length), code,
    u(target.exceptions), ...target.exceptionTable.map(e => cat(u(shift(e.from)), u(shift(e.to)), u(shift(e.target)), u(e.type), u(e.name))),
    bytes.subarray(target.traitsOffset, target.end));
}
function checkBody(p, index, expectedName, expectedHash) {
  const target = p.bodies.find(x => x.method === index);
  assert.equal(p.strings[p.methods[index]?.name], expectedName); assert.ok(target);
  assert.equal(hash(target.code), expectedHash, "unknown calendar method body; preserve existing bytes");
  return target;
}

function managerPatch(bytes) {
  const p = parseActivityAbc(bytes), state = p.strings.includes(OWNER), original = !state;
  assert.equal(p.strings[167], original ? "DailyLogList.ashx" : "UserCalendar.ashx");
  assert.equal(p.strings[394], "true", "activity-state requires the existing lowercase response fix first");
  assert.equal(p.strings.length, original ? 395 : 400); assert.equal(p.names.length, original ? 226 : 231);
  assert.equal(hash(p.bodies.find(x => x.method === 33).code), RESPONSE_SHA, "activity response callback must stay unchanged");
  const name = "calendar:CalendarManager/request", target = p.bodies.find(x => x.method === 21);
  assert.equal(p.strings[p.methods[21]?.name], name);
  const trait = p.methodTraits.find(x => x.method === 21), block = p.traitBlocks.find(x => x.owner === trait.owner);
  assert.deepEqual(trait, { owner: 2, name: 208, method: 21, kind: 65 });
  assert.deepEqual(p.names[2], { kind: 7, name: 7, ns: 2 }); assert.equal(p.strings[7], "CalendarManager");
  assert.equal(p.strings[p.namespaces[2].name], "calendar"); assert.equal(block.count, state ? 68 : 67);
  assert.equal(p.namespaces[4].kind, 22); assert.equal(p.strings[p.namespaces[4].name], "");
  for (const [id, text] of [[36, "PlayerManager"], [8, "Instance"], [37, "Self"], [33, "_eventActives"], [71, "int"], [140, "length"], [178, "isAttend"]]) assert.equal(p.strings[p.names[id].name], text);
  const prefix = calendarOwnerPrefix();
  if (state) {
    assert.deepEqual(p.strings.slice(395), [OWNER, "HasKey", "ID", "ActiveType", "IsOnly"]);
    assert.deepEqual(p.names.slice(226), [395, 396, 397, 398, 399].map(name => ({ kind: 7, name, ns: 4 })));
    const ownerSlot = cat(u(226), b(0), u(0), u(71), u(0));
    assert.deepEqual(bytes.subarray(block.end - ownerSlot.length, block.end), ownerSlot, "unknown calendar owner slot");
    assert.deepEqual(target.code.subarray(7, 7 + prefix.length), prefix);
    const restored = cat(target.code.subarray(0, 7), target.code.subarray(7 + prefix.length)); assert.equal(hash(restored), REQUEST_SHA);
    assert.deepEqual([target.maxStack, target.localCount, target.initialScope, target.maxScope, target.exceptions], [4, 7, 4, 5, 0]);
    return { out: bytes, changed: false };
  }
  checkBody(p, 21, name, REQUEST_SHA);
  assert.deepEqual([target.maxStack, target.localCount, target.initialScope, target.maxScope, target.exceptions], [4, 3, 4, 5, 0]);
  const strings = [...p.strings, OWNER, "HasKey", "ID", "ActiveType", "IsOnly"]; strings[167] = "UserCalendar.ashx";
  const code = insertCode(target.code, 7, prefix);
  const out = edits(bytes, [
    { start: p.stringCountOffset, end: p.stringPoolEnd, bytes: stringPool(strings) },
    { start: p.nameCountOffset, end: p.namePoolEnd, bytes: cat(u(231), bytes.subarray(p.nameDataOffset, p.namePoolEnd), ...[395, 396, 397, 398, 399].map(name => qname(4, name))) },
    { start: block.countOffset, end: block.end, bytes: cat(u(block.count + 1), bytes.subarray(block.dataOffset, block.end), u(226), b(0), u(0), u(71), u(0)) },
    { start: target.start, end: target.end, bytes: modifiedBody(bytes, target, code, 7, 7, prefix.length) },
  ]);
  managerPatch(out); return { out, changed: true };
}

function analyzerPatch(bytes) {
  const p = parseActivityAbc(bytes), state = p.strings.includes(OWNER);
  assert.equal(p.strings.length, state ? 89 : 70); assert.equal(p.names.length, state ? 63 : 40);
  assert.equal(p.namespaces.length, state ? 15 : 13); assert.ok(p.namespaceSets[1].includes(2));
  assert.deepEqual(p.namespaces[11], { kind: 24, name: 26 }); assert.equal(p.strings[26], "com.pickgliss.loader:DataAnalyzer");
  assert.deepEqual(p.names[20], { kind: 7, name: 37, ns: 11 }); assert.equal(p.strings[37], "onAnalyzeComplete");
  const addedStrings = ["calendar", "CalendarManager", "getInstance", "eventActives", "length", "HasKey", "ActiveID", "isAttend", "Item", OWNER,
    "ddt.manager", "PlayerManager", "Instance", "Self", "ID", "UserID", "_onCompleteCall", "ActiveType", "IsOnly"];
  const addedNames = [qname(13, 71), qname(2, 72), qname(2, 73), qname(2, 74), qname(2, 75), qname(2, 76), qname(2, 77),
    qname(2, 75, true), qname(2, 76, true), qname(2, 77, true), qname(2, 78), cat(b(27), u(1)), qname(2, 79),
    qname(14, 81), qname(2, 82), qname(2, 83), qname(2, 84), qname(2, 85, true), qname(11, 86),
    qname(2, 87), qname(2, 88), qname(2, 87, true), qname(2, 88, true)];
  const target = p.bodies.find(x => x.method === 7), prefix = calendarStatePrefix();
  assert.equal(p.strings[p.methods[7]?.name], "ddt.data.analyze:CalendarSignAnalyze/analyze");
  // Insert just after the success branch test, before date/sign data or callbacks become visible.
  const at = 85;
  if (state) {
    assert.deepEqual(p.strings.slice(70), addedStrings);
    assert.deepEqual(p.namespaces.slice(13), [{ kind: 22, name: 70 }, { kind: 22, name: 80 }]);
    const suffix = cat(...addedNames); assert.deepEqual(bytes.subarray(p.namePoolEnd - suffix.length, p.namePoolEnd), suffix, "unknown calendar state names");
    assert.deepEqual(target.code.subarray(at, at + prefix.length), prefix);
    const restored = cat(target.code.subarray(0, at), target.code.subarray(at + prefix.length));
    // The original one conditional jump crossing the insertion is restored for the digest check.
    restored.writeIntLE(78, 82, 3);
    assert.equal(hash(restored), ANALYZE_SHA);
    assert.deepEqual([target.maxStack, target.localCount, target.initialScope, target.maxScope, target.exceptions], [3, 12, 6, 11, 1]);
    assert.deepEqual(target.exceptionTable, [{ from: 54, to: 194 + prefix.length, target: 200 + prefix.length, type: 24, name: 25 }]);
    return { out: bytes, changed: false };
  }
  checkBody(p, 7, "ddt.data.analyze:CalendarSignAnalyze/analyze", ANALYZE_SHA);
  assert.deepEqual([target.maxStack, target.localCount, target.initialScope, target.maxScope], [3, 4, 6, 11]);
  assert.deepEqual(target.exceptionTable, [{ from: 54, to: 194, target: 200, type: 24, name: 25 }]);
  assert.equal(target.code.subarray(at, at + 2).toString("hex"), "f03c");
  const code = insertCode(target.code, at, prefix);
  const out = edits(bytes, [
    { start: p.stringCountOffset, end: p.stringPoolEnd, bytes: stringPool([...p.strings, ...addedStrings]) },
    { start: p.namespaceCountOffset, end: p.namespacePoolEnd, bytes: cat(u(15), bytes.subarray(p.namespaceDataOffset, p.namespacePoolEnd), b(22), u(70), b(22), u(80)) },
    { start: p.nameCountOffset, end: p.namePoolEnd, bytes: cat(u(63), bytes.subarray(p.nameDataOffset, p.namePoolEnd), ...addedNames) },
    { start: target.start, end: target.end, bytes: modifiedBody(bytes, target, code, 12, at, prefix.length) },
  ]);
  analyzerPatch(out); return { out, changed: true };
}

export function patchActivityState(buf) {
  const { error, body, sig, version } = decompressSwf(buf); assert.equal(error, null);
  assert.equal(buf.readUInt32LE(4), body.length + 8);
  const parsed = parseTags(body), counts = new Map(), proof = []; let changed = false;
  const tags = parsed.tags.map(tag => {
    assert.ok(tag.bodyEnd <= body.length);
    if (tag.code !== 82) return tag.raw;
    const payload = body.subarray(tag.bodyStart, tag.bodyEnd), r = new ByteReader(payload); r.u32(); const name = r.cstring();
    if (![MANAGER, ANALYZER].includes(name)) return tag.raw;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const original = payload.subarray(r.pos), p = parseActivityAbc(original);
    const result = name === MANAGER ? managerPatch(original) : analyzerPatch(original); changed ||= result.changed;
    const after = parseActivityAbc(result.out), method = name === MANAGER ? 21 : 7;
    for (const old of p.bodies.filter(x => x.method !== method)) assert.deepEqual(after.bodies.find(x => x.method === old.method).code, old.code, "unrelated method changed");
    const target = after.bodies.find(x => x.method === method); decodeCalendarCode(target.code);
    proof.push({ name, methodIndex: method, originalMethodSha256: name === MANAGER ? REQUEST_SHA : ANALYZE_SHA,
      patchedMethodSha256: hash(target.code), methodLength: target.length, maxStack: target.maxStack, localCount: target.localCount,
      exceptionTable: target.exceptionTable, unchangedMethods: p.methods.length - 1 });
    return result.changed ? buildTag(82, cat(payload.subarray(0, r.pos), result.out)) : tag.raw;
  });
  for (const name of [MANAGER, ANALYZER]) assert.equal(counts.get(name), 1, `expected exactly one ${name} ABC`);
  return { out: changed ? compressSwf(sig, version, cat(parsed.headerPrefix, ...tags, parsed.trailing)) : buf, changed,
    responseCallbackPreserved: true, publicActiveListPreserved: true, ownerBound: true, methods: proof };
}
