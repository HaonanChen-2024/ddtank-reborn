#!/usr/bin/env node
// One owner for display strings and optional original-client compatibility fixes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchSwfBuffer } from "../tools/i18n/abc-strings/patch.mjs";
import { patchActivityResponse } from "../tools/i18n/abc-strings/activity-response.mjs";
import { patchActivityState } from "../tools/i18n/abc-strings/activity-state.mjs";
import { patchExchangeState } from "../tools/i18n/abc-strings/exchange-state.mjs";
import { patchCraterMask } from "../tools/i18n/abc-strings/crater-mask.mjs";
import { buildActivityEntry } from "./workshop-activity-entry.mjs";
import { buildNativeWardrobeEntry } from "./workshop-native-wardrobe-entry.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const names = ["2.png", "3.png", "DDT_Loading.swf"];

export function literalOptions(args) {
  const nativeArgs = args.filter(arg => arg.startsWith("--native-wardrobe="));
  assert.ok(nativeArgs.length <= 1 && nativeArgs.every(arg => arg.length > "--native-wardrobe=".length), "provide one native wardrobe build manifest");
  const nativeWardrobeManifest = nativeArgs[0]?.slice("--native-wardrobe=".length);
  args = args.filter(arg => !nativeArgs.includes(arg));
  const commands = args.filter(arg => ["verify", "install", "rollback"].includes(arg));
  assert.ok(commands.length <= 1 && args.every(arg => commands.includes(arg) || ["--activity-response", "--activity-state", "--exchange-state", "--crater-mask", "--reference-activities"].includes(arg)), "usage: workshop-literals.mjs verify|install|rollback [--activity-response] [--activity-state] [--exchange-state] [--crater-mask] [--reference-activities]");
  assert.ok(args.filter(arg => arg === "--activity-response").length <= 1, "duplicate activity-response option");
  const command = commands[0] ?? "verify", activityResponse = args.includes("--activity-response");
  const activityState = args.includes("--activity-state");
  const exchangeState = args.includes("--exchange-state");
  const craterMask = args.includes("--crater-mask");
  const referenceActivities = args.includes("--reference-activities");
  assert.ok(args.filter(arg => arg === "--reference-activities").length <= 1, "duplicate reference-activities option");
  assert.ok(args.filter(arg => arg === "--activity-state").length <= 1, "duplicate activity-state option");
  assert.ok(args.filter(arg => arg === "--exchange-state").length <= 1, "duplicate exchange-state option");
  assert.ok(args.filter(arg => arg === "--crater-mask").length <= 1, "duplicate crater-mask option");
  assert.ok(command !== "rollback" || !(activityResponse || activityState || exchangeState || craterMask || referenceActivities || nativeWardrobeManifest), "rollback restores the complete owned literal overlay");
  return { command, activityResponse, ...(activityState ? { activityState } : {}), ...(exchangeState ? { exchangeState } : {}), ...(craterMask ? { craterMask } : {}), ...(referenceActivities ? { referenceActivities } : {}), ...(nativeWardrobeManifest ? { nativeWardrobeManifest } : {}) };
}

export function runLiteralOverlay({ command = "verify", activityResponse = false, activityState = false, exchangeState = false, craterMask = false, referenceActivities = false, nativeWardrobeManifest, repoRoot = repo, runtimeRoot = resolve(repoRoot, "../../runtime") } = {}) {
  assert.ok(["verify", "install", "rollback"].includes(command));
  assert.equal(typeof activityResponse, "boolean");
  assert.equal(typeof activityState, "boolean");
  assert.equal(typeof exchangeState, "boolean");
  assert.equal(typeof craterMask, "boolean");
  assert.equal(typeof referenceActivities, "boolean");
  assert.ok(command !== "rollback" || !(activityResponse || activityState || exchangeState || craterMask || referenceActivities || nativeWardrobeManifest));
  const overlay = join(runtimeRoot, "client-overlay"), ledger = join(runtimeRoot, "client-overlay-literals.json");
  const ledgerBytes = existsSync(ledger) ? readFileSync(ledger) : null;
  const previous = ledgerBytes ? JSON.parse(ledgerBytes.toString("utf8")) : null;
  const oldNative = previous?.nativeWardrobe;
  const native = nativeWardrobeManifest || oldNative ? readNativeWardrobe(nativeWardrobeManifest ?? oldNative.manifestPath, overlay) : null;
  if (oldNative) assert.deepEqual(native.receipt, oldNative, "native wardrobe build changed; preserve installed module");
  assert.ok(!previous || previous.referenceActivities === undefined || typeof previous.referenceActivities === "boolean", "unknown reference-activities journal flag");
  const oldActivities = previous?.referenceActivities ?? false, activitiesEnabled = oldActivities || referenceActivities || Boolean(native);
  assert.ok(!previous || previous.activityResponse === undefined || typeof previous.activityResponse === "boolean", "unknown activity-response journal flag");
  assert.ok(!previous || previous.activityState === undefined || typeof previous.activityState === "boolean", "unknown activity-state journal flag");
  assert.ok(!previous || previous.exchangeState === undefined || typeof previous.exchangeState === "boolean", "unknown exchange-state journal flag");
  assert.ok(!previous || previous.craterMask === undefined || typeof previous.craterMask === "boolean", "unknown crater-mask journal flag");
  const oldCrater = previous?.craterMask ?? false, craterEnabled = oldCrater || craterMask;
  const oldEnabled = previous?.activityResponse ?? false;
  const oldExchange = previous?.exchangeState ?? false, exchangeEnabled = oldExchange || exchangeState;
  const oldState = previous?.activityState ?? false, stateEnabled = oldState || activityState || exchangeEnabled;
  assert.ok(!oldState || oldEnabled, "calendar state journal requires its response fix");
  assert.ok(!oldExchange || oldState, "exchange state journal requires its calendar state fix");
  // Omitting the option later preserves the recorded optional effect.
  const enabled = oldEnabled || activityResponse || stateEnabled;
  function checkOwned() {
    assert.deepEqual(previous.files.map(entry => entry.name).sort(), [...names].sort(), "incomplete literal overlay journal");
    for (const entry of previous.files) {
      assert.ok(names.includes(entry.name), "unknown ledger file");
      assert.equal(hash(readFileSync(join(overlay, entry.name))), entry.sha256, "changed deployment preserved: " + entry.name);
      assert.equal(hash(readFileSync(entry.backup)), entry.sourceSha256, "backup changed: " + entry.name);
    }
    if (oldNative) for (const asset of native.assets) assert.equal(hash(readFileSync(asset.target)), asset.sha256, "changed native wardrobe asset preserved");
  }
  function replace(path, bytes) {
    mkdirSync(dirname(path), { recursive: true });
    const fresh = path + `.workshop-${process.pid}`;
    let created = false;
    try {
      writeFileSync(fresh, bytes, { flag: "wx" }); created = true;
      fs.renameSync(fresh, path);
    } finally { if (created && existsSync(fresh)) unlinkSync(fresh); }
  }
  if (command === "rollback") {
    assert.ok(previous, "no literal overlay journal"); checkOwned();
    for (const entry of previous.files) {
      const target = join(overlay, entry.name);
      if (entry.hadOverlay) replace(target, readFileSync(entry.backup)); else unlinkSync(target);
    }
    if (oldNative) for (const asset of native.assets) unlinkSync(asset.target);
    unlinkSync(ledger);
    return { rolledBack: true, files: previous.files.length, restartRequired: true };
  }
  if (previous) checkOwned();
  const chinese = JSON.parse(readFileSync(join(repoRoot, "research/i18n/zh-CN-literals.json"), "utf8"));
  const portuguese = JSON.parse(readFileSync(join(repoRoot, "tools/i18n/abc-strings/translations.json"), "utf8"));
  const translations = { ...chinese };
  for (const [source, value] of Object.entries(chinese)) {
    assert.ok(portuguese[source], "unknown original display string: " + source);
    assert.equal(typeof value, "string"); assert.ok(!/[\r\n]/.test(value));
    translations[portuguese[source]] = value;
  }
  const files = names.map(name => {
    const old = previous?.files.find(entry => entry.name === name), target = join(overlay, name);
    const source = old?.backup ?? (existsSync(target) ? target : join(repoRoot, "apps/api/assets/flash", name));
    const bytes = readFileSync(source), { out: displayOut, totalChanged } = patchSwfBuffer(bytes, translations);
    assert.ok(totalChanged > 0, "known display literals absent: " + name);
    const repeated = patchSwfBuffer(displayOut, translations);
    assert.equal(repeated.totalChanged, 0, "untranslated display literals remain: " + name);
    assert.deepEqual(repeated.out, displayOut, "non-idempotent SWF patch: " + name);
    // Recompute the OLD semantic flag from its original backup before accepting an upgrade.
    let oldOut = oldEnabled && name === "2.png" ? patchActivityResponse(displayOut).out : displayOut;
    if (oldState && name === "2.png") oldOut = patchActivityState(oldOut).out;
    if (oldExchange && name === "2.png") oldOut = patchExchangeState(oldOut).out;
    if (oldCrater && name === "2.png") oldOut = patchCraterMask(oldOut).out;
    if (oldActivities && name === "2.png") oldOut = buildActivityEntry(oldOut).output;
    if (oldNative && name === "2.png") oldOut = buildNativeWardrobeEntry(oldOut, native.bridge).output;
    if (old) assert.equal(hash(oldOut), old.sha256, "recorded literal/consumer output changed; preserve the installed batch");
    let out = displayOut, response, state, exchange, crater, activities, nativeEntry;
    if (enabled && name === "2.png") {
      const patched = patchActivityResponse(displayOut); out = patched.out;
      const again = patchActivityResponse(out); assert.equal(again.changed, false); assert.deepEqual(again.out, out);
      const { out: ignored, ...proof } = patched; response = proof;
    }
    if (stateEnabled && name === "2.png") {
      const patched = patchActivityState(out); out = patched.out;
      const again = patchActivityState(out); assert.equal(again.changed, false); assert.deepEqual(again.out, out);
      const { out: ignored, ...proof } = patched; state = proof;
    }
    if (exchangeEnabled && name === "2.png") {
      const patched = patchExchangeState(out); out = patched.out;
      const again = patchExchangeState(out); assert.equal(again.changed, false); assert.deepEqual(again.out, out);
      const { out: ignored, ...proof } = patched; exchange = proof;
    }
    if (craterEnabled && name === "2.png") {
      const patched = patchCraterMask(out); out = patched.out;
      const again = patchCraterMask(out); assert.equal(again.changed, false); assert.deepEqual(again.out, out);
      const { out: ignored, ...proof } = patched; crater = proof;
    }
    if (activitiesEnabled && name === "2.png") {
      const patched = buildActivityEntry(out); out = patched.output; activities = patched.proof;
    }
    if (native && name === "2.png") {
      const patched = buildNativeWardrobeEntry(out, native.bridge); out = patched.output; nativeEntry = patched.proof;
    }
    return { name, sourceSha256: hash(bytes), sha256: hash(out), changedStrings: totalChanged, bytes: out.length,
      hadOverlay: old?.hadOverlay ?? existsSync(target), backup: old?.backup,
      ...(response ? { activityResponse: response } : {}), ...(state ? { activityState: state } : {}), ...(exchange ? { exchangeState: exchange } : {}), ...(crater ? { craterMask: crater } : {}), ...(activities ? { referenceActivities: activities } : {}), ...(nativeEntry ? { nativeWardrobe: nativeEntry } : {}), out, sourceBytes: bytes, currentBytes: existsSync(target) ? readFileSync(target) : null };
  });
  const unchanged = Boolean(previous) && files.every(entry => entry.sha256 === previous.files.find(old => old.name === entry.name).sha256) && enabled === oldEnabled && stateEnabled === oldState && exchangeEnabled === oldExchange && craterEnabled === oldCrater && activitiesEnabled === oldActivities && Boolean(native) === Boolean(oldNative);
  const journalFiles = () => files.map(({ out, sourceBytes, currentBytes, ...entry }) => entry);
  if (command === "install" && !unchanged) {
    if (!previous) {
      const backupDir = join(runtimeRoot, "client-overlay-backups", `literals-${Date.now()}`); mkdirSync(backupDir, { recursive: true });
      for (const entry of files) { entry.backup = join(backupDir, entry.name); writeFileSync(entry.backup, entry.sourceBytes, { flag: "wx" }); }
    }
    const nextLedger = Buffer.from(JSON.stringify({ ...(previous ?? {}), installedAt: previous?.installedAt ?? new Date().toISOString(),
      ...(previous ? { updatedAt: new Date().toISOString() } : {}), activityResponse: enabled, ...(stateEnabled ? { activityState: true } : {}), ...(exchangeEnabled ? { exchangeState: true } : {}), ...(craterEnabled ? { craterMask: true } : {}), ...(activitiesEnabled ? { referenceActivities: true } : {}), ...(native ? { nativeWardrobe: native.receipt } : {}), files: journalFiles() }, null, 2));
    const checkLedger = () => ledgerBytes ? assert.deepEqual(readFileSync(ledger), ledgerBytes, "literal journal changed during preparation") : assert.equal(existsSync(ledger), false, "a literal journal appeared during preparation");
    checkLedger(); const installed = [], addedAssets = [];
    try {
      if (native && !oldNative) {
        for (const asset of native.assets) assert.equal(existsSync(asset.target), false, "existing native asset preserved: " + asset.target);
        for (const asset of native.assets) {
          mkdirSync(dirname(asset.target), { recursive: true });
          writeFileSync(asset.target, asset.bytes, { flag: "wx" }); addedAssets.push(asset);
          assert.equal(hash(readFileSync(asset.target)), asset.sha256);
        }
      }
      for (const entry of files) {
        const target = join(overlay, entry.name);
        if (entry.currentBytes) assert.deepEqual(readFileSync(target), entry.currentBytes, "literal deployment changed during preparation");
        else assert.equal(existsSync(target), false, "literal deployment appeared during preparation");
        if (entry.currentBytes?.equals(entry.out)) continue;
        installed.push(entry); replace(target, entry.out);
        assert.equal(hash(readFileSync(target)), entry.sha256);
      }
      checkLedger(); replace(ledger, nextLedger);
    } catch (error) {
      for (const entry of installed.reverse()) {
        const target = join(overlay, entry.name);
        if (entry.currentBytes) replace(target, entry.currentBytes); else if (existsSync(target)) unlinkSync(target);
      }
      if (existsSync(ledger) && readFileSync(ledger).equals(nextLedger)) {
        if (ledgerBytes) replace(ledger, ledgerBytes); else unlinkSync(ledger);
      }
      for (const asset of addedAssets.reverse()) if (existsSync(asset.target) && hash(readFileSync(asset.target)) === asset.sha256) unlinkSync(asset.target);
      throw error;
    }
  }
  return { installed: command === "install" || Boolean(previous), restartRequired: true, unchanged,
    nativeWardrobe: native?.receipt ?? null, nativeWardrobeInstalled: Boolean(native) && (command === "install" || Boolean(oldNative)),
    referenceActivities: activitiesEnabled, referenceActivitiesInstalled: activitiesEnabled && (command === "install" || oldActivities),
    activityResponse: enabled, activityResponseInstalled: enabled && (command === "install" || oldEnabled), activityState: stateEnabled,
    activityStateInstalled: stateEnabled && (command === "install" || oldState), exchangeState: exchangeEnabled,
    exchangeStateInstalled: exchangeEnabled && (command === "install" || oldExchange), craterMask: craterEnabled, craterMaskInstalled: craterEnabled && (command === "install" || oldCrater), pendingTransition: (enabled !== oldEnabled || stateEnabled !== oldState || exchangeEnabled !== oldExchange || craterEnabled !== oldCrater || activitiesEnabled !== oldActivities || Boolean(native) !== Boolean(oldNative)) && command !== "install", renderingAccepted: false,
    files: journalFiles().map(({ backup, ...entry }) => entry) };
}

function readNativeWardrobe(manifestPath, overlay) {
  const path = resolve(manifestPath), bytes = readFileSync(path), manifest = JSON.parse(bytes);
  assert.equal(manifest.module, "workshop-native-wardrobe"); assert.equal(manifest.version, 1);
  const root = dirname(path), within = file => {
    const target = resolve(file); assert.ok(target.startsWith(root + "/") || target.startsWith(root + "\\"), "native build path escaped"); return target;
  };
  const bridge = readFileSync(within(manifest.bridge.tagPath)); assert.equal(hash(bridge), manifest.bridge.tagSha256);
  const expected = ["MagicClothList.decoded.xml", "WorkshopNativeWardrobeBootstrap.swf", "magicwardrobe-original-library.swf", "magicwardrobe_v3_6_1_u1.swf", "magicwardrobe_v3_6_1_u1.ui", "shared-art.swf"];
  assert.deepEqual(manifest.assets.map(a => a.file).sort(), expected.sort());
  const assets = manifest.assets.map(asset => {
    assert.equal(asset.urlPath, "/flash/workshop-native/wardrobe/" + asset.file);
    const data = readFileSync(within(asset.path)); assert.equal(hash(data), asset.sha256); assert.equal(data.length, asset.bytes);
    return { target: join(overlay, "workshop-native/wardrobe", asset.file), bytes: data, sha256: asset.sha256 };
  });
  const receipt = { manifestPath: path, manifestSha256: hash(bytes), bridgeSha256: hash(bridge), assets: assets.map(({ target, sha256 }) => ({ target, sha256 })) };
  return { bridge, assets, receipt };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(JSON.stringify(runLiteralOverlay(literalOptions(process.argv.slice(2)))));
