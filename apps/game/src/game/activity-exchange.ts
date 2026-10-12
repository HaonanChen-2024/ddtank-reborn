/** Packet 31 follows original AS3 GameSocketOut.sendGoodsExchange: ActiveID, N,
 * then N (TemplateID, Place, BagType) int triples. No quantity or result packet 31
 * exists: S->C 31 belongs to ANSWERBOX_QUESTIN.
 *
 * Rules below are explicitly local-v1, not a reconstruction of missing official
 * exchange rules. Active_Convert_Item defines exact allowed templates per slot:
 * ItemType=zero-based slot, ItemCount=GoodsExchangeNum. Reserved fields MUST be
 * LimitValue=-1, IsBind=true, ValidDate=0. IsBind is a format marker, NOT a bound
 * material requirement: both bound and unbound materials are accepted. Rewards
 * are ordinary bound items. Unknown configuration fails closed.
 */
import { eq } from "drizzle-orm";
import { game, player, type Database } from "@ddt/db";
import type { GSPacket } from "@ddt/protocol";
import type { ServerContext } from "../session/context.js";
import type { GamePlayer } from "./player.js";
import type { PlayerInventory } from "./inventory.js";
import { ItemInfo, isSpecialTemplate, templateBagType, type ItemTemplate } from "./item.js";
import { claimOnce } from "./events.js";
import { saveItem } from "../db/items.js";
import { savePlayerInfo } from "../db/characters.js";
import { sendMail, type MailRow } from "../db/social.js";
import * as Out from "../packets/out.js";

const MAX_SLOTS = 8;
class ExchangeRejected extends Error {}
function requireRule(ok: unknown): asserts ok {
  if (!ok) throw new ExchangeRejected("兑换条件不符，未扣除材料。");
}
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
interface Selection { templateId: number; place: number; bagType: number }
interface Request { activeId: number; selections: Selection[] }

export function parseExchangeRequest(pkt: GSPacket): Request {
  // ByteBuffer overreads otherwise produce zeroes, so check the actual body first.
  requireRule(pkt.dataLeft >= 8);
  const activeId = pkt.readInt(), n = pkt.readInt();
  requireRule(positive(activeId) && n >= 1 && n <= MAX_SLOTS && pkt.dataLeft === n * 12);
  const selections: Selection[] = [], places = new Set<string>();
  for (let i = 0; i < n; i++) {
    const templateId = pkt.readInt(), place = pkt.readInt(), bagType = pkt.readInt();
    requireRule(positive(templateId) && (bagType === 0 || bagType === 1));
    requireRule(place >= (bagType === 0 ? 31 : 0) && place < (bagType === 0 ? 127 : 96));
    const key = `${bagType}:${place}`;
    requireRule(!places.has(key));
    places.add(key);
    selections.push({ templateId, place, bagType });
  }
  return { activeId, selections };
}

function numbers(raw: string | null): number[] {
  requireRule(raw && /^(0|[1-9]\d*)(,(0|[1-9]\d*))*$/.test(raw));
  const result = raw.split(",").map(Number);
  requireRule(result.length <= MAX_SLOTS && result.every(Number.isSafeInteger));
  return result;
}

function ordinary(t: ItemTemplate | undefined): asserts t is ItemTemplate {
  // Phase one intentionally permits ordinary material items, never currency,
  // equipment, pet/caddy special objects or a category-wide wildcard recipe.
  requireRule(t && t.CategoryID === 11 && !t.CanEquip && !isSpecialTemplate(t) && t.NeedSex === 0 && positive(t.MaxCount));
}

async function recipe(db: Database, ctx: ServerContext, activeId: number, now: Date) {
  const [active] = await db.select().from(game.Active).where(eq(game.Active.ActiveID, activeId));
  requireRule(active && active.ActiveType === 1 && active.HasKey === 6 && active.IsOnly === 1 && !active.IsShow && !active.IsAdvance && active.Type === 0 && !active.CanCreateCode);
  requireRule(active.EndDate && Number.isFinite(active.StartDate.getTime()) && Number.isFinite(active.EndDate.getTime()) && active.EndDate > active.StartDate && now >= active.StartDate && now <= active.EndDate);
  const categories = numbers(active.GoodsExchangeTypes), counts = numbers(active.GoodsExchangeNum);
  const limitTypes = numbers(active.limitType), limits = numbers(active.limitValue);
  requireRule(categories.length === counts.length && counts.length === limitTypes.length && counts.length === limits.length);
  requireRule(counts.every(positive) && limitTypes.every((x) => x === 0 || x === 1));
  const allowed = Array.from({ length: counts.length }, () => new Set<number>());
  const rows = await db.select().from(game.Active_Convert_Item).where(eq(game.Active_Convert_Item.ActiveID, activeId));
  for (const row of rows) {
    requireRule(Number.isSafeInteger(row.ItemType) && row.ItemType >= 0 && row.ItemType < counts.length);
    requireRule(row.ItemCount === counts[row.ItemType] && row.LimitValue === -1 && row.IsBind === true && row.ValidDate === 0);
    const t = ctx.templates.items.get(row.TemplateID);
    ordinary(t);
    requireRule(t.CategoryID === categories[row.ItemType] && row.ItemCount <= t.MaxCount && !allowed[row.ItemType]!.has(row.TemplateID));
    allowed[row.ItemType]!.add(row.TemplateID);
  }
  requireRule(allowed.every((s) => s.size > 0));
  const awards = await db.select().from(game.Active_Award).where(eq(game.Active_Award.ActiveID, activeId)).orderBy(game.Active_Award.ID);
  requireRule(awards.length >= 1 && awards.length <= 5);
  const rewards = awards.map((a) => {
    requireRule([a.StrengthenLevel, a.AttackCompose, a.DefendCompose, a.LuckCompose, a.AgilityCompose, a.Gold, a.Money, a.Sex, a.Mark].every((n) => n === 0));
    requireRule(positive(a.Count) && Number.isSafeInteger(a.ValidDate) && a.ValidDate >= 0);
    const t = ctx.templates.items.get(a.ItemID);
    ordinary(t);
    requireRule(a.Count <= t.MaxCount);
    const item = ItemInfo.createFromTemplate(t, a.Count, 0, now);
    item.IsBinds = true;
    item.ValidDate = a.ValidDate;
    return item;
  });
  return { active, allowed, counts, limitTypes, limits, rewards };
}

interface PendingItem { item: ItemInfo; before: string; dirty: boolean; after: ItemInfo }
interface Material extends PendingItem { bag: PlayerInventory }
const snapshot = (it: ItemInfo) => JSON.stringify(it.toRow());
const pendingItems = (p: GamePlayer) => [...new Set(p.allBags().filter((b) => b.saveToDb).flatMap((b) => b.dirtyItems()))];
// Quit may set State=0 while waiting for this transaction; its queued save writes
// that afterwards. Other profile changes outside the packet queue invalidate us.
const profileSnapshot = (p: GamePlayer) => JSON.stringify({ info: { ...p.info, State: 0 }, match: p.match });

/** Called by the authenticated packet queue. The same player's save/quit cannot
 * write an older snapshot over the deduction; all transaction objects are clones.
 * Returns false for a rejected/replayed request. Unexpected DB failures propagate
 * without touching inventory objects, dirty/removed collections or sending 64/117. */
export async function exchangeActivity(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<boolean> {
  try {
    const request = parseExchangeRequest(pkt);
    return await p.withPersistenceLock(async () => {
      requireRule(p.isActive && !p.quitting && !p.currentRoom && !(p.info.HasBagPassword && p.info.IsLocked));
      const committed = await ctx.db.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        const [owner] = await tx.select({ id: player.Sys_Users_Detail.UserID }).from(player.Sys_Users_Detail)
          .where(eq(player.Sys_Users_Detail.UserID, p.id)).for("update");
        requireRule(owner);
        const now = ctx.now(), config = await recipe(db, ctx, request.activeId, now);
        requireRule(request.selections.length === config.counts.length);
        // A selected dirty stack can come from a merge/split or a purchase. Save
        // its pending source removals AND prior payment in the same transaction,
        // otherwise a crash could retain the source stack/old currency balance.
        // Never call p.saveIntoDatabase(tx): that clears real dirty state early.
        const info = structuredClone(p.info), match = structuredClone(p.match), profileBefore = profileSnapshot(p);
        const pendingBefore = pendingItems(p);
        const pending = new Map<ItemInfo, PendingItem>();
        const capture = (item: ItemInfo): PendingItem => {
          let change = pending.get(item);
          if (!change) {
            requireRule(item.UserID === p.id && Number.isSafeInteger(item.ItemID) && item.ItemID >= 0);
            change = { item, before: snapshot(item), dirty: item.isDirty, after: ItemInfo.fromRow({ ...item.toRow(), ItemID: item.ItemID }, item.template) };
            pending.set(item, change);
          }
          return change;
        };
        pendingBefore.forEach(capture);
        const selected: Material[] = [], ids = new Set<number>();
        for (const [i, s] of request.selections.entries()) {
          const bag = p.getInventory(s.bagType), item = bag?.getItemAt(s.place);
          requireRule(bag && item && item.IsExist && item.UserID === p.id && item.TemplateID === s.templateId && item.BagType === s.bagType && item.Place === s.place);
          requireRule(templateBagType(item.template) === s.bagType && config.allowed[i]!.has(item.TemplateID) && !item.cellLocked && item.isValidItem(now));
          requireRule(Number.isSafeInteger(item.Count) && item.Count >= config.counts[i]! && item.Count <= item.template.MaxCount);
          requireRule((config.limitTypes[i] === 0 ? item.StrengthenLevel : item.template.Property1) >= config.limits[i]!);
          requireRule(Number.isSafeInteger(item.ItemID) && item.ItemID >= 0 && !selected.some((m) => m.item === item) && (item.ItemID === 0 || !ids.has(item.ItemID)));
          ids.add(item.ItemID);
          const change = capture(item), after = change.after;
          after.Count -= config.counts[i]!;
          if (after.Count === 0) {
            after.IsExist = false; after.BagType = -1; after.Place = -1;
            after.RemoveDate = now; after.RemoveType = 0;
          }
          selected.push({ ...change, bag });
        }
        const persistedIds = new Set<number>();
        for (const change of pending.values()) {
          const { item } = change;
          if (item.ItemID > 0) {
            requireRule(!persistedIds.has(item.ItemID));
            persistedIds.add(item.ItemID);
            const [stored] = await tx.select().from(player.Sys_Users_Goods).where(eq(player.Sys_Users_Goods.ItemID, item.ItemID)).for("update");
            requireRule(stored && stored.UserID === p.id && stored.TemplateID === item.TemplateID && (!item.IsExist || stored.IsExist));
            // Dirty online state may legitimately contain an unsaved count/move.
            // Clean state must still match DB; never resurrect a stale/foreign row.
            requireRule(change.dirty || pendingBefore.includes(item) || snapshot(ItemInfo.fromRow(stored, item.template)) === change.before);
          }
        }
        requireRule(await claimOnce(db, p.id, "exchange", String(request.activeId)));
        await savePlayerInfo(db, info, match);
        for (const m of pending.values()) await saveItem(db, m.after);
        const mail: MailRow = {
          ReceiverID: p.id, Receiver: p.info.NickName, SenderID: 0, Sender: "活动奖励",
          Title: config.active.Title, Content: "本地材料兑换奖励，请查收附件。", Type: 1,
          Gold: 0, Money: 0, GiftToken: 0, SendTime: now, SendDate: now,
        };
        for (const [i, item] of config.rewards.entries()) {
          await saveItem(db, item); // Detached item, UserID=0: normal mail attachment.
          Object.assign(mail, { [`Annex${i + 1}`]: String(item.ItemID), [`Annex${i + 1}Name`]: item.template.Name });
        }
        await sendMail(db, mail);
        // Defensive guard for mutation outside the normal serial packet path.
        requireRule(selected.every((m) => m.bag.getItemAt(m.item.Place) === m.item));
        requireRule([...pending.values()].every((m) => snapshot(m.item) === m.before && m.item.isDirty === m.dirty));
        const pendingNow = pendingItems(p);
        requireRule(pendingNow.length === pendingBefore.length && pendingNow.every((item) => pendingBefore.includes(item)) && profileSnapshot(p) === profileBefore);
        return { selected, pending: [...pending.values()] };
      });
      // Commit succeeded. Batch the original 64 slot notifications until all state
      // is applied, then 117 asks the original client to reload the mailbox.
      const bags = [...new Set(committed.selected.map((m) => m.bag))];
      bags.forEach((bag) => bag.beginChanges());
      try {
        for (const m of committed.selected) {
          if (!m.after.IsExist) m.bag.removeItem(m.item);
        }
        for (const m of committed.pending) {
          Object.assign(m.item, m.after.toRow());
        }
        for (const m of committed.selected) {
          if (m.after.IsExist) m.bag.updateItem(m.item);
        }
        for (const m of committed.pending) {
          m.item.isDirty = false;
          for (const bag of p.allBags()) {
            for (let i = bag.removed.length - 1; i >= 0; i--) if (bag.removed[i] === m.item) bag.removed.splice(i, 1);
          }
        }
      } finally { bags.forEach((bag) => bag.commitChanges()); }
      p.send(Out.mailResponse(p.id, 1));
      p.sendMessage(0, "兑换成功，奖励已发送至邮箱。");
      return true;
    });
  } catch (error) {
    if (!(error instanceof ExchangeRejected)) throw error;
    p.sendMessage(0, error.message);
    return false;
  }
}
