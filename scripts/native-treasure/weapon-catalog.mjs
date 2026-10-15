// Offline official-field candidates only; this file never installs an item or enables delivery.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {resolveTreasureDisplayIdentities} from './catalog.mjs';

export const WEAPON_FIELDS = Object.freeze(['Attack', 'Defence', 'Agility', 'Luck', ...Array.from({length: 8}, (_, i) => `Property${i + 1}`)]);
const area = 'runtime/content-expansion-20261012/weapons/round2';
const catalogSha = '2d5deb59f0387b7c82c335dc3c1b3eb8c343fc94665af54bfb3049ca25458683';
const pageShas = [
  'ea598c527a5c373cb288273f5c0f84b1a3b711506fe1596aae6c834880620771',
  '7989aff3f694316c7736bf4ba15038a3cbce8a754fb20942ca38216e24bdf279',
  '338a2ba5b46fec0cb85112f6b069efa2b38230a07d416e3dc3bfc5a99ed36f00',
  '7502e61d4c1e7b031c7093d0d35082aa58d125f70a2c68aa16c2831e59582b99',
  '89ba4d7b2087a9348a3116c858a09a01c23a44cb16e43cde76a149b3c0d22b00',
  'fcf5463f9bc67db1e8c515b903dff5eede2015edb73e2cca09545b13e86f743b',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const state = {referenceOnly: true, installed: false, runtimeReady: false, runtimeMapping: null, officialBallConfig: false};
const canonical = value => JSON.stringify(value, function (key, entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(name => [name, entry[name]])) : entry;
});

function integer(value, label, min = 0) {
  if (typeof value === 'string') {
    assert(/^(0|[1-9][0-9]*)$/.test(value.trim()), `invalid integer ${label}`);
    value = Number(value.trim());
  }
  assert(Number.isSafeInteger(value) && value >= min && value <= 0x7fffffff, `invalid integer ${label}`);
  return value;
}

function weaponIdentity(row) {
  assert(row && typeof row === 'object' && !Array.isArray(row), 'official record object required');
  const templateId = integer(row.templateId, 'official templateId', 1);
  assert.equal(row.category, 'weapon', `official ${templateId} category`);
  assert.equal(row.categoryId, 7, `official ${templateId} CategoryID`);
  assert(Number.isInteger(row.needSex) && row.needSex >= 0 && row.needSex <= 2, `official ${templateId} NeedSex`);
  assert.equal(typeof row.pic, 'string', `official ${templateId} Pic`);
  const match = /^\/image\/arm\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/1\/0\/show\.png$/.exec(row.pic);
  assert(match, `official ${templateId} arm Pic path`);
  return {TemplateID: templateId, CategoryID: 7, Pic: match[1], NeedSex: row.needSex};
}

function officialFields(row) {
  return Object.fromEntries(WEAPON_FIELDS.map(field => {
    const value = row[field[0].toLowerCase() + field.slice(1)];
    assert(typeof value === 'number', `official ${row.templateId} ${field} must be a JSON integer`);
    return [field, integer(value, `official ${row.templateId} ${field}`)];
  }));
}

/** Fixed historical public snapshot. Receipts are checked against pinned bytes, not caller claims. */
export function loadOfficialWeaponSnapshot(projectRoot) {
  assert(typeof projectRoot === 'string' && projectRoot.trim(), 'projectRoot required');
  const read = name => {
    const path = resolve(projectRoot, area, name), bytes = readFileSync(path);
    return {path, bytes, value: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))};
  };
  const merged = [], sources = [];
  for (let page = 1; page <= 6; page++) {
    const name = `official-weapon-page${page}`, response = read(`${name}.response`), receipt = read(`${name}.receipt.json`);
    const expectedSha = pageShas[page - 1];
    assert.equal(sha(response.bytes), expectedSha, `official page ${page} SHA-256`);
    const expectedUrl = `https://diy-ddt.wan.com/dressup-api/shopGood/pageList?pageNum=${page}&pageSize=120&category=weapon&sourceTypeList%5B%5D=0&sourceTypeList%5B%5D=1`;
    assert.equal(receipt.value.url, expectedUrl, `official page ${page} receipt URL`);
    assert.equal(receipt.value.status, 200, `official page ${page} HTTP status`);
    assert.equal(receipt.value.authenticated, false, `official page ${page} anonymous source`);
    assert.equal(receipt.value.contentType, 'application/json', `official page ${page} content type`);
    assert.equal(receipt.value.sha256, expectedSha, `official page ${page} receipt SHA-256`);
    assert.equal(receipt.value.bytes, response.bytes.length, `official page ${page} receipt bytes`);
    assert.equal(response.value.code, 200, `official page ${page} success code`);
    const {records, ...pagination} = response.value.data ?? {};
    assert.deepEqual(pagination, {total: 670, size: 120, current: page, pages: 6}, `official page ${page} pagination`);
    assert(Array.isArray(records) && records.length === (page === 6 ? 70 : 120), `official page ${page} record count`);
    merged.push(...records);
    sources.push({page, url: expectedUrl, path: response.path, sha256: expectedSha, bytes: response.bytes.length,
      receipt: {path: receipt.path, sha256: sha(receipt.bytes)}, records: records.length});
  }
  const summary = read('official-weapon-catalog.json');
  assert.equal(sha(summary.bytes), catalogSha, 'official merged catalog SHA-256');
  assert(Array.isArray(summary.value) && summary.value.length === 670, 'official merged catalog count');
  assert.equal(canonical(merged), canonical(summary.value), 'official pages and merged catalog canonical records');
  const ids = summary.value.map(row => {
    const identity = weaponIdentity(row);
    officialFields(row);
    return identity.TemplateID;
  });
  assert.equal(new Set(ids).size, 670, 'duplicate official templateId');
  const records = Object.freeze(summary.value.map(row => Object.freeze(row)));
  return {schemaVersion: 1, ...state, officialProvenanceVerified: true, snapshotLiveRefreshed: false,
    records, sources, summary: {path: summary.path, sha256: catalogSha, bytes: summary.bytes.length, records: 670}};
}

function comparison(local, expected = null) {
  if (!local) return null;
  const values = {}, differences = [];
  for (const field of WEAPON_FIELDS) {
    values[field] = Object.hasOwn(local, field) ? local[field] : null;
    if (!expected) continue;
    let normalized = null;
    try { normalized = integer(local[field], `local ${local.TemplateID} ${field}`); } catch { /* Invalid old values stay visible. */ }
    if (normalized === null || normalized !== expected[field]) differences.push({field, localValue: values[field], officialValue: expected[field], validLocalInteger: normalized !== null});
  }
  return {templateId: integer(local.TemplateID, 'local TemplateID', 1), values, differences: expected ? differences : null};
}

/** Pure caller-data comparison; only loadOfficialWeaponSnapshot supplies fixed-source evidence. */
export function resolveTreasureWeaponMappings({catalog, referenceTemplates, localTemplates, officialRecords, mappings = []}) {
  assert(catalog && Array.isArray(catalog.entries), 'catalog entries required');
  assert(Array.isArray(referenceTemplates) && Array.isArray(localTemplates) && Array.isArray(officialRecords) && Array.isArray(mappings), 'template/record/mapping arrays required');
  // Reuse the existing identity owner for validation and the same Pic normalization.
  const allIdentities = resolveTreasureDisplayIdentities(referenceTemplates, localTemplates);
  const references = new Map(referenceTemplates.map(row => [integer(row.TemplateID, 'reference TemplateID', 1), row]));
  const locals = new Map(localTemplates.map(row => [integer(row.TemplateID, 'local TemplateID', 1), row]));
  const identities = new Map(allIdentities.entries.map(row => [row.templateId, row]));
  const weaponRows = catalog.entries.filter(row => {
    const reference = references.get(integer(row.templateId, 'catalog templateId', 1));
    assert(reference, `missing reference display ${row.templateId}`);
    return integer(reference.CategoryID, 'reference CategoryID', 1) === 7;
  });
  assert.equal(weaponRows.length, 15, 'original catalog weapon row count');
  const sourceIds = new Set(weaponRows.map(row => integer(row.templateId, 'source TemplateID', 1)));
  assert.equal(sourceIds.size, 15, 'duplicate original weapon TemplateID');
  const officials = new Map();
  for (const row of officialRecords) {
    const display = weaponIdentity(row), id = display.TemplateID;
    assert(!officials.has(id), `duplicate official templateId ${id}`);
    officials.set(id, {row, display});
  }
  const explicit = new Map(), targetIds = new Set();
  for (const mapping of mappings) {
    assert(mapping && typeof mapping === 'object' && !Array.isArray(mapping), 'mapping object required');
    assert.deepEqual(Object.keys(mapping).sort(), ['localTemplateId', 'sourceTemplateId'], 'mapping fields');
    const sourceId = integer(mapping.sourceTemplateId, 'mapping sourceTemplateId', 1), localId = integer(mapping.localTemplateId, 'mapping localTemplateId', 1);
    assert(sourceIds.has(sourceId), `unknown mapping source ${sourceId}`);
    assert(locals.has(localId), `unknown mapping target ${localId}`);
    assert(!explicit.has(sourceId), `duplicate mapping source ${sourceId}`);
    assert(!targetIds.has(localId), `duplicate mapping target ${localId}`);
    explicit.set(sourceId, localId); targetIds.add(localId);
  }
  const entries = weaponRows.map(row => {
    const sourceTemplateId = integer(row.templateId, 'source TemplateID', 1), reference = references.get(sourceTemplateId), identity = identities.get(sourceTemplateId);
    const official = officials.get(sourceTemplateId), mappedId = explicit.get(sourceTemplateId), selected = mappedId === undefined ? null : locals.get(mappedId);
    const base = {key: row.key, sourceRow: row.sourceRow, sourceId: row.sourceId, sourceType: row.sourceType, sourceTemplateId, count: row.count,
      reference: identity.reference, sameIdIdentity: identity.status, appearanceCandidate: identity.appearanceCandidate,
      ...state, officialProvenanceVerified: false, officialFields: null, localComparison: comparison(locals.get(sourceTemplateId)),
      explicitMapping: mappedId === undefined ? null : {sourceTemplateId, localTemplateId: mappedId, accepted: false},
      mappedComparison: comparison(selected)};
    if (!official) return {...base, status: 'missing-official', reasons: ['Original official templateId is absent; another ID is never substituted.']};
    const officialIdentity = resolveTreasureDisplayIdentities([reference], [official.display]).entries[0];
    if (officialIdentity.status !== 'matched') return {...base, status: 'official-identity-conflict', reasons: ['Official original-ID category/Pic/sex does not match the reference display.']};
    const fields = officialFields(official.row), localComparison = comparison(locals.get(sourceTemplateId), fields);
    const proposal = {...base, officialFields: fields, localComparison};
    if (!selected) return {...proposal, status: 'unmapped', reasons: ['An explicit source-to-local mapping is required even for matching IDs and fields.']};
    const selectedIdentity = resolveTreasureDisplayIdentities([reference], [{...selected, TemplateID: sourceTemplateId}]).entries[0];
    const mappedComparison = comparison(selected, fields);
    if (selectedIdentity.status !== 'matched') return {...proposal, mappedComparison, status: 'mapping-display-conflict', reasons: ['Explicit target category/Pic/sex does not match the original weapon.']};
    if (mappedComparison.differences.length) return {...proposal, mappedComparison, status: 'mapping-field-conflict', reasons: ['Explicit target differs from the official 12 integer fields; old values are preserved.']};
    return {...proposal, mappedComparison, status: 'explicitly-mapped', reasons: [], explicitMapping: {...base.explicitMapping, accepted: true}};
  });
  return {schemaVersion: 1, ...state, officialProvenanceVerified: false,
    boundary: 'Caller-data field candidates only. Fixed official-source evidence must come from loadOfficialWeaponSnapshot; mappings do not install or prove projectile physics, effects, skills or item delivery.',
    counts: {weaponRows: entries.length, uniqueSourceTemplateIds: sourceIds.size,
      officialPresent: entries.filter(row => row.status !== 'missing-official').length,
      missingOfficial: entries.filter(row => row.status === 'missing-official').length,
      explicitMappings: mappings.length, acceptedMappings: entries.filter(row => row.explicitMapping?.accepted).length}, entries};
}
