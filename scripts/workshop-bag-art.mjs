#!/usr/bin/env node
// Replaces reviewed bitmap captions in the deployment overlay; preserves the original skin and every other SWF tag.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, deflateSync } from 'node:zlib';
import { ByteReader, decompressSwf, parseTags, buildTag, compressSwf } from '../tools/i18n/abc-strings/lib.mjs';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function preparedPixels(bytes, entry, decode) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'prepared caption must be PNG');
  assert.equal(hash(bytes), entry.preparedImage.sha256, 'prepared caption PNG hash mismatch');
  const image = decode(bytes);
  assert.equal(image.width, entry.width, 'prepared caption width mismatch'); assert.equal(image.height, entry.height, 'prepared caption height mismatch');
  assert.equal(image.data.length, entry.width * entry.height * 4, 'prepared caption pixel count mismatch');
  return Buffer.from(image.data);
}
export function decodeBitmap(bytes) {
  assert.ok(bytes.length >= 7 && bytes[2] === 5, 'requires 32-bit DefineBitsLossless2');
  const id = bytes.readUInt16LE(0), width = bytes.readUInt16LE(3), height = bytes.readUInt16LE(5);
  const raw = inflateSync(bytes.subarray(7));
  assert.equal(raw.length, width * height * 4, 'invalid ARGB pixel count');
  const rgba = Buffer.alloc(raw.length);
  for (let p = 0; p < raw.length; p += 4) {
    const a = raw[p]; rgba[p + 3] = a;
    for (let c = 0; c < 3; c++) rgba[p + c] = a ? Math.min(255, Math.round(raw[p + c + 1] * 255 / a)) : 0;
  }
  return { id, width, height, raw, rgba, prefix: bytes.subarray(0, 7) };
}
export function encodeBitmap(bitmap, rgba) {
  assert.equal(rgba.length, bitmap.raw.length);
  const raw = Buffer.from(bitmap.raw);
  // Preserve original premultiplied bytes for every unchanged pixel; unpremultiplication is otherwise lossy.
  for (let p = 0; p < raw.length; p += 4) {
    if (rgba.subarray(p, p + 4).equals(bitmap.rgba.subarray(p, p + 4))) continue;
    const a = rgba[p + 3]; raw[p] = a;
    for (let c = 0; c < 3; c++) raw[p + c + 1] = Math.round(rgba[p + c] * a / 255);
  }
  return Buffer.concat([bitmap.prefix, deflateSync(raw, { level: 9 })]);
}
// The reviewed RoomList caption is PNG with internal alpha inside DefineBitsJPEG3.
// Keep this separate from premultiplied Lossless2; JPEG/external-alpha inputs are not accepted.
export function decodePngBitmap(bytes, decode) {
  assert.ok(bytes.length >= 14, 'truncated PNG tag35 bitmap');
  const id = bytes.readUInt16LE(0), length = bytes.readUInt32LE(2);
  assert.ok(length >= 8 && length <= bytes.length - 6, 'invalid PNG tag35 alpha offset');
  const encoded = bytes.subarray(6, 6 + length), auxiliary = bytes.subarray(6 + length);
  assert.ok(encoded.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'tag35 caption must contain PNG');
  assert.equal(auxiliary.length ? inflateSync(auxiliary).length : 0, 0, 'PNG tag35 must use internal alpha');
  const { width, height, data } = decode(encoded), rgba = Buffer.from(data);
  assert.ok(width > 0 && height > 0 && rgba.length === width * height * 4, 'invalid PNG tag35 pixel count');
  return { id, width, height, rgba, raw: rgba };
}
function encodePngBitmap(image, rgba, encode) {
  assert.equal(rgba.length, image.width * image.height * 4);
  const encoded = encode({ width: image.width, height: image.height, data: rgba }), prefix = Buffer.alloc(6);
  prefix.writeUInt16LE(image.id); prefix.writeUInt32LE(encoded.length, 2);
  return Buffer.concat([prefix, encoded, deflateSync(Buffer.alloc(0))]);
}

// Only these reviewed RoomList JPEG owners may use the prepared PNG conversion.
const ROOMLIST_JPEG = new Map([
  [1, [35, 'asset.roomList.Create', '0e5abf89df6b89660c00b729cc62e1c6499e2d54f0afbae17f39b47a105a3d47']],
  [17, [35, 'asset.roomList.rivalship', 'de11b96102f86b992e6a606ca9ffc65ee0af9f186ee76ce41ccd70c94ab1aaeb']],
  [23, [21, 'asset.roomList.playerListBg_02', '5757a5f27c489123abf95ebe6726ffba35cf7a2c48231d8d9a75ca5161daa822']],
  [31, [35, 'asset.DungeonList.next_PVE', '99fcfb3e87789b899e5e0790aed1ac21d63a5c9300da7ea75ad1cb71b1ce8fd1']],
  [36, [35, 'asset.DungeonList.model_PVE', '2cd9eff6f2ece5553baf5c5f05d2fcfb9fcc092d49a716d8328a54667cc724d9']],
  [45, [35, 'asset.roomList.lookup', '4f5b7df314b491152292c1e1091c91aabf96dbbc61a45d5358199b0d86ce5a39']],
  [72, [21, 'asset.DungeonList.DungeonListBG', 'a8fe209087621be8b58136ae322a6292b57c12d85550de1755693891645c4154']],
]);
function reviewedRoomlistJpeg(entry, config, tagCode) {
  if (entry.inputFormat === undefined) return false;
  const expected = ROOMLIST_JPEG.get(entry.id);
  assert.ok(config.asset === 'ui/vietnam/swf/roomlist.swf' && expected && tagCode === expected[0] && entry.className === expected[1] && entry.sourceTagSha256 === expected[2], 'unsupported reviewed RoomList JPEG owner');
  assert.equal(entry.inputFormat, tagCode === 21 ? 'jpeg2' : 'jpeg3-external-alpha', 'invalid reviewed JPEG format');
  assert.ok(entry.preparedImage, 'reviewed JPEG needs a prepared PNG');
  return true;
}
export function jpegBitmapData(body, tagCode) {
  assert.ok(tagCode === 21 || tagCode === 35, 'unsupported JPEG tag');
  assert.ok(body.length >= (tagCode === 35 ? 10 : 6), 'truncated JPEG bitmap');
  const length = tagCode === 35 ? body.readUInt32LE(2) : body.length - 2, start = tagCode === 35 ? 6 : 2;
  assert.ok(length >= 4 && start + length <= body.length, 'invalid JPEG alpha offset');
  let encoded = body.subarray(start, start + length);
  if (encoded.subarray(0, 4).equals(Buffer.from('ffd9ffd8', 'hex'))) encoded = encoded.subarray(2);
  assert.ok(encoded.subarray(0, 2).equals(Buffer.from('ffd8', 'hex')) && encoded.subarray(-2).equals(Buffer.from('ffd9', 'hex')), 'reviewed input must contain JPEG');
  return { id: body.readUInt16LE(0), encoded, auxiliary: tagCode === 35 ? body.subarray(start + length) : null };
}
function decodeReviewedJpeg(body, tagCode, readJPEG) {
  const { id, encoded, auxiliary } = jpegBitmapData(body, tagCode), decoded = readJPEG(encoded), { width, height } = decoded;
  const rgba = Buffer.from(decoded.data);
  assert.ok(width > 0 && height > 0 && rgba.length === width * height * 4, 'invalid decoded JPEG pixels');
  const alpha = auxiliary === null ? null : inflateSync(auxiliary);
  if (alpha) assert.equal(alpha.length, width * height, 'invalid external JPEG alpha');
  for (let p = 0; p < width * height; p++) rgba[p * 4 + 3] = alpha ? alpha[p] : 255;
  return { id, width, height, raw: rgba, rgba };
}
export function decodePngTag21(body, decode) {
  assert.ok(body.subarray(2, 10).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'tag21 caption must contain PNG');
  const { width, height, data } = decode(body.subarray(2)), rgba = Buffer.from(data);
  assert.ok(width > 0 && height > 0 && rgba.length === width * height * 4, 'invalid PNG tag21 pixels');
  return { id: body.readUInt16LE(0), width, height, raw: rgba, rgba };
}
function encodePngTag21(image, rgba, encode) {
  const prefix = Buffer.alloc(2); prefix.writeUInt16LE(image.id);
  return Buffer.concat([prefix, encode({ width: image.width, height: image.height, data: rgba })]);
}
async function preloadRoomlistJpeg(bytes, config, loadImage, createCanvas) {
  if (!config.bitmaps.some(entry => entry.inputFormat !== undefined)) return undefined;
  const decoded = decompressSwf(bytes), parsed = parseTags(decoded.body), cache = new Map();
  for (const entry of config.bitmaps) {
    const tagCode = entry.tagCode ?? 36;
    if (!reviewedRoomlistJpeg(entry, config, tagCode)) continue;
    const tags = parsed.tags.filter(tag => tag.code === tagCode && decoded.body.readUInt16LE(tag.bodyStart) === entry.id);
    assert.equal(tags.length, 1, 'missing reviewed JPEG target');
    assert.equal(hash(tags[0].raw), entry.sourceTagSha256, 'reviewed JPEG tag changed; preserved');
    const { encoded } = jpegBitmapData(decoded.body.subarray(tags[0].bodyStart, tags[0].bodyEnd), tagCode);
    // loadImage is asynchronous; assigning Image.src and immediately drawing loses the JPEG pixels.
    const image = await loadImage(encoded), canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0); cache.set(hash(encoded), { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data });
  }
  return encoded => { const decoded = cache.get(hash(encoded)); assert.ok(decoded, 'JPEG was not preloaded'); return decoded; };
}

function inside(x, y, [left, top, width, height]) { return x >= left && y >= top && x < left + width && y < top + height; }
function inpaintCaption(image, rgba, box, seedRange) {
  const [left, top, width, height] = box, seed = new Set(), mask = new Set();
  const min = seedRange?.min ?? [185, 175, 120], max = seedRange?.max ?? [255, 255, 255];
  // Default reviewed buttons use pale glyphs; chat supplies its reviewed gold/black seed range.
  // Remove the glyph and its short dark outline,
  // while leaving the surrounding brick/grain pixels available for a local texture fill.
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    const p = (y * image.width + x) * 4;
    if (image.rgba[p + 3] >= 240 && min.every((v, c) => image.rgba[p + c] >= v && image.rgba[p + c] <= max[c])) seed.add(y * image.width + x);
  }
  for (const p of seed) {
    const x = p % image.width, y = Math.floor(p / image.width);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (inside(xx, yy, box) && image.rgba[(yy * image.width + xx) * 4 + 3] >= 240) mask.add(yy * image.width + xx);
    }
  }
  assert.ok(mask.size > 0, 'reviewed button caption has no pale glyphs');
  for (const p of mask) {
    const x = p % image.width, y = Math.floor(p / image.width), neighbours = [];
    // Narrow chat tabs have their gold frame immediately beside the glyphs; sample the reviewed
    // interior above/below them instead of smearing the frame into the black or gold button skin.
    if (seedRange) for (const step of [-1, 1]) {
      for (let yy = y + step; yy >= top && yy < top + height; yy += step) {
        const q = yy * image.width + x;
        if (!mask.has(q) && image.rgba[q * 4 + 3] >= 240) { neighbours.push({ p: q * 4, distance: Math.abs(yy - y) }); break; }
      }
    }
    else for (const step of [-1, 1]) {
      for (let xx = x + step; xx >= 0 && xx < image.width; xx += step) {
        const q = y * image.width + xx;
        if (!mask.has(q) && image.rgba[q * 4 + 3] >= 240) { neighbours.push({ p: q * 4, distance: Math.abs(xx - x) }); break; }
      }
    }
    if (!neighbours.length) for (const step of [-1, 1]) {
      for (let yy = y + step; yy >= 0 && yy < image.height; yy += step) {
        const q = yy * image.width + x;
        if (!mask.has(q) && image.rgba[q * 4 + 3] >= 240) { neighbours.push({ p: q * 4, distance: Math.abs(yy - y) }); break; }
      }
    }
    assert.ok(neighbours.length, 'caption texture cannot be reconstructed from surrounding pixels');
    const weight = neighbours.reduce((n, q) => n + 1 / q.distance, 0);
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(neighbours.reduce((n, q) => n + image.rgba[q.p + c] / q.distance, 0) / weight);
  }
}
function validateBackground(bytes, entry) {
  assert.ok(entry && entry.tagCode === 21 && Number.isInteger(entry.id), 'background needs reviewed tag21 metadata');
  assert.ok(Buffer.isBuffer(bytes) && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'background must be encoded PNG');
  assert.equal(hash(bytes), entry.pngSha256, 'background PNG hash mismatch');
  const depRoot = process.env.WORKSHOP_NODE_DEPS ?? join(process.env.USERPROFILE ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node');
  const { PNG } = createRequire(join(depRoot, 'package.json'))('pngjs'), image = PNG.sync.read(bytes);
  assert.equal(image.width, entry.width, 'background width mismatch'); assert.equal(image.height, entry.height, 'background height mismatch');
  return { enabled: true, id: entry.id, tagCode: entry.tagCode, width: image.width, height: image.height,
    pngSha256: hash(bytes), sourceTagSha256: entry.sourceTagSha256, referenceSwfSha256: entry.referenceSwfSha256 };
}
export function patchSwf(bytes, config, render, backgroundBytes = null, pngCodec = null) {
  const decoded = decompressSwf(bytes); assert.equal(decoded.error, null);
  assert.equal(bytes.readUInt32LE(4), decoded.body.length + 8, 'SWF declared length mismatch');
  const parsed = parseTags(decoded.body), ids = new Set(), changed = [], replacements = new Map(), symbols = new Map();
  const background = backgroundBytes === null ? { enabled: false } : validateBackground(backgroundBytes, config.background);
  for (const tag of parsed.tags.filter(tag => tag.code === 76)) {
    const r = new ByteReader(decoded.body.subarray(tag.bodyStart, tag.bodyEnd)), n = r.u16();
    for (let i = 0; i < n; i++) { const id = r.u16(); symbols.set(id, r.cstring()); }
  }
  for (const entry of config.bitmaps) {
    assert.ok(!ids.has(entry.id), 'duplicate configured bitmap'); ids.add(entry.id);
    const tagCode = entry.tagCode ?? 36;
    const jpeg = reviewedRoomlistJpeg(entry, config, tagCode);
    assert.ok(tagCode === 36 || tagCode === 35 || jpeg, 'unsupported caption bitmap tag');
    if (jpeg) {
      assert.ok(pngCodec?.readJPEG && decoded.version >= 8, 'reviewed JPEG conversion needs SWF8+ and awaited decoder');
      assert.equal(hash(bytes), config.sourceAssetSha256, 'unknown reviewed JPEG SWF input; preserved');
      assert.match(config.expectedSwfSha256 ?? '', /^[a-f0-9]{64}$/, 'reviewed JPEG needs a frozen output hash');
    }
    if (tagCode === 35) {
      assert.ok(entry.preparedImage && entry.className && pngCodec, 'PNG tag35 needs a reviewed prepared caption, class and codec');
      assert.ok(decoded.version >= 8, 'PNG tag35 requires SWF8+');
      assert.equal(hash(bytes), config.sourceAssetSha256, 'unknown PNG tag35 SWF input; preserved');
      assert.match(config.expectedSwfSha256 ?? '', /^[a-f0-9]{64}$/, 'PNG tag35 needs a frozen output hash');
    }
    const matches = parsed.tags.filter(tag => tag.code === tagCode && decoded.body.readUInt16LE(tag.bodyStart) === entry.id);
    assert.equal(matches.length, 1, 'missing or duplicate target bitmap: ' + entry.id);
    if (entry.className !== undefined) assert.equal(symbols.get(entry.id), entry.className, 'bitmap class mismatch');
    else {
      const owner = entry.ownerSymbolClass;
      assert.ok(owner && Number.isInteger(owner.id) && typeof owner.name === 'string', 'unlinked bitmap needs its reviewed owner');
      assert.equal(symbols.get(owner.id), owner.name, 'bitmap owner class mismatch');
      assert.equal(parsed.tags.filter(tag => tag.code === 39 && decoded.body.readUInt16LE(tag.bodyStart) === owner.id).length, 1, 'missing bitmap owner sprite');
    }
    const tag = matches[0], decode = jpeg ? body => decodeReviewedJpeg(body, tagCode, pngCodec.readJPEG) : tagCode === 35 ? body => decodePngBitmap(body, pngCodec.read) : decodeBitmap;
    if (tagCode === 35 || jpeg) assert.equal(hash(tag.raw), entry.sourceTagSha256, 'target PNG tag35 changed; preserved');
    const image = decode(decoded.body.subarray(tag.bodyStart, tag.bodyEnd));
    assert.equal(image.width, entry.width); assert.equal(image.height, entry.height);
    assert.equal(hash(image.raw), entry.sourcePixelsSha256, 'target bitmap changed; preserve newer work: ' + entry.id);
    for (const region of entry.regions) {
      const [x, y, w, h] = region.box; assert.ok([x, y, w, h].every(Number.isInteger));
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= image.width && y + h <= image.height, 'caption outside bitmap');
      assert.ok(typeof region.text === 'string' && region.text.length > 0 && !/[\r\n]/.test(region.text));
      assert.ok(Number.isFinite(region.textOffsetY ?? 0) && Math.abs(region.textOffsetY ?? 0) <= h / 2, 'invalid caption vertical offset');
      assert.ok(Number.isFinite(region.textOffsetX ?? 0) && Math.abs(region.textOffsetX ?? 0) <= w / 2, 'invalid caption horizontal offset');
      if (region.textOffsetX) assert.ok(region.inkMargin >= 1, 'offset caption needs an ink margin');
      if (region.inkMargin !== undefined) assert.ok(Number.isInteger(region.inkMargin) && region.inkMargin >= 1 && region.inkMargin * 2 < Math.min(w, h), 'invalid caption ink margin');
      assert.equal(Boolean(region.sample), !region.transparent, 'caption needs a sampled texture or transparent background');
      if (region.clearBoxes !== undefined) {
        assert.ok(region.transparent && !region.inpaint && Array.isArray(region.clearBoxes) && region.clearBoxes.length > 0, 'caption clear boxes require transparent replacement');
        for (const box of region.clearBoxes) assert.ok(Array.isArray(box) && box.length === 4 && box.every(Number.isInteger) && box[2] > 0 && box[3] > 0 && inside(box[0], box[1], region.box) && inside(box[0] + box[2] - 1, box[1] + box[3] - 1, region.box), 'caption clear box outside reviewed region');
      }
      if (region.hideWhenBackgroundEnabled !== undefined) {
        assert.equal(typeof region.hideWhenBackgroundEnabled, 'boolean', 'invalid background caption option');
        if (region.hideWhenBackgroundEnabled) assert.ok(region.transparent && !region.preserveAlpha && !region.inpaint, 'background duplicate caption must allow transparent clearing');
      }
      if (region.sample) { const [sx, sy, sw, sh] = region.sample; assert.ok([sx, sy, sw, sh].every(Number.isInteger)); assert.ok(sx >= 0 && sy >= 0 && sw > 0 && sh > 0 && sx + sw <= image.width && sy + sh <= image.height); }
      if (region.inpaintSeed) {
        const { min, max } = region.inpaintSeed;
        assert.ok(region.inpaint && Array.isArray(min) && Array.isArray(max) && min.length === 3 && max.length === 3 && min.every((v, c) => Number.isInteger(v) && Number.isInteger(max[c]) && v >= 0 && v <= max[c] && max[c] <= 255), 'invalid caption seed range');
      }
    }
    const hiddenRegions = background.enabled ? entry.regions.filter(region => region.hideWhenBackgroundEnabled) : [];
    const drawnRegions = entry.regions.filter(region => !hiddenRegions.includes(region));
    const rgba = render(image, hiddenRegions.length ? { ...entry, regions: drawnRegions } : entry);
    for (const region of hiddenRegions) {
      const [x, y, w, h] = region.box;
      for (let yy = y; yy < y + h; yy++) rgba.fill(0, (yy * image.width + x) * 4, (yy * image.width + x + w) * 4);
    }
    const encoded = tagCode === 21 ? encodePngTag21(image, rgba, pngCodec.write) : tagCode === 35 ? encodePngBitmap(image, rgba, pngCodec.write) : encodeBitmap(image, rgba);
    const patched = jpeg ? (tagCode === 21 ? decodePngTag21(encoded, pngCodec.read) : decodePngBitmap(encoded, pngCodec.read)) : decode(encoded);
    let changedPixels = 0, alphaChangedPixels = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const p = (y * image.width + x) * 4;
      if (!patched.raw.subarray(p, p + 4).equals(image.raw.subarray(p, p + 4))) {
        assert.ok(entry.regions.some(region => inside(x, y, region.box)), 'unreviewed pixels changed'); changedPixels++;
        const alpha = p + (tagCode === 35 || jpeg ? 3 : 0);
        if (patched.raw[alpha] !== image.raw[alpha]) {
          assert.ok((tagCode === 36 || (jpeg && [1, 17, 45].includes(entry.id))) && entry.regions.some(region => inside(x, y, region.box) && !region.preserveAlpha), 'caption changed protected alpha'); alphaChangedPixels++;
        }
      }
    }
    assert.ok(changedPixels > 0, 'caption patch was a no-op');
    replacements.set(tag, buildTag(tagCode, encoded));
    changed.push({ id: entry.id, className: entry.className, width: image.width, height: image.height,
      regions: entry.regions.length, changedPixels, alphaChangedPixels, outsideRegionsUnchanged: true,
      drawnRegions: drawnRegions.length, clearedRegions: hiddenRegions.map(region => ({ id: entry.id, text: region.text, box: region.box, action: 'clear-background-duplicate' })),
      sourcePixelsSha256: hash(image.raw), pixelsSha256: hash(patched.raw) });
  }
  if (background.enabled) {
    assert.ok(!ids.has(background.id), 'background conflicts with a caption bitmap');
    const matches = parsed.tags.filter(tag => tag.code === 21 && decoded.body.readUInt16LE(tag.bodyStart) === background.id);
    assert.equal(matches.length, 1, 'missing or duplicate background bitmap');
    const tag = matches[0]; assert.equal(hash(tag.raw), background.sourceTagSha256, 'background source tag changed; preserve newer work');
    replacements.set(tag, buildTag(21, Buffer.concat([decoded.body.subarray(tag.bodyStart, tag.bodyStart + 2), backgroundBytes])));
    changed.push({ ...background, kind: 'background' });
  }
  const out = compressSwf(decoded.sig, decoded.version, Buffer.concat([parsed.headerPrefix, ...parsed.tags.map(tag => replacements.get(tag) ?? tag.raw), parsed.trailing]));
  if (config.expectedSwfSha256) assert.equal(hash(out), config.expectedSwfSha256, 'rebuilt SWF differs from frozen candidate');
  const after = decompressSwf(out), afterTags = parseTags(after.body);
  assert.equal(after.error, null); assert.equal(after.sig, decoded.sig); assert.equal(after.version, decoded.version);
  assert.deepEqual(afterTags.headerPrefix, parsed.headerPrefix); assert.deepEqual(afterTags.trailing, parsed.trailing);
  assert.equal(afterTags.tags.length, parsed.tags.length);
  let unchangedTags = 0;
  for (let i = 0; i < parsed.tags.length; i++) {
    assert.equal(afterTags.tags[i].code, parsed.tags[i].code);
    if (!replacements.has(parsed.tags[i])) { assert.deepEqual(afterTags.tags[i].raw, parsed.tags[i].raw); unchangedTags++; }
  }
  if (background.enabled) {
    const tag = afterTags.tags.find(tag => tag.code === 21 && after.body.readUInt16LE(tag.bodyStart) === background.id);
    assert.deepEqual(after.body.subarray(tag.bodyStart + 2, tag.bodyEnd), backgroundBytes, 'packaged background PNG changed');
  }
  return { out, changed, background, unchangedTags, totalTags: parsed.tags.length };
}

async function main() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), runtime = resolve(repo, '../../runtime');
  const command = process.argv[2] ?? 'verify'; assert.ok(['verify', 'install', 'rollback'].includes(command), 'usage: workshop-bag-art.mjs verify|install|rollback');
  const flags = process.argv.slice(3), assetFlags = flags.filter(flag => ['--asset=hidden-controls', '--asset=hall', '--asset=chat', '--asset=hall-feature', '--asset=gameover', '--asset=email', '--roomlist', '--room'].includes(flag)), backgroundFlags = flags.filter(flag => flag.startsWith('--background='));
  assert.ok(assetFlags.length <= 1 && backgroundFlags.length <= 1 && flags.length === assetFlags.length + backgroundFlags.length, 'unknown or duplicate bag art option');
  const hiddenControls = flags.includes('--asset=hidden-controls'), hall = flags.includes('--asset=hall'), chat = flags.includes('--asset=chat'), hallFeature = flags.includes('--asset=hall-feature'), gameover = flags.includes('--asset=gameover'), email = flags.includes('--asset=email'), roomlist = flags.includes('--roomlist'), room = flags.includes('--room');
  assert.ok(backgroundFlags.length === 0 || (hall && command !== 'rollback' && backgroundFlags[0].length > '--background='.length), 'background requires --asset=hall for verify or install');
  const name = room ? 'room' : roomlist ? 'roomlist' : gameover ? 'gameover' : hallFeature ? 'ddthallicon' : chat ? 'chat' : hall ? 'hall' : hiddenControls ? 'coreii' : email ? 'email' : 'bagandinfo';
  const configDirectory = join(repo, room ? 'research/i18n/room-art' : roomlist ? 'research/i18n/roomlist-art' : 'research/i18n/bag-art');
  const configBytes = readFileSync(join(configDirectory, gameover ? 'gameover.zh-CN.json' : hallFeature ? 'hall-feature.zh-CN.json' : chat ? 'chat.zh-CN.json' : hall ? 'hall.zh-CN.json' : hiddenControls ? 'hidden-controls.zh-CN.json' : email ? 'email.zh-CN.json' : 'zh-CN.json')), config = JSON.parse(configBytes.toString('utf8'));
  assert.equal(config.asset, `ui/vietnam/swf/${name}.swf`);
  const target = join(runtime, 'client-overlay', config.asset), asset = join(repo, 'apps/api/assets/flash', config.asset);
  const ledgerFile = join(runtime, room ? 'client-overlay-room-art.json' : roomlist ? 'client-overlay-roomlist-art.json' : gameover ? 'client-overlay-gameover-art.json' : hallFeature ? 'client-overlay-hall-feature-art.json' : chat ? 'client-overlay-chat-art.json' : hall ? 'client-overlay-hall-art.json' : hiddenControls ? 'client-overlay-hidden-controls-art.json' : email ? 'client-overlay-email-art.json' : 'client-overlay-bag-art.json'), previous = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null;
  const assetBytes = readFileSync(asset); assert.equal(hash(assetBytes), config.sourceAssetSha256, 'shipped asset changed; preserved');
  const replace = bytes => { mkdirSync(dirname(target), { recursive: true }); const fresh = target + `.bag-art-${process.pid}`; writeFileSync(fresh, bytes, { flag: 'wx' }); renameSync(fresh, target); };
  if (previous) {
    assert.equal(previous.target, target); assert.equal(hash(readFileSync(target)), previous.sha256, 'overlay changed; preserve newer work');
    assert.equal(hash(readFileSync(previous.backup)), previous.sourceSha256, 'backup changed; preserved');
  }
  if (command === 'rollback') {
    assert.ok(previous, 'no bag art overlay journal');
    if (previous.hadOverlay) replace(readFileSync(previous.backup)); else unlinkSync(target);
    unlinkSync(ledgerFile); console.log(JSON.stringify({ rolledBack: true, originalAssetUnchanged: true })); return;
  }
  const backgroundFile = backgroundFlags.length ? resolve(backgroundFlags[0].slice('--background='.length)) : null;
  const backgroundBytes = backgroundFile ? readFileSync(backgroundFile) : null;
  const background = backgroundBytes ? { ...validateBackground(backgroundBytes, config.background), sourceFile: backgroundFile } : { enabled: false };
  const effectiveConfigSha256 = background.enabled ? hash(Buffer.concat([configBytes, Buffer.from(background.pngSha256, 'hex')])) : hash(configBytes);
  if (command === 'install' && (previous?.effectiveConfigSha256 ?? previous?.configSha256) === effectiveConfigSha256) { console.log(JSON.stringify({ installed: true, unchanged: true, sha256: previous.sha256, background: previous.background ?? { enabled: false }, renderingAccepted: false })); return; }
  const base = previous ? readFileSync(previous.backup) : existsSync(target) ? readFileSync(target) : assetBytes;
  if (hall) assert.equal(hash(base), config.sourceAssetSha256, 'unknown hall overlay; preserved');
  if (chat) assert.equal(hash(base), config.sourceAssetSha256, 'unknown chat overlay; preserved');
  if (hallFeature) assert.equal(hash(base), config.sourceAssetSha256, 'unknown hall feature overlay; preserved');
  if (gameover) assert.equal(hash(base), config.sourceAssetSha256, 'unknown gameover overlay; preserved');
  if (email) assert.equal(hash(base), config.sourceAssetSha256, 'unknown email overlay; preserved');
  if (roomlist) assert.equal(hash(base), config.sourceAssetSha256, 'unknown roomlist overlay; preserved');
  if (room) assert.equal(hash(base), config.sourceAssetSha256, 'unknown room overlay; preserved');
  const depRoot = process.env.WORKSHOP_NODE_DEPS ?? join(process.env.USERPROFILE ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node');
  const require = createRequire(join(depRoot, 'package.json')), { PNG } = require('pngjs'), { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');
  const font = process.env.WORKSHOP_CJK_FONT ?? join(process.env.WINDIR ?? 'C:/Windows', 'Fonts', config.fontFile);
  assert.ok(existsSync(font), 'existing Chinese font unavailable: ' + font); assert.ok(GlobalFonts.registerFromPath(font, config.fontFamily), 'Chinese font registration failed');
  const reportDir = room ? join(runtime, 'client-text-followup', 'room-candidate', String(Date.now())) : roomlist ? join(runtime, 'client-text-followup', 'roomlist-candidate', String(Date.now())) : gameover ? join(runtime, 'client-text-followup', 'gameover-candidate', String(Date.now())) : hallFeature ? join(runtime, 'client-text-followup', 'ddthallicon-candidate', String(Date.now())) : email ? join(runtime, 'client-text-followup', 'email-candidate', String(Date.now())) : join(runtime, 'client-text-followup', `art-${chat ? 'chat-' : hall ? 'hall-' : hiddenControls ? 'hidden-controls-' : ''}${Date.now()}`); mkdirSync(reportDir, { recursive: true });
  const readJPEG = await preloadRoomlistJpeg(base, config, loadImage, createCanvas);
  const rendered = [], fontFits = [];
  const result = patchSwf(base, config, (image, entry) => {
    let rgba = Buffer.from(image.rgba);
    if (entry.preparedImage) {
      assert.ok(typeof entry.preparedImage.path === 'string' && !isAbsolute(entry.preparedImage.path), 'prepared caption needs a relative path');
      const imagePath = resolve(configDirectory, entry.preparedImage.path);
      assert.ok(imagePath.startsWith(configDirectory + sep), 'prepared caption path outside config directory');
      rgba = preparedPixels(readFileSync(imagePath), entry, bytes => PNG.sync.read(bytes));
    }
    for (const region of entry.preparedImage ? [] : entry.regions) {
      const [x, y, w, h] = region.box;
      if (region.inpaint) inpaintCaption(image, rgba, region.box, region.inpaintSeed);
      else for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const p = ((y + yy) * image.width + x + xx) * 4;
        if (region.clearBoxes && !region.clearBoxes.some(box => inside(x + xx, y + yy, box))) continue;
        if (region.transparent) rgba.fill(0, p, p + 4);
        else { const [sx, sy, sw, sh] = region.sample, sp = ((sy + yy % sh) * image.width + sx + xx % sw) * 4; image.rgba.copy(rgba, p, sp, sp + 4); }
      }
      const scale = 3, canvas = createCanvas(w * scale, h * scale), ctx = canvas.getContext('2d');
      const lines = region.vertical ? [...region.text] : [region.text]; let size = region.fontSize;
      const stroke = region.strokeWidth ?? 0, outerStroke = region.outerStrokeWidth ?? 0, edge = Math.max(stroke, outerStroke);
      const textOffsetX = region.textOffsetX ?? 0, tx = (w / 2 + textOffsetX) * scale;
      while (size >= 7) { ctx.font = `bold ${size * scale}px "${config.fontFamily}"`; if (Math.max(...lines.map(line => ctx.measureText(line).width)) / scale + edge * 2 <= w - 2 - 2 * Math.abs(textOffsetX) && size * lines.length * 1.08 + edge * 2 <= h - 1) break; size -= .5; }
      assert.ok(size >= 7, 'Chinese caption cannot fit: ' + entry.id + ' ' + region.text);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      const lineHeight = size * 1.08, start = h / 2 - (lines.length - 1) * lineHeight / 2 + (region.textOffsetY ?? 0);
      lines.forEach((line, i) => { const ty = (start + i * lineHeight) * scale;
        if (region.outerStroke && outerStroke > 0) { ctx.strokeStyle = region.outerStroke; ctx.lineWidth = outerStroke * 2 * scale; ctx.strokeText(line, tx, ty); }
        if (region.stroke && stroke > 0) { ctx.strokeStyle = region.stroke; ctx.lineWidth = stroke * 2 * scale; ctx.strokeText(line, tx, ty); }
        if (region.fillBottom) { const gradient = ctx.createLinearGradient(0, 0, 0, h * scale); gradient.addColorStop(0, region.fill); gradient.addColorStop(1, region.fillBottom); ctx.fillStyle = gradient; }
        else ctx.fillStyle = region.fill;
        ctx.fillText(line, tx, ty);
      });
      const small = createCanvas(w, h), sc = small.getContext('2d'); sc.drawImage(canvas, 0, 0, w, h);
      const ink = sc.getImageData(0, 0, w, h).data;
      let left = w, top = h, right = -1, bottom = -1;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const q = (yy * w + xx) * 4, p = ((y + yy) * image.width + x + xx) * 4, a = ink[q + 3] / 255, ba = rgba[p + 3] / 255;
        if (a > 0) { left = Math.min(left, xx); top = Math.min(top, yy); right = Math.max(right, xx); bottom = Math.max(bottom, yy); }
        const outA = a + ba * (1 - a); if (outA === 0) continue;
        for (let c = 0; c < 3; c++) rgba[p + c] = Math.round((ink[q + c] * a + rgba[p + c] * ba * (1 - a)) / outA);
        rgba[p + 3] = region.preserveAlpha ? image.rgba[p + 3] : Math.round(outA * 255);
      }
      if (region.inkMargin !== undefined) assert.ok(right >= left && bottom >= top && left >= region.inkMargin && top >= region.inkMargin && right < w - region.inkMargin && bottom < h - region.inkMargin, 'Chinese caption ink touches reviewed boundary: ' + entry.id + ' ' + region.text);
      fontFits.push({ id: entry.id, text: region.text, fontSize: size, box: region.box, textOffsetX, textOffsetY: region.textOffsetY ?? 0,
        inkBounds: right < 0 ? null : [x + left, y + top, x + right, y + bottom] });
    }
    const png = bytes => PNG.sync.write({ width: image.width, height: image.height, data: bytes });
    const before = join(reportDir, `${entry.id}-before.png`), after = join(reportDir, `${entry.id}-after.png`);
    writeFileSync(before, png(image.rgba)); writeFileSync(after, png(rgba)); rendered.push({ id: entry.id, width: image.width, height: image.height, before, after }); return rgba;
  }, backgroundBytes, { ...PNG.sync, readJPEG });
  // Export the packaged pixels again; these are the actual SWF result, not only the painter's input.
  const packaged = decompressSwf(result.out), packedTags = parseTags(packaged.body);
  for (const entry of rendered) {
    const tagCode = config.bitmaps.find(bitmap => bitmap.id === entry.id).tagCode ?? 36;
    const tag = packedTags.tags.find(tag => tag.code === tagCode && packaged.body.readUInt16LE(tag.bodyStart) === entry.id), body = packaged.body.subarray(tag.bodyStart, tag.bodyEnd);
    const image = tagCode === 21 ? decodePngTag21(body, PNG.sync.read) : tagCode === 35 ? decodePngBitmap(body, PNG.sync.read) : decodeBitmap(body);
    writeFileSync(entry.after, PNG.sync.write({ width: image.width, height: image.height, data: image.rgba }));
  }
  const main = (roomlist ? rendered.find(entry => entry.id === 72) : rendered.find(entry => entry.id === 16)) ?? rendered[0], comparisonScale = chat || hallFeature || gameover || email ? 4 : 1, comparison = createCanvas(main.width * comparisonScale * 2, main.height * comparisonScale + 26), cc = comparison.getContext('2d');
  cc.fillStyle = '#92908a'; cc.fillRect(0, 0, comparison.width, comparison.height); cc.fillStyle = '#171717'; cc.font = `15px "${config.fontFamily}"`; cc.fillText('原资源', 8, 18); cc.fillText('中文替换', main.width * comparisonScale + 8, 18);
  cc.drawImage(await loadImage(main.before), 0, 26, main.width * comparisonScale, main.height * comparisonScale); cc.drawImage(await loadImage(main.after), main.width * comparisonScale, 26, main.width * comparisonScale, main.height * comparisonScale); writeFileSync(join(reportDir, 'main-comparison.png'), comparison.toBuffer('image/png'));
  for (const scale of hiddenControls || chat || hallFeature || gameover || email ? [1.25, 1.5, 2, 4] : [1.25, 1.5, 2]) { const zoom = createCanvas(Math.ceil(main.width * scale), Math.ceil(main.height * scale)); zoom.getContext('2d').drawImage(await loadImage(main.after), 0, 0, zoom.width, zoom.height); writeFileSync(join(reportDir, `main-after-${scale}x.png`), zoom.toBuffer('image/png')); }
  const buttons = rendered.filter(entry => entry !== main), rowHeight = room ? 240 : roomlist ? 580 : chat ? 190 : 150, columns = roomlist || hall || chat || gameover ? 2 : 4, columnWidth = room ? 360 : roomlist ? 600 : gameover ? 700 : hall || chat ? 520 : 300;
  const sheet = createCanvas(columns * columnWidth, Math.max(1, Math.ceil(buttons.length / columns)) * rowHeight), bc = sheet.getContext('2d'); bc.fillStyle = '#aaa'; bc.fillRect(0, 0, sheet.width, sheet.height); bc.font = `13px "${config.fontFamily}"`;
  for (let i = 0; i < buttons.length; i++) { const e = buttons[i], x = i % columns * columnWidth, y = Math.floor(i / columns) * rowHeight; bc.fillStyle = '#111'; bc.fillText(String(e.id), x + 2, y + 17); bc.drawImage(await loadImage(e.before), x + 4, y + 22, e.width * comparisonScale, e.height * comparisonScale); bc.drawImage(await loadImage(e.after), x + columnWidth / 2, y + 22, e.width * comparisonScale, e.height * comparisonScale); }
  writeFileSync(join(reportDir, 'buttons-comparison.png'), sheet.toBuffer('image/png'));
  const summary = { installed: command === 'install', sourceSha256: hash(base), sha256: hash(result.out), sourceAssetSha256: hash(assetBytes), configSha256: hash(configBytes), effectiveConfigSha256, background,
    target, reportDir, changed: result.changed, totalTags: result.totalTags, unchangedTags: result.unchangedTags,
    font, fontFits, drawnCaptionRegions: fontFits.length, clearedCaptionRegions: result.changed.flatMap(entry => entry.clearedRegions ?? []),
    rendered, preparedBitmaps: config.bitmaps.filter(entry => entry.preparedImage).map(entry => ({ id: entry.id, ...entry.preparedImage })),
    renderingAccepted: false, outsideCaptionRegionsUnchanged: !background.enabled, captionPixelsOutsideRegionsUnchanged: true, originalAssetUnchanged: true };
  writeFileSync(join(reportDir, `${name}.swf`), result.out); writeFileSync(join(reportDir, 'evidence.json'), JSON.stringify(summary, null, 2));
  if (command === 'install') {
    if (existsSync(target)) assert.equal(hash(readFileSync(target)), previous?.sha256 ?? summary.sourceSha256, 'overlay changed during preparation; preserved');
    const backup = previous?.backup ?? join(reportDir, `${name}.before.swf`); if (!previous) writeFileSync(backup, base, { flag: 'wx' }); const hadOverlay = previous?.hadOverlay ?? existsSync(target);
    const current = existsSync(target) ? readFileSync(target) : null;
    const freshJournal = ledgerFile + `.bag-art-${process.pid}`;
    try {
      replace(result.out); assert.equal(hash(readFileSync(target)), summary.sha256);
      writeFileSync(freshJournal, JSON.stringify({ ...summary, backup, hadOverlay, installedAt: new Date().toISOString() }, null, 2), { flag: 'wx' }); renameSync(freshJournal, ledgerFile);
    } catch (error) {
      if (existsSync(target) && hash(readFileSync(target)) === summary.sha256) { if (current) replace(current); else unlinkSync(target); }
      if (existsSync(freshJournal)) unlinkSync(freshJournal); throw error;
    }
  }
  assert.equal(hash(readFileSync(asset)), config.sourceAssetSha256, 'shipped asset changed during preparation');
  console.log(JSON.stringify({ installed: summary.installed, bitmaps: result.changed.length, regions: fontFits.length, clearedRegions: summary.clearedCaptionRegions.length, sha256: summary.sha256, reportDir, background, renderingAccepted: false }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
