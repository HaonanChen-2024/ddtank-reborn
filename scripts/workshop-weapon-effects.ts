// Apply captured official parameters to four already owned bubble-tea Ball rows.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DbHandle } from "../packages/db/src/index.js";
import { q } from "../apps/api/src/lib/db.js";
import { planWeaponInstall, type WeaponPackage } from "./workshop-weapon.js";
import { smithEnabledWeapon } from "./workshop-weapon-smith.js";
import type { StarterBinding } from "./workshop-starter-activity.js";

const { sql } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
type Row = Record<string, unknown>;
const templateId = 9107258;
const owner = "ddtank-workshop/weapon/bubble-tea-7258";
const bindingRows = { TemplateID: templateId, Common: 15601, CommonAddWound: 156012, CommonMultiBall: 156011, Special: 156013 };
const selection = "official-capture-v17.1.1" as const;
const mutableFields = ["Crater", "FlyingPartical", "ShootSound", "BombSound", "Power", "Radii"] as const;
const officialFields = ["ID", "Power", "Radii", "FlyingPartical", "BombPartical", "Crater", "AttackResponse", "IsSpin",
  "SpinV", "SpinVA", "Amount", "Wind", "DragIndex", "Weight", "Shake", "ShootSound", "BombSound", "ActionType", "Mass", "BombType"];
export type ParticleMode = "official" | "retained";
export type OfficialWeaponEvidence = {
  selection: typeof selection; ballListSha256: string; bombConfigSha256: string;
  Ball: Record<string, string>[]; BombConfig: Record<string, string>;
};

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
}
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

// The captured responses have a flat Result/Item grammar. Reject unsupported XML constructs rather than repairing them.
function readItems(xml: string): Record<string, string>[] {
  const root = xml.match(/^\s*(?:<\?xml version="1\.0" encoding="UTF-8"\?>\s*)?<Result value="true" message="Success!">([\s\S]*)<\/Result>\s*$/);
  assert.ok(root, "official XML must be a successful flat Result response");
  const rows: Record<string, string>[] = [];
  const rest = root[1].replace(/<Item\s+([^<>]*)\/>/g, (_tag, source: string) => {
    const row: Record<string, string> = {}, attrs = source.replace(/(?:^|\s+)([A-Za-z][A-Za-z0-9]*)="([^"<>&]*)"/g,
      (_attr, key: string, value: string) => { assert.ok(!Object.hasOwn(row, key), "duplicate official XML attribute"); row[key] = value; return ""; });
    assert.equal(attrs.trim(), "", "unsupported official XML attribute syntax"); rows.push(row); return "";
  });
  assert.equal(rest.trim(), "", "unsupported official XML structure");
  return rows;
}

function validateEvidence(evidence: OfficialWeaponEvidence): void {
  assert.ok(evidence && typeof evidence === "object");
  assert.deepEqual(Object.keys(evidence).sort(), ["selection", "ballListSha256", "bombConfigSha256", "Ball", "BombConfig"].sort());
  assert.equal(evidence.selection, selection);
  for (const hash of [evidence.ballListSha256, evidence.bombConfigSha256]) assert.match(hash, /^[a-f0-9]{64}$/);
  const expected = Object.fromEntries(Object.entries({ ...bindingRows, TemplateID: 7258 }).map(([key, value]) => [key, String(value)]));
  assert.equal(canonical(evidence.BombConfig), canonical(expected), "official 7258 mapping differs");
  assert.ok(Array.isArray(evidence.Ball) && evidence.Ball.length === 4, "four official Ball rows required");
  assert.deepEqual(evidence.Ball.map(row => row.ID).sort(), ["15601", "156011", "156012", "156013"]);
  for (const row of evidence.Ball) {
    assert.deepEqual(Object.keys(row).sort(), [...officialFields].sort(), "official Ball fields differ");
    assert.ok(Object.values(row).every(value => typeof value === "string"), "official XML attributes must remain strings");
    assert.equal(row.BombType, "0", "unsupported official-only BombType");
  }
}

/** Parse original XML without discarding its raw attribute values or whole-file fingerprints. */
export function readOfficialWeaponEvidence(ballListXml: string, bombConfigXml: string): OfficialWeaponEvidence {
  const balls = readItems(ballListXml).filter(row => ["15601", "156011", "156012", "156013"].includes(row.ID));
  const configs = readItems(bombConfigXml).filter(row => row.TemplateID === "7258");
  assert.equal(configs.length, 1, "one official 7258 BombConfig required");
  const evidence: OfficialWeaponEvidence = { selection, ballListSha256: sha(Buffer.from(ballListXml)),
    bombConfigSha256: sha(Buffer.from(bombConfigXml)), Ball: balls.sort((a, b) => Number(a.ID) - Number(b.ID)), BombConfig: configs[0] };
  validateEvidence(evidence); return evidence;
}

function typedAttribute(value: string, local: unknown, key: string): unknown {
  if (typeof local === "boolean") { assert.ok(value === "true" || value === "false", "invalid official boolean: " + key); return value === "true"; }
  if (typeof local === "number") {
    assert.match(value, /^-?\d+(?:\.\d+)?$/, "invalid official number: " + key);
    const parsed = Number(value); assert.ok(Number.isFinite(parsed), "nonfinite official number"); return parsed;
  }
  assert.equal(typeof local, "string", "unsupported official/local field type: " + key); return value;
}

/** Only the six proven differing columns may change. Unsupported official fields and local-only columns are preserved. */
export function weaponEffectsPackage(visualConfig: unknown, officialEvidence: OfficialWeaponEvidence, particleMode: ParticleMode): WeaponPackage {
  validateEvidence(officialEvidence);
  assert.ok(particleMode === "official" || particleMode === "retained", "explicit particle mode required");
  const before = planWeaponInstall(visualConfig).config;
  assert.equal(before.schemaVersion, 1, "effects require the completed owned visual package");
  assert.equal(before.owner, owner, "effects only support the owned bubble-tea weapon");
  assert.equal(canonical(before.BallConfig), canonical(bindingRows), "effects require the complete fixed four-branch BallConfig");
  assert.equal(before.Ball.length, 4, "effects require four owned Ball rows");
  const balls = before.Ball.map(ball => {
    const raw = officialEvidence.Ball.find(row => row.ID === String(ball.ID))!, after = { ...ball };
    for (const [key, rawValue] of Object.entries(raw)) {
      if (key === "BombType") continue; // The 4.1 table has no corresponding column; only official zero is accepted.
      assert.ok(Object.hasOwn(ball, key), "official field has no local counterpart: " + key);
      const value = typedAttribute(rawValue, ball[key], key);
      if ((mutableFields as readonly string[]).includes(key)) {
        if (key !== "FlyingPartical" || particleMode === "official") after[key] = value;
      } else assert.equal(value, ball[key], "unapproved official difference: " + key);
    }
    return after;
  });
  return planWeaponInstall({ ...before, Ball: balls }).config;
}

/** Validate all fields against the captured official transform and the explicit particle decision. */
export function validateWeaponEffectsPackage(visualConfig: unknown, effectsConfig: unknown,
  officialEvidence: OfficialWeaponEvidence, particleMode: ParticleMode): WeaponPackage {
  const expected = weaponEffectsPackage(visualConfig, officialEvidence, particleMode), actual = planWeaponInstall(effectsConfig).config;
  assert.equal(canonical(actual), canonical(expected), "effects package differs from official evidence; all other fields must be preserved");
  return actual;
}

function publish(path: string, intent: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx", 0o600); let written = false;
  try { writeFileSync(fd, JSON.stringify(intent, null, 2) + "\n"); fsyncSync(fd); written = true; }
  finally { closeSync(fd); if (!written) unlinkSync(path); }
}

export async function runWeaponEffectsUpgrade(h: DbHandle, options: {
  visualConfig: unknown; visualJournalPath: string; upgradeJournalPath: string;
  officialEvidence: OfficialWeaponEvidence; particleMode: ParticleMode;
  binding: StarterBinding; checkBinding?: () => void;
}) {
  const evidence = structuredClone(options.officialEvidence), evidenceSha256 = sha(Buffer.from(canonical(evidence))), particleMode = options.particleMode;
  const beforePlan = planWeaponInstall(options.visualConfig), afterPlan = planWeaponInstall(weaponEffectsPackage(beforePlan.config, evidence, particleMode));
  const before = beforePlan.config, after = afterPlan.config, ids = beforePlan.ballIds;
  assert.notEqual(beforePlan.packageSha256, afterPlan.packageSha256, "visual package must describe the pre-effects state");
  assert.ok(options.binding && typeof options.binding.databaseName === "string" && options.binding.databaseName.length > 0 &&
    typeof options.binding.dataDirectory === "string" && options.binding.dataDirectory.length > 0, "database binding is required");
  const binding = { databaseName: options.binding.databaseName, dataDirectory: options.binding.dataDirectory };
  assert.equal(canonical(binding), canonical(options.binding), "unknown database binding fields");
  const visualPath = resolve(options.visualJournalPath), upgradePath = resolve(options.upgradeJournalPath);
  assert.notEqual(visualPath.toLowerCase(), upgradePath.toLowerCase(), "visual and effects journals must be separate");
  let journalPublished = false;
  const result = await h.db.transaction(async tx => {
    const th = { ...h, db: tx };
    options.checkBinding?.();
    await tx.execute(sql`LOCK TABLE game."Shop_Goods", game."BallConfig", game."Ball" IN SHARE ROW EXCLUSIVE MODE`);
    const visualBytes = readFileSync(visualPath), visual = JSON.parse(visualBytes.toString("utf8"));
    assert.equal(visual.schemaVersion, 1); assert.equal(visual.phase, "prepared", "unknown visual journal phase");
    assert.equal(visual.owner, owner); assert.equal(visual.templateId, templateId);
    assert.equal(canonical(visual.binding), canonical(binding), "visual journal belongs to a different database");
    assert.equal(visual.newPackageSha256, beforePlan.packageSha256, "visual journal new package hash differs");
    assert.equal(planWeaponInstall(visual.newPackage).packageSha256, beforePlan.packageSha256, "visual journal new package differs");
    const sharedPlan = planWeaponInstall(visual.oldPackage), shared = sharedPlan.config.BallReferences;
    assert.equal(sharedPlan.packageSha256, visual.oldPackageSha256, "visual journal old package hash differs");
    assert.equal(sharedPlan.owner, owner); assert.equal(sharedPlan.templateId, templateId); assert.equal(sharedPlan.schemaVersion, 2);
    assert.equal(sharedPlan.config.Ball.length, 0); assert.equal(shared?.length, 4, "visual journal must preserve four old shared Ball rows");
    const sharedIds = sharedPlan.referencedBallIds!;
    assert.ok(sharedIds.every(id => !ids.includes(id)), "old shared Ball IDs must remain independent");
    const intent = { schemaVersion: 1, phase: "prepared", selection, particleMode, officialEvidenceSha256: evidenceSha256,
      officialEvidence: evidence, owner, templateId, binding,
      visualJournal: { path: visualPath, sha256: sha(visualBytes), packageSha256: beforePlan.packageSha256 },
      oldPackageSha256: beforePlan.packageSha256, newPackageSha256: afterPlan.packageSha256, oldPackage: before, newPackage: after };
    let upgradeBytes = existsSync(upgradePath) ? readFileSync(upgradePath) : null;
    if (upgradeBytes) assert.equal(canonical(JSON.parse(upgradeBytes.toString("utf8"))), canonical(intent), "effects ownership journal differs");
    const checkFiles = () => {
      assert.equal(sha(readFileSync(visualPath)), intent.visualJournal.sha256, "visual journal changed during effects upgrade");
      if (upgradeBytes) assert.equal(sha(readFileSync(upgradePath)), sha(upgradeBytes), "effects journal changed during upgrade");
    };
    const idList = sql.join(ids.map(id => sql`${id}`), sql`,`);
    const readState = async () => ({
      items: await q<Row>(th, sql`SELECT * FROM game."Shop_Goods" WHERE "TemplateID"=${templateId}`),
      configs: await q<Row>(th, sql`SELECT * FROM game."BallConfig" WHERE "TemplateID"=${templateId}`),
      balls: await q<Row>(th, sql`SELECT * FROM game."Ball" WHERE "ID" IN (${idList}) ORDER BY "ID"`),
      sharedBalls: await q<Row>(th, sql`SELECT * FROM game."Ball" WHERE "ID" IN (${sql.join(sharedIds.map(id => sql`${id}`), sql`,`)}) ORDER BY "ID"`),
      references: await q<Row>(th, sql`SELECT "TemplateID" FROM game."BallConfig" WHERE "Common" IN (${idList}) OR
        "CommonAddWound" IN (${idList}) OR "CommonMultiBall" IN (${idList}) OR "Special" IN (${idList}) ORDER BY "TemplateID"`),
    });
    const checkPreserved = (state: Awaited<ReturnType<typeof readState>>) => {
      assert.ok(canonical(state.items) === canonical([before.Shop_Goods]) ||
        canonical(state.items) === canonical([smithEnabledWeapon(before.Shop_Goods)]), "owned Shop_Goods missing or changed; preserved");
      assert.equal(canonical(state.configs), canonical([before.BallConfig]), "owned BallConfig missing or changed; preserved");
      assert.equal(canonical(state.sharedBalls), canonical(shared), "old shared Ball rows missing or changed; preserved");
      assert.equal(canonical(state.references), canonical([{ TemplateID: templateId }]), "owned Ball rows are shared or unreferenced; preserved");
    };
    const initial = await readState(); checkPreserved(initial);
    const isOld = canonical(initial.balls) === canonical(before.Ball), isNew = canonical(initial.balls) === canonical(after.Ball);
    assert.ok(isOld || isNew, "effects state is partial, mixed or changed; preserved");
    if (isNew) {
      assert.ok(upgradeBytes, "new effects state has no effects ownership journal");
      options.checkBinding?.(); checkFiles();
      return { status: "unchanged" as const, updated: { Ball: 0 } };
    }
    if (!upgradeBytes) {
      publish(upgradePath, intent); journalPublished = true; upgradeBytes = readFileSync(upgradePath);
      assert.equal(canonical(JSON.parse(upgradeBytes.toString("utf8"))), canonical(intent), "published effects journal differs");
    }
    // Intent is durable before any UPDATE. A rollback can only retry from the complete old state.
    options.checkBinding?.(); checkFiles();
    for (const ball of after.Ball) {
      const updated = await q<Row>(th, sql`UPDATE game."Ball" SET "Crater"=${ball.Crater}, "FlyingPartical"=${ball.FlyingPartical},
        "ShootSound"=${ball.ShootSound}, "BombSound"=${ball.BombSound}, "Power"=${ball.Power}, "Radii"=${ball.Radii} WHERE "ID"=${ball.ID} RETURNING *`);
      assert.equal(canonical(updated), canonical([ball]), "updated Ball row differs");
    }
    const installed = await readState(); checkPreserved(installed);
    assert.equal(canonical(installed.items), canonical(initial.items), "Shop_Goods changed during effects upgrade");
    assert.equal(canonical(installed.balls), canonical(after.Ball), "updated effects Ball rows differ");
    options.checkBinding?.(); checkFiles();
    return { status: "upgraded" as const, updated: { Ball: 4 } };
  });
  return { ...result, templateId, selection, particleMode, officialEvidenceSha256: evidenceSha256, oldPackageSha256: beforePlan.packageSha256,
    newPackageSha256: afterPlan.packageSha256, ballIds: ids, journalPublished, visualJournalPreserved: true,
    originalRowsPreserved: true, playerDataWritten: false, resourcesWritten: false, cacheReloadRequired: result.status === "upgraded",
    fightReloadRequired: result.status === "upgraded", clientAccepted: false };
}
