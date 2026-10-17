import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ByteReader, decompressSwf, parseTags } from '../tools/i18n/abc-strings/lib.mjs';
import { parseActivityAbc } from '../tools/i18n/abc-strings/activity-response.mjs';
import { patchBattleMusic } from '../tools/i18n/abc-strings/battle-music.mjs';
import { patchWeaponAudioRegistration } from '../tools/i18n/abc-strings/weapon-audio.mjs';
import { literalOptions } from './workshop-literals.mjs';

const original = readFileSync(new URL('../apps/api/assets/flash/2.png', import.meta.url));
function inspect(bytes) {
  const swf = decompressSwf(bytes), tags = parseTags(swf.body).tags;
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i]; if (t.code !== 82) continue;
    const r = new ByteReader(swf.body.subarray(t.bodyStart, t.bodyEnd)); r.u32();
    if (r.cstring() !== 'ddt/manager/SoundManager') continue;
    const p = parseActivityAbc(r.buf.subarray(r.pos));
    return { tags, i, p, code: p.bodies.find(b => b.method === 28).code };
  }
  assert.fail('missing SoundManager');
}
// Execute this real straight-line AVM2 method against a stream retaining its current audio until close().
function playBattle(code, muted = false) {
  const trace = [], stream = { music: 'lobby', close() { trace.push('close'); this.music = null; },
    play(id) { trace.push(['play', id]); this.music ??= id; } };
  const self = { stopMusic() { stream.close(); }, playMusicImp(list, loop) {
    trace.push({ list, loop, muted }); stream.play(list[0]);
  } };
  const r = new ByteReader(code), stack = [], locals = [self, '1005'];
  while (r.pos < code.length) {
    const op = r.buf[r.pos++];
    if (op === 0xf1 || op === 0xf0) r.u30();
    else if (op === 0xef) { r.pos++; r.u30(); r.pos++; r.u30(); }
    else if (op === 0xd0 || op === 0xd1) stack.push(locals[op - 0xd0]);
    else if (op === 0x30 || op === 0x29) stack.pop();
    else if (op === 0x27) stack.push(false);
    else if (op === 0x56) stack.push(stack.splice(-r.u30()));
    else if (op === 0x46 || op === 0x4f) {
      const name = r.u30(), count = r.u30(), args = count ? stack.splice(-count) : [], receiver = stack.pop();
      assert.ok(name === 60 || name === 61);
      const result = receiver[name === 60 ? 'stopMusic' : 'playMusicImp'](...args);
      if (op === 0x46) stack.push(result);
    } else if (op === 0x47) break;
    else assert.fail('unhandled opcode ' + op.toString(16));
  }
  return { music: stream.music, trace };
}
test('battle closes lobby audio before playing its own map, preserving playlist and mute state', () => {
  assert.equal(playBattle(inspect(original).code).music, 'lobby');
  for (const muted of [false, true]) {
    const result = playBattle(inspect(patchBattleMusic(original).out).code, muted);
    assert.equal(result.music, '1005');
    assert.deepEqual(result.trace, ['close', { list: ['1005', '1005'], loop: false, muted }, ['play', '1005']]);
  }
});
test('preserves weapon sound registration and all other SWF tags; repeat is unchanged', () => {
  const audio = patchWeaponAudioRegistration(original).out, before = inspect(audio), patched = patchBattleMusic(audio), after = inspect(patched.out);
  assert.equal(patched.changed, true);
  assert.deepEqual(after.p.bodies.find(b => b.method === 11).code, before.p.bodies.find(b => b.method === 11).code);
  before.tags.forEach((tag, i) => { if (i !== before.i) assert.deepEqual(after.tags[i].raw, tag.raw); });
  assert.equal(patchBattleMusic(patched.out).changed, false);
  assert.deepEqual(patchBattleMusic(patched.out).out, patched.out);
  assert.deepEqual(patchWeaponAudioRegistration(patchBattleMusic(original).out).out, patched.out);
  assert.equal(patchWeaponAudioRegistration(patched.out).changed, false);
});
test('owner accepts only one explicit battle music option', () => {
  assert.equal(literalOptions(['install', '--battle-music']).battleMusic, true);
  assert.throws(() => literalOptions(['--battle-music', '--battle-music']));
  assert.throws(() => literalOptions(['rollback', '--battle-music']));
});
