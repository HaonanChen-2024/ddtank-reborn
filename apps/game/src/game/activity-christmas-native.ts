/** Original snowman window, explicit local task resources; no snowfield or inventory mutation. */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { app, member, player, activityUtcDay, validActivityDay, recordActivitySpending, ActivityAccountingError, type Database } from "@ddt/db";
import type { ServerContext } from "../session/context.js";
import type { GameClient } from "../session/client.js";
import type { GamePlayer } from "./player.js";
import { ItemInfo } from "./item.js";
import { saveItem } from "../db/items.js";
import { sendMail, type MailRow } from "../db/social.js";
import * as Out from "../packets/out.js";

export type ChristmasAuthority = "online" | "offline" | "unavailable";
export type ChristmasTask = "sign" | "mines" | "pair" | "explore";
export type ChristmasTier = 1 | 2 | 3 | 4;
export interface ChristmasReward { templateId: 11019 | 11001 | 11021 | 11002; name: string; itemCount: number; bound: true; validDays: 0 }
export interface ChristmasQuote { count: number; double: boolean; resourceCost: number; pointCost: number; experienceGained: number; canCraft: boolean; reason: string }
export interface ChristmasTierView { tier: ChristmasTier; title: string; repeatable: boolean; threshold: number; cycle: number; nextTarget: number; claimed: boolean; canClaim: boolean; reason: string; reward: ChristmasReward }
export interface ChristmasNativeView {
  version: 1; kind: "christmas-native"; rulesVersion: 1; catalogVersion: "christmas-snowman-local-v1";
  day: string; revision: number; authority: ChristmasAuthority; available: boolean; reason: string; stateToken: string | null;
  activity: { open: true; beginAt: "1970-01-01T00:00:00.000Z"; endAt: "2099-12-31T23:59:59.999Z"; title: string };
  snowfield: { available: false; reason: string }; currency: "local-task-points"; points: number; taskEarned: number; dailyActionsRemaining: number;
  snowman: { resource: "local-task-snowpacks"; resourceLabel: string; balance: number; entitlement: number; usedToday: number; count: number; exp: number; totalExp: 10;
    maxCount: number; maxDoubleCount: number; tasks: { id: ChristmasTask; claimKey: string; completed: boolean; packs: number }[]; quotes: ChristmasQuote[] };
  rewards: ChristmasTierView[]; rules: string[]; unavailable: { id: "original-economy" | "snowfield" | "official-snowpacks"; reason: string }[];
}
export type ChristmasAction = { type: "craft"; count: number; marked: boolean; choice: string } | { type: "claim"; tier: ChristmasTier; index: number; choice: string };
export type ChristmasEffect = { type: "crafted"; count: number; double: boolean; resourceCost: number; pointCost: number; experienceGained: number;
  before: { count: number; exp: number }; after: { count: number; exp: number }; isUp: boolean; committedRevision: number }
  | { type: "claimed"; tier: ChristmasTier; cycle: number; rewards: ChristmasReward[]; committedRevision: number };
export interface ChristmasEnvelope { requestId: string; effects: ChristmasEffect[] }
export interface ChristmasRead { actor: { accountId: number; accountName: string }; characterId: number }
export interface ChristmasCommand extends ChristmasRead { requestId: string; action: ChristmasAction }
export interface ChristmasResult { view: ChristmasNativeView; requestId: string; replayed: boolean; message: string; mailedCount: number; nativeChristmasAction?: ChristmasEnvelope }
export type ChristmasReply<T> = { ok: true; value: T } | { ok: false; status: number; message: string };
export interface ChristmasState { version: 1; kind: "christmas-native"; rulesVersion: 1; catalogVersion: "christmas-snowman-local-v1";
  day: string; freeUsed: number; count: number; exp: number; claimedMask: number; packsNumber: number; [key: string]: unknown }
export interface ChristmasReference { version: 1; day: string; daily: Record<string, unknown>; games: Record<string, unknown>; claims: string[]; [key: string]: unknown }
export interface ChristmasWallet { Points: number; Earned: number; Revision: number }
export class ChristmasError extends Error { constructor(message: string, readonly status = 409) { super(message); } }
export const CHRISTMAS_ID = "christmas-native", CHRISTMAS_CATALOG = "christmas-snowman-local-v1";
const MAX = 1_000_000_000;
const taskIds = ["sign", "mines", "pair", "explore"] as const, taskPacks = [5, 10, 10, 5];
const gifts: ChristmasReward[] = [
  { templateId: 11019, name: "强化石1级", itemCount: 3, bound: true, validDays: 0 },
  { templateId: 11001, name: "朱雀石1级", itemCount: 5, bound: true, validDays: 0 },
  { templateId: 11021, name: "强化石2级", itemCount: 8, bound: true, validDays: 0 },
  { templateId: 11002, name: "朱雀石2级", itemCount: 2, bound: true, validDays: 0 },
];
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, min = 0, max = 2147483647): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
function need(ok: unknown, message: string, status = 409): asserts ok { if (!ok) throw new ChristmasError(message, status); }
export function christmasCanonical(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(christmasCanonical).join(",")}]`;
  if (obj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${christmasCanonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const hash = (v: unknown) => createHash("sha256").update(christmasCanonical(v));
export const christmasSignature = (action: ChristmasAction) => hash({ activityId: CHRISTMAS_ID, action }).digest("hex");
export function validateChristmasAction(v: unknown): asserts v is ChristmasAction {
  need(obj(v) && typeof v.choice === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(v.choice) && validActivityDay(v.choice.slice(0, 10)) &&
    (v.type === "craft" ? exact(v, ["type", "count", "marked", "choice"]) && int(v.count, 1, 10) && typeof v.marked === "boolean"
      : v.type === "claim" && exact(v, ["type", "tier", "index", "choice"]) && int(v.tier, 1, 4) && int(v.index, 0, 499999998) && (v.tier === 4 || v.index === 0)), "圣诞操作、数量或状态凭证无效。", 400);
}
export function readChristmasState(raw: unknown, now: Date): ChristmasState {
  const day = activityUtcDay(now);
  if (raw === undefined) return { version: 1, kind: CHRISTMAS_ID, rulesVersion: 1, catalogVersion: CHRISTMAS_CATALOG, day, freeUsed: 0, count: 0, exp: 0, claimedMask: 0, packsNumber: 0 };
  need(obj(raw) && raw.version === 1 && raw.kind === CHRISTMAS_ID && raw.rulesVersion === 1 && raw.catalogVersion === CHRISTMAS_CATALOG && validActivityDay(raw.day)
    && int(raw.freeUsed, 0, 30) && int(raw.count, 0, MAX) && int(raw.exp, 0, 9) && int(raw.claimedMask, 0, 7) && int(raw.packsNumber, 0, 499999998)
    && raw.packsNumber <= Math.max(0, Math.floor((raw.count - 6) / 2))
    && [1, 3, 6].every((t, i) => !(Number(raw.claimedMask) & 1 << i) || Number(raw.count) >= t), "圣诞存档不兼容；原数据已保留。", 503);
  const s = structuredClone(raw) as ChristmasState; if (s.day !== day) { s.day = day; s.freeUsed = 0; } return s;
}
export function readChristmasReference(raw: unknown, now: Date): ChristmasReference {
  const day = activityUtcDay(now);
  if (raw === undefined) return { version: 1, day, daily: {}, games: {}, completed: {}, claims: [], history: [] };
  need(obj(raw) && raw.version === 1 && validActivityDay(raw.day) && obj(raw.daily) && obj(raw.games) && Array.isArray(raw.claims) && raw.claims.every(k => typeof k === "string")
    && (raw.daily.actions === undefined || int(raw.daily.actions)), "活动任务根存档不兼容；原数据已保留。", 503);
  const s = structuredClone(raw) as ChristmasReference; if (s.day !== day) { s.day = day; s.daily = {}; } return s;
}
const tasks = (s: ChristmasReference) => taskIds.map((id, i) => ({ id, claimKey: `task:${s.day}:${id}`, completed: s.claims.includes(`task:${s.day}:${id}`), packs: taskPacks[i]! }));
const snowfield = { available: false as const, reason: "真实雪场、玩家移动及圣诞战斗尚未移植；当前仅开放堆雪人。" };
const rules = ["本地任务规则：今日已领取签到/扫雷/翻牌/寻宝任务分别提供5/10/10/5雪包，UTC跨日未用额度失效。",
  "普通每包1经验；双倍每包2经验并花费2活动积分；10经验完成1个雪人。每次明确确认1至10包。",
  "成功整批堆造只计共享每日500次一次；已有奖励领取不受500次限制。奖励永久绑定并寄送游戏邮件。", "旧网页16格找雪人保留，真实雪场尚未开放。"];
export function projectChristmas(raw: unknown, refRaw: unknown, wallet: ChristmasWallet, now: Date, authority: ChristmasAuthority, ready: boolean, session: string | number = "", gateReason = "请登录游戏大厅后使用。", templatesOk = true): ChristmasNativeView {
  let s = readChristmasState(undefined, now), ref = readChristmasReference(undefined, now), compatible = true, reason = gateReason;
  try { s = readChristmasState(raw, now); ref = readChristmasReference(refRaw, now);
    need(s.freeUsed <= tasks(ref).reduce((n, t) => n + (t.completed ? t.packs : 0), 0), "当日任务额度与雪包用量不一致；原数据已保留。", 503);
  } catch (e) { if (!(e instanceof ChristmasError)) throw e; compatible = false; reason = e.message; authority = "unavailable";
    s = readChristmasState(undefined, now); ref = readChristmasReference(undefined, now); }
  const available = compatible && authority === "online" && ready && templatesOk;
  if (available) reason = "可以使用本日任务雪包堆雪人。"; else if (!templatesOk && compatible) reason = "本地普通奖励模板暂不可用。";
  const sourceTasks = tasks(ref), entitlement = sourceTasks.reduce((n, t) => n + (t.completed ? t.packs : 0), 0), balance = compatible ? entitlement - s.freeUsed : 0;
  const remaining = Math.max(0, 500 - Number(ref.daily.actions ?? 0));
  const quotes: ChristmasQuote[] = [false, true].flatMap(double => Array.from({ length: 10 }, (_, i) => {
    const count = i + 1, pointCost = double ? count * 2 : 0, experienceGained = count * (double ? 2 : 1);
    let why = !available ? reason : wallet.Revision >= 2147483647 ? "活动钱包版本已达上限。" : remaining === 0 ? "今日500次玩法次数已用完，仍可领取已有奖励。" : count > balance ? "本日任务雪包不足，请先领取任务积分。"
      : wallet.Points < pointCost ? "活动积分不足。" : s.count + Math.floor((s.exp + experienceGained) / 10) > MAX ? "雪人进度已达容量上限。" : "可以堆造。";
    if (why === "可以堆造。" && double) { try { recordActivitySpending(ref.games.chargeNativeV1, now, pointCost); } catch (e) { if (!(e instanceof ActivityAccountingError)) throw e; why = "累计消费存档暂不兼容，不能进行双倍消费。"; } }
    return { count, double, resourceCost: count, pointCost, experienceGained, canCraft: why === "可以堆造。", reason: why };
  }));
  const rewards: ChristmasTierView[] = gifts.map((reward, i) => {
    const repeatable = i === 3, cycle = repeatable ? s.packsNumber : 0, threshold = repeatable ? 6 : [1, 3, 6][i]!, nextTarget = repeatable ? 6 + 2 * (cycle + 1) : threshold;
    const claimed = !repeatable && !!(s.claimedMask & 1 << i), canClaim = available && wallet.Revision < 2147483647 && !claimed && s.count >= nextTarget && (!repeatable || cycle <= 499999998);
    return { tier: (i + 1) as ChristmasTier, title: repeatable ? "每2个雪人循环礼" : `累计${threshold}个雪人`, repeatable, threshold, cycle, nextTarget, claimed, canClaim,
      reason: !available ? reason : claimed ? "本档已经领取。" : canClaim ? "可以领取。" : wallet.Revision >= 2147483647 ? "活动钱包版本已达上限。" : "累计雪人数尚未达到要求。", reward: { ...reward } };
  });
  return { version: 1, kind: CHRISTMAS_ID, rulesVersion: 1, catalogVersion: CHRISTMAS_CATALOG, day: activityUtcDay(now), revision: wallet.Revision, authority, available, reason,
    stateToken: available ? `${activityUtcDay(now)}.${hash({ characterSession: session, wallet, raw: raw ?? null, reference: refRaw ?? null, day: activityUtcDay(now), rules: CHRISTMAS_CATALOG }).digest("base64url")}` : null,
    activity: { open: true, beginAt: "1970-01-01T00:00:00.000Z", endAt: "2099-12-31T23:59:59.999Z", title: "快乐圣诞·堆雪人" }, snowfield, currency: "local-task-points", points: wallet.Points, taskEarned: wallet.Earned,
    dailyActionsRemaining: remaining, snowman: { resource: "local-task-snowpacks", resourceLabel: "本地任务雪包", balance, entitlement, usedToday: s.freeUsed, count: s.count, exp: s.exp, totalExp: 10,
      maxCount: Math.max(0, ...quotes.filter(q => !q.double && q.canCraft).map(q => q.count)), maxDoubleCount: Math.max(0, ...quotes.filter(q => q.double && q.canCraft).map(q => q.count)), tasks: sourceTasks, quotes },
    rewards, rules, unavailable: [{ id: "original-economy", reason: "原服经济数值未知，当前使用明确本地任务规则。" }, { id: "snowfield", reason: snowfield.reason }, { id: "official-snowpacks", reason: "本地虚拟雪包并非原201144背包物品，不连接真实付款。" }] };
}
function input(v: unknown, write: boolean): ChristmasRead | ChristmasCommand {
  need(obj(v) && exact(v, ["actor", "characterId", ...(write ? ["requestId", "action"] : [])]) && int(v.characterId, 1) && obj(v.actor) && exact(v.actor, ["accountId", "accountName"])
    && int(v.actor.accountId, 1) && typeof v.actor.accountName === "string" && v.actor.accountName.length > 0 && v.actor.accountName.length <= 256, "圣诞角色账户参数无效。", 400);
  if (write) { need(typeof v.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.requestId), "圣诞请求编号无效。", 400); validateChristmasAction(v.action); }
  return v as unknown as ChristmasRead | ChristmasCommand;
}
async function auth(db: Database, req: ChristmasRead, now: Date, write: boolean) {
  const [account] = await db.select().from(member.Accounts).where(eq(member.Accounts.ID, req.actor.accountId)).for("share");
  need(account && account.UserName.toLowerCase() === req.actor.accountName.toLowerCase(), "登录账户已失效，请重新登录。", 401);
  need(!account.IsBanned, "账户已被禁用。", 403);
  const [who] = await db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, req.characterId)).for(write ? "update" : "share");
  need(who && typeof who.UserName === "string" && who.UserName.toLowerCase() === account.UserName.toLowerCase(), "该角色不属于当前账户。", 403);
  need(who.IsExist && who.ForbidDate <= now, "该角色目前不可用。", 403); return who;
}
async function wallet(db: Database, id: number, write: boolean): Promise<ChristmasWallet> {
  if (write) await db.insert(app.ActivityWallet).values({ UserID: id }).onConflictDoNothing();
  const [w] = await db.select().from(app.ActivityWallet).where(eq(app.ActivityWallet.UserID, id)).for(write ? "update" : "share"); return w ?? { Points: 0, Earned: 0, Revision: 0 };
}
async function saved(db: Database, id: number) {
  const rows = await db.select().from(app.ActivityStates).where(eq(app.ActivityStates.UserID, id));
  return { native: rows.find(r => r.Activity === CHRISTMAS_ID)?.State, reference: rows.find(r => r.Activity === "reference")?.State };
}
function view(ctx: ServerContext, req: ChristmasRead, s: Awaited<ReturnType<typeof saved>>, w: ChristmasWallet, now: Date, client?: GameClient) {
  const p = client?.player, online = !!p && !client!.closed && !p.quitting && p.isActive && ctx.world.get(req.characterId) === p;
  const ready = online && !p!.currentRoom && !(p!.info.HasBagPassword && p!.info.IsLocked);
  const reason = !online ? "角色离线；请登录游戏大厅后堆雪人。" : p!.currentRoom ? "请回到游戏大厅后堆雪人。" : "请先解除背包锁定。";
  const templatesOk = gifts.every(g => { const t = ctx.templates.findItem(g.templateId); return t && t.CategoryID === 11 && !t.CanEquip && t.NeedSex === 0 && int(t.MaxCount, 1); });
  return projectChristmas(s.native, s.reference, w, now, online ? "online" : "offline", ready, `${req.characterId}:${client?.id ?? ""}`, reason, templatesOk);
}
async function reply<T>(work: () => Promise<T>): Promise<ChristmasReply<T>> {
  try { return { ok: true, value: await work() }; } catch (e) { if (e instanceof ChristmasError) return { ok: false, status: e.status, message: e.message }; throw e; }
}
async function queued<T>(client: GameClient | undefined, work: () => Promise<T>): Promise<T> {
  const p = client?.player; return p ? client!.enqueueActivityChristmas(() => p.withPersistenceLock(work)) : work();
}
export function readNativeChristmas(ctx: ServerContext, value: unknown, client?: GameClient): Promise<ChristmasReply<ChristmasNativeView>> {
  return reply(async () => { const req = input(value, false) as ChristmasRead; return queued(client, () => ctx.db.db.transaction(async tx => {
    const db = tx as unknown as Database, w = await wallet(db, req.characterId, false), now = ctx.now(); await auth(db, req, now, false);
    return view(ctx, req, await saved(db, req.characterId), w, now, client);
  })); });
}
export function actNativeChristmas(ctx: ServerContext, value: unknown, client?: GameClient): Promise<ChristmasReply<ChristmasResult>> {
  return reply(async () => { const req = input(value, true) as ChristmasCommand; req.requestId = req.requestId.toLowerCase();
    return queued(client, async () => {
      const result = await ctx.db.db.transaction(async tx => {
        const db = tx as unknown as Database, w = await wallet(db, req.characterId, true), now = ctx.now(), who = await auth(db, req, now, true);
        const [receipt] = await db.select().from(app.ActivityActions).where(and(eq(app.ActivityActions.UserID, req.characterId), eq(app.ActivityActions.RequestID, req.requestId)));
        const s = await saved(db, req.characterId), signature = christmasSignature(req.action);
        if (receipt) { need(receipt.Signature === signature, "requestId已用于另一操作。", 409); const old = receipt.Result as { message: string; mailedCount: number };
          need(typeof old.message === "string" && int(old.mailedCount, 0, 1000), "圣诞回执不可用。", 503);
          return { state: s, wallet: w, message: old.message, mailedCount: old.mailedCount, replayed: true };
        }
        const before = view(ctx, req, s, w, now, client); need(before.available, before.reason); need(req.action.choice === before.stateToken, "圣诞任务或状态已变化，请刷新后重试。");
        need(w.Revision < 2147483647, "活动钱包版本已达上限。", 503);
        const next = readChristmasState(s.native, now), reference = readChristmasReference(s.reference, now);
        let effect: ChristmasEffect, mailedCount = 0, message: string, cost = 0;
        if (req.action.type === "craft") {
          const a = req.action, quote = before.snowman.quotes.find(q => q.count === a.count && q.double === a.marked)!;
          need(quote.canCraft, quote.reason); cost = quote.pointCost; const prior = { count: next.count, exp: next.exp };
          next.freeUsed += a.count; next.count += Math.floor((next.exp + quote.experienceGained) / 10); next.exp = (next.exp + quote.experienceGained) % 10;
          reference.daily.actions = Number(reference.daily.actions ?? 0) + 1;
          if (cost) { try { reference.games.chargeNativeV1 = recordActivitySpending(reference.games.chargeNativeV1, now, cost); }
            catch (e) { if (e instanceof ActivityAccountingError) throw new ChristmasError(e.message, 503); throw e; } }
          effect = { type: "crafted", count: a.count, double: a.marked, resourceCost: a.count, pointCost: cost, experienceGained: quote.experienceGained,
            before: prior, after: { count: next.count, exp: next.exp }, isUp: next.count > prior.count, committedRevision: w.Revision + 1 };
          message = `已消耗${a.count}个本地任务雪包，获得${quote.experienceGained}经验。`;
          await db.insert(app.ActivityStates).values({ UserID: req.characterId, Activity: "reference", State: reference }).onConflictDoUpdate({ target: [app.ActivityStates.UserID, app.ActivityStates.Activity], set: { State: reference } });
        } else {
          const a = req.action, row = before.rewards[a.tier - 1]!; need(a.index === row.cycle, "奖励循环已变化，请刷新后重试。"); need(row.canClaim, row.reason);
          if (a.tier === 4) next.packsNumber++; else next.claimedMask |= 1 << (a.tier - 1);
          const t = ctx.templates.findItem(row.reward.templateId)!, items: ItemInfo[] = [];
          for (let left = row.reward.itemCount; left > 0; left -= t.MaxCount) { const gift = ItemInfo.createFromTemplate(t, Math.min(left, t.MaxCount), 0, now); gift.IsBinds = true; gift.ValidDate = 0; await saveItem(db, gift); items.push(gift); }
          for (let i = 0; i < items.length; i += 5) { const mail: MailRow = { ReceiverID: req.characterId, Receiver: who.NickName, SenderID: 0, Sender: "活动奖励", Title: "本地圣诞堆雪人奖励", Content: "本地任务活动奖励，永久绑定普通材料。", Type: 1, Gold: 0, Money: 0, GiftToken: 0, SendTime: now, SendDate: now };
            items.slice(i, i + 5).forEach((gift, j) => Object.assign(mail, { [`Annex${j + 1}`]: String(gift.ItemID), [`Annex${j + 1}Name`]: gift.template.Name })); await sendMail(db, mail); mailedCount++; }
          effect = { type: "claimed", tier: a.tier, cycle: a.tier === 4 ? next.packsNumber : 0, rewards: [{ ...row.reward }], committedRevision: w.Revision + 1 }; message = "雪人奖励已寄往游戏邮件。";
        }
        await db.insert(app.ActivityStates).values({ UserID: req.characterId, Activity: CHRISTMAS_ID, State: next }).onConflictDoUpdate({ target: [app.ActivityStates.UserID, app.ActivityStates.Activity], set: { State: next } });
        await db.update(app.ActivityWallet).set({ Points: w.Points - cost, Revision: w.Revision + 1 }).where(eq(app.ActivityWallet.UserID, req.characterId));
        await db.insert(app.ActivityActions).values({ UserID: req.characterId, RequestID: req.requestId, Signature: signature, Result: { message, mailedCount } });
        return { state: { native: next, reference: req.action.type === "craft" ? reference : s.reference }, wallet: { ...w, Points: w.Points - cost, Revision: w.Revision + 1 }, message, mailedCount, replayed: false, effect };
      });
      const projectedAt = ctx.now(), projected = view(ctx, req, result.state, result.wallet, projectedAt, client);
      if (!result.replayed && result.mailedCount && client?.player) { try { client.player.send(Out.mailResponse(req.characterId, 1)); } catch { ctx.log.warn("native Christmas committed mail notification failed"); } }
      return { view: projected, requestId: req.requestId, replayed: result.replayed, message: result.message, mailedCount: result.mailedCount,
        ...(!result.replayed ? { nativeChristmasAction: { requestId: req.requestId, effects: [result.effect!] } } : {}) };
    });
  });
}
