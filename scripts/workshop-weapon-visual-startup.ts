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
import { readOfficialWeaponEvidence, runWeaponEffectsUpgrade, weaponEffectsPackage } from "./workshop-weapon-effects.js";

const { sql } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Pin = { path: string; sha256: string };
interface Deployment {
  schemaVersion: 1;
  binding: { databaseName: string; dataDirectory: string };
  oldPackage: Pin; newPackage: Pin; originalJournal: Pin; previousFightExtension: Pin; fightExtension: Pin;
  upgradeJournalPath: string; receiptPath: string;
  resources: { resourcePath: string; sha256: string }[];
  effects?: Pin;
}
interface EffectsDeployment {
  schemaVersion: 1; selection: "official-capture-v17.1.1"; visualJournal: Pin; previousFightExtension: Pin;
  upgradeJournalPath: string;
  officialBallList: Pin; officialBombConfig: Pin; craterShapes: Pin; audioVerification: Pin;
  particleMode: "official" | "retained";
  particleVerification?: Pin;
  resources: (Pin & { kind: "audio" | "client-crater" | "client-crater-brink" | "particle-definition" | "particle-textures" })[];
}
function pinned(pin: Pin) {
  assert.ok(pin && isAbsolute(pin.path) && /^[a-f0-9]{64}$/.test(pin.sha256), "invalid deployment pin");
  const bytes = readFileSync(pin.path); assert.equal(sha(bytes), pin.sha256, "weapon visual deployment input changed"); return bytes;
}
export function readWeaponVisualDeployment(manifestPath: string, previousFightPath: string, uploadDir: string) {
  const bytes = readFileSync(manifestPath), config = JSON.parse(bytes.toString("utf8")) as Deployment;
  assert.deepEqual(Object.keys(config).sort(), ["schemaVersion", "binding", "oldPackage", "newPackage", "originalJournal", "previousFightExtension", "fightExtension", "upgradeJournalPath", "receiptPath", "resources", ...(config.effects ? ["effects"] : [])].sort());
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
  let effects: EffectsDeployment | undefined;
  let officialEvidence: ReturnType<typeof readOfficialWeaponEvidence> | undefined;
  if (config.effects) {
    effects = JSON.parse(pinned(config.effects).toString("utf8")) as EffectsDeployment;
    assert.deepEqual(Object.keys(effects).sort(), ["schemaVersion", "selection", "visualJournal", "previousFightExtension", "upgradeJournalPath", "resources", "officialBallList", "officialBombConfig", "craterShapes", "audioVerification", "particleMode", ...(effects.particleVerification ? ["particleVerification"] : [])].sort());
    assert.equal(effects.schemaVersion, 1); assert.equal(effects.selection, "official-capture-v17.1.1");
    assert.ok(effects.particleMode === "official" || effects.particleMode === "retained");
    assert.equal(resolve(effects.visualJournal.path), resolve(config.upgradeJournalPath), "effects must retain the original visual ownership journal");
    assert.ok(isAbsolute(effects.upgradeJournalPath));
    for (const existing of [config.originalJournal.path, config.upgradeJournalPath, config.receiptPath]) assert.notEqual(resolve(effects.upgradeJournalPath).toLowerCase(), resolve(existing).toLowerCase());
    pinned(effects.visualJournal);
    assert.ok(effects.resources.every(row => ["audio", "client-crater", "client-crater-brink", "particle-definition", "particle-textures"].includes(row.kind)), "unknown effects resource kind");
    const basicResources = effects.resources.filter(row => !row.kind.startsWith("particle-"));
    assert.deepEqual(basicResources.map(row => row.kind).sort(), ["audio", "client-crater", "client-crater", "client-crater-brink", "client-crater-brink"].sort());
    for (const [kind, filename] of [["client-crater", "crater.png"], ["client-crater-brink", "craterbrink.png"]]) {
      assert.deepEqual(basicResources.filter(row => row.kind === kind).map(row => resolve(row.path)).sort(),
        [15601, 15602].map(id => resolve(root, "image/bomb/crater", String(id), filename!)).sort(), "official crater resources must be selected from the upload paths");
    }
    officialEvidence = readOfficialWeaponEvidence(pinned(effects.officialBallList).toString("utf8"), pinned(effects.officialBombConfig).toString("utf8"));
    const particles = effects.resources.filter(row => row.kind.startsWith("particle-"));
    if (effects.particleMode === "retained") { assert.equal(particles.length, 0); assert.equal(effects.particleVerification, undefined); }
    else {
      assert.equal(particles.filter(row => row.kind === "particle-definition").length, 1);
      assert.ok(particles.some(row => row.kind === "particle-textures"), "official emitters require their display resources");
      assert.ok(effects.particleVerification, "official emitters require a verified dependency closure");
      const proof = JSON.parse(pinned(effects.particleVerification).toString("utf8"));
      assert.equal(proof.schemaVersion, 1); assert.equal(proof.particleMode, "official");
      assert.equal(proof.allDependenciesPresent, true); assert.equal(proof.officialDefinitionsMatch, true); assert.equal(proof.officialTexturesMatch, true);
      assert.ok(Array.isArray(proof.rows), "official particle proof must identify its emitters");
      assert.deepEqual(proof.rows.map((row: { emitterId: number }) => row.emitterId).sort((a: number,b: number) => a-b),
        [...new Set(officialEvidence.Ball.map(row => Number(row.FlyingPartical)))].sort((a,b) => a-b), "official particle proof does not cover the selected emitters exactly");
      for (const row of proof.rows) {
        assert.equal(row.allDependenciesPresent, true); assert.equal(row.officialDefinitionsMatch, true); assert.equal(row.officialTexturesMatch, true);
      }
      const asPin = (row: Pin) => ({ path: resolve(row.path), sha256: row.sha256 });
      assert.deepEqual(asPin(proof.selectedDefinition), asPin(particles.find(row => row.kind === "particle-definition")!));
      assert.deepEqual(proof.selectedTextures.map(asPin).sort((a: Pin,b: Pin) => a.path.localeCompare(b.path)),
        particles.filter(row => row.kind === "particle-textures").map(asPin).sort((a,b) => a.path.localeCompare(b.path)));
    }
    for (const resource of effects.resources) pinned(resource);
    const audio = JSON.parse(pinned(effects.audioVerification).toString("utf8")), selectedAudio = basicResources.find(row => row.kind === "audio")!;
    assert.equal(audio.allSixMatch, true, "official Sound252-257 identity is not verified");
    assert.equal(audio.rows?.length, 6);
    assert.equal(resolve(audio.localAudio.path), resolve(selectedAudio.path));
    assert.equal(audio.localAudio.sha256, selectedAudio.sha256);
    const beforeFight = JSON.parse(pinned(effects.previousFightExtension).toString("utf8"));
    const afterFight = JSON.parse(pinned(config.fightExtension).toString("utf8"));
    const adjusted = weaponEffectsPackage(newConfig, officialEvidence, effects.particleMode), ids = adjusted.Ball.map(row => Number(row.ID));
    assert.equal(beforeFight.balls.filter((row: { id: number }) => ids.includes(row.id)).length, 4, "four owned fight balls are required");
    assert.ok(!beforeFight.shapes?.some((row: { ballId: number }) => ids.includes(row.ballId)), "prior visual package must preserve its old compatibility masks");
    const craterShapes = JSON.parse(pinned(effects.craterShapes).toString("utf8"));
    assert.ok(Array.isArray(craterShapes));
    assert.deepEqual(craterShapes.map((row: { ballId: number }) => row.ballId).sort((a: number,b: number) => a-b), [...ids].sort((a,b) => a-b));
    for (const row of craterShapes) {
      assert.deepEqual(Object.keys(row).sort(), ["ballId", "source", "fileBase64"].sort());
      assert.equal(row.source, "official-image-derived-local-mask");
      assert.ok(typeof row.fileBase64 === "string" && row.fileBase64.length > 0);
    }
    const expected = structuredClone(beforeFight);
    expected.balls = expected.balls.map((row: { id: number; shapeId: number; shapeSource: string; flyingPartical: string }) => {
      if (!ids.includes(row.id)) return row;
      assert.equal(row.shapeId, row.id === 156013 ? 171 : 161, "previous fight crater changed");
      assert.equal(row.shapeSource, "local-compat");
      const ball = adjusted.Ball.find(ball => ball.ID === row.id)!;
      const { shapeId: _shapeId, shapeSource: _shapeSource, ...withoutCompatibilityShape } = row;
      return { ...withoutCompatibilityShape, power: ball.Power, radii: ball.Radii, mass: ball.Mass,
        weight: ball.Weight, wind: ball.Wind, dragIndex: ball.DragIndex, amount: ball.Amount,
        delay: ball.Delay, hasTunnel: ball.HasTunnel, flyingPartical: ball.FlyingPartical };
    });
    expected.shapes = [...(expected.shapes ?? []), ...craterShapes];
    assert.deepEqual(afterFight, expected, "official fight package differs from captured values or verified masks");
  }
  return { config, oldConfig, newConfig, effects, officialEvidence, check: () => {
    assert.deepEqual(readFileSync(manifestPath), bytes, "visual deployment manifest changed");
    for (const pin of [config.oldPackage, config.newPackage, config.originalJournal, config.previousFightExtension, config.fightExtension]) pinned(pin);
    for (const row of config.resources) pinned({ path: join(root, row.resourcePath), sha256: row.sha256 });
    if (config.effects && effects) {
      pinned(config.effects); pinned(effects.visualJournal); pinned(effects.previousFightExtension);
      pinned(effects.officialBallList); pinned(effects.officialBombConfig); pinned(effects.craterShapes);
      pinned(effects.audioVerification);
      if (effects.particleVerification) pinned(effects.particleVerification);
      for (const resource of effects.resources) pinned(resource);
    }
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
    const result = deployment.effects ? await runWeaponEffectsUpgrade(h, { visualConfig: deployment.newConfig,
      visualJournalPath: deployment.effects.visualJournal.path, upgradeJournalPath: deployment.effects.upgradeJournalPath,
      officialEvidence: deployment.officialEvidence!, particleMode: deployment.effects.particleMode,
      binding: selected.binding, checkBinding: check }) : await runWeaponVisualUpgrade(h, { oldConfig: deployment.oldConfig, newConfig: deployment.newConfig,
      originalJournalPath: deployment.config.originalJournal.path, upgradeJournalPath: deployment.config.upgradeJournalPath,
      binding: selected.binding, checkBinding: check });
    check();
    // isNew/no-op still selects the new fight package: a prior process may have stopped after DB commit.
    const receipt = { ...result, databaseName: selected.binding.databaseName, fightExtension: deployment.config.fightExtension.path, originalAssetsVerified: 6,
      effectResourcesVerified: deployment.effects?.resources.length ?? 0, effectSelection: deployment.effects?.selection ?? null,
      checkedAt: new Date().toISOString(), fullGameAccepted: false };
    writeFileSync(deployment.config.receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    return receipt;
  } finally { await h.close(); }
}
