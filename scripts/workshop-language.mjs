#!/usr/bin/env node
// Deployment-only client/server dictionary overlay. Shipped languages remain untouched.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(repo, "../../runtime");
const server = process.argv.includes("--server");
const notifications = process.argv.includes("--notifications");
assert.ok(!(server && notifications), "--server and --notifications are mutually exclusive");
const ownedHistory = server || notifications;
const backupDirectory = join(runtime, server ? "server-language-backups" : "client-overlay-backups");
const target = join(runtime, server ? "server-language.txt" : notifications ? "client-overlay/ui/vietnam/movingnotification.txt" : "client-overlay/ui/vietnam/language.txt");
const journalFile = join(runtime, server ? "server-language.json" : notifications ? "client-overlay-notifications.json" : "client-overlay-language.json");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const command = process.argv[2] ?? "verify";
assert.ok(["verify", "install", "rollback"].includes(command), "usage: workshop-language.mjs verify|install|rollback [--server|--notifications]");
function replace(bytes) {
  mkdirSync(dirname(target), { recursive: true });
  const fresh = target + `.workshop-${process.pid}`;
  writeFileSync(fresh, bytes, { flag: "wx" });
  renameSync(fresh, target);
}
if (command === "rollback") {
  assert.ok(existsSync(journalFile), "no language overlay journal");
  const journal = JSON.parse(readFileSync(journalFile, "utf8"));
  assert.equal(hash(readFileSync(target)), journal.sha256, "overlay changed since install; preserved");
  let backup;
  if (ownedHistory) assert.equal(journal.target, target, "language journal target differs; preserved");
  if (journal.backup) {
    if (ownedHistory) assert.equal(dirname(resolve(journal.backup)), backupDirectory, "language backup directory differs; preserved");
    backup = readFileSync(journal.backup);
    if (ownedHistory) {
      assert.equal(hash(backup), journal.backupSha256, "server language backup changed; preserved");
      assert.equal(journal.previousJournal?.target, target, "previous server language owner differs; preserved");
      assert.equal(journal.previousJournal?.sha256, journal.backupSha256, "previous server language receipt differs; preserved");
    }
  }
  if (backup) replace(backup); else unlinkSync(target);
  if (ownedHistory && backup) writeFileSync(journalFile, JSON.stringify(journal.previousJournal, null, 2));
  else unlinkSync(journalFile);
  console.log(`Chinese ${server ? "server" : notifications ? "scroll-notice" : "client"} overlay rolled back; shipped language retained`);
} else {
  const source = readFileSync(join(repo, server ? "data/i18n/pt-BR/server-language.txt" : notifications ? "apps/api/assets/flash/ui/vietnam/movingnotification.txt" : "apps/api/assets/flash/ui/vietnam/language.txt"));
  if (notifications) assert.ok(source.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])), "original scroll notices require UTF-16LE BOM");
  let text = source.toString(notifications ? "utf16le" : "utf8");
  const overrides = JSON.parse(readFileSync(join(repo, server ? "research/i18n/zh-CN-server-overrides.json" : notifications ? "research/i18n/zh-CN-moving-notifications.json" : "research/i18n/zh-CN-overrides.json"), "utf8"));
  assert.ok(text.includes("\r\n") && !/(?<!\r)\n/.test(text), "original AS3 parser requires CRLF");
  // Repair the three known malformed source records only in the deployment copy.
  const repairsFile = join(repo, "research/i18n/zh-CN-dictionary-format-repairs.json");
  if (!notifications && existsSync(repairsFile)) {
    const repairs = JSON.parse(readFileSync(repairsFile, "utf8"))[server ? "server" : "client"];
    assert.equal(repairs.sourceSha256, hash(source), "dictionary format repair source changed; preserved");
    for (const repair of repairs.entries) {
      assert.equal(typeof repair.source, "string"); assert.ok(repair.source.length > 0);
      assert.equal(typeof repair.replacement, "string");
      assert.equal(text.split(repair.source).length, 2, "dictionary format repair needs exactly one source record");
      assert.equal(repair.source.replace(/[\r\n]/g, ""), repair.replacement.replace(/[\r\n]/g, ""), "format repair may only change line boundaries");
      assert.ok(!/(?<!\r)\n|\r(?!\n)/.test(repair.replacement), "dictionary format repair requires CRLF");
      text = text.replace(repair.source, repair.replacement);
    }
  }
  if (notifications) {
    assert.equal(hash(source), overrides.sourceSha256, "shipped scroll notices changed; preserved");
    assert.ok(Array.isArray(overrides.lines) && overrides.lines.length > 0, "scroll notices need nonempty lines");
    for (const line of overrides.lines) assert.ok(typeof line === "string" && line.trim() && !/[\r\n{}]/.test(line), "invalid plain scroll-notice line");
  }
  const placeholders = value => [...value.matchAll(/\{\d+(?::[^}]*)?\}/g)].map(match => match[0]).sort();
  const rowOverrides = new Map(), seenVariants = new Map();
  const rowFile = join(repo, "research/i18n/zh-CN-server-row-overrides.json");
  if (server && existsSync(rowFile)) {
    const config = JSON.parse(readFileSync(rowFile, "utf8"));
    assert.ok(config && typeof config === "object" && !Array.isArray(config), "server row overrides need a source-bound object");
    assert.equal(config.sourceSha256, hash(source), "server row override source changed; preserved");
    assert.ok(config.entries && typeof config.entries === "object" && !Array.isArray(config.entries), "server row overrides need key/variant entries");
    for (const [key, variants] of Object.entries(config.entries)) {
      assert.ok(key && !/[:\r\n\t]/.test(key), `invalid server row override key: ${key}`);
      assert.ok(!Object.hasOwn(overrides, key), `server row override collides with a flat override: ${key}`);
      assert.ok(Array.isArray(variants) && variants.length > 0, `missing server row variants: ${key}`);
      const translations = new Map();
      for (const variant of variants) {
        assert.ok(variant && typeof variant === "object" && typeof variant.source === "string" && typeof variant.translation === "string", `invalid server row variant: ${key}`);
        assert.ok(!/[\r\n]/.test(variant.source) && !/[\r\n]/.test(variant.translation), `invalid server row line: ${key}`);
        assert.ok(!translations.has(variant.source), `duplicate server row variant: ${key}`);
        assert.deepEqual(placeholders(variant.translation), placeholders(variant.source), `placeholder mismatch: ${key}`);
        translations.set(variant.source, variant.translation);
      }
      rowOverrides.set(key, translations); seenVariants.set(key, new Set());
    }
  }
  const seen = new Set(); let changedRows = 0;
  let output = notifications ? overrides.lines.join("\r\n") + "\r\n" : text.split("\r\n").map(line => {
    const boundary = line.indexOf(":");
    if (boundary < 1 || line.startsWith("##")) return line;
    const key = line.slice(0, boundary).replace(/^\uFEFF/, "");
    if (!Object.hasOwn(overrides, key) && !rowOverrides.has(key)) return line;
    const original = line.slice(boundary + 1);
    let translated;
    if (rowOverrides.has(key)) {
      assert.ok(rowOverrides.get(key).has(original), `unlisted server row variant: ${key}`);
      translated = rowOverrides.get(key).get(original); seenVariants.get(key).add(original);
    } else translated = overrides[key];
    assert.equal(typeof translated, "string");
    assert.ok(!/[\r\n]/.test(translated), `invalid translated line: ${key}`);
    assert.deepEqual(placeholders(translated), placeholders(original), `placeholder mismatch: ${key}`);
    seen.add(key); changedRows++;
    return line.slice(0, boundary + 1) + translated;
  }).join("\r\n");
  if (!notifications) {
    assert.equal(seen.size, Object.keys(overrides).length + rowOverrides.size, "translation keys missing from original dictionary");
    for (const [key, variants] of rowOverrides) assert.equal(seenVariants.get(key).size, variants.size, `server row variants missing from original dictionary: ${key}`);
  }
  let addedKeys = 0;
  const additionsFile = join(repo, "research/i18n/zh-CN-server-additions.json");
  if (server && existsSync(additionsFile)) {
    const additions = JSON.parse(readFileSync(additionsFile, "utf8"));
    assert.ok(additions && typeof additions === "object" && !Array.isArray(additions), "server additions need a flat key/string map");
    const originalKeys = new Set(text.split("\r\n").filter(line => line.indexOf(":") > 0).map(line => line.slice(0, line.indexOf(":")).replace(/^\uFEFF/, "")));
    const lines = Object.entries(additions).map(([key, value]) => {
      const eventKey = key.startsWith("Workshop.Events.") && key.length > "Workshop.Events.".length && !/[:\r\n\t]/.test(key);
      const pveKey = /^Workshop\.Pve\.[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(key);
      assert.ok(eventKey || pveKey, `invalid server addition key: ${key}`);
      assert.ok(!Object.hasOwn(overrides, key) && !rowOverrides.has(key) && !originalKeys.has(key), `server addition collides with an existing key: ${key}`);
      assert.ok(typeof value === "string" && value.trim() && !/[\r\n\t]/.test(value), `invalid server addition value: ${key}`);
      return `${key}:${value}\r\n`;
    });
    addedKeys = lines.length;
    if (addedKeys) output += (output.endsWith("\r\n") ? "" : "\r\n") + lines.join("");
  }
  const bytes = notifications ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(output, "utf16le")]) : Buffer.from(output, "utf8");
  const summary = { sourceSha256: hash(source), sha256: hash(bytes), ...(notifications ? { notifications: overrides.lines.length, encoding: "utf16le-bom" } : { keys: seen.size + addedKeys, translatedRows: changedRows + addedKeys, ...(addedKeys ? { addedKeys } : {}) }), bytes: bytes.length, renderingAccepted: false };
  if (command === "install") {
    const previous = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, "utf8")) : null;
    if (existsSync(target)) {
      assert.ok(previous && hash(readFileSync(target)) === previous.sha256, "unowned/custom language overlay preserved");
      if (ownedHistory) assert.equal(previous.target, target, "language journal target differs; preserved");
      if (previous.sha256 === summary.sha256) { console.log(JSON.stringify({ ...summary, installed: true, unchanged: true })); process.exit(0); }
    }
    let backup, backupSha256;
    if (existsSync(target)) {
      backup = join(backupDirectory, `${notifications ? "notifications" : "language"}-${Date.now()}.txt`);
      mkdirSync(dirname(backup), { recursive: true }); writeFileSync(backup, readFileSync(target), { flag: "wx" });
      if (ownedHistory) backupSha256 = hash(readFileSync(backup));
    }
    replace(bytes);
    assert.equal(hash(readFileSync(target)), summary.sha256);
    writeFileSync(journalFile, JSON.stringify({ ...summary, target, backup, ...(ownedHistory ? { backupSha256, previousJournal: backup ? previous : undefined } : {}), installedAt: new Date().toISOString() }, null, 2));
  }
  console.log(JSON.stringify({ ...summary, installed: command === "install" }));
}
