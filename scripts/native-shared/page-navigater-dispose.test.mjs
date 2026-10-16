import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {ByteReader} from '../../tools/i18n/abc-strings/lib.mjs';
import {scan, sha, q} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';
import {parseActivityAbc} from '../../tools/i18n/abc-strings/activity-response.mjs';
import {adaptPageNavigaterDisposal} from './build-library.mjs';

const project = fileURLToPath(new URL('../../../../', import.meta.url));
const originalPath = resolve(process.env.SHARED_DISPOSE_ORIGINAL ?? resolve(project, 'runtime/reference-activities-completion-20261014/magicwardrobe-native-candidate/magicwardrobe-original-library.swf'));
const originalSkip = existsSync(originalPath) ? false : 'private original SWF absent; real ABC verification not run';
const source = originalSkip ? null : scan(readFileSync(originalPath));
const original = source?.abcs.find(a => a.name === 'morn/core/ex/PageNavigaterEx');
const box = source?.abcs.find(a => a.name === 'morn/core/components/Box');
if (source) assert(original && box, 'actual original PageNavigaterEx and Box are required');
const adapted = original ? adaptPageNavigaterDisposal({...original, owner: original.name}) : null;
// Explicit red-run switch executes the real old method against the same HBox double.
const actual = original && (process.env.SHARED_DISPOSE_UNPATCHED === '1' ? original : {...original, abc: adapted.bytes, p: parseActivityAbc(adapted.bytes)});

test('non-target owner returns the original bytes without parsing or adaptation', () => {
  const bytes = Buffer.from([0, 1, 2]), result = adaptPageNavigaterDisposal({owner: 'morn/core/components/HBox', abc: bytes});
  assert.equal(result.bytes, bytes); assert.deepEqual(result.changes, []);
});

test('target owner rejects an unknown ABC hash before parsing', () => {
  assert.throws(() => adaptPageNavigaterDisposal({owner: 'morn/core/ex/PageNavigaterEx', abc: Buffer.from([0, 1, 2])}), /pinned PageNavigaterEx ABC/);
});

// Bounded execution of these two real ABC methods with display/super doubles.
// This verifies the original instructions and call order, not the AVM2 runtime.
function execute(a, method, self, params = [], superDispose = () => {}) {
  const body = a.p.bodies.find(b => b.method === method), ops = decode(body.code);
  const offsets = new Map(ops.map((o, i) => [o.offset, i])), stack = [], locals = [self, ...params];
  const localName = i => a.p.strings[a.p.names[i]?.name];
  let at = 0, steps = 0;
  const branch = o => { assert(offsets.has(o.end + o.args[0])); at = offsets.get(o.end + o.args[0]); };
  while (at < ops.length) {
    assert(++steps < 1000, 'bounded original loop');
    const o = ops[at++], [arg, count] = o.args;
    if ([0x09, 0xef, 0xf0, 0xf1, 0x82].includes(o.op)) continue;
    if (o.op >= 0xd0 && o.op <= 0xd3) { stack.push(locals[o.op - 0xd0]); continue; }
    if (o.op === 0xd6) { locals[2] = stack.pop(); continue; }
    if (o.op === 0x30 || o.op === 0x29) { stack.pop(); continue; }
    if (o.op === 0x20) { stack.push(null); continue; }
    if (o.op === 0x24) { stack.push(arg > 127 ? arg - 256 : arg); continue; }
    if (o.op === 0x2a) { stack.push(stack.at(-1)); continue; }
    if (o.op === 0x76) { stack.push(Boolean(stack.pop())); continue; }
    if (o.op === 0x73) { stack.push(stack.pop() | 0); continue; }
    if (o.op === 0xc1) { stack.push(stack.pop() - 1); continue; }
    if (o.op === 0xa1) { const right = stack.pop(); stack.push(stack.pop() - right); continue; }
    if (o.op === 0x5d) { assert(localName(arg) in self); stack.push(self); continue; }
    if (o.op === 0x66) { stack.push(stack.pop()[localName(arg)]); continue; }
    if (o.op === 0x61) { const value = stack.pop(); stack.pop()[localName(arg)] = value; continue; }
    if (o.op === 0x46) {
      const args = stack.splice(stack.length - count, count), target = stack.pop(), name = localName(arg);
      if (typeof target[name] !== 'function') throw new ReferenceError('Error #1069: Property ' + name + ' not found on HBox double');
      stack.push(target[name](...args)); continue;
    }
    if (o.op === 0x45) { assert.equal(localName(arg), 'dispose'); assert.equal(count, 0); assert.equal(stack.pop(), self); superDispose(); stack.push(undefined); continue; }
    if (o.op === 0x10) { branch(o); continue; }
    if (o.op === 0x12) { if (!stack.pop()) branch(o); continue; }
    if (o.op === 0x13 || o.op === 0x17) { const right = stack.pop(), left = stack.pop(); if (o.op === 0x13 ? left == right : left > right) branch(o); continue; }
    if (o.op === 0x47) { assert.equal(stack.length, 0); return; }
    assert.fail('unsupported original opcode ' + o.op);
  }
  assert.fail('original method did not return');
}

const components = ['_firstBtn', '_prevBtn', '_nextBtn', '_lastBtn', '_pageNumBg', '_pageNumText'];
function fixture(count) {
  const trace = [], children = Array.from({length: count}, (_, i) => ({id: i}));
  const hbox = {get numChildren() { return children.length; }, getChildAt(i) { return children[i]; },
    removeChildAt(i) { trace.push('remove:' + i); return children.splice(i, 1)[0]; },
    removeAllChild(except = null) { trace.push('clear'); execute(box, 6, this, [except]); }};
  const self = {_hBox: hbox, _pageSpri: {}, ...Object.fromEntries(components.map(name => [name, {dispose() { trace.push(name); }}]))};
  const dispose = a => execute(a, 40, self, [], () => trace.push('super.dispose'));
  return {self, hbox, children, trace, dispose};
}

test('actual original method reproduces the ordinary unsupported HBox call', {skip: originalSkip}, () => {
  const f = fixture(3);
  assert.throws(() => f.dispose(original), /#1069: Property removeChildren/);
  assert.deepEqual(f.trace, components); assert.equal(f.children.length, 3);
});

for (const count of [0, 3]) test('adapted original disposal clears ' + count + ' children in the original release order', {skip: originalSkip}, () => {
  const f = fixture(count); f.dispose(actual);
  assert.equal(f.children.length, 0);
  assert.deepEqual(f.trace, [...components, 'clear', ...Array.from({length: count}, (_, i) => 'remove:' + (count - i - 1)), 'super.dispose']);
  for (const name of [...components, '_pageSpri', '_hBox']) assert.equal(f.self[name], null, name);
});

test('real inherited Box helper accepts the original null default and preserves an explicit except child', {skip: originalSkip}, () => {
  assert.equal(sha(box.abc), '6c9980d08df8aff7aa36fb8119d218dcd9d4154275ac652c180a35b237a87769');
  assert.equal(q(box.p, box.p.methods[6].params[0]), 'flash.display::DisplayObject');
  assert.equal(box.p.methods[6].flags, 136);
  const r = new ByteReader(box.abc); r.pos = box.p.namePoolEnd;
  const count = r.u30(); let defaults;
  for (let i = 0; i < count; i++) {
    const params = r.u30(); r.u30(); for (let j = 0; j < params; j++) r.u30();
    r.u30(); const flags = r.bytes(1)[0], optional = [];
    if (flags & 8) for (let n = r.u30(); n; n--) optional.push({value: r.u30(), kind: r.bytes(1)[0]});
    if (flags & 128) for (let j = 0; j < params; j++) r.u30();
    if (i === 6) defaults = optional;
  }
  assert.deepEqual(defaults, [{value: 12, kind: 12}]);
  const f = fixture(3), kept = f.children[1]; f.hbox.removeAllChild(kept);
  assert.deepEqual(f.children, [kept]); assert.deepEqual(f.trace, ['clear', 'remove:2', 'remove:0']);
});

test('one QName adaptation preserves all original strings, other names and complete method bodies', {skip: originalSkip}, () => {
  const p = parseActivityAbc(adapted.bytes), before = original.p;
  assert.deepEqual(p.strings, [...before.strings, 'removeAllChild']);
  assert.deepEqual(p.names, before.names.map((n, i) => i === 105 ? {...n, name: 289} : n));
  const qops = new Set([4, 5, 0x45, 0x46, 0x4a, 0x4c, 0x4e, 0x4f, 0x5d, 0x5e, 0x5f, 0x60, 0x61, 0x66, 0x68, 0x6a, 0x80, 0x86, 0xb2]);
  const uses = before.bodies.flatMap(b => decode(b.code).filter(o => qops.has(o.op) && o.args[0] === 105).map(o => ({method: b.method, ...o})));
  assert.deepEqual(uses, [{method: 40, op: 0x46, args: [105, 0], offset: 156, end: 159}]);
  assert.equal(q(p, 105), '::removeAllChild');
  for (const b of before.bodies) { const after = p.bodies.find(x => x.method === b.method); assert.deepEqual(adapted.bytes.subarray(after.start, after.end), original.abc.subarray(b.start, b.end)); }
  assert.equal(before.bodies.length, 43);
  assert.throws(() => adaptPageNavigaterDisposal({...original, owner: original.name, abc: Buffer.from([...original.abc, 0])}), /pinned PageNavigaterEx ABC/);
});

test('built candidate changes one of 92 ABCs and retains all other complete tags', {skip: originalSkip || (!process.env.SHARED_DISPOSE_CANDIDATE && 'SHARED_DISPOSE_CANDIDATE not provided; candidate equivalence not run')}, () => {
  const dir = resolve(process.env.SHARED_DISPOSE_CANDIDATE);
  const files = [['native-shared-library.swf', 82], ['magicwardrobe-module-library.swf', 10]];
  let changed = 0, unchanged = 0;
  for (const [file, count] of files) {
    const lib = scan(readFileSync(resolve(dir, file))); assert.equal(lib.abcs.length, count);
    assert.equal(lib.version, source.version); assert.deepEqual(lib.headerPrefix, source.headerPrefix);
    assert.deepEqual(lib.tags.filter(t => t.code !== 82).map(t => t.raw), source.tags.filter(t => t.code !== 82).map(t => t.raw));
    const entries = source.abcs.filter(a => a.name.startsWith('magicWardrobe/') === file.startsWith('magicwardrobe-'));
    assert.deepEqual(lib.abcs.map(a => a.name), entries.map(a => a.name));
    for (const [i, a] of lib.abcs.entries()) {
      const old = source.abcs.find(o => o.name === a.name);
      if (a.name === original.name) { assert.deepEqual(a.abc, adapted.bytes); changed++; }
      else {
        assert.deepEqual(a.abc, old.abc); unchanged++;
        assert.deepEqual(lib.tags.filter(t => t.code === 82)[i].raw, source.tags.filter(t => t.code === 82)[source.abcs.indexOf(old)].raw);
      }
      assert.deepEqual(a.prefix, old.prefix);
    }
  }
  assert.equal(changed, 1); assert.equal(unchanged, 91);
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json')));
  assert.equal(manifest.adaptations.length, 1); assert.equal(manifest.verification.allOriginalMethodBodiesUnchanged, true);
});

test('fresh pair shared copy retains the complete canonical 82-owner hash gate', {skip: originalSkip || ((!process.env.SHARED_DISPOSE_CANDIDATE || !process.env.SHARED_DISPOSE_PAIR_CANDIDATE) && 'both candidate directories are required; pair equivalence not run')}, () => {
  const canonical = scan(readFileSync(resolve(process.env.SHARED_DISPOSE_CANDIDATE, 'native-shared-library.swf')));
  const pair = scan(readFileSync(resolve(process.env.SHARED_DISPOSE_PAIR_CANDIDATE, 'pair-shared-library.swf')));
  assert.equal(pair.abcs.length, 82); assert.deepEqual(pair.abcs.map(a => a.name), canonical.abcs.map(a => a.name));
  for (const [i, a] of pair.abcs.entries()) {
    assert.equal(sha(a.abc), sha(canonical.abcs[i].abc), a.name);
    assert.deepEqual(a.prefix, canonical.abcs[i].prefix, a.name + ' DoABC header');
  }
});
