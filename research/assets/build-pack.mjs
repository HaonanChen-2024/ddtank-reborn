#!/usr/bin/env node
// build-pack.mjs — merge the downloaded resource packs into one servable tree vendor/_assets/merged/
// (= what the client's SITE / "resource/" URL must point at).
//
//  * Layer order (first wins): gunny30 (3.0, art format proven with 4.1-era clients) -> gun_mobile extracted
//    (newer CN-trad dump, much larger) -> gun_mobile equip_arm_bundle. Override with --pack DIR (repeatable).
//  * Map layers (image/map/<id>/<ForePic|DeadPic>.png): pick the candidate whose PNG size equals the
//    ForegroundWidth/Height of the DDTank41 LoadMapsItems template (the server's .map collision data is sized
//    from the same template, so a mismatched picture would desync terrain).
//  * Validates media; removes the known prefix and restores a PNG width byte only when its original CRC proves it.
//  * Files are hard-linked when unchanged (no extra disk), copied when rewritten. Skips Thumbs.db/__MACOSX/._*.
//  * Adds flash/characterdefine.xml (+ characterDefine.xml) from FlashSV1 and a permissive crossdomain.xml.
//  * Requires a fresh output directory; writes _manifest.tsv and _incompatible.tsv (rejected media and reasons).
// Usage: node research/assets/build-pack.mjs [--pack DIR]... [--out DIR] [--lowercase]
//   --lowercase also writes every path in lower case (for case-sensitive static hosts; the client mixes case,
//   e.g. requests hair/default/1/b/show.png while packs have .../1/B/...). Prefer a case-insensitive server instead.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = (...p) => path.join(ROOT, 'vendor', '_assets', ...p);
const PREFIX = Buffer.from([0, 3, 0x5e, 0x5f, 0x5e]);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LIMIT = 128 * 1024 * 1024;

function pngInfo(data) {
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG) || data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG header');
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  const depth = data[24], color = data[25], interlace = data[28];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color];
  if (!width || !height || width > 32768 || height > 32768 || !depths?.includes(depth) || data[26] !== 0 || data[27] !== 0 || interlace > 1) throw new Error('Invalid PNG dimensions or pixel format');
  const idat = []; let ended = false, palette = false;
  for (let offset = 8; offset < data.length;) {
    if (offset + 12 > data.length) throw new Error('Truncated PNG chunk');
    const length = data.readUInt32BE(offset), end = offset + 12 + length;
    if (end > data.length || crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) throw new Error('PNG chunk CRC mismatch');
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(data.subarray(offset + 8, end - 4));
    if (type === 'PLTE') palette = length > 0 && length <= 768 && length % 3 === 0;
    // Loaders stop at IEND; some otherwise valid source PNGs have trailing bytes.
    if (type === 'IEND') { if (length !== 0) throw new Error('Invalid PNG end'); ended = true; break; }
    offset = end;
  }
  if (!ended || !idat.length || (color === 3 && !palette)) throw new Error('Incomplete PNG structure');
  const pixels = inflateSync(Buffer.concat(idat), { maxOutputLength: LIMIT });
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let position = 0;
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - x) / dx)), rows = Math.max(0, Math.ceil((height - y) / dy));
    if (!columns || !rows) continue;
    const rowBytes = Math.ceil(columns * channels * depth / 8);
    for (let row = 0; row < rows; row++) { if (position >= pixels.length || pixels[position] > 4) throw new Error('Invalid PNG scanline'); position += rowBytes + 1; }
  }
  if (position !== pixels.length) throw new Error('PNG pixel length mismatch');
  return { width, height };
}

export function prepareMedia(file) {
  if (!/\.(png|jpe?g|swf)$/i.test(file)) return { action: 'link' };
  const raw = fs.readFileSync(file), prefixed = raw.subarray(0, 5).equals(PREFIX);
  let data = prefixed ? raw.subarray(5) : raw, action = prefixed ? 'strip' : 'link';
  if (data.subarray(0, 8).equals(PNG)) {
    if (prefixed && data.length >= 33 && data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR' && data[16] === 0xff) {
      data = Buffer.from(data); data[16] = 0;
      if (crc32(data.subarray(12, 29)) !== data.readUInt32BE(29)) throw new Error('Restored PNG IHDR CRC mismatch; source left unchanged');
      action = 'restore-width';
    }
    const size = pngInfo(data);
    return { ...size, action, rewritten: action === 'link' ? undefined : data };
  }
  const signature = data.toString('ascii', 0, 3);
  if (signature === 'FWS' || signature === 'CWS') {
    if (data.length < 8) throw new Error('Truncated SWF header');
    const declared = data.readUInt32LE(4);
    if (declared < 8 || declared > LIMIT) throw new Error('Invalid SWF declared length');
    const actual = signature === 'CWS' ? inflateSync(data.subarray(8), { maxOutputLength: LIMIT }).length + 8 : data.length;
    if (declared !== actual) throw new Error('SWF declared length mismatch');
    return { action, rewritten: prefixed ? data : undefined };
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9) return { action, rewritten: prefixed ? data : undefined };
  throw new Error(data.subarray(0, 4).equals(Buffer.from('PK\x03\x04')) ? 'ZIP container with media extension' : 'Unsupported media signature (including HTML response)');
}

export function requireFreshOutput(out, packs) {
  if (fs.lstatSync(out, { throwIfNoEntry: false })) throw new Error(`Existing output preserved; choose a new --out: ${out}`);
  for (let current = out; ; current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Output ancestor is a symlink/reparse point: ${current}`);
    if (path.dirname(current) === current) break;
  }
  for (const pack of packs) {
    const relative = path.relative(pack, out);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Output must be outside source packs');
  }
}

function main() {
const args = process.argv.slice(2);
let packs = []; let out = A('merged'); let lower = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pack') packs.push(path.resolve(args[++i]));
  else if (args[i] === '--out') out = path.resolve(args[++i]);
  else if (args[i] === '--lowercase') lower = true;
}
if (!packs.length) packs = [A('gunny30/inetpub/wwwroot/Resource'), A('gun_mobile/extracted/Resource'), A('gun_mobile/bundle/Resource')];
packs = packs.filter(fs.existsSync);
if (!packs.length) throw new Error('No resource packs found');
requireFreshOutput(out, packs);

const SKIP = /(^|\/)(__MACOSX|Thumbs\.db|\._[^/]*|\.DS_Store|web\.config|index\.php)$|(^|\/)__MACOSX\/|^(flash\/characterdefine\.xml|crossdomain\.xml|_manifest\.tsv|_incompatible\.tsv)$/i;
function walk(dir) {
  const res = []; const st = [dir];
  while (st.length) {
    const d = st.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__MACOSX') st.push(p); } else res.push(p);
    }
  }
  return res;
}

// map template sizes
const mapSize = new Map();
for (const f of [path.join(ROOT, 'vendor/DDTank41/GameAdmin/Backup/XMLReader/XMLImport/LoadMapsItems.xml')]) {
  if (!fs.existsSync(f)) continue;
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/<Item\s([^>]*)\/>/g)) {
    const o = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    mapSize.set(o.ID, { w: +o.ForegroundWidth, h: +o.ForegroundHeight, fore: o.ForePic, dead: o.DeadPic });
  }
}

// collect candidates: lower-case key -> [{pack, rel, abs}]
const cand = new Map();
for (const p of packs) for (const abs of walk(p)) {
  const rel = path.relative(p, abs).split(path.sep).join('/');
  if (SKIP.test(rel)) continue;
  const k = rel.toLowerCase();
  (cand.get(k) ?? cand.set(k, []).get(k)).push({ pack: p, rel, abs });
}

const manifest = [], incompatible = []; let linked = 0, copied = 0, stripped = 0, restored = 0, mapPicked = 0, mapMismatch = 0;
for (const [k, list] of cand) {
  const valid = [];
  for (const candidate of list) {
    try { valid.push({ ...candidate, ...prepareMedia(candidate.abs) }); }
    catch (error) { incompatible.push(`${candidate.rel}\t${path.relative(ROOT, candidate.pack)}\t${String(error.message).replace(/[\t\r\n]/g, ' ')}`); }
  }
  if (!valid.length) continue;
  let pick = valid[0];
  const mm = k.match(/^image\/map\/(\d+)\/([^/]+)\.png$/);
  if (mm && mapSize.has(mm[1])) {
    const t = mapSize.get(mm[1]);
    const layer = mm[2];
    if ([t.fore, t.dead].map((x) => (x || '').toLowerCase()).includes(layer)) {
      const ok = valid.find((c) => c.width === t.w && c.height === t.h);
      if (ok) { if (ok !== pick) mapPicked++; pick = ok; } else mapMismatch++;
    }
  }
  const relOut = lower ? k : pick.rel;
  const dst = path.join(out, relOut);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  let action = pick.action;
  if (pick.rewritten) {
    fs.writeFileSync(dst, pick.rewritten, { flag: 'wx' });
    if (action === 'restore-width') restored++; else stripped++;
  } else {
    try { fs.linkSync(pick.abs, dst); linked++; } catch { fs.copyFileSync(pick.abs, dst, fs.constants.COPYFILE_EXCL); action = 'copy'; copied++; }
  }
  manifest.push(`${relOut}\t${path.relative(ROOT, pick.pack)}\t${action}`);
}
// client boot files
const fsv = path.join(ROOT, 'vendor/DDTank41/Source Flash/FlashSV1');
fs.mkdirSync(path.join(out, 'flash'), { recursive: true });
for (const n of ['characterdefine.xml', 'characterDefine.xml']) fs.copyFileSync(path.join(fsv, 'characterdefine.xml'), path.join(out, 'flash', n));
fs.writeFileSync(path.join(out, 'crossdomain.xml'), '<?xml version="1.0"?>\n<cross-domain-policy>\n  <allow-access-from domain="*" to-ports="*"/>\n</cross-domain-policy>\n');
fs.writeFileSync(path.join(out, '_manifest.tsv'), manifest.sort().join('\n') + '\n');
fs.writeFileSync(path.join(out, '_incompatible.tsv'), incompatible.sort().join('\n') + '\n');
console.log(`packs: ${packs.map((p) => path.relative(ROOT, p)).join(' > ')}`);
console.log(`files: ${manifest.length} (linked ${linked}, copied ${copied}, de-obfuscated ${stripped}, width restored ${restored}, rejected ${incompatible.length}); map layers re-picked by size ${mapPicked}, no size match ${mapMismatch}`);
console.log(`out: ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
