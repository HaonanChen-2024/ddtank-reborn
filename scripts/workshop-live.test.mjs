import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeWorkshopPaths, resolveLivePath, verifyWorkshopLive } from "./workshop-live.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ddtank-live-inputs-")), repo = join(root, "source/repo");
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), "ddtank-live-inputs-"))); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(repo, { recursive: true }); mkdirSync(join(root, "runtime/live"), { recursive: true });
  const put = (name, data) => {
    const file = resolve(repo, name), bytes = Buffer.from(typeof data === "string" ? data : JSON.stringify(data));
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
    return { path: relative(repo, file).replaceAll("\\", "/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const language = put("../../runtime/live/language.txt", "key:中文"), fight = put("config/fight.json", { balls: [] });
  const manifest = { schemaVersion: 1, pathBase: "repo", files: [language, fight] };
  const profile = { schemaVersion: 1, pathBase: "repo", envPaths: { LANGUAGE_FILE: language.path, FIGHT_WEAPON_EXTENSION: fight.path }, inputs: put("config/inputs.json", manifest) };
  const profilePath = resolve(repo, put("config/profile.json", profile).path), settings = { ...profile.envPaths, PG_PASSWORD: "never included in output" };
  const save = () => { profile.inputs = put("config/inputs.json", manifest); put("config/profile.json", profile); };
  const check = () => verifyWorkshopLive(profilePath, settings, repo);
  return { root, repo, put, language, fight, manifest, profile, profilePath, settings, save, check };
}

test("bounded profile verifies repository-relative definitions and stable runtime files without writes", t => {
  const f = fixture(t), before = readFileSync(f.profilePath), result = f.check();
  assert.equal(result.files, 2); assert.equal(result.filesRead, 4); assert.equal(result.inputBytes, f.language.bytes + f.fight.bytes);
  assert.deepEqual(readFileSync(f.profilePath), before);
  const normalized = normalizeWorkshopPaths(f.settings, f.repo);
  assert.equal(normalized.LANGUAGE_FILE, resolve(f.repo, f.language.path)); assert.equal(normalized.PG_PASSWORD, f.settings.PG_PASSWORD);
  assert.deepEqual(verifyWorkshopLive(f.profilePath, normalized, f.repo), result);
});
test("missing and changed inputs fail before any service action", t => {
  const f = fixture(t), path = resolve(f.repo, f.fight.path), before = readFileSync(path);
  writeFileSync(path, Buffer.alloc(before.length)); assert.throws(f.check, /hash changed/);
  writeFileSync(path, "longer than original fixture input"); assert.throws(f.check, /size changed/);
  rmSync(path); assert.throws(f.check, /ENOENT/);
});
test("manifest tampering, duplicate pins and omitted selected file are rejected", t => {
  const f = fixture(t); writeFileSync(resolve(f.repo, f.profile.inputs.path), "{}"); assert.throws(f.check, /size changed/);
  f.manifest.files.push(f.fight); f.save(); assert.throws(f.check, /duplicate/);
  f.manifest.files = [f.language]; f.save(); assert.throws(f.check, /not pinned/);
});
test("path escape and absolute paths are refused, while stable runtime paths are accepted", t => {
  const f = fixture(t);
  for (const value of ["../../../escape", "../../elsewhere/file", resolve(f.root, "absolute"), "C:relative", "https://example.com/file", ""]) assert.throws(() => resolveLivePath(f.repo, value));
  assert.equal(resolveLivePath(f.repo, "../../runtime/live/language.txt"), resolve(f.repo, f.language.path));
  f.manifest.files[0].path = "../../elsewhere/file"; f.save(); assert.throws(f.check, /escapes/);
});
test("environment drift and credential fields are rejected without exposing values", t => {
  const f = fixture(t); f.settings.LANGUAGE_FILE = "another-file"; assert.throws(f.check, /live setting differs: LANGUAGE_FILE/);
  f.settings.LANGUAGE_FILE = f.language.path; f.profile.envPaths.PG_PASSWORD = "credential"; f.save();
  assert.throws(f.check, error => error.message.includes("unsupported setting") && !error.message.includes("credential"));
});

test("Git attributes preserve every pinned definition byte with autocrlf enabled", () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const git = args => { const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const names = readdirSync(join(repo, "config/workshop"), { recursive: true }).filter(name => name.endsWith(".json")).map(name => "config/workshop/" + name.replaceAll("\\", "/"));
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.equal(git(["check-attr", "text", "--", name]), name + ": text: unset");
    // hash-object without -w is read-only; --path runs the same clean conversion as add.
    assert.equal(git(["-c", "core.autocrlf=true", "hash-object", "--path=" + name, name]), git(["hash-object", "--no-filters", name]));
  }
});
