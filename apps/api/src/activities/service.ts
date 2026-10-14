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
import { createActivityState, transitionActivity, viewActivities } from "./engine.js";
import type { PairNativeEffect } from "./pair-native.js";
import type { MinesNativeEffect } from "./mines-native.js";
import type { DDPlayNativeEffect } from "./ddplay-native.js";
import type { GypsyNativeEffect } from "./gypsy-native.js";
import type { MoonlightNativeEffect } from "./moonlight-native.js";
import type { TreasureNativeEffect } from "./treasure-native.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivitySnapshot, type ActivityState, type ActivityWallet } from "./types.js";

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

async function context(app: AppCtx, characterId: number, now: Date): Promise<ActivityContext> {
  const [signs, owned, wardrobe] = await Promise.all([
    q<{ Key: string }>(app.h, sql`SELECT "Key" FROM app."EventClaims" WHERE "UserID"=${characterId} AND "Kind"='sign' ORDER BY "Key"`),
    q<{ TemplateID: number }>(app.h, sql`SELECT DISTINCT "TemplateID" FROM player."Sys_Users_Goods" WHERE "UserID"=${characterId} AND "IsExist"=true AND "Count">0
      AND ("ValidDate"=0 OR "IsUsed"=false OR "BeginDate" + "ValidDate" * interval '1 day' > ${now}) ORDER BY "TemplateID"`),
    q<WardrobeRow>(app.h, sql`SELECT t."TemplateID",COALESCE(tr."text",t."Name") AS "Name",t."CategoryID",t."Pic",t."NeedSex" FROM game."Shop_Goods" t
      LEFT JOIN app."Translations" tr ON tr."table"='Shop_Goods' AND tr."column"='Name' AND tr."rowId"=t."TemplateID"::text AND tr."lang"='zh-CN'
      WHERE t."CategoryID" IN (1,2,3,4,5,6,13,15) ORDER BY t."TemplateID"`),
  ]);
  return { now, signDays: signs.map((s) => s.Key), ownedTemplateIds: owned.map((i) => i.TemplateID),
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

export async function activitySnapshot(app: AppCtx, claims: Claims, characterId: number): Promise<ActivityResult> {
  const now = new Date();
  await owner(app, claims, characterId, now);
  // GET is read-only: an unstarted character gets an in-memory default, not a persisted board.
  const [row, ctx] = await Promise.all([
    q1<WalletRow & { State: ActivityState | null }>(app.h, sql`SELECT w."Points",w."Earned",w."Revision",s."State" FROM app."ActivityWallet" w
      LEFT JOIN app."ActivityStates" s ON s."UserID"=w."UserID" AND s."Activity"='reference' WHERE w."UserID"=${characterId}`),
    context(app, characterId, now),
  ]);
  return { characterId, ...viewActivities(row?.State ?? createActivityState(now), walletOf(row), ctx) };
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

export async function activityAction(app: AppCtx, claims: Claims, characterId: number, activityId: string, requestId: string, action: ActivityAction): Promise<ActivityResult> {
  const signature = createHash("sha256").update(canonical({ activityId, action })).digest("hex");
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
    const ctx = await context(txApp, characterId, now);
    const changed = transitionActivity(state, activityId, action, ctx, wallet);
    const next: ActivityWallet = { points: wallet.points + changed.pointsDelta, earned: wallet.earned + changed.earnedDelta, revision: wallet.revision + 1 };
    if (![changed.pointsDelta, changed.earnedDelta].every(Number.isInteger) || changed.earnedDelta < 0 || ![next.points, next.earned, next.revision].every(int)) throw new ActivityError("活动积分不足或结算配置无效。", 409);
    const mailedCount = await rewardMail(txApp, characterId, who, changed.rewards);
    await tx.execute(sql`UPDATE app."ActivityWallet" SET "Points"=${next.points},"Earned"=${next.earned},"Revision"=${next.revision} WHERE "UserID"=${characterId}`);
    await tx.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${characterId},'reference',${JSON.stringify(changed.state)}::jsonb)
      ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);
    const response: ActivityResult = { characterId, ...viewActivities(changed.state, next, ctx), message: changed.message, mailedCount,
      ...(changed.nativePairEffects ? { nativePairAction: { requestId, effects: changed.nativePairEffects } } : {}),
      ...(changed.nativeMinesEffects ? { nativeMinesAction: { requestId, effects: changed.nativeMinesEffects } } : {}),
      ...(changed.nativeDDPlayEffects ? { nativeDDPlayAction: { requestId, effects: changed.nativeDDPlayEffects } } : {}),
      ...(changed.nativeGypsyEffects ? { nativeGypsyAction: { requestId, effects: changed.nativeGypsyEffects } } : {}),
      ...(changed.nativeMoonlightEffects ? { nativeMoonlightAction: { requestId, effects: changed.nativeMoonlightEffects } } : {}),
      ...(changed.nativeTreasureEffects ? { nativeTreasureAction: { requestId, effects: changed.nativeTreasureEffects } } : {}) };
    // Store only the immutable receipt; repeating all 17 views here would grow saves on every click.
    const receipt = { message: changed.message, mailedCount };
    await tx.execute(sql`INSERT INTO app."ActivityActions" ("UserID","RequestID","Signature","Result") VALUES (${characterId},${requestId},${signature},${JSON.stringify(receipt)}::jsonb)`);
    mailed = changed.rewards.length > 0;
    return response;
  });
  if (mailed) await gameInternalPost(app, "/mail-notice", { userId: characterId });
  return result;
}
