// Register only the six original cream-bear Sound exports supplied by the audio overlay.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ByteReader, buildTag, compressSwf, decompressSwf, encodeU30, parseTags } from './lib.mjs';
import { parseActivityAbc } from './activity-response.mjs';
import { decodeCalendarCode } from './activity-state.mjs';

const TAG = 'ddt/manager/SoundManager', IDS = ['252', '253', '254', '255', '256', '257'];
const ORIGINAL = '806711c62ba971d995a404a7dcf42891bd4c06de82ed3e30c0f20ffa64e7af1a';
const PATCHED = '82de229f90509fab0c88ff04964c380c2054f6b8e7b1811cad77a0961a6f5324';
// The same two exact ABCs with the independent playGameBackMusic close-before-play fix.
const ORIGINAL_MUSIC = '9623c4827d2149d18888997b6f86281e0b7258eedef9f507173d5fb61fa17ed1';
const PATCHED_MUSIC = '6aa370055d5e9707466d51122271cc5dae708c1e6b84e79298badfbdc39b676a';
const INIT_CODE = '52bb8aa1e5452235cd1473e84338ed4e4668e3e5a7c5d28ea52c2842addf64a3';
const INIT_SOUND_CODE = '33efe922508c029f26d802b9209d6be8ff59317d0a43450514c01f2891b07441';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const u = encodeU30, cat = (...parts) => Buffer.concat(parts);
const addition = () => cat(...IDS.map((_, i) => cat(Buffer.from([0xd0, 0x2c]), u(446 + i), Buffer.from([0x4f]), u(75), u(1))));

function replace(bytes, edits) {
  let out = bytes, end = bytes.length;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    assert.ok(e.start <= e.end && e.end <= end); end = e.start;
    out = cat(out.subarray(0, e.start), e.data, out.subarray(e.end));
  }
  return out;
}
function methodBody(bytes, target, code) {
  return cat(...[target.method, target.maxStack, target.localCount, target.initialScope, target.maxScope, code.length].map(u), code,
    bytes.subarray(target.offset + target.length, target.end));
}
function inspect(bytes) {
  const digest = sha(bytes); assert.ok([ORIGINAL, PATCHED, ORIGINAL_MUSIC, PATCHED_MUSIC].includes(digest), 'unknown SoundManager ABC; preserve existing client');
  const patched = [PATCHED, PATCHED_MUSIC].includes(digest), battleMusic = [ORIGINAL_MUSIC, PATCHED_MUSIC].includes(digest);
  const p = parseActivityAbc(bytes), text = index => p.strings[p.names[index]?.name];
  assert.deepEqual([p.strings.length, p.names.length, p.methods.length], [patched ? 452 : 446, 84, 34]);
  assert.deepEqual(p.methodTraits.filter(t => text(t.owner) === 'SoundManager' && text(t.name) === 'init'), [{ owner: 4, name: 39, method: 11, kind: 65 }]);
  assert.equal(p.strings[p.namespaces[p.names[4].ns].name], 'ddt.manager');
  assert.deepEqual(p.names[39], { kind: 7, name: 60, ns: 1 });
  assert.deepEqual(p.namespaces[1], { kind: 5, name: 1 });
  assert.equal(p.strings[1], 'ddt.manager:SoundManager');
  assert.equal(p.strings[p.methods[11].name], 'ddt.manager:SoundManager/private:init');
  assert.deepEqual([p.methods[11].flags, p.methods[11].returnType, p.methods[11].params], [0, 26, []]);
  assert.equal(text(26), 'void');
  // QName 75 is the existing public initSound(String), never the private init trait.
  assert.deepEqual(p.names[75], { kind: 7, name: 415, ns: 2 });
  assert.equal(p.namespaces[2].kind, 22); assert.equal(p.strings[p.namespaces[2].name], ''); assert.equal(text(75), 'initSound');
  assert.deepEqual(p.methodTraits.filter(t => t.method === 13), [{ owner: 4, name: 75, method: 13, kind: 65 }]);
  assert.equal(p.strings[p.methods[13].name], 'ddt.manager:SoundManager/initSound');
  assert.deepEqual([p.methods[13].flags, p.methods[13].returnType, p.methods[13].params], [128, 26, [31]]);
  assert.equal(text(31), 'String');
  assert.equal(sha(p.bodies.find(b => b.method === 13).code), INIT_SOUND_CODE);
  const matches = p.bodies.filter(b => b.method === 11); assert.equal(matches.length, 1);
  const target = matches[0], extra = addition();
  assert.deepEqual([target.maxStack, target.localCount, target.initialScope, target.maxScope, target.length, target.exceptions], [4, 1, 4, 5, patched ? 2659 : 2617, 0]);
  const instructions = decodeCalendarCode(target.code);
  assert.equal(instructions.filter(i => i.op === 0x47).length, 1);
  assert.equal(instructions.at(-1).op, 0x47);
  assert.equal(instructions.filter(i => i.op >= 0x0c && i.op <= 0x1a).length, 0, 'init must remain branch-free');
  if (patched) {
    assert.deepEqual(p.strings.slice(446), IDS);
    assert.deepEqual(target.code.subarray(-1 - extra.length, -1), extra);
  } else for (const id of IDS) assert.equal(p.strings.indexOf(id), -1);
  const originalCode = patched ? cat(target.code.subarray(0, -1 - extra.length), target.code.subarray(-1)) : target.code;
  assert.equal(sha(originalCode), INIT_CODE);
  return { p, target, patched, battleMusic, originalCode, extra };
}

function patchAbc(bytes) {
  const before = inspect(bytes);
  if (before.patched) return { out: bytes, changed: false, battleMusic: before.battleMusic, unchangedMethods: before.p.bodies.length - 1 };
  const { p, target, extra } = before;
  const code = cat(target.code.subarray(0, -1), extra, target.code.subarray(-1));
  const pool = cat(u(452), bytes.subarray(p.stringDataOffset, p.stringPoolEnd), ...IDS.map(id => cat(u(3), Buffer.from(id))));
  const out = replace(bytes, [{ start: p.stringCountOffset, end: p.stringPoolEnd, data: pool }, { start: target.start, end: target.end, data: methodBody(bytes, target, code) }]);
  assert.equal(sha(out), before.battleMusic ? PATCHED_MUSIC : PATCHED, 'unexpected weapon audio registration output');
  const checked = inspect(out); assert.equal(checked.patched, true);
  assert.equal(checked.p.bodies.length, p.bodies.length);
  for (const body of p.bodies.filter(b => b.method !== 11)) {
    const after = checked.p.bodies.find(b => b.method === body.method); assert.ok(after);
    assert.deepEqual(out.subarray(after.start, after.end), bytes.subarray(body.start, body.end), 'unrelated SoundManager method changed');
  }
  const restored = replace(out, [
    { start: checked.p.stringCountOffset, end: checked.p.stringPoolEnd, data: cat(u(446), bytes.subarray(p.stringDataOffset, p.stringPoolEnd)) },
    { start: checked.target.start, end: checked.target.end, data: methodBody(out, checked.target, checked.originalCode) },
  ]);
  assert.deepEqual(restored, bytes, 'weapon audio registration changed bytes outside init and appended strings');
  return { out, changed: true, battleMusic: before.battleMusic, unchangedMethods: p.bodies.length - 1 };
}

export function patchWeaponAudioRegistration(bytes) {
  const swf = decompressSwf(bytes); assert.equal(swf.error, null);
  assert.equal(bytes.readUInt32LE(4), swf.body.length + 8, 'invalid weapon audio SWF declared length');
  const parsed = parseTags(swf.body); let found = 0, changed = false, unchangedMethods, battleMusic;
  const tags = parsed.tags.map(tag => {
    assert.ok(tag.bodyEnd <= swf.body.length, 'truncated weapon audio SWF tag');
    if (tag.code !== 82) return tag.raw;
    const payload = swf.body.subarray(tag.bodyStart, tag.bodyEnd), reader = new ByteReader(payload);
    reader.u32(); const name = reader.cstring();
    if (name !== TAG) return tag.raw;
    found++; const result = patchAbc(payload.subarray(reader.pos));
    changed = result.changed; unchangedMethods = result.unchangedMethods; battleMusic = result.battleMusic;
    return changed ? buildTag(82, cat(payload.subarray(0, reader.pos), result.out)) : tag.raw;
  });
  assert.equal(found, 1, 'expected one SoundManager DoABC tag');
  const out = changed ? compressSwf(swf.sig, swf.version, cat(parsed.headerPrefix, ...tags, parsed.trailing)) : bytes;
  const checked = parseTags(decompressSwf(out).body);
  assert.deepEqual(checked.headerPrefix, parsed.headerPrefix); assert.deepEqual(checked.trailing, parsed.trailing);
  assert.equal(checked.tags.length, parsed.tags.length);
  for (let i = 0; i < tags.length; i++) assert.deepEqual(checked.tags[i].raw, tags[i]);
  return { out, changed, proof: { tagName: TAG, methodIndex: 11, publicInitSoundQName: 75, soundIds: [...IDS], addedCodeBytes: 42,
    originalAbcSha256: battleMusic ? ORIGINAL_MUSIC : ORIGINAL, outputAbcSha256: battleMusic ? PATCHED_MUSIC : PATCHED, unchangedMethods, onlyInitBodyAndAppendedStringsChanged: true,
    allOtherSwfTagsByteIdentical: true, runtimeAccepted: false } };
}
