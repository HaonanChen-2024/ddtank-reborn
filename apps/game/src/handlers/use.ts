/**
 * Using items from the bag: 63 ITEM_OPENUP (boxes), 183 CARD_USE (buff / GP / VIP cards), 124 CHANGE_PLACE_GOODS_ALL
 * (sort), 60 ITEM_HIDE, 42 DELETE_GOODS (no-op like the original). 01 §3/§4.
 * Idempotency: every handler consumes the item it reads before granting anything, and a repeated packet finds the
 * slot empty (or the stack smaller), so it cannot duplicate.
 */
import { consortiaMgr } from "../game/consortia-mgr.js";
import { GSPacket } from "@ddt/protocol";
import { ItemInfo, templateBagType } from "../game/item.js";
import type { GamePlayer } from "../game/player.js";
import type { ItemBoxRow, Templates } from "../db/templates.js";
import type { BuffRow } from "../db/social.js";
import type { ServerContext } from "../session/context.js";
import * as Out from "../packets/out.js";
import type { HandlerRegistry } from "./registry.js";
import { addExpVip, applyVipDays, vipExpTable, vipNextLevelDays, vipPrice } from "../game/vip.js";

export interface BoxResult {
  gold: number; money: number; giftToken: number; medal: number; exp: number; honor: number; hardCurrency: number;
  items: { row: ItemBoxRow; count: number }[];
}

/**
 * ItemBoxMgr.CreateItemBox (Bussiness/Managers/ItemBoxMgr.cs:186): every IsSelect row, plus ONE random row among the
 * non-selected rows whose Random >= rand(max Random). Special template ids are currencies.
 */
export function createItemBox(rows: ItemBoxRow[] | undefined, rnd = Math.random): BoxResult | null {
  if (!rows?.length) return null;
  const r: BoxResult = { gold: 0, money: 0, giftToken: 0, medal: 0, exp: 0, honor: 0, hardCurrency: 0, items: [] };
  const picked = rows.filter((s) => s.IsSelect);
  const others = rows.filter((s) => !s.IsSelect);
  if (others.length) {
    const max = Math.max(...others.map((s) => s.Random));
    const round = Math.floor(rnd() * max);
    const pool = others.filter((s) => s.Random >= round);
    if (pool.length) picked.push(pool[Math.floor(rnd() * pool.length)]!);
  }
  for (const b of picked) {
    switch (b.TemplateId) {
      case -1100: r.giftToken += b.ItemCount; continue;
      case -900: r.hardCurrency += b.ItemCount; continue;
      case -800: r.honor += b.ItemCount; continue;
      case -300: r.medal += b.ItemCount; continue;
      case -200: r.money += b.ItemCount; continue;
      case -100: r.gold += b.ItemCount; continue;
      case 11107: r.exp += b.ItemCount; continue;
    }
    if (b.TemplateId < 0) continue; // -1000 league money, -1200 score, -1300 prestige: no column here
    r.items.push({ row: b, count: b.ItemCount });
  }
  return r;
}

/** OpenUpArkHandler.cs (63): byte bag, int slot, int count. */
export function openBox(ctx: ServerContext, p: GamePlayer, pkt: GSPacket, rnd = Math.random): void {
  const bag = p.getInventory(pkt.readByte());
  const slot = pkt.readInt();
  let num = pkt.readInt();
  const it = bag?.getItemAt(slot);
  if (!bag || !it || !it.isValidItem(ctx.now()) || it.template.CategoryID !== 11 || it.template.Property1 !== 6 || p.info.Grade < it.template.NeedLevel) return;
  if (num < 1 || num > it.Count) num = it.Count;
  const tpl: Templates = ctx.templates;
  const rows = tpl.itemBoxes.get(it.TemplateID);
  if (!rows?.length) return p.sendMessage(0, ctx.lang.t("OpenUpArkHandler.NoBox") === "OpenUpArkHandler.NoBox" ? "Esta caixa não tem itens." : ctx.lang.t("OpenUpArkHandler.NoBox"));
  const name = it.template.Name ?? "";
  if (!bag.removeCountFromStack(it, num)) return; // consume first (anti-dupe)
  const tot = { gold: 0, money: 0, giftToken: 0, medal: 0, exp: 0, honor: 0, hardCurrency: 0 };
  const merged = new Map<number, { row: ItemBoxRow; count: number }>();
  for (let i = 0; i < num; i++) {
    const r = createItemBox(rows, rnd);
    if (!r) continue;
    for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += r[k];
    for (const x of r.items) {
      const m = merged.get(x.row.TemplateId);
      if (m) m.count += x.count;
      else merged.set(x.row.TemplateId, { row: x.row, count: x.count });
    }
  }
  p.beginChanges();
  let total = 0;
  let what = "";
  if (tot.money) { total += tot.money; what = ctx.lang.t("OpenUpArkHandler.Money"); p.addMoney(tot.money); }
  if (tot.gold) { total += tot.gold; what = ctx.lang.t("OpenUpArkHandler.Gold"); p.addGold(tot.gold); }
  if (tot.giftToken) { total += tot.giftToken; what = ctx.lang.t("OpenUpArkHandler.GiftToken"); p.addGiftToken(tot.giftToken); }
  if (tot.medal) { total += tot.medal; what = ctx.lang.t("OpenUpArkHandler.Medal"); p.addMedal(tot.medal, tpl.findItem); }
  if (tot.honor) { total += tot.honor; what = ctx.lang.t("OpenUpArkHandler.honor"); p.addHonor(tot.honor); }
  if (tot.hardCurrency) { total += tot.hardCurrency; what = ctx.lang.t("OpenUpArkHandler.hardCurrency"); p.addHardCurrency(tot.hardCurrency); }
  if (tot.exp) { total += tot.exp; what = ctx.lang.t("OpenUpArkHandler.Exp"); p.addGP(tot.exp, false); }
  p.commitChanges();
  if (total > 0) p.sendMessage(0, `${ctx.lang.t("OpenUpArkHandler.Start")}${total}${what}.`);
  if (merged.size) {
    const out = new GSPacket(63, p.id);
    out.writeString(name);
    out.writeByte(merged.size);
    for (const { row, count } of merged.values()) {
      out.writeInt(row.TemplateId); out.writeInt(count); out.writeBoolean(row.IsBind); out.writeInt(row.ItemValid);
      out.writeInt(row.StrengthenLevel); out.writeInt(row.AttackCompose); out.writeInt(row.DefendCompose);
      out.writeInt(row.AgilityCompose); out.writeInt(row.LuckCompose);
      const t = tpl.findItem(row.TemplateId);
      if (!t) continue;
      const make = (n: number) => {
        const x = ItemInfo.createFromTemplate(t, n, 101, ctx.now());
        x.IsBinds = row.IsBind; x.ValidDate = row.ItemValid; x.StrengthenLevel = row.StrengthenLevel;
        x.AttackCompose = row.AttackCompose; x.DefendCompose = row.DefendCompose; x.AgilityCompose = row.AgilityCompose; x.LuckCompose = row.LuckCompose;
        return x;
      };
      if (t.MaxCount < 2) for (let i = 0; i < count; i++) p.addTemplateToBag(make(1), templateBagType(t), 1);
      else p.addTemplateToBag(make(count), templateBagType(t), count);
    }
    p.send(out);
  }
  p.questInv?.onUsingItem(it.TemplateID); void consortiaMgr(ctx).then((c) => c.onUseItem(p, it.TemplateID, 1));
}

/** BufferList.CreateBuffer(template, validDate) + the per-type Start (GPMultipleBuffer etc.: same type extends time). */
export function addItemBuff(p: GamePlayer, t: { Property1: number; Property2: number; Property3: number; TemplateID: number }, validDays: number, now: Date): BuffRow {
  const minutes = validDays * 24 * 60;
  const ex = p.buffs.find((b) => b.Type === t.Property1 && b.IsExist && b.BeginDate.getTime() + b.ValidDate * 60_000 > now.getTime());
  if (ex) {
    ex.ValidDate += minutes;
    return ex;
  }
  p.buffs = p.buffs.filter((b) => b.Type !== t.Property1);
  const b: BuffRow = { UserID: p.id, Type: t.Property1, Value: t.Property2, BeginDate: now, ValidDate: minutes, TemplateID: t.TemplateID, ValidCount: t.Property3, Data: null, IsExist: true };
  p.buffs.push(b);
  return b;
}

/** CardUseHandler.cs (183): int bag, int place (-1 = quick buy), int n, n×int shopIds, int, bool ignoreBagLock. */
export function cardUse(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): void {
  const bagType = pkt.readInt();
  const place = pkt.readInt();
  const n = pkt.readInt();
  const ids: number[] = [];
  for (let i = 0; i < Math.min(n, 50); i++) ids.push(pkt.readInt());
  pkt.readInt();
  const ignoreLock = pkt.readBoolean();
  if (p.info.HasBagPassword && p.info.IsLocked && !ignoreLock) return p.sendMessage(0, ctx.lang.t("Bag.Locked"));
  const tpl = ctx.templates;
  const loops = place === -1 ? ids : [0];
  for (const shopId of loops) {
    let item: ItemInfo | null = null;
    const bag = place === -1 ? null : p.getInventory(bagType);
    if (place === -1) {
      const s = tpl.shop.get(shopId);
      const t = s ? tpl.findItem(s.TemplateID) : undefined;
      if (!s || !t || !tpl.isOnShop(shopId)) { p.sendMessage(0, "无法购买该道具。"); continue; }
      if (!(s.APrice1 === -1 && s.AValue1 > 0) || s.AValue1 > p.info.Money + p.info.MoneyLock) continue;
      p.removeMoney(s.AValue1);
      item = ItemInfo.createFromTemplate(t, 1, 102, ctx.now());
      item.ValidDate = s.AUnit;
    } else item = bag?.getItemAt(place) ?? null;
    if (!item) continue;
    const t = item.template;
    if (t.Property1 === 21) {
      // GP pill: Property2 × count, whole stack consumed.
      if (!item.isValidItem(ctx.now())) continue;
      const gp = t.Property2 * item.Count;
      if (bag && t.CanDelete && !bag.removeCountFromStack(item, item.Count)) continue;
      p.addGP(gp, false);
      p.sendMessage(0, ctx.lang.t("GPDanUser.Success", gp));
      p.questInv?.onUsingItem(item.TemplateID); void consortiaMgr(ctx).then((c) => c.onUseItem(p, item.TemplateID, 1));
      continue;
    }
    if (t.Property1 === 23) {
      // CardUseHandler case 23: VIPRenewal(ValidDate days) + OpenVIP / ContinuousVIP, 92 SendOpenVIP, consume when CanDelete
      const days = item.ValidDate || 1;
      const { opened } = applyVipDays(p.info, days, ctx.now());
      if (bag && t.CanDelete) bag.removeCountFromStack(item, 1);
      p.send(Out.openVip(p.info));
      p.updateProperties();
      p.sendMessage(0, opened ? `恭喜你获得${days}天贵宾特权！` : `你的贵宾特权已延长${days}天！`);
      continue;
    }
    if (bag && !bag.removeCountFromStack(item, 1)) continue;
    addItemBuff(p, t, item.ValidDate, ctx.now());
    p.send(Out.bufferList(p.id, p.buffs));
    p.sendMessage(0, ctx.lang.t("CardUseHandler.Success"));
    p.questInv?.onUsingItem(item.TemplateID); void consortiaMgr(ctx).then((c) => c.onUseItem(p, item.TemplateID, 1));
  }
}

/**
 * TexpHandler.cs (99): int selectIndex (0 hp, 1 att, 2 def, 3 spd, 4 luk), int templateId, int place. The potion
 * (category 20) sits in StoreBag[0] (TexpView's cell); Property2 = exp. Daily cap = grade × 2 (VIP ≤ 2) or × 3.
 */
export function texp(ctx: ServerContext, p: GamePlayer, selectIndex: number, templateId: number, place: number): void {
  const it = p.storeBag.getItemAt(place);
  const info = p.info.Texp;
  if (!it || !info || it.TemplateID !== templateId || it.template.CategoryID !== 20) return;
  const limit = p.info.Grade * (p.info.VIPLevel <= 2 ? 2 : 3);
  const now = ctx.now();
  const day = (d: Date) => Math.floor(d.getTime() / 86_400_000);
  if (day(info.texpTaskDate) + 1 <= day(now) && info.texpCount >= limit) {
    info.texpCount = 0;
    info.texpTaskDate = now;
  }
  if (info.texpCount >= limit) return p.sendMessage(0, ctx.lang.t("texpSystem.texpCountToplimit"));
  const key = (["hpTexpExp", "attTexpExp", "defTexpExp", "spdTexpExp", "lukTexpExp"] as const)[selectIndex];
  if (!key) return; // -1 (BagView quest refresh) changes nothing in the original either, besides eating the potion
  if (!p.storeBag.removeTemplate(templateId, 1)) return;
  info[key] += it.template.Property2;
  info.texpCount++;
  info.texpTaskCount++;
  p.questInv?.onUsingItem(templateId);
  p.questInv?.onUsingItem(45001 + ((selectIndex + 4) % 5)); // OnUsingItem(45005 hp / 45001 att / 45002 def / 45003 spd / 45004 luk)
  p.updatePlayerProperties();
}

/** OpenVipHandler.cs (92): str nick, int days. Price from the VIP card (11992) shop entry, charged first (MoneyDirect). */
export function openVip(ctx: ServerContext, p: GamePlayer, nick: string, days: number): void {
  const card = [...ctx.templates.shop.values()].find((s) => s.TemplateID === 11992);
  const money = vipPrice(card, days);
  if (days <= 0 || money < 0) return;
  const target = nick === p.info.NickName ? p : ctx.world.all().find((o) => o.info.NickName === nick);
  if (!target) return p.sendMessage(0, `玩家${nick}不存在或不在线！`);
  if (target === p && p.info.VIPLevel === 9) return p.sendMessage(0, "你的贵宾等级已达上限！"); // checked before charging (original charged first)
  if (p.info.Money + p.info.MoneyLock < money) return p.sendMessage(0, ctx.lang.t("UserBuyItemHandler.Money"));
  p.removeMoney(money);
  const table = vipExpTable(ctx.templates.serverConfig.get("VIPExpForEachLv"));
  const { opened } = applyVipDays(target.info, days, ctx.now());
  addExpVip(target.info, money, table);
  if (target.info.typeVIP > 0) target.info.VIPNextLevelDaysNeeded = vipNextLevelDays(target.info, table, card);
  target.send(Out.openVip(target.info));
  target.updateProperties();
  if (target !== p) target.sendMessage(0, `${p.info.NickName}已成功为你${opened ? "开通" : "延长"}贵宾特权！`);
  p.sendMessage(0, target === p ? (opened ? "贵宾开通成功！" : "贵宾续费成功！") : `已成功为${nick}${opened ? "开通" : "续费"}贵宾特权！`);
}

/** ArrangeBagHandler.cs (124): compact the bag (and stack when `merge`). Only if `count` matches the item count. */
export function arrangeBag(p: GamePlayer, merge: boolean, count: number, bagType: number): void {
  const inv = p.getInventory(bagType);
  if (!inv) return;
  const items = () => inv.getItems(inv.beginSlot, inv.capacity - 1);
  if (count !== items().length) return;
  const compact = () => {
    const list = items();
    for (let i = 1; i <= list.length; i++) {
      const last = list[list.length - i]!;
      const empty = inv.findFirstEmptySlot(inv.beginSlot);
      if (empty === -1 || empty >= last.Place) break;
      inv.moveItem(last.Place, empty, last.Count);
    }
  };
  inv.beginChanges();
  try {
    compact();
    if (merge) {
      const list = items();
      const used = new Set<number>();
      for (let j = 0; j < list.length; j++) {
        if (used.has(j)) continue;
        for (let k = list.length - 1; k > j; k--) {
          const a = list[j]!, b = list[k]!;
          if (!used.has(k) && a.TemplateID === b.TemplateID && a.canStackedTo(b) && a.Count + b.Count <= a.template.MaxCount) {
            inv.moveItem(b.Place, a.Place, b.Count);
            used.add(k);
          }
        }
      }
      compact();
    }
  } finally {
    inv.commitChanges();
  }
}

export function registerUse(r: HandlerRegistry): void {
  r.player(63, "ITEM_OPENUP", (ctx, p, pkt) => openBox(ctx, p, pkt));
  r.player(183, "CARD_USE", (ctx, p, pkt) => cardUse(ctx, p, pkt));
  r.player(92, "VIP_RENEWAL", (ctx, p, pkt) => openVip(ctx, p, pkt.readString(), pkt.readInt()));
  r.player(99, "TEXP", (ctx, p, pkt) => texp(ctx, p, pkt.readInt(), pkt.readInt(), pkt.readInt()));
  r.player(124, "CHANGE_PLACE_GOODS_ALL", (_ctx, p, pkt) => {
    const merge = pkt.readBoolean();
    const count = pkt.readInt();
    const bagType = pkt.readInt();
    arrangeBag(p, merge, count, bagType);
  });
  /** UserHideItemHandler.cs (60) + GamePlayer.EquipShowImp: digit `slot` of Hide = 1 shown / 2 hidden. */
  r.player(60, "ITEM_HIDE", (_ctx, p, pkt) => {
    const hide = pkt.readBoolean();
    let n = pkt.readInt();
    if (n === 13) n = 3;
    else if (n === 15) n = 4;
    if (n < 0 || n >= 10) return;
    const pow = 10 ** n;
    const cur = Math.trunc(p.info.Hide / pow) % 10;
    p.info.Hide += pow * ((hide ? 2 : 1) - cur);
    p.updateProperties();
  });
  /** UserDeleteItemHandler.cs (42): delete disabled in the original. */
  r.player(42, "DELETE_GOODS", () => undefined, "stub");
}
