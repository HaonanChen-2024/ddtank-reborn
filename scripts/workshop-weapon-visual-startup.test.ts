import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { beforeEach, test, vi } from "vitest";
import { planWeaponInstall, type WeaponPackage } from "./workshop-weapon.js";
import { activateWeaponVisualStartup, readWeaponVisualDeployment, readWeaponVisualSession } from "./workshop-weapon-visual-startup.js";
import { readOfficialWeaponEvidence, weaponEffectsPackage } from "./workshop-weapon-effects.js";

const { createDbMock } = vi.hoisted(() => ({ createDbMock: vi.fn(() => { throw Error("unexpected database connection"); }) }));
vi.mock("../packages/db/src/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../packages/db/src/index.js")>(), createDb: createDbMock,
}));
beforeEach(() => { createDbMock.mockClear(); });
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seed = (name: string) => JSON.parse(gunzipSync(readFileSync(join(repo, "packages/db/seed/game", name + ".json.gz"))).toString("utf8")) as Record<string, unknown>[];
const sourceItem = seed("Shop_Goods").find(row => row.TemplateID === 7001)!;
const sourceBall = seed("Ball").find(row => row.ID === 106)!;
const branches = ["Common", "CommonAddWound", "CommonMultiBall", "Special"] as const;
const resourcePaths = ["image/bomb/blastout/blastout15601.swf", "image/bomb/blastout/blastout156011.swf",
  "image/bomb/blastout/blastout156012.swf", "image/bomb/blastout/blastout156013.swf",
  "image/bomb/bullet/bullet15601.swf", "image/bomb/bullet/bullet15602.swf"];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function packages() {
  const oldIds = [161, 1612, 1611, 171], newIds = [15601, 156012, 156011, 156013];
  const item = { ...sourceItem, TemplateID: 9107258, Name: "Isolated bubble-tea visual fixture",
    AddTime: sourceItem.AddTime === null ? null : new Date(String(sourceItem.AddTime) + "Z").toISOString() };
  const oldConfig: WeaponPackage = { schemaVersion: 2, mode: "local-compat", owner: "ddtank-workshop/weapon/bubble-tea-7258",
    metadata: { fixture: true, source: "complete seed rows, isolated startup test" }, Shop_Goods: item,
    BallConfig: { TemplateID: 9107258, ...Object.fromEntries(branches.map((key, index) => [key, oldIds[index]])) },
    Ball: [], BallReferences: oldIds.map(ID => ({ ...sourceBall, ID })) };
  const newConfig: WeaponPackage = { schemaVersion: 1, mode: "local-compat", owner: oldConfig.owner,
    metadata: { fixture: true, source: "explicit visual clones, no inferred physics" }, Shop_Goods: { ...item },
    BallConfig: { TemplateID: 9107258, ...Object.fromEntries(branches.map((key, index) => [key, newIds[index]])) },
    Ball: newIds.map((ID, index) => ({ ...oldConfig.BallReferences![index], ID, Name: "isolated-" + ID, BombPartical: index === 3 ? "15602" : "15601" })) };
  planWeaponInstall(oldConfig); planWeaponInstall(newConfig);
  return { oldConfig, newConfig };
}
function fixture(t: { onTestFinished: (fn: () => void) => void }, databaseName = "ddtank") {
  const path = mkdtempSync(join(tmpdir(), "ddt-visual-startup-"));
  assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir()));
  t.onTestFinished(() => { assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir())); rmSync(path, { recursive: true, force: true }); });
  const runtime = join(path, "runtime"), uploadDir = join(path, "upload");
  mkdirSync(join(runtime, "data/postgres"), { recursive: true }); mkdirSync(uploadDir);
  const expected: { runId: string; managerPid: number; databaseName: string } = { runId: randomUUID(), managerPid: process.pid, databaseName };
  const binding = { databaseName: "ddtank", dataDirectory: realpathSync(join(runtime, "data/postgres")) };
  const { oldConfig, newConfig } = packages();
  const put = (name: string, data: unknown) => { const file = join(path, name); writeFileSync(file, JSON.stringify(data, null, 2) + "\n"); return { path: file, sha256: sha(readFileSync(file)) }; };
  const oldPackage = put("old.json", oldConfig), newPackage = put("new.json", newConfig);
  const originalJournal = put("original.json", { schemaVersion: 1, phase: "prepared", binding,
    packageSha256: planWeaponInstall(oldConfig).packageSha256, package: oldConfig });
  const previousFightExtension = put("previous-fight.json", { fixture: "old fight bytes" });
  const fightExtension = put("new-fight.json", { fixture: "new fight bytes" });
  const resources = resourcePaths.map((resourcePath, index) => {
    const file = join(uploadDir, resourcePath); mkdirSync(dirname(file), { recursive: true });
    // Hash checking is independent of SWF decoding; the owner never loads these bytes as a movie.
    writeFileSync(file, Buffer.from("isolated-resource-" + index)); return { resourcePath, sha256: sha(readFileSync(file)) };
  });
  const manifest = { schemaVersion: 1, binding, oldPackage, newPackage, originalJournal, previousFightExtension, fightExtension,
    upgradeJournalPath: join(path, "upgrade.json"), receiptPath: join(path, "receipt.json"), resources };
  const manifestPath = put("deployment.json", manifest).path;
  const sessionPath = join(runtime, "workshop-session.json"), readyPath = join(runtime, "postgres-ready.json");
  const session = { ...expected, publicHost: "192.168.1.23", ports: { db: 55432 }, children: [{ name: "db", pid: process.pid }] };
  const ready = { pid: process.pid, port: 55432, databaseName };
  writeFileSync(sessionPath, JSON.stringify(session)); writeFileSync(readyPath, JSON.stringify(ready));
  const saveManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const readDeployment = (previousFightPath = previousFightExtension.path) => readWeaponVisualDeployment(manifestPath, previousFightPath, uploadDir);
  const readSession = (extra: Partial<typeof expected> = {}) => readWeaponVisualSession(runtime, { ...expected, ...extra });
  const activate = () => activateWeaponVisualStartup({ manifestPath, previousFightPath: previousFightExtension.path, uploadDir, runtime, ...expected });
  return { path, runtime, uploadDir, expected, binding, oldConfig, newConfig, manifest, manifestPath, session, ready,
    sessionPath, readyPath, saveManifest, readDeployment, readSession, activate };
}

test("complete seed packages and six exact resource targets are accepted without writes or database access", t => {
  const f = fixture(t), manifestBytes = readFileSync(f.manifestPath), originalBytes = readFileSync(f.manifest.originalJournal.path);
  const result = f.readDeployment(); assert.deepEqual(result.oldConfig, f.oldConfig); assert.deepEqual(result.newConfig, f.newConfig);
  assert.deepEqual(result.config.binding, f.binding); assert.equal(result.config.resources.length, 6); result.check();
  assert.deepEqual(readFileSync(f.manifestPath), manifestBytes); assert.deepEqual(readFileSync(f.manifest.originalJournal.path), originalBytes);
  assert.equal(existsSync(f.manifest.upgradeJournalPath), false); assert.equal(existsSync(f.manifest.receiptPath), false);
  assert.equal(createDbMock.mock.calls.length, 0);
});

function effectsFixture(t: { onTestFinished: (fn: () => void) => void }) {
  const f = fixture(t), put = (name: string, value: unknown) => {
    const path = join(f.path, name); writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
    return { path, sha256: sha(readFileSync(path)) };
  };
  const visualJournal = put("upgrade.json", { fixture: "owned visual journal, validated by the transaction owner" });
  const xml = '<Result value="true" message="Success!">' + [15601, 156011, 156012, 156013].map(ID => `<Item ID="${ID}" Power="${ID === 156013 ? '0.65' : '1.0'}" Radii="${ID === 156013 ? 65 : 60}" FlyingPartical="${ID === 156013 ? 498 : 518}" BombPartical="${ID === 156013 ? 15602 : 15601}" Crater="${ID === 156013 ? 15602 : 15601}" AttackResponse="0" IsSpin="false" SpinV="0" SpinVA="0.0" Amount="${ID === 156013 ? 3 : 1}" Wind="240" DragIndex="1" Weight="70" Shake="true" ShootSound="${ID === 15601 ? 254 : ID === 156011 ? 255 : ID === 156012 ? 256 : 257}" BombSound="${ID === 156013 ? 253 : 252}" ActionType="0" Mass="10" BombType="0"/>`).join('') + '</Result>';
  const bombXml = '<Result value="true" message="Success!"><Item TemplateID="7258" Common="15601" CommonAddWound="156012" CommonMultiBall="156011" Special="156013"/></Result>';
  const rawPin = (name: string, value: string) => { const path = join(f.path, name); writeFileSync(path,value); return {path,sha256:sha(readFileSync(path))}; };
  const evidence = readOfficialWeaponEvidence(xml, bombXml);
  for (const row of f.newConfig.Ball) {
    const official = evidence.Ball.find(value => Number(value.ID) === row.ID)!;
    for (const [key,value] of Object.entries(official)) if (key in row) row[key] = typeof row[key] === 'boolean' ? value === 'true' : typeof row[key] === 'number' ? Number(value) : value;
    Object.assign(row,{Power:row.ID === 156013 ? 0.6 : 1,Radii:row.ID === 156013 ? 45 : 55,Crater:row.ID === 156013 ? '171' : '161',FlyingPartical:row.ID === 156013 ? '8' : row.ID === 156012 ? '118' : '7',ShootSound:row.ID === 156013 ? '083' : '025',BombSound:row.ID === 156013 ? '088' : '087'});
  }
  f.manifest.newPackage = put('new.json',f.newConfig);
  const before = { schemaVersion: 1, source: "local-compat", items: [], ballConfigs: [], balls: f.newConfig.Ball.map(row => ({
    id: row.ID, power: row.Power, radii: row.Radii, mass:row.Mass, weight:row.Weight, wind:row.Wind,dragIndex:row.DragIndex,amount:row.Amount,delay:row.Delay,hasTunnel:row.HasTunnel,flyingPartical: row.FlyingPartical, shapeSource: "local-compat", shapeId: row.ID === 156013 ? 171 : 161,
  })) };
  const adjusted = weaponEffectsPackage(f.newConfig,evidence,'retained');
  const shapes = f.newConfig.Ball.map(row=>({ballId:row.ID,source:'official-image-derived-local-mask',fileBase64:Buffer.from([1,0,0,0,1,0,0,0,1]).toString('base64')}));
  const after = { ...before, balls: before.balls.map(({shapeId:_id,shapeSource:_source,...row}) => ({ ...row, power:adjusted.Ball.find(ball=>ball.ID===row.id)!.Power,radii:adjusted.Ball.find(ball=>ball.ID===row.id)!.Radii })),shapes };
  const resources = [{...put('audio.json',{fixture:'audio'}),kind:'audio'}];
  for (const id of [15601,15602]) for(const [kind,name] of [['client-crater','crater.png'],['client-crater-brink','craterbrink.png']]) {
    const path=join(f.uploadDir,'image/bomb/crater',String(id),name!);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,Buffer.from(`isolated-${id}-${name}`));resources.push({path,sha256:sha(readFileSync(path)),kind:kind!});
  }
  const effects = { schemaVersion: 1, selection: "official-capture-v17.1.1", visualJournal,
    officialBallList:rawPin('BallList.xml',xml),officialBombConfig:rawPin('BombConfig.xml',bombXml),craterShapes:put('shapes.json',shapes),particleMode:'retained',
    audioVerification:put('audio-verification.json',{allSixMatch:true,rows:Array.from({length:6},(_,i)=>({soundId:252+i})),localAudio:resources[0]}),
    previousFightExtension: put("effects-before-fight.json", before), upgradeJournalPath: join(f.path, "effects-upgrade.json"), resources };
  const effectsPin = put("effects.json", effects);
  const manifest = { ...f.manifest, effects: effectsPin, fightExtension: put("effects-after-fight.json", after) };
  const save = () => writeFileSync(f.manifestPath, JSON.stringify(manifest)); save();
  const changeEffects = (fn: (value: typeof effects) => void) => { fn(effects); manifest.effects = put("effects.json", effects); save(); };
  return { ...f, effects, manifest, before, after, save, put, changeEffects };
}

test("official capture accepts matching numeric/mask changes, retains fallback trails and pins all inputs", t => {
  const f = effectsFixture(t), selected = f.readDeployment();
  assert.equal(selected.effects?.selection, "official-capture-v17.1.1"); selected.check();
  assert.equal(selected.effects?.particleMode, "retained");
  assert.equal(createDbMock.mock.calls.length, 0);
  for (const resource of [...f.effects.resources,f.effects.officialBallList,f.effects.officialBombConfig,f.effects.craterShapes,f.effects.audioVerification]) {
    const bytes = readFileSync(resource.path); writeFileSync(resource.path, Buffer.concat([bytes, Buffer.from("changed")]));
    assert.throws(selected.check, /input changed/); writeFileSync(resource.path, bytes);
  }
  const journalBytes = readFileSync(f.effects.visualJournal.path);
  writeFileSync(f.effects.visualJournal.path, "changed"); assert.throws(selected.check, /input changed/);
  writeFileSync(f.effects.visualJournal.path, journalBytes); selected.check();
});

test("official capture rejects unrelated fight physics, missing resources and journal aliasing before database access", t => {
  const f = effectsFixture(t), correct = structuredClone(f.after);
  f.after.balls[0].power = 999; f.manifest.fightExtension = f.put("effects-after-fight.json", f.after); f.save();
  assert.throws(f.readDeployment, /differs from captured values/);
  f.manifest.fightExtension = f.put("effects-after-fight.json", correct); f.save();
  const resources = [...f.effects.resources]; f.changeEffects(value => { value.resources.pop(); });
  assert.throws(f.readDeployment);
  f.changeEffects(value => { value.resources = resources; value.upgradeJournalPath = value.visualJournal.path; });
  assert.throws(f.readDeployment);
  assert.equal(createDbMock.mock.calls.length, 0);
});

test("official emitter selection requires definitions and display resources before database access", t => {
  const f = effectsFixture(t);
  f.changeEffects(value => { value.particleMode = 'official'; });
  assert.throws(f.readDeployment);
  f.changeEffects(value => { value.particleMode = 'retained'; value.resources.push({...value.resources[0],kind:'particle-unknown'}); });
  assert.throws(f.readDeployment,/unknown effects resource kind/);
  assert.equal(createDbMock.mock.calls.length,0);
});

test("missing official audio identity refuses startup even when local sounds exist", t => {
  const f=effectsFixture(t);
  f.changeEffects(value=>{value.audioVerification=f.put('audio-unverified.json',{allSixMatch:false,rows:[],localAudio:value.resources[0]});});
  assert.throws(f.readDeployment,/Sound252-257 identity is not verified/);
  assert.equal(createDbMock.mock.calls.length,0);
});

test("verified official emitters select captured IDs only with the matching dependency proof", t => {
  const f=effectsFixture(t), definition=f.put('partical.json',{fixture:'same official emitters'}),textures=f.put('shape.json',{fixture:'same official display closure'});
  const proof=f.put('particle-proof.json',{allDependenciesPresent:true,officialDefinitionsMatch:true,officialTexturesMatch:true,selectedDefinition:definition,selectedTextures:[textures]});
  f.changeEffects(value=>{value.particleMode='official';value.resources.push({...definition,kind:'particle-definition'},{...textures,kind:'particle-textures'});Object.assign(value,{particleVerification:proof});});
  for(const row of f.after.balls)row.flyingPartical=row.id===156013?'498':'518';
  f.manifest.fightExtension=f.put('effects-after-fight.json',f.after);f.save();
  f.readDeployment().check();
  const proofData=JSON.parse(readFileSync(proof.path,'utf8'));proofData.officialTexturesMatch=false;
  f.changeEffects(value=>{Object.assign(value,{particleVerification:f.put('particle-proof.json',proofData)});});
  assert.throws(f.readDeployment);
  assert.equal(createDbMock.mock.calls.length,0);
});

test("missing, duplicate or unexpected visual targets are rejected", t => {
  const f = fixture(t), original = structuredClone(f.manifest.resources);
  for (const resources of [original.slice(1), [...original.slice(1), original[1]],
    [...original, { resourcePath: "image/bomb/bullet/bullet15603.swf", sha256: "0".repeat(64) }]]) {
    f.manifest.resources = resources; f.saveManifest(); assert.throws(f.readDeployment, /incomplete original visual resources/);
  }
});

test("every resource hash is enforced during initial read and subsequent check", t => {
  const f = fixture(t), selected = f.readDeployment();
  for (const resource of f.manifest.resources) {
    const path = join(f.uploadDir, resource.resourcePath), bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from("tampered")]));
    assert.throws(f.readDeployment, /input changed/); assert.throws(selected.check, /input changed/);
    writeFileSync(path, bytes);
  }
  selected.check();
});

test("package, previous/new FIGHT and original ownership journal pins reject drift", t => {
  const f = fixture(t), selected = f.readDeployment();
  for (const pin of [f.manifest.oldPackage, f.manifest.newPackage, f.manifest.originalJournal,
    f.manifest.previousFightExtension, f.manifest.fightExtension]) {
    const bytes = readFileSync(pin.path); writeFileSync(pin.path, Buffer.concat([bytes, Buffer.from(" ")]));
    assert.throws(f.readDeployment, /input changed/); assert.throws(selected.check, /input changed/); writeFileSync(pin.path, bytes);
  }
  const other = join(f.path, "same-bytes-other-fight.json"); writeFileSync(other, readFileSync(f.manifest.previousFightExtension.path));
  assert.throws(() => f.readDeployment(other), /existing fight extension differs/); selected.check();
});

test("manifest byte changes are rejected and malformed/foreign manifests cannot be adopted", t => {
  const f = fixture(t), selected = f.readDeployment(), bytes = readFileSync(f.manifestPath);
  writeFileSync(f.manifestPath, Buffer.concat([bytes, Buffer.from(" ")]));
  assert.throws(selected.check, /manifest changed/); writeFileSync(f.manifestPath, bytes);
  for (const change of [
    (value: Record<string, unknown>) => { value.schemaVersion = 2; },
    (value: Record<string, unknown>) => { value.unknown = true; },
    (value: Record<string, unknown>) => { (value.binding as { databaseName: string }).databaseName = "ddtank_restored"; },
    (value: Record<string, unknown>) => { (value.oldPackage as { sha256: string }).sha256 = "bad"; },
  ]) { const value = structuredClone(f.manifest); change(value); writeFileSync(f.manifestPath, JSON.stringify(value)); assert.throws(f.readDeployment); }
  writeFileSync(f.manifestPath, bytes); selected.check();
});

test("LAN session is retained while run/manager/database/ready identity mismatches are refused", t => {
  const f = fixture(t), selected = f.readSession(); assert.deepEqual(selected.binding, f.binding); selected.check();
  assert.equal(f.session.publicHost, "192.168.1.23");
  for (const extra of [{ runId: "another-run" }, { managerPid: process.pid + 1 }, { databaseName: "other-database" }]) assert.throws(() => f.readSession(extra));
  const sessionBytes = readFileSync(f.sessionPath), readyBytes = readFileSync(f.readyPath);
  for (const ready of [{ ...f.ready, pid: process.pid + 1 }, { ...f.ready, port: 5432 }, { ...f.ready, databaseName: "other" }]) {
    writeFileSync(f.readyPath, JSON.stringify(ready)); assert.throws(() => f.readSession());
  }
  writeFileSync(f.readyPath, readyBytes);
  writeFileSync(f.sessionPath, JSON.stringify({ ...f.session, children: [...f.session.children, ...f.session.children] }));
  assert.throws(() => f.readSession()); writeFileSync(f.sessionPath, sessionBytes); selected.check();
});

test("session or ready byte drift refuses a previously selected live process identity", t => {
  const f = fixture(t), selected = f.readSession();
  const sessionBytes = readFileSync(f.sessionPath), readyBytes = readFileSync(f.readyPath);
  writeFileSync(f.sessionPath, Buffer.concat([sessionBytes, Buffer.from(" ")]));
  assert.throws(selected.check, /startup session changed/); writeFileSync(f.sessionPath, sessionBytes);
  writeFileSync(f.readyPath, Buffer.concat([readyBytes, Buffer.from(" ")]));
  assert.throws(selected.check, /database restarted/); writeFileSync(f.readyPath, readyBytes); selected.check();
});

test("zero manager or DB PID cannot use process-group liveness as owned-process proof", t => {
  const f = fixture(t), sessionBytes = readFileSync(f.sessionPath), readyBytes = readFileSync(f.readyPath);
  writeFileSync(f.sessionPath, JSON.stringify({ ...f.session, children: [{ name: "db", pid: 0 }] }));
  writeFileSync(f.readyPath, JSON.stringify({ ...f.ready, pid: 0 }));
  assert.throws(() => f.readSession());
  writeFileSync(f.readyPath, readyBytes); writeFileSync(f.sessionPath, JSON.stringify({ ...f.session, managerPid: 0 }));
  assert.throws(() => f.readSession({ managerPid: 0 }));
  writeFileSync(f.sessionPath, sessionBytes); f.readSession().check();
});

test("restored database binding mismatch rejects before URL parsing or createDb", async t => {
  const f = fixture(t, "ddtank_restored_isolated"), sessionBytes = readFileSync(f.sessionPath), manifestBytes = readFileSync(f.manifestPath);
  const previousUrl = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  try { await assert.rejects(f.activate(), /no ownership for this selected database/); }
  finally { if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl; }
  assert.equal(createDbMock.mock.calls.length, 0); assert.deepEqual(readFileSync(f.sessionPath), sessionBytes);
  assert.deepEqual(readFileSync(f.manifestPath), manifestBytes); assert.equal(existsSync(f.manifest.upgradeJournalPath), false);
  assert.equal(existsSync(f.manifest.receiptPath), false);
});

test("same-name database with another physical data directory also refuses before createDb", async t => {
  const f = fixture(t); const otherData = join(f.path, "another-data"); mkdirSync(otherData);
  f.manifest.binding.dataDirectory = realpathSync(otherData); f.saveManifest();
  await assert.rejects(f.activate(), /no ownership for this selected database/);
  assert.equal(createDbMock.mock.calls.length, 0); assert.equal(existsSync(f.manifest.upgradeJournalPath), false);
});
