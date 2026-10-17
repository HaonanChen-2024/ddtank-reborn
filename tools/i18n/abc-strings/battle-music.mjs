// Battle transitions must close the preceding NetStream, just like playMusic does.
import assert from 'node:assert/strict';
import { ByteReader, buildTag, compressSwf, decompressSwf, encodeU30, parseTags } from './lib.mjs';
import { parseActivityAbc } from './activity-response.mjs';

const TAG = 'ddt/manager/SoundManager';
const original = Buffer.from('f106f0d203d030ef012300d203f0d403d0d1d1560227463d0229f0d50347', 'hex');
// After getlocal0/pushscope: this.stopMusic(). Keep the map ID, playlist and mute/volume behavior.
const fixed = Buffer.concat([original.subarray(0, 7), Buffer.from([0xd0, 0x4f, 60, 0]), original.subarray(7)]);
export function patchBattleMusic(bytes) {
  const swf = decompressSwf(bytes); assert.equal(swf.error, null);
  const parsed = parseTags(swf.body); let found = 0, changed = false;
  const tags = parsed.tags.map(tag => {
    if (tag.code !== 82) return tag.raw;
    const payload = swf.body.subarray(tag.bodyStart, tag.bodyEnd), r = new ByteReader(payload);
    r.u32(); if (r.cstring() !== TAG) return tag.raw;
    found++;
    const abc = payload.subarray(r.pos), p = parseActivityAbc(abc);
    assert.equal(p.strings[p.methods[28]?.name], 'ddt.manager:SoundManager/playGameBackMusic');
    assert.equal(p.strings[p.names[60]?.name], 'stopMusic');
    assert.equal(p.strings[p.names[61]?.name], 'playMusicImp');
    const body = p.bodies.find(b => b.method === 28);
    assert.deepEqual([body.maxStack, body.localCount, body.initialScope, body.maxScope, body.exceptions], [3, 2, 4, 5, 0]);
    assert.ok(body.code.equals(original) || body.code.equals(fixed), 'unknown battle music method; preserve client');
    if (body.code.equals(fixed)) return tag.raw;
    changed = true;
    const replacement = Buffer.concat([
      ...[28, 3, 2, 4, 5, fixed.length].map(encodeU30), fixed,
      abc.subarray(body.offset + body.length, body.end),
    ]);
    const out = Buffer.concat([abc.subarray(0, body.start), replacement, abc.subarray(body.end)]);
    const after = parseActivityAbc(out);
    for (const other of p.bodies.filter(b => b.method !== 28)) {
      const next = after.bodies.find(b => b.method === other.method);
      assert.deepEqual(out.subarray(next.start, next.end), abc.subarray(other.start, other.end));
    }
    return buildTag(82, Buffer.concat([payload.subarray(0, r.pos), out]));
  });
  assert.equal(found, 1, 'expected one SoundManager');
  return { out: changed ? compressSwf(swf.sig, swf.version, Buffer.concat([parsed.headerPrefix, ...tags, parsed.trailing])) : bytes,
    changed, proof: { methodIndex: 28, closesPreviousMusic: true, mapPlaylistPreserved: true, unchangedMethods: 33, runtimeAccepted: false } };
}
