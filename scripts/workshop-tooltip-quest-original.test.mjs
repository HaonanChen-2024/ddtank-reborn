import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { hash } from './workshop-bag-art.mjs';
import { buildTooltipQuestCandidates, manageTooltipQuestArt } from './workshop-tooltip-quest-art.mjs';

const repo = resolve(import.meta.dirname, '..');
const root = resolve(repo, '../../runtime/reference-ui-direct-port-20261015/tests', 'tooltip-quest-original-' + randomUUID());
const names = ['coreiconandtip', 'coreiconandtip1', 'quest'];
const legacyBuilder = 'cb44b581285f53cab17dc90695dcacdfe6a52cd2efb6ff066b2d2cd69c103576';
const legacyOutputs = ['e40ee10367bce9746fb4c26c730d70788eb6cfe5c69b35e91eb4092f3926b9c6', '8c7bb2f6ea4a610f4f3b05036429330cb4ff8dac0a1af1534ae54699739c691b', 'ebb8ef39308319575f90c4fa99cf296f64a74d4afa5ca67a0f8637591f1ed877'];
const legacyConfigs = ['0bbd2f3a661015f8e31faeba03ac4cd6e8781b05639429c742dafdf3c2a8b33f', '9540acbde442e97bcf2b3870cd98916ef66af6e93d6c66c77a060f299e974c4c', 'ae88ce4123a4365a4a27ca6346525f93602ff2be81c6542db2edf538122d906d'];
const configs = names.map(name => JSON.parse(fs.readFileSync(join(repo, 'research/i18n/tooltip-quest-art', name + '.zh-CN.json'))));
const configPins = names.map(name => ({ name, sha256: hash(fs.readFileSync(join(repo, 'research/i18n/tooltip-quest-art', name + '.zh-CN.json'))) }));
const sources = configs.map(config => fs.readFileSync(join(repo, 'apps/api/assets/flash', config.asset)));
const sourceHashes = sources.map(hash), completed = [];
const legacyCandidate = join(root, 'candidate-legacy'), originalCandidate = join(root, 'candidate-original');
let legacyManifest, originalManifest;

function json(path, value) { fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }
function diskHash(path) { return fs.existsSync(path) ? hash(fs.readFileSync(path)) : null; }
function treeState(path) {
  const entries = [];
  function visit(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(dir, e.name);
      if (e.isDirectory()) { entries.push([relative(path, file), 'directory']); visit(file); }
      else entries.push([relative(path, file), diskHash(file)]);
    }
  }
  visit(path); return entries;
}
function fixture(label) {
  const directory = join(root, label), runtime = join(directory, 'runtime'), assets = join(directory, 'assets');
  const reportDir = join(runtime, 'client-text-followup/tooltip-quest-installations/legacy-frozen');
  fs.mkdirSync(reportDir, { recursive: true });
  const entries = names.map((name, i) => {
    const target = join(runtime, 'client-overlay', configs[i].asset), backup = join(reportDir, name + '.before.swf');
    fs.mkdirSync(dirname(target), { recursive: true });
    const source = join(assets, configs[i].asset); fs.mkdirSync(dirname(source), { recursive: true });
    fs.writeFileSync(source, sources[i]); fs.writeFileSync(backup, sources[i]);
    fs.copyFileSync(join(legacyCandidate, name + '.swf'), target);
    return { name, target, backup, hadOverlay: i === 0, sourceSha256: sourceHashes[i], outputSha256: legacyOutputs[i] };
  });
  const journal = join(runtime, 'client-overlay-tooltip-quest-art.json');
  const receipt = { version: 1, kind: 'tooltip-quest-caption-installation', builderSha256: legacyBuilder, configs: configPins,
    candidateDirectory: legacyCandidate, manifestSha256: diskHash(join(legacyCandidate, 'manifest.json')), reportDir, entries,
    installedAt: '2026-10-15T00:00:00.000Z', runtimeAccepted: false };
  json(journal, receipt);
  return { directory, runtime, assets, journal, receipt, entries, targets: entries.map(e => e.target), roots: { runtime, assets } };
}
function oldState(f) {
  return { targets: f.targets.map(diskHash), journal: fs.readFileSync(f.journal), assets: treeState(f.assets), backups: f.entries.map(e => diskHash(e.backup)) };
}
function assertOldState(f, beforeState) {
  assert.deepEqual(f.targets.map(diskHash), beforeState.targets);
  assert.deepEqual(fs.readFileSync(f.journal), beforeState.journal);
  assert.deepEqual(treeState(f.assets), beforeState.assets);
  assert.deepEqual(f.entries.map(e => diskHash(e.backup)), beforeState.backups);
}
function assertPermanentBackups(f, receipt) {
  for (let i = 0; i < names.length; i++) {
    assert.equal(diskHash(f.entries[i].backup), sourceHashes[i]);
    assert.equal(diskHash(receipt.entries[i].backup), sourceHashes[i]);
    assert.equal(diskHash(join(receipt.reportDir, names[i] + '.previous.swf')), legacyOutputs[i]);
  }
}
function assertFailedUpgradeEvidence(f, previous) {
  const reports = join(f.runtime, 'client-text-followup/tooltip-quest-installations');
  const saved = fs.readdirSync(reports).filter(name => name !== 'legacy-frozen');
  assert.equal(saved.length, 1);
  const reportDir = join(reports, saved[0]);
  assert.deepEqual(fs.readFileSync(join(reportDir, 'prior-journal.json')), previous.journal);
  for (let i = 0; i < names.length; i++) {
    assert.equal(diskHash(join(reportDir, names[i] + '.before.swf')), sourceHashes[i]);
    assert.equal(diskHash(join(reportDir, names[i] + '.previous.swf')), legacyOutputs[i]);
  }
}
function copyCandidate(label) {
  const directory = join(root, label); fs.mkdirSync(directory);
  for (const file of ['manifest.json', 'original-resources.json', ...names.flatMap(name => [name + '.swf', name + '.config.json'])]) {
    fs.copyFileSync(join(originalCandidate, file), join(directory, file));
  }
  return directory;
}
async function withFsOverrides(overrides, fn) {
  const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, fs[key]]));
  try {
    Object.assign(fs, overrides); syncBuiltinESMExports();
    return await fn(originals);
  } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
}

before(async () => {
  fs.mkdirSync(root, { recursive: true });
  assert.deepEqual(configPins.map(e => e.sha256), legacyConfigs, 'legacy configuration fixture must retain its reviewed pins');
  assert.deepEqual(sourceHashes, configs.map(e => e.sourceBaseSha256));
  legacyManifest = await buildTooltipQuestCandidates(legacyCandidate);
  assert.deepEqual(legacyManifest.entries.map(e => e.outputSha256), legacyOutputs, 'legacy painted output must remain byte-identical');
  legacyManifest.builderSha256 = legacyBuilder; json(join(legacyCandidate, 'manifest.json'), legacyManifest);
  originalManifest = await buildTooltipQuestCandidates(originalCandidate, { originalResources: true });
  assert.equal(originalManifest.originalArtVersion, 1);
  assert.equal(originalManifest.originalConfigSha256, diskHash(join(originalCandidate, 'original-resources.json')));
  assert.equal(originalManifest.transplantSha256, diskHash(join(repo, 'scripts/workshop-original-ui-bitmaps.mjs')));
});

after(() => {
  assert.deepEqual(configs.map(config => diskHash(join(repo, 'apps/api/assets/flash', config.asset))), sourceHashes);
  json(join(root, 'result.json'), { completedCases: completed, root, legacyCandidate, originalCandidate,
    legacyBuilder, legacyOutputs, realAssetReadOnly: true, isolatedInstallRollback: true, productionOverlayTouched: false, runtimeAccepted: false });
  console.log(JSON.stringify({ root, completedCases: completed.length, productionOverlayTouched: false, runtimeAccepted: false }));
});

test('original resource upgrade verifies frozen legacy receipts without writing, repeats, and rolls back to permanent base backups', async () => {
  const f = fixture('upgrade-rollback'), previous = oldState(f), untouched = treeState(f.directory);
  assert.equal((await manageTooltipQuestArt('verify', undefined, f.roots)).installed, true);
  assert.deepEqual(treeState(f.directory), untouched);
  const preview = await manageTooltipQuestArt('verify', originalCandidate, f.roots);
  assert.equal(preview.verified, true); assert.equal(preview.installed, false);
  assert.deepEqual(treeState(f.directory), untouched);
  const install = await manageTooltipQuestArt('install', originalCandidate, f.roots);
  assert.equal(install.installed, true); assert.equal(install.unchanged, false);
  const receipt = JSON.parse(fs.readFileSync(f.journal));
  assert.equal(receipt.originalArtVersion, 1);
  assert.equal(receipt.upgradedFromManifestSha256, f.receipt.manifestSha256);
  assert.equal(receipt.originalConfigSha256, originalManifest.originalConfigSha256);
  assert.equal(receipt.transplantSha256, originalManifest.transplantSha256);
  assert.deepEqual(receipt.entries.map(e => e.hadOverlay), [true, false, false]);
  assert.deepEqual(fs.readFileSync(join(receipt.reportDir, 'prior-journal.json')), previous.journal);
  assert.deepEqual(f.targets.map(diskHash), originalManifest.entries.map(e => e.outputSha256));
  assertPermanentBackups(f, receipt);
  const installedState = treeState(f.directory);
  assert.equal((await manageTooltipQuestArt('install', originalCandidate, f.roots)).unchanged, true);
  assert.equal((await manageTooltipQuestArt('verify', originalCandidate, f.roots)).unchanged, true);
  assert.equal((await manageTooltipQuestArt('verify', undefined, f.roots)).installed, true);
  assert.deepEqual(treeState(f.directory), installedState);
  const rollback = await manageTooltipQuestArt('rollback', undefined, f.roots);
  assert.equal(rollback.rolledBack, true); assert.equal(rollback.backupsPreserved, true);
  assert.deepEqual(f.targets.map(diskHash), [sourceHashes[0], null, null]);
  assert.equal(fs.existsSync(f.journal), false); assertPermanentBackups(f, receipt);
  assert.deepEqual(treeState(f.assets), previous.assets);
  completed.push('legacy verify, original upgrade, repeat, implicit verify, base rollback');
});

test('original resource installation refuses a legacy downgrade without changing the installed overlay or journal', async () => {
  const f = fixture('downgrade'); await manageTooltipQuestArt('install', originalCandidate, f.roots);
  const state = treeState(f.directory);
  await assert.rejects(manageTooltipQuestArt('install', legacyCandidate, f.roots), /downgrade requires complete rollback/);
  await assert.rejects(manageTooltipQuestArt('verify', legacyCandidate, f.roots), /downgrade requires complete rollback/);
  assert.deepEqual(treeState(f.directory), state);
  completed.push('legacy downgrade rejected');
});

test('original candidates reject unknown builder, config, transplant, frozen config copy, metadata, and payload without writes', async () => {
  const f = fixture('candidate-rejections'), previous = oldState(f), state = treeState(f.directory);
  const cases = [
    ['builder', value => { value.builderSha256 = '0'.repeat(64); }, /builder changed/],
    ['original-config', value => { value.originalConfigSha256 = '0'.repeat(64); }, /candidate config changed/],
    ['transplant', value => { value.transplantSha256 = '0'.repeat(64); }, /candidate transplant changed/],
    ['caption-config', value => { value.entries[0].configSha256 = '0'.repeat(64); }, /caption config changed/],
    ['metadata', value => { value.entries[0].changedBitmapCount = 0; }, /metadata differs/],
  ];
  for (const [label, mutate, expected] of cases) {
    const directory = copyCandidate('bad-' + label), manifest = JSON.parse(fs.readFileSync(join(directory, 'manifest.json')));
    mutate(manifest); json(join(directory, 'manifest.json'), manifest);
    await assert.rejects(manageTooltipQuestArt('install', directory, f.roots), expected);
    assertOldState(f, previous); assert.deepEqual(treeState(f.directory), state);
  }
  const changedCopy = copyCandidate('bad-frozen-config');
  fs.appendFileSync(join(changedCopy, 'original-resources.json'), '\n');
  await assert.rejects(manageTooltipQuestArt('install', changedCopy, f.roots), /frozen original UI config changed/);
  assertOldState(f, previous); assert.deepEqual(treeState(f.directory), state);
  const changedPayload = copyCandidate('bad-payload'); fs.appendFileSync(join(changedPayload, 'quest.swf'), Buffer.from([0]));
  await assert.rejects(manageTooltipQuestArt('install', changedPayload, f.roots), /candidate differs from exact caption reconstruction/);
  assertOldState(f, previous); assert.deepEqual(treeState(f.directory), state);
  completed.push('candidate builder, config, transplant, frozen copy, metadata and payload guards');
});

test('legacy receipt builder, configuration and output pins remain closed while original receipt pins cannot drift', async () => {
  const f = fixture('receipt-rejections'), previous = oldState(f);
  for (const [mutate, expected] of [
    [value => { value.builderSha256 = '0'.repeat(64); }, /builder changed/],
    [value => { value.configs[0].sha256 = '0'.repeat(64); }, /config changed/],
    [value => { value.entries[0].outputSha256 = '0'.repeat(64); }, /legacy caption output pins changed/],
  ]) {
    const value = JSON.parse(previous.journal); mutate(value); json(f.journal, value);
    const modified = treeState(f.directory);
    await assert.rejects(manageTooltipQuestArt('verify', undefined, f.roots), expected);
    assert.deepEqual(treeState(f.directory), modified); fs.writeFileSync(f.journal, previous.journal); assertOldState(f, previous);
  }
  await manageTooltipQuestArt('install', originalCandidate, f.roots);
  const good = fs.readFileSync(f.journal);
  for (const [field, expected] of [['transplantSha256', /installed original UI transplant changed/], ['originalConfigSha256', /installed original UI config changed/]]) {
    const value = JSON.parse(good); value[field] = '0'.repeat(64); json(f.journal, value);
    const modified = treeState(f.directory);
    await assert.rejects(manageTooltipQuestArt('verify', undefined, f.roots), expected);
    assert.deepEqual(treeState(f.directory), modified); fs.writeFileSync(f.journal, good);
  }
  completed.push('frozen legacy and original receipt pin guards');
});

test('unavailable donor cache blocks verification while rollback still restores the real permanent base backups', async () => {
  const f = fixture('donor-unavailable'), previous = oldState(f);
  await manageTooltipQuestArt('install', originalCandidate, f.roots);
  const receipt = JSON.parse(fs.readFileSync(f.journal)), installedState = treeState(f.directory);
  const spec = JSON.parse(fs.readFileSync(join(originalCandidate, 'original-resources.json')));
  const donorPaths = new Set(spec.entries.map(e => resolve(repo, '../..', e.path))), read = fs.readFileSync;
  let unavailableReads = 0;
  await withFsOverrides({ readFileSync(path, ...args) {
    if (typeof path === 'string' && donorPaths.has(resolve(path))) {
      unavailableReads++; throw new Error('injected original donor cache unavailable');
    }
    return read.call(fs, path, ...args);
  } }, async () => {
    await assert.rejects(manageTooltipQuestArt('verify', undefined, f.roots), /injected original donor cache unavailable/);
    assert.ok(unavailableReads > 0); assert.deepEqual(treeState(f.directory), installedState);
    const beforeRollbackReads = unavailableReads;
    assert.equal((await manageTooltipQuestArt('rollback', undefined, f.roots)).rolledBack, true);
    assert.equal(unavailableReads, beforeRollbackReads, 'rollback must not read donor cache');
  });
  assert.deepEqual(f.targets.map(diskHash), [sourceHashes[0], null, null]); assert.equal(fs.existsSync(f.journal), false);
  assertPermanentBackups(f, receipt); assert.deepEqual(treeState(f.assets), previous.assets);
  completed.push('donor unavailable verify rejection and independent base rollback');
});

test('second target write failure compensates to all old painted outputs and preserves the old journal', async () => {
  const f = fixture('second-target-write-failure'), previous = oldState(f), open = fs.openSync;
  let injected = false;
  await withFsOverrides({ openSync(path, ...args) {
    if (!injected && String(path).startsWith(f.targets[1] + '.tooltip-quest-')) {
      injected = true; assert.equal(diskHash(f.targets[0]), originalManifest.entries[0].outputSha256);
      throw new Error('injected second target write failure');
    }
    return open.call(fs, path, ...args);
  } }, async () => {
    await assert.rejects(manageTooltipQuestArt('install', originalCandidate, f.roots), /injected second target write failure/);
  });
  assert.equal(injected, true); assertOldState(f, previous); assertFailedUpgradeEvidence(f, previous);
  assert.equal((await manageTooltipQuestArt('verify', undefined, f.roots)).installed, true);
  completed.push('second target write compensation');
});

test('journal commit failure compensates all three outputs and leaves the legacy journal byte-identical', async () => {
  const f = fixture('journal-commit-failure'), previous = oldState(f), rename = fs.renameSync;
  let injected = false;
  await withFsOverrides({ renameSync(from, to) {
    if (!injected && resolve(to) === f.journal) {
      injected = true; assert.deepEqual(f.targets.map(diskHash), originalManifest.entries.map(e => e.outputSha256));
      throw new Error('injected journal commit failure');
    }
    return rename.call(fs, from, to);
  } }, async () => {
    await assert.rejects(manageTooltipQuestArt('install', originalCandidate, f.roots), /injected journal commit failure/);
  });
  assert.equal(injected, true); assertOldState(f, previous); assertFailedUpgradeEvidence(f, previous);
  assert.equal((await manageTooltipQuestArt('verify', undefined, f.roots)).installed, true);
  completed.push('journal commit compensation');
});

test('failure compensation preserves externally changed targets instead of restoring over newer work', async () => {
  const f = fixture('external-target-during-failure'), previous = oldState(f), open = fs.openSync;
  const newer = Buffer.from('external target update after first original-resource replacement'); let injected = false;
  await withFsOverrides({ openSync(path, ...args) {
    if (!injected && String(path).startsWith(f.targets[1] + '.tooltip-quest-')) {
      injected = true; fs.writeFileSync(f.targets[0], newer); throw new Error('injected second target failure after external update');
    }
    return open.call(fs, path, ...args);
  } }, async () => {
    await assert.rejects(manageTooltipQuestArt('install', originalCandidate, f.roots), /compensation preserved externally changed targets/);
  });
  assert.equal(injected, true); assert.deepEqual(fs.readFileSync(f.targets[0]), newer);
  assert.deepEqual(f.targets.slice(1).map(diskHash), legacyOutputs.slice(1));
  assert.deepEqual(fs.readFileSync(f.journal), previous.journal);
  assert.deepEqual(f.entries.map(e => diskHash(e.backup)), sourceHashes); assert.deepEqual(treeState(f.assets), previous.assets);
  assertFailedUpgradeEvidence(f, previous);
  completed.push('external target update preserved by compensation');
});

test('journal commit failure preserves an external journal replacement while compensating owned outputs', async () => {
  const f = fixture('external-journal-during-failure'), previous = oldState(f), rename = fs.renameSync;
  const newer = Buffer.from('{"externalJournalUpdate":true}\n'); let injected = false;
  await withFsOverrides({ renameSync(from, to) {
    if (!injected && resolve(to) === f.journal) {
      injected = true; fs.writeFileSync(f.journal, newer); throw new Error('injected journal commit failure after external update');
    }
    return rename.call(fs, from, to);
  } }, async () => {
    await assert.rejects(manageTooltipQuestArt('install', originalCandidate, f.roots), /injected journal commit failure after external update/);
  });
  assert.equal(injected, true); assert.deepEqual(fs.readFileSync(f.journal), newer);
  assert.deepEqual(f.targets.map(diskHash), legacyOutputs);
  assert.deepEqual(f.entries.map(e => diskHash(e.backup)), sourceHashes); assert.deepEqual(treeState(f.assets), previous.assets);
  assertFailedUpgradeEvidence(f, previous);
  completed.push('external journal replacement preserved by compensation');
});
