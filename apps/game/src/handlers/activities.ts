/**
 * Events/Activities batch (QA-MATRIX "Eventos/Atividades"): the hall-icon systems that still had no handler.
 * Faithfully ported where the original had a real implementation; three codes (104 CARD_LOTTERY, 105 LUCK_LOTTERY,
 * 239 GOTO_CARD_LOTTERY) and the GuildMemberWeek/LanternRiddles/LightRoad sub-ranges of 145 ACTIVITY_SYSTEM are
 * confirmed DEAD in the original too (ePackageType exists but no [PacketHandler] class subscribes to it, or —
 * ActiveSystemHandler.cs — the handler builds a packet for sub 8 and never sends it): left unregistered here,
 * exactly matching that behaviour. 128/130 (LeftGunHandler/LeftGunCompleteHandler) are commented-out dead code in
 * the original's own source; same treatment.
 *
 * Reward pools for chicken box / lucky star aren't in any migrated table (Items_Box's EventAwardItem companion
 * table was never populated in the source .bak), so — like 102 WORLDBOSS_CMD's rankAwards — they are configured
 * through `app."ScheduledEvents"` params (kinds "chickenbox" / "luckystar" / "labyrinth", admin Events page),
 * with built-in defaults so the feature works unconfigured. Idempotency: every reward path either consumes the
 * source item/currency before granting (anti-replay, same rule as use.ts) or goes through claimOnce.
 */
import { eq, sql } from "drizzle-orm";
import { GSPacket } from "@ddt/protocol";
import { ItemInfo, templateBagType } from "../game/item.js";
import type { GamePlayer } from "../game/player.js";
import type { ServerContext } from "../session/context.js";
import type { ItemBoxRow } from "../db/templates.js";
import { claimOnce, grantRewards, type Reward } from "../game/events.js";
import { eventsRuntime } from "./events.js";
import { createItemBox } from "./use.js";
import { mailItems } from "./items.js";
import * as Out from "../packets/out.js";
import type { HandlerRegistry } from "./registry.js";
import { labyrinthHandler } from "../game/labyrinth.js";
export { labyrinthHandler, labyrinthTryAgainMoney } from "../game/labyrinth.js";
export type { LabyrinthRow } from "../game/labyrinth.js";

// ------------------------------------------------------------------ shared reward-pool config
export interface PoolItem { templateId: number; count: number; validDate?: number; isBind?: boolean; quality?: number; weight?: number }

const DEFAULT_CHICKENBOX_POOL: PoolItem[] = [
  { templateId: 11107, count: 500 }, { templateId: 11107, count: 1000 }, { templateId: 11456, count: 5 },
  { templateId: 11408, count: 10 }, { templateId: 112059, count: 1 }, { templateId: 11023, count: 3 },
  { templateId: 11020, count: 3 }, { templateId: 11018, count: 2 }, { templateId: 11444, count: 3 },
];
const DEFAULT_LUCKYSTAR_POOL: PoolItem[] = [
  { templateId: 11107, count: 300, weight: 30 }, { templateId: 11107, count: 800, weight: 15 },
  { templateId: 11456, count: 3, weight: 20 }, { templateId: 11408, count: 5, weight: 20 },
  { templateId: 11023, count: 2, weight: 15 }, { templateId: 11444, count: 2, weight: 15 },
];

function paramsOf(ctx: ServerContext, kind: string): Record<string, unknown> {
  return (eventsRuntime(ctx).scheduler.events.find((e) => e.kind === kind)?.params ?? {}) as Record<string, unknown>;
}
function isOpen(ctx: ServerContext, kind: string): boolean {
  const ev = eventsRuntime(ctx).scheduler.events.find((e) => e.kind === kind);
  return !ev || ev.enabled !== false;
}
function pool(ctx: ServerContext, kind: string, fallback: PoolItem[]): PoolItem[] {
  const p = paramsOf(ctx, kind).pool;
  return Array.isArray(p) && p.length ? (p as PoolItem[]) : fallback;
}
function num(ctx: ServerContext, kind: string, key: string, fb: number): number {
  const v = paramsOf(ctx, kind)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fb; // 0 is a valid admin override (e.g. a free feature)
}
function arr(ctx: ServerContext, kind: string, key: string, fb: number[]): number[] {
  const v = paramsOf(ctx, kind)[key];
  return Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : fb;
}

// ------------------------------------------------------------------ 26/27/28/45/204/232 caddy & lottery
/** GamePlayer.Lottery/LotteryID/LotteryItems/LotteryAwardList (in-memory, same as the original). */
interface LotteryState { lottery: number; lotteryId: number; items: ItemBoxRow[]; awards: ItemInfo[] }
const lotteryOf = new WeakMap<GamePlayer, LotteryState>();
function lottery(p: GamePlayer): LotteryState {
  let s = lotteryOf.get(p);
  if (!s) lotteryOf.set(p, (s = { lottery: -1, lotteryId: 0, items: [], awards: [] }));
  return s;
}

function resetLottery(p: GamePlayer): void {
  const s = lottery(p);
  s.lottery = -1; s.lotteryId = 0; s.items = []; s.awards = [];
}

/** ItemBoxMgr.FindLotteryItemBoxByRand: 18 distinct-by-(template,count) rows sampled without replacement. */
export function pickLotteryBoard(rows: ItemBoxRow[], rnd = Math.random): ItemBoxRow[] {
  const seen = new Set<string>();
  const dedup = rows.filter((r) => { const k = `${r.TemplateId}:${r.ItemCount}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const pick: ItemBoxRow[] = [];
  const left = [...dedup];
  for (let i = 0; i < 18; i++) {
    if (!left.length) { if (!dedup.length) break; pick.push(dedup[Math.floor(rnd() * dedup.length)]!); continue; }
    pick.push(left.splice(Math.floor(rnd() * left.length), 1)[0]!);
  }
  return pick;
}

function lotteryBoardPkt(lotteryId: number, items: ItemBoxRow[]): GSPacket {
  const p = new GSPacket(29);
  p.writeInt(lotteryId);
  for (let i = 0; i < 18; i++) {
    const it = items[i];
    p.writeInt(it?.TemplateId ?? 0); p.writeBoolean(it?.IsBind ?? true); p.writeByte(it?.ItemCount ?? 0); p.writeByte(it?.ItemValid ?? 0);
  }
  return p;
}

function caddyAwardsPkt(items: ItemInfo[], name: string): GSPacket {
  const p = new GSPacket(245);
  p.writeBoolean(items.length > 0);
  p.writeInt(items.length);
  for (const it of items) { p.writeString(name); p.writeInt(it.TemplateID); p.writeInt(4); p.writeBoolean(false); }
  return p;
}

/** 26 LOTTERY_OPEN_BOX: byte bagType, int slot, int num. num=-1 -> open the "god of wealth" 18-slot board (item at slot
 *  must be 112019/190000); else num is the templateId of a chest to open directly (ItemBoxMgr.CreateItemBox). */
export async function lotteryOpenBox(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  const s = lottery(p);
  if (s.lottery !== -1) return p.sendMessage(0, "O baú já está ativo!");
  const bagType = pkt.readByte();
  const slot = pkt.readInt();
  const idNum = pkt.readInt();
  const bag = p.getInventory(bagType);
  if (idNum === -1) {
    const it = bag?.getItemAt(slot);
    if (!it || (it.TemplateID !== 112019 && it.TemplateID !== 190000)) return;
    const rows = pickLotteryBoard(ctx.templates.itemBoxes.get(it.TemplateID) ?? [], Math.random);
    if (!bag!.removeCountFromStack(it, 1)) return;
    s.lottery = 0; s.lotteryId = it.TemplateID; s.items = rows;
    return p.send(lotteryBoardPkt(it.TemplateID, rows));
  }
  const dest = bag ?? p.caddyBag;
  if (dest.findFirstEmptySlot() === -1) { p.sendMessage(0, "O baú está cheio, não é possível abrir mais!"); return void p.send(caddyAwardsPkt(p.caddyBag.getItems(), "")); }
  const chest = [...p.allBags()].map((b) => b.getItemByTemplateID(0, idNum)).find((x) => x);
  if (!chest || chest.Count < 1) return void p.send(caddyAwardsPkt(p.caddyBag.getItems(), ""));
  const special = idNum === 112047 || idNum === 112100 || idNum === 112101;
  if (special) {
    const key = p.propBag.getItemByTemplateID(0, 11456);
    if (!key || key.Count < 4) { p.sendMessage(0, `${key?.template.Name ?? "Chave"} insuficiente.`); return void p.send(caddyAwardsPkt(p.caddyBag.getItems(), "")); }
    p.propBag.removeTemplate(11456, 4);
    await bumpCaddyOpenCount(ctx, p);
  }
  const r = createItemBox(ctx.templates.itemBoxes.get(idNum));
  if (!r) return void p.send(caddyAwardsPkt(p.caddyBag.getItems(), ""));
  let name = "";
  const rewards: Reward[] = [];
  if (r.gold) p.addGold(r.gold);
  if (r.giftToken) p.addGiftToken(r.giftToken);
  for (const x of r.items) { rewards.push({ templateId: x.row.TemplateId, count: x.count, validDate: x.row.ItemValid, isBind: x.row.IsBind }); name = ctx.templates.findItem(x.row.TemplateId)?.Name ?? name; }
  for (const b of p.allBags()) if (b.removeTemplate(idNum, 1)) break;
  const g = grantRewards(p, rewards, ctx.templates.findItem, ctx.now());
  if (g.overflow.length) await mailItems(ctx, p, g.overflow, "Abrir baú", 8);
  s.lottery = -1;
  p.send(caddyAwardsPkt(p.caddyBag.getItems(), name));
  if (g.summary.length) p.sendMessage(0, `Você recebeu ${g.summary.join(", ")}.`);
}

/** Sys_Users_Extra.TotalCaddyOpen (UsersExtraInfo.AddBadLuckCaddy): atomic SQL increment, offline-safe. */
async function bumpCaddyOpenCount(ctx: ServerContext, p: GamePlayer): Promise<void> {
  await ctx.db.db.execute(sql`INSERT INTO player."Sys_Users_Extra" ("UserID","TotalCaddyOpen") VALUES (${p.id}, 1)
    ON CONFLICT ("UserID") DO UPDATE SET "TotalCaddyOpen" = "Sys_Users_Extra"."TotalCaddyOpen" + 1`);
  if (p.extra) (p.extra as unknown as { TotalCaddyOpen: number }).TotalCaddyOpen = ((p.extra as unknown as { TotalCaddyOpen: number }).TotalCaddyOpen ?? 0) + 1;
}

/** 27 LOTTERY_RANDOM_SELECT: draw 1 card from the 18-board, max 8 draws, draw n costs n keys (escalating, as original). */
export async function lotteryRandomSelect(ctx: ServerContext, p: GamePlayer): Promise<void> {
  const s = lottery(p);
  if (s.lottery < 0 || s.lotteryId <= 0) return p.sendMessage(0, "Você ainda não abriu o baú.");
  if (s.lottery >= 8) return p.sendMessage(0, "Você não tem mais aberturas de baú.");
  const keyId = s.lotteryId === 190000 ? 190001 : 11444;
  const have = p.propBag.getItemByTemplateID(0, keyId)?.Count ?? 0;
  if (have < s.lottery + 1) return p.sendMessage(0, "Chaves insuficientes para abrir o baú.");
  s.lottery++;
  const r = createItemBox(s.items);
  if (!r || !r.items.length) return p.sendMessage(0, "Erro ao obter os dados da recompensa.");
  const picked = r.items[0]!;
  const idx = s.items.findIndex((x) => x.TemplateId === picked.row.TemplateId && x.ItemCount === picked.count);
  if (idx >= 0) s.items.splice(idx, 1);
  const tpl = ctx.templates.findItem(picked.row.TemplateId);
  const it = ItemInfo.createFromTemplate(tpl ?? ({ TemplateID: picked.row.TemplateId, MaxCount: 1 } as never), picked.count, 105, ctx.now());
  it.IsBinds = picked.row.IsBind; it.ValidDate = picked.row.ItemValid;
  s.awards.push(it);
  p.propBag.removeTemplate(keyId, s.lottery);
  const out = new GSPacket(30);
  out.writeBoolean(true); out.writeInt(it.TemplateID); out.writeInt(tpl?.Quality ?? 0); out.writeInt(0);
  out.writeInt(0); out.writeInt(0); out.writeInt(0); out.writeInt(0); out.writeBoolean(it.IsBinds); out.writeInt(it.ValidDate); out.writeByte(it.Count);
  p.send(out);
}

/** 28 LOTTERY_FINISH: move CaddyBag + LotteryAwardList into real bags (overflow by mail), ResetLottery. */
export async function lotteryFinish(ctx: ServerContext, p: GamePlayer): Promise<void> {
  const s = lottery(p);
  const overflow: ItemInfo[] = [];
  for (const it of [...p.caddyBag.getItems()]) {
    p.caddyBag.takeOutItem(it);
    if (!p.addTemplateToBag(it, templateBagType(it.template), it.Count)) overflow.push(it);
  }
  if (s.lottery !== -1 && s.awards.length) {
    for (const it of s.awards) if (!p.addTemplateToBag(it, templateBagType(it.template), it.Count)) overflow.push(it);
  }
  if (overflow.length) await mailItems(ctx, p, overflow, "Mochila cheia, itens enviados por correio", 8);
  resetLottery(p);
}

/** 45 CADDY_GET_BADLUCK: WorldMgr.CaddyRank — top 20 by Sys_Users_Extra.TotalCaddyOpen. */
async function caddyBadLuck(ctx: ServerContext, p: GamePlayer): Promise<void> {
  const res = (await ctx.db.db.execute(sql`
    SELECT d."UserID" AS id, d."NickName" AS nick, COALESCE(e."TotalCaddyOpen",0) AS n
    FROM player."Sys_Users_Detail" d LEFT JOIN player."Sys_Users_Extra" e ON e."UserID" = d."UserID"
    WHERE COALESCE(e."TotalCaddyOpen",0) > 0 ORDER BY n DESC LIMIT 20`)) as unknown;
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as { id: number; nick: string; n: number }[];
  const out = new GSPacket(45);
  out.writeString(ctx.now().toISOString());
  out.writeInt(rows.length);
  rows.forEach((r, i) => { out.writeInt(i + 1); out.writeInt(r.id); out.writeInt(Number(r.n)); out.writeInt(0); out.writeString(r.nick ?? ""); });
  p.send(out);
}

/** 204 OPEN_ALL_CARDBOX: every CaddyBag item -> CardBag.AddCard(Property5, rand 1..2). */
function openAllCardBox(p: GamePlayer): void {
  for (const it of [...p.caddyBag.getItems()]) {
    p.caddyBag.removeItem(it);
    const n = 1 + Math.floor(Math.random() * 2);
    p.cardBag.addCard(it.template.Property5, n);
    p.sendMessage(0, `Você abriu ${it.template.Name} e recebeu ${n} carta(s).`);
  }
}

/** 232 (CaddyClearAllHandler, confusingly ePackageType-unnamed "CADDY_SELL_ALL_GOODS" client-side): reclaim every
 *  CaddyBag item for gold/giftToken (Item.ReclaimType 1 = gold, 2 = giftToken) and clear the bag. */
function caddySellAll(p: GamePlayer): void {
  let gold = 0, giftToken = 0;
  for (const it of [...p.caddyBag.getItems()]) {
    if (it.template.ReclaimType === 1) gold += it.template.ReclaimValue * it.Count;
    else if (it.template.ReclaimType === 2) giftToken += it.template.ReclaimValue * it.Count;
    p.caddyBag.removeItem(it);
  }
  p.beginChanges();
  if (gold) p.addGold(gold);
  if (giftToken) p.addGiftToken(giftToken);
  p.commitChanges();
  const msg = [gold ? `Você recebeu ${gold} de ouro` : "", giftToken ? `Você recebeu ${giftToken} Cupons` : ""].filter(Boolean).join(" ");
  if (msg) p.sendMessage(0, msg);
}

// ------------------------------------------------------------------ 87 NEWCHICKENBOX_SYS (chicken box + lucky star)
export interface Card { templateId: number; count: number; strengthenLevel: number; validDate: number; atk: number; def: number; agi: number; luck: number; position: number; isSelected: boolean; isSeeded: boolean; isBind: boolean; weight: number }
interface ChickenState { rewards: Card[]; lastFlushTime: Date; isShowAll: boolean; canOpenCounts: number; canEagleEyeCounts: number }
const chickenOf = new WeakMap<GamePlayer, ChickenState>();
interface LuckyState { rewards: Card[]; award: Card | null; lastTurn: number; coins: number }
const luckyOf = new WeakMap<GamePlayer, LuckyState>();

const COIN_TEMPLATE = 201193;
const LUCKYSTAR_ITEM = 201192;
const DEFAULT_COINS = 500;
const FLUSH_COINS = 15;

function card(it: PoolItem, position: number): Card {
  return { templateId: it.templateId, count: it.count, strengthenLevel: 0, validDate: it.validDate ?? 0, atk: 0, def: 0, agi: 0, luck: 0, position, isSelected: false, isSeeded: false, isBind: it.isBind ?? true, weight: it.weight ?? 1000 };
}

export function drawDistinct(rows: PoolItem[], count: number): Card[] {
  const out: Card[] = [];
  const used = new Set<number>();
  let guard = 0;
  while (out.length < count && guard++ < count * 50) {
    const r = rows[Math.floor(Math.random() * rows.length)];
    if (!r || used.has(r.templateId)) { if (used.size >= rows.length) break; continue; }
    used.add(r.templateId);
    out.push(card(r, out.length));
  }
  return out;
}

function flushChickenBox(ctx: ServerContext, p: GamePlayer): ChickenState {
  const rows = pool(ctx, "chickenbox", DEFAULT_CHICKENBOX_POOL);
  const s: ChickenState = { rewards: drawDistinct(rows, 18), lastFlushTime: ctx.now(), isShowAll: true, canOpenCounts: 5, canEagleEyeCounts: 5 };
  chickenOf.set(p, s);
  return s;
}
function chickenState(ctx: ServerContext, p: GamePlayer): ChickenState {
  return chickenOf.get(p) ?? flushChickenBox(ctx, p);
}
const FREE_FLUSH_MIN = 120;
function isFreeFlushTime(s: ChickenState, now: Date): boolean {
  return now.getTime() - s.lastFlushTime.getTime() < FREE_FLUSH_MIN * 60_000;
}

function chickenListPkt(ctx: ServerContext, s: ChickenState): GSPacket {
  const p = new GSPacket(87);
  p.writeInt(3); Out.wd(p, s.lastFlushTime); p.writeInt(FREE_FLUSH_MIN); p.writeInt(0); p.writeInt(0); p.writeInt(0);
  p.writeBoolean(s.isShowAll); p.writeInt(s.rewards.length);
  for (const c of s.rewards) { p.writeInt(c.templateId); p.writeInt(c.strengthenLevel); p.writeInt(c.count); p.writeInt(c.validDate); p.writeInt(c.atk); p.writeInt(c.def); p.writeInt(c.agi); p.writeInt(c.luck); p.writeInt(c.position); p.writeBoolean(c.isSelected); p.writeBoolean(c.isSeeded); p.writeBoolean(c.isBind); }
  return p;
}

function setupLucky(ctx: ServerContext, p: GamePlayer): LuckyState {
  const rows = pool(ctx, "luckystar", DEFAULT_LUCKYSTAR_POOL);
  const rewards = drawDistinct(rows, 14);
  if (rewards.length) rewards[0] = { templateId: COIN_TEMPLATE, count: 1, strengthenLevel: 0, validDate: 0, atk: 0, def: 0, agi: 0, luck: 0, position: 0, isSelected: false, isSeeded: false, isBind: true, weight: 1000 };
  for (let i = rewards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rewards[i], rewards[j]] = [rewards[j]!, rewards[i]!]; }
  const s: LuckyState = { rewards, award: null, lastTurn: 0, coins: DEFAULT_COINS };
  luckyOf.set(p, s);
  return s;
}

/** PlayerActives.GetAward: weighted pick by `.weight`; if the coin slot wins and rand(100)>3, re-roll excluding coin. */
export function luckyDraw(s: LuckyState): Card {
  const pick = (rows: Card[]): Card => {
    const total = rows.reduce((a, c) => a + c.weight, 0);
    let r = Math.random() * total;
    for (const c of rows) { if (r < c.weight) return c; r -= c.weight; }
    return rows[rows.length - 1]!;
  };
  let award = pick(s.rewards);
  if (award.templateId === COIN_TEMPLATE && Math.random() * 100 > 3) {
    const rest = s.rewards.filter((c) => c.templateId !== COIN_TEMPLATE);
    if (rest.length) award = pick(rest);
  }
  return award;
}

export function chickenBoxHandler(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): void {
  const cmd = pkt.readInt();
  if ([10, 11, 12, 13, 14, 15].includes(cmd) && !isOpen(ctx, "chickenbox")) return p.sendMessage(0, "O Baú do Rei Galo está fechado.");
  if ([31, 32, 33, 34].includes(cmd) && !isOpen(ctx, "luckystar")) return p.sendMessage(0, "A Estrela da Sorte está fechada.");
  const openPrice = arr(ctx, "chickenbox", "openCardPrice", [100, 200, 300, 500, 800]);
  const eyePrice = arr(ctx, "chickenbox", "eagleEyePrice", [50, 100, 150, 250, 400]);
  switch (cmd) {
    case 13: { // TAKEOVERCARD
      const pos = pkt.readInt();
      const s = chickenState(ctx, p);
      if (s.canOpenCounts <= 0) return p.sendMessage(0, "Você usou todas as aberturas de cartas.");
      const c = s.rewards.find((x) => x.position === pos && !x.isSelected);
      if (!c) return p.sendMessage(0, "Carta não encontrada.");
      const price = openPrice[Math.min(s.canOpenCounts, openPrice.length) - 1] ?? openPrice[openPrice.length - 1]!;
      if (p.info.Money < price) return p.sendMessage(0, "Cupons insuficientes.");
      p.removeMoney(price);
      c.isSelected = true; c.isBind = true;
      const out = new GSPacket(87);
      out.writeInt(13); out.writeInt(c.templateId); out.writeInt(c.strengthenLevel); out.writeInt(c.count); out.writeInt(c.validDate);
      out.writeInt(c.atk); out.writeInt(c.def); out.writeInt(c.agi); out.writeInt(c.luck); out.writeInt(c.position);
      out.writeBoolean(c.isSelected); out.writeBoolean(c.isSeeded); out.writeBoolean(c.isBind); out.writeInt(0);
      p.send(out);
      const tpl = ctx.templates.findItem(c.templateId);
      if (tpl) { const g = grantRewards(p, [{ templateId: c.templateId, count: c.count, isBind: true }], ctx.templates.findItem, ctx.now()); if (g.overflow.length) void mailItems(ctx, p, g.overflow, "Carta", 8); p.sendMessage(0, `Você recebeu ${tpl.Name ?? c.templateId} x${c.count}.`); }
      s.canOpenCounts--;
      if (s.canOpenCounts === 0) { const sp = new GSPacket(87); sp.writeInt(12); p.send(sp); }
      return;
    }
    case 11: { // USEEAGLEEYE
      const pos = pkt.readInt();
      const s = chickenState(ctx, p);
      if (s.canEagleEyeCounts <= 0) return p.sendMessage(0, "Você usou todas as revelações de cartas.");
      const c = s.rewards.find((x) => x.position === pos && !x.isSeeded);
      if (!c) return p.sendMessage(0, "Carta não encontrada.");
      const price = eyePrice[Math.min(s.canEagleEyeCounts, eyePrice.length) - 1] ?? eyePrice[eyePrice.length - 1]!;
      if (p.info.Money < price) return p.sendMessage(0, "Cupons insuficientes.");
      p.removeMoney(price);
      c.isSeeded = true;
      const out = new GSPacket(87);
      out.writeInt(11); out.writeInt(c.templateId); out.writeInt(c.strengthenLevel); out.writeInt(c.count); out.writeInt(c.validDate);
      out.writeInt(c.atk); out.writeInt(c.def); out.writeInt(c.agi); out.writeInt(c.luck); out.writeInt(c.position);
      out.writeBoolean(c.isSelected); out.writeBoolean(c.isSeeded); out.writeBoolean(c.isBind); out.writeInt(0);
      p.send(out);
      s.canEagleEyeCounts--;
      return;
    }
    case 14: { // FLUSHCHICKENVIEW
      const s = chickenState(ctx, p);
      const free = isFreeFlushTime(s, ctx.now());
      const price = num(ctx, "chickenbox", "flushPrice", 500);
      if (!free) { if (p.info.Money < price) return p.sendMessage(0, "Cupons insuficientes."); p.removeMoney(price); }
      flushChickenBox(ctx, p);
      p.send(chickenListPkt(ctx, chickenOf.get(p)!));
      return p.sendMessage(0, free ? "Atualização grátis." : "Atualizado com sucesso.");
    }
    case 12: // AllITEMSHOW
      return p.send(chickenListPkt(ctx, chickenState(ctx, p)));
    case 15: { // CLICKSTARTBNT
      const s = chickenState(ctx, p);
      s.isShowAll = false;
      for (let i = s.rewards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const a = s.rewards[i]!.position; s.rewards[i]!.position = s.rewards[j]!.position; s.rewards[j]!.position = a; }
      const out = new GSPacket(87);
      out.writeInt(5); out.writeBoolean(true);
      return p.send(out);
    }
    case 10: // ENTERCHICKENVIEW
      return p.send(chickenListPkt(ctx, chickenState(ctx, p)));
    case 31: { // ENTER_GAME (Lucky Star)
      const money = 2500;
      if (p.info.Money < money) return p.sendMessage(0, `São necessários ${money} Cupons para usar esta função!`);
      p.removeMoney(money);
      p.sendMessage(0, `${money} Cupons descontados ao abrir a função!`);
      const s = setupLucky(ctx, p);
      sendLuckyAllGoods(p, s);
      return;
    }
    case 32: // CLOSE_GAME
      return;
    case 33: { // START_TURN (7s cooldown, consumes LUCKYSTAR_ITEM)
      const s = luckyOf.get(p);
      if (!s) return p.sendMessage(0, "Você ainda não entrou na Estrela da Sorte.");
      if (ctx.now().getTime() - s.lastTurn < 7000) return p.sendMessage(0, "Aguarde.");
      const it = p.propBag.getItemByTemplateID(0, LUCKYSTAR_ITEM);
      if (!it || it.Count <= 0) return p.sendMessage(0, `${ctx.templates.findItem(LUCKYSTAR_ITEM)?.Name ?? "Estrela da Sorte"} insuficiente.`);
      p.propBag.removeTemplate(LUCKYSTAR_ITEM, 1);
      for (let i = s.rewards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s.rewards[i], s.rewards[j]] = [s.rewards[j]!, s.rewards[i]!]; }
      s.lastTurn = ctx.now().getTime();
      s.award = luckyDraw(s);
      s.coins += FLUSH_COINS;
      const out = new GSPacket(87);
      out.writeInt(34); out.writeInt(s.coins); out.writeInt(s.award.templateId); out.writeInt(s.award.strengthenLevel);
      out.writeInt(s.award.count); out.writeInt(s.award.validDate); out.writeInt(s.award.atk); out.writeInt(s.award.def);
      out.writeInt(s.award.agi); out.writeInt(s.award.luck); out.writeBoolean(s.award.isBind);
      p.send(out);
      if (s.award.templateId === COIN_TEMPLATE) { p.addMoney(s.coins); s.coins = DEFAULT_COINS; }
      return;
    }
    case 34: { // TURN_COMPLETE
      const s = luckyOf.get(p);
      if (!s?.award) return;
      if (s.award.templateId !== COIN_TEMPLATE) {
        const g = grantRewards(p, [{ templateId: s.award.templateId, count: s.award.count, isBind: s.award.isBind }], ctx.templates.findItem, ctx.now());
        if (g.overflow.length) void mailItems(ctx, p, g.overflow, "Lucky Star", 8);
      }
      return;
    }
  }
}

function sendLuckyAllGoods(p: GamePlayer, s: LuckyState): void {
  const out = new GSPacket(87);
  out.writeInt(30); out.writeInt(s.coins); out.writeInt(s.rewards.length);
  for (const c of s.rewards) { out.writeInt(c.templateId); out.writeInt(c.strengthenLevel); out.writeInt(c.count); out.writeInt(c.validDate); out.writeInt(c.atk); out.writeInt(c.def); out.writeInt(c.agi); out.writeInt(c.luck); out.writeBoolean(c.isBind); }
  p.send(out);
}

// ------------------------------------------------------------------ 131 LABYRINTH
// Administrative changes and battle awards share game/labyrinth.ts and one
// detached player/database transaction. Combat admission remains disabled.

// ------------------------------------------------------------------ 132 league (Chiến thần) stats — BattleGroundHandler
/** PlayerBattle's reference stats are hard-coded constants in the original too (not derived from the player). */
const BATTLE_REF = { Agility: 1600, Attack: 1700, Blood: 25000, Damage: 1000, Defend: 1500, Energy: 293, Guard: 500, Lucky: 1500 };
const FAIR_BATTLE_DAY_PRESTIGE = 2000;

async function leagueRank(ctx: ServerContext, userId: number): Promise<number> {
  const res = (await ctx.db.db.execute(sql`
    SELECT rnk FROM (SELECT "UserID", RANK() OVER (ORDER BY "weeklyScore" DESC) rnk FROM player."Sys_User_Match_Info") x WHERE "UserID" = ${userId}`)) as unknown;
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as { rnk: number }[];
  return rows[0]?.rnk ?? 0;
}

export async function battleGroundHandler(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  const b = pkt.readByte();
  const out = new GSPacket(132, p.id);
  if (b === 3) {
    const b2 = pkt.readByte();
    out.writeByte(3); out.writeBoolean(true); out.writeByte(b2);
    if (b2 === 2) out.writeInt(await leagueRank(ctx, p.id));
    else if (b2 === 1) { out.writeInt(p.match.addDayPrestge ?? 0); out.writeInt(p.match.totalPrestige ?? 0); out.writeInt(FAIR_BATTLE_DAY_PRESTIGE); }
    p.send(out);
  } else if (b === 5) {
    out.writeByte(5);
    out.writeInt(BATTLE_REF.Attack); out.writeInt(BATTLE_REF.Defend); out.writeInt(BATTLE_REF.Agility); out.writeInt(BATTLE_REF.Lucky);
    out.writeInt(BATTLE_REF.Damage); out.writeInt(BATTLE_REF.Guard); out.writeInt(BATTLE_REF.Blood); out.writeInt(BATTLE_REF.Energy);
    p.send(out);
  }
}

// ------------------------------------------------------------------ 258 NOVICEACTIVITY (simplified: grade-gated)
/** NoviceActivityGetAward.cs tracks a per-ActivityType condition counter via PlayerExtra (grade up / strengthen /
 *  recharge / VIP up / fight power...) which this port hasn't built; eligibility here is simplified to the player's
 *  current Grade against Event_Reward_Info.Condition (the "grade up" trigger, the one actually used by the 4.1
 *  client's novice/newbie panel) — same tables (Event_Reward_Info/Goods), admin-editable. Idempotent per
 *  (ActivityType, Condition) claim. */
export async function noviceActivity(ctx: ServerContext, p: GamePlayer, activityType: number, subActivityType: number): Promise<void> {
  const rt = eventsRuntime(ctx);
  const condition = subActivityType <= 1 ? 1 : subActivityType;
  const goods = rt.data.eventGoods.filter((g) => g.ActivityType === activityType && g.SubActivityType === condition);
  if (!goods.length) return p.sendMessage(0, "Sem recompensa.");
  if (condition > p.info.Grade) return p.sendMessage(0, "Condições insuficientes! A operação falhou.");
  if (!(await claimOnce(ctx.db.db, p.id, "novice", `${activityType}:${condition}`))) return p.sendMessage(0, "Você já recebeu esta recompensa.");
  const rewards: Reward[] = goods.map((g) => ({ templateId: g.TemplateId, count: g.Count ?? 1, validDate: g.ValidDate ?? 0, isBind: g.IsBind ?? true }));
  const g = grantRewards(p, rewards, ctx.templates.findItem, ctx.now());
  if (g.overflow.length) await mailItems(ctx, p, g.overflow, "Presente de Abertura do Servidor", 51);
  p.sendMessage(0, "Presente do evento recebido com sucesso!");
}

// ------------------------------------------------------------------ registration
export function registerActivities(r: HandlerRegistry): void {
  r.player(26, "LOTTERY_OPEN_BOX", (ctx, p, pkt) => lotteryOpenBox(ctx, p, pkt));
  r.player(27, "LOTTERY_RANDOM_SELECT", (ctx, p) => lotteryRandomSelect(ctx, p));
  r.player(28, "LOTTERY_FINISH", (ctx, p) => lotteryFinish(ctx, p));
  r.player(45, "CADDY_GET_BADLUCK", (ctx, p) => caddyBadLuck(ctx, p));
  r.player(204, "OPEN_ALL_CARDBOX", (_ctx, p) => openAllCardBox(p));
  r.player(232, "CADDY_SELL_ALL_GOODS", (_ctx, p) => caddySellAll(p));
  r.player(87, "NEWCHICKENBOX_SYS", (ctx, p, pkt) => chickenBoxHandler(ctx, p, pkt), "partial");
  r.player(131, "LABYRINTH", (ctx, p, pkt) => labyrinthHandler(ctx, p, pkt), "partial");
  r.player(132, "BATTLEGROUND", (ctx, p, pkt) => battleGroundHandler(ctx, p, pkt));
  r.player(258, "NOVICEACTIVITY", (ctx, p, pkt) => noviceActivity(ctx, p, pkt.readInt(), pkt.readInt()), "partial");
}

export { isOpen as activityOpen };
