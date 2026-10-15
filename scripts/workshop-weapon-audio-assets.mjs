// Build-only: append six original weapon sounds without replacing the shared audio library.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { ByteReader, buildTag, compressSwf, decompressSwf, parseTags } from '../tools/i18n/abc-strings/lib.mjs';
import { scan, sha, q, pinned } from './native-pair/build-library.mjs';
import { decode } from './native-pair/audit-candidate.mjs';
import { zipRecords } from './workshop-bag-layout.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const weaponAudioNames = Object.freeze(['Sound252', 'Sound253', 'Sound254', 'Sound255', 'Sound256', 'Sound257']);
export const weaponAudioPins = Object.freeze({
  base: '2d03a52789d09e201992be8843aec00f42d2046e681955c9d01f6ad0b0196d8f',
  original: 'b6340a42e0977dbc9abab28fbf1ca51ca995a43e04a5f7ba6b955f49bc75241e',
  compiler: 'cc07d749e376715e650271a9875289e49d94234902fff5e5fae287c478c8557b',
  player: '7d4d6168d27603cfb3b750302448e354e0bbc1bdd58f5d101c3dcf6891e9bb65',
});
// Original DefineSound bytes after CharacterID; includes flags, sample count and compressed MP3.
const audioDataPins = Object.freeze([
  'ab2025f8274b815b180f1b51a1973a2d68a002cf14feff2614273b47f5f5b931',
  '470daed6b9e578742a0a8cd1a86bd7561a2f4a2602fbf57c7480cf4dc93d3981',
  '1e5419ad9cad993b555e2cbd62a8a9da74172b66999e430470a176449c1f9ce0',
  '9329537c75aedd11cf923d5d0d2a73ede0a45b50116e4dfd1d0f20ad419b6565',
  '2ea73e7274f616b10686c7b2ba9a5aef73e58c104e935acabc67337d5f006aec',
  'b5928af9de6e83d59466f6ecebfd5b16b00804aa5880b2abba1d0c8152a9be90',
]);
// Fixed compiler/player toolchain and six reviewed super()-only sources, not donor business ABC.
const classAbcPins = Object.freeze([
  '139eeaa3f738f2d9910d141d1c562655cad4a3c17e3ff9f1ee84a3a38b5591f0',
  'e95b5ab5c617f4c0f0c01596392dd759bb86e839b9d4a2edc685fb7b34d7c5d4',
  '16d95654b7808fd085216f8ff5dfea363d0f6a9adee9663f4f8d69d0c55e3df1',
  '9241a5917253815bf9001b72de17d742893d0eda8c02aef0115242a0afee2979',
  '65e5d62fe7b4613472dbf97154e7a9eaac400bd66c87edefb09d0e0b3e663832',
  '3333beebe1b0fd049600e92c6a6b8a666d15420f6b89823d071a94ffdd9b37df',
]);

function symbols(swf) {
  return swf.tags.filter(t => t.code === 76).flatMap(t => {
    const r = new ByteReader(swf.body.subarray(t.bodyStart, t.bodyEnd)), rows = [];
    for (let n = r.u16(); n; n--) { const id = r.u16(); assert(r.buf.indexOf(0, r.pos) >= r.pos, 'unterminated sound symbol'); rows.push({ id, name: r.cstring() }); }
    assert.equal(r.pos, r.buf.length, 'unread sound symbols'); return rows;
  });
}

function checkedSwf(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length >= 8, 'SWF buffer required');
  // Validate tag framing before the existing scanner reads null-terminated ABC names.
  const swf = decompressSwf(bytes); assert.equal(swf.error, null); assert.equal(bytes.readUInt32LE(4), swf.body.length + 8, 'SWF declared size');
  const parsed = parseTags(swf.body); assert.equal(parsed.tags.at(-1)?.code, 0, 'SWF End required'); assert.equal(parsed.trailing.length, 0, 'unexpected SWF trailing bytes');
  for (const t of parsed.tags) {
    assert(t.bodyEnd <= swf.body.length && t.raw.length === t.bodyEnd - t.headerStart, 'truncated SWF tag');
    if (t.code === 82) { const body = swf.body.subarray(t.bodyStart, t.bodyEnd); assert(body.length >= 5 && body.indexOf(0, 4) >= 4, 'unterminated ABC name'); }
  }
  return scan(bytes);
}

function classAbcs(glueBytes) {
  const glue = checkedSwf(glueBytes), wanted = new Set(weaponAudioNames.map(n => '::' + n));
  assert.equal(glue.tags.filter(t => t.code === 14).length, 0, 'glue must not contain compiler-encoded sounds');
  const selected = glue.abcs.filter(a => a.p.traitBlocks.some(t => t.owner != null && wanted.has(q(a.p, t.owner))));
  assert.equal(selected.length, 6, 'six separate sound classes required');
  const classes = selected.flatMap(a => a.p.traitBlocks.filter(t => t.owner != null).map(t => q(a.p, t.owner)));
  assert.deepEqual(classes.sort(), [...wanted].sort(), 'no additional classes in selected ABCs');
  const allowedNames = new Set(['::Object', 'flash.events::EventDispatcher', 'flash.media::Sound', ...wanted]);
  const allowedOps = new Set([0xd0, 0x30, 0x47, 0x49, 0x65, 0x5d, 0x66, 0x60, 0x58, 0x1d, 0x68]);
  for (const a of selected) {
    const index = weaponAudioNames.indexOf(a.name); assert(index >= 0, 'unexpected sound ABC owner');
    assert.equal(sha(a.abc), classAbcPins[index], 'sound class glue changed');
    assert.deepEqual(a.prefix, Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from(a.name + '\0')]), 'sound ABC prefix changed');
    assert.equal(a.p.methods.length, 3, 'sound class must only have constructor, class and script initializers');
    assert.equal(a.p.bodies.length, 3);
    assert(a.p.traitBlocks.filter(t => t.owner != null).every(t => t.count === 0), 'sound instances have no business traits');
    assert(a.p.methods.every(m => m.params.length === 0 && m.flags === 0), 'sound wrapper methods take no parameters');
    let constructors = 0;
    for (const b of a.p.bodies) {
      assert.equal(b.exceptions, 0, 'sound wrapper has no exception handlers');
      const ops = decode(b.code); assert(ops.every(o => allowedOps.has(o.op)), 'nontrivial sound wrapper bytecode');
      if (ops.some(o => o.op === 0x49)) { assert.equal(b.code.toString('hex'), 'd030d0490047', 'constructor must only call super()'); constructors++; }
      for (const o of ops.filter(o => [0x5d, 0x66, 0x60, 0x68].includes(o.op))) assert(allowedNames.has(q(a.p, o.args[0])), 'unexpected sound wrapper dependency');
    }
    assert.equal(constructors, 1);
  }
  return { glue, selected: selected.sort((a, b) => a.name.localeCompare(b.name)) };
}

export function verifyWeaponAudioAssets(bytes) {
  const base = checkedSwf(pinned(resolve(repo, 'vendor/DDTank41/Source Flash/FlashSV1/audio.swf'), weaponAudioPins.base));
  const merged = checkedSwf(bytes), oldSymbols = symbols(base), mergedSymbols = symbols(merged);
  assert.equal(merged.sig, base.sig, 'audio compression format changed'); assert.equal(merged.version, base.version, 'audio SWF version changed');
  assert.deepEqual(merged.headerPrefix, base.headerPrefix, 'audio frame header changed'); assert.deepEqual(merged.trailing, base.trailing);
  const oldTable = base.tags.find(t => t.code === 76); assert.equal(merged.tags.filter(t => t.code === 76).length, 1, 'exactly one SymbolClass required');
  const oldIds = base.tags.filter(t => t.code === 14).map(t => base.body.readUInt16LE(t.bodyStart)), firstId = Math.max(...oldIds, ...oldSymbols.map(s => s.id)) + 1;
  const additions = weaponAudioNames.map((name, i) => ({ name, id: firstId + i }));
  assert.deepEqual(mergedSymbols, [...oldSymbols, ...additions], 'old and added sound symbols must match exactly');
  const newTags = additions.map((s, i) => {
    const found = merged.tags.filter(t => t.code === 14 && merged.body.readUInt16LE(t.bodyStart) === s.id); assert.equal(found.length, 1, 'one new DefineSound required');
    const payload = merged.body.subarray(found[0].bodyStart, found[0].bodyEnd);
    assert.equal(sha(payload.subarray(2)), audioDataPins[i], 'original compressed sound changed: ' + s.name);
    return found[0];
  });
  const newAbcs = additions.map((s, i) => {
    const found = merged.abcs.filter(a => a.name === s.name); assert.equal(found.length, 1, 'one new sound ABC required');
    assert.equal(sha(found[0].abc), classAbcPins[i], 'sound class ABC changed: ' + s.name);
    assert.deepEqual(found[0].prefix, Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from(s.name + '\0')]), 'sound ABC prefix changed');
    return merged.tags.filter(t => t.code === 82)[merged.abcs.indexOf(found[0])];
  });
  const table = merged.tags.find(t => t.code === 76), tableBytes = merged.body.subarray(table.bodyStart, table.bodyEnd), oldTableBytes = base.body.subarray(oldTable.bodyStart, oldTable.bodyEnd);
  assert.deepEqual(tableBytes.subarray(2, oldTableBytes.length), oldTableBytes.subarray(2), 'old SymbolClass row bytes changed');
  const expected = base.tags.flatMap(t => t === oldTable ? [...newTags.map(x => x.raw), ...newAbcs.map(x => x.raw), table.raw] : [t.raw]);
  assert.deepEqual(merged.tags.map(t => sha(t.raw)), expected.map(sha), 'old audio tags or incremental tag order changed');
  assert.deepEqual(merged.abcs.slice(0, base.abcs.length).map(a => sha(a.abc)), base.abcs.map(a => sha(a.abc)), 'old audio methods changed');
  return { valid: true, sha256: sha(bytes), bytes: bytes.length, sourceSha256: weaponAudioPins.original, baseSha256: weaponAudioPins.base, oldSoundCount: oldIds.length, addedSoundCount: 6, symbols: additions, allOldTagsExceptSymbolTableUnchanged: true, originalCompressedAudioUnchanged: true, playbackVerified: false };
}

export function patchWeaponAudioAssets(baseBytes, originalBytes, glueBytes) {
  assert.equal(sha(baseBytes), weaponAudioPins.base, 'base audio changed');
  assert.equal(sha(originalBytes), weaponAudioPins.original, 'original battle audio changed');
  const base = checkedSwf(baseBytes), original = checkedSwf(originalBytes), glue = classAbcs(glueBytes);
  const oldSymbols = symbols(base), sourceSymbols = symbols(original), symbolTags = base.tags.filter(t => t.code === 76);
  assert.equal(symbolTags.length, 1, 'one existing SymbolClass table required');
  assert.equal(new Set(oldSymbols.map(s => s.name)).size, oldSymbols.length, 'duplicate existing sound symbols');
  assert(!oldSymbols.some(s => weaponAudioNames.includes(s.name)), 'target sound already exists');
  assert(!base.abcs.some(a => a.p.traitBlocks.some(t => t.owner != null && weaponAudioNames.includes(q(a.p, t.owner).replace(/^::/, '')))), 'target sound class already exists');
  const originalSounds = original.tags.filter(t => t.code === 14), oldSounds = base.tags.filter(t => t.code === 14);
  // This fixed shared library only defines Sound characters. Unknown character-bearing tags fail closed.
  assert(base.tags.every(t => [0, 1, 9, 14, 45, 69, 76, 82, 86].includes(t.code)), 'unexpected base audio tag');
  const oldIds = oldSounds.map(t => base.body.readUInt16LE(t.bodyStart));
  assert.equal(new Set(oldIds).size, oldIds.length, 'duplicate existing sound IDs');
  let nextId = Math.max(0, ...oldIds, ...oldSymbols.map(s => s.id)) + 1;
  assert(nextId + 5 <= 65535, 'sound CharacterID exhausted');
  const rows = weaponAudioNames.map(name => {
    const matches = sourceSymbols.filter(s => s.name === name); assert.equal(matches.length, 1, 'one original sound symbol required');
    const found = originalSounds.filter(t => original.body.readUInt16LE(t.bodyStart) === matches[0].id); assert.equal(found.length, 1, 'one original DefineSound required');
    const tag = found[0], sourcePayload = original.body.subarray(tag.bodyStart, tag.bodyEnd); assert(sourcePayload.length > 9 && sourcePayload[2] >> 4 === 2, 'original MP3 DefineSound required');
    const payload = Buffer.from(sourcePayload), id = nextId++; payload.writeUInt16LE(id);
    assert.deepEqual(payload.subarray(2), sourcePayload.subarray(2), 'original sound bytes must stay exact');
    return { name, id, sourceId: matches[0].id, sourcePayload, payload, tag: buildTag(14, payload) };
  });
  const table = symbolTags[0], oldTable = base.body.subarray(table.bodyStart, table.bodyEnd), count = Buffer.alloc(2); count.writeUInt16LE(oldSymbols.length + 6);
  const appendedRows = rows.flatMap(r => { const id = Buffer.alloc(2); id.writeUInt16LE(r.id); return [id, Buffer.from(r.name + '\0')]; });
  const newTable = buildTag(76, Buffer.concat([count, oldTable.subarray(2), ...appendedRows]));
  const glueTags = glue.selected.map(a => glue.glue.tags.filter(t => t.code === 82)[glue.glue.abcs.indexOf(a)].raw);
  const out = compressSwf(base.sig, base.version, Buffer.concat([base.headerPrefix, ...base.tags.flatMap(t => t === table ? [...rows.map(r => r.tag), ...glueTags, newTable] : [t.raw]), base.trailing]));
  const checked = checkedSwf(out), kept = checked.tags.filter(t => t.code !== 76 && !rows.some(r => t.code === 14 && checked.body.readUInt16LE(t.bodyStart) === r.id) && !glueTags.some(raw => t.raw.equals(raw)));
  assert.deepEqual(checked.headerPrefix, base.headerPrefix); assert.deepEqual(checked.trailing, base.trailing);
  assert.deepEqual(kept.map(t => sha(t.raw)), base.tags.filter(t => t !== table).map(t => sha(t.raw)), 'all old tags except extended SymbolClass must remain exact');
  assert.deepEqual(symbols(checked), [...oldSymbols, ...rows.map(r => ({ id: r.id, name: r.name }))], 'original SymbolClass row order preserved');
  assert.deepEqual(checked.abcs.slice(0, base.abcs.length).map(a => sha(a.abc)), base.abcs.map(a => sha(a.abc)), 'old ABCs unchanged');
  const metadata = {
    version: 1, kind: 'original-weapon-audio-increment', baseSha256: sha(baseBytes), sourceSha256: sha(originalBytes), outputSha256: sha(out), bytes: out.length,
    oldSoundCount: oldSounds.length, addedSoundCount: rows.length, oldSymbolCount: oldSymbols.length, outputSymbolCount: symbols(checked).length,
    oldTagsPreserved: base.tags.length - 1, extendedTag: 'SymbolClass', oldSymbolRowsByteIdentical: true, allOldAbcsByteIdentical: true, originalCompressedAudioUnchanged: true,
    sounds: rows.map(r => ({ symbol: r.name, sourceCharacterId: r.sourceId, characterId: r.id, tagCode: 14, originalPayloadSha256: sha(r.sourcePayload), audioDataSha256: sha(r.sourcePayload.subarray(2)), mergedPayloadSha256: sha(r.payload), payloadBytes: r.payload.length, onlyCharacterIdChanged: true })),
    classGlues: glue.selected.map(a => ({ name: a.name, abcSha256: sha(a.abc), methodCount: a.p.bodies.length, pureSuperConstructor: true })),
    wholeReferenceAudioImported: false, installed: false, playbackVerified: false,
  };
  verifyWeaponAudioAssets(out);
  return { out, metadata };
}

export function buildOriginalWeaponAudioAssets({ projectRoot = resolve(repo, '../..'), outputDir, javaPath = 'C:/Users/11322/.jdks/openjdk-22.0.1/bin/java.exe' } = {}) {
  assert(outputDir, 'fresh candidate output directory required');
  const p = resolve(projectRoot), out = resolve(outputDir); assert(out.startsWith(resolve(p, 'runtime') + sep), 'candidate must be inside project runtime');
  mkdirSync(out); mkdirSync(resolve(out, 'sources'));
  for (const name of weaponAudioNames) writeFileSync(resolve(out, 'sources', name + '.as'), `package { import flash.media.Sound; public dynamic class ${name} extends Sound { public function ${name}() { super(); } } }\n`, { flag: 'wx' });
  const compiler = resolve(p, 'runtime/tools/flex-min/lib/mxmlc.jar'), player = resolve(p, 'downloads/flex/playerglobal32_0.swc');
  pinned(compiler, weaponAudioPins.compiler); pinned(player, weaponAudioPins.player);
  const swcPath = resolve(out, 'weapon-sound-class-glue.swc'), args = ['-cp', compiler, 'flex2.tools.Compc', '-load-config=', '-compiler.theme=', '-compiler.fonts.local-fonts-snapshot=', '-compiler.library-path=', '-compiler.external-library-path=' + player, '-compiler.source-path=' + resolve(out, 'sources'), '-target-player=10.0', '-swf-version=10', '-debug=false', '-include-classes=' + weaponAudioNames.join(','), '-output=' + swcPath];
  const compiled = spawnSync(javaPath, args, { windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  writeFileSync(resolve(out, 'compiler.log'), String(compiled.stdout ?? '') + String(compiled.stderr ?? ''), { flag: 'wx' });
  assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
  const zip = readFileSync(swcPath), record = zipRecords(zip).records.find(r => r.name === 'library.swf'); assert(record, 'class glue library missing');
  const method = zip.readUInt16LE(record.local + 8), raw = zip.subarray(record.data, record.data + record.compressedSize); assert([0, 8].includes(method), 'unsupported SWC compression');
  const glueBytes = method === 0 ? raw : inflateRawSync(raw); writeFileSync(resolve(out, 'weapon-sound-class-glue.swf'), glueBytes, { flag: 'wx' });
  const basePath = resolve(p, 'source/ddtank-reborn/vendor/DDTank41/Source Flash/FlashSV1/audio.swf'), sourcePath = resolve(p, 'runtime/weapon-original-effects-20261015/cream-reference/audiobattle.swf');
  const result = patchWeaponAudioAssets(pinned(basePath, weaponAudioPins.base), pinned(sourcePath, weaponAudioPins.original), glueBytes);
  const file = 'audio-with-original-cream-sounds.swf'; writeFileSync(resolve(out, file), result.out, { flag: 'wx' });
  const manifest = { ...result.metadata, file, basePath, sourcePath, glueFile: 'weapon-sound-class-glue.swf', glueSha256: sha(glueBytes), compilerExitCode: compiled.status, registrationRequired: true };
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { ...result, manifest, outputDir: out, path: resolve(out, file) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildOriginalWeaponAudioAssets({ outputDir: process.argv[2], projectRoot: process.argv[3], javaPath: process.argv[4] });
  console.log(JSON.stringify({ path: result.path, sha256: result.manifest.outputSha256, sounds: result.manifest.sounds, installed: false }, null, 2));
}
