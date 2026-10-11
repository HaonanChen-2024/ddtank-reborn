import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePortsFree, portOpen, selectLanHost, selectRestoredBackup, stopOwnedChild } from "./workshop.mjs";
import { confirmRestoredDatabase, readRestoredBackup, selectedDatabase } from "./workshop-backup.mjs";

function restoreFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ddtank-workshop-restore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, "postgres"), path = join(dir, "backup.dump.json"), binding = join(dir, "private", "binding.json");
  mkdirSync(data); writeFileSync(join(data, "PG_VERSION"), "18\n");
  const bytes = Buffer.from("isolated unit fixture, not a real Postgres backup");
  writeFileSync(join(dir, "backup.dump"), bytes);
  const fingerprint = Object.fromEntries(["accounts", "players", "goods", "templates", "shop", "maps"].map(key => [key, { count: 1, digest: "a".repeat(32) }]));
  // The deployed pre-feature manifest/restore format must remain accepted.
  const manifest = { dump: "backup.dump", sha256: createHash("sha256").update(bytes).digest("hex"), fingerprint };
  const restored = { ok: true, database: "workshop_restore_1791703803629_e082e2", dumpSha256: manifest.sha256, fingerprint, originalDatabaseUntouched: true };
  writeFileSync(path, JSON.stringify(manifest)); writeFileSync(path + ".restore.json", JSON.stringify(restored));
  return { dir, data, path, binding, manifest, restored };
}

test("restored selection validates the deployed backup format and refuses a fresh cluster", async t => {
  const f = restoreFixture(t);
  assert.equal(await selectRestoredBackup([], join(f.dir, "missing-cluster")), null);
  assert.equal((await selectRestoredBackup(["--restored=" + f.path], f.data)).database, f.restored.database);
  await assert.rejects(selectRestoredBackup(["--restored=" + f.path], join(f.dir, "missing-cluster")), /不会新建空库/);
  await assert.rejects(selectRestoredBackup(["--restored"], f.data), /完整的备份/);
  await assert.rejects(selectRestoredBackup(["--restored=" + f.path, "--restored=" + f.path], f.data), /完整的备份/);
});

test("missing/hash/proof/fingerprint errors preserve all supplied files and create no binding", t => {
  const f = restoreFixture(t);
  assert.throws(() => readRestoredBackup(join(f.dir, "missing.dump.json")), /ENOENT/);
  const proof = f.path + ".restore.json", dump = join(f.dir, "backup.dump");
  for (const change of [
    () => writeFileSync(dump, "tampered archive"),
    () => writeFileSync(proof, JSON.stringify({ ...f.restored, dumpSha256: "b".repeat(64) })),
    () => writeFileSync(proof, JSON.stringify({ ...f.restored, fingerprint: {} })),
    () => writeFileSync(proof, JSON.stringify({ ...f.restored, database: "ddtank" })),
    () => writeFileSync(proof, JSON.stringify({ ...f.restored, ok: false })),
  ]) {
    writeFileSync(dump, "isolated unit fixture, not a real Postgres backup"); writeFileSync(proof, JSON.stringify(f.restored)); change();
    const before = [f.path, proof, dump].map(path => readFileSync(path));
    assert.throws(() => readRestoredBackup(f.path));
    [f.path, proof, dump].forEach((path, i) => assert.deepEqual(readFileSync(path), before[i]));
    assert.equal(existsSync(f.binding), false);
  }
});

test("first activation requires real fingerprint; a bound copy can retain later gameplay changes", async t => {
  const f = restoreFixture(t), restored = readRestoredBackup(f.path);
  const changed = { ...f.manifest.fingerprint, players: { count: 2, digest: "b".repeat(32) } };
  await assert.rejects(confirmRestoredDatabase(restored, f.data, f.binding, async () => restored.database, async () => changed), /does not match/);
  assert.equal(existsSync(f.binding), false);
  let fingerprints = 0, identities = 0;
  const identity = async database => { identities++; return database; };
  assert.deepEqual(await confirmRestoredDatabase(restored, f.data, f.binding, identity, async () => { fingerprints++; return f.manifest.fingerprint; }), { databaseName: restored.database, continued: false });
  const binding = readFileSync(f.binding);
  assert.deepEqual(await confirmRestoredDatabase(restored, f.data, f.binding, identity, async () => { fingerprints++; return changed; }), { databaseName: restored.database, continued: true });
  assert.equal(fingerprints, 1); assert.equal(identities, 2); assert.deepEqual(readFileSync(f.binding), binding);
  await assert.rejects(confirmRestoredDatabase({ ...restored, restoreProofSha256: "c".repeat(64) }, f.data, f.binding, identity), /binding differs/);
  await assert.rejects(confirmRestoredDatabase(restored, f.data, f.binding, async () => "ddtank"), /identity differs/);
  assert.deepEqual(readFileSync(f.binding), binding);
});

test("backup source follows the running selected database and retains legacy default sessions", () => {
  assert.equal(selectedDatabase(null), "ddtank");
  assert.equal(selectedDatabase({ managerPid: process.pid }), "ddtank");
  assert.equal(selectedDatabase({ managerPid: process.pid, databaseName: "workshop_restore_1791703803629_e082e2" }), "workshop_restore_1791703803629_e082e2");
  assert.throws(() => selectedDatabase({ managerPid: process.pid, databaseName: "another_project" }), /invalid Workshop database/);
  assert.throws(() => selectedDatabase({ managerPid: 0, databaseName: "ddtank" }), /invalid Workshop session/);
});

test("normal IPC stop and forced own-child termination are reported differently", async () => {
  for (const cooperate of [true, false]) {
    const child = spawn(process.execPath, ["--eval", `process.on('message', m => { if (${cooperate} && m === 'workshop-stop') process.exit(0); }); process.send('ready'); setInterval(() => {}, 1000);`], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.workshopName = "fixture";
    await new Promise((res, rej) => { child.once("message", res); child.once("error", rej); });
    try {
      const result = await stopOwnedChild(child, 100);
      assert.equal(result.stopped, true);
      assert.equal(result.forced, !cooperate);
      assert.equal(result.graceful, cooperate);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  }
});

test("LAN selection accepts a local private address and excludes virtual adapters by default", () => {
  const interfaces = {
    WLAN: [{ address: "192.168.1.6", internal: false }],
    VMware: [{ address: "192.168.200.1", internal: false }],
    loopback: [{ address: "127.0.0.1", internal: true }],
    external: [{ address: "8.8.8.8", internal: false }],
  };
  assert.equal(selectLanHost(undefined, interfaces), "192.168.1.6");
  assert.equal(selectLanHost("192.168.200.1", interfaces), "192.168.200.1");
  for (const value of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "192.168.1.7"]) {
    assert.throws(() => selectLanHost(value, interfaces), /本机网卡/);
  }
  assert.throws(() => selectLanHost(undefined, { ...interfaces, Ethernet: [{ address: "10.1.1.2", internal: false }] }), /唯一/);
});

test("an occupied loopback port is refused without stopping its owner", async () => {
  const owner = net.createServer((socket) => socket.end());
  await new Promise((resolve) => owner.listen(0, "127.0.0.1", resolve));
  const port = owner.address().port;
  try {
    assert.equal(await portOpen(port), true);
    await assert.rejects(ensurePortsFree({ existing: port }), /端口已占用/);
    assert.equal(owner.listening, true);
    assert.equal(await portOpen(port), true);
  } finally { await new Promise((resolve) => owner.close(resolve)); }
  assert.equal(await portOpen(port), false);
  await ensurePortsFree({ closed: port });
});
