import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildTag, compressSwf, decompressSwf, parseTags } from '../tools/i18n/abc-strings/lib.mjs';
import { patchHallHover } from './workshop-hall-hover.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const tag = (code, id, content) => { const idBytes = Buffer.alloc(2); idBytes.writeUInt16LE(id); return buildTag(code, Buffer.concat([idBytes, Buffer.from(content)])); };
function fixture() {
  const background = tag(21, 12, 'night'), sprite = tag(39, 245, '13 frames and named hit targets'),
    old = tag(21, 16, 'day'), original = tag(21, 54, 'night highlight'), installed = tag(21, 16, 'night highlight');
  const keep = buildTag(82, Buffer.from('existing unrelated client script and tutorial'));
  const swf = tags => compressSwf('CWS', 10, Buffer.concat([Buffer.from([8, 0, 0, 24, 1, 0]), ...tags, buildTag(0, Buffer.alloc(0))]));
  const bytes = swf([background, old, sprite, keep]), donor = swf([original]);
  const manifest = { version: 1, donorSha256: sha(donor),
    background: { targetId: 12, tagCode: 21, sha256: sha(background) }, mainSprite: { targetId: 245, tagCode: 39, sha256: sha(sprite) },
    entries: [{ targetId: 16, donorId: 54, tagCode: 21, sourceTagSha256: sha(old), donorTagSha256: sha(original), installedTagSha256: sha(installed), references: [] }],
  };
  return { bytes, donor, manifest, swf, background, sprite, keep, old };
}
test('only reviewed art changes; background, hit targets, timeline and script bytes survive', () => {
  const f = fixture(), result = patchHallHover(f.bytes, f.donor, f.manifest), before = parseTags(decompressSwf(f.bytes).body).tags, after = parseTags(decompressSwf(result.out).body).tags;
  assert.equal(result.changes.length, 1); assert.equal(after.length, before.length);
  for (const i of [0, 2, 3, 4]) assert.deepEqual(after[i].raw, before[i].raw);
  assert.deepEqual(patchHallHover(result.out, f.donor, f.manifest).out, result.out);
  assert.equal(patchHallHover(result.out, f.donor, f.manifest).changes.length, 0);
});
test('refuses changed donors, target art, and an incompatible background before returning output', () => {
  const f = fixture();
  assert.throws(() => patchHallHover(f.bytes, Buffer.from('different donor'), f.manifest), /donor changed/);
  const targetChanged = f.swf([f.background, tag(21, 16, 'other work'), f.sprite, f.keep]);
  assert.throws(() => patchHallHover(targetChanged, f.donor, f.manifest), /preserve existing work/);
  const skinChanged = f.swf([tag(21, 12, 'other skin'), f.old, f.sprite, f.keep]);
  assert.throws(() => patchHallHover(skinChanged, f.donor, f.manifest), /background\/timeline changed/);
});
