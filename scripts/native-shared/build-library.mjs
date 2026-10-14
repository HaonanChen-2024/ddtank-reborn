import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ByteReader, compressSwf, decompressSwf, parseTags} from '../../tools/i18n/abc-strings/lib.mjs';
import {parseActivityAbc} from '../../tools/i18n/abc-strings/activity-response.mjs';

const SOURCE = 'runtime/reference-activities-completion-20261014/magicwardrobe-native-candidate/magicwardrobe-original-library.swf';
const SOURCE_SHA256 = 'ad3151811f44d99570ae10b13a219c290aa97ed42d131df2c1ec5bf2b3cf8bc5';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function scan(bytes) {
  const swf = decompressSwf(bytes);
  assert.equal(swf.error, null);
  assert.equal(bytes.readUInt32LE(4), swf.body.length + 8, 'SWF declared length');
  const parsed = parseTags(swf.body);
  assert.equal(parsed.trailing.length, 0);
  const abcs = parsed.tags.filter(t => t.code === 82).map((tag, sourceIndex) => {
    const r = new ByteReader(swf.body.subarray(tag.bodyStart, tag.bodyEnd));
    const flags = r.u32(), end = r.buf.indexOf(0, r.pos);
    assert(end >= r.pos, 'terminated DoABC owner');
    const owner = r.cstring(), abc = r.buf.subarray(r.pos);
    return {owner, sourceIndex, flags, abc, raw: tag.raw, p: parseActivityAbc(abc)};
  });
  return {...swf, ...parsed, abcs};
}

// Parse the actual name pool: parseActivityAbc intentionally omits a Multiname's
// namespace-set index. Inheritance through those names must not become ::IBox.
function namesFor(a) {
  const r = new ByteReader(a.abc), p = a.p;
  r.pos = p.nameDataOffset;
  const u = () => r.u30(), names = [null];
  const qualify = (nsIndex, nameIndex) => {
    const ns = p.namespaces[nsIndex];
    assert(ns && typeof p.strings[nameIndex] === 'string');
    const namespace = p.strings[ns.name], localName = p.strings[nameIndex];
    const qualifiedName = `${namespace}::${localName}`;
    // Private namespaces have ABC-local identity even if their URI matches.
    const key = `${ns.kind === 5 ? `${a.owner}:${nsIndex}:` : ''}${ns.kind}:${qualifiedName}`;
    return {qualifiedName, namespace, namespaceKind: ns.kind, localName, key};
  };
  for (let index = 1; index < p.names.length; index++) {
    const kind = r.bytes(1)[0];
    let candidates = [];
    switch (kind) {
      case 7: case 13: { const ns = u(), name = u(); candidates = [qualify(ns, name)]; break; }
      case 9: case 14: {
        const name = u(), set = u();
        assert(Array.isArray(p.namespaceSets[set]), 'valid NamespaceSet');
        candidates = p.namespaceSets[set].map(ns => qualify(ns, name));
        break;
      }
      case 15: case 16: case 27: case 28: u(); break;
      case 17: case 18: break;
      case 29: { u(); const length = u(); for (let i = 0; i < length; i++) u(); break; }
      default: assert.fail(`unsupported multiname kind ${kind}`);
    }
    names.push({kind, candidates});
  }
  assert.equal(r.pos, p.namePoolEnd);
  return names;
}

function declarations(a) {
  const r = new ByteReader(a.abc), p = a.p, names = namesFor(a);
  r.pos = p.namePoolEnd;
  const u = () => r.u30(), byte = () => r.bytes(1)[0];
  const methodCount = u();
  for (let i = 0; i < methodCount; i++) {
    const params = u(); u(); for (let j = 0; j < params; j++) u();
    u(); const flags = byte();
    if (flags & 8) { const count = u(); for (let j = 0; j < count; j++) { u(); byte(); } }
    if (flags & 128) for (let j = 0; j < params; j++) u();
  }
  const metadataCount = u();
  for (let i = 0; i < metadataCount; i++) { u(); const count = u(); for (let j = 0; j < count * 2; j++) u(); }
  const classCount = u(), classes = [];
  for (let i = 0; i < classCount; i++) {
    const name = u(), parent = u(), flags = byte();
    if (flags & 8) u();
    const count = u(), interfaces = [];
    for (let j = 0; j < count; j++) interfaces.push(u());
    u();
    const traits = p.traitBlocks[i];
    assert.equal(traits.owner, name); assert.equal(traits.countOffset, r.pos);
    r.pos = traits.end;
    assert.equal(names[name].kind, 7, 'instance declaration must be a QName');
    assert.equal(names[name].candidates.length, 1);
    classes.push({...names[name].candidates[0], nameIndex: name, parent, interfaces});
  }
  assert.equal(classCount, p.traitBlocks.filter(t => t.owner != null).length);
  return {...a, classes, names};
}

function classRecord(c) {
  return {qualifiedName: c.qualifiedName, namespaceKind: c.namespaceKind,
    publicName: c.namespaceKind === 0x16 ? (c.namespace ? c.qualifiedName : c.localName) : null};
}

/**
 * Split the pinned, already adapted 92-ABC wardrobe library without modifying it.
 * projectRoot is DDTank-Workshop, not source/ddtank-reborn. outputDir must not
 * exist; its parent must exist. Returns the same JSON object saved as manifest.json.
 * This is an offline build only: it never loads SWFs, patches a client, or starts a service.
 */
export function buildSharedLibraries({projectRoot, outputDir}) {
  assert(typeof projectRoot === 'string' && projectRoot.length > 0);
  assert(typeof outputDir === 'string' && outputDir.length > 0);
  const root = resolve(projectRoot), out = resolve(outputDir), sourcePath = resolve(root, SOURCE);
  const outputRelative = relative(resolve(root, 'runtime'), out);
  assert(outputRelative && outputRelative !== '..' && !outputRelative.startsWith('..\\') &&
    !outputRelative.startsWith('../') && !isAbsolute(outputRelative), 'outputDir must be inside project runtime');
  assert(!existsSync(out), `outputDir already exists: ${out}`);
  const source = readFileSync(sourcePath);
  assert.equal(sha(source), SOURCE_SHA256, 'pinned shared source changed');
  const original = scan(source), all = original.abcs.map(declarations);
  assert.equal(all.length, 92);
  assert.equal(new Set(all.map(a => a.owner)).size, 92, 'unique ABC owners');
  assert.equal(original.headerPrefix.readUInt16LE(original.headerPrefix.length - 2), 1, 'single-frame library');
  assert(original.tags.every(t => [69, 82, 1, 0].includes(t.code)), 'only library tags may be split');
  const tag = code => {
    const matches = original.tags.filter(t => t.code === code);
    assert.equal(matches.length, 1, `exactly one tag ${code}`); return matches[0].raw;
  };
  const attributes = tag(69), showFrame = tag(1), end = tag(0);
  const classOwners = new Map();
  for (const a of all) for (const c of a.classes) {
    assert(!classOwners.has(c.key), `duplicate class identity ${c.qualifiedName}`);
    classOwners.set(c.key, {a, c});
  }
  const shared = all.filter(a => !a.owner.startsWith('magicWardrobe/'));
  const wardrobe = all.filter(a => a.owner.startsWith('magicWardrobe/'));
  assert.equal(shared.length, 82); assert.equal(wardrobe.length, 10);
  const sharedNames = shared.flatMap(a => a.classes.map(c => c.qualifiedName));
  const wardrobeNames = wardrobe.flatMap(a => a.classes.map(c => c.qualifiedName));
  const intersection = sharedNames.filter(name => wardrobeNames.includes(name));
  assert.equal(intersection.length, 0, 'module class sets must be disjoint');
  assert.equal(new Set(sharedNames).size, sharedNames.length);
  assert.equal(new Set(wardrobeNames).size, wardrobeNames.length);

  const inheritance = [], sharedToWardrobe = [];
  for (const a of all) for (const c of a.classes) {
    for (const [kind, index] of [['superclass', c.parent], ...c.interfaces.map(i => ['interface', i])]) {
      if (!index) continue;
      const name = a.names[index], candidates = name.candidates;
      const matches = [...new Map(candidates.filter(n => classOwners.has(n.key)).map(n => [n.key, classOwners.get(n.key)])).values()];
      assert(matches.length <= 1, `ambiguous ${kind} ${a.owner} ${index}`);
      if (!matches.length) {
        assert.equal(new Set(candidates.map(n => n.key)).size, 1, `unresolved dynamic inheritance ${a.owner} ${index}`);
      }
      const target = matches[0];
      if (target && target.a !== a) assert(target.a.sourceIndex < a.sourceIndex, 'source inheritance order');
      const edge = {owner: a.owner, class: c.qualifiedName, kind, multinameKind: name.kind,
        candidates: candidates.map(n => n.qualifiedName), dependency: target?.c.qualifiedName ?? candidates[0].qualifiedName,
        dependencyOwner: target?.a.owner ?? null, external: !target};
      inheritance.push(edge);
      if (!a.owner.startsWith('magicWardrobe/') && target?.a.owner.startsWith('magicWardrobe/')) sharedToWardrobe.push(edge);
    }
  }
  assert.equal(sharedToWardrobe.length, 0, 'shared inheritance cannot depend on wardrobe');

  mkdirSync(out);
  const files = [['native-shared-library.swf', shared], ['magicwardrobe-module-library.swf', wardrobe]].map(([file, entries]) => {
    const bytes = compressSwf('CWS', original.version, Buffer.concat([
      original.headerPrefix, attributes, ...entries.map(a => a.raw), showFrame, end,
    ]));
    const checked = scan(bytes);
    assert.deepEqual(checked.abcs.map(a => a.owner), entries.map(a => a.owner), 'stable source order');
    for (let i = 0; i < entries.length; i++) {
      assert.deepEqual(checked.abcs[i].abc, entries[i].abc, 'ABC bytes unchanged');
      assert.deepEqual(checked.abcs[i].raw, entries[i].raw, 'complete DoABC tag unchanged');
    }
    writeFileSync(resolve(out, file), bytes, {flag: 'wx'});
    assert.equal(sha(readFileSync(resolve(out, file))), sha(bytes), 'written SWF readback');
    return {file, bytes: bytes.length, sha256: sha(bytes), swfVersion: checked.version,
      abcCount: entries.length, classCount: entries.reduce((sum, a) => sum + a.classes.length, 0),
      classNames: entries.flatMap(a => a.classes.map(c => c.qualifiedName)),
      owners: entries.map(a => ({owner: a.owner, sourceIndex: a.sourceIndex, abcSha256: sha(a.abc),
        doAbcSha256: sha(a.raw), classes: a.classes.map(classRecord)}))};
  });
  const SharedClassNames = shared.flatMap(a => a.classes.map(classRecord).map(c => c.publicName).filter(Boolean));
  assert.equal(SharedClassNames.length, 82, 'public shared class probe count');
  assert.equal(new Set(SharedClassNames).size, 82);
  writeFileSync(resolve(out, 'SharedClassNames.json'), JSON.stringify(SharedClassNames, null, 2) + '\n', {flag: 'wx'});
  assert.equal(sha(readFileSync(sourcePath)), SOURCE_SHA256, 'source unchanged after build');
  const manifest = {version: 1, createdAt: new Date().toISOString(), source: {path: sourcePath, bytes: source.length, sha256: SOURCE_SHA256, abcCount: 92},
    outputDir: out, files, SharedClassNames,
    verification: {allAbcBytesUnchanged: true, allDoAbcTagsUnchanged: true, stableSourceOrder: true,
      uniqueOwnerCount: 92, uniqueClassCount: classOwners.size, sharedClassCount: sharedNames.length,
      wardrobeClassCount: wardrobeNames.length, classIntersection: intersection, sharedToWardrobeInheritance: sharedToWardrobe,
      namespaceSetInheritanceCount: inheritance.filter(edge => [9, 14].includes(edge.multinameKind)).length,
      sourceUnchanged: true},
    inheritance,
    classProbePolicy: 'SharedClassNames contains all 82 PackageNamespace classes. The two PrivateNs helper classes remain in the SWF and full class inventory, but cannot be public ApplicationDomain.hasDefinition probes.',
    status: {installed: false, browserValidated: false, runtimeAccepted: false}};
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Usage: node build-library.mjs PROJECT_ROOT NEW_OUTPUT_DIRECTORY');
  const result = buildSharedLibraries({projectRoot: process.argv[2], outputDir: process.argv[3]});
  console.log(JSON.stringify({outputDir: result.outputDir, files: result.files.map(({file, bytes, sha256, abcCount, classCount}) =>
    ({file, bytes, sha256, abcCount, classCount})), verification: result.verification, status: result.status}, null, 2));
}
