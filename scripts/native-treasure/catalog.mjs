import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {inflateSync} from 'node:zlib';

const area = 'runtime/reference-activities-completion-20261014/native-maze-analysis-20261015';
const rawSha = '739530d89d7802ad8ce641627b72a1b6207bbec49044ea9035e495f1a35e285b';
const decodedSha = '2e970255b8a8fe5a503deea827c4865e651ebecc5ee0666d838030343bc4687c';
const rowsPerCategory = [12, 12, 12, 12, 12, 9, 10, 12, 5, 8, 12, 6, 12, 12, 12];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const referenceState = {status: 'reference-only', drawable: false};

function attributes(text, allowed) {
  const result = {};
  const pattern = /\s+([A-Za-z_][\w.-]*)\s*=\s*("[^"<>]*"|'[^'<>]*')/y;
  let at = 0;
  while (at < text.length && text.slice(at).trim()) {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    assert(match, 'invalid XML attribute syntax');
    const [, name, quoted] = match;
    assert(allowed.includes(name), `unexpected XML attribute ${name}`);
    assert(!Object.hasOwn(result, name), `duplicate XML attribute ${name}`);
    result[name] = quoted.slice(1, -1);
    at = pattern.lastIndex;
  }
  assert.equal(Object.keys(result).length, allowed.length, 'missing XML attribute');
  return result;
}

function integer(value, name, min = 1, max = 0x7fffffff) {
  if (typeof value === 'string') {
    value = value.trim();
    assert(/^(0|[1-9][0-9]*)$/.test(value), `invalid integer ${name}`);
    value = Number(value);
  }
  assert(Number.isSafeInteger(value) && value >= min && value <= max, `invalid integer ${name}`);
  return value;
}

/** Strict parser for this offline numeric XML format, not a general XML/HTTP parser. */
export function parseTreasureCatalog(xml) {
  assert(typeof xml === 'string' || xml instanceof Uint8Array, 'catalog must be UTF-8 XML');
  const bytes = typeof xml === 'string' ? Buffer.from(xml, 'utf8') : Buffer.from(xml);
  assert(bytes.length > 0 && bytes.length <= 65536, 'invalid catalog size');
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  assert(!/[^\x09\x0a\x0d\x20-\x7e]/.test(text), 'catalog contains unsupported XML characters');
  const root = /^\s*<Result\b([^<>]*)>([\s\S]*)<\/Result>\s*$/.exec(text);
  assert(root, 'invalid Result document');
  assert.deepEqual(attributes(root[1], ['value', 'message']), {value: 'true', message: 'Success!'});
  const sourceSha256 = sha(bytes), entries = [], seenRows = new Set();
  const pattern = /<Item\b([^<>]*)\/>/g;
  let at = 0;
  for (const match of root[2].matchAll(pattern)) {
    assert(!root[2].slice(at, match.index).trim(), 'unexpected catalog content');
    const row = attributes(match[1], ['ID', 'template', 'type', 'count']);
    const sourceId = integer(row.ID, 'ID'), sourceType = integer(row.type, 'type', 1, 15);
    const templateId = integer(row.template, 'template'), count = integer(row.count, 'count');
    const identity = JSON.stringify([sourceId, sourceType, templateId, count]);
    assert(!seenRows.has(identity), 'duplicate complete catalog row');
    seenRows.add(identity);
    const sourceRow = entries.length + 1;
    entries.push({key: `${sourceSha256}:${sourceRow}`, sourceRow, sourceId, sourceType, templateId, count});
    at = match.index + match[0].length;
  }
  assert(!root[2].slice(at).trim(), 'unexpected catalog content');
  assert.equal(entries.length, 158, 'catalog row count');
  const categories = rowsPerCategory.map((count, i) => {
    const sourceType = i + 1, rows = entries.filter(row => row.sourceType === sourceType);
    assert.equal(rows.length, count, `catalog category ${sourceType} row count`);
    return {sourceType, selectable: sourceType < 15, special: sourceType === 15, entryKeys: rows.map(row => row.key)};
  });
  const templateIds = new Set(entries.map(row => row.templateId));
  const sourceIds = new Set(entries.map(row => row.sourceId));
  assert.equal(templateIds.size, 157, 'catalog unique template count');
  assert.equal(sourceIds.size, 147, 'catalog unique source ID count');
  assert.equal(entries.filter(row => row.sourceId === 957 && row.sourceType === 1).length, 12, 'preserve repeated source ID 957');
  assert.deepEqual(entries.filter(row => row.templateId === 11905).map(row => [row.sourceType, row.count]), [[7, 10], [12, 5]], 'preserve both 11905 catalog positions');
  return {
    schemaVersion: 1, ...referenceState,
    boundary: 'Original rows only; no runtime pool, probabilities, prices, names or equipment attributes.',
    source: {sha256: sourceSha256, bytes: bytes.length, pinned: false},
    counts: {rows: 158, uniqueTemplateIds: 157, uniqueSourceIds: 147, categories: 15, selectableCategories: 14},
    entries, categories,
  };
}

/** Read only the pinned original files. This does not install or enable a reward pool. */
export function loadTreasureCatalog(projectRoot) {
  assert(typeof projectRoot === 'string' && projectRoot.trim(), 'projectRoot required');
  const rawPath = resolve(projectRoot, area, 'NewLotteryItem.xml.raw');
  const decodedPath = resolve(projectRoot, area, 'NewLotteryItem.xml');
  const raw = readFileSync(rawPath), decoded = readFileSync(decodedPath);
  assert.equal(sha(raw), rawSha, 'original raw catalog SHA-256');
  assert.equal(sha(decoded), decodedSha, 'original decoded catalog SHA-256');
  assert.deepEqual(inflateSync(raw, {maxOutputLength: 65536}), decoded, 'raw/decoded catalog equality');
  const catalog = parseTreasureCatalog(decoded);
  catalog.source = {
    ...catalog.source, pinned: true,
    raw: {path: rawPath, sha256: rawSha, bytes: raw.length},
    decoded: {path: decodedPath, sha256: decodedSha, bytes: decoded.length},
  };
  return catalog;
}

function displayIdentity(row) {
  assert(row && typeof row === 'object' && !Array.isArray(row), 'template display object required');
  for (const name of ['TemplateID', 'CategoryID', 'Pic', 'NeedSex']) assert(Object.hasOwn(row, name), `missing display field ${name}`);
  const templateId = integer(row.TemplateID, 'TemplateID');
  const categoryId = integer(row.CategoryID, 'CategoryID');
  const needSex = integer(row.NeedSex, 'NeedSex', 0, 2);
  assert(typeof row.Pic === 'string' && row.Pic.trim() && !/[\x00-\x1f\x7f]/.test(row.Pic), 'invalid display Pic');
  return {
    templateId,
    key: JSON.stringify([categoryId, row.Pic.trim().toLowerCase(), needSex]),
    // Preserve source spellings/types; no Name, statistics or other template fields escape.
    display: {TemplateID: row.TemplateID, CategoryID: row.CategoryID, Pic: row.Pic, NeedSex: row.NeedSex},
  };
}

/** Compare any reference subset with local display metadata; candidates never change IDs. */
export function resolveTreasureDisplayIdentities(referenceTemplates, localTemplates) {
  assert(Array.isArray(referenceTemplates) && Array.isArray(localTemplates), 'template arrays required');
  const reference = referenceTemplates.map(displayIdentity), local = localTemplates.map(displayIdentity);
  for (const [label, rows] of [['reference', reference], ['local', local]]) {
    assert.equal(new Set(rows.map(row => row.templateId)).size, rows.length, `duplicate ${label} TemplateID`);
  }
  const localById = new Map(local.map(row => [row.templateId, row]));
  const entries = reference.map(row => {
    const sameId = localById.get(row.templateId);
    const status = !sameId ? 'missing' : sameId.key === row.key ? 'matched' : 'identity-conflict';
    const candidates = status === 'matched' ? [] : local.filter(candidate => candidate.templateId !== row.templateId && candidate.key === row.key)
      .map(candidate => ({templateId: candidate.templateId, display: candidate.display})).sort((a, b) => a.templateId - b.templateId);
    return {
      templateId: row.templateId, status, reference: row.display, local: sameId?.display ?? null,
      appearanceCandidate: {status: candidates.length === 1 ? 'unique' : candidates.length > 1 ? 'ambiguous' : 'none', candidateOnly: true, candidates},
      runtimeMapping: null,
    };
  });
  return {
    ...referenceState,
    identityKeyNormalization: {numericFields: 'integer value; surrounding whitespace ignored', Pic: 'surrounding whitespace trimmed and lowercased; no path or alias rewrite', sourceValues: 'preserved'},
    counts: {matched: entries.filter(row => row.status === 'matched').length, missing: entries.filter(row => row.status === 'missing').length, identityConflict: entries.filter(row => row.status === 'identity-conflict').length},
    entries,
  };
}
