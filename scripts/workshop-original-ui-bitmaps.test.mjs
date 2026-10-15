import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildTag, compressSwf, decompressSwf, parseTags, encodeU30 } from '../tools/i18n/abc-strings/lib.mjs';
import { parseActivityAbc } from '../tools/i18n/abc-strings/activity-response.mjs';
import { hash } from './workshop-bag-art.mjs';
import { decodeOriginalLossless2, transplantOriginalBitmaps } from './workshop-original-ui-bitmaps.mjs';

const deps = createRequire(join(process.env.WORKSHOP_NODE_DEPS ?? join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node'), 'package.json'));
const { PNG } = deps('pngjs'), { createCanvas } = deps('@napi-rs/canvas');
const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
const symbolTag = rows => buildTag(76, Buffer.concat([u16(rows.length), ...rows.flatMap(([id, name]) => [u16(id), Buffer.from(name + '\0')])]));
const lossless = (id, value, width = 2, height = 2) => buildTag(36, Buffer.concat([u16(id), Buffer.from([5]), u16(width), u16(height), deflateSync(Buffer.alloc(width * height * 4, value))]));
const encoded = (id, code, image, alpha = Buffer.alloc(0)) => {
  const offset = Buffer.alloc(4); offset.writeUInt32LE(image.length);
  return buildTag(code, Buffer.concat([u16(id), ...(code === 35 ? [offset] : []), image, ...(code === 35 ? [deflateSync(alpha)] : [])]));
};
const header = Buffer.from([0, 0, 0, 1, 0]), trailing = Buffer.from('preserved trailing bytes');
// Valid empty ABC, plus nonselected shape/sprite definitions; their bytes must survive exactly.
const abc = buildTag(82, Buffer.concat([Buffer.alloc(4), Buffer.from('empty\0'), Buffer.from([16, 0, 46, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0])]));
const shape = buildTag(2, Buffer.from([91, 0, 0, 0, 0, 0, 0]));
const sprite = buildTag(39, Buffer.concat([u16(92), u16(1), buildTag(1, Buffer.alloc(0)), buildTag(0, Buffer.alloc(0))]));
const swf = (tags, suffix = trailing) => compressSwf('CWS', 10, Buffer.concat([header, ...tags, buildTag(0, Buffer.alloc(0)), suffix]));
const parsed = bytes => { const d = decompressSwf(bytes); return { ...d, ...parseTags(d.body) }; };
const old = lossless(7, 100), donor = lossless(71, 180), untouched = lossless(8, 40);
const target = swf([old, abc, shape, untouched, sprite, symbolTag([[7, 'target.caption'], [8, 'target.other']])]);
const source = swf([symbolTag([[71, 'source.caption']]), shape, donor]);
const mapping = { targetSymbol: 'target.caption', sourceSymbol: 'source.caption', sourceTagSha256: hash(donor), targetTagSha256: hash(old), width: 2, height: 2 };
let cases = 0;

const result = await transplantOriginalBitmaps(target, source, [mapping]), before = parsed(target), after = parsed(result.out);
assert.deepEqual(after.headerPrefix, before.headerPrefix); assert.deepEqual(after.trailing, trailing);
assert.deepEqual(after.body.subarray(after.tags[0].bodyStart, after.tags[0].bodyStart + 2), u16(7));
assert.deepEqual(after.body.subarray(after.tags[0].bodyStart + 2, after.tags[0].bodyEnd), parsed(source).body.subarray(parsed(source).tags[2].bodyStart + 2, parsed(source).tags[2].bodyEnd));
for (let i = 1; i < before.tags.length; i++) assert.deepEqual(after.tags[i].raw, before.tags[i].raw);
assert.equal(result.metadata.unchangedTags, before.tags.length - 1); assert.equal(result.metadata.mappings[0].sourceId, 71);
assert.equal(result.metadata.mappings[0].targetId, 7); assert.equal(result.metadata.sourcePayloadsExceptIdByteIdentical, true); cases++;
// Source definition order, symbol order and unrelated contents cannot select a bitmap by position.
assert.deepEqual((await transplantOriginalBitmaps(target, swf([donor, symbolTag([[71, 'source.caption']]), abc]), [mapping])).out, result.out); cases++;

const reject = async (t, s, rows, pattern) => { await assert.rejects(transplantOriginalBitmaps(t, s, rows), pattern); cases++; };
await reject(target, source, [{ ...mapping, sourceTagSha256: '0'.repeat(64) }], /source bitmap tag changed/);
await reject(target, source, [{ ...mapping, targetTagSha256: '0'.repeat(64) }], /target bitmap tag changed/);
await reject(target, source, [{ ...mapping, width: 3 }], /width mismatch/);
const wide = lossless(71, 180, 3, 2);
await reject(target, swf([wide, symbolTag([[71, 'source.caption']])]), [{ ...mapping, sourceTagSha256: hash(wide) }], /source bitmap width mismatch/);
await reject(target, source, [mapping, mapping], /duplicate target bitmap ID/);
await reject(target, source, [{ ...mapping, sourceSymbol: 'missing' }], /source symbol missing or duplicate/);
await reject(target, source, [{ ...mapping, targetSymbol: 'missing' }], /target symbol missing or duplicate/);
await reject(target, swf([donor, symbolTag([[71, 'source.caption'], [71, 'source.caption']])]), [mapping], /source symbol missing or duplicate/);
await reject(target, swf([donor, donor, symbolTag([[71, 'source.caption']])]), [mapping], /source character definition missing or duplicate/);
await reject(target, swf([symbolTag([[0, 'source.caption']])]), [mapping], /root SymbolClass/);
await reject(swf([old, symbolTag([[0, 'target.caption']])]), source, [mapping], /root SymbolClass/);
const unsupported = buildTag(39, Buffer.concat([u16(71), u16(1), buildTag(0, Buffer.alloc(0))]));
await reject(target, swf([unsupported, symbolTag([[71, 'source.caption']])]), [{ ...mapping, sourceTagSha256: hash(unsupported) }], /unsupported bitmap tag/);
const malformed = Buffer.from(target); malformed.writeUInt32LE(1, 4);
await reject(malformed, source, [mapping], /declared length mismatch/);

// PNG/JPEG2 and JPEG3 retain their original encoded data and alpha when replacing Lossless2.
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.from([1, 2, 3, 3, 10, 20, 30, 255, 0, 0, 0, 0, 90, 80, 70, 128]) });
const canvas = createCanvas(2, 2), ctx = canvas.getContext('2d'); ctx.fillStyle = '#c08030'; ctx.fillRect(0, 0, 2, 2);
const jpeg = canvas.toBuffer('image/jpeg');
for (const [code, image, alpha] of [[21, png, Buffer.alloc(0)], [21, jpeg, Buffer.alloc(0)], [35, png, Buffer.alloc(0)], [35, jpeg, Buffer.from([0, 3, 128, 255])]]) {
  const tag = encoded(71, code, image, alpha), candidate = swf([symbolTag([[71, 'source.caption']]), tag]);
  const transplanted = await transplantOriginalBitmaps(target, candidate, [{ ...mapping, sourceTagSha256: hash(tag) }]), out = parsed(transplanted.out);
  const original = parsed(candidate).tags[1];
  assert.equal(out.tags[0].code, code); assert.deepEqual(out.body.subarray(out.tags[0].bodyStart + 2, out.tags[0].bodyEnd), parsed(candidate).body.subarray(original.bodyStart + 2, original.bodyEnd));
  assert.equal(transplanted.metadata.mappings[0].sourcePayloadSha256, transplanted.metadata.mappings[0].outputPayloadSha256); cases++;
}
const jpegTag = encoded(71, 21, jpeg);
const independentJpeg = await transplantOriginalBitmaps(target, swf([buildTag(8, Buffer.from('unusable unrelated tables')), jpegTag, symbolTag([[71, 'source.caption']])]), [{ ...mapping, sourceTagSha256: hash(jpegTag) }]);
assert.equal(independentJpeg.metadata.mappings[0].jpegTablesUsed, false); cases++;
const noHuffmanParts = [jpeg.subarray(0, 2)]; let jpegAt = 2;
while (jpegAt < jpeg.length) {
  const start = jpegAt; assert.equal(jpeg[jpegAt++], 255); const marker = jpeg[jpegAt++], length = jpeg.readUInt16BE(jpegAt); jpegAt += length;
  if (marker !== 196) noHuffmanParts.push(jpeg.subarray(start, jpegAt));
  if (marker === 218) { noHuffmanParts.push(jpeg.subarray(jpegAt)); break; }
}
const abbreviatedJpeg = encoded(71, 21, Buffer.concat(noHuffmanParts));
await reject(target, swf([buildTag(8, jpeg), abbreviatedJpeg, symbolTag([[71, 'source.caption']])]), [{ ...mapping, sourceTagSha256: hash(abbreviatedJpeg) }], /requires standalone/);
const badEncoded = encoded(71, 21, Buffer.from('not JPEG or PNG'));
await reject(target, swf([badEncoded, symbolTag([[71, 'source.caption']])]), [{ ...mapping, sourceTagSha256: hash(badEncoded) }], /must contain JPEG/);
assert.equal(hash(target), hash(swf([old, abc, shape, untouched, sprite, symbolTag([[7, 'target.caption'], [8, 'target.other']])])));

// Palette entries are premultiplied RGBA; rows have four-byte index alignment.
const paletteBody = Buffer.concat([u16(71), Buffer.from([3]), u16(2), u16(2), Buffer.from([2]),
  deflateSync(Buffer.from([64, 32, 16, 128, 9, 8, 7, 0, 1, 2, 3, 255, 0, 1, 255, 255, 2, 0, 255, 255]))]);
const palette = buildTag(36, paletteBody), paletteImage = decodeOriginalLossless2(paletteBody);
assert.deepEqual(paletteImage.rgba, Buffer.from([128, 64, 32, 128, 0, 0, 0, 0, 1, 2, 3, 255, 128, 64, 32, 128]));
assert.deepEqual(paletteImage.raw, Buffer.from([128, 64, 32, 16, 0, 9, 8, 7, 255, 1, 2, 3, 128, 64, 32, 16]));
const paletteTransfer = await transplantOriginalBitmaps(target, swf([palette, symbolTag([[71, 'source.caption']])]), [{ ...mapping, sourceTagSha256: hash(palette) }]);
assert.deepEqual(parsed(paletteTransfer.out).body.subarray(parsed(paletteTransfer.out).tags[0].bodyStart + 2, parsed(paletteTransfer.out).tags[0].bodyEnd), paletteBody.subarray(2)); cases++;
const badPalette = Buffer.concat([paletteBody.subarray(0, 8), deflateSync(Buffer.from([64, 32, 16, 128, 9, 8, 7, 0, 1, 2, 3, 255, 3, 1, 0, 0, 2, 0, 0, 0]))]);
assert.throws(() => decodeOriginalLossless2(badPalette), /palette index outside/); cases++;

function wrappers(defaults, { code = 'd030d0d1d2490247', traits = false, param = 1, padding = 0 } = {}) {
  const u = encodeU30, cat = (...parts) => Buffer.concat(parts), byte = n => Buffer.from([n]);
  const strings = ['', 'int', 'asset.test', 'Caption', 'Other', 'flash.display', 'BitmapData'];
  const integers = [...defaults, 77, 88, ...Array(padding).fill(99)];
  const emptyMethod = cat(u(0), u(0), u(0), byte(0));
  const ctor = indices => cat(u(2), u(0), u(param), u(param), u(0), byte(8), u(2), ...indices.map(index => cat(u(index), byte(3))));
  const instance = (name, init, business) => cat(u(name), u(3), byte(1), u(0), u(init), ...(business ? [u(1), u(1), byte(0), u(0), u(1), u(0)] : [u(0)]));
  const body = (method, hex) => { const bytes = Buffer.from(hex, 'hex'); return cat(u(method), u(3), u(3), u(0), u(1), u(bytes.length), bytes, u(0), u(0)); };
  return buildTag(82, cat(Buffer.alloc(4), Buffer.from('wrappers\0'), Buffer.from([16, 0, 46, 0]),
    u(integers.length + 1), ...integers.map(u), u(1), u(1),
    u(strings.length), ...strings.slice(1).map(s => cat(u(Buffer.byteLength(s)), Buffer.from(s))),
    u(4), byte(22), u(0), byte(22), u(2), byte(22), u(5), u(1),
    u(5), byte(7), u(1), u(1), byte(7), u(2), u(3), byte(7), u(3), u(6), byte(7), u(2), u(4),
    u(5), emptyMethod, ctor([1, 2]), emptyMethod, emptyMethod, ctor([3, 4]), u(0),
    u(2), instance(2, 1, traits), instance(4, 4, false), u(0), u(0), u(3), u(0),
    u(1), u(2), u(2), u(2), byte(4), u(1), u(0), u(4), byte(4), u(2), u(1),
    u(5), body(0, 'd03047'), body(1, code), body(2, 'd03047'), body(3, 'd03047'), body(4, 'd030d0d1d2490247')));
}
const abcBytes = raw => { const s = parsed(swf([raw])), t = s.tags[0], b = s.body.subarray(t.bodyStart, t.bodyEnd); return b.subarray(b.indexOf(0, 4) + 1); };
const newBitmap = lossless(71, 180, 3, 4), targetWrappers = wrappers([133, 15], { padding: 124 }), sourceWrappers = wrappers([3, 4]);
const sizedTarget = swf([old, targetWrappers, symbolTag([[7, 'asset.test.Caption']]), shape, sprite]);
const sizedSource = (wrap = sourceWrappers) => swf([wrap, symbolTag([[71, 'asset.test.Caption']]), newBitmap]);
const sizedMapping = { targetSymbol: 'asset.test.Caption', sourceSymbol: 'asset.test.Caption', sourceTagSha256: hash(newBitmap), targetTagSha256: hash(old), width: 3, height: 4,
  targetWidth: 2, targetHeight: 2, dimensionChanges: true, expectedTargetDefaults: [133, 15] };
const sized = await transplantOriginalBitmaps(sizedTarget, sizedSource(), [sizedMapping]);
assert.equal(sized.metadata.changedAbcTagCount, 1); assert.deepEqual(sized.metadata.mappings[0].targetDefaultsBefore, [133, 15]);
assert.deepEqual(sized.metadata.mappings[0].targetDefaultsAfter, [3, 4]); assert.deepEqual(sized.metadata.constructorDefaultChanges[0].appendedIntegers, [3, 4]);
const oldAbc = parseActivityAbc(abcBytes(targetWrappers)), newAbc = parseActivityAbc(abcBytes(parsed(sized.out).tags[1].raw));
assert.deepEqual(newAbc.bodies.map(body => body.code), oldAbc.bodies.map(body => body.code));
assert.equal(sized.metadata.allMethodBodiesByteIdentical, true); cases++;
await reject(sizedTarget, sizedSource(), [{ ...sizedMapping, dimensionChanges: false }], /explicit permission/);
await reject(sizedTarget, sizedSource(), [{ ...sizedMapping, expectedTargetDefaults: undefined }], /expectedTargetDefaults/);
await reject(sizedTarget, sizedSource(), [{ ...sizedMapping, expectedTargetDefaults: [2, 2] }], /target constructor defaults changed/);
await reject(sizedTarget, sizedSource(wrappers([4, 4])), [sizedMapping], /source constructor defaults differ/);
const sourceDefaultPin = { ...sizedMapping, expectedSourceDefaults: [4, 4] };
const preservedDefaults = await transplantOriginalBitmaps(sizedTarget, sizedSource(wrappers([4, 4])), [sourceDefaultPin]);
assert.deepEqual(preservedDefaults.metadata.mappings[0].sourceRawDimensions, [3, 4]);
assert.deepEqual(preservedDefaults.metadata.mappings[0].sourceDefaults, [4, 4]);
assert.deepEqual(preservedDefaults.metadata.mappings[0].targetDefaultsAfter, [4, 4]); cases++;
await reject(sizedTarget, sizedSource(), [sourceDefaultPin], /source constructor defaults differ/);
await reject(sizedTarget, sizedSource(), [{ ...sourceDefaultPin, expectedSourceDefaults: [0, 4] }], /expectedSourceDefaults must be two positive ints/);
await reject(sizedTarget, sizedSource(wrappers([3, 4], { code: 'd03047' })), [sizedMapping], /only forward super/);
await reject(sizedTarget, sizedSource(wrappers([3, 4], { traits: true })), [sizedMapping], /instance traits/);
await reject(sizedTarget, sizedSource(wrappers([3, 4], { param: 3 })), [sizedMapping], /take two ints/);

// Optional local originals exercise every currently inventoried tip mapping without writing artifacts.
const project = resolve(import.meta.dirname, '../../..'), fixture = join(project, 'runtime/reference-original-bag-tip-ui-20261015');
const constructorReport = join(fixture, 'tooltip-constructor-mapping.json'), originalFile = join(fixture, 'public-inputs/coreiconandtip_v3_6_1_u3.swf');
let realFixtureCases = 0;
if (existsSync(constructorReport) && existsSync(originalFile)) {
  const inventory = JSON.parse(readFileSync(constructorReport)), originalBytes = readFileSync(originalFile);
  for (const name of ['coreiconandtip', 'coreiconandtip1']) {
    const input = readFileSync(resolve(import.meta.dirname, '../apps/api/assets/flash/ui/vietnam/swf', name + '.swf'));
    const rows = inventory.filter(row => row.targetModule === name).map(row => ({ targetSymbol: row.targetSymbol.name, sourceSymbol: row.referenceSymbol.name,
      sourceTagSha256: row.referenceSymbol.tagSha256, targetTagSha256: row.targetSymbol.tagSha256, ...row.referenceSymbol.dimensions,
      targetWidth: row.targetSymbol.dimensions.width, targetHeight: row.targetSymbol.dimensions.height, dimensionChanges: true, expectedTargetDefaults: row.targetWrapper.defaults }));
    assert.ok(rows.length > 0); const actual = await transplantOriginalBitmaps(input, originalBytes, rows);
    assert.equal(actual.metadata.changedBitmapCount, rows.length); assert.equal(actual.metadata.allMethodBodiesByteIdentical, true); realFixtureCases++; cases++;
  }
}
const questFixture = join(project, 'runtime/reference-original-quest-ui-20261015'), questReport = join(questFixture, 'all-original-bitmap-mapping.json');
if (existsSync(questReport)) {
  const inventory = JSON.parse(readFileSync(questReport));
  const rows = inventory.bitmaps.map(row => ({ targetSymbol: row.className, sourceSymbol: row.className, sourceTagSha256: row.sourceTagSha256, targetTagSha256: row.targetTagSha256,
    width: row.sourceWidth, height: row.sourceHeight, targetWidth: row.targetWidth, targetHeight: row.targetHeight, dimensionChanges: true,
    expectedTargetDefaults: [row.constructorTargetDefaults.width, row.constructorTargetDefaults.height],
    expectedSourceDefaults: [row.constructorSourceDefaults.width, row.constructorSourceDefaults.height] }));
  const actual = await transplantOriginalBitmaps(readFileSync(resolve(import.meta.dirname, '../apps/api/assets/flash/ui/vietnam/swf/quest.swf')),
    readFileSync(join(questFixture, 'quest_v3_6_1_u1.swf')), rows);
  assert.equal(rows.length, 96); assert.equal(actual.metadata.changedBitmapCount, 96); assert.equal(actual.metadata.allMethodBodiesByteIdentical, true);
  assert.equal(actual.metadata.mappings.filter(row => row.sourceDefaults.some((value, i) => value !== row.sourceRawDimensions[i])).length, 4); realFixtureCases++; cases++;
}
console.log(JSON.stringify({ passed: true, cases, realFixtureCases, offline: true, network: false, installed: false }));
