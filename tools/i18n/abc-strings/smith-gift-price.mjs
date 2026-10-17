// Keep the smith bundle's client affordability check equal to the displayed 998 quote.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ByteReader, buildTag, compressSwf, decompressSwf, encodeU30, parseTags } from './lib.mjs';
import { parseActivityAbc } from './activity-response.mjs';

const TAG = 'store/view/strength/BuyGiftBagButton';
const originalHash = 'bbffbc199b5b8e056b5fac8a0ea66713e885fa72ad5a236f77bb89c1da446a91';
const originalInit = Buffer.from('d030ef010200185e0125dc07680147', 'hex');
const hash = b => createHash('sha256').update(b).digest('hex');

export function patchSmithGiftPrice(bytes) {
  const swf = decompressSwf(bytes); assert.equal(swf.error, null);
  const parsed = parseTags(swf.body); let found = 0, changed = false;
  const tags = parsed.tags.map(tag => {
    if (tag.code !== 82) return tag.raw;
    const payload = swf.body.subarray(tag.bodyStart, tag.bodyEnd), r = new ByteReader(payload);
    r.u32(); if (r.cstring() !== TAG) return tag.raw;
    found++;
    const abc = payload.subarray(r.pos), out = Buffer.from(abc), constants = new ByteReader(abc);
    constants.u16(); constants.u16(); assert.equal(constants.u30(), 2);
    const intOffset = constants.pos, price = constants.u30();
    assert.ok(price === 988 || price === 998, 'unknown smith bundle price');
    const p = parseActivityAbc(abc), init = p.bodies.find(body => body.method === 0);
    assert.equal(p.strings[p.names[1].name], 'GIFTBAG_PRICE');
    const normalized = Buffer.from(abc);
    encodeU30(988).copy(normalized, intOffset);
    originalInit.copy(normalized, init.offset);
    assert.equal(hash(normalized), originalHash, 'unknown BuyGiftBagButton class; preserve current client');
    const expectedInit = Buffer.from(originalInit); encodeU30(price).copy(expectedInit, 10);
    assert.deepEqual(init.code, expectedInit);
    if (price === 998) return tag.raw;
    encodeU30(998).copy(out, intOffset); encodeU30(998).copy(out, init.offset + 10);
    changed = true;
    return buildTag(82, Buffer.concat([payload.subarray(0, r.pos), out]));
  });
  assert.equal(found, 1, 'expected one BuyGiftBagButton');
  return { out: changed ? compressSwf(swf.sig, swf.version, Buffer.concat([parsed.headerPrefix, ...tags, parsed.trailing])) : bytes,
    changed, proof: { class: TAG, oldPrice: 988, price: 998, otherClassesPreserved: true, purchasePacketPreserved: true, runtimeAccepted: false } };
}
