// Restore the existing Chinese NoEnergyAsset text without changing combat art or timelines.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decompressSwf, parseTags, buildTag, compressSwf, skipRect } from '../tools/i18n/abc-strings/lib.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function patchGameEnergyText(currentBytes, referenceBytes) {
  assert.equal(hash(currentBytes), 'c6cab9efbdd1e540fc42729440db558b096aa9d3eaefc51b9a75e8e779cf6ee8', 'game overlay changed; preserve newer work');
  assert.equal(hash(referenceBytes), 'c5f90921f8c04ec48ad790ed64c455ae1aecabb68f9b4927281b2a857c887d01', 'Chinese reference changed');
  const scan = bytes => { const s = decompressSwf(bytes); assert.equal(s.error, null); return { ...s, ...parseTags(s.body) }; };
  const current = scan(currentBytes), reference = scan(referenceBytes);
  const find = (swf, code, id) => { const matches = swf.tags.filter(t => t.code === code && swf.body.readUInt16LE(t.bodyStart) === id); assert.equal(matches.length, 1); return matches[0]; };
  const body = (swf, tag) => swf.body.subarray(tag.bodyStart, tag.bodyEnd);
  const textTag = find(current, 37, 475), text = body(current, textTag);
  const referenceText = body(reference, find(reference, 37, 550));
  const oldHtml = text.indexOf(Buffer.from('<p align="center">')), newHtml = referenceText.indexOf(Buffer.from('<p align="center">'));
  assert.ok(oldHtml > 0 && newHtml > 0);
  assert.ok(text.subarray(oldHtml).toString('utf8').includes('deficiencias físicas'));
  assert.ok(referenceText.subarray(newHtml).toString('utf8').includes('<b>体力不足</b>'));
  const flags = text.readUInt16BE(skipRect(text, 2));
  assert.ok((flags & 0x0100) && !(flags & 1), 'expected a device-font EditText');
  assert.equal(text.readUInt16LE(skipRect(text, 2) + 2), 474);
  const fontTag = find(current, 75, 474), font = Buffer.from(body(reference, find(reference, 75, 549)));
  assert.equal(font.readUInt16LE(5 + font[4]), 0, 'reference font must use device glyphs');
  font.writeUInt16LE(474);
  const replacements = new Map([[fontTag, buildTag(75, font)], [textTag, buildTag(37, Buffer.concat([text.subarray(0, oldHtml), referenceText.subarray(newHtml)]))]]);
  const output = compressSwf(current.sig, current.version, Buffer.concat([current.headerPrefix, ...current.tags.map(t => replacements.get(t) ?? t.raw), current.trailing]));
  const after = scan(output); assert.equal(after.tags.length, current.tags.length);
  current.tags.forEach((t, i) => { if (!replacements.has(t)) assert.deepEqual(after.tags[i].raw, t.raw); });
  assert.deepEqual(body(after, find(after, 37, 475)).subarray(0, oldHtml), text.subarray(0, oldHtml));
  return { output, report: { sourceSha256: hash(currentBytes), referenceSha256: hash(referenceBytes), outputSha256: hash(output), translatedTexts: 1, changedBitmapCount: 0, changedTags: [{ code: 75, id: 474 }, { code: 37, id: 475 }], symbol: 'asset.game.NoEnergyAsset', from: 'deficiencias físicas', to: '体力不足', deviceFont: 'Microsoft YaHei', boundsAndLayoutPreserved: true, allOtherTagsByteIdentical: true, timelineUnchanged: true, gameAccepted: false } };
}
