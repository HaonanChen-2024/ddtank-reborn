/** Synthetic isolated DB/client fixture shared only by A05 API and native PostgreSQL tests. */
import { game, member, player, type DbHandle } from "@ddt/db";
import { vi } from "vitest";
import { GameClient } from "../src/session/client.js";
import { GamePlayer } from "../src/game/player.js";
import { World, type ServerContext } from "../src/session/context.js";
import { HandlerRegistry } from "../src/handlers/registry.js";
import { Templates } from "../src/db/templates.js";
import { loadPlayerInfo } from "../src/db/characters.js";
import { defaultMatch } from "../src/game/player-info.js";
import { ItemInfo } from "../src/game/item.js";

export async function seedExchangeTemplates(h: DbHandle, maxCount = 9999) {
  const base: typeof game.Shop_Goods.$inferInsert = { TemplateID: 11019, Name: "强化石1级", CanRecycle: 0, CategoryID: 11,
    Attack: 0, Defence: 0, Agility: 0, Luck: 0, Level: 1, Quality: 1, MaxCount: maxCount, NeedSex: 0, NeedLevel: 1,
    CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
    Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
    BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
  await h.db.insert(game.Shop_Goods).values([[11019, "强化石1级"], [11001, "朱雀石1级"], [11021, "强化石2级"], [11002, "朱雀石2级"]].map(([id, name]) => ({ ...base, TemplateID: Number(id), Name: String(name) }))).onConflictDoNothing();
}
export async function exchangeFixture(h: DbHandle, id = 905, templateId = 11019, count = 40) {
  const name = `native-exchange-${id}`;
  await h.db.insert(member.Accounts).values({ ID: id, UserName: name, PasswordHash: "tests-only" }).onConflictDoNothing();
  const [who] = await h.db.insert(player.Sys_Users_Detail).values({ UserID: id, UserName: name, NickName: `兑换角色${id}`, Password: "test", IsFirst: 1, ForbidDate: new Date("2000-01-01Z") }).returning();
  const info = (await loadPlayerInfo(h.db, who!.UserID))!, tpl = new Templates();
  tpl.items = new Map((await h.db.select().from(game.Shop_Goods)).map(t => [t.TemplateID, t]));
  const frames: Uint8Array[] = [];
  const ctx = { db: h, templates: tpl, now: () => new Date(), world: new World(), cfg: { LOGIN_TIMEOUT_SEC: 0, PACKET_RATE_PER_SEC: 100, PACKET_RATE_BURST: 100 },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }, rooms: { waitingRemove: () => {} }, lang: { t: (s: string) => s } } as unknown as ServerContext;
  const client = new GameClient({ kind: "fake", remoteAddress: "test", write: b => frames.push(b), close: () => {} }, ctx, new HandlerRegistry());
  const p = new GamePlayer(client, info, defaultMatch(id), 1, "test"); client.player = p; ctx.world.add(p);
  const [row] = await h.db.insert(player.Sys_Users_Goods).values({ UserID: id, TemplateID: templateId, BagType: 1, Place: 0, Count: count }).returning();
  const material = ItemInfo.fromRow(row!, tpl.findItem(templateId)!); p.propBag.loadItems([material]); frames.length = 0;
  return { p, ctx, client, material, frames, input: { actor: { accountId: id, accountName: name }, characterId: id } };
}
