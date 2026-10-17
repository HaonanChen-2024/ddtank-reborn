import assert from "node:assert/strict";

type Row = Record<string, unknown>;
const ids = [9107243, 9107258];
/** Use the existing Level 3 weapon smith rules, without changing official combat stats or ball bindings.
 * ItemStrengthenHandler.cs / forge.ts: Level 3 weapons downgrade on failure instead of being destroyed.
 */
export function smithEnabledWeapon<T extends Row>(before: T): T {
  assert.ok(ids.includes(Number(before.TemplateID)), "not an owned imported weapon");
  assert.equal(before.CategoryID, 7);
  assert.equal(before.Level, 1);
  assert.equal(before.CanStrengthen, false);
  assert.equal(before.CanCompose, false);
  assert.equal(before.CanTransfer, 0);
  assert.ok(typeof before.Description === "string" && before.Description.endsWith("暂不开放强化、合成与转移。"));
  return { ...before, Level: 3, CanStrengthen: true, CanCompose: true, CanTransfer: 1,
    Description: before.Description.replace("暂不开放强化、合成与转移。", "支持本地铁匠铺强化、合成与转移。") };
}
