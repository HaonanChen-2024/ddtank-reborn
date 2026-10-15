// Offline preparation for the full original pool. This never changes live rewards or templates.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadTreasureCatalog, resolveTreasureDisplayIdentities} from './catalog.mjs';
import {loadOfficialWeaponSnapshot, resolveTreasureWeaponMappings} from './weapon-catalog.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Metadata is supplied by an offline XML extractor; matching display fields never authorizes delivery. */
export function prepareTreasureCatalog({projectRoot, outputDir, referenceTemplates, localTemplates, templateSources, weaponInputs}) {
  assert(Array.isArray(referenceTemplates) && Array.isArray(localTemplates));
  assert(Array.isArray(templateSources) && templateSources.length === 2);
  const catalog = loadTreasureCatalog(projectRoot);
  const templateIds = new Set(catalog.entries.map(row => row.templateId));
  assert.equal(new Set(referenceTemplates.map(row => row.TemplateID)).size, templateIds.size);
  assert(referenceTemplates.every(row => templateIds.has(row.TemplateID)), 'reference metadata must cover exactly the catalog templates');
  const sources = templateSources.map(source => {
    assert(['reference-snapshot', 'local-snapshot'].includes(source.kind));
    assert.equal(typeof source.path, 'string');
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    const bytes = readFileSync(source.path);
    assert.equal(sha(bytes), source.sha256, 'template source bytes changed');
    return {kind: source.kind, path: resolve(source.path), sha256: source.sha256, bytes: bytes.length};
  });
  assert.equal(new Set(sources.map(source => source.kind)).size, 2);
  const identities = resolveTreasureDisplayIdentities(referenceTemplates, localTemplates);
  const report = {
    version: 1, activity: 'treasure-native', scope: 'offline-display-snapshots',
    catalogSource: catalog.source, templateSources: sources,
    suppliedDisplayMetadataCounts: {reference: referenceTemplates.length, local: localTemplates.length}, identities,
    currentDatabaseVerified: false, drawable: false, importedEquipmentProperties: false,
    limitations: [
      'Caller-supplied display metadata needs independent XML derivation verification; source hashes pin the original snapshots only.',
      'Matching CategoryID/Pic/NeedSex does not prove item semantics, official attributes, skills or deliverability.',
      'Different-ID candidates are never applied automatically. Missing or conflicting entries require resolution before spending is enabled.',
      'No weights, prices, tickets, lucky-stone ranking or live reward rules are inferred from the original catalog.',
    ],
  };
  let weapons;
  if (weaponInputs !== undefined) {
    assert(weaponInputs && typeof weaponInputs === 'object' && !Array.isArray(weaponInputs), 'weaponInputs object required');
    assert.deepEqual(Object.keys(weaponInputs).sort(), ['localTemplates', 'mappings'], 'unknown weaponInputs fields');
    assert(Array.isArray(weaponInputs.localTemplates), 'local weapon template array required');
    // Full weapon rows must belong to the same supplied local display snapshot, never another ID alias.
    const localWeaponIdentities = resolveTreasureDisplayIdentities(weaponInputs.localTemplates, localTemplates);
    assert(localWeaponIdentities.entries.every(row => row.status === 'matched'), 'local weapon display metadata differs from local snapshot');
    const official = loadOfficialWeaponSnapshot(projectRoot);
    weapons = {
      ...resolveTreasureWeaponMappings({catalog, referenceTemplates, localTemplates: weaponInputs.localTemplates,
        officialRecords: official.records, mappings: weaponInputs.mappings}),
      officialProvenanceVerified: true,
      officialSnapshotSources: official.sources,
      officialSnapshotSummary: official.summary,
      templateSources: sources,
      localMetadataDerivationVerified: false,
      limitations: [
        'Pinned official snapshot fields are verified against the six original responses, not current live official gameplay.',
        'Caller-supplied local fields still need independent derivation from the pinned local XML.',
        'Explicitly accepted item-field mappings do not prove BallConfig, physics, animation, installation or runtime delivery.',
      ],
    };
  }
  const out = resolve(outputDir);
  assert(!existsSync(out), 'preserve prior catalog preparation');
  const documents = [['original-catalog.json', catalog], ['display-identities.json', report]];
  if (weapons) documents.push(['weapon-mappings.json', weapons]);
  // Validate serialization before creating a directory that cannot be reused after a rejected input.
  const prepared = documents.map(([file, value]) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    return {file, content: bytes, bytes: bytes.length, sha256: sha(bytes)};
  });
  const outputs = prepared.map(({content, ...metadata}) => metadata);
  const manifest = {version: 1, module: 'treasure-original-catalog-preparation',
    outputDir: out, sources: [{file: 'catalog.mjs', sha256: sha(readFileSync(new URL('./catalog.mjs', import.meta.url)))},
      {file: 'prepare-catalog.mjs', sha256: sha(readFileSync(fileURLToPath(import.meta.url)))},
      ...(weapons ? [{file: 'weapon-catalog.mjs', sha256: sha(readFileSync(new URL('./weapon-catalog.mjs', import.meta.url)))}] : [])],
    outputs, referenceOnly: true, runtimeLoaded: false, installed: false, gameAccepted: false};
  mkdirSync(out, {recursive: true});
  for (const {file, content} of prepared) writeFileSync(resolve(out, file), content, {flag: 'wx'});
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'usage: node prepare-catalog.mjs DISPLAY_INPUTS_JSON NEW_OUTPUT_DIRECTORY');
  const input = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const manifest = prepareTreasureCatalog({...input, projectRoot, outputDir: process.argv[3]});
  console.log(JSON.stringify({outputs: manifest.outputs, referenceOnly: true, installed: false}));
}
