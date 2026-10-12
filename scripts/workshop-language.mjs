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
const target = join(runtime, server ? "server-language.txt" : "client-overlay/ui/vietnam/language.txt");
const journalFile = join(runtime, server ? "server-language.json" : "client-overlay-language.json");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const command = process.argv[2] ?? "verify";
assert.ok(["verify", "install", "rollback"].includes(command), "usage: workshop-language.mjs verify|install|rollback [--server]");
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
  if (server) assert.equal(journal.target, target, "server language journal target differs; preserved");
  if (journal.backup) {
    if (server) assert.equal(dirname(resolve(journal.backup)), join(runtime, "server-language-backups"), "server language backup directory differs; preserved");
    backup = readFileSync(journal.backup);
    if (server) {
      assert.equal(hash(backup), journal.backupSha256, "server language backup changed; preserved");
      assert.equal(journal.previousJournal?.target, target, "previous server language owner differs; preserved");
      assert.equal(journal.previousJournal?.sha256, journal.backupSha256, "previous server language receipt differs; preserved");
    }
  }
  if (backup) replace(backup); else unlinkSync(target);
  if (server && backup) writeFileSync(journalFile, JSON.stringify(journal.previousJournal, null, 2));
  else unlinkSync(journalFile);
  console.log(`Chinese ${server ? "server" : "client"} dictionary overlay rolled back; shipped language retained`);
} else {
  const source = readFileSync(join(repo, server ? "data/i18n/pt-BR/server-language.txt" : "apps/api/assets/flash/ui/vietnam/language.txt"));
  const text = source.toString("utf8");
  const overrides = JSON.parse(readFileSync(join(repo, server ? "research/i18n/zh-CN-server-overrides.json" : "research/i18n/zh-CN-overrides.json"), "utf8"));
  assert.ok(text.includes("\r\n") && !/(?<!\r)\n/.test(text), "original AS3 parser requires CRLF");
  const seen = new Set(); let changedRows = 0;
  const output = text.split("\r\n").map(line => {
    const boundary = line.indexOf(":");
    if (boundary < 1 || line.startsWith("##")) return line;
    const key = line.slice(0, boundary).replace(/^\uFEFF/, "");
    if (!Object.hasOwn(overrides, key)) return line;
    const translated = overrides[key];
    assert.equal(typeof translated, "string");
    assert.ok(!/[\r\n]/.test(translated), `invalid translated line: ${key}`);
    const placeholders = value => [...value.matchAll(/\{\d+(?::[^}]*)?\}/g)].map(match => match[0]).sort();
    assert.deepEqual(placeholders(translated), placeholders(line.slice(boundary + 1)), `placeholder mismatch: ${key}`);
    seen.add(key); changedRows++;
    return line.slice(0, boundary + 1) + translated;
  }).join("\r\n");
  assert.equal(seen.size, Object.keys(overrides).length, "translation keys missing from original dictionary");
  const bytes = Buffer.from(output, "utf8");
  const summary = { sourceSha256: hash(source), sha256: hash(bytes), keys: seen.size, translatedRows: changedRows, bytes: bytes.length, renderingAccepted: false };
  if (command === "install") {
    const previous = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, "utf8")) : null;
    if (existsSync(target)) {
      assert.ok(previous && hash(readFileSync(target)) === previous.sha256, "unowned/custom language overlay preserved");
      if (server) assert.equal(previous.target, target, "server language journal target differs; preserved");
      if (previous.sha256 === summary.sha256) { console.log(JSON.stringify({ ...summary, installed: true, unchanged: true })); process.exit(0); }
    }
    let backup, backupSha256;
    if (existsSync(target)) {
      backup = join(runtime, server ? "server-language-backups" : "client-overlay-backups", `language-${Date.now()}.txt`);
      mkdirSync(dirname(backup), { recursive: true }); writeFileSync(backup, readFileSync(target), { flag: "wx" });
      if (server) backupSha256 = hash(readFileSync(backup));
    }
    replace(bytes);
    assert.equal(hash(readFileSync(target)), summary.sha256);
    writeFileSync(journalFile, JSON.stringify({ ...summary, target, backup, ...(server ? { backupSha256, previousJournal: backup ? previous : undefined } : {}), installedAt: new Date().toISOString() }, null, 2));
  }
  console.log(JSON.stringify({ ...summary, installed: command === "install" }));
}
