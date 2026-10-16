import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { app, createDb, game, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { parseTemplateTextOverrides } from "../../../packages/db/src/translations.js";
import { Templates } from "../../game/src/db/templates.js";
import { buildApp } from "../src/app.js";
import type { XEl } from "../src/lib/flash-xml.js";
import { TEMPLATES } from "../src/templates/defs.js";

const file = fileURLToPath(new URL("../../../research/i18n/zh-CN-template-text.json", import.meta.url));
const namesFile = fileURLToPath(new URL("../../../research/i18n/zh-CN-item-names.json", import.meta.url));
const entries = parseTemplateTextOverrides(readFileSync(file, "utf8"));
const definitions = ["/TemplateAllList.ashx", "/QuestList.ashx"].map(endpoint => TEMPLATES.find(d => d.endpoint === endpoint)!);
const temp = mkdtempSync(join(tmpdir(), "ddt-template-text-"));
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  h = await createDb("pglite:memory"); // Never use the configured live database or start a listener.
  await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods", "Quest", "Quest_Condiction", "Quest_Goods"] });
  await h.db.insert(app.Translations).values([
    { table: "Shop_Goods", column: "Name", rowId: "11028", lang: "pt-BR", text: "Existing name" },
    { table: "Shop_Goods", column: "Remark", rowId: "11028", lang: "pt-BR", text: "Existing remark" },
    { table: "Quest", column: "Title", rowId: "341", lang: "pt-BR", text: "Existing title" },
    { table: "Quest_Condiction", column: "CondictionTitle", rowId: "341:1", lang: "pt-BR", text: "Inactive old condition overlay" },
  ]);
  const [owner] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: "text_overlay_history", NickName: "History", Password: "test", IsFirst: 1 }).returning();
  await h.db.insert(player.Sys_Users_Goods).values({ UserID: owner!.UserID, TemplateID: 11028, Count: 3, BagType: 1, Place: 0 });
  await h.db.insert(player.User_Messages).values({ ReceiverID: owner!.UserID, Title: "Historic title", Content: "Historic body", Annex1Name: "Historic item" });
  built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config: {
    NODE_ENV: "test", DB_MIGRATE: false, DB_SEED_IF_EMPTY: false, GAME_INTERNAL_URL: "",
    FLASH_DIR: join(temp, "flash"), RESOURCE_DIR: join(temp, "resource"), UPLOAD_DIR: join(temp, "uploads"),
  } });
});
beforeEach(() => {
  vi.stubEnv("ITEM_NAME_OVERRIDES_FILE", namesFile);
  vi.stubEnv("PVE_TEXT_OVERRIDES_FILE", "");
  vi.stubEnv("TEMPLATE_TEXT_OVERRIDES_FILE", "");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await built?.app.close(); await h?.close();
  if (dirname(resolve(temp)) !== realpathSync(tmpdir())) throw new Error("Unexpected test directory");
  rmSync(temp, { recursive: true, force: true });
});
const snapshot = async () => ({
  goods: await h.db.select().from(game.Shop_Goods).orderBy(game.Shop_Goods.TemplateID),
  quests: await h.db.select().from(game.Quest).orderBy(game.Quest.ID),
  conditions: await h.db.select().from(game.Quest_Condiction).orderBy(game.Quest_Condiction.QuestID, game.Quest_Condiction.CondictionID),
  rewards: await h.db.select().from(game.Quest_Goods).orderBy(game.Quest_Goods.QuestID, game.Quest_Goods.RewardItemID),
  translations: await h.db.select().from(app.Translations),
  profiles: await h.db.select().from(player.Sys_Users_Detail),
  items: await h.db.select().from(player.Sys_Users_Goods),
  mail: await h.db.select().from(player.User_Messages),
});
const textFor = (table: string, rowId: string) => entries.find(e => e.table === table && e.rowId === rowId)?.text ?? {};
const attributes = (node: XEl) => Object.fromEntries(node.attrs);
const itemRows = (xml: XEl) => new Map(xml.children[0]!.children.map(row => [String(attributes(row).TemplateID), row]));
const questRows = (xml: XEl) => new Map(xml.children.map(row => [String(attributes(row).ID), row]));

it("serves exact screenshot names, descriptions, tasks, conditions and reward references through real HTTP XML and Game without any stored changes", async () => {
  const before = await snapshot(), priorGame = await new Templates().load(h.db, 1);
  const priorXml = await Promise.all(definitions.map(d => d.build(h)));
  expect(entries.map(e => `${e.table}:${e.rowId}`)).toEqual([
    "Shop_Goods:11028", "Shop_Goods:10008", "Shop_Goods:11001", "Shop_Goods:11005", "Shop_Goods:11009", "Shop_Goods:11013",
    "Shop_Goods:11904", "Shop_Goods:40002", "Shop_Goods:10018",
    "Quest:318", "Quest_Condiction:318:1", "Quest:341", "Quest_Condiction:341:1", "Quest:346", "Quest_Condiction:346:1", "Quest:347", "Quest_Condiction:347:1",
    "Shop_Goods:10016",
    "Shop_Goods:10002",
    "Shop_Goods:10001", "Shop_Goods:10003", "Shop_Goods:10004", "Shop_Goods:10005", "Shop_Goods:10006", "Shop_Goods:10007",
    "Shop_Goods:11901", "Shop_Goods:11902", "Shop_Goods:11903", "Shop_Goods:11905", "Shop_Goods:11906",
    "Shop_Goods:40001", "Shop_Goods:40003",
  ]);
  expect(before.goods.find(g => g.TemplateID === 11028)!.Name).toBe("Bùa may mắn 100%");
  expect([318, 341, 346, 347].map(id => before.quests.find(q => q.ID === id)!.Title)).toEqual([
    "Tranh đoạt báu vật ", "Dũng sĩ luyện tập ", "Hạ huyệt ma kiến (dễ)", "Mua sắm lần đầu",
  ]);
  expect(priorGame.quests.get(341)!.conds[0]!.CondictionTitle).toBe("Thắng 4 trận chiến đấu");
  vi.stubEnv("TEMPLATE_TEXT_OVERRIDES_FILE", file);
  const currentGame = await new Templates().load(h.db, 1), currentXml = await Promise.all(definitions.map(d => d.build(h)));
  const currentItems = itemRows(currentXml[0]!), priorItems = itemRows(priorXml[0]!);
  for (const [id, original] of priorGame.items) {
    const text = textFor("Shop_Goods", String(id));
    expect(currentGame.items.get(id)).toEqual({ ...original, ...text });
    expect(attributes(currentItems.get(String(id))!)).toEqual({ ...attributes(priorItems.get(String(id))!), ...text });
  }
  const currentQuests = questRows(currentXml[1]!), priorQuests = questRows(priorXml[1]!);
  for (const [id, original] of priorGame.quests) {
    const text = textFor("Quest", String(id)), current = currentGame.quests.get(id)!;
    expect(current.info).toEqual({ ...original.info, ...text });
    expect(current.goods).toEqual(original.goods);
    expect(current.conds).toEqual(original.conds.map(c => ({ ...c, ...textFor("Quest_Condiction", `${id}:${c.CondictionID}`) })));
    const oldRow = priorQuests.get(String(id))!, newRow = currentQuests.get(String(id))!;
    expect(attributes(newRow)).toEqual({ ...attributes(oldRow), ...text });
    expect(newRow.children.map(child => attributes(child))).toEqual(oldRow.children.map(child => ({
      ...attributes(child), ...(child.name === "Item_Condiction" ? textFor("Quest_Condiction", `${id}:${attributes(child).CondictionID}`) : {}),
    })));
    if (Object.hasOwn(text, "Detail")) {
      expect(text.Detail.match(/<cr|cr>/g) ?? []).toEqual(original.info.Detail!.match(/<cr|cr>/g) ?? []);
      expect(current.info.Objective).toBe("");
    }
  }
  expect(currentGame.items.get(11028)).toMatchObject({ Name: "幸运符100%", Description: "合成、强化装备时，成功率提高100%。", Property1: 3, Property2: 100 });
  expect(currentGame.items.get(11028)!.Remark).toBe("Existing remark");
  expect(currentGame.items.get(11904)).toMatchObject({ Name: "4级经验药水", Description: "使用后增加10000点人物经验。", CategoryID: 11, Property1: 21, Property2: 10000, MaxCount: 1 });
  expect(currentGame.items.get(40002)).toMatchObject({ Name: "修炼药水2级", Description: "在背包的修炼界面选择属性使用，增加300点修炼经验。每日使用次数受角色等级和VIP等级限制。", CategoryID: 20, Property1: 0, Property2: 300 });
  expect(currentGame.items.get(10018)).toMatchObject({ Name: "激怒", Description: "使用后增加100点怒气（怒气上限的50%），最多补至怒气上限。", CategoryID: 10, Property1: 11, Property2: 100 });
  expect(currentGame.items.get(10016)).toMatchObject({ Name: "传送", Description: "不受武器限制，将自己传送到本回合攻击的落点。" });
  expect(currentGame.items.get(10002)).toMatchObject({ Name: "攻击+1", Description: "增加1次攻击，伤害降低10%。" });
  expect(currentGame.items.get(10001)).toMatchObject({ Name: "攻击+2", Description: "增加2次攻击，伤害降低40%。" });
  expect(currentGame.items.get(10003)).toMatchObject({ Name: "三叉戟导弹", Description: "一次发射3发炮弹，伤害降低50%；与必杀技同时使用时无效。" });
  expect(currentGame.items.get(10004)).toMatchObject({ Name: "伤害+50%", Description: "伤害提高50%。" });
  expect(currentGame.items.get(10005)).toMatchObject({ Name: "伤害+40%", Description: "伤害提高40%。" });
  expect(currentGame.items.get(10006)).toMatchObject({ Name: "伤害+30%", Description: "伤害提高30%。" });
  expect(currentGame.items.get(10007)).toMatchObject({ Name: "伤害+20%", Description: "伤害提高20%。" });
  expect(currentGame.items.get(11901)).toMatchObject({ Name: "1级经验药水", Description: "使用后增加1000点人物经验。", CategoryID: 11, Property1: 21, Property2: 1000, MaxCount: 1 });
  expect(currentGame.items.get(11902)).toMatchObject({ Name: "2级经验药水", Description: "使用后增加2000点人物经验。", CategoryID: 11, Property1: 21, Property2: 2000, MaxCount: 1 });
  expect(currentGame.items.get(11903)).toMatchObject({ Name: "3级经验药水", Description: "使用后增加5000点人物经验。", CategoryID: 11, Property1: 21, Property2: 5000, MaxCount: 1 });
  expect(currentGame.items.get(11905)).toMatchObject({ Name: "5级经验药水", Description: "使用后增加20000点人物经验。", CategoryID: 11, Property1: 21, Property2: 20000, MaxCount: 1 });
  expect(currentGame.items.get(11906)).toMatchObject({ Name: "超级经验药水", Description: "使用后增加100000点人物经验。", CategoryID: 11, Property1: 21, Property2: 100000, MaxCount: 9999 });
  expect(currentGame.items.get(40001)).toMatchObject({ Name: "修炼药水1级", Description: "在背包的修炼界面选择属性使用，增加30点修炼经验。每日使用次数受角色等级和VIP等级限制。", CategoryID: 20, Property1: 0, Property2: 30 });
  expect(currentGame.items.get(40003)).toMatchObject({ Name: "修炼药水3级", Description: "在背包的修炼界面选择属性使用，增加900点修炼经验。每日使用次数受角色等级和VIP等级限制。", CategoryID: 20, Property1: 0, Property2: 900 });
  expect(currentGame.quests.get(341)!.conds[0]).toMatchObject({ CondictionType: 6, Para1: 0, Para2: 4 });
  expect(currentGame.quests.get(347)!.conds[0]).toMatchObject({ CondictionType: 10, Para1: -4, Para2: 1 });
  for (const id of [318, 341, 346, 347]) for (const reward of currentGame.quests.get(id)!.goods) {
    const template = currentGame.items.get(reward.RewardItemID)!;
    expect(textFor("Shop_Goods", String(reward.RewardItemID)).Name).toBe(template.Name);
  }
  for (const d of definitions) await built.ctx.cache.rebuild(d);
  const plain = await built.app.inject({ method: "GET", url: "/Request/TemplateAlllist1.xml" });
  const packed = await built.app.inject({ method: "GET", url: "/Request/TemplateAlllist.xml" });
  const quests = await built.app.inject({ method: "GET", url: "/Request/QuestList.xml" });
  expect([plain.statusCode, packed.statusCode, quests.statusCode]).toEqual([200, 200, 200]);
  expect(plain.body).toBe(currentXml[0]!.toString()); expect(inflateSync(packed.rawPayload).toString("utf8")).toBe(plain.body);
  expect(inflateSync(quests.rawPayload).toString("utf8")).toBe(currentXml[1]!.toString());
  expect(await snapshot()).toEqual(before);
  vi.stubEnv("TEMPLATE_TEXT_OVERRIDES_FILE", "");
  const restoredGame = await new Templates().load(h.db, 1);
  expect(restoredGame.items).toEqual(priorGame.items); expect(restoredGame.quests).toEqual(priorGame.quests);
  expect((await Promise.all(definitions.map(d => d.build(h)))).map(xml => xml.toString())).toEqual(priorXml.map(xml => xml.toString()));
});

it("fails explicitly for a configured missing file instead of silently showing source text", async () => {
  vi.stubEnv("TEMPLATE_TEXT_OVERRIDES_FILE", join(temp, "missing.json"));
  await expect(new Templates().load(h.db, 1)).rejects.toThrow(/ENOENT/);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const d of definitions) expect(attributes(await d.build(h)).value).toBe("false");
    expect(logged).toHaveBeenCalledTimes(2);
  } finally { logged.mockRestore(); }
});
