import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { app, createDb, game, migrateDb, player, type DbHandle } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import { loadPlayerInfo } from "../src/db/characters.js";
import { EventData } from "../src/game/events.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { achievementFinish, eventsRuntime } from "../src/handlers/events.js";
import { World, type ServerContext } from "../src/session/context.js";

const achievementId = 990101;
const originalTitle = "Thiên hạ vô song";
const displayTitle = "天下无双";
const now = new Date("2026-10-17T06:00:00Z");
const goods = [
  { AchievementID: achievementId, RewardType: 1, RewardPara: originalTitle, RewardValueId: 17, RewardCount: 1 },
  { AchievementID: achievementId, RewardType: 0, RewardPara: "Original non-title reward", RewardValueId: 11022, RewardCount: 7 },
];
let h: DbHandle, sequence = 0;

beforeAll(async () => {
  // Isolated SQL and packet objects only: no configured DB, listener, client connection or browser.
  for (const name of ["ITEM_NAME_OVERRIDES_FILE", "PVE_TEXT_OVERRIDES_FILE", "TEMPLATE_TEXT_OVERRIDES_FILE", "TEMPLATE_TEXT_SUPPLEMENT_FILE"]) vi.stubEnv(name, "");
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await h.db.insert(game.Achievement).values({
    ID: achievementId, PlaceID: 0, Title: "成就测试", Detail: "测试", NeedMinLevel: 0, NeedMaxLevel: 0,
    PreAchievementID: "0,", IsOther: 0, AchievementType: 0, CanHide: false,
    StartDate: new Date("2020-01-01Z"), EndDate: new Date("2099-01-01Z"), AchievementPoint: 10,
    IsActive: 1, PicID: 0, IsShare: false,
  });
  await h.db.insert(game.AchievementCondition).values({ AchievementID: achievementId, CondictionID: 1, CondictionType: 1, Condiction_Para2: 0 });
  await h.db.insert(game.Achievement_Goods).values(goods);
  await h.db.insert(app.Translations).values([
    { table: "Achievement_Goods", column: "RewardPara", rowId: `${achievementId}:1:17`, lang: "pt-BR", text: displayTitle },
    { table: "Achievement_Goods", column: "RewardPara", rowId: `${achievementId}:1:18`, lang: "pt-BR", text: "错误关联称号" },
    { table: "Achievement_Goods", column: "RewardPara", rowId: `${achievementId}:0:11022`, lang: "pt-BR", text: "非称号说明" },
  ]);
});
afterAll(async () => { vi.unstubAllEnvs(); await h?.close(); });

async function fixture() {
  const [owner] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `title_display_${++sequence}`, NickName: "称号测试", Grade: 10, IsFirst: 1 }).returning();
  const info = (await loadPlayerInfo(h.db, owner!.UserID))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: packet => sent.push(GSPacket.parse(packet.encode())), disconnect() {}, remoteAddress: "achievement-title-memory" }, info, defaultMatch(info.ID), 1, "test");
  const ctx = { db: h, world: new World(), now: () => now } as unknown as ServerContext;
  ctx.world.add(p);
  eventsRuntime(ctx).data = await new EventData().load(h.db);
  return { ctx, p, sent };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const ranks = (f: Fixture) => h.db.select().from(player.Sys_User_Rank).where(eq(player.Sys_User_Rank.UserID, f.p.id)).orderBy(player.Sys_User_Rank.ID);
function notices(f: Fixture) {
  return f.sent.filter(packet => packet.code === 3).map(packet => {
    packet.clearOffset(); expect(packet.readInt()).toBe(0);
    const text = packet.readString(); expect(packet.dataLeft).toBe(0); return text;
  });
}
function rankDisplay(f: Fixture) {
  const packets = f.sent.filter(packet => packet.code === 34);
  expect(packets).toHaveLength(1);
  const packet = packets[0]!; packet.clearOffset();
  const count = packet.readInt(), rows = [];
  for (let index = 0; index < count; index++) rows.push({
    NewTitleID: packet.readInt(), Name: packet.readString(), BeginDate: packet.readDateTime(true), EndDate: packet.readDateTime(true),
  });
  expect(packet.dataLeft).toBe(0);
  return rows;
}

it("loads composite-key display names without changing title identities, counts or non-title rewards", async () => {
  const data = await new EventData().load(h.db);
  expect(data.achGoods.get(achievementId)).toEqual(goods);
  expect(await h.db.select().from(game.Achievement_Goods)).toEqual(goods);
  expect(data.achievementTitleName(originalTitle)).toBe(displayTitle);
  expect(data.achievementTitleName("Original non-title reward")).toBe("Original non-title reward");
  expect(data.achievementTitleName("Unrelated stored title")).toBe("Unrelated stored title");
});

it("new completion sends Chinese title text but persists the original name and remains idempotent", async () => {
  const f = await fixture();
  const before = { gold: f.p.info.Gold, money: f.p.info.Money, inventory: f.p.allBags().map(bag => bag.getItems()) };
  expect(await achievementFinish(f.ctx, f.p, achievementId)).toBe(true);
  const stored = await ranks(f);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ Name: originalTitle, NewTitleID: 0, IsExit: true, Validate: 0, BeginDate: now, EndDate: now });
  expect(notices(f)).toEqual([`获得称号：${displayTitle}`]);
  expect(rankDisplay(f)).toEqual([{ NewTitleID: 0, Name: displayTitle, BeginDate: now, EndDate: new Date(+now + 365 * 86_400_000) }]);
  expect(f.p.info.AchievementPoint).toBe(10);
  expect({ gold: f.p.info.Gold, money: f.p.info.Money, inventory: f.p.allBags().map(bag => bag.getItems()) }).toEqual(before);
  expect(await h.db.select().from(game.Achievement_Goods)).toEqual(goods);
  f.sent.length = 0;
  expect(await achievementFinish(f.ctx, f.p, achievementId)).toBe(false);
  expect(await ranks(f)).toEqual(stored);
  expect(f.sent).toEqual([]);
  expect(f.p.info.AchievementPoint).toBe(10);
});

it("reuses an existing original-name title and only translates matching outgoing rank names", async () => {
  const f = await fixture(), oldDate = new Date("2025-02-03T04:05:06Z");
  const [historic, other, unnamed] = await h.db.insert(player.Sys_User_Rank).values([
    { UserID: f.p.id, Name: originalTitle, NewTitleID: 91, IsExit: false, Validate: 7, BeginDate: oldDate, EndDate: oldDate, Attack: 7, HP: 13 },
    { UserID: f.p.id, Name: "Unrelated stored title", NewTitleID: 92, IsExit: true, Validate: 2, BeginDate: oldDate, EndDate: oldDate },
    { UserID: f.p.id, Name: null, NewTitleID: 93, IsExit: true, Validate: 3, BeginDate: oldDate, EndDate: oldDate },
  ]).returning();
  expect(await achievementFinish(f.ctx, f.p, achievementId)).toBe(true);
  const stored = await ranks(f);
  expect(stored).toEqual([
    { ...historic!, IsExit: true, Validate: 0, BeginDate: now, EndDate: now }, other!, unnamed!,
  ]);
  expect(stored.filter(row => row.Name === displayTitle)).toEqual([]);
  expect(notices(f)).toEqual([`获得称号：${displayTitle}`]);
  expect(rankDisplay(f).sort((a, b) => a.NewTitleID - b.NewTitleID)).toEqual([
    { NewTitleID: 91, Name: displayTitle, BeginDate: now, EndDate: new Date(+now + 365 * 86_400_000) },
    { NewTitleID: 92, Name: "Unrelated stored title", BeginDate: oldDate, EndDate: new Date(+oldDate + 2 * 86_400_000) },
    { NewTitleID: 93, Name: "", BeginDate: oldDate, EndDate: new Date(+oldDate + 3 * 86_400_000) },
  ]);
});
