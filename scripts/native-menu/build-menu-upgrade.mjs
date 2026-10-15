// Add original Hall artwork without rebuilding or changing the 89 installed activity resources.
import assert from 'node:assert/strict';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNativeMenuArt } from './build-original-art.mjs';
import { buildNativeCommonBridge } from '../workshop-native-wardrobe.mjs';
import { verifyNativeActivityMenuBridge } from '../workshop-native-wardrobe-entry.mjs';
import { sha } from '../native-pair/build-library.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const changedInputs = ['scripts/native-wardrobe/WorkshopNativeWardrobeBridge.as', 'scripts/native-shared/build-activities.mjs'];
const addedInputs = ['scripts/native-menu/build-original-art.mjs', 'scripts/native-menu/source-spec.json'];
const read = path => readFileSync(path);
const checked = (path, hash) => { const bytes = read(path); assert.equal(sha(bytes), hash, path); return bytes; };
function inside(root, path) { const rel = relative(root, resolve(path)); assert(rel && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)); return resolve(path); }

export async function buildMenuUpgrade({ manifestPath, expectedSha256, outputDir, projectRoot = resolve(repo, '../..'), javaPath } = {}) {
  assert(manifestPath && /^[a-f0-9]{64}$/.test(expectedSha256) && outputDir, 'explicit previous manifest, SHA and fresh output required');
  const sourcePath = resolve(manifestPath), previous = JSON.parse(checked(sourcePath, expectedSha256)), out = resolve(outputDir);
  assert(!existsSync(out), 'preserve previous build');
  assert.equal(previous.module, 'workshop-native-activities'); assert.equal(previous.version, 1);
  assert.equal(previous.nativeMenuVersion, 1); assert.equal(previous.nativeMenuArtVersion, undefined);
  assert.equal(previous.christmasSceneVersion, 1); assert.equal(previous.christmasBattleReturnVersion, 1);
  assert.equal(previous.assets.length, 89); assert.equal(new Set(previous.assets.map(a => a.urlPath)).size, 89);
  assert.equal(previous.sources.length, 84); assert.equal(new Set(previous.sources.map(s => s.file)).size, 84);
  for (const name of changedInputs) assert(previous.sources.some(s => s.file === name));
  const changes = [];
  for (const source of previous.sources) {
    assert.equal(resolve(source.path), resolve(repo, source.file));
    const current = sha(read(source.path));
    if (changedInputs.includes(source.file)) changes.push({ file: source.file, beforeSha256: source.sha256, sha256: current });
    else assert.equal(current, source.sha256, 'unrelated compiler input changed: ' + source.file);
  }
  checked(previous.bridge.tagPath, previous.bridge.tagSha256);
  checked(previous.bridge.compiledSwf, previous.bridge.compiledSwfSha256);
  const originals = previous.assets.map(asset => ({ ...asset, data: checked(inside(dirname(sourcePath), asset.path), asset.sha256) }));
  for (const asset of originals) assert.equal(asset.data.length, asset.bytes);
  const shared = JSON.parse(read(previous.components.shared));
  assert.equal(shared.SharedClassNames.length, 82);
  const sharedAsset = originals.find(a => a.file === 'native-shared-library.swf');
  assert(shared.files.some(file => file.file === sharedAsset.file && file.sha256 === sharedAsset.sha256));
  const sources = [...previous.sources.map(s => ({ ...s, sha256: sha(read(s.path)) })), ...addedInputs.map(file => ({ file, path: resolve(repo, file), sha256: sha(read(resolve(repo, file))) }))];
  mkdirSync(out, { recursive: true });
  const assets = originals.map(({ data, ...asset }) => {
    assert(asset.urlPath.startsWith('/flash/workshop-native/') || asset.urlPath.startsWith('/resource/image/scene/christmas/workshop/'));
    const path = resolve(out, asset.urlPath.slice(1)); inside(out, path); mkdirSync(dirname(path), { recursive: true });
    copyFileSync(asset.path, path, constants.COPYFILE_EXCL); checked(path, asset.sha256);
    return { ...asset, path, source: asset.path };
  });
  const builtArt = await buildNativeMenuArt({ projectRoot, javaPath, outputDir: resolve(out, 'menu-art-component') });
  const art = builtArt.art;
  assert.equal(art.file, 'hall-activity-original-art.swf'); assert.equal(art.urlPath, '/flash/workshop-native/menu/' + art.file);
  checked(art.path, art.sha256); const artPath = resolve(out, art.urlPath.slice(1)); mkdirSync(dirname(artPath), { recursive: true });
  copyFileSync(art.path, artPath, constants.COPYFILE_EXCL); checked(artPath, art.sha256);
  assets.push({ ...art, path: artPath, source: art.path });
  const bridge = buildNativeCommonBridge({ projectRoot, javaPath, sharedLibraries: shared, outputDir: resolve(out, 'menu-bridge') });
  const abi = verifyNativeActivityMenuBridge(checked(bridge.tagPath, bridge.tagSha256), { nativeMenuArtVersion: 1 });
  assert.equal(bridge.sourceSha256, sources.find(s => s.file === changedInputs[0]).sha256, 'compiled bridge source changed during menu build');
  for (const source of sources) checked(source.path, source.sha256);
  checked(sourcePath, expectedSha256);
  const manifest = { ...previous, builtAt: new Date().toISOString(), outputDir: out, nativeMenuArtVersion: 1, assets, bridge, sources,
    components: { ...previous.components, menuArt: builtArt.manifestPath },
    menuArtUpgrade: { manifestPath: sourcePath, manifestSha256: expectedSha256, preservedAssets: 89, changedInputs: changes, addedInputs,
      sharedManifestSha256: sha(read(previous.components.shared)), originalMenuArtManifest: builtArt.manifestPath, abi },
    installed: false, browserValidated: false, runtimeAccepted: false };
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifestPath, expectedSha256, outputDir] = process.argv.slice(2); assert.equal(process.argv.length, 5);
  const result = await buildMenuUpgrade({ manifestPath, expectedSha256, outputDir });
  console.log(JSON.stringify({ manifestPath: resolve(outputDir, 'manifest.json'), assets: result.assets.length, nativeMenuArtVersion: result.nativeMenuArtVersion, bridge: result.bridge, installed: false }));
}
