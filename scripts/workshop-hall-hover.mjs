// Reuse the night hall's matching hover art without importing its timeline or scripts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decompressSwf, parseTags, buildTag, compressSwf } from '../tools/i18n/abc-strings/lib.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const reviewed = JSON.parse(readFileSync(new URL('../research/i18n/hall-hover/night.zh-CN.json', import.meta.url)));

function scan(bytes) {
  const decoded = decompressSwf(bytes);
  assert.equal(decoded.error, null, 'invalid hall SWF');
  assert.equal(bytes.readUInt32LE(4), decoded.body.length + 8, 'invalid SWF length');
  const parsed = parseTags(decoded.body);
  assert.equal(parsed.tags.at(-1)?.code, 0, 'missing SWF End tag');
  assert.equal(parsed.trailing.length, 0, 'unexpected SWF trailing data');
  for (const tag of parsed.tags) assert.ok(tag.bodyEnd <= decoded.body.length, 'truncated SWF tag');
  return { ...decoded, ...parsed };
}

function definition(swf, tagCode, id) {
  const matches = swf.tags.filter(tag => tag.code === tagCode && tag.bodyEnd - tag.bodyStart >= 2 && swf.body.readUInt16LE(tag.bodyStart) === id);
  assert.equal(matches.length, 1, 'missing or duplicate hall definition: ' + id);
  const tag = matches[0];
  return { tag, payload: swf.body.subarray(tag.bodyStart, tag.bodyEnd) };
}

export function patchHallHover(bytes, donorBytes, manifest = reviewed) {
  assert.equal(manifest.version, 1);
  assert.equal(sha256(donorBytes), manifest.donorSha256, 'night hall donor changed');
  const source = scan(bytes), donor = scan(donorBytes), replacements = new Map(), targets = new Set(), changes = [];
  // Preserve newer independent captions/tutorial fixes, but refuse a different hall skin/timeline.
  for (const anchor of [manifest.background, manifest.mainSprite]) {
    assert.equal(sha256(definition(source, anchor.tagCode, anchor.targetId).tag.raw), anchor.sha256, 'hall background/timeline changed');
  }
  for (const entry of manifest.entries) {
    assert.ok([21, 35, 36, 22].includes(entry.tagCode), 'unsupported reviewed hall tag');
    assert.ok(!targets.has(entry.targetId), 'duplicate target'); targets.add(entry.targetId);
    const old = definition(source, entry.tagCode, entry.targetId), original = definition(donor, entry.tagCode, entry.donorId);
    assert.equal(sha256(original.tag.raw), entry.donorTagSha256, 'donor definition changed');
    const payload = Buffer.from(original.payload); payload.writeUInt16LE(entry.targetId);
    for (const ref of entry.references) {
      assert.equal(entry.tagCode, 22, 'only reviewed tooltip shape has references');
      assert.ok(ref.offset >= 2 && ref.offset + 2 <= payload.length, 'reference outside shape');
      assert.equal(payload.readUInt16LE(ref.offset), ref.donorId, 'tooltip bitmap reference changed');
      assert.equal(definition(source, ref.targetId === 177 ? 35 : 36, ref.targetId).payload.readUInt16LE(), ref.targetId);
      payload.writeUInt16LE(ref.targetId, ref.offset);
    }
    const replacement = buildTag(entry.tagCode, payload), currentHash = sha256(old.tag.raw);
    assert.equal(sha256(replacement), entry.installedTagSha256, 'unexpected transplanted tag');
    assert.ok(currentHash === entry.sourceTagSha256 || currentHash === entry.installedTagSha256, 'target changed; preserve existing work: ' + entry.targetId);
    if (currentHash !== entry.installedTagSha256) {
      replacements.set(old.tag.headerStart, replacement);
      changes.push({ targetId: entry.targetId, donorId: entry.donorId, kind: entry.kind });
    }
  }
  const out = replacements.size ? compressSwf(source.sig, source.version, Buffer.concat([
    source.headerPrefix, ...source.tags.map(tag => replacements.get(tag.headerStart) ?? tag.raw), source.trailing,
  ])) : bytes;
  return { out, changes, sourceSha256: sha256(bytes), installedSha256: sha256(out) };
}
