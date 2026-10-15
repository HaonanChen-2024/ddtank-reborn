import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadOfficialWeaponSnapshot, resolveTreasureWeaponMappings, WEAPON_FIELDS} from './weapon-catalog.mjs';

const ids = [7024, 7027, 7026, 7238, 7117, 7223, 7058, 7190, 7057, 7063, 7133, 7242, 7089, 7164, 7194];
const missingIds = [7238, 7242, 7164];
const fields = Object.fromEntries(WEAPON_FIELDS.map((field, index) => [field, index + 1]));
const display = id => ({TemplateID: id, CategoryID: 7, Pic: `weapon${id}`, NeedSex: 0});
function inputs() {
  return {
    catalog: {entries: ids.map((id, index) => ({key: `source:${index + 1}`, sourceRow: index + 1, sourceId: index + 1,
      sourceType: index < 12 ? 1 : 15, templateId: id, count: 1}))},
    referenceTemplates: ids.map(id => ({...display(id), Attack: 999999})),
    localTemplates: ids.map(id => ({...display(id), ...fields})),
    officialRecords: ids.filter(id => !missingIds.includes(id)).map(id => ({templateId: id, category: 'weapon', categoryId: 7,
      needSex: 0, pic: `/image/arm/weapon${id}/1/0/show.png`, ...Object.fromEntries(WEAPON_FIELDS.map(field => [field[0].toLowerCase() + field.slice(1), fields[field]]))})),
    mappings: [],
  };
}
const rowFor = (report, id) => report.entries.find(row => row.sourceTemplateId === id);

test('all 15 original row identities remain; no same-ID automatic mappings and no private statistics leak', () => {
  const input = inputs(), result = resolveTreasureWeaponMappings(input);
  assert.deepEqual(result.counts, {weaponRows: 15, uniqueSourceTemplateIds: 15, officialPresent: 12, missingOfficial: 3, explicitMappings: 0, acceptedMappings: 0});
  assert.deepEqual(result.entries.map(row => row.sourceTemplateId), ids);
  assert.deepEqual(result.entries.map(({key, sourceRow, sourceId, sourceType, sourceTemplateId, count}) => ({key, sourceRow, sourceId, sourceType, templateId: sourceTemplateId, count})), input.catalog.entries);
  assert.deepEqual(result.entries.filter(row => row.status === 'missing-official').map(row => row.sourceTemplateId), missingIds);
  assert(result.entries.every(row => row.runtimeMapping === null && row.installed === false && row.runtimeReady === false && row.officialBallConfig === false));
  assert(result.entries.every(row => row.explicitMapping === null));
  assert.equal(result.officialProvenanceVerified, false);
  assert(!JSON.stringify(result).includes('999999'));
  assert.deepEqual(rowFor(result, 7024).officialFields, fields);
  assert.deepEqual(rowFor(result, 7238).localComparison.values, fields);
  assert.equal(rowFor(result, 7238).localComparison.differences, null);
});

test('only explicit display-and-field-equal mappings are accepted, still as offline candidates', () => {
  const input = inputs(); input.mappings = [{sourceTemplateId: 7024, localTemplateId: 7024}];
  input.localTemplates[0].Pic = ' WEAPON7024 ';
  input.localTemplates[0].Property1 = ' 5 ';
  const result = resolveTreasureWeaponMappings(input), row = rowFor(result, 7024);
  assert.equal(result.counts.acceptedMappings, 1);
  assert.equal(row.status, 'explicitly-mapped');
  assert.equal(row.explicitMapping.accepted, true);
  assert.equal(row.runtimeMapping, null);
  assert.equal(row.officialProvenanceVerified, false);
  assert.equal(row.localComparison.values.Property1, ' 5 ');
  assert.deepEqual(row.mappedComparison.differences, []);
});

test('same appearance under another ID needs an explicit mapping; original official ID cannot be borrowed', () => {
  const input = inputs();
  input.localTemplates.find(row => row.TemplateID === 7089).Pic = 'wrong';
  input.localTemplates.push({...display(7089), ...fields, TemplateID: 7099});
  let row = rowFor(resolveTreasureWeaponMappings(input), 7089);
  assert.deepEqual(row.appearanceCandidate.candidates.map(row => row.templateId), [7099]);
  assert.equal(row.explicitMapping, null); assert.equal(row.status, 'unmapped');
  input.mappings = [{sourceTemplateId: 7089, localTemplateId: 7099}];
  row = rowFor(resolveTreasureWeaponMappings(input), 7089);
  assert.equal(row.status, 'explicitly-mapped');
  input.officialRecords.find(row => row.templateId === 7089).templateId = 7099;
  row = rowFor(resolveTreasureWeaponMappings(input), 7089);
  assert.equal(row.status, 'missing-official');
  assert.equal(row.officialFields, null); assert.equal(row.explicitMapping.accepted, false);
});

for (const field of WEAPON_FIELDS) test(`explicit mapping blocks changed ${field}, retaining both values`, () => {
  const input = inputs(); input.mappings = [{sourceTemplateId: 7024, localTemplateId: 7024}];
  input.localTemplates[0][field] += 1000;
  const row = rowFor(resolveTreasureWeaponMappings(input), 7024);
  assert.equal(row.status, 'mapping-field-conflict'); assert.equal(row.explicitMapping.accepted, false);
  assert.deepEqual(row.mappedComparison.differences, [{field, localValue: fields[field] + 1000, officialValue: fields[field], validLocalInteger: true}]);
  assert.equal(input.localTemplates[0][field], fields[field] + 1000);
});

test('missing or malformed local integers are reported as conflicts rather than defaulted', () => {
  for (const value of [undefined, null, '', '1.5', '0x1', '-1', true, NaN, Infinity, 2147483648]) {
    const input = inputs(); input.mappings = [{sourceTemplateId: 7024, localTemplateId: 7024}];
    if (value === undefined) delete input.localTemplates[0].Attack; else input.localTemplates[0].Attack = value;
    const row = rowFor(resolveTreasureWeaponMappings(input), 7024);
    assert.equal(row.status, 'mapping-field-conflict');
    assert.equal(row.mappedComparison.differences[0].validLocalInteger, false);
  }
});

test('original official and explicit target display dimensions must all agree', () => {
  for (const [key, value] of [['Pic', 'other'], ['NeedSex', 1], ['CategoryID', 17]]) {
    const input = inputs(); input.mappings = [{sourceTemplateId: 7024, localTemplateId: 7024}];
    input.localTemplates[0][key] = value;
    assert.equal(rowFor(resolveTreasureWeaponMappings(input), 7024).status, 'mapping-display-conflict');
  }
  for (const [key, value] of [['pic', '/image/arm/other/1/0/show.png'], ['needSex', 1]]) {
    const input = inputs(); input.officialRecords[0][key] = value;
    const row = rowFor(resolveTreasureWeaponMappings(input), 7024);
    assert.equal(row.status, 'official-identity-conflict'); assert.equal(row.officialFields, null);
  }
});

test('malformed paths, types, duplicate official IDs and incomplete official integer fields fail closed', () => {
  for (const [key, value] of [['category', 'hat'], ['categoryId', 17], ['categoryId', '7'], ['needSex', 3], ['needSex', '0'],
    ['pic', '/image/arm/../1/0/show.png'], ['pic', 'https://example.com/image/arm/weapon7024/1/0/show.png'],
    ['pic', '/image/arm/weapon7024/1/0/show.png?x=1'], ['pic', '/image/arm/weapon%327024/1/0/show.png'],
    ['pic', '/image/arm/weapon7024/1/icon.png'], ['attack', '1'], ['attack', null], ['property8', 1.5]]) {
    const input = inputs(); input.officialRecords[0][key] = value;
    assert.throws(() => resolveTreasureWeaponMappings(input), undefined, `${key}=${value}`);
  }
  for (const field of WEAPON_FIELDS) {
    const input = inputs(); delete input.officialRecords[0][field[0].toLowerCase() + field.slice(1)];
    assert.throws(() => resolveTreasureWeaponMappings(input), /must be a JSON integer/);
  }
  const input = inputs(); input.officialRecords.push({...input.officialRecords[0]});
  assert.throws(() => resolveTreasureWeaponMappings(input), /duplicate official templateId/);
});

test('unknown, duplicate, extended or ambiguous mappings are rejected', () => {
  for (const mappings of [
    [{sourceTemplateId: 9999, localTemplateId: 7024}], [{sourceTemplateId: 7024, localTemplateId: 9999}],
    [{sourceTemplateId: 7024, localTemplateId: 7024}, {sourceTemplateId: 7024, localTemplateId: 7027}],
    [{sourceTemplateId: 7024, localTemplateId: 7024}, {sourceTemplateId: 7027, localTemplateId: 7024}],
    [{sourceTemplateId: 7024, localTemplateId: 7024, official: true}], [null],
  ]) assert.throws(() => resolveTreasureWeaponMappings({...inputs(), mappings}));
  const input = inputs(); input.localTemplates.push({...input.localTemplates[0]});
  assert.throws(() => resolveTreasureWeaponMappings(input), /duplicate local TemplateID/);
});

test('incomplete or duplicate original weapon rows and absent reference display fail closed', () => {
  let input = inputs(); input.catalog.entries.pop();
  assert.throws(() => resolveTreasureWeaponMappings(input), /original catalog weapon row count/);
  input = inputs(); input.catalog.entries[1] = {...input.catalog.entries[0]};
  assert.throws(() => resolveTreasureWeaponMappings(input), /duplicate original weapon TemplateID/);
  input = inputs(); input.referenceTemplates.pop();
  assert.throws(() => resolveTreasureWeaponMappings(input), /missing reference display/);
});

test('caller official flags never supply verified provenance', () => {
  const input = inputs(); input.official = true; input.officialProvenanceVerified = true;
  input.officialRecords.forEach(row => { row.official = true; });
  const result = resolveTreasureWeaponMappings(input);
  assert.equal(result.officialProvenanceVerified, false);
  assert(result.entries.every(row => row.officialProvenanceVerified === false));
});

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const officialArea = 'runtime/content-expansion-20261012/weapons/round2';
const snapshotAvailable = existsSync(resolve(projectRoot, officialArea, 'official-weapon-catalog.json'));
function fixture(t, withSnapshot = false) {
  const root = mkdtempSync(resolve(tmpdir(), 'treasure-official-test-')), target = resolve(root, officialArea);
  mkdirSync(target, {recursive: true});
  t.after(() => {
    assert(root.startsWith(resolve(tmpdir()) + sep) && root.includes('treasure-official-test-'));
    rmSync(root, {recursive: true});
  });
  if (withSnapshot) {
    for (const file of ['official-weapon-catalog.json', ...Array.from({length: 6}, (_, i) => `official-weapon-page${i + 1}`).flatMap(name => [`${name}.response`, `${name}.receipt.json`])]) copyFileSync(resolve(projectRoot, officialArea, file), resolve(target, file));
  }
  return {root, target};
}

test('fixed loader refuses caller-created official receipts and content', t => {
  const {root, target} = fixture(t);
  writeFileSync(resolve(target, 'official-weapon-page1.response'), '{}');
  writeFileSync(resolve(target, 'official-weapon-page1.receipt.json'), JSON.stringify({official: true}));
  assert.throws(() => loadOfficialWeaponSnapshot(root), /official page 1 SHA-256/);
});

test('historical snapshot validates six pages, 670 records and fixed source receipts', {skip: !snapshotAvailable && 'optional historical source snapshot not present'}, () => {
  const result = loadOfficialWeaponSnapshot(projectRoot);
  assert.equal(result.records.length, 670); assert.equal(result.sources.length, 6);
  assert.equal(result.officialProvenanceVerified, true); assert.equal(result.snapshotLiveRefreshed, false);
  assert.equal(result.installed, false); assert.equal(result.runtimeReady, false); assert.equal(result.officialBallConfig, false);
  assert(Object.isFrozen(result.records) && result.records.every(Object.isFrozen));
});

test('fixed loader rejects each changed original page, summary drift and receipt URL substitution', {skip: !snapshotAvailable && 'optional historical source snapshot not present'}, t => {
  const {root, target} = fixture(t, true);
  for (let page = 1; page <= 6; page++) {
    const file = resolve(target, `official-weapon-page${page}.response`), bytes = readFileSync(file);
    writeFileSync(file, Buffer.concat([bytes, Buffer.from('\n')]));
    assert.throws(() => loadOfficialWeaponSnapshot(root), new RegExp(`official page ${page} SHA-256`));
    writeFileSync(file, bytes);
  }
  const catalog = resolve(target, 'official-weapon-catalog.json'), bytes = readFileSync(catalog);
  writeFileSync(catalog, Buffer.concat([bytes, Buffer.from('\n')]));
  assert.throws(() => loadOfficialWeaponSnapshot(root), /official merged catalog SHA-256/); writeFileSync(catalog, bytes);
  const receipt = resolve(target, 'official-weapon-page1.receipt.json'), original = readFileSync(receipt), data = JSON.parse(original);
  for (const url of [data.url.replace('diy-ddt.wan.com', 'example.com'), data.url.replace('category=weapon', 'category=hat'), data.url.replace('pageNum=1', 'pageNum=2')]) {
    writeFileSync(receipt, JSON.stringify({...data, url}));
    assert.throws(() => loadOfficialWeaponSnapshot(root), /receipt URL/);
  }
});
