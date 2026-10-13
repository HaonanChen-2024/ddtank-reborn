// Ruffle compatibility for Tile.Dig's terrain-clipped crater rim.
// Keep the original ERASE, placement matrices, final rim blend and collision rules.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ByteReader, buildTag, compressSwf, decompressSwf, encodeU30, parseTags } from "./lib.mjs";
import { parseActivityAbc } from "./activity-response.mjs";

const TAG = "phy/maps/Tile";
const ORIGINAL = "3d2dbda798c25dc8db24cf07fa3e5b5c6bee267376df3d10fe4089e220bb76dd";
const PATCHED = "b6bc2ed326a941b1a97bdb96f0ec9061eaf43c592386e3b49e527fdd790e5cd6";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const u = encodeU30, cat = (...parts) => Buffer.concat(parts);
const op = (code, ...operands) => cat(Buffer.from([code]), ...operands.map(u));

function replacement() {
  // mask = new BitmapData(rim.width, rim.height, true, 0);
  // mask.draw(this, the original terrain-to-rim matrix);
  // rim.copyPixels(border.bitmapData, rim.rect, new Point(), mask, new Point(), false);
  // copyPixels multiplies the two alpha channels, including transparent sky pixels.
  return cat(
    op(0x5d, 2), op(0x62, 4), op(0x66, 8), op(0x62, 4), op(0x66, 10),
    op(0x26), op(0x24, 0), op(0x4a, 2, 4), op(0x80, 2), op(0x63, 6),
    op(0x62, 6), op(0xd0), op(0x62, 5), op(0x4f, 14, 2),
    op(0x62, 4), op(0xd3), op(0x66, 11), op(0x62, 4), op(0x66, 36),
    op(0x5d, 20), op(0x4a, 20, 0), op(0x62, 6), op(0x5d, 20), op(0x4a, 20, 0),
    op(0x27), op(0x4f, 35, 6), op(0x62, 6), op(0x4f, 18, 0),
  );
}

function patchAbc(bytes) {
  const digest = sha(bytes);
  if (digest === PATCHED) return { out: bytes, changed: false };
  assert.equal(digest, ORIGINAL, "unknown Tile ABC; preserve existing client");
  const p = parseActivityAbc(bytes), target = p.bodies.find(b => b.method === 2);
  assert.deepEqual([p.methods.length, p.strings.length, p.names.length], [7, 61, 35]);
  assert.equal(p.strings[p.methods[2].name], "phy.maps:Tile/Dig");
  assert.deepEqual([target.maxStack, target.localCount, target.initialScope, target.maxScope, target.length, target.exceptions], [7, 6, 7, 8, 280, 0]);
  assert.equal(p.strings[p.names[14].name], "draw");
  assert.equal(p.strings[p.names[16].name], "ALPHA");
  assert.equal(p.strings[p.namespaces[3].name], "");
  const old = target.code, added = replacement(), delta = added.length - 16;
  assert.deepEqual(old.subarray(203, 219), cat(op(0x62, 4), op(0xd0), op(0x62, 5), op(0x20), op(0x5d, 12), op(0x66, 12), op(0x66, 16), op(0x46, 14, 4), op(0x29)));
  assert.equal(old[151], 0x12); assert.equal(old.readIntLE(152, 3), 122);
  const code = cat(old.subarray(0, 203), added, old.subarray(219));
  code.writeIntLE(122 + delta, 152, 3);
  const body = cat(u(2), u(7), u(7), u(7), u(8), u(code.length), code, bytes.subarray(target.offset + target.length, target.end));
  const newStrings = ["copyPixels", "rect"].map(s => cat(u(Buffer.byteLength(s)), Buffer.from(s)));
  const edits = [
    { start: p.stringCountOffset, end: p.stringPoolEnd, data: cat(u(63), bytes.subarray(p.stringDataOffset, p.stringPoolEnd), ...newStrings) },
    { start: p.nameCountOffset, end: p.namePoolEnd, data: cat(u(37), bytes.subarray(p.nameDataOffset, p.namePoolEnd), op(7, 3, 61), op(7, 3, 62)) },
    { start: target.start, end: target.end, data: body },
  ];
  let out = bytes;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = cat(out.subarray(0, e.start), e.data, out.subarray(e.end));
  const checked = parseActivityAbc(out);
  assert.equal(checked.bodies.length, p.bodies.length);
  for (const b of p.bodies.filter(b => b.method !== 2)) {
    const after = checked.bodies.find(c => c.method === b.method);
    assert.deepEqual(out.subarray(after.start, after.end), bytes.subarray(b.start, b.end), "unrelated Tile method changed");
  }
  assert.equal(sha(out), PATCHED, "unexpected crater mask output");
  return { out, changed: true };
}

export function patchCraterMask(buf) {
  const swf = decompressSwf(buf); assert.equal(swf.error, null);
  assert.equal(buf.readUInt32LE(4), swf.body.length + 8, "invalid SWF declared length");
  const parsed = parseTags(swf.body); let found = 0, changed = false, abcSha256;
  const tags = parsed.tags.map(tag => {
    assert.ok(tag.bodyEnd <= swf.body.length, "truncated SWF tag");
    if (tag.code !== 82) return tag.raw;
    const payload = swf.body.subarray(tag.bodyStart, tag.bodyEnd), r = new ByteReader(payload);
    r.u32(); const name = r.cstring();
    if (name !== TAG) return tag.raw;
    found++;
    const result = patchAbc(payload.subarray(r.pos)); changed = result.changed; abcSha256 = sha(result.out);
    return changed ? buildTag(82, cat(payload.subarray(0, r.pos), result.out)) : tag.raw;
  });
  assert.equal(found, 1, "expected one Tile DoABC tag");
  return { out: changed ? compressSwf(swf.sig, swf.version, cat(parsed.headerPrefix, ...tags, parsed.trailing)) : buf,
    changed, tagName: TAG, methodIndex: 2, abcSha256, terrainClippedRim: true, renderingAccepted: false };
}
