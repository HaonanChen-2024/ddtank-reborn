// Upgrade the already owned bubble-tea weapon's four visual bindings. No item, physics or shared-row edits.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { game, type DbHandle } from "../packages/db/src/index.js";
import { q } from "../apps/api/src/lib/db.js";
import { planWeaponInstall } from "./workshop-weapon.js";
import { smithEnabledWeapon } from "./workshop-weapon-smith.js";
import type { StarterBinding } from "./workshop-starter-activity.js";

const { sql } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
const branches = ["Common", "CommonAddWound", "CommonMultiBall", "Special"] as const;
type Row = Record<string, unknown>;
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
}
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function publish(path: string, journal: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx", 0o600); let written = false;
  try { writeFileSync(fd, JSON.stringify(journal, null, 2) + "\n"); fsyncSync(fd); written = true; }
  finally { closeSync(fd); if (!written) unlinkSync(path); }
}

export async function runWeaponVisualUpgrade(h: DbHandle, options: {
  oldConfig: unknown; newConfig: unknown; originalJournalPath: string; upgradeJournalPath: string;
  binding: StarterBinding; checkBinding?: () => void;
}) {
  const oldPlan = planWeaponInstall(options.oldConfig), newPlan = planWeaponInstall(options.newConfig);
  const before = oldPlan.config, after = newPlan.config, templateId = 9107258;
  assert.equal(oldPlan.templateId, templateId, "visual upgrade only supports the owned bubble-tea template");
  assert.equal(newPlan.templateId, templateId);
  assert.equal(before.owner, "ddtank-workshop/weapon/bubble-tea-7258");
  assert.equal(after.owner, before.owner, "visual upgrade must inherit the original owner");
  assert.equal(before.schemaVersion, 2); assert.equal(before.Ball.length, 0);
  assert.equal(before.BallReferences!.length, 4, "old package must contain four read-only BallReferences");
  assert.equal(after.schemaVersion, 1); assert.equal(after.Ball.length, 4);
  assert.equal(canonical(after.Shop_Goods), canonical(before.Shop_Goods), "Shop_Goods must remain completely unchanged");
  const oldIds = oldPlan.referencedBallIds!, newIds = newPlan.ballIds;
  assert.ok(newIds.every(id => !oldIds.includes(id)), "new Ball IDs must be independent of old shared rows");
  const protectedBall = (row: Row) => Object.fromEntries(Object.entries(row).filter(([key]) => !["ID", "Name", "BombPartical"].includes(key)));
  for (const branch of branches) {
    const oldBall = before.BallReferences!.find(row => row.ID === before.BallConfig[branch])!;
    const newBall = after.Ball.find(row => row.ID === after.BallConfig[branch])!;
    assert.equal(canonical(protectedBall(newBall)), canonical(protectedBall(oldBall)), branch + " physics, crater, sound and trail must remain unchanged");
  }
  assert.ok(options.binding && typeof options.binding.databaseName === "string" && options.binding.databaseName.length > 0 &&
    typeof options.binding.dataDirectory === "string" && options.binding.dataDirectory.length > 0, "database binding is required");
  const binding = { databaseName: options.binding.databaseName, dataDirectory: options.binding.dataDirectory };
  assert.equal(canonical(binding), canonical(options.binding), "unknown database binding fields");
  const originalPath = resolve(options.originalJournalPath), upgradePath = resolve(options.upgradeJournalPath);
  assert.notEqual(originalPath.toLowerCase(), upgradePath.toLowerCase(), "original and upgrade journals must be separate");
  let journalPublished = false;
  const result = await h.db.transaction(async tx => {
    const th = { ...h, db: tx };
    options.checkBinding?.();
    await tx.execute(sql`LOCK TABLE game."Shop_Goods", game."BallConfig", game."Ball" IN SHARE ROW EXCLUSIVE MODE`);
    const originalBytes = readFileSync(originalPath), original = JSON.parse(originalBytes.toString("utf8"));
    assert.equal(original.schemaVersion, 1); assert.equal(original.phase, "prepared", "unknown original ownership journal phase");
    assert.equal(canonical(original.binding), canonical(binding), "original journal belongs to a different database");
    assert.equal(original.packageSha256, oldPlan.packageSha256, "original journal package hash differs");
    assert.equal(planWeaponInstall(original.package).packageSha256, oldPlan.packageSha256, "original journal package differs");
    const intent = { schemaVersion: 1, phase: "prepared", owner: before.owner, templateId, binding,
      originalJournal: { path: originalPath, sha256: sha(originalBytes), packageSha256: oldPlan.packageSha256 },
      oldPackageSha256: oldPlan.packageSha256, newPackageSha256: newPlan.packageSha256,
      oldPackage: before, newPackage: after };
    let upgradeBytes = existsSync(upgradePath) ? readFileSync(upgradePath) : null;
    if (upgradeBytes) assert.equal(canonical(JSON.parse(upgradeBytes.toString("utf8"))), canonical(intent), "upgrade ownership journal differs");
    const checkFiles = () => {
      assert.equal(sha(readFileSync(originalPath)), intent.originalJournal.sha256, "original journal changed during upgrade");
      if (upgradeBytes) assert.equal(sha(readFileSync(upgradePath)), sha(upgradeBytes), "upgrade journal changed during upgrade");
    };
    const readState = async () => ({
      items: await q<Row>(th, sql`SELECT * FROM game."Shop_Goods" WHERE "TemplateID"=${templateId}`),
      configs: await q<Row>(th, sql`SELECT * FROM game."BallConfig" WHERE "TemplateID"=${templateId}`),
      oldBalls: await q<Row>(th, sql`SELECT * FROM game."Ball" WHERE "ID" IN (${sql.join(oldIds.map(id => sql`${id}`), sql`,`)}) ORDER BY "ID"`),
      newBalls: await q<Row>(th, sql`SELECT * FROM game."Ball" WHERE "ID" IN (${sql.join(newIds.map(id => sql`${id}`), sql`,`)}) ORDER BY "ID"`),
      references: await q<Row>(th, sql`SELECT "TemplateID" FROM game."BallConfig" WHERE
        "Common" IN (${sql.join(newIds.map(id => sql`${id}`), sql`,`)}) OR
        "CommonAddWound" IN (${sql.join(newIds.map(id => sql`${id}`), sql`,`)}) OR
        "CommonMultiBall" IN (${sql.join(newIds.map(id => sql`${id}`), sql`,`)}) OR
        "Special" IN (${sql.join(newIds.map(id => sql`${id}`), sql`,`)}) ORDER BY "TemplateID"`),
    });
    const checkPreserved = (state: Awaited<ReturnType<typeof readState>>) => {
      // A completed visual deployment can subsequently enable the two owned weapons' smith capabilities.
      // Accept exactly that upgrade; all official stats and every other field still have to match.
      const smithUpgraded = upgradeBytes && canonical(state.configs) === canonical([after.BallConfig]) &&
        canonical(state.items) === canonical([smithEnabledWeapon(before.Shop_Goods)]);
      assert.ok(canonical(state.items) === canonical([before.Shop_Goods]) || smithUpgraded, "owned Shop_Goods missing or changed; preserved");
      assert.equal(canonical(state.oldBalls), canonical(before.BallReferences), "old shared BallReferences missing or changed; preserved");
    };
    const state = await readState(); checkPreserved(state);
    const isOld = canonical(state.configs) === canonical([before.BallConfig]) && state.newBalls.length === 0 && state.references.length === 0;
    const isNew = canonical(state.configs) === canonical([after.BallConfig]) && canonical(state.newBalls) === canonical(after.Ball) &&
      canonical(state.references) === canonical([{ TemplateID: templateId }]);
    assert.ok(isOld || isNew, "visual upgrade state is partial, occupied, shared or changed; preserved");
    if (isNew) {
      assert.ok(upgradeBytes, "new visual state has no upgrade ownership journal");
      options.checkBinding?.(); checkFiles();
      return { status: "unchanged" as const, inserted: { Ball: 0 }, updated: { BallConfig: 0 } };
    }
    if (!upgradeBytes) {
      publish(upgradePath, intent); journalPublished = true;
      upgradeBytes = readFileSync(upgradePath);
      assert.equal(canonical(JSON.parse(upgradeBytes.toString("utf8"))), canonical(intent), "published upgrade journal differs");
    }
    // The persisted intent precedes every DB mutation. A failed transaction leaves the exact old state retryable.
    checkFiles();
    await tx.insert(game.Ball).values(after.Ball as (typeof game.Ball.$inferInsert)[]);
    await tx.execute(sql`UPDATE game."BallConfig" SET "Common"=${after.BallConfig.Common}, "CommonAddWound"=${after.BallConfig.CommonAddWound},
      "CommonMultiBall"=${after.BallConfig.CommonMultiBall}, "Special"=${after.BallConfig.Special} WHERE "TemplateID"=${templateId}`);
    const installed = await readState(); checkPreserved(installed);
    assert.equal(canonical(installed.configs), canonical([after.BallConfig]), "updated BallConfig differs");
    assert.equal(canonical(installed.newBalls), canonical(after.Ball), "inserted visual Ball rows differ");
    assert.equal(canonical(installed.references), canonical([{ TemplateID: templateId }]), "new visual Ball IDs became shared");
    options.checkBinding?.(); checkFiles();
    return { status: "upgraded" as const, inserted: { Ball: 4 }, updated: { BallConfig: 1 } };
  });
  return { ...result, templateId, oldPackageSha256: oldPlan.packageSha256, newPackageSha256: newPlan.packageSha256,
    oldBallIds: oldIds, newBallIds: newIds, journalPublished, originalJournalPreserved: true, originalRowsPreserved: true,
    playerDataWritten: false, resourcesWritten: false, cacheReloadRequired: result.status === "upgraded",
    fightReloadRequired: result.status === "upgraded", clientAccepted: false };
}
