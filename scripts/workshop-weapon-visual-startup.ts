// Optional, pinned local deployment step. Runs after owned DB readiness and before API/game startup.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createDb } from "../packages/db/src/index.js";
import { q1 } from "../apps/api/src/lib/db.js";
import { planWeaponInstall } from "./workshop-weapon.js";
import { runWeaponVisualUpgrade } from "./workshop-weapon-visuals.js";

const { sql } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Pin = { path: string; sha256: string };
interface Deployment {
  schemaVersion: 1;
  binding: { databaseName: string; dataDirectory: string };
  oldPackage: Pin; newPackage: Pin; originalJournal: Pin; previousFightExtension: Pin; fightExtension: Pin;
  upgradeJournalPath: string; receiptPath: string;
  resources: { resourcePath: string; sha256: string }[];
}
function pinned(pin: Pin) {
  assert.ok(pin && isAbsolute(pin.path) && /^[a-f0-9]{64}$/.test(pin.sha256), "invalid deployment pin");
  const bytes = readFileSync(pin.path); assert.equal(sha(bytes), pin.sha256, "weapon visual deployment input changed"); return bytes;
}
export function readWeaponVisualDeployment(manifestPath: string, previousFightPath: string, uploadDir: string) {
  const bytes = readFileSync(manifestPath), config = JSON.parse(bytes.toString("utf8")) as Deployment;
  assert.deepEqual(Object.keys(config).sort(), ["schemaVersion", "binding", "oldPackage", "newPackage", "originalJournal", "previousFightExtension", "fightExtension", "upgradeJournalPath", "receiptPath", "resources"].sort());
  assert.equal(config.schemaVersion, 1);
  assert.deepEqual(Object.keys(config.binding).sort(), ["databaseName", "dataDirectory"].sort());
  assert.equal(config.binding.databaseName, "ddtank", "visual deployment only owns the original local database");
  assert.ok(isAbsolute(config.binding.dataDirectory) && isAbsolute(config.upgradeJournalPath) && isAbsolute(config.receiptPath));
  assert.equal(resolve(previousFightPath), resolve(config.previousFightExtension.path), "existing fight extension differs");
  pinned(config.previousFightExtension); pinned(config.fightExtension); pinned(config.originalJournal);
  const oldConfig = JSON.parse(pinned(config.oldPackage).toString("utf8")), newConfig = JSON.parse(pinned(config.newPackage).toString("utf8"));
  assert.equal(planWeaponInstall(oldConfig).templateId, 9107258); assert.equal(planWeaponInstall(newConfig).templateId, 9107258);
  const root = realpathSync(uploadDir), expected = ["image/bomb/blastout/blastout15601.swf", "image/bomb/blastout/blastout156011.swf", "image/bomb/blastout/blastout156012.swf", "image/bomb/blastout/blastout156013.swf", "image/bomb/bullet/bullet15601.swf", "image/bomb/bullet/bullet15602.swf"];
  assert.deepEqual(config.resources.map(row => row.resourcePath).sort(), expected.sort(), "incomplete original visual resources");
  for (const row of config.resources) {
    const path = realpathSync(join(root, row.resourcePath)), inside = relative(root, path);
    assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside), "visual resource escapes upload root");
    pinned({ path, sha256: row.sha256 });
  }
  return { config, oldConfig, newConfig, check: () => {
    assert.deepEqual(readFileSync(manifestPath), bytes, "visual deployment manifest changed");
    for (const pin of [config.oldPackage, config.newPackage, config.originalJournal, config.previousFightExtension, config.fightExtension]) pinned(pin);
    for (const row of config.resources) pinned({ path: join(root, row.resourcePath), sha256: row.sha256 });
  } };
}

export function readWeaponVisualSession(runtime: string, expected: { runId: string; managerPid: number; databaseName: string }) {
  const sessionPath = join(runtime, "workshop-session.json"), readyPath = join(runtime, "postgres-ready.json");
  const sessionBytes = readFileSync(sessionPath), readyBytes = readFileSync(readyPath);
  const session = JSON.parse(sessionBytes.toString("utf8")), ready = JSON.parse(readyBytes.toString("utf8"));
  assert.equal(session.runId, expected.runId); assert.equal(session.managerPid, expected.managerPid);
  assert.equal(session.databaseName, expected.databaseName); assert.equal(session.ports?.db, 55432);
  const db = session.children?.filter((child: { name: string }) => child.name === "db");
  assert.equal(db?.length, 1); assert.equal(db[0].pid, ready.pid); assert.equal(ready.port, 55432); assert.equal(ready.databaseName, expected.databaseName);
  assert.ok(Number.isSafeInteger(expected.managerPid) && expected.managerPid > 0, "invalid Workshop manager PID");
  assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0, "invalid Workshop database PID");
  const binding = { databaseName: expected.databaseName, dataDirectory: realpathSync(join(runtime, "data/postgres")) };
  const check = () => {
    assert.deepEqual(readFileSync(sessionPath), sessionBytes, "Workshop startup session changed");
    assert.deepEqual(readFileSync(readyPath), readyBytes, "Workshop database restarted");
    process.kill(expected.managerPid, 0); process.kill(ready.pid, 0);
  };
  check(); return { binding, check };
}

export async function activateWeaponVisualStartup(options: {
  manifestPath: string; previousFightPath: string; uploadDir: string; runtime: string;
  runId: string; managerPid: number; databaseName: string;
}) {
  const deployment = readWeaponVisualDeployment(options.manifestPath, options.previousFightPath, options.uploadDir);
  const selected = readWeaponVisualSession(options.runtime, options);
  assert.deepEqual(selected.binding, deployment.config.binding, "visual deployment has no ownership for this selected database; refused before API/game startup");
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55432"); assert.equal(url.pathname, "/" + selected.binding.databaseName);
  const h = await createDb(url.href, { max: 1 });
  try {
    const identity = await q1<{ databaseName: string; dataDirectory: string; port: number; timezone: string }>(h, sql`SELECT current_database() AS "databaseName", current_setting('data_directory') AS "dataDirectory", inet_server_port() AS port, current_setting('TimeZone') AS timezone`);
    assert.equal(identity?.databaseName, selected.binding.databaseName); assert.equal(identity?.port, 55432); assert.equal(identity?.timezone, "UTC");
    assert.equal(realpathSync(identity!.dataDirectory), selected.binding.dataDirectory);
    const check = () => { selected.check(); deployment.check(); }; check();
    const result = await runWeaponVisualUpgrade(h, { oldConfig: deployment.oldConfig, newConfig: deployment.newConfig,
      originalJournalPath: deployment.config.originalJournal.path, upgradeJournalPath: deployment.config.upgradeJournalPath,
      binding: selected.binding, checkBinding: check });
    check();
    // isNew/no-op still selects the new fight package: a prior process may have stopped after DB commit.
    const receipt = { ...result, databaseName: selected.binding.databaseName, fightExtension: deployment.config.fightExtension.path, originalAssetsVerified: 6, checkedAt: new Date().toISOString(), fullGameAccepted: false };
    writeFileSync(deployment.config.receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    return receipt;
  } finally { await h.close(); }
}
