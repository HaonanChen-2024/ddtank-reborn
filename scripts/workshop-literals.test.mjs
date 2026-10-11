import assert from "node:assert/strict";
import { test } from "node:test";
import { patchSwfBuffer } from "../tools/i18n/abc-strings/patch.mjs";
import { buildTag, compressSwf, decompressSwf, encodeU30, parseTags } from "../tools/i18n/abc-strings/lib.mjs";

test("display translation preserves all other SWF bytes and the ABC suffix", () => {
  const strings = ["Confirmar", "rsa-public-modulus-retained", "ddt.manager.SocketManager"];
  const stringBytes = strings.map(value => {
    const bytes = Buffer.from(value);
    return Buffer.concat([encodeU30(bytes.length), bytes]);
  });
  const prefix = Buffer.from([16, 0, 46, 0, 1, 1, 1, 4]);
  const suffix = Buffer.from([1, 1, 1, 0, 0, 0, 0]);
  const abc = Buffer.concat([prefix, ...stringBytes, suffix]);
  const abcPrefix = Buffer.from([0, 0, 0, 0, 116, 101, 115, 116, 0]);
  const untouchedTag = buildTag(9, Buffer.from([12, 34, 56]));
  const header = Buffer.from([8, 0, 0, 24, 1, 0]);
  const input = compressSwf("CWS", 10, Buffer.concat([header, untouchedTag, buildTag(82, Buffer.concat([abcPrefix, abc])), buildTag(0, Buffer.alloc(0))]));
  const result = patchSwfBuffer(input, { Confirmar: "确定" });
  assert.equal(result.totalChanged, 1);
  const decoded = decompressSwf(result.out);
  assert.equal(decoded.body.length + 8, result.out.readUInt32LE(4));
  const parsed = parseTags(decoded.body);
  assert.deepEqual(parsed.headerPrefix, header);
  assert.deepEqual(parsed.tags[0].raw, untouchedTag);
  const text = Buffer.from("确定");
  const expectedAbc = Buffer.concat([abcPrefix, prefix, encodeU30(text.length), text, ...stringBytes.slice(1), suffix]);
  assert.deepEqual(decoded.body.subarray(parsed.tags[1].bodyStart, parsed.tags[1].bodyEnd), expectedAbc);
  const repeated = patchSwfBuffer(result.out, { Confirmar: "确定" });
  assert.equal(repeated.totalChanged, 0);
  assert.deepEqual(repeated.out, result.out);
});
