#!/usr/bin/env node
/**
 * Rewrites Vietnamese literal strings found by scan.mjs directly inside a SWF's ABC (ActionScript 3
 * bytecode) constant pool, with PT-BR text from translations.json. Only the string pool's own u30
 * length-prefix + UTF-8 bytes change; every other ABC structure (namespaces, multinames, method bodies,
 * classes, scripts...) references strings by constant-pool INDEX, never by byte offset, so it's copied
 * through unmodified. The containing DoABC tag's length and the SWF's FileLength header field are
 * recomputed since the new strings are rarely byte-identical in length to the originals (unlike the
 * fixed-length RSA-modulus patch in apps/api/scripts/patch-client-key.ts, which can get away with a
 * byte-for-byte same-length swap).
 *
 * Vendor is never written to. Output always goes to --out (typically the apps/api/assets/flash overlay).
 *
 * Pipeline order for FlashSV1/2.png specifically: this script must run BEFORE patch-client-key.ts,
 * feeding patch-client-key its own output as input — patch-client-key does a dynamic indexOf() for the
 * RSA modulus string at patch time (not a hardcoded offset), so it works fine on an already-resized file,
 * but the reverse order (key patch, then this script) would also work by the same logic; the only hard
 * requirement is sequential (A's output -> B's input), never patch both independently off the same
 * vendor source and try to merge, since only one of the two patched copies would survive.
 *
 * Usage: node patch.mjs <in.swf|in.png> <out.swf|out.png> [--translations path.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ByteReader, encodeU30, decompressSwf, parseTags, buildTag, compressSwf } from "./lib.mjs";

function patchAbcStrings(abcBuf, translations) {
  const r = new ByteReader(abcBuf);
  r.bytes(4); // minor_version(u16) + major_version(u16), unchanged

  const intCount = r.u30();
  for (let i = 1; i < intCount; i++) r.u30();
  const uintCount = r.u30();
  for (let i = 1; i < uintCount; i++) r.u30();
  const doubleCount = r.u30();
  for (let i = 1; i < doubleCount; i++) r.pos += 8;

  const stringCount = r.u30();
  const prefix = abcBuf.subarray(0, r.pos); // header + ints + uints + doubles + string_count, byte-identical

  const chunks = [];
  let changed = 0;
  for (let i = 1; i < stringCount; i++) {
    const len = r.u30();
    const raw = r.bytes(len);
    const orig = raw.toString("utf8");
    const translated = Object.prototype.hasOwnProperty.call(translations, orig) ? translations[orig] : orig;
    if (translated !== orig) changed++;
    const newBytes = Buffer.from(translated, "utf8");
    chunks.push(encodeU30(newBytes.length), newBytes);
  }
  const suffix = abcBuf.subarray(r.pos); // namespaces..script info, all index-referenced, byte-identical

  return { abc: Buffer.concat([prefix, ...chunks, suffix]), changed };
}

export function patchSwfBuffer(buf, translations) {
  const { error, body, sig, version } = decompressSwf(buf);
  if (error) throw new Error(error);
  const { headerPrefix, tags, trailing } = parseTags(body);

  let totalChanged = 0;
  const rebuiltTagBytes = tags.map((tag) => {
    if (tag.code !== 82 && tag.code !== 72) return tag.raw;
    const tagBody = body.subarray(tag.bodyStart, tag.bodyEnd);
    let abcData, prefixBuf;
    if (tag.code === 82) {
      const tr = new ByteReader(tagBody);
      tr.u32();
      tr.cstring();
      prefixBuf = tagBody.subarray(0, tr.pos);
      abcData = tagBody.subarray(tr.pos);
    } else {
      prefixBuf = Buffer.alloc(0);
      abcData = tagBody;
    }
    const { abc: newAbc, changed } = patchAbcStrings(abcData, translations);
    totalChanged += changed;
    const newTagBody = Buffer.concat([prefixBuf, newAbc]);
    return buildTag(tag.code, newTagBody);
  });

  const newBody = Buffer.concat([headerPrefix, ...rebuiltTagBytes, trailing]);
  const out = compressSwf(sig, version, newBody);
  return { out, totalChanged };
}

function main() {
  const args = process.argv.slice(2);
  let translationsPath = new URL("./translations.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--translations") translationsPath = args[++i];
    else pos.push(args[i]);
  }
  const [inPath, outPath] = pos;
  if (!inPath || !outPath) {
    console.error("usage: node patch.mjs <in> <out> [--translations path.json]");
    process.exit(1);
  }
  const translations = JSON.parse(readFileSync(translationsPath, "utf8"));
  const buf = readFileSync(inPath);
  const { out, totalChanged } = patchSwfBuffer(buf, translations);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out);
  console.log(`${inPath}: patched ${totalChanged} ABC constant-pool string(s) -> ${outPath} (${out.length} bytes)`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
