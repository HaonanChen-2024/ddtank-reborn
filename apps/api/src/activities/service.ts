import { commandChristmas, type ChristmasEnvelope } from "./christmas-native.js";
import { commandSnowfield, isSnowfieldAction, readSnowfieldPair, type SnowfieldEnvelope } from "./christmas-snowfield.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { AppCtx } from "../context.js";
import { q, q1 } from "../lib/db.js";
import type { Claims } from "../lib/jwt.js";
import { safeKey } from "../lib/storage.js";
import { sendMail } from "../routes/admin.js";
import { gameInternalPost } from "../routes/public.js";
import { PRIZES } from "./config.js";
import { createActivityState, transitionActivity, transitionFirstRechargeGift, viewActivities } from "./engine.js";
import type { PairNativeEffect } from "./pair-native.js";
import type { MinesNativeEffect } from "./mines-native.js";
import type { DDPlayNativeEffect } from "./ddplay-native.js";
import type { GypsyNativeEffect } from "./gypsy-native.js";
import type { MoonlightNativeEffect } from "./moonlight-native.js";
import type { TreasureNativeEffect } from "./treasure-native.js";
import type { WheelNativeEffect } from "./wheel-native.js";
import type { CarnivalNativeEffect } from "./carnival-native.js";
import type { DevilEffect } from "./devil-native.js";
import type { CaveEffect } from "./caveloot-native.js";
import { validateFirstRechargeNativeAction, type FirstRechargeNativeEffect } from "./first-recharge-native.js";
import { recordChargeNativeSpending, type ChargeNativeEffect } from "./charge-native.js";
import { advanceForthrightGroup, decodeForthrightCode, forthrightEntityCode, readForthrightNativeState, validateForthrightGroup, validateForthrightNativeAction,
  type ForthrightNativeEffect, type PrivateGroup } from "./forthright-native.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivitySnapshot, type ActivityState, type ActivityWallet } from "./types.js";
import { commandExchange, readExchangeProjection, type ExchangeEnvelope } from "./exchange-native.js";

interface Owner { NickName: string; Sex: boolean }
interface WalletRow { Points: number; Earned: number; Revision: number }
interface WardrobeRow { TemplateID: number; Name: string; CategoryID: number; Pic: string | null; NeedSex: number }
export interface ActivityResult extends ActivitySnapshot {
  characterId: number; message?: string; mailedCount?: number; replayed?: boolean;
  /** New committed native actions only; replays return the latest projection without reanimating. */
  nativePairAction?: { requestId: string; effects: PairNativeEffect[] };
  nativeMinesAction?: { requestId: string; effects: MinesNativeEffect[] };
  nativeDDPlayAction?: { requestId: string; effects: DDPlayNativeEffect[] };
  nativeGypsyAction?: { requestId: string; effects: GypsyNativeEffect[] };
  nativeMoonlightAction?: { requestId: string; effects: MoonlightNativeEffect[] };
  nativeTreasureAction?: { requestId: string; effects: TreasureNativeEffect[] };
  nativeWheelAction?: { requestId: string; effects: WheelNativeEffect[] };
  nativeCarnivalAction?: { requestId: string; effects: CarnivalNativeEffect[] };
  nativeFirstRechargeAction?: { requestId: string; effects: FirstRechargeNativeEffect[] };
  nativeChargeAction?: { requestId: string; effects: ChargeNativeEffect[] };
  nativeForthrightAction?: { requestId: string; effects: ForthrightNativeEffect[] };
  nativeExchangeAction?: ExchangeEnvelope;
  nativeChristmasAction?: ChristmasEnvelope | SnowfieldEnvelope;
  nativeDevilAction?: { requestId: string; effects: DevilEffect[] };
  nativeCaveLootAction?: { requestId: string; effects: CaveEffect[] };
}
const int = (n: number) => Number.isInteger(n) && n >= 0 && n <= 2147483647;

function wardrobeIcon(app: AppCtx, item: WardrobeRow): string | undefined {
  const pic = item.Pic;
  if (!pic || pic.length > 200 || pic !== pic.trim() || safeKey(pic) !== pic || pic.includes("/") || pic === "." || pic === "..") return undefined;
  if (!Number.isInteger(item.NeedSex) || item.NeedSex < 0 || item.NeedSex > 2) return undefined;
  // Match lib/wardrobe.ts and the original PathManager.solveGoodsPath; wings have a separate icon owner.
  const categories: Record<number, string> = { 1: "head", 2: "glass", 3: "hair", 4: "eff", 5: "cloth", 6: "face", 13: "suits" };
  if (item.CategoryID !== 15 && !Object.hasOwn(categories, item.CategoryID)) return undefined;
  const path = item.CategoryID === 15 ? `image/equip/wing/${pic}/icon.png`
    : `image/equip/${item.NeedSex === 1 ? "m" : "f"}/${categories[item.CategoryID]}/${item.CategoryID === 13 ? pic : pic.toLowerCase()}/icon_1.png`;
  const file = app.resources.resolve(path);
  // Use the same local index as /resource/*, never its missing-file placeholder or an external URL.
  return file && existsSync(file) ? `/resource/${path.split("/").map(encodeURIComponent).join("/")}` : undefined;
}

async function owner(app: AppCtx, claims: Claims, characterId: number, now: Date, locked = false): Promise<Owner> {
  const account = await q1<{ ID: number; UserName: string; IsBanned: boolean }>(app.h, sql`SELECT "ID","UserName","IsBanned" FROM member."Accounts"
    WHERE "ID"=${claims.sub} AND lower("UserName")=lower(${claims.name}) ${locked ? sql`FOR SHARE` : sql``}`);
  if (!account) throw new ActivityError("登录账户已失效，请重新登录。", 401);
  if (account.IsBanned) throw new ActivityError("账户已被禁用。", 403);
  const character = await q1<Owner & { IsExist: boolean; ForbidDate: Date }>(app.h, sql`SELECT "NickName","Sex","IsExist","ForbidDate" FROM player."Sys_Users_Detail"
    WHERE "UserID"=${characterId} AND lower("UserName")=lower(${account.UserName}) ${locked ? sql`FOR SHARE` : sql``}`);
  if (!character?.NickName) throw new ActivityError("该角色不属于当前账户。", 403);
  if (!character.IsExist || new Date(character.ForbidDate).getTime() > now.getTime()) throw new ActivityError("该角色目前不可用。", 403);
  return character;
}

async function forthrightGroups(app: AppCtx, characterId: number, now: Date, inspectCode?: string): Promise<PrivateGroup[]> {
  const root = await stateOf(app, characterId, now), s = readForthrightNativeState(root.games.forthrightNativeV1);
  const ids = new Set([characterId, ...s.joinedGroupCodes.map(code => decodeForthrightCode(code).ownerId)]);
  if (inspectCode) ids.add(decodeForthrightCode(inspectCode).ownerId);
  // Only this activity's canonical group subtree is read; other roles' boards/seeds are never loaded.
  const [related, publicRows] = await Promise.all([
    q<{ Groups: Record<string, PrivateGroup> }>(app.h, sql`SELECT "State"->'games'->'forthrightNativeV1'->'createdGroups' AS "Groups"
      FROM app."ActivityStates" WHERE "Activity"='reference' AND "UserID" IN (${sql.join([...ids].map(id => sql`${id}`), sql`,`)})`),
    q<{ Group: PrivateGroup }>(app.h, sql`SELECT g.value AS "Group" FROM app."ActivityStates" s,
      LATERAL jsonb_each(COALESCE(s."State"->'games'->'forthrightNativeV1'->'createdGroups','{}'::jsonb)) g
      WHERE s."Activity"='reference' AND g.value->>'status'='pending' AND g.value->>'publicListing'='true'
      ORDER BY g.value->>'createdAt' DESC,s."UserID",g.key LIMIT 50`),
  ]);
  const groups = new Map<string, PrivateGroup>();
  for (const g of [...publicRows.map(row => row.Group), ...related.flatMap(row => Object.values(row.Groups ?? {}))]) {
    const validated = validateForthrightGroup(g); groups.set(validated.code, validated);
  }
  return [...groups.values()];
}
async function context(app: AppCtx, characterId: number, now: Date): Promise<ActivityContext> {
  const [signs, owned, wardrobe] = await Promise.all([
    q<{ Key: string }>(app.h, sql`SELECT "Key" FROM app."EventClaims" WHERE "UserID"=${characterId} AND "Kind"='sign' ORDER BY "Key"`),
    q<{ TemplateID: number }>(app.h, sql`SELECT DISTINCT "TemplateID" FROM player."Sys_Users_Goods" WHERE "UserID"=${characterId} AND "IsExist"=true AND "Count">0
      AND ("ValidDate"=0 OR "IsUsed"=false OR "BeginDate" + "ValidDate" * interval '1 day' > ${now}) ORDER BY "TemplateID"`),
    q<WardrobeRow>(app.h, sql`SELECT t."TemplateID",COALESCE(tr."text",t."Name") AS "Name",t."CategoryID",t."Pic",t."NeedSex" FROM game."Shop_Goods" t
      LEFT JOIN app."Translations" tr ON tr."table"='Shop_Goods' AND tr."column"='Name' AND tr."rowId"=t."TemplateID"::text AND tr."lang"='zh-CN'
      WHERE t."CategoryID" IN (1,2,3,4,5,6,13,15) ORDER BY t."TemplateID"`),
  ]);
  return { now, characterId, forthrightGroups: await forthrightGroups(app, characterId, now), signDays: signs.map((s) => s.Key), ownedTemplateIds: owned.map((i) => i.TemplateID),
    wardrobeItems: wardrobe.map((i) => {
      const icon = wardrobeIcon(app, i);
      return { templateId: i.TemplateID, name: i.Name, category: i.CategoryID, ...(icon ? { icon } : {}) };
    }) };
}

const walletOf = (w?: WalletRow): ActivityWallet => ({ points: w?.Points ?? 0, earned: w?.Earned ?? 0, revision: w?.Revision ?? 0 });
async function stateOf(app: AppCtx, characterId: number, now: Date): Promise<ActivityState> {
  const row = await q1<{ State: ActivityState }>(app.h, sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${characterId} AND "Activity"='reference'`);
  return row?.State ?? createActivityState(now);
}

export async function activitySnapshot(app: AppCtx, claims: Claims, characterId: number, loadExchange = true): Promise<ActivityResult> {
  const now = new Date();
  await owner(app, claims, characterId, now);
  // GET is read-only: an unstarted character gets an in-memory default, not a persisted board.
  const [row, ctx] = await Promise.all([
    q1<WalletRow & { State: ActivityState | null }>(app.h, sql`SELECT w."Points",w."Earned",w."Revision",s."State" FROM app."ActivityWallet" w
      LEFT JOIN app."ActivityStates" s ON s."UserID"=w."UserID" AND s."Activity"='reference' WHERE w."UserID"=${characterId}`),
    context(app, characterId, now),
  ]);
  const result: ActivityResult = { characterId, ...viewActivities(row?.State ?? createActivityState(now), walletOf(row), ctx) };
  // Never add internal inventory reads to context(): old actions hold the wallet lock there.
  if (loadExchange) {
    result.nativeExchange = await readExchangeProjection(app, claims, characterId, result.revision, result.day);
    const christmas = await readSnowfieldPair(app, claims, characterId, result.revision, result.day, result.points, result.earned);
    result.nativeChristmas = christmas.snowman;
    result.nativeChristmasSnowfield = christmas.snowfield;
  }
  return result;
}

/** Keep all ordinary attachments in the claim transaction; sendMail itself truncates after five. */
async function rewardMail(app: AppCtx, characterId: number, who: Owner, rewards: ActivityReward[]): Promise<number> {
  const items: { templateId: number; count: number; validDays: number }[] = [];
  for (const reward of rewards) {
    const validDays = reward.validDays ?? 0;
    if (!int(reward.templateId) || !PRIZES.some((p) => p.templateId === reward.templateId) || !int(reward.count) || reward.count === 0 || !int(validDays)) throw new ActivityError("活动奖励配置无效。", 503);
    const template = await q1<{ MaxCount: number; NeedSex: number; CategoryID: number; CanEquip: boolean }>(app.h, sql`SELECT "MaxCount","NeedSex","CategoryID","CanEquip" FROM game."Shop_Goods" WHERE "TemplateID"=${reward.templateId}`);
    if (!template || template.CategoryID !== 11 || template.CanEquip || !int(template.MaxCount) || template.MaxCount === 0 || (template.NeedSex !== 0 && template.NeedSex !== (who.Sex ? 1 : 2))) throw new ActivityError("活动奖励模板不可交付。", 503);
    const stacks = Math.ceil(reward.count / template.MaxCount);
    if (items.length + stacks > 1000) throw new ActivityError("活动奖励数量超过交付上限。", 503);
    for (let left = reward.count; left > 0; left -= template.MaxCount) items.push({ templateId: reward.templateId, count: Math.min(left, template.MaxCount), validDays });
  }
  for (let i = 0; i < items.length; i += 5) await sendMail(app, characterId, who.NickName, "本地活动奖励", "奖励来自本地活动，已按原物品模板发放。", { items: items.slice(i, i + 5) });
  return Math.ceil(items.length / 5);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Roll back even speculative wallet inserts when a committed gift is replayed. */
class GiftReplay extends Error { constructor(readonly result: ActivityResult) { super("committed gift replay"); } }
async function firstRechargeGift(app: AppCtx, claims: Claims, characterId: number, requestId: string, action: ActivityAction, signature: string): Promise<ActivityResult> {
  const a = validateFirstRechargeNativeAction(action);
  if (a.type !== "gift-card") throw new ActivityError("赠送操作无效。");
  await owner(app, claims, characterId, new Date());
  const matches = await q<{ UserID: number; NickName: string }>(app.h, sql`SELECT "UserID","NickName" FROM player."Sys_Users_Detail"
    WHERE lower("NickName")=lower(${a.recipientName}) ORDER BY "UserID" LIMIT 2`);
  const target = matches.length === 1 && matches[0].UserID !== characterId ? matches[0] : undefined;
  const ids = target ? [characterId, target.UserID].sort((x, y) => x - y) : [characterId];
  try {
    return await app.h.db.transaction(async tx => {
      const txApp: AppCtx = { ...app, h: { ...app.h, db: tx } };
      // Both row creation and row locking use the same global order, before any state writes.
      for (const id of ids) await tx.execute(sql`INSERT INTO app."ActivityWallet" ("UserID") VALUES (${id}) ON CONFLICT DO NOTHING`);
      const rows = await q<WalletRow & { UserID: number }>(txApp.h, sql`SELECT "UserID","Points","Earned","Revision" FROM app."ActivityWallet"
        WHERE "UserID" IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)}) ORDER BY "UserID" FOR UPDATE`);
      const now = new Date(), who = await owner(txApp, claims, characterId, now, true);
      const sourceRow = rows.find(row => row.UserID === characterId);
      if (!sourceRow) throw new ActivityError("赠送钱包锁定失败。", 503);
      const previous = await q1<{ Signature: string; Result: Pick<ActivityResult, "message" | "mailedCount"> }>(txApp.h,
        sql`SELECT "Signature","Result" FROM app."ActivityActions" WHERE "UserID"=${characterId} AND "RequestID"=${requestId}`);
      if (previous) {
        if (previous.Signature !== signature) throw new ActivityError("requestId已用于另一操作，请使用新的请求编号。", 409);
        const [state, ctx] = await Promise.all([stateOf(txApp, characterId, now), context(txApp, characterId, now)]);
        throw new GiftReplay({ characterId, ...viewActivities(state, walletOf(sourceRow), ctx), message: previous.Result.message,
          mailedCount: previous.Result.mailedCount, replayed: true });
      }
      if (!target) throw new ActivityError("收件角色无效或不能接收凭证。", 409);
      const recipient = await q1<{ UserID: number; NickName: string; IsExist: boolean; ForbidDate: Date; IsBanned: boolean }>(txApp.h,
        sql`SELECT d."UserID",d."NickName",d."IsExist",d."ForbidDate",a."IsBanned" FROM player."Sys_Users_Detail" d
          JOIN member."Accounts" a ON lower(a."UserName")=lower(d."UserName")
          WHERE d."UserID"=${target.UserID} AND lower(d."NickName")=lower(${a.recipientName}) FOR SHARE OF d,a`);
      const targetRow = rows.find(row => row.UserID === target.UserID);
      if (!recipient || !targetRow || !recipient.IsExist || recipient.IsBanned || new Date(recipient.ForbidDate).getTime() > now.getTime())
        throw new ActivityError("收件角色无效或不能接收凭证。", 409);
      const [sourceState, targetState, ctx] = await Promise.all([stateOf(txApp, characterId, now), stateOf(txApp, target.UserID, now), context(txApp, characterId, now)]);
      const result = transitionFirstRechargeGift(sourceState, targetState, a, ctx,
        { now, characterId: target.UserID, signDays: [], ownedTemplateIds: [] }, walletOf(sourceRow), who.NickName, recipient.NickName);
      const sourceNext = { ...walletOf(sourceRow), revision: sourceRow.Revision + 1 }, targetNext = { ...walletOf(targetRow), revision: targetRow.Revision + 1 };
      if (![sourceNext, targetNext].every(w => [w.points, w.earned, w.revision].every(int))) throw new ActivityError("赠送钱包状态无效。", 409);
      for (const [id, wallet, state] of [[characterId, sourceNext, result.source], [target.UserID, targetNext, result.target]] as const) {
        await tx.execute(sql`UPDATE app."ActivityWallet" SET "Revision"=${wallet.revision} WHERE "UserID"=${id}`);
        await tx.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${id},'reference',${JSON.stringify(state)}::jsonb)
          ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);
      }
      const receipt = { message: result.message, mailedCount: 0 };
      await tx.execute(sql`INSERT INTO app."ActivityActions" ("UserID","RequestID","Signature","Result") VALUES (${characterId},${requestId},${signature},${JSON.stringify(receipt)}::jsonb)`);
      return { characterId, ...viewActivities(result.source, sourceNext, ctx), ...receipt,
        nativeFirstRechargeAction: { requestId, effects: result.effects } };
    });
  } catch (err) { if (err instanceof GiftReplay) return err.result; throw err; }
}

class ForthrightRetry extends Error {}
async function forthrightReplay(app: AppCtx, claims: Claims, characterId: number, requestId: string, signature: string): Promise<ActivityResult | undefined> {
  return app.h.db.transaction(async tx => {
    const txApp: AppCtx = { ...app, h: { ...app.h, db: tx } }, now = new Date();
    const row = await q1<WalletRow>(txApp.h, sql`SELECT "Points","Earned","Revision" FROM app."ActivityWallet" WHERE "UserID"=${characterId} FOR UPDATE`);
    await owner(txApp, claims, characterId, now, true);
    const previous = await q1<{ Signature: string; Result: Pick<ActivityResult, "message" | "mailedCount"> }>(txApp.h,
      sql`SELECT "Signature","Result" FROM app."ActivityActions" WHERE "UserID"=${characterId} AND "RequestID"=${requestId}`);
    if (!previous) return undefined;
    if (previous.Signature !== signature) throw new ActivityError("requestId已用于另一操作，请使用新的请求编号。", 409);
    const [state, ctx] = await Promise.all([stateOf(txApp, characterId, now), context(txApp, characterId, now)]);
    return { characterId, ...viewActivities(state, walletOf(row), ctx), ...previous.Result, replayed: true };
  });
}
async function forthrightInspect(app: AppCtx, claims: Claims, characterId: number, requestId: string, action: ActivityAction, signature: string): Promise<ActivityResult> {
  const a = validateForthrightNativeAction(action); if (a.type !== "inspect-group") throw new ActivityError("查询操作无效。");
  const now = new Date(); await owner(app, claims, characterId, now);
  const previous = await q1<{ Signature: string }>(app.h, sql`SELECT "Signature" FROM app."ActivityActions" WHERE "UserID"=${characterId} AND "RequestID"=${requestId}`);
  if (previous && previous.Signature !== signature) throw new ActivityError("requestId已用于另一操作，请使用新的请求编号。", 409);
  const [state, row, ctx, groups] = await Promise.all([stateOf(app, characterId, now), q1<WalletRow>(app.h,
    sql`SELECT "Points","Earned","Revision" FROM app."ActivityWallet" WHERE "UserID"=${characterId}`), context(app, characterId, now), forthrightGroups(app, characterId, now, a.choice)]);
  if (!groups.some(g => g.code === a.choice)) throw new ActivityError("拼团不存在。", 404);
  return { characterId, ...viewActivities(state, walletOf(row), { ...ctx, forthrightGroups: groups, forthrightInspectCode: a.choice }), message: "拼团查询完成；本次查询未写入任何活动数据。" };
}
async function forthrightGroupAction(app: AppCtx, claims: Claims, characterId: number, requestId: string, action: ActivityAction, signature: string): Promise<ActivityResult> {
  const a = validateForthrightNativeAction(action), notices = new Set<number>();
  await owner(app, claims, characterId, new Date());
  for (let attempt = 0; attempt < 3; attempt++) {
    // A receipt is authoritative even if the original group has since been archived.
    const committed = await q1(app.h, sql`SELECT "Signature" FROM app."ActivityActions" WHERE "UserID"=${characterId} AND "RequestID"=${requestId}`);
    if (committed) { const replay = await forthrightReplay(app, claims, characterId, requestId, signature); if (replay) return replay; }
    const creatorId = a.type === "open-group" ? characterId : decodeForthrightCode(forthrightEntityCode(a.choice)).ownerId;
    const before = readForthrightNativeState((await stateOf(app, creatorId, new Date())).games.forthrightNativeV1);
    const sequence = a.type === "open-group" ? undefined : decodeForthrightCode(forthrightEntityCode(a.choice)).sequence;
    const preGroup = sequence === undefined ? undefined : before.createdGroups[String(sequence)];
    if (sequence !== undefined && !preGroup) {
      const replay = await forthrightReplay(app, claims, characterId, requestId, signature); if (replay) return replay;
      throw new ActivityError("拼团不存在。", 404);
    }
    const ids = [...new Set([characterId, creatorId, ...(preGroup?.members.map(m => m.characterId) ?? [])])].sort((x, y) => x - y);
    try {
      const result = await app.h.db.transaction(async tx => {
        const txApp: AppCtx = { ...app, h: { ...app.h, db: tx } };
        for (const id of ids) await tx.execute(sql`INSERT INTO app."ActivityWallet" ("UserID") VALUES (${id}) ON CONFLICT DO NOTHING`);
        const rows = await q<WalletRow & { UserID: number }>(txApp.h, sql`SELECT "UserID","Points","Earned","Revision" FROM app."ActivityWallet"
          WHERE "UserID" IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)}) ORDER BY "UserID" FOR UPDATE`);
        const now = new Date(); await owner(txApp, claims, characterId, now, true);
        const previous = await q1<{ Signature: string; Result: Pick<ActivityResult, "message" | "mailedCount"> }>(txApp.h,
          sql`SELECT "Signature","Result" FROM app."ActivityActions" WHERE "UserID"=${characterId} AND "RequestID"=${requestId}`);
        if (previous) {
          if (previous.Signature !== signature) throw new ActivityError("requestId已用于另一操作，请使用新的请求编号。", 409);
          const [state, ctx] = await Promise.all([stateOf(txApp, characterId, now), context(txApp, characterId, now)]);
          throw new GiftReplay({ characterId, ...viewActivities(state, walletOf(rows.find(r => r.UserID === characterId)), ctx), ...previous.Result, replayed: true });
        }
        const states = new Map(await Promise.all(ids.map(async id => [id, await stateOf(txApp, id, now)] as const)));
        if (sequence !== undefined) {
          const current = readForthrightNativeState(states.get(creatorId)!.games.forthrightNativeV1).createdGroups[String(sequence)];
          const actualIds = [...new Set([characterId, creatorId, ...(current?.members.map(m => m.characterId) ?? [])])].sort((x, y) => x - y);
          if (!current || canonical(actualIds) !== canonical(ids)) throw new ForthrightRetry();
        }
        const details = await q<Owner & { UserID: number }>(txApp.h, sql`SELECT "UserID","NickName","Sex" FROM player."Sys_Users_Detail"
          WHERE "UserID" IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)}) ORDER BY "UserID" FOR SHARE`);
        if (rows.length !== ids.length || details.length !== ids.length) throw new ActivityError("拼团成员资料缺失。", 409);
        const ctx = { ...await context(txApp, characterId, now), requestId };
        const changed = advanceForthrightGroup(ids.map(id => ({ characterId: id, nickname: details.find(d => d.UserID === id)!.NickName,
          root: states.get(id)!, wallet: walletOf(rows.find(r => r.UserID === id)) })), a, ctx);
        let mailedCount = 0, actorState: ActivityState | undefined, actorWallet: ActivityWallet | undefined;
        for (const role of changed.roles.sort((x, y) => x.characterId - y.characterId)) {
          const wallet = { points: role.wallet.points - role.cost + role.credited, earned: role.wallet.earned, revision: role.wallet.revision + 1 };
          if (![wallet.points, wallet.earned, wallet.revision].every(int)) throw new ActivityError("拼团结算积分或版本无效。", 409);
          if (role.cost > 0) role.root.games.chargeNativeV1 = recordChargeNativeSpending(role.root.games.chargeNativeV1, { now }, role.cost);
          const who = details.find(d => d.UserID === role.characterId)!;
          mailedCount += await rewardMail(txApp, role.characterId, who, role.rewards);
          if (role.notification) { await sendMail(txApp, role.characterId, who.NickName, "本地活动积分结算", role.notification, {}); mailedCount++; }
          if (role.rewards.length || role.notification) notices.add(role.characterId);
          await tx.execute(sql`UPDATE app."ActivityWallet" SET "Points"=${wallet.points},"Earned"=${wallet.earned},"Revision"=${wallet.revision} WHERE "UserID"=${role.characterId}`);
          await tx.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${role.characterId},'reference',${JSON.stringify(role.root)}::jsonb)
            ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);
          if (role.characterId === characterId) { actorState = role.root; actorWallet = wallet; }
        }
        const receipt = { message: changed.message, mailedCount };
        await tx.execute(sql`INSERT INTO app."ActivityActions" ("UserID","RequestID","Signature","Result") VALUES (${characterId},${requestId},${signature},${JSON.stringify(receipt)}::jsonb)`);
        return { characterId, ...viewActivities(actorState!, actorWallet!, { ...ctx, forthrightGroups: [...(ctx.forthrightGroups ?? []).filter(g => g.code !== changed.group.code), changed.group] }),
          ...receipt, nativeForthrightAction: { requestId, effects: changed.effects } };
      });
      for (const id of notices) await gameInternalPost(app, "/mail-notice", { userId: id });
      return result;
    } catch (err) { notices.clear(); if (err instanceof GiftReplay) return err.result; if (err instanceof ForthrightRetry) continue; throw err; }
  }
  throw new ActivityError("拼团成员刚刚变化，请刷新后重试。", 409);
}

export async function activityAction(app: AppCtx, claims: Claims, characterId: number, activityId: string, requestId: string, action: ActivityAction): Promise<ActivityResult> {
  if (activityId === "christmas-native") {
    await owner(app, claims, characterId, new Date());
    // Never hold an API wallet transaction while waiting for the actual game queue.
    const committed = isSnowfieldAction(action) ? await commandSnowfield(app, claims, characterId, requestId, action)
      : await commandChristmas(app, claims, characterId, requestId, action);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await activitySnapshot(app, claims, characterId, false);
      const pair = await readSnowfieldPair(app, claims, characterId, result.revision, result.day, result.points, result.earned);
      const view = pair.snowman;
      if (view.revision !== result.revision || view.day !== result.day) continue;
      const committedView = "pair" in committed ? committed.pair.snowman : committed.view;
      let synchronizeOnly = committed.replayed || committedView.revision !== view.revision || committedView.day !== view.day;
      if ("pair" in committed) {
        const field = pair.snowfield, effect = committed.nativeChristmasAction?.effects[0];
        synchronizeOnly ||= !field.available || !effect || effect.committedRevision !== result.revision
          || effect.committedSceneRevision !== field.scene.revision || committed.pair.snowfield.scene.revision !== field.scene.revision
          || action.type === "enter" && !field.scene.canResume || action.type === "challenge" && !field.attempt.canResume;
      } else synchronizeOnly ||= !view.available;
      return { ...result, nativeChristmas: view, nativeChristmasSnowfield: pair.snowfield, message: committed.message, mailedCount: committed.mailedCount,
        ...(synchronizeOnly ? { replayed: true } : { nativeChristmasAction: committed.nativeChristmasAction }) };
    }
    throw new ActivityError("圣诞已由原请求编号结算，当前投影暂不一致，请保留同一请求编号重试。", 503);
  }
  if (activityId === "exchange-native") {
    await owner(app, claims, characterId, new Date());
    // No API transaction/row lock may span an internal game command.
    const committed = await commandExchange(app, claims, characterId, requestId, action);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await activitySnapshot(app, claims, characterId, false);
      const view = committed.view.revision === result.revision && committed.view.day === result.day ? committed.view
        : await readExchangeProjection(app, claims, characterId, result.revision, result.day);
      if (view.authority === "unavailable" || view.revision !== result.revision) continue;
      return { ...result, nativeExchange: view, message: committed.message, mailedCount: committed.mailedCount,
        ...(committed.replayed ? { replayed: true } : { nativeExchangeAction: committed.nativeExchangeAction }) };
    }
    throw new ActivityError("兑换已由原请求编号结算，当前投影暂不一致，请保留同一请求编号重试。", 503);
  }
  const signature = createHash("sha256").update(canonical({ activityId, action })).digest("hex");
  if (activityId === "first-recharge-native" && action.type === "gift-card") return firstRechargeGift(app, claims, characterId, requestId, action, signature);
  if (activityId === "forthright-native" && action.type === "inspect-group") return forthrightInspect(app, claims, characterId, requestId, action, signature);
  if (activityId === "forthright-native" && ["open-group", "join-group", "leave-group", "cancel-group", "settle-group"].includes(action.type))
    return forthrightGroupAction(app, claims, characterId, requestId, action, signature);
  let mailed = false;
  const result = await app.h.db.transaction(async (tx) => {
    const txApp: AppCtx = { ...app, h: { ...app.h, db: tx } };
    await tx.execute(sql`INSERT INTO app."ActivityWallet" ("UserID") VALUES (${characterId}) ON CONFLICT DO NOTHING`);
    const row = await q1<WalletRow>(txApp.h, sql`SELECT "Points","Earned","Revision" FROM app."ActivityWallet" WHERE "UserID"=${characterId} FOR UPDATE`);
    const now = new Date();
    const who = await owner(txApp, claims, characterId, now, true);
    // Signing remains owned by the original game handler, not a local completion flag.
    if (activityId === "sign") throw new ActivityError("请通过游戏中的原签到入口签到。", 400);
    const previous = await q1<{ Signature: string; Result: Pick<ActivityResult, "message" | "mailedCount"> }>(txApp.h, sql`SELECT "Signature","Result" FROM app."ActivityActions" WHERE "UserID"=${characterId} AND "RequestID"=${requestId}`);
    if (previous) {
      if (previous.Signature !== signature) throw new ActivityError("requestId已用于另一操作，请使用新的请求编号。", 409);
      // Keep the original receipt intact, but never let its historical page replace newer state.
      const [state, ctx] = await Promise.all([stateOf(txApp, characterId, now), context(txApp, characterId, now)]);
      return { characterId, ...viewActivities(state, walletOf(row), ctx), message: previous.Result.message, mailedCount: previous.Result.mailedCount, replayed: true };
    }
    const wallet = walletOf(row);
    const state = await stateOf(txApp, characterId, now);
    const ctx = { ...await context(txApp, characterId, now), requestId };
    const changed = transitionActivity(state, activityId, action, ctx, wallet);
    const next: ActivityWallet = { points: wallet.points + changed.pointsDelta, earned: wallet.earned + changed.earnedDelta, revision: wallet.revision + 1 };
    if (![changed.pointsDelta, changed.earnedDelta].every(Number.isInteger) || changed.earnedDelta < 0 || ![next.points, next.earned, next.revision].every(int)) throw new ActivityError("活动积分不足或结算配置无效。", 409);
    let mailedCount = await rewardMail(txApp, characterId, who, changed.rewards);
    if (changed.nativeForthrightNotification) { await sendMail(txApp, characterId, who.NickName, "本地活动积分结算", changed.nativeForthrightNotification, {}); mailedCount++; }
    await tx.execute(sql`UPDATE app."ActivityWallet" SET "Points"=${next.points},"Earned"=${next.earned},"Revision"=${next.revision} WHERE "UserID"=${characterId}`);
    await tx.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${characterId},'reference',${JSON.stringify(changed.state)}::jsonb)
      ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);
    const response: ActivityResult = { characterId, ...viewActivities(changed.state, next, ctx), message: changed.message, mailedCount,
      ...(changed.nativePairEffects ? { nativePairAction: { requestId, effects: changed.nativePairEffects } } : {}),
      ...(changed.nativeMinesEffects ? { nativeMinesAction: { requestId, effects: changed.nativeMinesEffects } } : {}),
      ...(changed.nativeDDPlayEffects ? { nativeDDPlayAction: { requestId, effects: changed.nativeDDPlayEffects } } : {}),
      ...(changed.nativeGypsyEffects ? { nativeGypsyAction: { requestId, effects: changed.nativeGypsyEffects } } : {}),
      ...(changed.nativeMoonlightEffects ? { nativeMoonlightAction: { requestId, effects: changed.nativeMoonlightEffects } } : {}),
      ...(changed.nativeTreasureEffects ? { nativeTreasureAction: { requestId, effects: changed.nativeTreasureEffects } } : {}),
      ...(changed.nativeWheelEffects ? { nativeWheelAction: { requestId, effects: changed.nativeWheelEffects } } : {}),
      ...(changed.nativeCarnivalEffects ? { nativeCarnivalAction: { requestId, effects: changed.nativeCarnivalEffects } } : {}),
      ...(changed.nativeFirstRechargeEffects ? { nativeFirstRechargeAction: { requestId, effects: changed.nativeFirstRechargeEffects } } : {}),
      ...(changed.nativeChargeEffects ? { nativeChargeAction: { requestId, effects: changed.nativeChargeEffects } } : {}),
      ...(changed.nativeForthrightEffects ? { nativeForthrightAction: { requestId, effects: changed.nativeForthrightEffects } } : {}), ...(changed.nativeDevilEffects ? { nativeDevilAction: { requestId, effects: changed.nativeDevilEffects } } : {}), ...(changed.nativeCaveLootEffects ? { nativeCaveLootAction: { requestId, effects: changed.nativeCaveLootEffects } } : {}) };
    // Store only the immutable receipt; repeating all 17 views here would grow saves on every click.
    const receipt = { message: changed.message, mailedCount };
    await tx.execute(sql`INSERT INTO app."ActivityActions" ("UserID","RequestID","Signature","Result") VALUES (${characterId},${requestId},${signature},${JSON.stringify(receipt)}::jsonb)`);
    mailed = changed.rewards.length > 0 || !!changed.nativeForthrightNotification;
    return response;
  });
  if (mailed) await gameInternalPost(app, "/mail-notice", { userId: characterId });
  return result;
}
