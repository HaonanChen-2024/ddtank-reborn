/** A05 original ExchangeAct adapter. Rules are explicitly local, not recovered private-server prices. */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { app, member, player, type Database } from "@ddt/db";
import type { ServerContext } from "../session/context.js";
import type { GameClient } from "../session/client.js";
import type { GamePlayer } from "./player.js";
import { ItemInfo, isSpecialTemplate, templateBagType } from "./item.js";
import { saveItem } from "../db/items.js";
import { savePlayerInfo } from "../db/characters.js";
import { sendMail, type MailRow } from "../db/social.js";
import * as Out from "../packets/out.js";

export const EXCHANGE_ID = "exchange-native";
export const EXCHANGE_CATALOG = "exchange-native-v1-local-4";
const names: Record<number, string> = { 11019: "强化石1级", 11001: "朱雀石1级", 11021: "强化石2级", 11002: "朱雀石2级" };
const ids = [11019, 11001, 11021, 11002];
const recipes = [
  { id: "local-strengthen-up", input: 11019, cost: 4, output: 11021, count: 1 },
  { id: "local-zhuque-up", input: 11001, cost: 4, output: 11002, count: 1 },
  { id: "local-strengthen-down", input: 11021, cost: 2, output: 11019, count: 3 },
  { id: "local-zhuque-down", input: 11002, cost: 2, output: 11001, count: 3 },
];
export interface ExchangeItem { templateId: number; name: string; count: number }
export interface ExchangeReward extends ExchangeItem { bound: true; validDays: 0 }
export interface ExchangeNativeView {
  version: 1; catalogVersion: string; day: string; revision: number;
  authority: "online" | "offline" | "unavailable"; available: boolean; reason: string;
  materialSource: "prop-bag"; stateToken: string | null;
  category: { id: "local-materials"; title: string };
  materials: { templateId: number; name: string; eligibleCount: number | null }[];
  recipes: { index: number; catalogId: string; title: string; inputs: ExchangeItem[]; outputs: ExchangeReward[];
    dailyLimit: 10; exchanged: number; remaining: number; maxCount: number; canExchange: boolean; reason: string }[];
  rules: string[]; unavailable: { id: string; reason: string }[];
}
export interface ExchangeAction { type: "exchange"; index: number; count: number; choice: string }
export interface ExchangeEffect { type: "exchanged"; index: number; count: number; consumed: ExchangeItem[];
  rewards: ExchangeReward[]; committedRevision: number }
export interface ExchangeActor { accountId: number; accountName: string }
export interface ExchangeRead { actor: ExchangeActor; characterId: number }
export interface ExchangeCommand extends ExchangeRead { requestId: string; action: ExchangeAction }
export interface ExchangeResult { view: ExchangeNativeView; requestId: string; replayed: boolean; message: string; mailedCount: number;
  nativeExchangeAction?: { requestId: string; effects: ExchangeEffect[] } }
export type ExchangeReply<T> = { ok: true; value: T } | { ok: false; status: number; message: string };
interface SavedState { version: 1; day: string; exchanged: number[]; [key: string]: unknown }
interface Wallet { Points: number; Earned: number; Revision: number }
class ExchangeError extends Error { constructor(message: string, readonly status = 409) { super(message); } }
const integer = (n: unknown, min = 0, max = 2147483647): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
function need(ok: unknown, message: string, status = 409): asserts ok { if (!ok) throw new ExchangeError(message, status); }
const utcDay = (now: Date) => now.toISOString().slice(0, 10);
/** Identical canonical signature to apps/api activities/service; global UUID ledger is shared. */
export function exchangeCanonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(exchangeCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${exchangeCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(exchangeCanonical(value));
export const exchangeSignature = (action: ExchangeAction) => hash({ activityId: EXCHANGE_ID, action }).digest("hex");
function readInput(value: unknown, action: boolean): ExchangeRead | ExchangeCommand {
  need(object(value) && Object.keys(value).every(k => ["actor", "characterId", ...(action ? ["action", "requestId"] : [])].includes(k)), "兑换请求参数无效。", 400);
  need(integer(value.characterId, 1) && object(value.actor) && Object.keys(value.actor).length === 2 &&
    integer(value.actor.accountId, 1) && typeof value.actor.accountName === "string" && value.actor.accountName.length > 0 && value.actor.accountName.length <= 256, "兑换账户参数无效。", 400);
  if (action) {
    need(typeof value.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId), "兑换请求编号无效。", 400);
    const a = value.action;
    need(object(a) && Object.keys(a).length === 4 && Object.keys(a).every(k => ["type", "index", "count", "choice"].includes(k)) &&
      a.type === "exchange" && integer(a.index, 0, 3) && integer(a.count, 1, 10) && typeof a.choice === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(a.choice), "兑换配方、数量或状态凭证无效。", 400);
  }
  return value as unknown as ExchangeRead | ExchangeCommand;
}
function state(raw: unknown, now: Date): SavedState {
  if (raw === undefined) return { version: 1, day: utcDay(now), exchanged: [0, 0, 0, 0] };
  need(object(raw) && raw.version === 1 && typeof raw.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.day) &&
    Array.isArray(raw.exchanged) && raw.exchanged.length === 4 && raw.exchanged.every(n => integer(n, 0, 10)), "兑换存档不兼容，请保留原件。", 503);
  const s = structuredClone(raw) as SavedState;
  if (s.day !== utcDay(now)) { s.day = utcDay(now); s.exchanged = [0, 0, 0, 0]; }
  return s;
}
async function auth(db: Database, input: ExchangeRead, now: Date, update: boolean) {
  const [account] = await db.select().from(member.Accounts).where(and(eq(member.Accounts.ID, input.actor.accountId),
    sql`lower(${member.Accounts.UserName})=lower(${input.actor.accountName})`)).for("share");
  need(account, "登录账户已失效，请重新登录。", 401);
  need(!account.IsBanned, "账户已被禁用。", 403);
  const q = db.select().from(player.Sys_Users_Detail).where(and(eq(player.Sys_Users_Detail.UserID, input.characterId),
    sql`lower(${player.Sys_Users_Detail.UserName})=lower(${account.UserName})`));
  const [who] = await q.for(update ? "update" : "share");
  need(who?.NickName, "该角色不属于当前账户。", 403);
  need(who.IsExist && who.ForbidDate <= now, "该角色目前不可用。", 403);
  return who;
}
async function saved(db: Database, id: number, now: Date) {
  const [row] = await db.select().from(app.ActivityStates).where(and(eq(app.ActivityStates.UserID, id), eq(app.ActivityStates.Activity, EXCHANGE_ID)));
  return state(row?.State, now);
}
const rowFingerprint = (it: ItemInfo) => exchangeCanonical(it.toRow());
function templateValid(ctx: ServerContext, id: number) {
  const t = ctx.templates.findItem(id);
  return !!t && t.TemplateID === id && t.CategoryID === 11 && !t.CanEquip && !isSpecialTemplate(t) && t.NeedSex === 0 && integer(t.MaxCount, 1);
}
function eligible(p: GamePlayer, now: Date): ItemInfo[] {
  const found = p.propBag.getItems(0, 95).filter(it => ids.includes(it.TemplateID));
  const duplicate = new Set(found.filter((it, i) => found.some((other, j) => i !== j && (other === it || it.ItemID > 0 && other.ItemID === it.ItemID))).map(it => it.tempId));
  return found.filter(it => !duplicate.has(it.tempId) && it.UserID === p.id && it.IsExist && it.BagType === 1 && templateBagType(it.template) === 1 &&
    integer(it.Place, 0, 95) && p.propBag.getItemAt(it.Place) === it && integer(it.ItemID) && integer(it.Count, 1, it.template.MaxCount) &&
    !it.cellLocked && it.isValidItem(now) && [it.StrengthenLevel, it.StrengthenExp, it.AttackCompose, it.DefendCompose, it.LuckCompose, it.AgilityCompose,
      it.StrengthenTimes, it.StrengthenRefineryLevel, it.Hole5Level, it.Hole5Exp, it.Hole6Level, it.Hole6Exp, it.Blood, it.curExp].every(n => n === 0) &&
    [it.Hole1, it.Hole2, it.Hole3, it.Hole4, it.Hole5, it.Hole6].every(n => n <= 0) && !it.isGold && !it.Color && !it.Skin &&
    it.latentEnergyCurStr === "0,0,0,0" && it.latentEnergyNewStr === "0,0,0,0").sort((a, b) => a.Place - b.Place || a.ItemID - b.ItemID || a.tempId - b.tempId);
}
const item = (templateId: number, count: number): ExchangeItem => ({ templateId, name: names[templateId]!, count });
const reward = (templateId: number, count: number): ExchangeReward => ({ ...item(templateId, count), bound: true, validDays: 0 });
function online(ctx: ServerContext, input: ExchangeRead, p?: GamePlayer, client?: GameClient): p is GamePlayer {
  return !!p && !!client && client.player === p && !client.closed && ctx.world.get(input.characterId) === p && p.isActive && !p.quitting;
}
function project(ctx: ServerContext, input: ExchangeRead, s: SavedState, w: Wallet, now: Date, p?: GamePlayer, client?: GameClient): ExchangeNativeView {
  const live = online(ctx, input, p, client), templatesOk = ids.every(id => templateValid(ctx, id));
  const available = live && !p.currentRoom && !(p.info.HasBagPassword && p.info.IsLocked) && templatesOk;
  const reason = !live ? "角色离线或连接尚未就绪；请登录大厅后兑换。" : p.currentRoom ? "请回到游戏大厅后兑换。" :
    p.info.HasBagPassword && p.info.IsLocked ? "请先解除背包锁定。" : !templatesOk ? "本地普通材料模板暂不可用。" : "可以兑换真实背包材料。";
  const stacks = live ? eligible(p, now) : [];
  const materials = ids.map(id => ({ templateId: id, name: names[id]!, eligibleCount: live ? stacks.filter(it => it.TemplateID === id).reduce((n, it) => n + it.Count, 0) : null }));
  const token = available ? `${utcDay(now)}.${hash({ characterId: input.characterId, catalog: EXCHANGE_CATALOG, day: s.day, exchanged: s.exchanged,
    revision: w.Revision, session: client!.id, available, templates: ids.map(id => ctx.templates.findItem(id)),
    stacks: p.propBag.getItems(0, 95).filter(it => ids.includes(it.TemplateID)).map(it => ({ row: it.toRow(), dirty: it.isDirty, tempId: it.tempId })) }).digest("base64url")}` : null;
  return { version: 1, catalogVersion: EXCHANGE_CATALOG, day: utcDay(now), revision: w.Revision, authority: live ? "online" : "offline", available, reason,
    materialSource: "prop-bag", stateToken: token, category: { id: "local-materials", title: "本地材料兑换" }, materials,
    recipes: recipes.map((r, index) => {
      const exchanged = s.exchanged[index]!, remaining = 10 - exchanged, have = materials.find(m => m.templateId === r.input)!.eligibleCount ?? 0;
      const maxCount = available ? Math.min(10, remaining, Math.floor(have / r.cost)) : 0;
      return { index, catalogId: r.id, title: `${names[r.input]}兑换${names[r.output]}`, inputs: [item(r.input, r.cost)], outputs: [reward(r.output, r.count)],
        dailyLimit: 10, exchanged, remaining, maxCount, canExchange: maxCount > 0, reason: !available ? reason : remaining === 0 ? "今日该配方已兑满。" : maxCount === 0 ? "合格背包材料不足。" : "请选择兑换份数。" };
    }), rules: ["本地材料配方；并非原服14分类36配方。", "每配方UTC日最多10份，单批1至10份；绑定与未绑定材料均可消费。",
      "仅使用道具背包中的合格材料；奖励永久绑定并原子发送邮件。", "兑换不收活动积分，不增加任务累计积分，不受每日500次游戏消费限制。"],
    unavailable: [{ id: "reference-catalog", reason: "原服14分类36配方及42种输出尚未审核移植。" }, { id: "offline-exchange", reason: "离线不执行新扣料；已提交请求可用原编号重试查询。" }] };
}
async function wallet(db: Database, id: number, write: boolean): Promise<Wallet> {
  if (write) await db.insert(app.ActivityWallet).values({ UserID: id }).onConflictDoNothing();
  const [row] = await db.select().from(app.ActivityWallet).where(eq(app.ActivityWallet.UserID, id)).for(write ? "update" : "share");
  return row ?? { Points: 0, Earned: 0, Revision: 0 };
}
async function readView(ctx: ServerContext, input: ExchangeRead, p?: GamePlayer, client?: GameClient) {
  return ctx.db.db.transaction(async tx => {
    const db = tx as unknown as Database, w = await wallet(db, input.characterId, false), now = ctx.now();
    await auth(db, input, now, false);
    return project(ctx, input, await saved(db, input.characterId, now), w, now, p, client);
  });
}
async function reply<T>(work: () => Promise<T>): Promise<ExchangeReply<T>> {
  try { return { ok: true, value: await work() }; }
  catch (err) { if (err instanceof ExchangeError) return { ok: false, status: err.status, message: err.message }; throw err; }
}
/** Both reads and writes append to the real socket queue, then exclude autosave/quit. */
export function readNativeExchange(ctx: ServerContext, value: unknown, client?: GameClient): Promise<ExchangeReply<ExchangeNativeView>> {
  return reply(async () => {
    const input = readInput(value, false) as ExchangeRead, p = client?.player;
    return p ? client!.enqueueActivityExchange(() => p.withPersistenceLock(() => readView(ctx, input, p, client))) : readView(ctx, input);
  });
}
interface Pending { real: ItemInfo; before: string; dirty: boolean; after: ItemInfo }
const pending = (p: GamePlayer) => [...new Set(p.allBags().flatMap(b => b.saveToDb ? b.dirtyItems() : b.removed))];
const profile = (p: GamePlayer) => exchangeCanonical({ info: { ...p.info, State: 0 }, match: p.match });
async function commit(ctx: ServerContext, input: ExchangeCommand, p?: GamePlayer, client?: GameClient): Promise<ExchangeResult> {
  const signature = exchangeSignature(input.action);
  const result = await ctx.db.db.transaction(async tx => {
    const db = tx as unknown as Database, w = await wallet(db, input.characterId, true), now = ctx.now();
    const who = await auth(db, input, now, true);
    const [receipt] = await db.select().from(app.ActivityActions).where(and(eq(app.ActivityActions.UserID, input.characterId), eq(app.ActivityActions.RequestID, input.requestId)));
    const s = await saved(db, input.characterId, now);
    if (receipt) {
      need(receipt.Signature === signature, "requestId已用于另一操作，请使用新的请求编号。", 409);
      const old = receipt.Result as { message: string; mailedCount: number };
      need(typeof old.message === "string" && integer(old.mailedCount), "兑换回执不可用。", 503);
      return { view: project(ctx, input, s, w, now, p, client), requestId: input.requestId, replayed: true, ...old };
    }
    const beforeView = project(ctx, input, s, w, now, p, client);
    need(online(ctx, input, p, client) && beforeView.available, beforeView.reason);
    need(input.action.choice === beforeView.stateToken, "背包材料或活动状态已变化，请刷新后重试。");
    need(input.action.count <= beforeView.recipes[input.action.index]!.maxCount, "材料不足或今日兑换份数已用完。");
    need(integer(w.Revision, 0, 2147483646), "活动钱包版本已达上限。", 503);
    const r = recipes[input.action.index]!, count = input.action.count, selected: Pending[] = [], changes = new Map<ItemInfo, Pending>();
    const info = structuredClone(p.info), match = structuredClone(p.match), profileBefore = profile(p), pendingBefore = pending(p);
    const capture = (real: ItemInfo) => {
      let entry = changes.get(real);
      if (!entry) {
        need(real.UserID === p.id && integer(real.ItemID), "背包物品归属异常。");
        entry = { real, before: rowFingerprint(real), dirty: real.isDirty, after: ItemInfo.fromRow({ ...real.toRow(), ItemID: real.ItemID }, real.template) };
        changes.set(real, entry);
      }
      return entry;
    };
    pendingBefore.forEach(capture);
    let left = r.cost * count;
    for (const it of eligible(p, now).filter(it => it.TemplateID === r.input)) {
      if (!left) break;
      const entry = capture(it), used = Math.min(left, it.Count); left -= used; entry.after.Count -= used;
      if (entry.after.Count === 0) Object.assign(entry.after, { IsExist: false, BagType: -1, Place: -1, RemoveDate: now, RemoveType: 0 });
      selected.push(entry);
    }
    need(left === 0, "合格背包材料不足。");
    const persisted = [...changes.values()].filter(c => c.real.ItemID > 0).sort((a, b) => a.real.ItemID - b.real.ItemID);
    need(new Set(persisted.map(c => c.real.ItemID)).size === persisted.length, "背包物品编号重复。");
    for (const c of persisted) {
      const [stored] = await db.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, c.real.ItemID)).for("update");
      need(stored && stored.UserID === p.id && stored.TemplateID === c.real.TemplateID && (!c.real.IsExist || stored.IsExist), "背包物品记录已变化。");
      need(c.dirty || pendingBefore.includes(c.real) || rowFingerprint(ItemInfo.fromRow(stored, c.real.template)) === c.before, "背包物品记录已变化。");
    }
    await savePlayerInfo(db, info, match);
    for (const c of changes.values()) await saveItem(db, c.after);
    const output = ctx.templates.findItem(r.output)!;
    const attachments: ItemInfo[] = [];
    for (let n = r.count * count; n > 0; n -= output.MaxCount) {
      const gift = ItemInfo.createFromTemplate(output, Math.min(n, output.MaxCount), 0, now); gift.IsBinds = true; gift.ValidDate = 0;
      await saveItem(db, gift); attachments.push(gift);
    }
    let mailedCount = 0;
    for (let i = 0; i < attachments.length; i += 5) {
      const mail: MailRow = { ReceiverID: p.id, Receiver: who.NickName, SenderID: 0, Sender: "活动奖励", Title: "本地材料兑换奖励",
        Content: "材料已按本地配方扣除；附件为永久绑定普通材料。", Type: 1, Gold: 0, Money: 0, GiftToken: 0, SendTime: now, SendDate: now };
      attachments.slice(i, i + 5).forEach((gift, j) => Object.assign(mail, { [`Annex${j + 1}`]: String(gift.ItemID), [`Annex${j + 1}Name`]: gift.template.Name }));
      await sendMail(db, mail); mailedCount++;
    }
    s.exchanged[input.action.index]! += count;
    await db.insert(app.ActivityStates).values({ UserID: p.id, Activity: EXCHANGE_ID, State: s }).onConflictDoUpdate({
      target: [app.ActivityStates.UserID, app.ActivityStates.Activity], set: { State: s } });
    await db.update(app.ActivityWallet).set({ Revision: w.Revision + 1 }).where(eq(app.ActivityWallet.UserID, p.id));
    const message = `已兑换${count}份，奖励已发送至邮箱。`;
    await db.insert(app.ActivityActions).values({ UserID: p.id, RequestID: input.requestId, Signature: signature, Result: { message, mailedCount } });
    const pendingNow = pending(p);
    need(profile(p) === profileBefore && [...changes.values()].every(c => rowFingerprint(c.real) === c.before && c.real.isDirty === c.dirty) &&
      pendingNow.length === pendingBefore.length && pendingNow.every(it => pendingBefore.includes(it)) && selected.every(c => p.propBag.getItemAt(c.real.Place) === c.real), "在线背包发生并发变化，请刷新重试。");
    const effect: ExchangeEffect = { type: "exchanged", index: input.action.index, count, consumed: [item(r.input, r.cost * count)],
      rewards: [reward(r.output, r.count * count)], committedRevision: w.Revision + 1 };
    return { view: beforeView, requestId: input.requestId, replayed: false, message, mailedCount, changes: [...changes.values()], selected, state: s,
      wallet: { ...w, Revision: w.Revision + 1 }, nativeExchangeAction: { requestId: input.requestId, effects: [effect] } };
  });
  if (!result.changes || !result.selected || !result.state || !result.wallet) return result;
  // Publish ALL committed rows/IDs and clean dirty collections before any transport callback.
  // Item removal/update is batched; only commitChanges below can reach the socket.
  const owner = p!;
  owner.propBag.beginChanges();
  for (const c of result.selected) if (!c.after.IsExist) owner.propBag.removeItem(c.real);
  for (const c of result.changes) Object.assign(c.real, c.after.toRow());
  for (const c of result.selected) if (c.after.IsExist) owner.propBag.updateItem(c.real);
  for (const c of result.changes) {
    c.real.isDirty = false;
    for (const bag of owner.allBags()) for (let i = bag.removed.length - 1; i >= 0; i--) if (bag.removed[i] === c.real) bag.removed.splice(i, 1);
  }
  const projectedAt = ctx.now();
  const view = project(ctx, input, state(result.state, projectedAt), result.wallet, projectedAt, owner, client);
  for (const notify of [() => owner.propBag.commitChanges(), () => owner.send(Out.mailResponse(owner.id, 1))]) {
    try { notify(); } catch (err) { ctx.log.warn(`native exchange committed notification failed: ${err instanceof Error ? err.message : "transport error"}`); }
  }
  return { view, requestId: result.requestId, replayed: false, message: result.message, mailedCount: result.mailedCount, nativeExchangeAction: result.nativeExchangeAction };
}
export function actNativeExchange(ctx: ServerContext, value: unknown, client?: GameClient): Promise<ExchangeReply<ExchangeResult>> {
  return reply(async () => {
    const input = readInput(value, true) as ExchangeCommand; input.requestId = input.requestId.toLowerCase();
    const p = client?.player;
    // Receipt recognition remains possible without any live player or current token.
    return p ? client!.enqueueActivityExchange(() => p.withPersistenceLock(() => commit(ctx, input, p, client))) : commit(ctx, input);
  });
}
