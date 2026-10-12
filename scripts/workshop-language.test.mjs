import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workshop-language.mjs"));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t) {
  const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, "ddtank-language-"));
  t.after(() => { assert.ok(resolve(root).startsWith(parent + sep)); rmSync(root, { recursive: true, force: true }); });
  const repo = join(root, "source/repo"), runtime = join(root, "runtime");
  const put = (file, text) => { const path = join(repo, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  put("scripts/workshop-language.mjs", script);
  const source = "\uFEFF# source comment\r\nNPC.Line:Original {0:N0}<br/>\r\nUntouched:Kept\r\nNPC.Line:Last {0:N0}<br/>\r\n";
  put("data/i18n/pt-BR/server-language.txt", source);
  put("research/i18n/zh-CN-server-overrides.json", JSON.stringify({ "NPC.Line": "中文 {0:N0}<br/>" }));
  put("apps/api/assets/flash/ui/vietnam/language.txt", "\uFEFF## client\r\nClient.Line:Old {0}\r\n");
  put("research/i18n/zh-CN-overrides.json", JSON.stringify({ "Client.Line": "客户端 {0}" }));
  const run = (...args) => spawnSync(process.execPath, [join(repo, "scripts/workshop-language.mjs"), ...args], { encoding: "utf8", windowsHide: true });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  return { root, repo, runtime, put, source, run, ok };
}

test("server verification is read-only and includes duplicate rows and format placeholders", t => {
  const f = fixture(t), result = JSON.parse(f.ok("verify", "--server"));
  assert.equal(result.keys, 1); assert.equal(result.translatedRows, 2); assert.equal(result.installed, false);
  assert.equal(existsSync(f.runtime), false);
  assert.equal(readFileSync(join(f.repo, "data/i18n/pt-BR/server-language.txt"), "utf8"), f.source);
});

test("the online-box Chinese keys install over the real server dictionary without changing other lines", t => {
  const f = fixture(t);
  // Git checkouts may use LF; the deployment fixture must match the original AS3 parser's CRLF contract.
  const source = readFileSync(join(repoRoot, "data/i18n/pt-BR/server-language.txt"), "utf8").replace(/\r?\n/g, "\r\n");
  const overridesText = readFileSync(join(repoRoot, "research/i18n/zh-CN-server-overrides.json"), "utf8");
  const overrides = JSON.parse(overridesText);
  const keys = ["success", "todayOver", "title", "mail", "fail"].map(key => `UserGetTimeBoxHandler.${key}`).concat("GoodsPresentHandler.AnnexRemark");
  for (const key of keys) assert.equal(typeof overrides[key], "string");
  f.put("data/i18n/pt-BR/server-language.txt", source);
  f.put("research/i18n/zh-CN-server-overrides.json", overridesText);
  f.ok("verify", "--server"); f.ok("install", "--server");
  const expected = source.split("\r\n").map(line => {
    const colon = line.indexOf(":"), key = line.slice(0, colon);
    return colon >= 0 && Object.hasOwn(overrides, key) ? `${key}:${overrides[key]}` : line;
  }).join("\r\n");
  assert.equal(readFileSync(join(f.runtime, "server-language.txt"), "utf8"), expected);
  assert.equal(readFileSync(join(f.repo, "data/i18n/pt-BR/server-language.txt"), "utf8"), source);
});

test("client and server installations use independent targets, journals and rollback", t => {
  const f = fixture(t); f.ok("install");
  const client = join(f.runtime, "client-overlay/ui/vietnam/language.txt"), journal = join(f.runtime, "client-overlay-language.json");
  const oldClient = readFileSync(client), oldJournal = readFileSync(journal);
  f.ok("install", "--server");
  const server = join(f.runtime, "server-language.txt"), bytes = readFileSync(server, "utf8");
  assert.equal(bytes, f.source.replaceAll(/(?:Original|Last) \{0:N0\}/g, "中文 {0:N0}"));
  assert.equal(JSON.parse(f.ok("install", "--server")).unchanged, true);
  f.ok("rollback", "--server");
  assert.equal(existsSync(server), false); assert.equal(existsSync(join(f.runtime, "server-language.json")), false);
  assert.deepEqual(readFileSync(client), oldClient); assert.deepEqual(readFileSync(journal), oldJournal);
});

test("server update backs up and restores the prior deployment without changing the shipped source", t => {
  const f = fixture(t); f.ok("install", "--server");
  const server = join(f.runtime, "server-language.txt"), previous = readFileSync(server);
  f.put("research/i18n/zh-CN-server-overrides.json", JSON.stringify({ "NPC.Line": "新中文 {0:N0}<br/>" }));
  f.ok("install", "--server");
  const journal = JSON.parse(readFileSync(join(f.runtime, "server-language.json"), "utf8"));
  assert.ok(journal.backup.includes("server-language-backups")); assert.deepEqual(readFileSync(journal.backup), previous);
  f.ok("rollback", "--server"); assert.deepEqual(readFileSync(server), previous);
  // Restored owned content must remain updatable; retaining the bytes alone loses the old ownership receipt.
  f.ok("install", "--server"); assert.ok(readFileSync(server, "utf8").includes("新中文"));
  assert.equal(readFileSync(join(f.repo, "data/i18n/pt-BR/server-language.txt"), "utf8"), f.source);
});

test("custom server edits are preserved by install and rollback", t => {
  const f = fixture(t); f.ok("install", "--server");
  const server = join(f.runtime, "server-language.txt"); writeFileSync(server, "custom user content");
  for (const action of ["install", "rollback"]) assert.notEqual(f.run(action, "--server").status, 0);
  assert.equal(readFileSync(server, "utf8"), "custom user content");
});

test("invalid server key or formatted placeholder fails before any deployment write", t => {
  const f = fixture(t);
  for (const overrides of [{ "NPC.Line": "中文 {0}" }, { "Missing.Key": "中文" }, { "NPC.Line": "跨行\n{0:N0}" }]) {
    f.put("research/i18n/zh-CN-server-overrides.json", JSON.stringify(overrides));
    assert.notEqual(f.run("install", "--server").status, 0); assert.equal(existsSync(f.runtime), false);
  }
});

test("server rollback preserves deployment when the saved backup was modified", t => {
  const f = fixture(t); f.ok("install", "--server");
  f.put("research/i18n/zh-CN-server-overrides.json", JSON.stringify({ "NPC.Line": "新中文 {0:N0}<br/>" })); f.ok("install", "--server");
  const target = join(f.runtime, "server-language.txt"), before = readFileSync(target);
  const journal = JSON.parse(readFileSync(join(f.runtime, "server-language.json"), "utf8"));
  writeFileSync(journal.backup, "changed backup");
  assert.notEqual(f.run("rollback", "--server").status, 0); assert.deepEqual(readFileSync(target), before);
  assert.equal(readFileSync(journal.backup, "utf8"), "changed backup");
});

test("server rejects a journal with another target or backup directory", t => {
  const f = fixture(t); f.ok("install", "--server");
  const path = join(f.runtime, "server-language.json"), journal = JSON.parse(readFileSync(path, "utf8"));
  const target = join(f.runtime, "server-language.txt"), before = readFileSync(target);
  writeFileSync(path, JSON.stringify({ ...journal, target: join(f.runtime, "other.txt") }));
  assert.notEqual(f.run("install", "--server").status, 0); assert.notEqual(f.run("rollback", "--server").status, 0);
  writeFileSync(path, JSON.stringify({ ...journal, backup: join(f.root, "unrelated.txt") }));
  assert.notEqual(f.run("rollback", "--server").status, 0); assert.deepEqual(readFileSync(target), before);
});

test("server rollback refuses a backup without its matching previous ownership receipt", t => {
  const f = fixture(t); f.ok("install", "--server");
  f.put("research/i18n/zh-CN-server-overrides.json", JSON.stringify({ "NPC.Line": "新中文 {0:N0}<br/>" })); f.ok("install", "--server");
  const path = join(f.runtime, "server-language.json"), journal = JSON.parse(readFileSync(path, "utf8"));
  const target = join(f.runtime, "server-language.txt"), before = readFileSync(target);
  journal.previousJournal.sha256 = "0".repeat(64); writeFileSync(path, JSON.stringify(journal));
  assert.notEqual(f.run("rollback", "--server").status, 0); assert.deepEqual(readFileSync(target), before);
});
