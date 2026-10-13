import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { patchCraterMask } from "../tools/i18n/abc-strings/crater-mask.mjs";
import { ByteReader, compressSwf, decompressSwf, parseTags } from "../tools/i18n/abc-strings/lib.mjs";
import { parseActivityAbc } from "../tools/i18n/abc-strings/activity-response.mjs";
import { literalOptions, runLiteralOverlay } from "./workshop-literals.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const original = readFileSync(join(repo, "apps/api/assets/flash/2.png"));
const names = ["2.png", "3.png", "DDT_Loading.swf"];
function inspect(raw) {
  const swf = decompressSwf(raw); assert.equal(swf.error, null);
  const parsed = parseTags(swf.body);
  const tags = parsed.tags.map(tag => {
    if (tag.code !== 82) return tag;
    const r = new ByteReader(swf.body.subarray(tag.bodyStart, tag.bodyEnd)); r.u32();
    const name = r.cstring(), abc = r.bytes(r.buf.length - r.pos);
    return { ...tag, name, abc };
  });
  return { ...swf, ...parsed, tags };
}

test("patch changes only Tile.Dig and is byte-idempotent", () => {
  const result = patchCraterMask(original), before = inspect(original), after = inspect(result.out);
  assert.equal(result.changed, true); assert.equal(result.renderingAccepted, false);
  assert.equal(before.tags.length, after.tags.length);
  assert.deepEqual(after.headerPrefix, before.headerPrefix); assert.deepEqual(after.trailing, before.trailing);
  for (let i = 0; i < before.tags.length; i++) {
    const a = before.tags[i], b = after.tags[i];
    if (a.name !== "phy/maps/Tile") { assert.deepEqual(b.raw, a.raw); continue; }
    const p = parseActivityAbc(a.abc), q = parseActivityAbc(b.abc);
    assert.deepEqual(q.methods, p.methods); assert.deepEqual(q.methodTraits, p.methodTraits);
    assert.deepEqual(q.strings.slice(0, p.strings.length), p.strings);
    for (const method of p.bodies) {
      const patched = q.bodies.find(m => m.method === method.method);
      if (method.method === 2) {
        assert.equal(patched.exceptions, 0); assert.equal(patched.localCount, 7);
        // All original code, including ERASE and final draw, survives outside one mask step.
        const prefix = Buffer.from(patched.code.subarray(0, 203)); prefix.writeIntLE(122, 152, 3);
        assert.deepEqual(prefix, method.code.subarray(0, 203));
        assert.deepEqual(patched.code.subarray(-61), method.code.subarray(219));
      } else assert.deepEqual(b.abc.subarray(patched.start, patched.end), a.abc.subarray(method.start, method.end));
    }
  }
  const again = patchCraterMask(result.out); assert.equal(again.changed, false); assert.deepEqual(again.out, result.out);
});

test("unknown Tile bytecode and a missing Tile are rejected", () => {
  const s = inspect(original), tile = s.tags.find(t => t.name === "phy/maps/Tile");
  const altered = Buffer.from(s.body); altered[tile.bodyEnd - 1] ^= 1;
  assert.throws(() => patchCraterMask(compressSwf(s.sig, s.version, altered)), /unknown Tile ABC/);
  const missing = compressSwf(s.sig, s.version, Buffer.concat([s.headerPrefix, ...s.tags.filter(t => t !== tile).map(t => t.raw), s.trailing]));
  assert.throws(() => patchCraterMask(missing), /expected one Tile/);
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ddt-crater-mask-"));
  t.after(() => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(dir.startsWith(join(tmpdir(), "ddt-crater-mask-")));
    rmSync(dir, { recursive: true, force: true });
  });
  const repoRoot = join(dir, "repo"), runtimeRoot = join(dir, "runtime");
  for (const name of ["research/i18n/zh-CN-literals.json", "tools/i18n/abc-strings/translations.json", ...names.map(n => "apps/api/assets/flash/" + n)]) {
    const target = join(repoRoot, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(join(repo, name)));
  }
  const overlay = join(runtimeRoot, "client-overlay"), ledger = join(runtimeRoot, "client-overlay-literals.json");
  return { overlay, ledger, runtimeRoot, run: args => runLiteralOverlay({ repoRoot, runtimeRoot, ...args }) };
}

test("mask is explicit and independent of activity flags; verify stays read-only", t => {
  assert.deepEqual(literalOptions(["--crater-mask"]), { command: "verify", activityResponse: false, craterMask: true });
  for (const args of [["--crater-mask", "--crater-mask"], ["rollback", "--crater-mask"], ["--crater-mask=true"]]) assert.throws(() => literalOptions(args));
  const f = fixture(t), plain = f.run(), pending = f.run({ craterMask: true });
  assert.equal(plain.craterMask, false); assert.equal(pending.craterMask, true);
  assert.equal(pending.craterMaskInstalled, false); assert.equal(pending.pendingTransition, true);
  assert.equal(pending.activityResponse, false); assert.equal(pending.exchangeState, false);
  assert.equal(existsSync(f.runtimeRoot), false);
  for (const name of ["3.png", "DDT_Loading.swf"]) assert.equal(plain.files.find(x => x.name === name).sha256, pending.files.find(x => x.name === name).sha256);
});

test("existing exchange overlay upgrades only 2.png, keeps backups and survives subsequent default runs", t => {
  const f = fixture(t); f.run({ command: "install", exchangeState: true });
  const before = JSON.parse(readFileSync(f.ledger, "utf8")), files = names.map(n => readFileSync(join(f.overlay, n)));
  const pending = f.run({ craterMask: true }); assert.equal(pending.pendingTransition, true);
  const installed = f.run({ command: "install", craterMask: true });
  assert.equal(installed.craterMaskInstalled, true); assert.equal(installed.exchangeStateInstalled, true);
  const after = JSON.parse(readFileSync(f.ledger, "utf8"));
  assert.deepEqual(after.files.map(f => f.backup), before.files.map(f => f.backup));
  assert.deepEqual(readFileSync(join(f.overlay, "2.png")), patchCraterMask(files[0]).out);
  for (let i = 1; i < names.length; i++) assert.deepEqual(readFileSync(join(f.overlay, names[i])), files[i]);
  const ledger = readFileSync(f.ledger);
  assert.equal(f.run().unchanged, true); assert.equal(f.run({ command: "install" }).unchanged, true);
  assert.deepEqual(readFileSync(f.ledger), ledger);
  const result = f.run({ command: "rollback" }); assert.equal(result.rolledBack, true);
  assert.equal(existsSync(f.ledger), false);
  for (const name of names) assert.equal(existsSync(join(f.overlay, name)), false);
  for (const file of before.files) assert.ok(existsSync(file.backup));
});

test("forged crater flag and changed output cannot be overwritten", t => {
  const f = fixture(t); f.run({ command: "install", exchangeState: true });
  const old = readFileSync(f.ledger), fake = JSON.parse(old); fake.craterMask = true;
  writeFileSync(f.ledger, JSON.stringify(fake));
  assert.throws(() => f.run({ command: "install", craterMask: true }), /recorded literal\/consumer output changed/);
  writeFileSync(f.ledger, old); f.run({ command: "install", craterMask: true });
  const target = join(f.overlay, "2.png"), changed = Buffer.concat([readFileSync(target), Buffer.from([1])]); writeFileSync(target, changed);
  assert.throws(() => f.run({ command: "install" }), /changed deployment preserved/);
  assert.deepEqual(readFileSync(target), changed);
});
