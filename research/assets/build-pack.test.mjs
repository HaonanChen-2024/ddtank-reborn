import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareMedia, requireFreshOutput } from './build-pack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const sample = path.resolve(ROOT, '../../assets/incoming/gun-mobile/embedded/bomb/Resource/image/bomb/crater/65/Crater.png');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const prefix = Buffer.from([0, 3, 0x5e, 0x5f, 0x5e]);

test('real recoverable PNG, CRC gate, old prefix, rejected media, source priority and fresh output', (t) => {
  assert.ok(fs.existsSync(sample), 'Run after obtaining the verified Gun_mobile Resource archive');
  const original = fs.readFileSync(sample), originalHash = hash(original);
  assert.equal(originalHash, '7ae8151bd41f1ca04d1e7dab0dfb001181f4643027654e8b3ba959d9296aeecb');
  const actual = prepareMedia(sample);
  assert.equal(actual.action, 'restore-width');
  assert.deepEqual([actual.width, actual.height], [265, 257]);
  // Independently verified by Pillow after the IHDR CRC-proven repair.
  assert.equal(hash(actual.rewritten), '960115f4430ddc667a0886ec963ba6644c38c664f43053ff7fe323adde66f6b6');
  assert.equal(hash(fs.readFileSync(sample)), originalHash);

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ddtank-build-pack-test-'));
  t.after(() => { assert.ok(parent.startsWith(path.join(os.tmpdir(), 'ddtank-build-pack-test-'))); fs.rmSync(parent, { recursive: true }); });
  const base = path.join(parent, 'base'), mobile = path.join(parent, 'mobile'), out = path.join(parent, 'out');
  fs.mkdirSync(base); fs.mkdirSync(mobile);
  fs.writeFileSync(path.join(base, 'shared.png'), actual.rewritten);
  fs.writeFileSync(path.join(mobile, 'shared.png'), original);
  fs.writeFileSync(path.join(mobile, 'repaired.png'), original);
  const oldPrefix = Buffer.concat([prefix, actual.rewritten]);
  fs.writeFileSync(path.join(mobile, 'old.png'), oldPrefix);
  assert.equal(prepareMedia(path.join(mobile, 'old.png')).action, 'strip');
  assert.deepEqual(prepareMedia(path.join(mobile, 'old.png')).rewritten, actual.rewritten);
  fs.writeFileSync(path.join(mobile, 'trailing.png'), Buffer.concat([actual.rewritten, Buffer.from([0, 0])]));
  assert.equal(prepareMedia(path.join(mobile, 'trailing.png')).action, 'link');
  const badCrc = Buffer.from(original); badCrc[37] ^= 1;
  fs.writeFileSync(path.join(mobile, 'bad-crc.png'), badCrc);
  assert.throws(() => prepareMedia(path.join(mobile, 'bad-crc.png')), /IHDR CRC mismatch/);
  fs.writeFileSync(path.join(mobile, 'unprefixed-bad-width.png'), original.subarray(5));
  assert.throws(() => prepareMedia(path.join(mobile, 'unprefixed-bad-width.png')), /dimensions/);
  fs.writeFileSync(path.join(mobile, 'fake.png'), '<!DOCTYPE html><html>Error</html>');
  fs.writeFileSync(path.join(mobile, 'zip.swf'), Buffer.from('PK\x03\x04'));
  fs.writeFileSync(path.join(mobile, 'truncated.png'), actual.rewritten.subarray(0, 60));
  const reserved = path.join(base, 'flash/characterdefine.xml');
  fs.mkdirSync(path.dirname(reserved)); fs.writeFileSync(reserved, 'source sentinel');
  const sourceFiles = [path.join(base, 'shared.png'), path.join(mobile, 'shared.png'), path.join(mobile, 'repaired.png'), path.join(mobile, 'old.png'), reserved];
  const before = sourceFiles.map((f) => hash(fs.readFileSync(f)));
  execFileSync(process.execPath, [path.join(HERE, 'build-pack.mjs'), '--pack', base, '--pack', mobile, '--out', out]);
  assert.deepEqual(fs.readFileSync(path.join(out, 'shared.png')), actual.rewritten);
  assert.deepEqual(fs.readFileSync(path.join(out, 'repaired.png')), actual.rewritten);
  const manifest = fs.readFileSync(path.join(out, '_manifest.tsv'), 'utf8');
  assert.match(manifest, /shared\.png\t[^\n]*base\tlink/);
  assert.match(manifest, /repaired\.png\t[^\n]*mobile\trestore-width/);
  assert.match(manifest, /old\.png\t[^\n]*mobile\tstrip/);
  const incompatible = fs.readFileSync(path.join(out, '_incompatible.tsv'), 'utf8');
  for (const name of ['bad-crc.png', 'unprefixed-bad-width.png', 'fake.png', 'zip.swf', 'truncated.png']) { assert.ok(incompatible.includes(name)); assert.equal(fs.existsSync(path.join(out, name)), false); }
  assert.deepEqual(sourceFiles.map((f) => hash(fs.readFileSync(f))), before);
  assert.throws(() => requireFreshOutput(out, [base]), /Existing output preserved/);
  assert.throws(() => requireFreshOutput(path.join(base, 'child'), [base]), /outside source packs/);
  const link = path.join(parent, 'linked'); fs.symlinkSync(base, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => requireFreshOutput(path.join(link, 'child'), [mobile]), /symlink\/reparse/);
});
