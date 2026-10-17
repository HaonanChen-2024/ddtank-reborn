/**
 * Using items from the bag: 63 ITEM_OPENUP (boxes), 183 CARD_USE (buff / GP / VIP cards), 124 CHANGE_PLACE_GOODS_ALL
 * (sort), 60 ITEM_HIDE, 42 DELETE_GOODS (no-op like the original). 01 §3/§4.
 * Packet 63 commits consumption and rewards atomically. It has no request UUID: a new packet against a remaining
 * stack is a new opening, not an idempotent replay. Other handlers retain their separate consumption contracts.
 */
import { consortiaMgr } from "../game/consortia-mgr.js";
import { GSPacket } from "@ddt/protocol";
import { ItemInfo, templateBagType } from "../game/item.js";
import { commitPlayerMutation, PlayerMutationCommittedError } from "../game/player-transaction.js";
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

/** OpenUpArkHandler.cs (63): byte bag, int slot, int count; CanUse is deliberately not required. */
export async function openBox(ctx: ServerContext, p: GamePlayer, pkt: GSPacket, rnd = Math.random): Promise<void> {
  const reject = (message = "开箱保存失败，箱子和奖励未改变，请稍后重试。") => p.sendMessage(0, message);
  if (pkt.length - pkt.offset !== 9) return reject("开箱请求无效。");
  const bagType = pkt.readByte(), slot = pkt.readInt(), requested = pkt.readInt();
  return p.withPersistenceLock(async () => {
    const permitted = () => p.isActive && !p.quitting && !p.currentRoom?.IsPlaying && !(p.info.HasBagPassword && p.info.IsLocked);
    if (!permitted()) return reject("当前不能打开箱子，请先返回大厅并解锁背包。");
    let message: string | undefined;
    type Opened = { templateId: number; name: string; total: number; what: string; items: { row: ItemBoxRow; count: number }[] };
    let result: Opened | null = null, notificationError: unknown;
    try {
      result = await commitPlayerMutation(ctx, p, async (_db, staged, now) => {
        if (!permitted()) return null;
        const bag = staged.getInventory(bagType), it = bag?.getItemAt(slot), tpl = ctx.templates;
        const integer = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647;
        if (!Number.isFinite(now.getTime()) || !bag?.saveToDb || !it || it.cellLocked || !it.IsExist || it.UserID !== p.id || it.Place !== slot || it.BagType !== bagType ||
            !it.isValidItem(now) || !integer(it.Count) || it.Count < 1 || tpl.findItem(it.TemplateID) !== it.template ||
            it.template.CategoryID !== 11 || it.template.Property1 !== 6 || staged.info.Grade < it.template.NeedLevel) return null;
        const rows = tpl.itemBoxes.get(it.TemplateID);
        if (!rows?.length) { message = "箱子奖励配置缺失，箱子已保留。"; return null; }
        // Validate every possible award before rolling. Unsupported currencies or
        // missing item templates must never turn a consumed box into a lost reward.
        const currency = new Set([-1100, -900, -800, -300, -200, -100, 11107]);
        if (rows.some(row => row.ID !== it.TemplateID || !integer(row.ItemCount) || !integer(row.Random) ||
          ![row.ItemValid, row.StrengthenLevel, row.AttackCompose, row.DefendCompose, row.AgilityCompose, row.LuckCompose].every(integer) ||
          (!currency.has(row.TemplateId) && (row.TemplateId < 0 || !tpl.findItem(row.TemplateId) || !integer(tpl.findItem(row.TemplateId)!.MaxCount) || tpl.findItem(row.TemplateId)!.MaxCount < 1)))) {
          message = "箱子奖励尚未配置完整，箱子已保留。"; return null;
        }
        const num = requested < 1 || requested > it.Count ? it.Count : requested;
        const tot = { gold: 0, money: 0, giftToken: 0, medal: 0, exp: 0, honor: 0, hardCurrency: 0 };
        const merged = new Map<number, { row: ItemBoxRow; count: number }>();
        for (let i = 0; i < num; i++) {
          const r = createItemBox(rows, () => {
            const sample = rnd();
            if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error("Invalid box random result");
            return sample;
          })!;
          for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += r[k];
          for (const x of r.items) {
            const m = merged.get(x.row.TemplateId);
            if (m) m.count += x.count;
            else merged.set(x.row.TemplateId, { row: x.row, count: x.count });
          }
        }
        if (merged.size > 255 || !Object.values(tot).every(integer) || [...merged.values()].some(x => !integer(x.count))) return null;
        for (const [amount, current] of [[tot.money, staged.info.Money], [tot.gold, staged.info.Gold], [tot.giftToken, staged.info.GiftToken],
          [tot.honor, staged.info.myHonor], [tot.hardCurrency, staged.info.hardCurrency], [tot.exp, staged.info.GP]]) {
          if (amount && (!integer(current!) || !integer(current! + amount!))) { message = "奖励数量超过可保存上限，箱子已保留。"; return null; }
        }
        if (tot.medal && (!tpl.findItem(11408) || !integer(tpl.findItem(11408)!.MaxCount) || tpl.findItem(11408)!.MaxCount < 1)) { message = "勋章奖励配置缺失，箱子已保留。"; return null; }
        if (!bag.removeCountFromStack(it, num)) return null;
        const overflow: ItemInfo[] = [];
        const grant = (t: NonNullable<ReturnType<Templates["findItem"]>>, count: number, row?: ItemBoxRow) => {
          for (let remaining = count; remaining > 0;) {
            const n = Math.min(remaining, t.MaxCount), x = ItemInfo.createFromTemplate(t, n, 101, now);
            if (row) {
              x.IsBinds = row.IsBind; x.ValidDate = row.ItemValid; x.StrengthenLevel = row.StrengthenLevel;
              x.AttackCompose = row.AttackCompose; x.DefendCompose = row.DefendCompose; x.AgilityCompose = row.AgilityCompose; x.LuckCompose = row.LuckCompose;
            }
            if (!staged.addTemplateToBag(x, templateBagType(t), n)) overflow.push(x);
            remaining -= n;
          }
        };
        let total = 0, what = "";
        if (tot.money) { total += tot.money; what = ctx.lang.t("OpenUpArkHandler.Money"); staged.addMoney(tot.money); }
        if (tot.gold) { total += tot.gold; what = ctx.lang.t("OpenUpArkHandler.Gold"); staged.addGold(tot.gold); }
        if (tot.giftToken) { total += tot.giftToken; what = ctx.lang.t("OpenUpArkHandler.GiftToken"); staged.addGiftToken(tot.giftToken); }
        if (tot.medal) { total += tot.medal; what = ctx.lang.t("OpenUpArkHandler.Medal"); grant(tpl.findItem(11408)!, tot.medal); }
        if (tot.honor) { total += tot.honor; what = ctx.lang.t("OpenUpArkHandler.honor"); staged.addHonor(tot.honor); }
        if (tot.hardCurrency) { total += tot.hardCurrency; what = ctx.lang.t("OpenUpArkHandler.hardCurrency"); staged.addHardCurrency(tot.hardCurrency); }
        if (tot.exp) { total += tot.exp; what = ctx.lang.t("OpenUpArkHandler.Exp"); staged.addGP(tot.exp, false); }
        for (const x of merged.values()) grant(tpl.findItem(x.row.TemplateId)!, x.count, x.row);
        return { value: { templateId: it.TemplateID, name: it.template.Name ?? "", total, what, items: [...merged.values()] }, overflow, mailTitle: "开箱奖励" };
      });
    } catch (error) {
      if (error instanceof PlayerMutationCommittedError) { result = error.value as Opened; notificationError = error; }
      else { ctx.log.error("Open box transaction failed", error); return reject(); }
    }
    if (!result) { if (message) reject(message); return; }
    const committed = result;
    const notify = (work: () => void) => { try { work(); } catch (error) { notificationError ??= error; } };
    if (committed.total > 0) notify(() => p.sendMessage(0, `${ctx.lang.t("OpenUpArkHandler.Start")}${committed.total}${committed.what}.`));
    if (committed.items.length) notify(() => {
      const out = new GSPacket(63, p.id); out.writeString(committed.name); out.writeByte(committed.items.length);
      for (const { row, count } of committed.items) {
        out.writeInt(row.TemplateId); out.writeInt(count); out.writeBoolean(row.IsBind); out.writeInt(row.ItemValid);
        out.writeInt(row.StrengthenLevel); out.writeInt(row.AttackCompose); out.writeInt(row.DefendCompose); out.writeInt(row.AgilityCompose); out.writeInt(row.LuckCompose);
      }
      p.send(out);
    });
    // Existing TS quest/guild hooks are post-commit; they are not part of the
    // ordinary profile/items SQL transaction and must not run on rollback.
    notify(() => p.questInv?.onUsingItem(committed.templateId));
    if (p.info.ConsortiaID > 0) void consortiaMgr(ctx).then(c => c.onUseItem(p, committed.templateId, 1)).catch(error => ctx.log.error("Open box guild notification failed", error));
    if (notificationError) throw notificationError;
  });
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

function purchaseFailure(ctx: ServerContext, p: GamePlayer, code: number, reason: string, message: string): void {
  ctx.log.warn("purchase rejected", { code, playerId: p.id, reason });
  p.sendMessage(0, message);
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
      if (!s || !t || !tpl.isOnShop(shopId)) { purchaseFailure(ctx, p, 183, "unavailable_item", "无法购买该道具。"); continue; }
      if (s.APrice1 !== -1 || !Number.isSafeInteger(s.AValue1) || s.AValue1 <= 0 || s.AValue1 > 2_147_483_647) {
        purchaseFailure(ctx, p, 183, "unsupported_price", "该道具暂不支持快捷购买，请前往商城查看。"); continue;
      }
      if (s.AValue1 > p.info.Money + p.info.MoneyLock) {
        purchaseFailure(ctx, p, 183, "insufficient_money", `购买需要${s.AValue1}点券，当前点券不足。`); continue;
      }
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
export async function texp(ctx: ServerContext, p: GamePlayer, selectIndex: number, templateId: number, place: number): Promise<void> {
  const keys = ["hpTexpExp", "attTexpExp", "defTexpExp", "spdTexpExp", "lukTexpExp"] as const;
  if (!Number.isSafeInteger(selectIndex) || selectIndex < 0 || selectIndex >= keys.length || !Number.isSafeInteger(place) || place < 0) return;
  const key = keys[selectIndex]!;
  return p.withPersistenceLock(async () => {
    const permitted = () => p.isActive && !p.quitting && !p.currentRoom?.IsPlaying && !(p.info.HasBagPassword && p.info.IsLocked) && p.extra?.coupleBossBoxNum !== 9;
    if (!permitted()) return;
    let limited = false, result: { trained: boolean } | null = null, notificationError: unknown;
    try {
      result = await commitPlayerMutation<{ trained: boolean }>(ctx, p, async (_db, staged, now) => {
        if (!permitted()) return null;
        const bag = staged.storeBag, it = bag.getItemAt(place), info = staged.info.Texp;
        const integer = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
        if (!Number.isFinite(now.getTime()) || !it || !info || it.cellLocked || !it.IsExist || it.UserID !== p.id || it.Place !== place || it.BagType !== bag.bagType ||
            it.TemplateID !== templateId || ctx.templates.findItem(templateId) !== it.template || it.template.CategoryID !== 20 || !it.isValidItem(now) ||
            !integer(it.Count) || it.Count < 1 || !integer(it.template.MaxCount) || it.Count > it.template.MaxCount ||
            !integer(it.template.Property2) || it.template.Property2 < 1 || !integer(staged.info.Grade) || staged.info.Grade < 1 || staged.info.Grade < it.template.NeedLevel ||
            !integer(staged.info.VIPLevel) || !keys.every(k => integer(info[k])) || !integer(info.texpCount) || !integer(info.texpTaskCount) || !Number.isFinite(info.texpTaskDate.getTime())) return null;
        let limit = staged.info.Grade * (staged.info.VIPLevel <= 2 ? 2 : 3), usedBuff = false;
        // Original UsePayBuff(Train_Good=71) checks its template and inclusive
        // expiry, then consumes a limited use before the daily-cap decision.
        const buff = staged.buffs.find(b => b.Type === 71 && b.IsExist);
        const buffTemplate = buff && ctx.templates.findItem(buff.TemplateID);
        if (buff && buffTemplate && buff.BeginDate.getTime() + buff.ValidDate * 60_000 >= now.getTime() &&
            integer(buff.Value) && integer(buff.ValidCount) && (buffTemplate.Property3 === 0 || (buffTemplate.Property3 > 0 && buff.ValidCount > 0))) {
          limit += buff.Value;
          if (buffTemplate.Property3 > 0) { buff.ValidCount--; usedBuff = true; }
        }
        if (!integer(limit)) return null;
        // C# DateTime.Now.Date uses the server's local calendar. Preserve its
        // conditional reset: a previous-day count below the limit is not reset.
        const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
        if (day(info.texpTaskDate) + 1 <= day(now) && info.texpCount >= limit) { info.texpCount = 0; info.texpTaskDate = now; }
        if (info.texpCount >= limit) {
          limited = true;
          return usedBuff ? { value: { trained: false } } : null;
        }
        if (!integer(info[key] + it.template.Property2) || !integer(info.texpTaskCount + 1) || !bag.removeCountFromStack(it, 1)) return null;
        info[key] += it.template.Property2; info.texpCount++; info.texpTaskCount++;
        staged.updatePlayerProperties();
        return { value: { trained: true } };
      });
    } catch (error) {
      if (error instanceof PlayerMutationCommittedError) { result = error.value as { trained: boolean }; notificationError = error; }
      else { ctx.log.error("Training potion transaction failed", error); p.sendMessage(0, "修炼保存失败，药水和经验未改变，请稍后重试。"); return; }
    }
    if (limited) p.sendMessage(0, ctx.lang.t("texpSystem.texpCountToplimit"));
    if (result?.trained) {
      // Quest notifications follow durable profile/material publication.
      for (const id of [templateId, 45001 + ((selectIndex + 4) % 5)]) {
        try { p.questInv?.onUsingItem(id); } catch (error) { notificationError ??= error; }
      }
    }
    if (notificationError) throw notificationError;
  });
}

/** OpenVipHandler.cs (92): str nick, int days. Price from the VIP card (11992) shop entry, charged first (MoneyDirect). */
export function openVip(ctx: ServerContext, p: GamePlayer, nick: string, days: number): void {
  const card = [...ctx.templates.shop.values()].find((s) => s.TemplateID === 11992);
  const money = vipPrice(card, days);
  if (!Number.isSafeInteger(days) || days <= 0 || days > 2_147_483_647)
    return purchaseFailure(ctx, p, 92, "invalid_duration", "请选择正确的贵宾开通天数。");
  if (!Number.isSafeInteger(money) || money < 0 || money > 2_147_483_647)
    return purchaseFailure(ctx, p, 92, "invalid_quote", "贵宾价格配置暂不可用，未扣除点券，请稍后重试。");
  const target = nick === p.info.NickName ? p : ctx.world.all().find((o) => o.info.NickName === nick);
  if (!target) return p.sendMessage(0, `玩家${nick}不存在或不在线！`);
  if (target === p && p.info.VIPLevel === 9) return p.sendMessage(0, "你的贵宾等级已达上限！"); // checked before charging (original charged first)
  if (p.info.Money + p.info.MoneyLock < money)
    return purchaseFailure(ctx, p, 92, "insufficient_money", `开通或续费需要${money}点券，当前点券不足。`);
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
  r.player(99, "TEXP", (ctx, p, pkt) => {
    if (pkt.length - pkt.offset !== 12) return;
    return texp(ctx, p, pkt.readInt(), pkt.readInt(), pkt.readInt());
  });
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
