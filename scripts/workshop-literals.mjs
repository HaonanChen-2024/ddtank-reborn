#!/usr/bin/env node
// One owner for the display-string overlay and optional activity-response consumer fix.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchSwfBuffer } from "../tools/i18n/abc-strings/patch.mjs";
import { patchActivityResponse } from "../tools/i18n/abc-strings/activity-response.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const names = ["2.png", "3.png", "DDT_Loading.swf"];

export function literalOptions(args) {
  const commands = args.filter(arg => ["verify", "install", "rollback"].includes(arg));
  assert.ok(commands.length <= 1 && args.every(arg => commands.includes(arg) || arg === "--activity-response"), "usage: workshop-literals.mjs verify|install|rollback [--activity-response]");
  assert.ok(args.filter(arg => arg === "--activity-response").length <= 1, "duplicate activity-response option");
  const command = commands[0] ?? "verify", activityResponse = args.includes("--activity-response");
  assert.ok(command !== "rollback" || !activityResponse, "rollback restores the complete owned literal overlay");
  return { command, activityResponse };
}

export function runLiteralOverlay({ command = "verify", activityResponse = false, repoRoot = repo, runtimeRoot = resolve(repoRoot, "../../runtime") } = {}) {
  assert.ok(["verify", "install", "rollback"].includes(command));
  assert.equal(typeof activityResponse, "boolean");
  assert.ok(command !== "rollback" || !activityResponse);
  const overlay = join(runtimeRoot, "client-overlay"), ledger = join(runtimeRoot, "client-overlay-literals.json");
  const ledgerBytes = existsSync(ledger) ? readFileSync(ledger) : null;
  const previous = ledgerBytes ? JSON.parse(ledgerBytes.toString("utf8")) : null;
  assert.ok(!previous || previous.activityResponse === undefined || typeof previous.activityResponse === "boolean", "unknown activity-response journal flag");
  const oldEnabled = previous?.activityResponse ?? false;
  // Omitting the option later preserves the recorded optional effect.
  const enabled = oldEnabled || activityResponse;
  function checkOwned() {
    assert.deepEqual(previous.files.map(entry => entry.name).sort(), [...names].sort(), "incomplete literal overlay journal");
    for (const entry of previous.files) {
      assert.ok(names.includes(entry.name), "unknown ledger file");
      assert.equal(hash(readFileSync(join(overlay, entry.name))), entry.sha256, "changed deployment preserved: " + entry.name);
      assert.equal(hash(readFileSync(entry.backup)), entry.sourceSha256, "backup changed: " + entry.name);
    }
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
    const oldOut = oldEnabled && name === "2.png" ? patchActivityResponse(displayOut).out : displayOut;
    if (old) assert.equal(hash(oldOut), old.sha256, "recorded literal/consumer output changed; preserve the installed batch");
    let out = displayOut, response;
    if (enabled && name === "2.png") {
      const patched = patchActivityResponse(displayOut); out = patched.out;
      const again = patchActivityResponse(out); assert.equal(again.changed, false); assert.deepEqual(again.out, out);
      const { out: ignored, ...proof } = patched; response = proof;
    }
    return { name, sourceSha256: hash(bytes), sha256: hash(out), changedStrings: totalChanged, bytes: out.length,
      hadOverlay: old?.hadOverlay ?? existsSync(target), backup: old?.backup,
      ...(response ? { activityResponse: response } : {}), out, sourceBytes: bytes, currentBytes: existsSync(target) ? readFileSync(target) : null };
  });
  const unchanged = Boolean(previous) && files.every(entry => entry.sha256 === previous.files.find(old => old.name === entry.name).sha256) && enabled === oldEnabled;
  const journalFiles = () => files.map(({ out, sourceBytes, currentBytes, ...entry }) => entry);
  if (command === "install" && !unchanged) {
    if (!previous) {
      const backupDir = join(runtimeRoot, "client-overlay-backups", `literals-${Date.now()}`); mkdirSync(backupDir, { recursive: true });
      for (const entry of files) { entry.backup = join(backupDir, entry.name); writeFileSync(entry.backup, entry.sourceBytes, { flag: "wx" }); }
    }
    const nextLedger = Buffer.from(JSON.stringify({ ...(previous ?? {}), installedAt: previous?.installedAt ?? new Date().toISOString(),
      ...(previous ? { updatedAt: new Date().toISOString() } : {}), activityResponse: enabled, files: journalFiles() }, null, 2));
    const checkLedger = () => ledgerBytes ? assert.deepEqual(readFileSync(ledger), ledgerBytes, "literal journal changed during preparation") : assert.equal(existsSync(ledger), false, "a literal journal appeared during preparation");
    checkLedger(); const installed = [];
    try {
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
      throw error;
    }
  }
  return { installed: command === "install" || Boolean(previous), restartRequired: true, unchanged,
    activityResponse: enabled, activityResponseInstalled: enabled && (command === "install" || oldEnabled), pendingTransition: enabled !== oldEnabled && command !== "install", renderingAccepted: false,
    files: journalFiles().map(({ backup, ...entry }) => entry) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(JSON.stringify(runLiteralOverlay(literalOptions(process.argv.slice(2)))));
