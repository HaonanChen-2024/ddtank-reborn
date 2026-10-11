// One consumer fix: CalendarManager's activity callback must accept the API's lowercase true.
// Sign-in still uses the original shared "True" constant. Never replace that constant globally.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ByteReader, buildTag, compressSwf, decompressSwf, encodeU30, parseTags } from "./lib.mjs";

const TAG = "calendar/CalendarManager";
const METHOD = "calendar:CalendarManager/private:__activityLoadComplete";
const ORIGINAL_CODE = "e7d63c1f5ff472e8a9d447cce96aa7ce35e7c8ddcbdd116434d2ce44f5512e6e";
const PATCHED_CODE = "68153276b9940b86be0b41da077eccb972f008be49fdaa069a99124033b7d8b1";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

class Reader extends ByteReader {
  bytes(n) {
    assert.ok(Number.isInteger(n) && n >= 0 && this.pos + n <= this.buf.length, "truncated activity ABC");
    return super.bytes(n);
  }
  byte() { return this.bytes(1)[0]; }
  varInt(lastByteMax) {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = this.byte();
      if (shift === 28) assert.ok(byte <= lastByteMax, "invalid activity ABC varint");
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    assert.fail("unterminated activity ABC varint");
  }
  u30() { return this.varInt(3); }
}

// Read the complete ABC so the target is identified by its class, private trait and method,
// rather than a caller-supplied offset or a byte search that could match another method.
function parseAbc(bytes) {
  const r = new Reader(bytes), u = () => r.u30(), b = () => r.byte();
  r.bytes(4);
  for (let pool = 0; pool < 2; pool++) { const count = u(); for (let i = 1; i < count; i++) r.varInt(15); }
  let count = u(); for (let i = 1; i < count; i++) r.bytes(8);
  const stringCountOffset = r.pos; count = u(); const stringDataOffset = r.pos;
  const strings = [""]; for (let i = 1; i < count; i++) strings.push(r.bytes(u()).toString("utf8"));
  const stringPoolEnd = r.pos;
  count = u(); const namespaces = [null];
  for (let i = 1; i < count; i++) namespaces.push({ kind: b(), name: u() });
  count = u(); for (let i = 1; i < count; i++) { const n = u(); for (let j = 0; j < n; j++) u(); }
  count = u(); const names = [null];
  for (let i = 1; i < count; i++) {
    const kind = b(); let name = 0, ns = 0;
    switch (kind) {
      case 7: case 13: ns = u(); name = u(); break;
      case 15: case 16: name = u(); break;
      case 17: case 18: break;
      case 9: case 14: name = u(); u(); break;
      case 27: case 28: u(); break;
      case 29: { u(); const n = u(); for (let j = 0; j < n; j++) u(); break; }
      default: assert.fail("unknown activity ABC multiname");
    }
    names.push({ kind, name, ns });
  }
  const methods = []; count = u();
  for (let i = 0; i < count; i++) {
    const n = u(), returnType = u(), params = []; for (let j = 0; j < n; j++) params.push(u());
    const name = u(), flags = b();
    if (flags & 8) { const optional = u(); for (let j = 0; j < optional; j++) { u(); b(); } }
    if (flags & 128) for (let j = 0; j < n; j++) u();
    methods.push({ name, flags, returnType, params });
  }
  count = u(); for (let i = 0; i < count; i++) { u(); const n = u(); for (let j = 0; j < n * 2; j++) u(); }
  const methodTraits = [];
  function traits(owner) {
    const n = u();
    for (let i = 0; i < n; i++) {
      const name = u(), kind = b(); let method;
      switch (kind & 15) {
        case 0: case 6: u(); u(); if (u()) b(); break;
        case 1: case 2: case 3: u(); method = u(); break;
        case 4: u(); u(); break;
        case 5: u(); method = u(); break;
        default: assert.fail("unknown activity ABC trait");
      }
      if (method !== undefined) methodTraits.push({ owner, name, method, kind });
      if (kind & 64) { const metadata = u(); for (let j = 0; j < metadata; j++) u(); }
    }
  }
  const classes = u();
  for (let i = 0; i < classes; i++) {
    const name = u(); u(); const flags = b(); if (flags & 8) u();
    const n = u(); for (let j = 0; j < n; j++) u(); u(); traits(name);
  }
  for (let i = 0; i < classes; i++) { u(); traits(null); }
  count = u(); for (let i = 0; i < count; i++) { u(); traits(null); }
  count = u(); const bodies = [];
  for (let i = 0; i < count; i++) {
    const method = u(), maxStack = u(), localCount = u(), initialScope = u(), maxScope = u(), length = u();
    const offset = r.pos, code = r.bytes(length), exceptions = u();
    for (let j = 0; j < exceptions * 5; j++) u(); traits(null);
    bodies.push({ method, maxStack, localCount, initialScope, maxScope, length, offset, code, exceptions });
  }
  assert.equal(r.pos, bytes.length, "activity ABC has unparsed bytes");
  return { strings, stringCountOffset, stringDataOffset, stringPoolEnd, namespaces, names, methods, methodTraits, bodies };
}

function inspectAbc(bytes) {
  const p = parseAbc(bytes), text = index => p.strings[p.names[index]?.name];
  const targets = p.methodTraits.filter(t => text(t.owner) === "CalendarManager" && text(t.name) === "__activityLoadComplete");
  assert.equal(targets.length, 1, "expected one CalendarManager activity callback trait");
  const trait = targets[0], method = p.methods[trait.method], name = p.names[trait.name], owner = p.names[trait.owner];
  assert.equal(trait.kind, 65, "unknown activity callback method trait metadata");
  assert.equal(trait.method, 33, "unknown activity callback method index");
  assert.equal(p.strings[p.namespaces[owner.ns]?.name], "calendar", "unknown callback class namespace");
  assert.equal(p.namespaces[name.ns]?.kind, 5, "activity callback must be private");
  assert.equal(p.strings[p.namespaces[name.ns]?.name], "calendar:CalendarManager", "unknown private callback namespace");
  assert.equal(p.strings[method?.name], METHOD, "unknown activity callback identity");
  assert.equal(method.flags, 128); assert.equal(method.params.length, 1);
  assert.equal(text(method.params[0]), "LoaderEvent"); assert.equal(text(method.returnType), "void");
  const matches = p.bodies.filter(body => body.method === trait.method);
  assert.equal(matches.length, 1, "expected one callback method body");
  const target = matches[0], digest = hash(target.code);
  assert.ok([ORIGINAL_CODE, PATCHED_CODE].includes(digest), "unknown activity callback code digest");
  assert.deepEqual([target.maxStack, target.localCount, target.initialScope, target.maxScope, target.length, target.exceptions], [3, 4, 4, 5, 176, 0], "unknown activity callback body contract");
  assert.equal(p.strings[199], "True", "shared sign-in True constant must remain unchanged");
  assert.equal(text(141), "String"); assert.equal(text(177), "value"); assert.equal(p.names[177].kind, 14);
  assert.equal(text(163), "_reciveActive"); assert.equal(text(178), "isAttend");
  const patched = digest === PATCHED_CODE;
  assert.equal(p.strings.length, patched ? 395 : 394, "unknown callback string pool");
  assert.equal(p.strings.indexOf("true"), patched ? 394 : -1, "unknown lowercase activity result constant");
  // Decode all 71 instructions, including debug operands, before identifying pushstring.
  const r = new Reader(target.code), instructions = [];
  while (r.pos < target.code.length) {
    const offset = r.pos, op = r.byte(), operands = [];
    if ([0xf1, 0xf0, 0x5d, 0x66, 0x80, 0x61, 0x2c].includes(op)) operands.push(r.u30());
    else if (op === 0xef) operands.push(r.byte(), r.u30(), r.byte(), r.u30());
    else if (op === 0x46) operands.push(r.u30(), r.u30());
    else if ([0x14, 0x0e].includes(op)) operands.push(r.bytes(3).readIntLE(0, 3));
    else if (op === 0x24) operands.push(r.bytes(1).readInt8(0));
    else assert.ok([0xd0, 0xd1, 0xd2, 0xd3, 0xd6, 0xd7, 0x30, 0x87, 0x29, 0x26, 0x47].includes(op), "unknown activity callback opcode");
    instructions.push({ offset, op, operands, end: r.pos });
  }
  assert.equal(instructions.length, 71);
  const pushes = instructions.filter(i => i.op === 0x2c); assert.equal(pushes.length, 1);
  const push = pushes[0], i = instructions.indexOf(push);
  assert.deepEqual(instructions.slice(i - 3, i + 2).map(x => [x.offset, x.op, x.operands]), [
    [102, 0xd3, []], [103, 0x66, [177]], [106, 0x46, [141, 1]], [110, 0x2c, [patched ? 394 : 199]], [113, 0x14, [11]],
  ], "unknown activity success comparison branch");
  assert.deepEqual(instructions.slice(i + 3, i + 7).map(x => [x.op, x.operands]), [[0xd0, []], [0x66, [163]], [0x26, []], [0x61, [178]]]);
  return { ...p, target, push, patched };
}

function patchAbc(bytes) {
  const p = inspectAbc(bytes);
  if (p.patched) return { out: bytes, changed: false, methodCount: p.methods.length };
  const rest = Buffer.from(bytes.subarray(p.stringPoolEnd)), relative = p.target.offset + p.push.offset + 1 - p.stringPoolEnd;
  const operand = encodeU30(394); assert.equal(operand.length, p.push.end - p.push.offset - 1);
  operand.copy(rest, relative);
  const out = Buffer.concat([bytes.subarray(0, p.stringCountOffset), encodeU30(395), bytes.subarray(p.stringDataOffset, p.stringPoolEnd), encodeU30(4), Buffer.from("true"), rest]);
  const checked = inspectAbc(out); assert.equal(checked.patched, true);
  // The entire namespaces-through-method-bodies suffix is identical except for this operand.
  const restored = Buffer.from(out.subarray(checked.stringPoolEnd)); encodeU30(199).copy(restored, relative);
  assert.deepEqual(restored, bytes.subarray(p.stringPoolEnd), "unrelated activity ABC bytes changed");
  return { out, changed: true, methodCount: p.methods.length };
}

export function patchActivityResponse(buf) {
  const { error, body, sig, version } = decompressSwf(buf); assert.equal(error, null);
  assert.equal(buf.readUInt32LE(4), body.length + 8, "invalid activity SWF declared length");
  const parsed = parseTags(body); let found = 0, changed = false, methodCount;
  const tags = parsed.tags.map(tag => {
    assert.ok(tag.bodyEnd <= body.length, "truncated activity SWF tag");
    if (tag.code !== 82) return tag.raw;
    const payload = body.subarray(tag.bodyStart, tag.bodyEnd), r = new Reader(payload); r.bytes(4);
    const nameStart = r.pos; while (r.byte() !== 0) {} const name = payload.toString("utf8", nameStart, r.pos - 1);
    if (name !== TAG) return tag.raw;
    found++;
    const result = patchAbc(payload.subarray(r.pos)); changed = result.changed; methodCount = result.methodCount;
    return result.changed ? buildTag(tag.code, Buffer.concat([payload.subarray(0, r.pos), result.out])) : tag.raw;
  });
  assert.equal(found, 1, "expected one CalendarManager DoABC tag");
  const out = changed ? compressSwf(sig, version, Buffer.concat([parsed.headerPrefix, ...tags, parsed.trailing])) : buf;
  return { out, changed, tagName: TAG, methodIndex: 33, originalCodeSha256: ORIGINAL_CODE, patchedCodeSha256: PATCHED_CODE,
    constantIndex: 394, sharedTrueIndex: 199, unchangedMethods: methodCount - 1, methodLength: 176, branchesAndExceptionsPreserved: true };
}
