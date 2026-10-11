#!/usr/bin/env node
// Local deployment overlay: only known display strings, never the original SWFs or RSA material.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchSwfBuffer } from "../tools/i18n/abc-strings/patch.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(repo, "../../runtime");
const overlay = join(runtime, "client-overlay");
const ledger = join(runtime, "client-overlay-literals.json");
const command = process.argv[2] ?? "verify";
assert.ok(["verify", "install", "rollback"].includes(command), "usage: workshop-literals.mjs verify|install|rollback");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const previous = existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")) : null;
const names = ["2.png", "3.png", "DDT_Loading.swf"];
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
  writeFileSync(fresh, bytes, { flag: "wx" });
  renameSync(fresh, path);
}
if (command === "rollback") {
  assert.ok(previous, "no literal overlay journal");
  checkOwned();
  for (const entry of previous.files) {
    const target = join(overlay, entry.name);
    if (entry.hadOverlay) replace(target, readFileSync(entry.backup)); else unlinkSync(target);
  }
  unlinkSync(ledger);
  console.log(JSON.stringify({ rolledBack: true, files: previous.files.length, restartRequired: true }));
} else {
  if (previous) checkOwned();
  const chinese = JSON.parse(readFileSync(join(repo, "research/i18n/zh-CN-literals.json"), "utf8"));
  const portuguese = JSON.parse(readFileSync(join(repo, "tools/i18n/abc-strings/translations.json"), "utf8"));
  const translations = { ...chinese };
  for (const [source, value] of Object.entries(chinese)) {
    assert.ok(portuguese[source], "unknown original display string: " + source);
    assert.equal(typeof value, "string");
    assert.ok(!/[\r\n]/.test(value));
    // Also replace the corresponding PT-BR strings in the already patched deployment.
    translations[portuguese[source]] = value;
  }
  const files = names.map(name => {
    const old = previous?.files.find(entry => entry.name === name);
    const target = join(overlay, name);
    const source = old?.backup ?? (existsSync(target) ? target : join(repo, "apps/api/assets/flash", name));
    const bytes = readFileSync(source);
    const { out, totalChanged } = patchSwfBuffer(bytes, translations);
    assert.ok(totalChanged > 0, "known display literals absent: " + name);
    // Replacing the same values twice must be a no-op, and the SWF must still parse.
    const repeated = patchSwfBuffer(out, translations);
    assert.equal(repeated.totalChanged, 0, "untranslated display literals remain: " + name);
    assert.deepEqual(repeated.out, out, "non-idempotent SWF patch: " + name);
    if (old) assert.equal(hash(out), old.sha256, "translation changed; rollback the previous batch first");
    return { name, sourceSha256: hash(bytes), sha256: hash(out), changedStrings: totalChanged,
      bytes: out.length, hadOverlay: old?.hadOverlay ?? existsSync(target), backup: old?.backup, out, sourceBytes: bytes };
  });
  if (command === "install" && !previous) {
    const backupDir = join(runtime, "client-overlay-backups", `literals-${Date.now()}`);
    mkdirSync(backupDir, { recursive: true });
    for (const entry of files) {
      entry.backup = join(backupDir, entry.name);
      writeFileSync(entry.backup, entry.sourceBytes, { flag: "wx" });
    }
    const installed = [];
    try {
      for (const entry of files) {
        replace(join(overlay, entry.name), entry.out);
        installed.push(entry);
        assert.equal(hash(readFileSync(join(overlay, entry.name))), entry.sha256);
      }
      writeFileSync(ledger, JSON.stringify({ installedAt: new Date().toISOString(), files: files.map(({ out, sourceBytes, ...entry }) => entry) }, null, 2), { flag: "wx" });
    } catch (error) {
      for (const entry of installed.reverse()) {
        if (entry.hadOverlay) replace(join(overlay, entry.name), entry.sourceBytes);
        else unlinkSync(join(overlay, entry.name));
      }
      throw error;
    }
  }
  console.log(JSON.stringify({ installed: command === "install" || Boolean(previous), restartRequired: true,
    unchanged: Boolean(previous), renderingAccepted: false,
    files: files.map(({ out, sourceBytes, backup, ...entry }) => entry) }));
}
