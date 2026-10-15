// Offline preparation for the full original pool. This never changes live rewards or templates.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadTreasureCatalog, resolveTreasureDisplayIdentities} from './catalog.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Metadata is supplied by an offline XML extractor; matching display fields never authorizes delivery. */
export function prepareTreasureCatalog({projectRoot, outputDir, referenceTemplates, localTemplates, templateSources}) {
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
  const out = resolve(outputDir);
  assert(!existsSync(out), 'preserve prior catalog preparation');
  mkdirSync(out, {recursive: true});
  const outputs = [];
  for (const [file, value] of [['original-catalog.json', catalog], ['display-identities.json', report]]) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    writeFileSync(resolve(out, file), bytes, {flag: 'wx'});
    outputs.push({file, bytes: bytes.length, sha256: sha(bytes)});
  }
  const manifest = {version: 1, module: 'treasure-original-catalog-preparation',
    outputDir: out, sources: [{file: 'catalog.mjs', sha256: sha(readFileSync(new URL('./catalog.mjs', import.meta.url)))},
      {file: 'prepare-catalog.mjs', sha256: sha(readFileSync(fileURLToPath(import.meta.url)))}],
    outputs, referenceOnly: true, runtimeLoaded: false, installed: false, gameAccepted: false};
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
