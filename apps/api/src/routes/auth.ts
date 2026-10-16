/** Site + launcher auth (member."Accounts", scrypt) and the play config (flashvars incl. the one-time web key). */
import { issueWebKey } from "@ddt/auth";
import { app as appTables, checkLogin, findAccount, hashPassword, verifyPassword, Accounts } from "@ddt/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import { q } from "../lib/db.js";
import { signJwt, verifyJwt, type Claims } from "../lib/jwt.js";

export async function roleOf(ctx: AppCtx, acc: { ID: number; IsAdmin: boolean }): Promise<string> {
  const [r] = await ctx.h.db.select().from(appTables.AccountRoles).where(eq(appTables.AccountRoles.AccountID, acc.ID)).limit(1);
  if (r && r.active) return r.role;
  return acc.IsAdmin ? "admin" : "player";
}

export function authOf(ctx: AppCtx, req: FastifyRequest): Claims | null {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? verifyJwt(m[1]!, ctx.cfg.JWT_SECRET) : null;
}

export function requireUser(ctx: AppCtx) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const c = authOf(ctx, req);
    if (!c) return reply.code(401).send({ message: "请先登录" });
    (req as FastifyRequest & { user: Claims }).user = c;
  };
}

export function requireAdmin(ctx: AppCtx) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const c = authOf(ctx, req);
    if (!c) return reply.code(401).send({ message: "请先登录" });
    if (c.role !== "admin") return reply.code(403).send({ message: "此功能仅限管理员使用" });
    (req as FastifyRequest & { user: Claims }).user = c;
  };
}

export const userOf = (req: FastifyRequest) => (req as FastifyRequest & { user: Claims }).user;

const publicUser = (acc: { ID: number; UserName: string; Email: string | null }, role: string) => ({ id: acc.ID, username: acc.UserName, email: acc.Email ?? "", role });

/** Everything the page / launcher needs to start the Flash client for `userName` (issues a fresh one-time key). */
export async function playConfig(ctx: AppCtx, acc: { ID: number; UserName: string } | null, ip?: string) {
  const c = ctx.cfg;
  const base = c.PUBLIC_URL;
  let flashvars: Record<string, string> = { user: "", key: "", config: `${base}/flash/config.xml` };
  let expiresAt: string | undefined;
  if (acc) {
    const t = await issueWebKey(ctx.h, acc.UserName, { accountId: acc.ID, ttlMinutes: c.LOGIN_KEY_TTL_MIN, ip });
    flashvars = { user: acc.UserName.toLowerCase(), key: t.key, config: `${base}/flash/config.xml` };
    expiresAt = t.expiresAt.toISOString();
  }
  const proxy = [{ host: c.GAME_HOST, port: c.GAME_PORT, proxyUrl: c.GAME_WS_URL }];
  if (c.GAME_HOST === "127.0.0.1") proxy.push({ host: "localhost", port: c.GAME_PORT, proxyUrl: c.GAME_WS_URL });
  return {
    rufflePath: c.RUFFLE_URL || `${base}/ruffle/ruffle.js`,
    swfUrl: `${base}/flash/Loading.swf`,
    base: `${base}/flash/`,
    flashvars,
    socketProxy: proxy,
    socket: { host: c.GAME_HOST, port: c.GAME_PORT, policyPort: c.POLICY_PORT },
    wsUrl: c.GAME_WS_URL,
    requestUrl: `${base}/request/`,
    resourceUrl: `${base}/resource/`,
    flashUrl: `${base}/flash/`,
    configUrl: `${base}/flash/config.xml`,
    expiresAt,
  };
}

const NAME_RE = /^[A-Za-z0-9_.]{3,32}$/;

export async function authRoutes(f: FastifyInstance, ctx: AppCtx) {
  const issue = async (acc: Awaited<ReturnType<typeof findAccount>> & object, ip: string) => {
    const role = await roleOf(ctx, acc);
    const token = signJwt({ sub: acc.ID, name: acc.UserName, role }, ctx.cfg.JWT_SECRET, ctx.cfg.JWT_TTL);
    const play = await playConfig(ctx, acc, ip);
    return { token, user: publicUser(acc, role), play: { flashvars: play.flashvars, swfUrl: play.swfUrl, expiresAt: play.expiresAt }, game: play };
  };

  f.post("/api/auth/register", async (req, reply) => {
    const b = z.object({ username: z.string(), email: z.string().optional().default(""), password: z.string() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ message: "提交的信息无效" });
    const { username, email, password } = b.data;
    if (!NAME_RE.test(username)) return reply.code(400).send({ message: "用户名须由3至32个英文字母、数字、下划线或点组成" });
    if (password.length < 6) return reply.code(400).send({ message: "密码至少需要6个字符" });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ message: "邮箱地址格式不正确" });
    if (await findAccount(ctx.h, username)) return reply.code(409).send({ message: "该用户名已被使用" });
    const [acc] = await ctx.h.db.insert(Accounts).values({ UserName: username, Email: email || null, PasswordHash: await hashPassword(password) }).returning();
    return reply.code(201).send(await issue(acc!, req.ip));
  });

  f.post("/api/auth/login", async (req, reply) => {
    const b = z.object({ username: z.string().min(1), password: z.string().min(1) }).passthrough().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ message: "请输入用户名和密码" });
    const existing = await findAccount(ctx.h, b.data.username);
    if (existing?.IsBanned) return reply.code(403).send({ message: existing.BanReason ? `账号已被封禁：${existing.BanReason}` : "账号已被封禁" });
    const acc = await checkLogin(ctx.h, b.data.username, b.data.password);
    if (!acc) return reply.code(401).send({ message: "用户名或密码错误" });
    await ctx.h.db.update(Accounts).set({ LastLoginAt: new Date(), LastLoginIP: req.ip }).where(eq(Accounts.ID, acc.ID));
    const out = await issue(acc, req.ip);
    // maintenance: only admins may enter
    const m = await maintenance(ctx);
    if (m.on && out.user.role !== "admin") return reply.code(503).send({ message: m.message || "服务器维护中" });
    return out;
  });

  f.get("/api/auth/me", { preHandler: requireUser(ctx) }, async (req, reply) => {
    const acc = await findAccount(ctx.h, userOf(req).name);
    if (!acc) return reply.code(401).send({ message: "请先登录" });
    return { user: publicUser(acc, await roleOf(ctx, acc)) };
  });

  f.get("/api/account/me", { preHandler: requireUser(ctx) }, async (req, reply) => {
    const acc = await findAccount(ctx.h, userOf(req).name);
    if (!acc) return reply.code(401).send({ message: "请先登录" });
    const chars = await q(
      ctx.h,
      sql`SELECT "UserID","NickName","Grade","Gold","Money","Sex","ConsortiaName" FROM app."V_Sys_Users_Detail" WHERE lower("UserName") = lower(${acc.UserName}) AND "NickName" <> '' ORDER BY "UserID"`,
    );
    return {
      user: publicUser(acc, await roleOf(ctx, acc)),
      characters: chars.map((c) => ({
        id: c.UserID,
        nickname: c.NickName,
        level: c.Grade,
        gold: c.Gold,
        money: c.Money,
        sex: c.Sex ? "m" : "f",
        guild: (c.ConsortiaName as string) || null,
      })),
    };
  });

  f.post("/api/account/password", { preHandler: requireUser(ctx) }, async (req, reply) => {
    const b = z.object({ currentPassword: z.string(), newPassword: z.string().min(6) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ message: "新密码至少需要6个字符" });
    const acc = await findAccount(ctx.h, userOf(req).name);
    if (!acc || !(await verifyPassword(b.data.currentPassword, acc.PasswordHash))) return reply.code(400).send({ message: "原密码错误" });
    await ctx.h.db.update(Accounts).set({ PasswordHash: await hashPassword(b.data.newPassword) }).where(eq(Accounts.ID, acc.ID));
    return reply.code(204).send();
  });

  /** Fresh play config for the logged-in user (new one-time key each call). */
  f.get("/api/play/config", { preHandler: requireUser(ctx) }, async (req, reply) => {
    const acc = await findAccount(ctx.h, userOf(req).name);
    if (!acc || acc.IsBanned) return reply.code(401).send({ message: "请先登录" });
    return playConfig(ctx, acc, req.ip);
  });
}

export async function maintenance(ctx: AppCtx): Promise<{ on: boolean; message: string }> {
  const [s] = await ctx.h.db.select().from(appTables.Settings).where(eq(appTables.Settings.key, "server-config")).limit(1);
  const v = (s?.value ?? {}) as Record<string, unknown>;
  return { on: !!v.maintenance, message: String(v.maintenanceMessage ?? "") };
}
