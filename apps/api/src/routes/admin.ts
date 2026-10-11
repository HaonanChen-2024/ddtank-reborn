/** Admin REST (role admin): generic CRUD over the RESOURCES whitelist + server-config, stats, assets, mail, templates. */
import { app as appTables, Accounts, findAccount, hashPassword } from "@ddt/db";
import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import os from "node:os";
import type { AppCtx } from "../context.js";
import { q } from "../lib/db.js";
import { wallNow } from "../lib/flash-xml.js";
import { safeKey } from "../lib/storage.js";
import { checkWardrobe } from "../lib/wardrobe.js";
import { RESOURCES, type ResourceDef } from "./admin-resources.js";
import { requireAdmin, userOf } from "./auth.js";
import { gameInternal, gameInternalPost, setting } from "./public.js";

type Row = Record<string, unknown>;
const ID_SEP = "~";

function cols(t: PgTable): Record<string, PgColumn> {
  return getTableColumns(t) as Record<string, PgColumn>;
}
const tableKey = (t: PgTable) => {
  const c = getTableConfig(t);
  return `${c.schema ?? "public"}.${c.name}`;
};

/** Converts JSON values to what the column expects (ISO strings -> Date for timestamps, numbers from strings). */
function coerce(col: PgColumn, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  const dt = col.dataType;
  if (dt === "date" || col.columnType.includes("Timestamp")) return v instanceof Date ? v : new Date(String(v));
  if (dt === "number") return typeof v === "number" ? v : Number(v);
  if (dt === "boolean") return typeof v === "boolean" ? v : v === "true" || v === 1 || v === "1";
  if (dt === "string" && typeof v !== "string") return typeof v === "object" ? JSON.stringify(v) : String(v);
  return v;
}

function pick(def: ResourceDef, body: Row, opts: { allowPk: boolean }): Row {
  const c = cols(def.table);
  const out: Row = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    const col = c[k];
    if (!col || def.hidden?.includes(k)) continue;
    if (!opts.allowPk && def.pk.includes(k)) continue;
    out[k] = coerce(col, v);
  }
  return out;
}

function pkWhere(def: ResourceDef, id: string): SQL | undefined {
  const parts = decodeURIComponent(id).split(ID_SEP);
  if (parts.length !== def.pk.length) return undefined;
  const c = cols(def.table);
  return and(...def.pk.map((k, i) => eq(c[k]!, coerce(c[k]!, parts[i]))));
}

function strip(def: ResourceDef, r: Row): Row {
  if (!def.hidden) return r;
  const o = { ...r };
  for (const h of def.hidden) delete o[h];
  return o;
}

export async function audit(ctx: AppCtx, actor: string | null, category: string, message: string, data?: unknown, level = "info") {
  try {
    await ctx.h.db.insert(appTables.Logs).values({ actor, category, message, data: data as object, level });
  } catch (e) {
    ctx.log.warn(`audit failed: ${(e as Error).message}`);
  }
}

/** Defaults of the server-config page, from env; stored overrides in app."Settings"("server-config"). */
export function serverConfigDefaults(ctx: AppCtx): Row {
  const c = ctx.cfg;
  return {
    publicHost: c.GAME_HOST,
    publicIps: [c.GAME_HOST],
    tcpPort: c.GAME_PORT,
    wsUrl: c.GAME_WS_URL,
    policyPort: c.POLICY_PORT,
    resourceUrl: `${c.PUBLIC_URL}/resource/`,
    requestUrl: `${c.PUBLIC_URL}/request/`,
    flashUrl: `${c.PUBLIC_URL}/flash/`,
    expRate: 1,
    goldRate: 1,
    dropRate: 1,
    offerRate: 1,
    maxPlayers: 1000,
    maintenance: false,
    maintenanceMessage: "",
    motd: "",
    /** Elevation angles (degrees) for the Play page's "Âng. N: Distância | Força" reference tables, computed by
     *  GET /api/public/aim-tables (`@ddt/fight` `computeAimTable`, same physics as the server). */
    aimAngles: ["20", "30", "50", "65"],
  };
}

/** Applies stored network settings to the running config (ServerList.ashx, play config, config.xml). */
export function applyServerConfig(ctx: AppCtx, v: Row) {
  if (typeof v.publicHost === "string" && v.publicHost) ctx.cfg.GAME_HOST = v.publicHost;
  if (Number(v.tcpPort)) ctx.cfg.GAME_PORT = Number(v.tcpPort);
  if (typeof v.wsUrl === "string" && v.wsUrl) ctx.cfg.GAME_WS_URL = v.wsUrl;
  if (Number(v.policyPort)) ctx.cfg.POLICY_PORT = Number(v.policyPort);
}

const memSeries: { t: string; v: number }[] = [];
const cpuSeries: { t: string; v: number }[] = [];
let lastCpu = process.cpuUsage();
let lastT = Date.now();
export function sampleProcess() {
  const now = Date.now();
  const cu = process.cpuUsage(lastCpu);
  const pct = ((cu.user + cu.system) / 1000 / Math.max(1, now - lastT)) * 100;
  lastCpu = process.cpuUsage();
  lastT = now;
  const t = new Date(now).toISOString();
  cpuSeries.push({ t, v: Math.round(pct * 10) / 10 });
  memSeries.push({ t, v: Math.round(process.memoryUsage().rss / 1048576) });
  if (cpuSeries.length > 60) cpuSeries.shift();
  if (memSeries.length > 60) memSeries.shift();
}

export async function adminRoutes(f: FastifyInstance, ctx: AppCtx) {
  // drop whitelist entries whose PK columns don't exist (defensive: heaps without a real key)
  for (const [name, def] of Object.entries(RESOURCES)) {
    const c = cols(def.table);
    if (!def.pk.every((k) => c[k])) {
      ctx.log.warn(`admin resource "${name}" disabled: pk ${def.pk.join(",")} not in ${tableKey(def.table)}`);
      delete RESOURCES[name];
    }
  }

  const guard = requireAdmin(ctx);
  const actor = (req: FastifyRequest) => userOf(req)?.name ?? null;

  // ---- specific endpoints (registered before the generic :resource routes) ----
  f.post("/api/admin/items/wardrobe-check", { preHandler: guard }, async (req, reply) => {
    try { return checkWardrobe(ctx.resources, req.body, ctx.cfg.PUBLIC_URL); }
    catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : "Invalid wardrobe draft" }); }
  });

  f.get("/api/admin/stats", { preHandler: guard }, async () => {
    const g = await gameInternal<Row>(ctx, "/stats");
    sampleProcess();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const [reg] = await ctx.h.db.select({ n: count() }).from(Accounts).where(sql`${Accounts.CreatedAt} >= ${today}`);
    const sc = { ...serverConfigDefaults(ctx), ...((await setting<Row>(ctx, "server-config")) ?? {}) };
    return {
      onlinePlayers: 0,
      capacity: Number(sc.maxPlayers ?? 1000),
      rooms: 0,
      matchesInProgress: 0,
      matchesToday: 0,
      uptimeSec: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
      cpu: [...cpuSeries],
      mem: [...memSeries],
      memTotalMb: Math.round(os.totalmem() / 1048576),
      ...(g ?? {}),
      registeredToday: Number(reg?.n ?? 0),
      gameOnline: !!g,
    };
  });

  f.get("/api/admin/server-config", { preHandler: guard }, async () => ({ ...serverConfigDefaults(ctx), ...((await setting<Row>(ctx, "server-config")) ?? {}) }));
  f.put("/api/admin/server-config", { preHandler: guard }, async (req) => {
    const v = { ...serverConfigDefaults(ctx), ...((await setting<Row>(ctx, "server-config")) ?? {}), ...((req.body as Row) ?? {}) };
    await ctx.h.db
      .insert(appTables.Settings)
      .values({ key: "server-config", value: v })
      .onConflictDoUpdate({ target: appTables.Settings.key, set: { value: v, updatedAt: new Date() } });
    applyServerConfig(ctx, v);
    await audit(ctx, actor(req), "config", "server-config updated", v);
    return v;
  });

  // ---- assets / uploads ----
  const upload = async (req: FastifyRequest) => {
    const parts = req.parts();
    let folder = "uploads";
    let file: { name: string; body: Buffer; type: string } | undefined;
    for await (const p of parts) {
      if (p.type === "file") file = { name: p.filename, body: await p.toBuffer(), type: p.mimetype };
      else if (p.fieldname === "folder") folder = String(p.value ?? "uploads");
    }
    if (!file) return null;
    const key = `${safeKey(folder)}/${safeKey(file.name)}`;
    const asset = await ctx.storage.put(key, file.body, file.type);
    if (ctx.storage.kind === "local" && ctx.storage.dir) ctx.resources.trees[0]?.add(asset.key, `${ctx.storage.dir}/${asset.key}`);
    await audit(ctx, actor(req), "assets", `upload ${asset.key}`, { size: asset.size });
    return asset;
  };
  f.post("/api/admin/uploads", { preHandler: guard }, async (req, reply) => {
    const a = await upload(req);
    if (!a) return reply.code(400).send({ message: "Arquivo ausente" });
    return reply.code(201).send({ url: a.url, key: a.key });
  });
  f.post("/api/admin/assets", { preHandler: guard }, async (req, reply) => {
    const a = await upload(req);
    if (!a) return reply.code(400).send({ message: "Arquivo ausente" });
    return reply.code(201).send(a);
  });
  f.get<{ Querystring: { prefix?: string } }>("/api/admin/assets", { preHandler: guard }, async (req) => ctx.storage.list(req.query.prefix ?? ""));
  f.get("/api/admin/assets/misses", { preHandler: guard }, async () =>
    [...ctx.resources.misses.entries()].sort((a, b) => b[1] - a[1]).map(([path, count]) => ({ path, count })),
  );
  f.delete<{ Params: { key: string } }>("/api/admin/assets/:key", { preHandler: guard }, async (req, reply) => {
    const key = decodeURIComponent(req.params.key);
    await ctx.storage.remove(key);
    ctx.resources.trees[0]?.remove(safeKey(key));
    await audit(ctx, actor(req), "assets", `delete ${key}`);
    return reply.code(204).send();
  });

  // ---- events / scheduler (apps/game internal channel) ----
  f.get("/api/admin/events/status", { preHandler: guard }, async (_req, reply) => (await gameInternal(ctx, "/events")) ?? reply.code(503).send({ message: "Servidor de jogo indisponível" }));
  f.post("/api/admin/events/start", { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as Row;
    const r = await gameInternalPost(ctx, "/events/start", { kind: String(b.kind ?? ""), minutes: Number(b.minutes ?? 30) });
    await audit(ctx, actor(req), "events", `start ${b.kind} ${b.minutes ?? 30} min`);
    return r ?? reply.code(503).send({ message: "Servidor de jogo indisponível" });
  });
  f.post("/api/admin/events/stop", { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as Row;
    const r = await gameInternalPost(ctx, "/events/stop", { kind: String(b.kind ?? "") });
    await audit(ctx, actor(req), "events", `stop ${b.kind}`);
    return r ?? reply.code(503).send({ message: "Servidor de jogo indisponível" });
  });
  f.post("/api/admin/events/reload", { preHandler: guard }, async (req, reply) => {
    const r = await gameInternalPost(ctx, "/reload-templates");
    await audit(ctx, actor(req), "events", "reload");
    return r ?? reply.code(503).send({ message: "Servidor de jogo indisponível" });
  });
  /** Activation codes for an Active with HasKey 1/4 (player."Active_Number"), like the GameAdmin code generator. */
  f.post<{ Params: { id: string } }>("/api/admin/events/:id/codes", { preHandler: guard }, async (req) => {
    const b = (req.body ?? {}) as Row;
    const n = Math.max(1, Math.min(1000, Number(b.count ?? 10)));
    const mark = Number(b.mark ?? 0);
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const codes: string[] = [];
    for (let i = 0; i < n; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(14));
      codes.push(Array.from(bytes, (x) => alphabet[x % alphabet.length]).join(""));
    }
    for (const c of codes) await ctx.h.db.execute(sql`INSERT INTO player."Active_Number" ("AwardID","ActiveID","PullDown","UserID","Mark") VALUES (${c}, ${Number(req.params.id)}, false, 0, ${mark}) ON CONFLICT DO NOTHING`);
    await audit(ctx, actor(req), "events", `codes ${req.params.id} x${n}`);
    return { codes };
  });

  // ---- templates (XML cache) ----
  f.get("/api/admin/templates", { preHandler: guard }, async () =>
    ctx.cache.list().map((x) => ({ name: x.name, compressed: x.compressed, size: x.body.length, builtAt: x.builtAt, source: x.source })),
  );
  f.post("/api/admin/templates/rebuild", { preHandler: guard }, async (req) => {
    const t0 = Date.now();
    await ctx.cache.buildAll();
    await audit(ctx, actor(req), "templates", "rebuild all");
    return { ok: true, ms: Date.now() - t0, files: ctx.cache.list().length };
  });

  // ---- mail ----
  // drizzle expands a JS array param to a tuple ($1, $2), which `= ANY(...)` rejects: build IN (...) instead
  const nickIn = (names: string[]) => (names.length ? sql`"NickName" IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})` : sql`false`);
  f.post("/api/admin/mail/broadcast", { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as Row;
    if (!b.subject || !b.body) return reply.code(400).send({ message: "Assunto e mensagem são obrigatórios" });
    const target = String(b.target ?? "all");
    const where =
      target === "online"
        ? sql`"State" = 1`
        : target === "level"
          ? sql`"Grade" BETWEEN ${Number(b.levelMin ?? 1)} AND ${Number(b.levelMax ?? 100)}`
          : target === "list"
            ? nickIn((Array.isArray(b.nicknames) ? b.nicknames : []).map(String))
            : sql`true`;
    const users = await q(ctx.h, sql`SELECT "UserID","NickName" FROM player."Sys_Users_Detail" WHERE "IsExist" = true AND "NickName" <> '' AND ${where}`);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 5) as Row[];
    for (const u of users) await sendMail(ctx, Number(u.UserID), String(u.NickName), String(b.subject), String(b.body), { gold: Number(b.gold ?? 0), money: Number(b.money ?? 0), giftToken: Number(b.giftToken ?? 0), items });
    await ctx.h.db.insert(appTables.MailBroadcasts).values({ subject: String(b.subject), target, recipients: users.length, sentBy: actor(req), payload: b });
    await audit(ctx, actor(req), "mail", `broadcast "${b.subject}" to ${users.length}`);
    return { recipients: users.length };
  });

  // ---- player actions ----
  f.post<{ Params: { id: string; action: string } }>("/api/admin/players/:id/:action", { preHandler: guard }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = (req.body ?? {}) as Row;
    const [u] = await q(ctx.h, sql`SELECT "UserID","NickName" FROM player."Sys_Users_Detail" WHERE "UserID" = ${id}`);
    if (!u) return reply.code(404).send({ message: "Jogador não encontrado" });
    if (req.params.action === "ban") {
      const hours = Number(b.hours ?? 0);
      const until = new Date(wallNow().getTime() + (hours > 0 ? hours * 3600_000 : 100 * 365 * 86400_000));
      await ctx.h.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "ForbidDate" = ${until}, "ForbidReason" = ${String(b.reason ?? "")}, "IsExist" = false WHERE "UserID" = ${id}`);
    } else if (req.params.action === "unban") {
      await ctx.h.db.execute(sql`UPDATE player."Sys_Users_Detail" SET "ForbidDate" = ${new Date(Date.UTC(2000, 0, 1))}, "ForbidReason" = '', "IsExist" = true WHERE "UserID" = ${id}`);
    } else if (req.params.action === "give-item") {
      await sendMail(ctx, id, String(u.NickName), "GM", "Item", { items: [{ templateId: b.templateId, count: b.count, validDays: b.validDays }] });
    } else return reply.code(404).send({ message: "Ação desconhecida" });
    await audit(ctx, actor(req), "players", `${req.params.action} ${u.NickName} (${id})`, b);
    return { ok: true };
  });

  // ---- admin users (member.Accounts + app.AccountRoles) ----
  const R = appTables.AccountRoles;
  const adminRow = (a: typeof Accounts.$inferSelect, r?: typeof R.$inferSelect) => ({
    id: a.ID,
    username: a.UserName,
    email: a.Email ?? "",
    role: r?.role ?? (a.IsAdmin ? "admin" : "player"),
    active: r ? r.active : a.IsAdmin,
    lastLoginAt: a.LastLoginAt,
  });
  f.get("/api/admin/admin-users", { preHandler: guard }, async (req) => {
    const rows = await ctx.h.db.select().from(Accounts).leftJoin(R, eq(R.AccountID, Accounts.ID)).where(or(eq(Accounts.IsAdmin, true), sql`${R.AccountID} IS NOT NULL`));
    const items = rows.map((r) => adminRow(r.Accounts, r.AccountRoles ?? undefined));
    const qs = req.query as Row;
    return { items, total: items.length, page: Number(qs.page ?? 1), pageSize: Number(qs.pageSize ?? 20) };
  });
  f.post("/api/admin/admin-users", { preHandler: guard }, async (req, reply) => {
    const b = (req.body ?? {}) as Row;
    if (!b.username || !b.password) return reply.code(400).send({ message: "Usuário e senha são obrigatórios" });
    if (await findAccount(ctx.h, String(b.username))) return reply.code(409).send({ message: "username já existe" });
    const role = String(b.role ?? "admin");
    const [a] = await ctx.h.db.insert(Accounts).values({ UserName: String(b.username), Email: (b.email as string) ?? null, PasswordHash: await hashPassword(String(b.password)), IsAdmin: role === "admin" }).returning();
    await ctx.h.db.insert(R).values({ AccountID: a!.ID, role, active: b.active !== false });
    await audit(ctx, actor(req), "admin-users", `create ${a!.UserName} (${role})`);
    return reply.code(201).send(adminRow(a!, { AccountID: a!.ID, role, active: b.active !== false }));
  });
  f.patch<{ Params: { id: string } }>("/api/admin/admin-users/:id", { preHandler: guard }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = (req.body ?? {}) as Row;
    const [a] = await ctx.h.db.select().from(Accounts).where(eq(Accounts.ID, id));
    if (!a) return reply.code(404).send({ message: "Não encontrado" });
    const [cur] = await ctx.h.db.select().from(R).where(eq(R.AccountID, id));
    const role = String(b.role ?? cur?.role ?? (a.IsAdmin ? "admin" : "gm"));
    const active = b.active === undefined ? (cur?.active ?? true) : !!b.active;
    const set: Partial<typeof Accounts.$inferInsert> = { IsAdmin: role === "admin" && active };
    if (b.email !== undefined) set.Email = String(b.email);
    if (b.password) set.PasswordHash = await hashPassword(String(b.password));
    const [na] = await ctx.h.db.update(Accounts).set(set).where(eq(Accounts.ID, id)).returning();
    await ctx.h.db.insert(R).values({ AccountID: id, role, active }).onConflictDoUpdate({ target: R.AccountID, set: { role, active } });
    await audit(ctx, actor(req), "admin-users", `update ${a.UserName}`);
    return adminRow(na!, { AccountID: id, role, active });
  });
  f.get<{ Params: { id: string } }>("/api/admin/admin-users/:id", { preHandler: guard }, async (req, reply) => {
    const [r] = await ctx.h.db.select().from(Accounts).leftJoin(R, eq(R.AccountID, Accounts.ID)).where(eq(Accounts.ID, Number(req.params.id)));
    return r ? adminRow(r.Accounts, r.AccountRoles ?? undefined) : reply.code(404).send({ message: "Não encontrado" });
  });
  f.delete<{ Params: { id: string } }>("/api/admin/admin-users/:id", { preHandler: guard }, async (req, reply) => {
    const id = Number(req.params.id);
    if (id === userOf(req).sub) return reply.code(400).send({ message: "Você não pode remover a si mesmo" });
    await ctx.h.db.update(Accounts).set({ IsAdmin: false }).where(eq(Accounts.ID, id));
    await ctx.h.db.delete(R).where(eq(R.AccountID, id));
    await audit(ctx, actor(req), "admin-users", `revoke ${id}`);
    return reply.code(204).send();
  });

  // ---- generic CRUD ----
  const resolve = (name: string) => RESOURCES[name];

  f.get<{ Params: { resource: string }; Querystring: { q?: string; page?: string; pageSize?: string; sort?: string } }>(
    "/api/admin/:resource",
    { preHandler: guard },
    async (req, reply) => {
      const def = resolve(req.params.resource);
      if (!def) return reply.code(404).send({ message: "Recurso desconhecido" });
      const c = cols(def.table);
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 20));
      const conds: SQL[] = [];
      const needle = (req.query.q ?? "").trim();
      if (needle) {
        const ors: SQL[] = [];
        for (const [k, col] of Object.entries(c)) {
          if (def.hidden?.includes(k)) continue;
          if (col.dataType === "string" && !col.columnType.includes("Json")) ors.push(ilike(col, `%${needle.replace(/[%_\\]/g, (x) => "\\" + x)}%`));
          else if (col.dataType === "number" && /^-?\d+$/.test(needle)) ors.push(eq(col, Number(needle)));
        }
        if (ors.length) conds.push(or(...ors)!);
      }
      let order: SQL[] = def.pk.map((k) => asc(c[k]!));
      const sort = req.query.sort;
      if (sort) {
        const d = sort.startsWith("-");
        const col = c[d ? sort.slice(1) : sort];
        if (col) order = [d ? desc(col) : asc(col), ...order];
      }
      const where = conds.length ? and(...conds) : undefined;
      const [tot] = await ctx.h.db.select({ n: count() }).from(def.table).where(where);
      const rows = await ctx.h.db.select().from(def.table).where(where).orderBy(...order).limit(pageSize).offset((page - 1) * pageSize);
      return { items: (rows as Row[]).map((r) => strip(def, r)), total: Number(tot?.n ?? 0), page, pageSize };
    },
  );

  f.get<{ Params: { resource: string; id: string } }>("/api/admin/:resource/:id", { preHandler: guard }, async (req, reply) => {
    const def = resolve(req.params.resource);
    const w = def && pkWhere(def, req.params.id);
    if (!def || !w) return reply.code(404).send({ message: "Não encontrado" });
    const [row] = await ctx.h.db.select().from(def.table).where(w).limit(1);
    return row ? strip(def, row as Row) : reply.code(404).send({ message: "Não encontrado" });
  });

  const afterWrite = async (req: FastifyRequest, def: ResourceDef, what: string, data?: unknown) => {
    const files = await ctx.cache.invalidate([tableKey(def.table)]);
    // game-side caches (items/shop/maps + event templates + app."ScheduledEvents"): reload on the internal channel
    const key = tableKey(def.table);
    if (key.startsWith("game.") || key === "app.ScheduledEvents") void gameInternalPost(ctx, "/reload-templates");
    await audit(ctx, actor(req), "crud", `${what} ${tableKey(def.table)}${files.length ? ` (rebuilt ${files.join(", ")})` : ""}`, data);
  };

  f.post<{ Params: { resource: string } }>("/api/admin/:resource", { preHandler: guard }, async (req, reply) => {
    const def = resolve(req.params.resource);
    if (!def) return reply.code(404).send({ message: "Recurso desconhecido" });
    if (def.readOnly || def.noCreate) return reply.code(405).send({ message: "Criação não permitida" });
    const values = pick(def, req.body as Row, { allowPk: true });
    const w = def.pk.every((k) => values[k] !== undefined && values[k] !== null) ? pkWhere(def, def.pk.map((k) => String(values[k])).join(ID_SEP)) : undefined;
    if (w) {
      const [dup] = await ctx.h.db.select().from(def.table).where(w).limit(1);
      if (dup) return reply.code(409).send({ message: `${def.pk.join(" + ")} já existe` });
    }
    try {
      const [row] = (await ctx.h.db.insert(def.table).values(values as never).returning()) as Row[];
      await afterWrite(req, def, "create", values);
      return reply.code(201).send(strip(def, row ?? values));
    } catch (e) {
      return reply.code(400).send({ message: (e as Error).message.split("\n")[0] });
    }
  });

  f.patch<{ Params: { resource: string; id: string } }>("/api/admin/:resource/:id", { preHandler: guard }, async (req, reply) => {
    const def = resolve(req.params.resource);
    const w = def && pkWhere(def, req.params.id);
    if (!def || !w) return reply.code(404).send({ message: "Não encontrado" });
    if (def.readOnly) return reply.code(405).send({ message: "Somente leitura" });
    const values = pick(def, req.body as Row, { allowPk: false });
    if (!Object.keys(values).length) return reply.code(400).send({ message: "Nada para atualizar" });
    try {
      const rows = (await ctx.h.db.update(def.table).set(values as never).where(w).returning()) as Row[];
      if (!rows.length) return reply.code(404).send({ message: "Não encontrado" });
      await afterWrite(req, def, `update ${req.params.id}`, values);
      return strip(def, rows[0]!);
    } catch (e) {
      return reply.code(400).send({ message: (e as Error).message.split("\n")[0] });
    }
  });

  f.delete<{ Params: { resource: string; id: string } }>("/api/admin/:resource/:id", { preHandler: guard }, async (req, reply) => {
    const def = resolve(req.params.resource);
    const w = def && pkWhere(def, req.params.id);
    if (!def || !w) return reply.code(404).send({ message: "Não encontrado" });
    if (def.readOnly || def.noDelete) return reply.code(405).send({ message: "Exclusão não permitida" });
    await ctx.h.db.delete(def.table).where(w);
    await afterWrite(req, def, `delete ${req.params.id}`);
    return reply.code(204).send();
  });
  void inArray;
}

/** Writes a system mail with optional gold/money and up to 5 item attachments (Sys_Users_Goods rows referenced by Annex1..5). */
export async function sendMail(
  ctx: AppCtx,
  userId: number,
  nick: string,
  title: string,
  content: string,
  o: { gold?: number; money?: number; giftToken?: number; items?: Row[] } = {},
) {
  const now = wallNow();
  const annex: (number | null)[] = [];
  for (const it of (o.items ?? []).slice(0, 5)) {
    const tid = Number(it.templateId ?? it.TemplateID);
    if (!tid) continue;
    const res = await q(
      ctx.h,
      sql`INSERT INTO player."Sys_Users_Goods" ("UserID","BagType","TemplateID","Place","Count","IsJudge","Color","IsExist","StrengthenLevel","AttackCompose","DefendCompose","LuckCompose","AgilityCompose","IsBinds","BeginDate","ValidDate","IsUsed")
          VALUES (0, 0, ${tid}, -1, ${Math.max(1, Number(it.count ?? 1))}, true, '', true, 0, 0, 0, 0, 0, true, ${now}, ${Number(it.validDays ?? 0)}, false) RETURNING "ItemID"`,
    );
    annex.push(Number(res[0]?.ItemID ?? 0) || null);
  }
  const a = (i: number) => (annex[i] ? String(annex[i]) : null);
  await ctx.h.db.execute(sql`INSERT INTO player."User_Messages"
    ("SenderID","Sender","ReceiverID","Receiver","Title","Content","SendTime","IsRead","IsDelR","IfDelS","IsDelete","Annex1","Annex2","Annex3","Annex4","Annex5","Gold","Money","GiftToken","IsExist","Type","ValidDate","SendDate","Remark")
    VALUES (0, 'GM', ${userId}, ${nick}, ${title}, ${content}, ${now}, false, false, false, false, ${a(0)}, ${a(1)}, ${a(2)}, ${a(3)}, ${a(4)}, ${o.gold ?? 0}, ${o.money ?? 0}, ${o.giftToken ?? 0}, true, ${annex.length || o.gold || o.money ? 51 : 52}, 720, ${now}, '')`);
}
