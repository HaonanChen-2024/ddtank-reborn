/**
 * Whitelist: REST resource name -> Drizzle table (apps/admin/src/resources/*.ts names). Only these tables are reachable
 * through /api/admin/:resource. Composite keys are joined with "~" in URL ids.
 */
import { app, game, player, Accounts } from "@ddt/db";
import { and, asc, count, desc, eq, getTableColumns, or } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import type { AppCtx } from "../context.js";
import type { requireAdmin } from "./auth.js";

export interface ResourceDef {
  table: PgTable;
  pk: string[];
  readOnly?: boolean;
  noCreate?: boolean;
  noDelete?: boolean;
  /** Columns never returned (hashes). */
  hidden?: string[];
}

export const RESOURCES: Record<string, ResourceDef> = {
  // players
  players: { table: player.Sys_Users_Detail, pk: ["UserID"], noCreate: true, noDelete: true, hidden: ["Password", "PasswordTwo", "QuestSite"] },
  "player-items": { table: player.Sys_Users_Goods, pk: ["ItemID"] },
  "player-mail": { table: player.User_Messages, pk: ["ID"] },
  accounts: { table: Accounts, pk: ["ID"], hidden: ["PasswordHash"] },
  bots: { table: app.Bots, pk: ["id"] },
  // guilds (Sociedade)
  guilds: { table: player.Consortia, pk: ["ConsortiaID"], noCreate: true, noDelete: true },
  "guild-members": { table: player.Consortia_Users, pk: ["ID"], noCreate: true },
  "guild-duties": { table: player.Consortia_Duty, pk: ["DutyID"], noCreate: true, noDelete: true },
  "guild-applications": { table: player.Consortia_Apply_Users, pk: ["ID"], noCreate: true },
  "guild-events": { table: player.Consortia_Event, pk: ["ID"], noCreate: true, readOnly: true },
  "guild-tasks": { table: player.Consortia_Task_Info, pk: ["ID"], noCreate: true },
  "guild-levels": { table: player.Consortia_Level, pk: ["Level"] },
  // content
  items: { table: game.Shop_Goods, pk: ["TemplateID"] },
  shop: { table: game.Shop, pk: ["ID"] },
  "shop-show": { table: game.ShopGoodsShowList, pk: ["TempID"] },
  "item-box": { table: game.Shop_Goods_Box, pk: ["ID", "TemplateId"] },
  quests: { table: game.Quest, pk: ["ID"] },
  "quest-conditions": { table: game.Quest_Condiction, pk: ["QuestID", "CondictionID"] },
  "quest-goods": { table: game.Quest_Goods, pk: ["QuestID", "RewardItemID"] },
  events: { table: game.Active, pk: ["ActiveID"] },
  "scheduled-events": { table: app.ScheduledEvents, pk: ["id"] },
  "event-claims": { table: app.EventClaims, pk: ["UserID", "Kind", "Key"], noCreate: true },
  "event-codes": { table: player.Active_Number, pk: ["AwardID"] },
  "login-award": { table: game.Login_Award_Item_Template, pk: ["ID"] },
  "time-box": { table: game.LoadUserBox, pk: ["ID"] },
  "online-box": { table: game.User_Box, pk: ["ID"], readOnly: true },
  "event-awards": { table: game.Active_Award, pk: ["ID"] },
  "event-reward-info": { table: game.Event_Reward_Info, pk: ["ActivityType", "SubActivityType"] },
  "event-reward-goods": { table: game.Event_Reward_Goods, pk: ["ActivityType", "SubActivityType", "TemplateId"] },
  "activity-items": { table: game.Activity_System_Item, pk: ["ID"] },
  "daily-award": { table: game.Daily_Award, pk: ["ID"] },
  dungeons: { table: game.Pve_Info, pk: ["ID"] },
  missions: { table: game.Mission_Info, pk: ["Id"] },
  npcs: { table: game.NPC_Info, pk: ["ID"] },
  maps: { table: game.Game_Map, pk: ["ID"] },
  balls: { table: game.Ball, pk: ["ID"] },
  "drop-items": { table: game.Drop_Item, pk: ["Id"] },
  "drop-conditions": { table: game.Drop_Condiction, pk: ["DropId"] },
  achievements: { table: game.Achievement, pk: ["ID"] },
  edicts: { table: game.Edictum_List, pk: ["ID"] },
  "game-config": { table: game.Server_Config, pk: ["ID"] },
  "server-list": { table: player.Server_List, pk: ["ID"] },
  "player-config": { table: player.Server_Config, pk: ["ID"] },
  // site / system (new tables)
  texts: { table: app.Texts, pk: ["key"] },
  news: { table: app.News, pk: ["id"] },
  logs: { table: app.Logs, pk: ["id"], readOnly: true },
  "mail-broadcasts": { table: app.MailBroadcasts, pk: ["id"], readOnly: true },
};

/** Online rewards use User_Box Type 0; LoadUserBox remains the legacy writable resource. */
export function registerOnlineBoxReadRoutes(f: FastifyInstance, ctx: AppCtx, guard: ReturnType<typeof requireAdmin>) {
  const table = game.User_Box;
  const columns = getTableColumns(table);
  f.get<{ Querystring: { q?: string; page?: string; pageSize?: string; sort?: string } }>("/api/admin/online-box", { preHandler: guard }, async (req) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 20));
    const needle = (req.query.q ?? "").trim();
    const search = /^-?\d+$/.test(needle) ? or(...Object.values(columns).map((column) => eq(column, Number(needle)))) : undefined;
    const where = and(eq(table.Type, 0), search);
    const sort = req.query.sort ?? "ID";
    const field = sort.replace(/^-/, "");
    const column = Object.hasOwn(columns, field) ? columns[field as keyof typeof columns] : table.ID;
    const order = [sort.startsWith("-") ? desc(column) : asc(column)];
    if (column !== table.ID) order.push(asc(table.ID));
    const [total] = await ctx.h.db.select({ n: count() }).from(table).where(where);
    const items = await ctx.h.db.select().from(table).where(where).orderBy(...order).limit(pageSize).offset((page - 1) * pageSize);
    return { items, total: Number(total?.n ?? 0), page, pageSize };
  });
  f.get<{ Params: { id: string } }>("/api/admin/online-box/:id", { preHandler: guard }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!/^-?\d+$/.test(req.params.id) || !Number.isSafeInteger(id) || id < -2147483648 || id > 2147483647) {
      return reply.code(404).send({ message: "未找到相关记录" });
    }
    const [row] = await ctx.h.db.select().from(table).where(and(eq(table.Type, 0), eq(table.ID, id))).limit(1);
    return row ?? reply.code(404).send({ message: "未找到相关记录" });
  });
}
