#!/usr/bin/env node
// Offline refinement of four reviewed tooltip labels; never installs or starts a service.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ByteReader, decompressSwf, parseTags, buildTag, compressSwf } from '../tools/i18n/abc-strings/lib.mjs';
import { decodeBitmap, encodeBitmap, hash } from './workshop-bag-art.mjs';
import { renderCaption } from './workshop-calendar-art.mjs';

const repo = resolve(import.meta.dirname, '..');
const configuration = readFileSync(join(repo, 'research/i18n/tooltip-quest-art/smooth-labels.zh-CN.json'));
export const tooltipLabels = JSON.parse(configuration);
const deps = createRequire(join(process.env.WORKSHOP_NODE_DEPS ?? join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node'), 'package.json'));
const { PNG } = deps('pngjs'), { GlobalFonts, createCanvas, loadImage } = deps('@napi-rs/canvas');

function scan(bytes) {
  const swf = decompressSwf(bytes); assert.equal(swf.error, null);
  assert.equal(bytes.readUInt32LE(4), swf.body.length + 8);
  const parsed = parseTags(swf.body), symbols = new Map();
  for (const t of parsed.tags.filter(t => t.code === 76)) {
    const r = new ByteReader(swf.body.subarray(t.bodyStart, t.bodyEnd));
    for (let n = r.u16(); n; n--) symbols.set(r.u16(), r.cstring());
  }
  return { ...swf, ...parsed, symbols };
}
export function tooltipBitmap(bytes, id) {
  const swf = scan(bytes), tags = swf.tags.filter(t => t.code === 36 && swf.body.readUInt16LE(t.bodyStart) === id);
  assert.equal(tags.length, 1); return decodeBitmap(swf.body.subarray(tags[0].bodyStart, tags[0].bodyEnd));
}
export function patchTooltipLabels(bytes, name) {
  const asset = tooltipLabels.assets.find(e => e.name === name); assert.ok(asset, 'unsupported tooltip label asset');
  assert.equal(hash(bytes), asset.sourceSha256, 'tooltip source changed; preserve newer work');
  assert.ok(GlobalFonts.registerFromPath(join(process.env.WINDIR ?? 'C:/Windows', 'Fonts', tooltipLabels.fontFile), tooltipLabels.fontFamily), 'tooltip font unavailable');
  const before = scan(bytes), replacements = new Map(), fontFits = [];
  for (const e of asset.bitmaps) {
    assert.equal(before.symbols.get(e.id), e.symbol);
    const matches = before.tags.filter(t => t.code === 36 && before.body.readUInt16LE(t.bodyStart) === e.id); assert.equal(matches.length, 1);
    const tag = matches[0]; assert.equal(hash(tag.raw), e.tagSha256, 'tooltip label tag changed');
    const image = decodeBitmap(before.body.subarray(tag.bodyStart, tag.bodyEnd));
    assert.equal(image.width, e.width); assert.equal(image.height, e.height);
    const { labelWidth, ...style } = tooltipLabels.style;
    const rgba = renderCaption(image, { id: e.id, regions: [{ box: [0, 0, labelWidth, e.height], text: e.text, transparent: true, inkMargin: 1, ...style }] }, tooltipLabels, fontFits);
    const body = encodeBitmap(image, rgba), after = decodeBitmap(body);
    // Keep every original underline/value-area byte, including premultiplied alpha.
    for (let y = 0; y < e.height; y++) for (let x = labelWidth; x < e.width; x++) {
      const p = (y * e.width + x) * 4; assert.deepEqual(after.raw.subarray(p, p + 4), image.raw.subarray(p, p + 4));
    }
    replacements.set(tag, buildTag(36, body));
  }
  const out = compressSwf(before.sig, before.version, Buffer.concat([before.headerPrefix, ...before.tags.map(t => replacements.get(t) ?? t.raw), before.trailing]));
  const after = scan(out); assert.equal(after.tags.length, before.tags.length);
  assert.deepEqual(after.headerPrefix, before.headerPrefix); assert.deepEqual(after.trailing, before.trailing);
  for (let i = 0; i < before.tags.length; i++) if (!replacements.has(before.tags[i])) assert.deepEqual(after.tags[i].raw, before.tags[i].raw);
  return { out, metadata: { name, sourceSha256: hash(bytes), outputSha256: hash(out), configSha256: hash(configuration), changedBitmapIds: asset.bitmaps.map(e => e.id), fontFits,
    allOtherTagsByteIdentical: true, originalDimensionsPreserved: true, valueUnderlinesPreserved: true, runtimeAccepted: false } };
}

export async function buildTooltipLabelCandidates(inputDirectory, outputDirectory) {
  const output = resolve(outputDirectory); assert.ok(!existsSync(output), 'candidate directory already exists'); mkdirSync(output, { recursive: true });
  const entries = [], sheet = createCanvas(1160, 8 * 124), ctx = sheet.getContext('2d');
  ctx.fillStyle = '#404047'; ctx.fillRect(0, 0, sheet.width, sheet.height); let row = 0;
  for (const asset of tooltipLabels.assets) {
    const source = readFileSync(join(inputDirectory, asset.name + '.swf')), result = patchTooltipLabels(source, asset.name);
    writeFileSync(join(output, asset.name + '.before.swf'), source); writeFileSync(join(output, asset.name + '.swf'), result.out);
    for (const e of asset.bitmaps) {
      ctx.font = `14px "${tooltipLabels.fontFamily}"`; ctx.fillStyle = '#fff';
      ctx.fillText(`${asset.name} #${e.id} ${e.text} | before 4x | after 4x | after 1x / 1.25x / 1.5x`, 8, row * 124 + 19);
      for (const [suffix, bytes, x] of [['before', source, 8], ['after', result.out, 400]]) {
        const im = tooltipBitmap(bytes, e.id), png = PNG.sync.write({ width: im.width, height: im.height, data: im.rgba });
        writeFileSync(join(output, `${asset.name}-${e.id}-${suffix}.png`), png); const picture = await loadImage(png);
        ctx.drawImage(picture, x, row * 124 + 30, im.width * 4, im.height * 4);
        if (suffix === 'after') for (const [index, scale] of [1, 1.25, 1.5].entries()) {
          ctx.drawImage(picture, 800, row * 124 + 29 + index * 27, im.width * scale, im.height * scale);
          const zoom = createCanvas(Math.ceil(im.width * scale), Math.ceil(im.height * scale));
          zoom.getContext('2d').drawImage(picture, 0, 0, im.width * scale, im.height * scale);
          writeFileSync(join(output, `${asset.name}-${e.id}-after-${scale}x.png`), zoom.toBuffer('image/png'));
        }
      }
      row++;
    }
    entries.push(result.metadata);
  }
  writeFileSync(join(output, 'comparison.png'), sheet.toBuffer('image/png'));
  const manifest = { version: 1, kind: 'smooth-tooltip-label-candidates', createdAt: new Date().toISOString(), entries, installed: false, runtimeAccepted: false };
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], 'candidate', 'usage: workshop-tooltip-labels.mjs candidate <input-swf-directory> <fresh-output-directory>');
  assert.equal(process.argv.length, 5); console.log(JSON.stringify(await buildTooltipLabelCandidates(process.argv[3], process.argv[4])));
}
