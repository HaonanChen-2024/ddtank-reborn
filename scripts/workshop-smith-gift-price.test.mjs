import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ByteReader, decompressSwf, parseTags } from '../tools/i18n/abc-strings/lib.mjs';
import { parseActivityAbc } from '../tools/i18n/abc-strings/activity-response.mjs';
import { patchSmithGiftPrice } from '../tools/i18n/abc-strings/smith-gift-price.mjs';
import { literalOptions } from './workshop-literals.mjs';

const original = readFileSync(new URL('../apps/api/assets/flash/2.png', import.meta.url));
function inspect(bytes) {
  const swf = decompressSwf(bytes), tags = parseTags(swf.body).tags;
  for (const [index, tag] of tags.entries()) {
    if (tag.code !== 82) continue;
    const r = new ByteReader(swf.body.subarray(tag.bodyStart, tag.bodyEnd)); r.u32();
    if (r.cstring() !== 'store/view/strength/BuyGiftBagButton') continue;
    const abc = r.buf.subarray(r.pos), constants = new ByteReader(abc);
    constants.u16(); constants.u16(); constants.u30();
    return { index, tags, price: constants.u30(), abc: parseActivityAbc(abc) };
  }
  assert.fail('missing BuyGiftBagButton');
}

test('smith affordability threshold matches quote; all click/submit/socket methods remain byte-identical', () => {
  const before = inspect(original), patch = patchSmithGiftPrice(original), after = inspect(patch.out);
  assert.equal(before.price, 988); assert.equal(after.price, 998);
  const init = after.abc.bodies.find(body => body.method === 0);
  const r = new ByteReader(init.code.subarray(10)); assert.equal(r.u30(), 998);
  for (const body of before.abc.bodies.filter(body => body.method !== 0))
    assert.deepEqual(after.abc.bodies.find(next => next.method === body.method).code, body.code);
  before.tags.forEach((tag, index) => { if (index !== before.index) assert.deepEqual(after.tags[index].raw, tag.raw); });
});

test('second patch is unchanged', () => {
  const first = patchSmithGiftPrice(original);
  const second = patchSmithGiftPrice(first.out);
  assert.equal(first.changed, true); assert.equal(second.changed, false); assert.deepEqual(second.out, first.out);
});

test('literal owner requires one explicit smith price option', () => {
  assert.equal(literalOptions(['verify', '--smith-gift-price']).smithGiftPrice, true);
  assert.throws(() => literalOptions(['--smith-gift-price', '--smith-gift-price']));
  assert.throws(() => literalOptions(['rollback', '--smith-gift-price']));
});
