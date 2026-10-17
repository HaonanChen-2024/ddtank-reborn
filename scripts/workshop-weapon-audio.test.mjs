import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { ByteReader, buildTag, compressSwf, decompressSwf, parseTags } from '../tools/i18n/abc-strings/lib.mjs';
import { parseActivityAbc } from '../tools/i18n/abc-strings/activity-response.mjs';
import { decodeCalendarCode } from '../tools/i18n/abc-strings/activity-state.mjs';
import { patchWeaponAudioRegistration } from '../tools/i18n/abc-strings/weapon-audio.mjs';
import { literalOptions, runLiteralOverlay } from './workshop-literals.mjs';

const repo = resolve(import.meta.dirname, '..'), path = resolve(repo, '../../runtime/client-overlay/2.png');
const current = readFileSync(path), currentBefore = Buffer.from(current);
const input = readFileSync(resolve(repo, 'apps/api/assets/flash/2.png')), originalInput = Buffer.from(input), ids = ['252', '253', '254', '255', '256', '257'];
const tagName = 'ddt/manager/SoundManager';

function inspect(bytes) {
  const swf = decompressSwf(bytes); assert.equal(swf.error, null);
  const parsed = parseTags(swf.body), matching = [];
  for (let i = 0; i < parsed.tags.length; i++) {
    const tag = parsed.tags[i]; if (tag.code !== 82) continue;
    const payload = swf.body.subarray(tag.bodyStart, tag.bodyEnd), reader = new ByteReader(payload);
    reader.u32(); if (reader.cstring() !== tagName) continue;
    const prefix = payload.subarray(0, reader.pos), abc = payload.subarray(reader.pos), p = parseActivityAbc(abc);
    matching.push({ index: i, prefix, abc, p, init: p.bodies.find(b => b.method === 11) });
  }
  assert.equal(matching.length, 1); return { ...swf, ...parsed, ...matching[0] };
}
function rewrite(bytes, transform) {
  const before = inspect(bytes), tags = before.tags.map((tag, i) => i === before.index ? transform(before, tag) : tag.raw);
  return compressSwf(before.sig, before.version, Buffer.concat([before.headerPrefix, ...tags.flat(), before.trailing]));
}

test('real old SoundManager has private init and public initSound; only six fixed Sound IDs are appended', () => {
  const before = inspect(input), result = patchWeaponAudioRegistration(input), after = inspect(result.out);
  assert.equal(result.changed, true); assert.deepEqual(result.proof.soundIds, ids);
  assert.equal(result.proof.addedCodeBytes, 42); assert.equal(result.proof.unchangedMethods, 33);
  assert.equal(result.proof.onlyInitBodyAndAppendedStringsChanged, true);
  assert.equal(result.proof.allOtherSwfTagsByteIdentical, true); assert.equal(result.proof.runtimeAccepted, false);
  assert.equal(before.p.strings[before.p.methods[11].name], 'ddt.manager:SoundManager/private:init');
  assert.equal(before.p.namespaces[before.p.names[39].ns].kind, 5);
  const publicName = after.p.names[75];
  assert.equal(after.p.strings[publicName.name], 'initSound');
  assert.equal(after.p.namespaces[publicName.ns].kind, 22); assert.equal(after.p.strings[after.p.namespaces[publicName.ns].name], '');
  assert.deepEqual(after.p.strings.slice(0, 446), before.p.strings); assert.deepEqual(after.p.strings.slice(446), ids);
  const appended = decodeCalendarCode(after.init.code).slice(-19);
  assert.equal(appended.pop().op, 0x47);
  for (let i = 0; i < ids.length; i++) {
    const [receiver, argument, call] = appended.slice(i * 3, i * 3 + 3);
    assert.equal(receiver.op, 0xd0); assert.equal(argument.op, 0x2c);
    assert.equal(after.p.strings[argument.operands[0]], ids[i]); assert.equal(call.op, 0x4f); assert.deepEqual(call.operands, [75, 1]);
  }
  assert.equal(after.init.length - before.init.length, 42);
  assert.deepEqual(after.init.code.subarray(0, before.init.length - 1), before.init.code.subarray(0, -1));
  assert.deepEqual(after.init.code.subarray(-1), before.init.code.subarray(-1));
  for (const key of ['maxStack', 'localCount', 'initialScope', 'maxScope', 'exceptions']) assert.equal(after.init[key], before.init[key]);
  const currentResult = patchWeaponAudioRegistration(current);
  const currentAfter = inspect(currentResult.out);
  assert.deepEqual(currentAfter.init.code, after.init.code);
  // A later battle-music patch owns method 28; audio registration must preserve it verbatim.
  assert.deepEqual(currentAfter.p.bodies.find(b => b.method === 28).code, inspect(current).p.bodies.find(b => b.method === 28).code);
  assert.deepEqual(input, originalInput); assert.deepEqual(readFileSync(path), currentBefore);
});

test('all other SWF tags, SoundManager methods and ABC regions retain their original bytes', () => {
  const before = inspect(input), after = inspect(patchWeaponAudioRegistration(input).out);
  assert.equal(after.tags.length, before.tags.length); assert.deepEqual(after.headerPrefix, before.headerPrefix); assert.deepEqual(after.trailing, before.trailing);
  assert.deepEqual(after.prefix, before.prefix);
  for (let i = 0; i < before.tags.length; i++) if (i !== before.index) assert.deepEqual(after.tags[i].raw, before.tags[i].raw);
  for (const key of ['methods', 'names', 'namespaces', 'namespaceSets', 'methodTraits']) assert.deepEqual(after.p[key], before.p[key]);
  for (const b of before.p.bodies.filter(b => b.method !== 11)) {
    const next = after.p.bodies.find(e => e.method === b.method);
    assert.deepEqual(after.abc.subarray(next.start, next.end), before.abc.subarray(b.start, b.end));
  }
  assert.deepEqual(after.abc.subarray(0, after.p.stringCountOffset), before.abc.subarray(0, before.p.stringCountOffset));
  assert.deepEqual(after.abc.subarray(after.p.stringPoolEnd, after.init.start), before.abc.subarray(before.p.stringPoolEnd, before.init.start));
  assert.deepEqual(after.abc.subarray(after.init.end), before.abc.subarray(before.init.end));
  assert.deepEqual(after.abc.subarray(after.init.offset + after.init.length, after.init.end), before.abc.subarray(before.init.offset + before.init.length, before.init.end));
});

test('registration is byte-idempotent and also accepts the same unmodified ABC in the shipped base', () => {
  const once = patchWeaponAudioRegistration(input), twice = patchWeaponAudioRegistration(once.out);
  assert.equal(twice.changed, false); assert.strictEqual(twice.out, once.out); assert.deepEqual(twice.proof, once.proof);
  const source = readFileSync(resolve(repo, 'apps/api/assets/flash/2.png')), sourceBefore = Buffer.from(source);
  const base = patchWeaponAudioRegistration(source);
  assert.equal(base.changed, true); assert.deepEqual(inspect(base.out).abc, inspect(once.out).abc);
  assert.deepEqual(source, sourceBefore);
});

test('unknown original or patched SoundManager byte changes are rejected without mutating input', () => {
  for (const bytes of [input, patchWeaponAudioRegistration(input).out]) {
    for (const target of ['init', 'initSound', 'pool']) {
      const changed = rewrite(bytes, before => {
        const abc = Buffer.from(before.abc);
        const at = target === 'pool' ? before.p.stringDataOffset + 1 : before.p.bodies.find(b => b.method === (target === 'init' ? 11 : 13)).offset + 1;
        abc[at] ^= 1; return buildTag(82, Buffer.concat([before.prefix, abc]));
      });
      const snapshot = Buffer.from(changed);
      assert.throws(() => patchWeaponAudioRegistration(changed), /unknown SoundManager ABC/); assert.deepEqual(changed, snapshot);
    }
  }
});

test('missing or duplicate SoundManager, malformed SWF lengths and non-SWF input fail closed', () => {
  const absent = rewrite(input, () => []);
  assert.throws(() => patchWeaponAudioRegistration(absent), /expected one SoundManager/);
  const duplicate = rewrite(input, (_, tag) => [tag.raw, tag.raw]);
  assert.throws(() => patchWeaponAudioRegistration(duplicate), /expected one SoundManager/);
  const wrongLength = Buffer.from(input); wrongLength.writeUInt32LE(9, 4);
  assert.throws(() => patchWeaponAudioRegistration(wrongLength), /declared length/);
  assert.throws(() => patchWeaponAudioRegistration(Buffer.from('not a SWF')), /SWF signature/);
});

test('literal CLI accepts the weapon audio flag once and rejects duplicate or flagged rollback requests', () => {
  assert.equal(literalOptions(['install', '--weapon-audio']).weaponAudio, true);
  assert.equal(literalOptions(['--weapon-audio']).command, 'verify');
  assert.equal(literalOptions(['verify', '--weapon-audio']).weaponAudio, true);
  assert.equal(literalOptions(['verify']).weaponAudio, undefined);
  assert.throws(() => literalOptions(['install', '--weapon-audio', '--weapon-audio']), /duplicate weapon-audio/);
  assert.throws(() => literalOptions(['rollback', '--weapon-audio']), /rollback restores/);
  assert.throws(() => literalOptions(['verify', '--weapon-audio=false']), /usage:/);
});

for (const audioState of ['missing', 'corrupt']) test(`core rollback succeeds with ${audioState} audio while verify and install still fail closed`, t => {
  const prefix = join(tmpdir(), 'ddt-weapon-audio-rollback-'), runtimeRoot = mkdtempSync(prefix);
  t.after(() => {
    assert.equal(dirname(resolve(runtimeRoot)), resolve(tmpdir()));
    assert.ok(runtimeRoot.startsWith(prefix));
    rmSync(runtimeRoot, { recursive: true, force: true });
  });
  const overlay = join(runtimeRoot, 'client-overlay'), backupDir = join(runtimeRoot, 'backups');
  mkdirSync(overlay); mkdirSync(backupDir);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const originals = new Map(), files = ['2.png', '3.png', 'DDT_Loading.swf'].map(name => {
    const original = readFileSync(join(repo, 'apps/api/assets/flash', name)); originals.set(name, original);
    const installed = name === '2.png' ? patchWeaponAudioRegistration(original).out : original;
    const backup = join(backupDir, name);
    writeFileSync(backup, original); writeFileSync(join(overlay, name), installed);
    return { name, backup, hadOverlay: true, sourceSha256: hash(original), sha256: hash(installed) };
  });
  const ledger = join(runtimeRoot, 'client-overlay-literals.json');
  const journalBytes = Buffer.from(JSON.stringify({ weaponAudio: true, files }));
  writeFileSync(ledger, journalBytes);
  const audio = join(overlay, 'audio.swf'), corrupt = Buffer.from('not an SWF audio file');
  if (audioState === 'corrupt') writeFileSync(audio, corrupt);
  const run = options => runLiteralOverlay({ repoRoot: repo, runtimeRoot, ...options });
  for (const command of ['verify', 'install']) {
    assert.throws(() => run({ command }), audioState === 'missing' ? /ENOENT/ : /SWF signature/);
    assert.deepEqual(readFileSync(ledger), journalBytes);
    for (const entry of files) assert.equal(hash(readFileSync(join(overlay, entry.name))), entry.sha256);
  }
  assert.deepEqual(run({ command: 'rollback' }), { rolledBack: true, files: 3, restartRequired: true });
  assert.equal(existsSync(ledger), false);
  for (const entry of files) {
    assert.deepEqual(readFileSync(join(overlay, entry.name)), originals.get(entry.name));
    assert.deepEqual(readFileSync(entry.backup), originals.get(entry.name));
  }
  if (audioState === 'missing') assert.equal(existsSync(audio), false);
  else assert.deepEqual(readFileSync(audio), corrupt);
});
