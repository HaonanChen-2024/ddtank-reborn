// Build-only hall callback; menu v1 consumes the click even when its native UI is unavailable.
// No installation, network, database, or live player access. Unknown ABC owners fail closed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ByteReader, buildTag, compressSwf, decompressSwf, encodeU30, parseTags } from "../tools/i18n/abc-strings/lib.mjs";
import { parseActivityAbc } from "../tools/i18n/abc-strings/activity-response.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const cat = (...bytes) => Buffer.concat(bytes), u = encodeU30, byte = n => Buffer.from([n]);
const CALENDAR = {
  owner: "calendar/CalendarManager",
  abc: "da749f35c16b873fafd63d2b08a1ab54faa82da8175a41e79eb53df54d9b95ca",
  methods: [
    { name: "getInstance", index: 1, static: true, returns: "calendar::CalendarManager", code: "2e9ec34c1bc8d9cf2c5ca029e3013e8fc408f7df39199637b63267c82a08baa2", shape: [2, 1, 3, 4, 33, 0] },
    { name: "open", index: 6, static: false, returns: "::void", code: "4ece82fa5f8137362ae3eee5443cb75d7eaf92ea1b3a7fc7e9aa528ea979d25c", shape: [8, 2, 4, 5, 318, 0] },
  ],
};
const SPECS = {
  "hallIcon/view/HallRightIconView": {
    abc: "6086dfd81882da7bc728541bbeaf06249a17e8b65fa16e482ec3c4514181fd87", method: "__activityClickHandler", index: 13,
    code: "3c35a8d2bba47caaf2927c6e032b85f8692a9d9156bc0188e10e7627dc419f89", insert: 7,
    shape: [2, 4, 9, 10, 550, 0], publicNs: 3,
  },
  "chickActivation/ChickActivationManager": {
    abc: "e0a98cd203f4551ff2a8e5c9fc83f6e50b1ee85f3919c9910c1649067d1d1ebd", method: "setup", index: 4,
    code: "97a7a472232ede1b482783e5f81695e420f323fdac5b834f2fcb4cbf54fb0285", insert: 44,
    shape: [3, 1, 5, 6, 47, 0], publicNs: 6,
  },
};
function splice(bytes, edits) {
  let result = bytes, limit = bytes.length;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    assert.ok(edit.start >= 0 && edit.end >= edit.start && edit.end <= limit);
    result = cat(result.subarray(0, edit.start), edit.bytes, result.subarray(edit.end)); limit = edit.start;
  }
  return result;
}
function assembler() {
  const parts = [], labels = new Map(), branches = [], operations = []; let length = 0;
  return {
    op(op, ...args) { const encoded = cat(byte(op), ...args.map(u)); operations.push({ offset: length, op, args }); parts.push(encoded); length += encoded.length; },
    branch(op, target) { branches.push({ offset: length, target }); operations.push({ offset: length, op, target }); parts.push(cat(byte(op), Buffer.alloc(3))); length += 4; },
    label(name) { assert.ok(!labels.has(name)); labels.set(name, length); },
    finish() {
      const code = cat(...parts);
      for (const jump of branches) { assert.ok(labels.has(jump.target)); code.writeIntLE(labels.get(jump.target) - jump.offset - 4, jump.offset + 1, 3); }
      return { code, operations: operations.map(operation => operation.target ? { ...operation, target: labels.get(operation.target) } : operation) };
    },
  };
}
function extensions(p, spec) {
  const strings = [...p.strings], names = [], namespaces = [];
  const str = value => { const index = strings.length; strings.push(value); return index; };
  const name = (value, namespace = spec.publicNs) => { const index = p.names.length + names.length; names.push(cat(byte(7), u(namespace), u(str(value)))); return index; };
  const namespace = value => { const index = p.namespaces.length + namespaces.length; namespaces.push(cat(byte(22), u(str(value)))); return index; };
  const n = { ExternalInterface: name("ExternalInterface", namespace("flash.external")), available: name("available") };
  if (spec.method === "setup") {
    n.addCallback = name("addCallback"); n.callback = str("workshopOpenActivation");
    n.signCallback = str("workshopOpenSign"); n.CalendarManager = name("CalendarManager", namespace("calendar"));
    n.getInstance = name("getInstance"); n.openSign = name("open");
  }
  else { n.call = name("call"); n.open = str("workshopOpenActivities"); n.ID = name("ID"); n.expand = name("expand"); n.stopPropagation = name("stopPropagation"); }
  return { strings, names, namespaces, n };
}
function addition(spec, n) {
  const a = assembler(), o = (...args) => a.op(...args), j = (...args) => a.branch(...args);
  if (spec.method === "setup") {
    o(0x60, n.ExternalInterface); o(0x66, n.available); j(0x12, "fallback");
    o(0x60, n.ExternalInterface); o(0x2c, n.callback); o(0xd0); o(0x66, 75); o(0x4f, n.addCallback, 2);
    // AS3 method closures retain their receiver. Register open; never call sign/receive here.
    o(0x60, n.ExternalInterface); o(0x2c, n.signCallback); o(0x60, n.CalendarManager);
    o(0x46, n.getInstance, 0); o(0x66, n.openSign); o(0x4f, n.addCallback, 2);
  } else {
    // Existing scope is initialized. Preserve all original branches by inserting before their start.
    o(0xd0); o(0x66, 39); j(0x12, "fallback");
    o(0xd1); o(0x66, 64); o(0xd0); o(0x66, 39); o(0x66, 65); j(0x1a, "fallback");
    o(0x60, n.ExternalInterface); o(0x66, n.available); j(0x12, spec.nativeMenuVersion === 1 ? "consume" : "fallback");
    o(0x60, n.ExternalInterface); o(0x2c, n.open);
    o(0x60, 91); o(0x66, 76); o(0x66, 92); o(0x66, n.ID); o(0x46, n.call, 2);
    if (spec.nativeMenuVersion === 1) { o(0x29); a.label("consume"); }
    else { o(0x26); j(0x1a, "fallback"); }
    o(0xd0); o(0x66, 39); o(0x27); o(0x4f, n.expand, 1);
    // Stage has its own expansion listener: do not let it reopen the legacy activation menu.
    o(0xd1); o(0x4f, n.stopPropagation, 0); o(0x47);
  }
  a.label("fallback"); o(0x09); // Every fallback lands at an actual instruction boundary.
  return a.finish();
}
const stringPool = strings => cat(u(strings.length), ...strings.slice(1).map(value => { const bytes = Buffer.from(value); return cat(u(bytes.length), bytes); }));
function qtext(p, index) { const n = p.names[index]; return `${p.strings[p.namespaces[n.ns]?.name] ?? "*"}::${p.strings[n.name]}`; }
function readCalendar(bytes) {
  assert.equal(sha(bytes), CALENDAR.abc, "unknown CalendarManager; verify the original sign-window owner");
  const p = parseActivityAbc(bytes);
  const methods = CALENDAR.methods.map(expected => {
    const traits = p.methodTraits.filter(trait => qtext(p, trait.name) === `::${expected.name}`);
    assert.equal(traits.length, 1); const trait = traits[0], method = p.methods[trait.method], body = p.bodies.find(item => item.method === trait.method);
    assert.equal(trait.method, expected.index); assert.equal(trait.owner === null, expected.static);
    if (!expected.static) assert.equal(qtext(p, trait.owner), "calendar::CalendarManager");
    const ns = p.namespaces[p.names[trait.name].ns]; assert.equal(ns.kind, 22); assert.equal(p.strings[ns.name], "");
    assert.equal(p.strings[method.name], `calendar:CalendarManager/${expected.name}`);
    assert.deepEqual(method.params, []); assert.equal(method.flags, 0); assert.equal(qtext(p, method.returnType), expected.returns);
    assert.ok(body); assert.equal(sha(body.code), expected.code);
    assert.deepEqual([body.maxStack, body.localCount, body.initialScope, body.maxScope, body.length, body.exceptions], expected.shape);
    return { method: expected.name, methodIndex: expected.index, parameters: 0, returnType: expected.returns, codeSha256: expected.code };
  });
  return { owner: CALENDAR.owner, abcSha256: sha(bytes), methods, unchanged: true, callback: "CalendarManager.getInstance().open" };
}
function readOwner(bytes, spec) {
  assert.equal(sha(bytes), spec.abc, "unknown ABC owner; do not overwrite existing changes");
  const p = parseActivityAbc(bytes), traits = p.methodTraits.filter(t => p.strings[p.names[t.name]?.name] === spec.method);
  assert.equal(traits.length, 1); const trait = traits[0]; assert.equal(trait.method, spec.index);
  const body = p.bodies.find(b => b.method === trait.method); assert.ok(body);
  assert.equal(sha(body.code), spec.code); assert.deepEqual([body.maxStack, body.localCount, body.initialScope, body.maxScope, body.length, body.exceptions], spec.shape);
  assert.equal(p.strings[p.namespaces[spec.publicNs].name], ""); assert.equal(p.namespaces[spec.publicNs].kind, 22);
  if (spec.method === "setup") { assert.equal(qtext(p, 75), "::showFrame"); assert.equal(body.code[46], 0x47); }
  else {
    assert.deepEqual(body.code.subarray(5, 7), Buffer.from([0xd0, 0x30]));
    for (const [index, value] of [[39, "hallIcon.view:HallRightIconView::_activity"], [64, "::target"], [65, "::mainIcon"], [91, "ddt.manager::PlayerManager"], [76, "::Instance"], [92, "::Self"]]) assert.equal(qtext(p, index), value);
  }
  return { p, body };
}

// Finite branch checks for the injected instructions only, not an AVM2/Ruffle runtime claim.
function checkAddition(p, spec, pool, added) {
  const codeNames = new Map(p.names.flatMap((n, index) => n ? [[index, p.strings[n.name]]] : []));
  for (const [key, value] of Object.entries(pool.n)) if (!["open", "callback", "signCallback"].includes(key)) codeNames.set(value, key === "openSign" ? "open" : key);
  const strings = pool.strings;
  const execute = (available, result, targetIsMain, hasPanel = true) => {
    const calls = [], mainIcon = {}, panel = { mainIcon, expand: value => calls.push(["expand", value]) };
    const owner = { _activity: hasPanel ? panel : null, showFrame: () => {} };
    const event = { target: targetIsMain ? mainIcon : {}, stopPropagation: () => calls.push(["stopPropagation"]) };
    let calendarReads = 0, calendarOpens = 0;
    const calendar = { open() { assert.equal(this, calendar); assert.equal(arguments.length, 0); calendarOpens++; } };
    const globals = { ExternalInterface: { available, call: (...args) => { calls.push(["call", ...args]); return result; }, addCallback: (...args) => calls.push(["addCallback", ...args]) }, PlayerManager: { Instance: { Self: { ID: 40 } } }, CalendarManager: { getInstance() { assert.equal(arguments.length, 0); calendarReads++; return calendar; } } };
    const stack = []; let position = 0, returned = false;
    const operations = added.operations, byOffset = new Map(operations.map((operation, index) => [operation.offset, index]));
    while (position < operations.length) {
      const operation = operations[position++], { op, args = [] } = operation;
      if (op === 0xd0) stack.push(owner);
      else if (op === 0xd1) stack.push(event);
      else if (op === 0x60) stack.push(globals[codeNames.get(args[0])]);
      else if (op === 0x66) { const receiver = stack.pop(), value = receiver[codeNames.get(args[0])]; stack.push(typeof value === "function" ? value.bind(receiver) : value); }
      else if (op === 0x2c) stack.push(strings[args[0]]);
      else if (op === 0x26 || op === 0x27) stack.push(op === 0x26);
      else if (op === 0x29) stack.pop();
      else if (op === 0x12) { if (!stack.pop()) position = byOffset.get(operation.target); }
      else if (op === 0x1a) { const right = stack.pop(), left = stack.pop(); if (left !== right) position = byOffset.get(operation.target); }
      else if (op === 0x46 || op === 0x4f) { const values = stack.splice(stack.length - args[1]), object = stack.pop(); const value = object[codeNames.get(args[0])](...values); if (op === 0x46) stack.push(value); }
      else if (op === 0x47) { returned = true; break; }
      else assert.equal(op, 0x09);
    }
    assert.equal(stack.length, 0); assert.equal(calendarOpens, 0, "registration must not open or claim anything");
    assert.equal(calendarReads, spec.method === "setup" && available ? 1 : 0);
    if (spec.method === "setup" && available) {
      const callback = calls.find(call => call[1] === "workshopOpenSign"); assert.ok(callback);
      callback[2](); assert.equal(calendarOpens, 1, "sign callback must open the bound CalendarManager without arguments");
    }
    return { returned, calls };
  };
  assert.deepEqual(execute(false, true, true).calls, spec.nativeMenuVersion === 1 ? [["expand", false], ["stopPropagation"]] : []);
  assert.equal(execute(false, true, true).returned, spec.nativeMenuVersion === 1);
  if (spec.method === "setup") {
    const ok = execute(true, true, true); assert.equal(ok.calls.length, 2); assert.equal(ok.calls[0][0], "addCallback");
    assert.equal(ok.calls[0][1], "workshopOpenActivation"); assert.equal(typeof ok.calls[0][2], "function"); assert.equal(ok.returned, false);
    assert.equal(ok.calls[1][0], "addCallback"); assert.equal(ok.calls[1][1], "workshopOpenSign"); assert.equal(typeof ok.calls[1][2], "function");
  } else {
    assert.deepEqual(execute(true, true, false).calls, []); assert.deepEqual(execute(true, true, true, false).calls, []);
    for (const value of [false, null, undefined, 1, "true"]) {
      const fallback = execute(true, value, true); assert.equal(fallback.returned, spec.nativeMenuVersion === 1);
      assert.equal(fallback.calls.length, spec.nativeMenuVersion === 1 ? 3 : 1);
    }
    assert.deepEqual(execute(true, true, true), { returned: true, calls: [["call", "workshopOpenActivities", 40], ["expand", false], ["stopPropagation"]] });
  }
}
function patchOwner(bytes, spec) {
  const { p, body } = readOwner(bytes, spec), pool = extensions(p, spec), added = addition(spec, pool.n);
  checkAddition(p, spec, pool, added);
  const code = cat(body.code.subarray(0, spec.insert), added.code, body.code.subarray(spec.insert));
  const newBody = cat(u(body.method), u(Math.max(3, body.maxStack)), u(body.localCount), u(body.initialScope), u(body.maxScope), u(code.length), code, u(0), bytes.subarray(body.traitsOffset, body.end));
  const out = splice(bytes, [
    { start: p.stringCountOffset, end: p.stringPoolEnd, bytes: stringPool(pool.strings) },
    { start: p.namespaceCountOffset, end: p.namespacePoolEnd, bytes: cat(u(p.namespaces.length + pool.namespaces.length), bytes.subarray(p.namespaceDataOffset, p.namespacePoolEnd), ...pool.namespaces) },
    { start: p.nameCountOffset, end: p.namePoolEnd, bytes: cat(u(p.names.length + pool.names.length), bytes.subarray(p.nameDataOffset, p.namePoolEnd), ...pool.names) },
    { start: body.start, end: body.end, bytes: newBody },
  ]);
  const checked = parseActivityAbc(out), changedBodies = [];
  assert.equal(checked.bodies.length, p.bodies.length); assert.equal(checked.methods.length, p.methods.length);
  assert.deepEqual(checked.methods, p.methods); assert.deepEqual(checked.methodTraits, p.methodTraits);
  assert.deepEqual(checked.strings.slice(0, p.strings.length), p.strings);
  assert.deepEqual(checked.names.slice(0, p.names.length), p.names); assert.deepEqual(checked.namespaces.slice(0, p.namespaces.length), p.namespaces);
  for (const original of p.bodies) {
    const current = checked.bodies.find(b => b.method === original.method); assert.ok(current);
    if (!out.subarray(current.start, current.end).equals(bytes.subarray(original.start, original.end))) changedBodies.push(original.method);
  }
  assert.deepEqual(changedBodies, [body.method]); const current = checked.bodies.find(b => b.method === body.method);
  assert.deepEqual(cat(current.code.subarray(0, spec.insert), current.code.subarray(spec.insert + added.code.length)), body.code);
  // Undo only the explicit pool appends/body edit and demand exact original ABC bytes.
  const restored = splice(out, [
    { start: checked.stringCountOffset, end: checked.stringPoolEnd, bytes: bytes.subarray(p.stringCountOffset, p.stringPoolEnd) },
    { start: checked.namespaceCountOffset, end: checked.namespacePoolEnd, bytes: bytes.subarray(p.namespaceCountOffset, p.namespacePoolEnd) },
    { start: checked.nameCountOffset, end: checked.namePoolEnd, bytes: bytes.subarray(p.nameCountOffset, p.namePoolEnd) },
    { start: current.start, end: current.end, bytes: bytes.subarray(body.start, body.end) },
  ]); assert.deepEqual(restored, bytes);
  return { out, proof: { method: spec.method, methodIndex: body.method, originalAbcSha256: sha(bytes), candidateAbcSha256: sha(out), originalCodeSha256: sha(body.code), candidateCodeSha256: sha(code), insertedBytes: added.code.length, changedMethodBodies: changedBodies, unrelatedMethodsByteIdentical: true, inverseRestoresOriginalAbc: true, branchCasesChecked: true } };
}

export function buildActivityEntry(input, { nativeMenuVersion } = {}) {
  assert.ok(nativeMenuVersion === undefined || nativeMenuVersion === 1, "unsupported native activity menu version");
  const swf = decompressSwf(input); assert.equal(swf.error, null); assert.equal(input.readUInt32LE(4), swf.body.length + 8);
  const original = parseTags(swf.body), owners = [], calendarOwners = [], outputTags = original.tags.map(tag => {
    if (tag.code !== 82) return tag.raw;
    const payload = swf.body.subarray(tag.bodyStart, tag.bodyEnd), reader = new ByteReader(payload);
    reader.u32(); const name = reader.cstring();
    if (name === CALENDAR.owner) calendarOwners.push(readCalendar(payload.subarray(reader.pos)));
    if (!Object.hasOwn(SPECS, name)) return tag.raw;
    assert.ok(!owners.some(owner => owner.owner === name));
    const spec = nativeMenuVersion === 1 && SPECS[name].method !== "setup" ? { ...SPECS[name], nativeMenuVersion } : SPECS[name];
    const changed = patchOwner(payload.subarray(reader.pos), spec);
    owners.push({ owner: name, ...changed.proof }); return buildTag(82, cat(payload.subarray(0, reader.pos), changed.out));
  });
  assert.equal(owners.length, 2); assert.equal(calendarOwners.length, 1);
  const output = compressSwf(swf.sig, swf.version, cat(original.headerPrefix, ...outputTags, original.trailing));
  const roundtrip = decompressSwf(output), parsed = parseTags(roundtrip.body); assert.equal(parsed.tags.length, original.tags.length);
  assert.deepEqual(parsed.headerPrefix, original.headerPrefix); assert.deepEqual(parsed.trailing, original.trailing);
  const changedTagIndices = original.tags.flatMap((tag, i) => tag.raw.equals(parsed.tags[i].raw) ? [] : [i]);
  assert.equal(changedTagIndices.length, 2);
  return { output, proof: { owner: "ddtank-workshop/activity-entry-candidate", ...(nativeMenuVersion === 1 ? { nativeMenuVersion: 1 } : {}), original: { bytes: input.length, sha256: sha(input) }, candidate: { bytes: output.length, sha256: sha(output) }, changedTagIndices, changedAbcOwners: owners, calendarWindowOwner: calendarOwners[0], allOtherTagsByteIdentical: true, installed: false, runtimeVerified: false, callbacks: { page: "workshopOpenActivities(characterId): boolean", flash: "workshopOpenActivation(): void", sign: "workshopOpenSign(): void" } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputPath, outputPath, receiptPath, expectedSha] = process.argv.slice(2);
  assert.ok(inputPath && outputPath && receiptPath && /^[a-f0-9]{64}$/.test(expectedSha ?? ""), "usage: node scripts/workshop-activity-entry.mjs INPUT OUTPUT RECEIPT EXPECTED_INPUT_SHA256");
  const inputFile = resolve(inputPath), outputFile = resolve(outputPath), receiptFile = resolve(receiptPath);
  assert.ok(new Set([inputFile, outputFile, receiptFile]).size === 3); assert.ok(!existsSync(outputFile) && !existsSync(receiptFile), "preserve existing artifacts");
  const input = readFileSync(inputFile); assert.equal(sha(input), expectedSha, "input changed since review");
  const result = buildActivityEntry(input);
  mkdirSync(dirname(outputFile), { recursive: true }); mkdirSync(dirname(receiptFile), { recursive: true });
  writeFileSync(outputFile, result.output, { flag: "wx" });
  writeFileSync(receiptFile, JSON.stringify({ ...result.proof, input: inputFile, output: outputFile, createdAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
  assert.equal(sha(readFileSync(inputFile)), expectedSha); assert.equal(sha(readFileSync(outputFile)), result.proof.candidate.sha256);
  console.log(JSON.stringify({ output: outputFile, receipt: receiptFile, ...result.proof }));
}
