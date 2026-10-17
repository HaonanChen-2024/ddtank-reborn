import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { decompressSwf, parseTags } from '../tools/i18n/abc-strings/lib.mjs';
import { hash } from './workshop-bag-art.mjs';
import { tooltipLabels, tooltipBitmap, patchTooltipLabels } from './workshop-tooltip-labels.mjs';

// The frozen local fixture contains the already installed original-Chinese UI.
// It is not redistributed with the source patch.
const fixture = resolve(import.meta.dirname, '../../../runtime/reference-ui-direct-port-20261015/candidate-a');
const available = tooltipLabels.assets.every(a => existsSync(join(fixture, a.name + '.swf')));
const outputs = new Map();

test('the requested four labels map to both client resource modules', () => {
  assert.deepEqual(tooltipLabels.assets.map(a => a.bitmaps.map(b => b.text)), [
    ['品质', '类型', '伤害', '角度'], ['品质', '类型', '伤害', '角度'],
  ]);
  assert.throws(() => patchTooltipLabels(Buffer.alloc(0), 'unknown'), /unsupported/);
  assert.throws(() => patchTooltipLabels(Buffer.alloc(0), 'coreiconandtip'), /source changed/);
});

for (const asset of tooltipLabels.assets) test(asset.name + ' preserves dimensions, non-label tags, underline and transparent margins', { skip: !available }, () => {
  const beforeBytes = readFileSync(join(fixture, asset.name + '.swf')), inputHash = hash(beforeBytes);
  const result = patchTooltipLabels(beforeBytes, asset.name), before = parseTags(decompressSwf(beforeBytes).body), after = parseTags(decompressSwf(result.out).body);
  assert.equal(hash(beforeBytes), inputHash); assert.notEqual(result.metadata.sourceSha256, result.metadata.outputSha256);
  assert.equal(before.tags.length, after.tags.length);
  const changed = before.tags.flatMap((t, i) => t.raw.equals(after.tags[i].raw) ? [] : [t]);
  assert.equal(changed.length, 4); assert.ok(changed.every(t => t.code === 36));
  for (const entry of asset.bitmaps) {
    const old = tooltipBitmap(beforeBytes, entry.id), image = tooltipBitmap(result.out, entry.id);
    assert.equal(image.width, entry.width); assert.equal(image.height, entry.height);
    let intermediateAlpha = 0, whiteInk = 0, darkOutline = 0; const alphaLevels = new Set();
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const p = (y * image.width + x) * 4, a = image.rgba[p + 3];
      if (x >= 28) assert.deepEqual(image.raw.subarray(p, p + 4), old.raw.subarray(p, p + 4));
      else {
        if (x === 0 || x === 27 || y === 0 || y === image.height - 1) assert.equal(a, 0, 'ink clips or fills the transparent border');
        if (a > 0 && a < 255) { intermediateAlpha++; alphaLevels.add(a); }
        if (a > 200 && image.rgba[p] > 200) whiteInk++;
        if (a > 50 && image.rgba[p] < 60) darkOutline++;
      }
    }
    assert.ok(intermediateAlpha > 10 && alphaLevels.size > 10, 'label needs multiple levels of antialiased alpha');
    assert.ok(whiteInk > 20, 'white text is missing');
    assert.ok(darkOutline > 10, 'black outline is missing');
  }
  outputs.set(asset.name, result.out);
});

test('both client modules use identical reviewed text pixels', { skip: !available }, () => {
  const [a, b] = tooltipLabels.assets;
  for (let i = 0; i < 4; i++) assert.deepEqual(tooltipBitmap(outputs.get(a.name), a.bitmaps[i].id).rgba, tooltipBitmap(outputs.get(b.name), b.bitmaps[i].id).rgba);
});
