// Compose after the existing activity-entry patch. Only register the native wardrobe bridge.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ByteReader, buildTag, compressSwf, decompressSwf, encodeU30, parseTags } from "../tools/i18n/abc-strings/lib.mjs";
import { parseActivityAbc } from "../tools/i18n/abc-strings/activity-response.mjs";
import { decode } from "./native-pair/audit-candidate.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const cat = (...parts) => Buffer.concat(parts), u = encodeU30;
const ownerName = "chickActivation/ChickActivationManager";
const bridgeName = "workshop/native/WorkshopNativeWardrobeBridge/v1";
const sourceHash = "d81a0d2cf2387b2ee76e9b3910446d59be36143afb47a64784a4ba55fbd4250c";
const sourceCodeHash = "10ee4103b30bc8cacfacf1ddfd78322befefe256f93cfd83db1c09dfc760fce2";
function replace(bytes, edits) {
  let result = bytes, boundary = bytes.length;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    assert.ok(e.start >= 0 && e.end <= boundary && e.end >= e.start);
    result = cat(result.subarray(0, e.start), e.bytes, result.subarray(e.end)); boundary = e.start;
  }
  return result;
}
function readTag(tag) {
  const reader = new ByteReader(tag), head = reader.u16();
  assert.equal(head >> 6, 82);
  const length = (head & 63) === 63 ? reader.u32() : head & 63;
  assert.equal(reader.pos + length, tag.length);
  const payload = reader.pos;
  reader.u32(); const name = reader.cstring();
  return { name, abc: tag.subarray(reader.pos), prefix: tag.subarray(payload, reader.pos) };
}

// Opt-in v1 gate only. Legacy bridge installation and byte generation do not call this helper.
export function verifyNativeActivityMenuBridge(bridgeTag) {
  const bridge = readTag(bridgeTag); assert.equal(bridge.name, bridgeName);
  const p = parseActivityAbc(bridge.abc);
  const qualified = index => {
    const n = p.names[index];
    assert.ok(n && n.kind === 7, "native menu requires a concrete QName");
    return `${p.strings[p.namespaces[n.ns]?.name]}::${p.strings[n.name]}`;
  };
  const classes = [...new Set(p.traitBlocks.filter(t => t.owner != null).map(t => qualified(t.owner)))];
  assert.deepEqual(classes, ["::WorkshopNativeWardrobeBridge"]);
  const publicMethod = (name, params, returnType) => {
    const traits = p.methodTraits.filter(t => qualified(t.name) === `::${name}`);
    assert.equal(traits.length, 1, `native menu public method: ${name}`);
    const trait = traits[0], ns = p.namespaces[p.names[trait.name].ns];
    assert.equal(trait.owner, null, `native menu method must be static: ${name}`);
    assert.equal(trait.kind & 15, 1); assert.equal(ns.kind, 22, `native menu method must be public: ${name}`);
    const method = p.methods[trait.method], bodies = p.bodies.filter(b => b.method === trait.method);
    assert.equal(bodies.length, 1, `native menu method body: ${name}`);
    assert.deepEqual(method.params.map(qualified), params, `native menu parameter ABI: ${name}`);
    assert.equal(qualified(method.returnType), returnType, `native menu return ABI: ${name}`);
    return { name, method: trait.method, params, returnType, body: bodies[0] };
  };
  const menu = [
    ["workshopOpenActivityMenu", "openActivityMenu", ["::Number", "::String"], "::Boolean"],
    ["workshopStatusActivityMenu", "statusActivityMenu", [], "::Object"],
    ["workshopCloseActivityMenu", "closeActivityMenu", ["::String"], "::Boolean"],
    ["workshopActivityMenuResult", "activityMenuResult", ["::Number", "::String", "::String", "::Boolean", "::String"], "::Boolean"],
  ];
  const init = publicMethod("init", [], "::void"), ops = decode(init.body.code), registrations = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]; if (![0x46, 0x4f].includes(op.op)) continue;
    assert.equal(qualified(op.args[0]), "::addCallback", "native menu init may only register callbacks");
    assert.equal(op.args[1], 2);
    const [receiver, literal, binding] = ops.slice(i - 3, i);
    assert.ok(receiver?.op === 0x60 && literal?.op === 0x2c && binding?.op === 0x60, "native menu callback requires an actual direct function binding");
    assert.equal(qualified(receiver.args[0]), "flash.external::ExternalInterface");
    registrations.push({ callback: p.strings[literal.args[0]], binding: qualified(binding.args[0]), offset: op.offset });
  }
  const legacy = ["Wardrobe", "Pair", "Mines", "DDPlay", "Gypsy", "Moonlight", "Treasure", "Purr", "Carnival", "FirstRecharge", "Charge", "Forthright", "Exchange", "Devil", "CaveLoot", "Christmas"]
    .flatMap(name => ["Open", "Status", "Close"].map(action => `workshop${action}${name}`));
  assert.deepEqual(registrations.map(r => r.callback).sort(), [...legacy, ...menu.map(row => row[0])].sort(), "native menu v1 requires exactly 52 real callback registrations");
  const methods = menu.map(([callback, name, params, result]) => {
    const { body, ...method } = publicMethod(name, params, result), registration = registrations.find(r => r.callback === callback);
    assert.equal(registration.binding, `::${name}`, `native menu callback points to the wrong method: ${callback}`);
    return { callback, ...method, registrationOffset: registration.offset, codeSha256: sha(body.code) };
  });
  return { version: 1, bridgeSha256: sha(bridgeTag), initMethod: init.method, initCallbackCount: registrations.length,
    legacyCallbacks: legacy.length, menuCallbacks: methods, compiledOnly: true, runtimeVerified: false };
}

export function buildNativeWardrobeEntry(input, bridgeTag) {
  const bridge = readTag(bridgeTag);
  assert.equal(bridge.name, bridgeName);
  const bridgeAbc = parseActivityAbc(bridge.abc);
  const classNames = [...new Set(bridgeAbc.traitBlocks.filter(t => t.owner != null).map(t => {
    const n = bridgeAbc.names[t.owner]; return `${bridgeAbc.strings[bridgeAbc.namespaces[n.ns]?.name]}::${bridgeAbc.strings[n.name]}`;
  }))];
  assert.deepEqual(classNames, ["::WorkshopNativeWardrobeBridge"]);
  for (const callback of ["workshopOpenWardrobe", "workshopStatusWardrobe", "workshopCloseWardrobe"]) assert.ok(bridgeAbc.strings.includes(callback));
  const swf = decompressSwf(input); assert.equal(swf.error, null);
  const parsed = parseTags(swf.body); let changed = null;
  const outputTags = [];
  for (const [index, tag] of parsed.tags.entries()) {
    if (tag.code !== 82) { outputTags.push(tag.raw); continue; }
    const owner = readTag(tag.raw);
    assert.notEqual(owner.name, bridgeName, "native bridge already present; rebuild from the owned original input");
    if (owner.name !== ownerName) { outputTags.push(tag.raw); continue; }
    assert.equal(changed, null); assert.equal(sha(owner.abc), sourceHash, "changed setup owner preserved");
    const p = parseActivityAbc(owner.abc), body = p.bodies.find(b => b.method === 4);
    assert.ok(body); assert.equal(sha(body.code), sourceCodeHash);
    assert.deepEqual([body.maxStack, body.localCount, body.initialScope, body.maxScope, body.length, body.exceptions], [3, 1, 5, 6, 82, 0]);
    assert.equal(p.namespaces[6].kind, 22); assert.equal(p.strings[p.namespaces[6].name], "");
    assert.deepEqual([...body.code.subarray(78)], [9, 240, 54, 71]);
    const strings = [...p.strings, "WorkshopNativeWardrobeBridge", "init"];
    const pool = cat(u(strings.length), ...strings.slice(1).map(s => { const b = Buffer.from(s); return cat(u(b.length), b); }));
    const names = cat(u(p.names.length + 2), owner.abc.subarray(p.nameDataOffset, p.namePoolEnd),
      Buffer.from([7, 6]), u(p.strings.length), Buffer.from([7, 6]), u(p.strings.length + 1));
    const added = cat(Buffer.from([0x60]), u(p.names.length), Buffer.from([0x4f]), u(p.names.length + 1), u(0));
    const code = cat(body.code.subarray(0, 79), added, body.code.subarray(79));
    const newBody = cat(u(4), u(3), u(1), u(5), u(6), u(code.length), code, u(0), owner.abc.subarray(body.traitsOffset, body.end));
    const out = replace(owner.abc, [
      { start: p.stringCountOffset, end: p.stringPoolEnd, bytes: pool },
      { start: p.nameCountOffset, end: p.namePoolEnd, bytes: names },
      { start: body.start, end: body.end, bytes: newBody },
    ]);
    const checked = parseActivityAbc(out), current = checked.bodies.find(b => b.method === 4);
    assert.deepEqual(checked.methods, p.methods); assert.deepEqual(checked.methodTraits, p.methodTraits);
    assert.deepEqual(checked.namespaces, p.namespaces);
    assert.deepEqual(checked.bodies.filter(b => b.method !== 4).map(b => out.subarray(b.start, b.end)), p.bodies.filter(b => b.method !== 4).map(b => owner.abc.subarray(b.start, b.end)));
    assert.deepEqual(cat(current.code.subarray(0, 79), current.code.subarray(79 + added.length)), body.code);
    const restored = replace(out, [
      { start: checked.stringCountOffset, end: checked.stringPoolEnd, bytes: owner.abc.subarray(p.stringCountOffset, p.stringPoolEnd) },
      { start: checked.nameCountOffset, end: checked.namePoolEnd, bytes: owner.abc.subarray(p.nameCountOffset, p.namePoolEnd) },
      { start: current.start, end: current.end, bytes: owner.abc.subarray(body.start, body.end) },
    ]);
    assert.deepEqual(restored, owner.abc);
    changed = { index, owner: ownerName, originalAbcSha256: sourceHash, candidateAbcSha256: sha(out), insertionOffset: 79, insertedBytes: added.length, inverseRestoresOriginal: true };
    outputTags.push(bridgeTag, buildTag(82, cat(owner.prefix, out)));
  }
  assert.ok(changed);
  const output = compressSwf(swf.sig, swf.version, cat(parsed.headerPrefix, ...outputTags, parsed.trailing));
  const result = parseTags(decompressSwf(output).body);
  assert.equal(result.tags.length, parsed.tags.length + 1);
  for (let i = 0; i < parsed.tags.length; i++) if (i !== changed.index) assert.deepEqual(result.tags[i + (i > changed.index ? 1 : 0)].raw, parsed.tags[i].raw);
  return { output, proof: { originalSha256: sha(input), candidateSha256: sha(output), bridgeSha256: sha(bridgeTag), changed, allOtherTagsByteIdentical: true, installed: false, runtimeVerified: false } };
}
