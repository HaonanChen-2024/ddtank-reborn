import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildTag, compressSwf } from '../tools/i18n/abc-strings/lib.mjs';
import { scan, sha } from './native-pair/build-library.mjs';
import { buildOriginalWeaponAudioAssets, patchWeaponAudioAssets, verifyWeaponAudioAssets, weaponAudioNames, weaponAudioPins } from './workshop-weapon-audio-assets.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), p = resolve(repo, '../..');
const root = resolve(p, 'runtime/weapon-original-effects-20261015/cream-reference');
const basePath = resolve(repo, 'vendor/DDTank41/Source Flash/FlashSV1/audio.swf'), sourcePath = resolve(root, 'audiobattle.swf');
const available = existsSync(basePath) && existsSync(sourcePath);

describe('original weapon audio real-resource regression', { skip: available ? false : 'requires the fixed local base and anonymously acquired audiobattle.swf fixture' }, () => {
  let candidate, base, original, glue, parsed;
  before(() => {
    base = readFileSync(basePath); original = readFileSync(sourcePath);
    candidate = buildOriginalWeaponAudioAssets({ projectRoot: p, outputDir: resolve(root, 'test-candidate-' + randomUUID()) });
    glue = readFileSync(resolve(candidate.outputDir, candidate.manifest.glueFile)); parsed = scan(candidate.out);
  });
  const mutate = fn => compressSwf(parsed.sig, parsed.version, Buffer.concat([parsed.headerPrefix, ...fn(parsed.tags), parsed.trailing]));
  const changeTag = (predicate, fn) => mutate(tags => tags.map(t => predicate(t) ? fn(t) : t.raw));

  test('rebuild preserves the original 132 sounds and all old methods while adding exactly six sounds', () => {
    const checked = verifyWeaponAudioAssets(candidate.out);
    assert.equal(checked.oldSoundCount, 132); assert.equal(checked.addedSoundCount, 6);
    assert.deepEqual(checked.symbols.map(s => s.name), weaponAudioNames);
    assert.deepEqual(checked.symbols.map(s => s.id), [133, 134, 135, 136, 137, 138]);
    assert.equal(candidate.manifest.outputSha256, 'eb07d14f76d9900abb9358ed064130ef5fb3bd60b3350d0f223682000fb7dc65');
    assert(candidate.manifest.originalCompressedAudioUnchanged); assert(candidate.manifest.allOldAbcsByteIdentical);
    assert.equal(sha(readFileSync(basePath)), weaponAudioPins.base); assert.equal(sha(readFileSync(sourcePath)), weaponAudioPins.original);
  });

  test('second pure build is deterministic and keeps all six compressed payloads except CharacterID', () => {
    const again = patchWeaponAudioAssets(base, original, glue);
    assert.deepEqual(again.out, candidate.out); assert.deepEqual(again.metadata, candidate.metadata);
    const donor = scan(original);
    for (const sound of candidate.metadata.sounds) {
      const from = donor.tags.find(t => t.code === 14 && donor.body.readUInt16LE(t.bodyStart) === sound.sourceCharacterId);
      const to = parsed.tags.find(t => t.code === 14 && parsed.body.readUInt16LE(t.bodyStart) === sound.characterId);
      assert.deepEqual(donor.body.subarray(from.bodyStart + 2, from.bodyEnd), parsed.body.subarray(to.bodyStart + 2, to.bodyEnd));
    }
  });

  test('one mutated compressed MP3 byte is rejected', () => {
    const altered = changeTag(t => t.code === 14 && parsed.body.readUInt16LE(t.bodyStart) === 133, t => {
      const payload = Buffer.from(parsed.body.subarray(t.bodyStart, t.bodyEnd)); payload[payload.length - 1] ^= 1; return buildTag(14, payload);
    });
    assert.throws(() => verifyWeaponAudioAssets(altered), /original compressed sound changed/);
  });

  test('changing an unrelated old sound is rejected', () => {
    const altered = changeTag(t => t.code === 14 && parsed.body.readUInt16LE(t.bodyStart) === 1, t => {
      const payload = Buffer.from(parsed.body.subarray(t.bodyStart, t.bodyEnd)); payload[payload.length - 1] ^= 1; return buildTag(14, payload);
    });
    assert.throws(() => verifyWeaponAudioAssets(altered), /old audio tags/);
  });

  test('missing and duplicated new Sound class ABCs are rejected', () => {
    const selected = parsed.tags.filter(t => t.code === 82)[parsed.abcs.findIndex(a => a.name === 'Sound252')];
    assert.throws(() => verifyWeaponAudioAssets(mutate(tags => tags.filter(t => t !== selected).map(t => t.raw))), /one new sound ABC/);
    assert.throws(() => verifyWeaponAudioAssets(mutate(tags => tags.flatMap(t => t === selected ? [t.raw, t.raw] : [t.raw]))), /one new sound ABC/);
  });

  test('changing a new class method or its superclass pool is rejected', () => {
    const abcIndex = parsed.abcs.findIndex(a => a.name === 'Sound252'), target = parsed.tags.filter(t => t.code === 82)[abcIndex];
    const altered = changeTag(t => t === target, t => {
      const payload = Buffer.from(parsed.body.subarray(t.bodyStart, t.bodyEnd));
      payload[parsed.abcs[abcIndex].prefix.length + parsed.abcs[abcIndex].p.bodies[0].offset] = 0xd1;
      return buildTag(82, payload);
    });
    assert.throws(() => verifyWeaponAudioAssets(altered), /sound class ABC changed/);
  });

  test('missing Sound linkage and a second SymbolClass table are rejected', () => {
    const target = parsed.tags.find(t => t.code === 76);
    const renamed = changeTag(t => t === target, t => {
      const payload = Buffer.from(parsed.body.subarray(t.bodyStart, t.bodyEnd));
      const at = payload.indexOf(Buffer.from('Sound252\0')); assert(at > 0); payload[at + 7] = '9'.charCodeAt(0); return buildTag(76, payload);
    });
    assert.throws(() => verifyWeaponAudioAssets(renamed), /sound symbols must match exactly/);
    assert.throws(() => verifyWeaponAudioAssets(mutate(tags => tags.flatMap(t => t === target ? [t.raw, t.raw] : [t.raw]))), /exactly one SymbolClass/);
  });

  test('whole donor business ABC or an unknown extra tag is rejected', () => {
    const donorAbc = scan(original).tags.find(t => t.code === 82).raw;
    const altered = mutate(tags => tags.flatMap(t => t.code === 0 ? [donorAbc, t.raw] : [t.raw]));
    assert.throws(() => verifyWeaponAudioAssets(altered), /old audio tags/);
    assert.throws(() => verifyWeaponAudioAssets(mutate(tags => tags.flatMap(t => t.code === 0 ? [buildTag(77, Buffer.from('extra')), t.raw] : [t.raw]))), /old audio tags/);
  });

  test('new tag order and existing frame header are checked', () => {
    const reversed = mutate(tags => {
      const result = tags.map(t => t.raw), selected = tags.map((t, i) => [t, i]).filter(([t]) => t.code === 14 && parsed.body.readUInt16LE(t.bodyStart) >= 133);
      [result[selected[0][1]], result[selected[1][1]]] = [result[selected[1][1]], result[selected[0][1]]]; return result;
    });
    assert.throws(() => verifyWeaponAudioAssets(reversed), /incremental tag order/);
    const header = Buffer.from(parsed.headerPrefix); header[header.length - 1] ^= 1;
    assert.throws(() => verifyWeaponAudioAssets(compressSwf(parsed.sig, parsed.version, Buffer.concat([header, ...parsed.tags.map(t => t.raw)]))), /frame header changed/);
  });

  test('base-only, unpinned source/base/glue and corrupt declared length are rejected', () => {
    assert.throws(() => verifyWeaponAudioAssets(base), /sound symbols must match exactly/);
    const badBase = Buffer.from(base); badBase[badBase.length - 1] ^= 1;
    const badOriginal = Buffer.from(original); badOriginal[badOriginal.length - 1] ^= 1;
    assert.throws(() => patchWeaponAudioAssets(badBase, original, glue), /base audio changed/);
    assert.throws(() => patchWeaponAudioAssets(base, badOriginal, glue), /original battle audio changed/);
    assert.throws(() => patchWeaponAudioAssets(base, original, original), /glue must not contain/);
    const badLength = Buffer.from(candidate.out); badLength.writeUInt32LE(badLength.readUInt32LE(4) + 1, 4);
    assert.throws(() => verifyWeaponAudioAssets(badLength), /declared size/);
  });

  test('an unterminated ABC name fails before the shared scanner reads its bytecode', () => {
    const target = parsed.tags.filter(t => t.code === 82).at(-1);
    assert.throws(() => verifyWeaponAudioAssets(changeTag(t => t === target, () => buildTag(82, Buffer.from([1, 0, 0, 0, 65, 65, 65])))), /unterminated ABC name/);
  });

  test('build-only output cannot overwrite an existing candidate directory or escape runtime', () => {
    assert.throws(() => buildOriginalWeaponAudioAssets({ projectRoot: p, outputDir: candidate.outputDir }), /EEXIST/);
    assert.throws(() => buildOriginalWeaponAudioAssets({ projectRoot: p, outputDir: resolve(repo, 'audio-candidate') }), /inside project runtime/);
  });
});
