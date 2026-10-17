import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { loadPlayerInfo } from "../src/db/characters.js";
import { loadUserItems } from "../src/db/items.js";
import { loadUserPets } from "../src/db/pets-cards.js";
import { Templates } from "../src/db/templates.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { activeEquipSkill, buildProp, createPet, updateSkillPet, type UserPetRow } from "../src/game/pets.js";
import { commitPlayerMutation } from "../src/game/player-transaction.js";
import { mailItems } from "../src/handlers/items.js";
import { registerMail } from "../src/handlers/mail.js";
import { registerPets } from "../src/handlers/pets.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import type { GameClient } from "../src/session/client.js";
import type { ServerContext } from "../src/session/context.js";

// Unchanged shipped gzip bytes: complete templates/config/levels/skills, never toy pet/food rows.
const sourcePins = {
  Shop_Goods: "8850565ed5e743f01cba4bd3679e2cb65b3448e05ade0db7c4437406c275cc53",
  Pet_Config: "5e455fcc8c5cfdb7773822ccdf181d560bdb08b71e51d843a14382a1b946cfcd",
  Pet_Level: "3334a1cc895c336fe8dfe3eb376ce3c47e50c6dc23002bbaa642a3abdab57622",
  Pet_Template_Info: "cd80746642f7f8aeaf51f466f44938e7cba454c2ed0c493901479e039c5e7282",
  Pet_Skill_Info: "c4c1e9ada439e715cfe0f97b4a3d0aeac7ef6a7439eb34133c20bb0b181d42c0",
  Pet_Skill_Template_Info: "26bf792561856832f2d713a96714bf7fca86ade2e2ef9f96688e40dfe0a68f58",
};
const goods = JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url))).toString("utf8")) as ItemTemplate[];
const now = new Date("2026-10-16T08:00:00Z"), D = player.Sys_Users_Detail, G = player.Sys_Users_Goods, P = player.Sys_Users_Pet, M = player.User_Messages;
const registry = new HandlerRegistry(); registerMail(registry); registerPets(registry);
let h: DbHandle, templates: Templates, sequence = 0;
beforeAll(async () => {
  for (const [name, expected] of Object.entries(sourcePins)) {
    const bytes = readFileSync(new URL(`../../../packages/db/seed/game/${name}.json.gz`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex"), `${name} original gzip`).toBe(expected);
  }
  h = await createDb("pglite:memory"); await migrateDb(h);
  await seedDatabase(h, { only: ["Pet_Config", "Pet_Level", "Pet_Template_Info", "Pet_Skill_Info", "Pet_Skill_Template_Info"] });
  templates = new Templates(); await templates.loadPetsCards(h.db, "original");
  templates.items = new Map(goods.filter(row => [334100, 334103, 11019].includes(row.TemplateID)).map(row => [row.TemplateID, row]));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of ['player."Sys_Users_Pet"', 'player."Sys_Users_Detail"'])
    await h.db.execute(sql.raw(`DROP TRIGGER IF EXISTS petfood_test_fault ON ${table}`));
  await h.db.execute(sql`DROP FUNCTION IF EXISTS player.petfood_test_fault()`);
});
afterAll(async () => { await h?.close(); });

async function fixture(options: { grade?: number; templateId?: number; count?: number;
  item?: Partial<Pick<ItemInfo, "DefendCompose" | "Hole1" | "Hole2" | "Hole3" | "Hole4" | "Hole5" | "Blood">>;
  pet?: Partial<Pick<UserPetRow, "Level" | "GP" | "MaxGP" | "Hunger">> } = {}) {
  const [row] = await h.db.insert(D).values({ UserName: `petfood${++sequence}`, NickName: `PetFood${sequence}`, Grade: options.grade ?? 25, IsFirst: 1, Gold: 5000, Money: 1000 }).returning();
  const sent: GSPacket[] = [], world = new Map<number, GamePlayer>(), error = vi.fn();
  const makePlayer = async () => new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "petfood-isolated-memory" },
    (await loadPlayerInfo(h.db, row!.UserID))!, defaultMatch(row!.UserID), 1, "test");
  const p = await makePlayer(); world.set(p.id, p);
  const pet = createPet(templates.pets, templates.pets.templates.get(100101)!, p.id, 0, p.info.Grade, p.info.VIPLevel, () => 0.5);
  Object.assign(pet, { Hunger: 5000 }, options.pet); buildProp(pet);
  pet.Skill = updateSkillPet(templates.pets, pet.Level, pet.TemplateID, p.info.Grade); pet.SkillEquip = activeEquipSkill(pet.Level, p.info.VIPLevel);
  pet.BaseProp = JSON.stringify({ ...pet, dirty: undefined });
  expect(p.petBag.addPetTo(pet, 0)).toBe(true); expect(p.petBag.equipPet(0, true)).toBe(true); p.pet = pet;
  await p.saveIntoDatabase(h.db); expect(pet.ID).toBeGreaterThan(0); p.flushPets();
  const ctx = { db: h, templates, now: () => new Date(now), world, lang: { t: (key: string) => key }, log: { debug() {}, warn() {}, error } } as unknown as ServerContext;
  const dispatch = async (code: number, write: (packet: GSPacket) => void) => {
    const packet = new GSPacket(code); write(packet);
    await registry.get(code)!.handle(ctx, { player: p } as GameClient, GSPacket.parse(packet.encode()));
  };
  const count = options.count ?? 5;
  const attachment = ItemInfo.createFromTemplate(templates.findItem(options.templateId ?? 334103)!, count, 0, now); attachment.IsBinds = true;
  Object.assign(attachment, options.item);
  await mailItems(ctx, p, [attachment], "Treasure pet food", 12);
  const [mail] = await h.db.select().from(M).where(eq(M.ReceiverID, p.id));
  expect(mail).toMatchObject({ Annex1: String(attachment.ItemID), Type: 12 });
  const claim = () => dispatch(113, packet => { packet.writeInt(mail!.ID); packet.writeByte(1); });
  await claim();
  const item = p.propBag.getItemByTemplateID(0, attachment.TemplateID)!;
  expect(item).toMatchObject({ ItemID: attachment.ItemID, UserID: p.id, Count: count, IsBinds: true, ValidDate: 0 });
  expect(item.ItemID).toBeGreaterThan(0);
  const reply = sent.filter(packet => packet.code === 113).at(-1)!;
  expect([reply.readInt(), reply.readInt(), reply.readInt()]).toEqual([mail!.ID, 1, 1]);
  expect((await h.db.select().from(M).where(eq(M.ID, mail!.ID)))[0]!.Annex1).toBeNull();
  const feed = (place = item.Place, bag = item.BagType, petPlace = 0) => dispatch(68, packet => {
    packet.writeByte(4); packet.writeInt(place); packet.writeInt(bag); packet.writeInt(petPlace);
  });
  const reload = async () => {
    const fresh = await makePlayer(), items = await loadUserItems(h.db, p.id, templates.findItem, templates.findGoldTemplate);
    for (const [bag, rows] of items) fresh.getInventory(bag)!.loadItems(rows);
    fresh.petBag.load(await loadUserPets(h.db, p.id)); fresh.pet = fresh.petBag.equipped(); fresh.recalcStats(now);
    return fresh;
  };
  sent.length = 0;
  return { p, pet, item, mail: mail!, sent, error, ctx, claim, feed, reload };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const database = async (f: Fixture) => ({
  profile: await h.db.select().from(D).where(eq(D.UserID, f.p.id)),
  pets: await h.db.select().from(P).where(eq(P.UserID, f.p.id)).orderBy(P.ID),
  goods: await h.db.select().from(G).where(eq(G.UserID, f.p.id)).orderBy(G.ItemID),
  mail: await h.db.select().from(M).where(eq(M.ReceiverID, f.p.id)).orderBy(M.ID),
});
const memory = (f: Fixture) => structuredClone({
  info: f.p.info, match: f.p.match, pet: f.p.pet,
  pets: f.p.petBag.pets, removed: f.p.petBag.removed, changed: [...f.p.petBag.changed],
  eat: f.p.petBag.eat, eatDirty: f.p.petBag.eatDirty, adopt: f.p.petBag.adopt,
  bags: f.p.allBags().map(bag => ({ bag: bag.bagType, items: bag.getItems().map(item => ({ ...item.toRow(), dirty: item.isDirty })), removed: bag.removed.map(item => ({ ...item.toRow(), dirty: item.isDirty })) })),
});
function balances(p: GamePlayer) {
  const { Gold, Money, MoneyLock, GiftToken, GP, Grade, petScore } = p.info;
  return { Gold, Money, MoneyLock, GiftToken, GP, Grade, petScore };
}
async function expectFed(f: Fixture, expected: { GP: number; Level: number; Hunger: number; remaining: number; templateId?: number }) {
  const { remaining, templateId = 100101, ...petState } = expected;
  expect(f.p.petBag.getPetAt(0)).toBe(f.pet); expect(f.p.pet).toBe(f.pet);
  expect(f.pet).toMatchObject({ ...petState, ID: f.pet.ID, TemplateID: templateId, UserID: f.p.id, IsEquip: true, IsExit: true, dirty: false });
  const fresh = await f.reload();
  expect(fresh).not.toBe(f.p); expect(fresh.pet).not.toBe(f.pet);
  expect(fresh.pet).toMatchObject({ ...petState, ID: f.pet.ID, TemplateID: templateId, UserID: f.p.id, IsEquip: true, dirty: false });
  expect(fresh.petBag.getPetAt(0)!.Skill).toBe(f.pet.Skill); expect(fresh.petBag.getPetAt(0)!.SkillEquip).toBe(f.pet.SkillEquip);
  const stored = await database(f);
  expect(stored.pets).toHaveLength(1); expect(stored.pets[0]).toMatchObject({ ...petState, ID: f.pet.ID });
  expect(stored.goods).toHaveLength(1);
  expect(stored.goods[0]).toMatchObject(remaining > 0
    ? { ItemID: f.item.ItemID, UserID: f.p.id, TemplateID: f.item.TemplateID, Count: remaining, IsExist: true, IsBinds: true }
    : { ItemID: f.item.ItemID, UserID: f.p.id, TemplateID: f.item.TemplateID, IsExist: false, BagType: -1, Place: -1, IsBinds: true });
  expect(fresh.propBag.getItemCount(f.item.TemplateID)).toBe(remaining);
  expect(balances(fresh)).toEqual(balances(f.p)); expect(stored.mail[0]!.Annex1).toBeNull();
}

describe("genuine treasure pet food through mail 113 and registered pet 68/4", () => {
  it("keeps the original food, pet limits and independent level thresholds", () => {
    expect(templates.findItem(334103)).toMatchObject({ CategoryID: 34, CanUse: true, NeedLevel: 0, BindType: 1, MaxCount: 9999, Property1: 1500, Property2: 20000 });
    expect(templates.pets.templates.get(100101)).toMatchObject({ KindID: 1, StarLevel: 1, HighBlood: 15000, HighAttack: 340, HighDefence: 400, HighAgility: 300, HighLuck: 300 });
    expect(templates.pets.config.get("LimitGrade")).toBe("25"); expect(templates.pets.config.get("MaxLevel")).toBe("50"); expect(templates.pets.config.get("MaxHunger")).toBe("10000");
    expect([12, 13, 24, 25].map(level => templates.pets.levelGp.get(level))).toEqual([86233, 122391, 1484566, 1706040]);
    expect(templates.pets.skillTemplates.length).toBeGreaterThan(0); expect(templates.pets.skills.size).toBeGreaterThan(0);
    expect(templates.findItem(334100)).toMatchObject({ CategoryID: 34, CanUse: true, MaxCount: 1, Property1: 0, Property2: 0 });
  });

  it.each(["reject", "return null"] as const)("isolates pet rows and eat state without petUpdates when work will %s", async outcome => {
    const f = await fixture(), live = memory(f), stored = await database(f);
    const pending = f.p.withPersistenceLock(() => commitPlayerMutation(f.ctx, f.p, async (_db, staged) => {
      expect(staged.petBag).not.toBe(f.p.petBag); expect(staged.petBag.getPetAt(0)).not.toBe(f.pet); expect(staged.pet).not.toBe(f.p.pet);
      expect(staged.petBag.eat).not.toBe(f.p.petBag.eat);
      staged.petBag.getPetAt(0)!.GP = 100000; staged.petBag.eat.weaponExp = 17; staged.petBag.eatDirty = true;
      return outcome === "return null" ? null : { value: true };
    }));
    if (outcome === "reject") await expect(pending).rejects.toThrow("Pets are read-only without explicit opt-in");
    else expect(await pending).toBeNull();
    expect(memory(f)).toEqual(live); expect(await database(f)).toEqual(stored); expect(f.sent).toHaveLength(0);
  });

  it("claims a bound five-food mail once, feeds it and reloads the saved pet/item without another save", async () => {
    const f = await fixture(), before = balances(f.p), itemId = f.item.ItemID, petId = f.pet.ID;
    const claimed = await database(f); await f.claim(); expect(await database(f)).toEqual(claimed); expect(f.p.propBag.getItemCount(334103)).toBe(5); f.sent.length = 0;
    await f.feed(); expect(f.error).not.toHaveBeenCalled();
    expect(f.item.ItemID).toBe(itemId); expect(f.pet.ID).toBe(petId); expect(balances(f.p)).toEqual(before);
    await expectFed(f, { GP: 100000, Level: 12, Hunger: 10000, remaining: 0 });
    expect(f.sent.filter(packet => packet.code === 68)).toHaveLength(1); expect(f.sent.some(packet => packet.code === 64)).toBe(true);
    const stored = await database(f); await f.feed(); expect(await database(f)).toEqual(stored); expect(f.pet.GP).toBe(100000);
  });

  it("caps at the real grade-25 threshold and retains the one unneeded food", async () => {
    const f = await fixture({ pet: { Level: 24, GP: 1626040, MaxGP: 1706040, Hunger: 9000 } }), before = balances(f.p);
    await f.feed(); expect(f.error).not.toHaveBeenCalled(); expect(balances(f.p)).toEqual(before);
    await expectFed(f, { GP: 1706040, Level: 25, Hunger: 10000, remaining: 1 });
    const stored = await database(f); await f.feed(); expect(await database(f)).toEqual(stored); expect(f.item.Count).toBe(1);
  });

  it("feeds hunger at the level cap without adding GP, then refuses a full pet without consumption", async () => {
    const f = await fixture({ pet: { Level: 25, GP: 1706040, MaxGP: 1706040, Hunger: 8500 } });
    await f.feed(); await expectFed(f, { GP: 1706040, Level: 25, Hunger: 10000, remaining: 0 });
    const full = await fixture({ pet: { Level: 25, GP: 1706040, MaxGP: 1706040, Hunger: 10000 } }), stored = await database(full), live = memory(full);
    await full.feed(); expect(await database(full)).toEqual(stored); expect(memory(full)).toEqual(live); expect(full.item.Count).toBe(5);
  });

  it("preserves legitimate dirty online hunger progress in the feeding transaction", async () => {
    const f = await fixture(); f.pet.Hunger = 4000; f.pet.dirty = true; f.p.petBag.changed.add(0);
    await f.feed(); expect(f.error).not.toHaveBeenCalled();
    await expectFed(f, { GP: 100000, Level: 12, Hunger: 10000, remaining: 0 });
  });

  it("crosses the genuine level-30 threshold, evolves 100101 to 100102 and durably learns its real skills", async () => {
    const f = await fixture({ grade: 50, pet: { Level: 29, GP: 3077161, MaxGP: 3177161 } });
    expect([29, 30, 31].map(level => templates.pets.levelGp.get(level))).toEqual([2836688, 3177161, 3534658]);
    expect(templates.pets.templates.get(100102)).toMatchObject({ EvolutionID: 1, GameAssetUrl: "pet002", HighBloodGrow: 4400, HighAttackGrow: 510, HighDefenceGrow: 600, HighAgilityGrow: 450, HighLuckGrow: 450 });
    expect(f.pet).toMatchObject({ TemplateID: 100101, BloodGrow: 1175, AttackGrow: 266, DefenceGrow: 313, AgilityGrow: 235, LuckGrow: 235,
      Skill: "3,0|27,1|38,2|56,3|69,4", SkillEquip: "0,0|0,1|-1,2|-1,3|-1,4" });
    vi.spyOn(Math, "random").mockReturnValue(0); await f.feed(); expect(f.error).not.toHaveBeenCalled();
    const evolved = { TemplateID: 100102, MaxGP: 3534658, BloodGrow: 1176, AttackGrow: 267, DefenceGrow: 314, AgilityGrow: 236, LuckGrow: 236,
      Blood: 458, Attack: 80, Defence: 94, Agility: 70, Luck: 70, Skill: "3,0|27,1|38,2|56,3|69,4", SkillEquip: "0,0|0,1|0,2|-1,3|-1,4" };
    expect(f.pet).toMatchObject(evolved); await expectFed(f, { GP: 3177161, Level: 30, Hunger: 10000, remaining: 0, templateId: 100102 });
    expect((await f.reload()).pet).toMatchObject(evolved);
  });

  it("consumes genuine essence with carried GP and break stats and reloads the committed pet directly", async () => {
    const f = await fixture({ templateId: 334100, count: 1, item: { DefendCompose: 100000, Hole1: 1, Hole2: 17, Hole3: 19, Hole4: 23, Hole5: 29, Blood: 31 } });
    expect(f.item).toMatchObject({ DefendCompose: 100000, Hole1: 1, Hole2: 17, Hole3: 19, Hole4: 23, Hole5: 29, Blood: 31 });
    await f.feed(); expect(f.error).not.toHaveBeenCalled();
    await expectFed(f, { GP: 100000, Level: 12, Hunger: 5000, remaining: 0 });
    const carried = { breakGrade: 1, breakAttack: 17, breakDefence: 19, breakAgility: 23, breakLuck: 29, breakBlood: 31 };
    expect(f.pet).toMatchObject(carried); expect((await f.reload()).pet).toMatchObject(carried);
  });

  it("preserves original essence consumption at the level cap even when only dirty state changes", async () => {
    const f = await fixture({ templateId: 334100, count: 1, pet: { Level: 25, GP: 1706040, MaxGP: 1706040, Hunger: 8500 }, item: { DefendCompose: 100000, Hole1: 0, Hole2: 0, Hole3: 0, Hole4: 0, Hole5: 0, Blood: 0 } });
    const original = { ...f.pet, dirty: false }; await f.feed(); expect(f.error).not.toHaveBeenCalled();
    await expectFed(f, { GP: 1706040, Level: 25, Hunger: 8500, remaining: 0 }); expect(f.pet).toEqual(original);
  });

  it("rejects essence at full level and hunger without leaking its speculative break fields", async () => {
    const f = await fixture({ templateId: 334100, count: 1, pet: { Level: 25, GP: 1706040, MaxGP: 1706040, Hunger: 10000 }, item: { DefendCompose: 100000, Hole1: 1, Hole2: 17, Hole3: 19, Hole4: 23, Hole5: 29, Blood: 31 } });
    const live = memory(f), stored = await database(f); await f.feed();
    expect(memory(f)).toEqual(live); expect(await database(f)).toEqual(stored); expect(f.item.Count).toBe(1); expect(f.item.IsExist).toBe(true);
    expect(f.pet).toMatchObject({ breakGrade: 0, breakAttack: 0, breakDefence: 0, breakAgility: 0, breakLuck: 0, breakBlood: 0 });
    expect(f.sent.filter(packet => [64, 68].includes(packet.code))).toHaveLength(0);
  });

  it("refuses a clean pet whose persisted row changed without overwriting SQL or the live object", async () => {
    const f = await fixture(); await h.db.update(P).set({ Hunger: 4000 }).where(eq(P.ID, f.pet.ID));
    const stored = await database(f), live = memory(f); await f.feed();
    expect(f.error).toHaveBeenCalled(); expect(await database(f)).toEqual(stored); expect(memory(f)).toEqual(live);
    expect(f.sent.filter(packet => [64, 68].includes(packet.code))).toHaveLength(0);
  });

  it.each(["grade", "non-food", "missing pet", "locked bag", "expired food"] as const)("rejects %s without consuming or changing pet storage", async reason => {
    const f = await fixture({ grade: reason === "grade" ? 24 : 25, templateId: reason === "non-food" ? 11019 : 334103 });
    if (reason === "locked bag") { f.p.info.HasBagPassword = true; f.p.info.IsLocked = true; }
    if (reason === "expired food") { f.item.IsUsed = true; f.item.BeginDate = new Date("2026-10-14T08:00:00Z"); f.item.ValidDate = 1; f.p.propBag.updateItem(f.item); await f.p.saveIntoDatabase(h.db); }
    const stored = await database(f), live = memory(f); f.sent.length = 0;
    await f.feed(f.item.Place, f.item.BagType, reason === "missing pet" ? 1 : 0);
    expect(await database(f)).toEqual(stored); expect(memory(f)).toEqual(live); expect(f.item.Count).toBe(5);
    expect(f.sent.filter(packet => [64, 68].includes(packet.code))).toHaveLength(0);
  });

  it.each(["pet update", "deferred commit"] as const)("rolls back actual %s SQL failure without leaking pet, food or notifications", async kind => {
    const f = await fixture(), stored = await database(f), live = memory(f), pet = f.pet, item = f.item;
    await h.db.execute(sql`CREATE FUNCTION player.petfood_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '68/4 petfood SQL fault'; RETURN NEW; END $$`);
    await h.db.execute(sql.raw(kind === "pet update"
      ? 'CREATE TRIGGER petfood_test_fault BEFORE UPDATE ON player."Sys_Users_Pet" FOR EACH ROW EXECUTE FUNCTION player.petfood_test_fault()'
      : 'CREATE CONSTRAINT TRIGGER petfood_test_fault AFTER UPDATE ON player."Sys_Users_Detail" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION player.petfood_test_fault()'));
    await f.feed(); expect(f.error).toHaveBeenCalled(); expect(await database(f)).toEqual(stored); expect(memory(f)).toEqual(live);
    expect(f.p.pet).toBe(pet); expect(f.p.propBag.getItemAt(item.Place)).toBe(item);
    expect(f.sent.filter(packet => [64, 68].includes(packet.code))).toHaveLength(0);
  });

  it("retains committed pet and food after notification failure and reloads them without autosave", async () => {
    const f = await fixture(), original = f.p.sink.send.bind(f.p.sink), notice = vi.spyOn(f.p, "sendMessage");
    const send = vi.spyOn(f.p.sink, "send").mockImplementation(packet => { if (packet.code === 68) throw new Error("68/4 transport failed after commit"); original(packet); });
    await expect(f.feed()).rejects.toThrow("68/4 transport failed after commit"); send.mockRestore();
    expect(f.error).not.toHaveBeenCalled(); expect(notice).toHaveBeenCalledWith(0, "FeedPet.Success");
    await expectFed(f, { GP: 100000, Level: 12, Hunger: 10000, remaining: 0 });
    expect(f.p.petBag.changed.size).toBe(0);
  });
});
