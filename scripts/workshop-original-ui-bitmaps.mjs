// Offline original bitmap transplant; opted-in wrapper defaults are the only ABC edits.
// The caller pins both complete input SWFs.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { ByteReader, decompressSwf, parseTags, buildTag, compressSwf, encodeU30 } from '../tools/i18n/abc-strings/lib.mjs';
import { parseActivityAbc } from '../tools/i18n/abc-strings/activity-response.mjs';
import { decodeBitmap, hash, jpegBitmapData } from './workshop-bag-art.mjs';
import { decodeJpeg3 } from './workshop-calendar-art.mjs';

const bitmapCodes = new Set([21, 35, 36]);
const definitionCodes = new Set([2, 6, 7, 10, 11, 14, 20, 21, 22, 32, 33, 34, 35, 36, 37, 39, 46, 48, 60, 75, 83, 84, 87, 90, 91]);
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

// Decode only; transplanting always preserves the original compressed payload.
export function decodeOriginalLossless2(body) {
  assert.ok(body.length >= 7, 'truncated DefineBitsLossless2');
  if (body[2] === 5) return decodeBitmap(body);
  assert.equal(body[2], 3, 'unsupported DefineBitsLossless2 format');
  assert.ok(body.length >= 8, 'truncated palette bitmap');
  const id = body.readUInt16LE(0), width = body.readUInt16LE(3), height = body.readUInt16LE(5), colors = body[7] + 1;
  assert.ok(width > 0 && height > 0, 'invalid palette bitmap dimensions');
  const palette = inflateSync(body.subarray(8)), stride = (width + 3) & ~3;
  assert.equal(palette.length, colors * 4 + stride * height, 'invalid palette pixel count');
  const raw = Buffer.alloc(width * height * 4), rgba = Buffer.alloc(raw.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = palette[colors * 4 + y * stride + x]; assert.ok(index < colors, 'palette index outside color table');
    const k = index * 4, p = (y * width + x) * 4, a = palette[k + 3]; raw[p] = a; rgba[p + 3] = a;
    for (let c = 0; c < 3; c++) { raw[p + c + 1] = palette[k + c]; rgba[p + c] = a ? Math.min(255, Math.round(palette[k + c] * 255 / a)) : 0; }
  }
  return { id, width, height, raw, rgba };
}

function scan(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 8, 'SWF buffer required');
  const decoded = decompressSwf(bytes); assert.equal(decoded.error, null);
  assert.equal(bytes.readUInt32LE(4), decoded.body.length + 8, 'SWF declared length mismatch');
  const parsed = parseTags(decoded.body);
  assert.equal(parsed.tags.at(-1)?.code, 0, 'missing SWF End tag');
  for (const tag of parsed.tags) assert.ok(tag.bodyEnd <= decoded.body.length && tag.raw.length === tag.bodyEnd - tag.headerStart, 'SWF tag outside body');
  const symbols = [];
  for (const tag of parsed.tags.filter(tag => tag.code === 76)) {
    const r = new ByteReader(decoded.body.subarray(tag.bodyStart, tag.bodyEnd));
    assert.ok(r.buf.length >= 2, 'truncated SymbolClass');
    for (let n = r.u16(); n; n--) {
      assert.ok(r.pos + 2 <= r.buf.length, 'truncated SymbolClass ID');
      const id = r.u16(); assert.ok(r.buf.indexOf(0, r.pos) >= r.pos, 'unterminated SymbolClass name');
      symbols.push({ id, name: r.cstring() });
    }
    assert.equal(r.pos, r.buf.length, 'unread SymbolClass bytes');
  }
  return { ...decoded, ...parsed, symbols };
}

function namedBitmap(swf, name, expectedHash, side) {
  assert.ok(typeof name === 'string' && name.length > 0, side + ' symbol required');
  assert.match(expectedHash ?? '', /^[a-f0-9]{64}$/, side + ' tag SHA256 required');
  const symbols = swf.symbols.filter(symbol => symbol.name === name);
  assert.equal(symbols.length, 1, side + ' symbol missing or duplicate: ' + name);
  const { id } = symbols[0]; assert.notEqual(id, 0, side + ' root SymbolClass is not a bitmap');
  const tags = swf.tags.filter(tag => definitionCodes.has(tag.code) && tag.bodyEnd - tag.bodyStart >= 2 && swf.body.readUInt16LE(tag.bodyStart) === id);
  assert.equal(tags.length, 1, side + ' character definition missing or duplicate: ' + name);
  const tag = tags[0]; assert.ok(bitmapCodes.has(tag.code), side + ' unsupported bitmap tag: ' + tag.code);
  assert.equal(hash(tag.raw), expectedHash, side + ' bitmap tag changed: ' + name);
  return { id, tag, body: swf.body.subarray(tag.bodyStart, tag.bodyEnd) };
}

async function decode(swf, bitmap) {
  const { tag, body } = bitmap;
  if (tag.code === 36) return decodeOriginalLossless2(body);
  assert.ok(body.length >= (tag.code === 35 ? 6 : 2), 'truncated encoded bitmap');
  const size = tag.code === 35 ? body.readUInt32LE(2) : body.length - 2, start = tag.code === 35 ? 6 : 2;
  assert.ok(size > 0 && start + size <= body.length, 'invalid bitmap alpha offset');
  let encoded = body.subarray(start, start + size);
  const png = encoded.subarray(0, 8).equals(pngSignature);
  if (!png) {
    // Decode these bytes independently; unrelated global JPEGTables are never read.
    encoded = jpegBitmapData(body, tag.code).encoded;
    if (tag.code === 21) {
      const markers = new Set(); let at = 2;
      while (at < encoded.length) {
        assert.equal(encoded[at++], 255, 'invalid standalone JPEG marker');
        while (encoded[at] === 255) at++;
        const marker = encoded[at++]; markers.add(marker);
        assert.ok(at + 2 <= encoded.length, 'truncated standalone JPEG segment');
        const length = encoded.readUInt16BE(at); assert.ok(length >= 2 && at + length <= encoded.length, 'invalid standalone JPEG segment');
        at += length; if (marker === 218) break;
      }
      assert.ok(markers.has(219) && markers.has(196) && [...markers].some(code => [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(code)) && markers.has(218), 'JPEG2 requires standalone quantization/Huffman/frame/scan tables');
    }
  }
  // The existing decoder also handles standalone JPEG2 when wrapped without alpha.
  const prefix = Buffer.alloc(6); prefix.writeUInt16LE(bitmap.id); prefix.writeUInt32LE(encoded.length, 2);
  const image = await decodeJpeg3(Buffer.concat([prefix, encoded, body.subarray(start + size)]));
  assert.ok(image.width > 0 && image.height > 0 && image.rgba.length === image.width * image.height * 4, 'invalid decoded bitmap dimensions');
  return image;
}

const qname = (p, index) => {
  const name = p.names[index]; if (!name || name.kind !== 7) return null;
  const ns = p.strings[p.namespaces[name.ns]?.name]; return ns ? ns + '.' + p.strings[name.name] : p.strings[name.name];
};

// Read only the additional spans needed for two integer constructor defaults.
// Existing complete ABC parsing owns traits and method-body validation.
function constructorInfo(abc) {
  const p = parseActivityAbc(abc), r = new ByteReader(abc), ints = [0], optionals = [], instances = [];
  r.pos = 4; const intCount = r.u30(), intDataStart = r.pos;
  for (let i = 1; i < intCount; i++) ints.push(r.u30() | 0);
  const intEnd = r.pos; r.pos = p.namePoolEnd;
  assert.equal(r.u30(), p.methods.length);
  for (let i = 0; i < p.methods.length; i++) {
    const params = r.u30(); r.u30(); for (let n = 0; n < params; n++) r.u30(); r.u30(); const flags = abc[r.pos++], values = [];
    if (flags & 8) for (let n = r.u30(); n; n--) { const start = r.pos, index = r.u30(), end = r.pos, kind = abc[r.pos++]; values.push({ start, end, index, kind }); }
    if (flags & 128) for (let n = 0; n < params; n++) r.u30();
    optionals.push(values);
  }
  for (let n = r.u30(); n; n--) { r.u30(); for (let pairs = r.u30() * 2; pairs; pairs--) r.u30(); }
  for (let n = r.u30(); n; n--) {
    const name = r.u30(), superName = r.u30(), flags = abc[r.pos++]; if (flags & 8) r.u30();
    const interfaces = []; for (let count = r.u30(); count; count--) interfaces.push(r.u30());
    const ctor = r.u30(), traits = p.traitBlocks.find(block => block.countOffset === r.pos);
    assert.ok(traits && traits.owner === name, 'missing BitmapData instance traits'); r.pos = traits.end;
    instances.push({ name, superName, flags, interfaces, ctor, traitCount: traits.count });
  }
  return { p, abc, ints, intCount, intDataStart, intEnd, optionals, instances };
}

function bitmapWrapper(swf, symbol) {
  if (!swf.abcs) swf.abcs = swf.tags.filter(tag => tag.code === 82).map(tag => {
    const body = swf.body.subarray(tag.bodyStart, tag.bodyEnd), end = body.indexOf(0, 4);
    assert.ok(body.length >= 5 && end >= 4, 'truncated DoABC header');
    return { tag, prefix: body.subarray(0, end + 1), ...constructorInfo(body.subarray(end + 1)) };
  });
  const matches = swf.abcs.flatMap(abc => abc.instances.filter(instance => qname(abc.p, instance.name) === symbol).map(instance => ({ abc, instance })));
  assert.equal(matches.length, 1, 'BitmapData wrapper missing or duplicate: ' + symbol);
  const { abc, instance } = matches[0], method = abc.p.methods[instance.ctor], optional = abc.optionals[instance.ctor];
  assert.equal(qname(abc.p, instance.superName), 'flash.display.BitmapData', 'wrapper must extend BitmapData');
  assert.equal(instance.traitCount, 0, 'BitmapData wrapper has instance traits'); assert.equal(instance.interfaces.length, 0, 'BitmapData wrapper has interfaces');
  assert.equal(abc.instances.filter(other => other.ctor === instance.ctor).length, 1, 'BitmapData constructor is shared');
  assert.equal(method.flags, 8, 'BitmapData constructor must have only optional parameters');
  assert.deepEqual(method.params.map(index => qname(abc.p, index)), ['int', 'int'], 'BitmapData constructor must take two ints');
  assert.equal(optional.length, 2, 'BitmapData constructor needs two defaults');
  assert.ok(optional.every(value => value.kind === 3 && value.index > 0 && value.index < abc.ints.length), 'BitmapData defaults must be explicit int constants');
  const bodies = abc.p.bodies.filter(body => body.method === instance.ctor); assert.equal(bodies.length, 1, 'BitmapData constructor body missing or duplicate');
  assert.equal(bodies[0].code.toString('hex'), 'd030d0d1d2490247', 'BitmapData constructor must only forward super(param1,param2)');
  assert.equal(bodies[0].exceptions, 0, 'BitmapData constructor has exceptions');
  return { abc, instance, defaults: optional.map(value => abc.ints[value.index]) };
}

function replaceSpans(bytes, changes) {
  const parts = []; let at = 0;
  for (const change of changes.sort((a, b) => a.start - b.start)) {
    assert.ok(change.start >= at && change.end >= change.start, 'overlapping constructor edits');
    parts.push(bytes.subarray(at, change.start), change.bytes); at = change.end;
  }
  return Buffer.concat([...parts, bytes.subarray(at)]);
}

function patchConstructorDefaults(abc, plans) {
  const ints = [...abc.ints], changes = [], appended = [], methodChanges = [];
  for (const [method, values] of plans) {
    const indices = values.map(value => {
      let index = ints.indexOf(value, 1); if (index < 0) { index = ints.length; ints.push(value); appended.push(value); } return index;
    });
    for (let i = 0; i < 2; i++) if (indices[i] !== abc.optionals[method][i].index) changes.push({ ...abc.optionals[method][i], bytes: encodeU30(indices[i]) });
    methodChanges.push({ method, before: abc.optionals[method].map(value => abc.ints[value.index]), after: values });
  }
  if (!changes.length) return { out: abc.abc, changes: [], allMethodBodiesByteIdentical: true };
  if (appended.length) changes.push({ start: 4, end: abc.intEnd, bytes: Buffer.concat([encodeU30(ints.length), abc.abc.subarray(abc.intDataStart, abc.intEnd), ...appended.map(encodeU30)]) });
  const out = replaceSpans(abc.abc, changes), checked = constructorInfo(out);
  assert.deepEqual(checked.ints, ints); assert.deepEqual(checked.p.methods, abc.p.methods); assert.deepEqual(checked.instances, abc.instances);
  for (const key of ['strings', 'namespaces', 'namespaceSets', 'names', 'methodTraits']) assert.deepEqual(checked.p[key], abc.p[key], 'unselected ABC structure changed');
  assert.equal(checked.p.bodies.length, abc.p.bodies.length);
  for (let i = 0; i < abc.p.bodies.length; i++) {
    const before = abc.p.bodies[i], after = checked.p.bodies[i];
    assert.deepEqual(out.subarray(after.start, after.end), abc.abc.subarray(before.start, before.end), 'ABC method body changed');
  }
  for (let method = 0; method < abc.optionals.length; method++) {
    const old = abc.optionals[method], next = checked.optionals[method]; assert.equal(next.length, old.length);
    for (let i = 0; i < old.length; i++) {
      assert.equal(next[i].kind, old[i].kind);
      if (plans.has(method)) assert.equal(checked.ints[next[i].index], plans.get(method)[i]);
      else assert.equal(next[i].index, old[i].index, 'unselected optional default changed');
    }
  }
  // Reversing only these allowed pool/default spans must recover the entire old ABC.
  const inverse = []; let shift = 0;
  for (const change of changes) { inverse.push({ start: change.start + shift, end: change.start + shift + change.bytes.length, bytes: abc.abc.subarray(change.start, change.end) }); shift += change.bytes.length - (change.end - change.start); }
  assert.deepEqual(replaceSpans(out, inverse), abc.abc, 'ABC changes escaped constructor defaults/int append');
  return { out, changes: methodChanges, appendedIntegers: appended, allMethodBodiesByteIdentical: true };
}

export async function transplantOriginalBitmaps(targetBytes, sourceBytes, mappings) {
  assert.ok(Array.isArray(mappings) && mappings.length > 0, 'nonempty bitmap mappings required');
  const target = scan(targetBytes), source = scan(sourceBytes), replacements = new Map(), rows = [], targetIds = new Set(), constructorPlans = new Map(), constructorDefaultChanges = [];
  for (const mapping of mappings) {
    const { targetSymbol, sourceSymbol, sourceTagSha256, targetTagSha256, width, height, targetWidth = width, targetHeight = height } = mapping;
    assert.ok(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0, 'positive bitmap dimensions required');
    assert.ok(Number.isInteger(targetWidth) && Number.isInteger(targetHeight) && targetWidth > 0 && targetHeight > 0, 'positive target bitmap dimensions required');
    assert.ok(mapping.dimensionChanges === undefined || typeof mapping.dimensionChanges === 'boolean', 'dimensionChanges must be boolean');
    if (mapping.expectedSourceDefaults !== undefined) assert.ok(Array.isArray(mapping.expectedSourceDefaults) && mapping.expectedSourceDefaults.length === 2 && mapping.expectedSourceDefaults.every(value => Number.isInteger(value) && value > 0), 'expectedSourceDefaults must be two positive ints');
    const before = namedBitmap(target, targetSymbol, targetTagSha256, 'target'), original = namedBitmap(source, sourceSymbol, sourceTagSha256, 'source');
    assert.ok(!targetIds.has(before.id), 'duplicate target bitmap ID: ' + before.id); targetIds.add(before.id);
    const [targetImage, sourceImage] = await Promise.all([decode(target, before), decode(source, original)]);
    assert.equal(targetImage.width, targetWidth, 'target bitmap width mismatch'); assert.equal(targetImage.height, targetHeight, 'target bitmap height mismatch');
    assert.equal(sourceImage.width, width, 'source bitmap width mismatch'); assert.equal(sourceImage.height, height, 'source bitmap height mismatch');
    const dimensionsDiffer = width !== targetWidth || height !== targetHeight; let defaults;
    assert.ok(!dimensionsDiffer || mapping.dimensionChanges === true, 'dimension changes require explicit permission');
    if (mapping.dimensionChanges === true) {
      assert.equal(sourceSymbol, targetSymbol, 'dimension changes require the same BitmapData symbol');
      assert.ok(Array.isArray(mapping.expectedTargetDefaults) && mapping.expectedTargetDefaults.length === 2 && mapping.expectedTargetDefaults.every(value => Number.isInteger(value) && value > 0), 'dimension changes require expectedTargetDefaults as two positive ints');
      const targetWrapper = bitmapWrapper(target, targetSymbol), sourceWrapper = bitmapWrapper(source, sourceSymbol);
      assert.deepEqual(targetWrapper.defaults, mapping.expectedTargetDefaults, 'target constructor defaults changed');
      assert.deepEqual(sourceWrapper.defaults, mapping.expectedSourceDefaults ?? [width, height], 'source constructor defaults differ from expectedSourceDefaults or source bitmap dimensions');
      let plans = constructorPlans.get(targetWrapper.abc); if (!plans) { plans = new Map(); constructorPlans.set(targetWrapper.abc, plans); }
      assert.ok(!plans.has(targetWrapper.instance.ctor), 'duplicate BitmapData constructor edit'); plans.set(targetWrapper.instance.ctor, sourceWrapper.defaults);
      defaults = { targetDefaultsBefore: targetWrapper.defaults, sourceDefaults: sourceWrapper.defaults, targetDefaultsAfter: sourceWrapper.defaults, constructorMethod: targetWrapper.instance.ctor };
    }
    const payload = Buffer.from(original.body); payload.writeUInt16LE(before.id);
    assert.deepEqual(payload.subarray(2), original.body.subarray(2), 'original bitmap payload changed');
    const raw = buildTag(original.tag.code, payload); replacements.set(before.tag, raw);
    rows.push({ targetSymbol, sourceSymbol, targetId: before.id, sourceId: original.id, targetTagCode: before.tag.code, sourceTagCode: original.tag.code,
      outputTagCode: original.tag.code, targetTagSha256, sourceTagSha256, outputTagSha256: hash(raw), width, height, targetWidth, targetHeight,
      sourceRawDimensions: [width, height], targetRawDimensions: [targetWidth, targetHeight], bounds: [0, 0, width, height],
      sourcePayloadSha256: hash(original.body.subarray(2)), outputPayloadSha256: hash(payload.subarray(2)), sourcePayloadExceptIdByteIdentical: true,
      independentlyDecoded: true, jpegTablesUsed: false, dimensionChanges: mapping.dimensionChanges === true, ...defaults });
  }
  for (const [abc, plans] of constructorPlans) {
    const patched = patchConstructorDefaults(abc, plans);
    if (!patched.out.equals(abc.abc)) {
      replacements.set(abc.tag, buildTag(82, Buffer.concat([abc.prefix, patched.out])));
      constructorDefaultChanges.push({ originalAbcSha256: hash(abc.abc), outputAbcSha256: hash(patched.out), changes: patched.changes, appendedIntegers: patched.appendedIntegers, allMethodBodiesByteIdentical: true });
    }
  }
  const out = compressSwf(target.sig, target.version, Buffer.concat([target.headerPrefix, ...target.tags.map(tag => replacements.get(tag) ?? tag.raw), target.trailing]));
  const checked = scan(out); assert.equal(checked.sig, target.sig); assert.equal(checked.version, target.version);
  assert.deepEqual(checked.headerPrefix, target.headerPrefix); assert.deepEqual(checked.trailing, target.trailing); assert.equal(checked.tags.length, target.tags.length);
  let unchangedTags = 0;
  for (let i = 0; i < target.tags.length; i++) {
    assert.deepEqual(checked.tags[i].raw, replacements.get(target.tags[i]) ?? target.tags[i].raw, 'rebuilt bitmap tag differs');
    if (!replacements.has(target.tags[i])) unchangedTags++;
  }
  return { out, metadata: { version: 1, kind: 'original-ui-bitmap-transplant', targetSha256: hash(targetBytes), sourceSha256: hash(sourceBytes), outputSha256: hash(out),
    mappings: rows, changedBitmapIds: rows.map(row => row.targetId), changedBitmapCount: rows.length, totalTags: target.tags.length, unchangedTags,
    allUnselectedTagsByteIdentical: true, headerPrefixByteIdentical: true, trailingByteIdentical: true, sourcePayloadsExceptIdByteIdentical: true,
    constructorDefaultChanges, changedAbcTagCount: constructorDefaultChanges.length, allMethodBodiesByteIdentical: true,
    installed: false, runtimeAccepted: false } };
}
