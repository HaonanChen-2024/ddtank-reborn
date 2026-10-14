// Hand-written (not generated). New tables for DDTank Reborn that have no equivalent in the original SQL Server DBs.
// Owner: apps/api (written by the API/admin, read by apps/game). See apps/api/README.md "Login tickets".
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, varchar } from "drizzle-orm/pg-core";

/** Postgres schema for the new stack's own tables. */
export const appSchema = pgSchema("app");

const ts = (name: string) => timestamp(name, { precision: 3, mode: "date" });

/**
 * app."LoginSessions" — replaces Tank.Request `PlayerManager` (in-memory name -> key dictionary) so that the API,
 * the launcher flow and apps/game share it.
 *
 * Lifecycle (mirrors CreateLogin.aspx -> Login.ashx -> socket LOGIN):
 *  1. web/launcher login (or CreateLogin.aspx with md5 content) -> upsert {UserName, WebKey, ExpiresAt}  (PlayerManager.Add)
 *  2. Login.ashx: RSA blob "user,key,tempPwd,nick" -> WebKey must match and not be expired (PlayerManager.Login),
 *     then GameKey = tempPwd, Count++ (PlayerManager.Update)
 *  3. apps/game socket LOGIN "user,tempPwd" -> GameKey must match and GameKeyExpiresAt > now.
 */
export const LoginSessions = appSchema.table(
  "LoginSessions",
  {
    /** lower(account name), as PlayerManager stored name.ToLower(). Prefixed "<site>_" for per-site keys (GetNameBySite). */
    UserName: varchar("UserName", { length: 200 }).notNull(),
    AccountID: integer("AccountID"),
    /** One-time web key given to Loading.swf as flashvar `key` (uppercase GUID like the original LoginGame.aspx). */
    WebKey: varchar("WebKey", { length: 64 }).notNull(),
    /** Session password chosen by the client in Login.ashx (6 random a-z), used by the socket LOGIN. */
    GameKey: varchar("GameKey", { length: 64 }),
    Site: varchar("Site", { length: 64 }).notNull().default(""),
    /** PlayerManager.Count: number of Login.ashx successes for this key (0 = first login). */
    Count: integer("Count").notNull().default(0),
    UserID: integer("UserID"),
    CreatedAt: ts("CreatedAt").notNull().defaultNow(),
    UpdatedAt: ts("UpdatedAt").notNull().defaultNow(),
    ExpiresAt: ts("ExpiresAt").notNull(),
    GameKeyExpiresAt: ts("GameKeyExpiresAt"),
    LastIP: varchar("LastIP", { length: 64 }),
  },
  (t) => [primaryKey({ name: "LoginSessions_pkey", columns: [t.UserName] })],
);

/** app."Settings" — key/value store (server-config page, launcher manifest overrides, ...). */
export const Settings = appSchema.table("Settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
});

/** app."News" — site / launcher news. */
export const News = appSchema.table(
  "News",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    summary: text("summary").notNull().default(""),
    body: text("body"),
    category: varchar("category", { length: 32 }).notNull().default("news"),
    cover: text("cover"),
    url: text("url"),
    publishedAt: ts("publishedAt").notNull().defaultNow(),
    published: boolean("published").notNull().default(true),
    createdAt: ts("createdAt").notNull().defaultNow(),
  },
  (t) => [index("IX_News_publishedAt").on(t.publishedAt)],
);

/** app."Bots" — AI opponents for PvP rooms (read by apps/game). */
export const Bots = appSchema.table("Bots", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  nickname: varchar("nickname", { length: 40 }).notNull(),
  sex: varchar("sex", { length: 1 }).notNull().default("m"),
  level: integer("level").notNull().default(10),
  difficulty: varchar("difficulty", { length: 16 }).notNull().default("normal"),
  weaponTemplateId: integer("weaponTemplateId").notNull().default(7001),
  equips: jsonb("equips").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
  guild: varchar("guild", { length: 40 }),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

/** app."Texts" — client language strings (ui/<lang>/language.txt) editable in the admin. */
export const Texts = appSchema.table("Texts", {
  key: varchar("key", { length: 300 }).primaryKey(),
  group: varchar("group", { length: 120 }).notNull().default(""),
  ptBR: text("ptBR").notNull().default(""),
  en: text("en"),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
});

/**
 * app."Translations" — pt-BR (or other) overlay for game-data text (Shop_Goods, Quest, Game_Map, NPC_Info,
 * Mission_Info/Pve_Info, Achievement, ...) that lives in the `game` schema (vendor-sourced, still Vietnamese/
 * Chinese). Looked up by (table, column, rowId) at template-load time in apps/game and apps/api, gated by
 * config DEFAULT_LANG; falls back to the original `game` schema value when no row matches. Exported/imported
 * in bulk via packages/db/scripts/export-texts.ts and import-translations.ts (data/i18n/pt-BR/db/*.json).
 * Admin "Texts > Game data" edits rows here directly (see docs/ROADMAP.md "Localização PT-BR").
 */
export const Translations = appSchema.table(
  "Translations",
  {
    /** game-schema table name, e.g. "Game_Map", "Shop_Goods". */
    table: varchar("table", { length: 100 }).notNull(),
    /** game-schema column name, e.g. "Name", "Description". */
    column: varchar("column", { length: 100 }).notNull(),
    /** stringified primary key of the source row (works for int and composite-less string PKs alike). */
    rowId: varchar("rowId", { length: 64 }).notNull(),
    lang: varchar("lang", { length: 8 }).notNull().default("pt-BR"),
    text: text("text").notNull(),
    /** original source value at the time of translation, for drift detection when the vendor table is re-seeded. */
    sourceText: text("sourceText"),
    updatedAt: ts("updatedAt").notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "Translations_pkey", columns: [t.table, t.column, t.rowId, t.lang] })],
);

/** app."Logs" — admin actions, transactions and server events. */
export const Logs = appSchema.table(
  "Logs",
  {
    id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
    at: ts("at").notNull().defaultNow(),
    level: varchar("level", { length: 8 }).notNull().default("info"),
    category: varchar("category", { length: 40 }).notNull(),
    actor: varchar("actor", { length: 200 }),
    message: text("message").notNull(),
    data: jsonb("data"),
  },
  (t) => [index("IX_Logs_at").on(t.at)],
);

/** app."AccountRoles" — panel role of a member."Accounts" row ("admin" | "gm"). IsAdmin stays the source of truth for "admin". */
export const AccountRoles = appSchema.table("AccountRoles", {
  AccountID: integer("AccountID").primaryKey(),
  role: varchar("role", { length: 16 }).notNull().default("admin"),
  active: boolean("active").notNull().default(true),
});

/** app."MailBroadcasts" — history of admin mail sends. */
export const MailBroadcasts = appSchema.table("MailBroadcasts", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  sentAt: ts("sentAt").notNull().defaultNow(),
  subject: varchar("subject", { length: 200 }).notNull(),
  target: varchar("target", { length: 32 }).notNull(),
  recipients: integer("recipients").notNull().default(0),
  sentBy: varchar("sentBy", { length: 200 }),
  payload: jsonb("payload"),
});

/** app."Servers" — live game-server registry: apps/game upserts on boot + heartbeats online count; apps/api/admin read it. */
export const Servers = appSchema.table("Servers", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  /** REAL TCP port (ServerList.ashx advertises port - 69). */
  port: integer("port").notNull(),
  wsUrl: text("wsUrl"),
  state: integer("state").notNull().default(1),
  online: integer("online").notNull().default(0),
  lastSeenAt: ts("lastSeenAt").notNull().defaultNow(),
});

/**
 * app."EventClaims" — one row per reward already claimed (idempotency for every event/activity claim in apps/game and
 * apps/api: daily award per day, sign-in reward per month+count, time box, activity codes, accumulative login, ...).
 * INSERT ... ON CONFLICT DO NOTHING RETURNING decides who wins a repeated/concurrent claim.
 */
export const EventClaims = appSchema.table(
  "EventClaims",
  {
    UserID: integer("UserID").notNull(),
    Kind: varchar("Kind", { length: 32 }).notNull(),
    Key: varchar("Key", { length: 64 }).notNull(),
    ClaimedAt: ts("ClaimedAt").notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "EventClaims_pkey", columns: [t.UserID, t.Kind, t.Key] })],
);

/**
 * app."ScheduledEvents" — weekly schedule of the timed systems run by apps/game `EventScheduler` (world boss, league,
 * elite championship, weekly reset, double exp/gold windows). The original had these timers commented out
 * (GameServer.cs:316, ActiveSystemMgr). Times are UTC "HH:MM"; weekdays "0..6" (0 = Sunday). Edited in the admin
 * Events page; apps/api POSTs /reload-templates on the game internal channel after each write.
 */
export const ScheduledEvents = appSchema.table("ScheduledEvents", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  kind: varchar("kind", { length: 32 }).notNull(),
  title: text("title").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  weekdays: varchar("weekdays", { length: 20 }).notNull().default("0,1,2,3,4,5,6"),
  startTime: varchar("startTime", { length: 5 }).notNull().default("00:00"),
  durationMin: integer("durationMin").notNull().default(60),
  startDate: ts("startDate"),
  endDate: ts("endDate"),
  params: jsonb("params").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
});

/** Local activity points are independent of game currencies; serialized by the wallet row lock. */
export const ActivityWallet = appSchema.table("ActivityWallet", {
  UserID: integer("UserID").primaryKey(),
  Points: integer("Points").notNull().default(0),
  Earned: integer("Earned").notNull().default(0),
  Revision: integer("Revision").notNull().default(0),
}, (t) => [check("ActivityWallet_nonnegative", sql`${t.Points} >= 0 AND ${t.Earned} >= 0 AND ${t.Revision} >= 0`)]);

/** Server-private boards and temporary prize bags, committed with points and reward mail. */
export const ActivityStates = appSchema.table("ActivityStates", {
  UserID: integer("UserID").notNull().references(() => ActivityWallet.UserID),
  Activity: varchar("Activity", { length: 32 }).notNull(),
  State: jsonb("State").notNull(),
}, (t) => [primaryKey({ name: "ActivityStates_pkey", columns: [t.UserID, t.Activity] })]);

/** A retry returns the committed result; reusing an id with a different payload is rejected. */
export const ActivityActions = appSchema.table("ActivityActions", {
  UserID: integer("UserID").notNull().references(() => ActivityWallet.UserID),
  RequestID: varchar("RequestID", { length: 36 }).notNull(),
  Signature: text("Signature").notNull(),
  Result: jsonb("Result").notNull(),
  CreatedAt: ts("CreatedAt").notNull().defaultNow(),
}, (t) => [primaryKey({ name: "ActivityActions_pkey", columns: [t.UserID, t.RequestID] })]);
