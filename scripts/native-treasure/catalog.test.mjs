import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadTreasureCatalog, parseTreasureCatalog, resolveTreasureDisplayIdentities} from './catalog.mjs';
import {prepareTreasureCatalog} from './prepare-catalog.mjs';
import {loadOfficialWeaponSnapshot, WEAPON_FIELDS} from './weapon-catalog.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const xml = readFileSync(resolve(project, 'runtime/reference-activities-completion-20261014/native-maze-analysis-20261015/NewLotteryItem.xml'), 'utf8');
const display = (TemplateID, Pic, CategoryID = 7, NeedSex = 0) => ({TemplateID, CategoryID, Pic, NeedSex});

test('pinned original retains 158 ordered rows, 14 selectable categories and special category 15', () => {
  const result = loadTreasureCatalog(project);
  assert.deepEqual(result.counts, {rows: 158, uniqueTemplateIds: 157, uniqueSourceIds: 147, categories: 15, selectableCategories: 14});
  assert.equal(result.status, 'reference-only');
  assert.equal(result.drawable, false);
  assert.equal(result.source.pinned, true);
  assert.equal(result.source.raw.bytes, 965);
  assert.equal(result.source.decoded.bytes, 9376);
  assert.equal(result.source.raw.sha256, '739530d89d7802ad8ce641627b72a1b6207bbec49044ea9035e495f1a35e285b');
  assert.equal(result.source.sha256, '2e970255b8a8fe5a503deea827c4865e651ebecc5ee0666d838030343bc4687c');
  assert.equal(result.source.sha256, result.source.decoded.sha256);
  assert(result.source.raw.path.endsWith('NewLotteryItem.xml.raw'));
  assert(result.source.decoded.path.endsWith('NewLotteryItem.xml'));
  assert.equal(result.entries.filter(row => row.sourceId === 957).length, 12);
  assert.equal(new Set(result.entries.map(row => row.key)).size, 158);
  result.entries.forEach((row, index) => assert.equal(row.key, `${result.source.sha256}:${index + 1}`));
  assert.deepEqual(result.entries.filter(row => row.templateId === 11905).map(row => [row.sourceType, row.count]), [[7, 10], [12, 5]]);
  assert(result.categories.slice(0, 14).every(row => row.selectable && !row.special));
  assert.deepEqual(result.categories[14], {sourceType: 15, selectable: false, special: true, entryKeys: result.entries.filter(row => row.sourceType === 15).map(row => row.key)});
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  for (const row of result.entries) assert.deepEqual(Object.keys(row), ['key', 'sourceRow', 'sourceId', 'sourceType', 'templateId', 'count']);
});

test('format whitespace and attribute order do not drop or merge rows; XML names remain case sensitive', () => {
  const changed = xml.replace(/\r?\n/g, '\n\t').replace('ID="957" template="7024" type="1" count="1"', "count = '1' type='1' template='7024' ID='957'");
  const actual = parseTreasureCatalog(changed), expected = parseTreasureCatalog(xml);
  const rows = catalog => catalog.entries.map(({key, ...row}) => row);
  assert.deepEqual(rows(actual), rows(expected));
  assert.notEqual(actual.source.sha256, expected.source.sha256);
  assert.equal(actual.source.pinned, false);
  for (const changed of [xml.replace('<Item ', '<item '), xml.replace('template=', 'Template='), xml.replace('<Result ', '<result ')]) assert.throws(() => parseTreasureCatalog(changed));
});

test('malformed, extended and lossy catalogs fail closed', () => {
  const first = /  <Item[^\n]+\r?\n/.exec(xml)[0];
  const mutations = [
    xml.replace(first, ''), // Repeated ID is not a reason to discard a row.
    xml.replace(first, first + first),
    xml.replace('template="7027"', 'template="7024"'),
    xml.replace('type="1"', 'type="16"'),
    xml.replace('count="1"', 'count="0"'),
    xml.replace('count="1"', 'count="1.5"'),
    xml.replace('template="7024"', 'template="2147483648"'),
    xml.replace('template="7024"', 'template="07"'),
    xml.replace('count="1"', 'Damage="999" count="1"'),
    xml.replace('count="1"', 'count="1" count="1"'),
    xml.replace('count="1"', ''),
    xml.replace('template="11905" type="7" count="10"', 'template="11905" type="7" count="9"'), // Keep the distinct 11905 quantities.
    xml.replace('<Result', '<!DOCTYPE Result><Result'),
    xml.replace('template="7024"', 'template="&#55;024"'),
    xml.replace('<Item ', '<Item <!--bad--> '),
    xml.replace('</Result>', '<Unexpected /></Result>'),
    xml.replace('value="true"', 'value="false"'),
    xml.replace('ID="957" template=', 'ID="957"template='),
    xml.replace('ID="957"', 'ID="\u0000957"'),
  ];
  mutations.forEach((value, index) => assert.throws(() => parseTreasureCatalog(value), undefined, `mutation ${index}`));
  assert.throws(() => parseTreasureCatalog(Buffer.from([0xff])));
  assert.throws(() => parseTreasureCatalog(' '.repeat(65537)));
});

test('display matching normalizes keys explicitly but preserves source values and excludes all statistics', () => {
  const source = {...display(' 7117 ', ' Flower ', '7', '0'), Name: 'not an identity', Attack: 999999};
  const local = {...display(7117, 'flower'), Name: 'different name', Defence: 999999};
  const result = resolveTreasureDisplayIdentities([source], [local]);
  assert.deepEqual(result.counts, {matched: 1, missing: 0, identityConflict: 0});
  assert.equal(result.entries[0].status, 'matched');
  assert.equal(result.entries[0].reference.Pic, ' Flower ');
  assert.equal(result.entries[0].reference.TemplateID, ' 7117 ');
  assert.equal(result.entries[0].local.Pic, 'flower');
  assert.match(result.identityKeyNormalization.Pic, /trimmed and lowercased/);
  assert(!JSON.stringify(result).includes('999999'));
  assert(!JSON.stringify(result).includes('Name'));
  assert.equal(result.drawable, false);
  assert.equal(result.entries[0].runtimeMapping, null);
});

test('same-ID conflict remains a conflict even when exactly one other ID has the matching appearance', () => {
  const result = resolveTreasureDisplayIdentities([display(7117, 'Sthebouquet')], [display(7117, 'SSbombpack'), display(9234, 'sthebouquet')]);
  const row = result.entries[0];
  assert.equal(row.status, 'identity-conflict');
  assert.equal(row.templateId, 7117);
  assert.equal(row.local.TemplateID, 7117);
  assert.equal(row.appearanceCandidate.status, 'unique');
  assert.deepEqual(row.appearanceCandidate.candidates.map(candidate => candidate.templateId), [9234]);
  assert.equal(row.appearanceCandidate.candidateOnly, true);
  assert.equal(row.runtimeMapping, null);
});

test('missing IDs, identity dimensions and ambiguous appearance candidates never infer a mapping', () => {
  const reference = [display(10, 'x'), display(11, 'x', 31), display(12, 'x', 7, 1), display(13, 'unknown')];
  const local = [display(11, 'x', 17), display(12, 'x', 7, 2), display(21, 'x'), display(20, 'x')];
  const result = resolveTreasureDisplayIdentities(reference, local);
  assert.deepEqual(result.counts, {matched: 0, missing: 2, identityConflict: 2});
  assert.equal(result.entries[0].appearanceCandidate.status, 'ambiguous');
  assert.deepEqual(result.entries[0].appearanceCandidate.candidates.map(row => row.templateId), [20, 21]);
  assert(result.entries.every(row => row.runtimeMapping === null));
  assert.equal(result.entries[1].appearanceCandidate.status, 'none');
  assert.equal(result.entries[2].appearanceCandidate.status, 'none');
  assert.equal(result.entries[3].appearanceCandidate.status, 'none');
  assert.deepEqual(resolveTreasureDisplayIdentities([], []).entries, []);
});

test('display metadata requires unambiguous IDs and complete valid identities', () => {
  const valid = display(7, 'valid');
  for (const key of ['TemplateID', 'CategoryID', 'Pic', 'NeedSex']) {
    const missing = {...valid}; delete missing[key];
    assert.throws(() => resolveTreasureDisplayIdentities([missing], []));
  }
  for (const bad of [display(0, 'x'), display(7, '  '), display(7, 'x\u0000'), display(7, 'x', -1), display(7, 'x', 7, 3), display('7.0', 'x'), display(true, 'x'), {...valid, templateid: 8, TemplateID: undefined}]) {
    assert.throws(() => resolveTreasureDisplayIdentities([bad], []));
  }
  assert.throws(() => resolveTreasureDisplayIdentities([valid, {...valid}], []), /duplicate reference TemplateID/);
  assert.throws(() => resolveTreasureDisplayIdentities([], [valid, {...valid, TemplateID: '7'}]), /duplicate local TemplateID/);
});

function preparationFixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'ddtank-treasure-catalog-'));
  t.after(() => {
    // Only this fresh fixture under the system temp directory may be removed recursively.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('ddtank-treasure-catalog-'));
    rmSync(root, {recursive: true, force: true});
  });
  const sourcePaths = [
    ['reference-snapshot', 'runtime/weapon-original-effects-20261015/bubble-reference/public-inputs/templates.decoded.xml'],
    ['local-snapshot', 'runtime/online-box-followup-20261013/clothing-install-real252-20261014/canonical-deployed/template-current-plain.xml'],
  ];
  const templateSources = sourcePaths.map(([kind, file]) => {
    const path = resolve(project, file), bytes = readFileSync(path);
    return {kind, path, sha256: createHash('sha256').update(bytes).digest('hex')};
  });
  const required = new Set(parseTreasureCatalog(xml).entries.map(row => row.templateId));
  const referenceTemplates = [...readFileSync(templateSources[0].path, 'utf8').matchAll(/<Item\b([^<>]*)\/>/g)].flatMap(match => {
    const get = name => new RegExp(`\\b${name}="([^"]*)"`).exec(match[1])?.[1];
    const TemplateID = Number(get('TemplateID'));
    return required.has(TemplateID) ? [display(TemplateID, get('Pic'), Number(get('CategoryID')), Number(get('NeedSex')))] : [];
  });
  assert.equal(referenceTemplates.length, 157);
  return {root, input: {projectRoot: project, outputDir: resolve(root, 'prepared'), referenceTemplates, localTemplates: [referenceTemplates[0]], templateSources}};
}

test('offline preparation serializes every original row and display-only identity without changing runtime', t => {
  const {input} = preparationFixture(t);
  const manifest = prepareTreasureCatalog(input);
  assert.equal(manifest.referenceOnly, true);
  assert.equal(manifest.runtimeLoaded, false);
  assert.equal(manifest.installed, false);
  assert.equal(manifest.gameAccepted, false);
  assert.deepEqual(readdirSync(input.outputDir).sort(), ['display-identities.json', 'manifest.json', 'original-catalog.json']);
  const catalog = JSON.parse(readFileSync(resolve(input.outputDir, 'original-catalog.json'), 'utf8'));
  const identities = JSON.parse(readFileSync(resolve(input.outputDir, 'display-identities.json'), 'utf8'));
  assert.equal(catalog.entries.length, 158);
  assert.equal(identities.identities.entries.length, 157);
  assert.deepEqual(identities.identities.counts, {matched: 1, missing: 156, identityConflict: 0});
  assert.equal(identities.currentDatabaseVerified, false);
  assert.equal(identities.importedEquipmentProperties, false);
  for (const output of manifest.outputs) {
    const bytes = readFileSync(resolve(input.outputDir, output.file));
    assert.equal(bytes.length, output.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), output.sha256);
  }
  for (const row of identities.identities.entries) {
    assert.deepEqual(Object.keys(row.reference), ['TemplateID', 'CategoryID', 'Pic', 'NeedSex']);
    assert.equal(row.runtimeMapping, null);
  }
});

test('preparation refuses an old output directory and preserves all existing output bytes', t => {
  const {input} = preparationFixture(t);
  prepareTreasureCatalog(input);
  const before = readdirSync(input.outputDir).map(file => [file, readFileSync(resolve(input.outputDir, file))]);
  assert.throws(() => prepareTreasureCatalog(input), /preserve prior catalog preparation/);
  assert.deepEqual(readdirSync(input.outputDir), before.map(([file]) => file));
  for (const [file, bytes] of before) assert.deepEqual(readFileSync(resolve(input.outputDir, file)), bytes);
});

test('preparation refuses incomplete or extra reference coverage before creating output', t => {
  const {input} = preparationFixture(t);
  assert.throws(() => prepareTreasureCatalog({...input, referenceTemplates: input.referenceTemplates.slice(1)}));
  assert.equal(existsSync(input.outputDir), false);
  const changed = [...input.referenceTemplates];
  changed[0] = {...changed[0], TemplateID: 123456789};
  assert.throws(() => prepareTreasureCatalog({...input, referenceTemplates: changed}), /cover exactly/);
  assert.equal(existsSync(input.outputDir), false);
});

test('preparation refuses changed source bytes before creating output', t => {
  const {input, root} = preparationFixture(t);
  const changedPath = resolve(root, 'changed-source.xml');
  writeFileSync(changedPath, Buffer.concat([readFileSync(input.templateSources[0].path), Buffer.from('\n')]));
  const templateSources = input.templateSources.map((source, index) => index ? source : {...source, path: changedPath});
  assert.throws(() => prepareTreasureCatalog({...input, templateSources}), /template source bytes changed/);
  assert.equal(existsSync(input.outputDir), false);
});

function weaponPreparationFixture(t) {
  const {input} = preparationFixture(t);
  const official = loadOfficialWeaponSnapshot(project).records.find(row => row.templateId === 7024);
  const fields = Object.fromEntries(WEAPON_FIELDS.map(field => [field, official[field[0].toLowerCase() + field.slice(1)]]));
  const local = {...display(7024, 'boomerang'), ...fields};
  return {input: {...input, localTemplates: [display(7024, 'boomerang')],
    weaponInputs: {localTemplates: [local], mappings: [{sourceTemplateId: 7024, localTemplateId: 7024}]}}, fields};
}

test('optional weapon preparation uses the pinned official snapshot and preserves all original rows', t => {
  const {input, fields} = weaponPreparationFixture(t);
  const before = JSON.stringify(input);
  const manifest = prepareTreasureCatalog(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(manifest.outputs.length, 3);
  const weapons = JSON.parse(readFileSync(resolve(input.outputDir, 'weapon-mappings.json'), 'utf8'));
  assert.equal(weapons.entries.length, 15);
  assert.equal(weapons.officialProvenanceVerified, true);
  assert.equal(weapons.officialSnapshotSources.length, 6);
  assert.equal(weapons.officialSnapshotSummary.records, 670);
  assert.equal(weapons.officialSnapshotSummary.sha256, '2d5deb59f0387b7c82c335dc3c1b3eb8c343fc94665af54bfb3049ca25458683');
  assert.equal(weapons.localMetadataDerivationVerified, false);
  assert.equal(weapons.installed, false);
  assert.equal(weapons.runtimeReady, false);
  assert.equal(weapons.officialBallConfig, false);
  const mapped = weapons.entries.find(row => row.sourceTemplateId === 7024);
  assert.equal(mapped.status, 'explicitly-mapped');
  assert.deepEqual(mapped.officialFields, fields);
  assert.equal(mapped.runtimeMapping, null);
  assert.equal(weapons.entries.filter(row => row.status === 'missing-official').length, 3);
  const artifact = manifest.outputs.find(row => row.file === 'weapon-mappings.json');
  const bytes = readFileSync(resolve(input.outputDir, artifact.file));
  assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(manifest.sources.length, 3);
});

test('optional weapon preparation rejects caller official overrides and local display drift before output', t => {
  const {input} = weaponPreparationFixture(t);
  assert.throws(() => prepareTreasureCatalog({...input, weaponInputs: {...input.weaponInputs, officialRecords: []}}), /unknown weaponInputs fields/);
  assert.equal(existsSync(input.outputDir), false);
  const localTemplates = input.weaponInputs.localTemplates.map(row => ({...row, Pic: 'other-weapon'}));
  assert.throws(() => prepareTreasureCatalog({...input, weaponInputs: {...input.weaponInputs, localTemplates}}), /display metadata differs/);
  assert.equal(existsSync(input.outputDir), false);
});

test('local weapon stat drift is retained as a conflict instead of rewriting the old template', t => {
  const {input, fields} = weaponPreparationFixture(t);
  input.weaponInputs.localTemplates[0].Attack += 1;
  const before = JSON.stringify(input);
  prepareTreasureCatalog(input);
  const weapons = JSON.parse(readFileSync(resolve(input.outputDir, 'weapon-mappings.json'), 'utf8'));
  const row = weapons.entries.find(entry => entry.sourceTemplateId === 7024);
  assert.equal(row.status, 'mapping-field-conflict');
  assert.equal(row.officialFields.Attack, fields.Attack);
  assert.equal(row.runtimeMapping, null);
  assert.equal(JSON.stringify(input), before);
});

test('unserializable caller fields are rejected before creating any preparation output', t => {
  const {input} = weaponPreparationFixture(t);
  input.weaponInputs.localTemplates[0].Attack = BigInt(145);
  assert.throws(() => prepareTreasureCatalog(input), /BigInt/);
  assert.equal(existsSync(input.outputDir), false);
});
