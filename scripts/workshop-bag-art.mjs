#!/usr/bin/env node
// Replaces reviewed bitmap captions in the deployment overlay; preserves the original skin and every other SWF tag.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, deflateSync } from 'node:zlib';
import { ByteReader, decompressSwf, parseTags, buildTag, compressSwf } from '../tools/i18n/abc-strings/lib.mjs';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
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
export function patchSwf(bytes, config, render) {
  const decoded = decompressSwf(bytes); assert.equal(decoded.error, null);
  assert.equal(bytes.readUInt32LE(4), decoded.body.length + 8, 'SWF declared length mismatch');
  const parsed = parseTags(decoded.body), ids = new Set(), changed = [], replacements = new Map(), symbols = new Map();
  for (const tag of parsed.tags.filter(tag => tag.code === 76)) {
    const r = new ByteReader(decoded.body.subarray(tag.bodyStart, tag.bodyEnd)), n = r.u16();
    for (let i = 0; i < n; i++) { const id = r.u16(); symbols.set(id, r.cstring()); }
  }
  for (const entry of config.bitmaps) {
    assert.ok(!ids.has(entry.id), 'duplicate configured bitmap'); ids.add(entry.id);
    const matches = parsed.tags.filter(tag => tag.code === 36 && decoded.body.readUInt16LE(tag.bodyStart) === entry.id);
    assert.equal(matches.length, 1, 'missing or duplicate target bitmap: ' + entry.id);
    if (entry.className !== undefined) assert.equal(symbols.get(entry.id), entry.className, 'bitmap class mismatch');
    else {
      const owner = entry.ownerSymbolClass;
      assert.ok(owner && Number.isInteger(owner.id) && typeof owner.name === 'string', 'unlinked bitmap needs its reviewed owner');
      assert.equal(symbols.get(owner.id), owner.name, 'bitmap owner class mismatch');
      assert.equal(parsed.tags.filter(tag => tag.code === 39 && decoded.body.readUInt16LE(tag.bodyStart) === owner.id).length, 1, 'missing bitmap owner sprite');
    }
    const tag = matches[0], image = decodeBitmap(decoded.body.subarray(tag.bodyStart, tag.bodyEnd));
    assert.equal(image.width, entry.width); assert.equal(image.height, entry.height);
    assert.equal(hash(image.raw), entry.sourcePixelsSha256, 'target bitmap changed; preserve newer work: ' + entry.id);
    for (const region of entry.regions) {
      const [x, y, w, h] = region.box; assert.ok([x, y, w, h].every(Number.isInteger));
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= image.width && y + h <= image.height, 'caption outside bitmap');
      assert.ok(typeof region.text === 'string' && region.text.length > 0 && !/[\r\n]/.test(region.text));
      assert.ok(Number.isFinite(region.textOffsetY ?? 0) && Math.abs(region.textOffsetY ?? 0) <= h / 2, 'invalid caption vertical offset');
      assert.equal(Boolean(region.sample), !region.transparent, 'caption needs a sampled texture or transparent background');
      if (region.sample) { const [sx, sy, sw, sh] = region.sample; assert.ok([sx, sy, sw, sh].every(Number.isInteger)); assert.ok(sx >= 0 && sy >= 0 && sw > 0 && sh > 0 && sx + sw <= image.width && sy + sh <= image.height); }
      if (region.inpaintSeed) {
        const { min, max } = region.inpaintSeed;
        assert.ok(region.inpaint && Array.isArray(min) && Array.isArray(max) && min.length === 3 && max.length === 3 && min.every((v, c) => Number.isInteger(v) && Number.isInteger(max[c]) && v >= 0 && v <= max[c] && max[c] <= 255), 'invalid caption seed range');
      }
    }
    const rgba = render(image, entry), patched = decodeBitmap(encodeBitmap(image, rgba));
    let changedPixels = 0, alphaChangedPixels = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const p = (y * image.width + x) * 4;
      if (!patched.raw.subarray(p, p + 4).equals(image.raw.subarray(p, p + 4))) {
        assert.ok(entry.regions.some(region => inside(x, y, region.box)), 'unreviewed pixels changed'); changedPixels++;
        if (patched.raw[p] !== image.raw[p]) {
          assert.ok(entry.regions.some(region => inside(x, y, region.box) && !region.preserveAlpha), 'caption changed protected alpha'); alphaChangedPixels++;
        }
      }
    }
    assert.ok(changedPixels > 0, 'caption patch was a no-op');
    replacements.set(tag, buildTag(36, encodeBitmap(image, rgba)));
    changed.push({ id: entry.id, className: entry.className, width: image.width, height: image.height,
      regions: entry.regions.length, changedPixels, alphaChangedPixels, outsideRegionsUnchanged: true,
      sourcePixelsSha256: hash(image.raw), pixelsSha256: hash(patched.raw) });
  }
  const out = compressSwf(decoded.sig, decoded.version, Buffer.concat([parsed.headerPrefix, ...parsed.tags.map(tag => replacements.get(tag) ?? tag.raw), parsed.trailing]));
  const after = decompressSwf(out), afterTags = parseTags(after.body);
  assert.equal(after.error, null); assert.equal(after.sig, decoded.sig); assert.equal(after.version, decoded.version);
  assert.deepEqual(afterTags.headerPrefix, parsed.headerPrefix); assert.deepEqual(afterTags.trailing, parsed.trailing);
  assert.equal(afterTags.tags.length, parsed.tags.length);
  let unchangedTags = 0;
  for (let i = 0; i < parsed.tags.length; i++) {
    assert.equal(afterTags.tags[i].code, parsed.tags[i].code);
    if (!replacements.has(parsed.tags[i])) { assert.deepEqual(afterTags.tags[i].raw, parsed.tags[i].raw); unchangedTags++; }
  }
  return { out, changed, unchangedTags, totalTags: parsed.tags.length };
}

async function main() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), runtime = resolve(repo, '../../runtime');
  const command = process.argv[2] ?? 'verify'; assert.ok(['verify', 'install', 'rollback'].includes(command), 'usage: workshop-bag-art.mjs verify|install|rollback');
  const flags = process.argv.slice(3); assert.ok(flags.length <= 1 && flags.every(flag => ['--asset=hidden-controls', '--asset=hall', '--asset=chat'].includes(flag)), 'unknown bag art option');
  const hiddenControls = flags.includes('--asset=hidden-controls'), hall = flags.includes('--asset=hall'), chat = flags.includes('--asset=chat');
  const name = chat ? 'chat' : hall ? 'hall' : hiddenControls ? 'coreii' : 'bagandinfo';
  const configBytes = readFileSync(join(repo, 'research/i18n/bag-art', chat ? 'chat.zh-CN.json' : hall ? 'hall.zh-CN.json' : hiddenControls ? 'hidden-controls.zh-CN.json' : 'zh-CN.json')), config = JSON.parse(configBytes.toString('utf8'));
  assert.equal(config.asset, `ui/vietnam/swf/${name}.swf`);
  const target = join(runtime, 'client-overlay', config.asset), asset = join(repo, 'apps/api/assets/flash', config.asset);
  const ledgerFile = join(runtime, chat ? 'client-overlay-chat-art.json' : hall ? 'client-overlay-hall-art.json' : hiddenControls ? 'client-overlay-hidden-controls-art.json' : 'client-overlay-bag-art.json'), previous = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null;
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
  if (command === 'install' && previous?.configSha256 === hash(configBytes)) { console.log(JSON.stringify({ installed: true, unchanged: true, sha256: previous.sha256 })); return; }
  const base = previous ? readFileSync(previous.backup) : existsSync(target) ? readFileSync(target) : assetBytes;
  if (hall) assert.equal(hash(base), config.sourceAssetSha256, 'unknown hall overlay; preserved');
  if (chat) assert.equal(hash(base), config.sourceAssetSha256, 'unknown chat overlay; preserved');
  const depRoot = process.env.WORKSHOP_NODE_DEPS ?? join(process.env.USERPROFILE ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node');
  const require = createRequire(join(depRoot, 'package.json')), { PNG } = require('pngjs'), { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');
  const font = process.env.WORKSHOP_CJK_FONT ?? join(process.env.WINDIR ?? 'C:/Windows', 'Fonts', config.fontFile);
  assert.ok(existsSync(font), 'existing Chinese font unavailable: ' + font); assert.ok(GlobalFonts.registerFromPath(font, config.fontFamily), 'Chinese font registration failed');
  const reportDir = join(runtime, 'client-text-followup', `art-${chat ? 'chat-' : hall ? 'hall-' : hiddenControls ? 'hidden-controls-' : ''}${Date.now()}`); mkdirSync(reportDir, { recursive: true });
  const rendered = [], fontFits = [];
  const result = patchSwf(base, config, (image, entry) => {
    const rgba = Buffer.from(image.rgba);
    for (const region of entry.regions) {
      const [x, y, w, h] = region.box;
      if (region.inpaint) inpaintCaption(image, rgba, region.box, region.inpaintSeed);
      else for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const p = ((y + yy) * image.width + x + xx) * 4;
        if (region.transparent) rgba.fill(0, p, p + 4);
        else { const [sx, sy, sw, sh] = region.sample, sp = ((sy + yy % sh) * image.width + sx + xx % sw) * 4; image.rgba.copy(rgba, p, sp, sp + 4); }
      }
      const scale = 3, canvas = createCanvas(w * scale, h * scale), ctx = canvas.getContext('2d');
      const lines = region.vertical ? [...region.text] : [region.text]; let size = region.fontSize;
      const stroke = region.strokeWidth ?? 0, outerStroke = region.outerStrokeWidth ?? 0, edge = Math.max(stroke, outerStroke);
      while (size >= 7) { ctx.font = `bold ${size * scale}px "${config.fontFamily}"`; if (Math.max(...lines.map(line => ctx.measureText(line).width)) / scale + edge * 2 <= w - 2 && size * lines.length * 1.08 + edge * 2 <= h - 1) break; size -= .5; }
      assert.ok(size >= 7, 'Chinese caption cannot fit: ' + entry.id + ' ' + region.text);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      const lineHeight = size * 1.08, start = h / 2 - (lines.length - 1) * lineHeight / 2 + (region.textOffsetY ?? 0);
      lines.forEach((line, i) => { const ty = (start + i * lineHeight) * scale;
        if (region.outerStroke && outerStroke > 0) { ctx.strokeStyle = region.outerStroke; ctx.lineWidth = outerStroke * 2 * scale; ctx.strokeText(line, w * scale / 2, ty); }
        if (region.stroke && stroke > 0) { ctx.strokeStyle = region.stroke; ctx.lineWidth = stroke * 2 * scale; ctx.strokeText(line, w * scale / 2, ty); }
        if (region.fillBottom) { const gradient = ctx.createLinearGradient(0, 0, 0, h * scale); gradient.addColorStop(0, region.fill); gradient.addColorStop(1, region.fillBottom); ctx.fillStyle = gradient; }
        else ctx.fillStyle = region.fill;
        ctx.fillText(line, w * scale / 2, ty);
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
      fontFits.push({ id: entry.id, text: region.text, fontSize: size, box: region.box, textOffsetY: region.textOffsetY ?? 0,
        inkBounds: right < 0 ? null : [x + left, y + top, x + right, y + bottom] });
    }
    const png = bytes => PNG.sync.write({ width: image.width, height: image.height, data: bytes });
    const before = join(reportDir, `${entry.id}-before.png`), after = join(reportDir, `${entry.id}-after.png`);
    writeFileSync(before, png(image.rgba)); writeFileSync(after, png(rgba)); rendered.push({ id: entry.id, width: image.width, height: image.height, before, after }); return rgba;
  });
  // Export the packaged pixels again; these are the actual SWF result, not only the painter's input.
  const packaged = decompressSwf(result.out), packedTags = parseTags(packaged.body);
  for (const entry of rendered) {
    const tag = packedTags.tags.find(tag => tag.code === 36 && packaged.body.readUInt16LE(tag.bodyStart) === entry.id), image = decodeBitmap(packaged.body.subarray(tag.bodyStart, tag.bodyEnd));
    writeFileSync(entry.after, PNG.sync.write({ width: image.width, height: image.height, data: image.rgba }));
  }
  const main = rendered.find(entry => entry.id === 16) ?? rendered[0], comparisonScale = chat ? 4 : 1, comparison = createCanvas(main.width * comparisonScale * 2, main.height * comparisonScale + 26), cc = comparison.getContext('2d');
  cc.fillStyle = '#92908a'; cc.fillRect(0, 0, comparison.width, comparison.height); cc.fillStyle = '#171717'; cc.font = `15px "${config.fontFamily}"`; cc.fillText('原资源', 8, 18); cc.fillText('中文替换', main.width * comparisonScale + 8, 18);
  cc.drawImage(await loadImage(main.before), 0, 26, main.width * comparisonScale, main.height * comparisonScale); cc.drawImage(await loadImage(main.after), main.width * comparisonScale, 26, main.width * comparisonScale, main.height * comparisonScale); writeFileSync(join(reportDir, 'main-comparison.png'), comparison.toBuffer('image/png'));
  for (const scale of hiddenControls || chat ? [1.25, 1.5, 2, 4] : [1.25, 1.5, 2]) { const zoom = createCanvas(Math.ceil(main.width * scale), Math.ceil(main.height * scale)); zoom.getContext('2d').drawImage(await loadImage(main.after), 0, 0, zoom.width, zoom.height); writeFileSync(join(reportDir, `main-after-${scale}x.png`), zoom.toBuffer('image/png')); }
  const buttons = rendered.filter(entry => entry !== main), rowHeight = chat ? 190 : 150, columns = hall || chat ? 2 : 4, columnWidth = hall || chat ? 520 : 300;
  const sheet = createCanvas(columns * columnWidth, Math.max(1, Math.ceil(buttons.length / columns)) * rowHeight), bc = sheet.getContext('2d'); bc.fillStyle = '#aaa'; bc.fillRect(0, 0, sheet.width, sheet.height); bc.font = `13px "${config.fontFamily}"`;
  for (let i = 0; i < buttons.length; i++) { const e = buttons[i], x = i % columns * columnWidth, y = Math.floor(i / columns) * rowHeight; bc.fillStyle = '#111'; bc.fillText(String(e.id), x + 2, y + 17); bc.drawImage(await loadImage(e.before), x + 4, y + 22, e.width * comparisonScale, e.height * comparisonScale); bc.drawImage(await loadImage(e.after), x + columnWidth / 2, y + 22, e.width * comparisonScale, e.height * comparisonScale); }
  writeFileSync(join(reportDir, 'buttons-comparison.png'), sheet.toBuffer('image/png'));
  const summary = { installed: command === 'install', sourceSha256: hash(base), sha256: hash(result.out), sourceAssetSha256: hash(assetBytes), configSha256: hash(configBytes),
    target, reportDir, changed: result.changed, totalTags: result.totalTags, unchangedTags: result.unchangedTags,
    font, fontFits, rendered, renderingAccepted: false, outsideCaptionRegionsUnchanged: true, originalAssetUnchanged: true };
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
  console.log(JSON.stringify({ installed: summary.installed, bitmaps: result.changed.length, regions: fontFits.length, sha256: summary.sha256, reportDir, renderingAccepted: false }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
