/**
 * 81 FARM — ports Game.Server/Farm/* (FarmHandler → FarmLogicProcessor → Farm/Handle/*),
 * GameUtils/PlayerFarm.cs + PlayerFarmInventory.cs (base field state machine), SqlDataProvider UserFarmInfo /
 * UserFieldInfo, procs SP_Users_Farm_Add/_Update (player.Sys_User_Farm / Sys_User_Field).
 * Scope (01 §13 / task): plant, fast-forward ("water"/fertilize), harvest, expand (rent fields), farm helper,
 * friend-farm visit/steal. Poultry (subs 20-25/33), gift packs (20) and compose-food (5) are not ported — out of
 * scope for this pass, same "missing" status HANDLERS.md already listed them under.
 *
 * Seed template: Property2 = yield (GainCount), Property3 = minutes to ripen (FieldValidDate), Property4 = the
 * harvested goods template.
 *
 * Fix vs the original: **farm helper price exploit** — HelperSwitchField (sub 9) used to read `price` straight off
 * the wire and charge exactly that (FarmHandler.cs §13 note "Price supplied by client"). This port ignores the
 * client's price entirely and computes it server-side from `seedTime` (minutes) × `FarmHelperPricePerMin`
 * (Server_Config, default 2) — a crafted packet can no longer buy the helper for less (or nothing).
 */
import { and, eq } from "drizzle-orm";
import { PacketOut } from "@ddt/protocol";
import { player } from "@ddt/db";
import { saveItem } from "../db/items.js";
import { sendMail } from "../db/social.js";
import { BagType, ItemInfo, type ItemTemplate } from "../game/item.js";
import type { GamePlayer } from "../game/player.js";
import * as Out from "../packets/out.js";
import type { ServerContext } from "../session/context.js";
import { HandlerRegistry } from "./registry.js";

const FARM = player.Sys_User_Farm;
const FIELD = player.Sys_User_Field;
export const FIELD_CAPACITY = 24;
export const STARTER_FIELDS = 8;
/** PlayerFarmInventory.GropFastforward: GameProperties.FastGrowSubTime. */
export const FAST_GROW_SUB_MIN = 30;
export const MIN_GRADE = 25;

type FarmRow = typeof FARM.$inferSelect;
type FieldRow = typeof FIELD.$inferSelect;

interface FarmState { farm: FarmRow; fields: Map<number, FieldRow>; viewing: number | null }
const stateByPlayer = new WeakMap<GamePlayer, FarmState>();

function isWarrior(p: GamePlayer): boolean { return (p.extra as { coupleBossBoxNum?: number } | null)?.coupleBossBoxNum === 9; }

/** UserFieldInfo.isDig: ripe (seeded and elapsed minutes, minus fast-forward, reached FieldValidDate). */
function isRipe(f: FieldRow, now: Date): boolean {
  if (f.SeedID === 0) return false;
  const elapsedMin = (now.getTime() - f.PlantTime.getTime()) / 60_000 + f.AccelerateTime;
  return elapsedMin >= f.FieldValidDate;
}
/** UserFieldInfo field slot still rented/owned (PayTime in the future, or the 8 starter fields). */
function isUnlocked(f: FieldRow, now: Date): boolean { return f.FieldID < STARTER_FIELDS || f.PayTime.getTime() > now.getTime(); }

async function loadFarm(ctx: ServerContext, userId: number, farmerName: string): Promise<{ farm: FarmRow; fields: Map<number, FieldRow> }> {
  const db = ctx.db.db;
  let [farm] = await db.select().from(FARM).where(eq(FARM.FarmID, userId)).limit(1);
  if (!farm) {
    const now = ctx.now();
    [farm] = await db.insert(FARM).values({ FarmID: userId, FarmerName: farmerName, AutoPayTime: now, CountDownTime: now, PayFieldMoney: "", PayAutoMoney: "" }).returning();
    const rows = Array.from({ length: STARTER_FIELDS }, (_, i) => ({
      FarmID: userId, FieldID: i, SeedID: 0, PlantTime: now, FieldValidDate: 1, PayTime: new Date(now.getTime() + 100 * 365 * 86_400_000),
      payFieldTime: 876_000, GainCount: 0, AccelerateTime: 0, AutomaticTime: now, IsExit: true,
    }));
    await db.insert(FIELD).values(rows);
  }
  const fieldRows = await db.select().from(FIELD).where(and(eq(FIELD.FarmID, userId), eq(FIELD.IsExit, true)));
  return { farm, fields: new Map(fieldRows.map((f) => [f.FieldID, f])) };
}

async function saveField(ctx: ServerContext, userId: number, f: FieldRow): Promise<void> {
  const { ID, FarmID: _fid, ...rest } = f;
  if (ID > 0) await ctx.db.db.update(FIELD).set(rest).where(eq(FIELD.ID, ID));
  else { const [row] = await ctx.db.db.insert(FIELD).values({ ...rest, FarmID: userId }).returning(); f.ID = row!.ID; }
}
async function saveFarm(ctx: ServerContext, f: FarmRow): Promise<void> {
  const { ID, ...rest } = f;
  await ctx.db.db.update(FARM).set(rest).where(eq(FARM.ID, ID));
}

function st(ctx: ServerContext, p: GamePlayer): Promise<FarmState> {
  const cur = stateByPlayer.get(p);
  if (cur) return Promise.resolve(cur);
  return loadFarm(ctx, p.id, p.info.NickName ?? "").then(({ farm, fields }) => {
    const s: FarmState = { farm, fields, viewing: null };
    stateByPlayer.set(p, s);
    return s;
  });
}

function fieldPacket(f: FieldRow): PacketOut {
  const p = new PacketOut(81);
  p.writeByte(17); // FARM_LAND_INFO: single-field echo
  p.writeInt(f.FieldID); p.writeInt(f.SeedID); Out.wd(p, f.PlantTime); p.writeInt(f.FieldValidDate);
  p.writeInt(f.AccelerateTime); p.writeInt(f.GainCount); Out.wd(p, f.PayTime);
  return p;
}
function farmSnapshot(sub: number, ownerId: number, ownerName: string, isHelper: boolean, fields: FieldRow[]): PacketOut {
  const p = new PacketOut(81);
  p.writeByte(sub); p.writeInt(ownerId); p.writeString(ownerName); p.writeBoolean(isHelper); p.writeInt(fields.length);
  for (const f of fields) {
    p.writeInt(f.FieldID); p.writeInt(f.SeedID); Out.wd(p, f.PlantTime); p.writeInt(f.FieldValidDate);
    p.writeInt(f.AccelerateTime); p.writeInt(f.GainCount); Out.wd(p, f.PayTime);
  }
  return p;
}
function helperPacket(farm: FarmRow): PacketOut {
  const p = new PacketOut(81);
  p.writeByte(9); p.writeBoolean(farm.isFarmHelper); p.writeInt(farm.isAutoId); p.writeInt(farm.AutoValidDate); p.writeInt(farm.KillCropId);
  return p;
}

async function giveOrMail(ctx: ServerContext, p: GamePlayer, tpl: ItemTemplate, count: number): Promise<void> {
  const item = ItemInfo.createFromTemplate(tpl, count, 102);
  const inv = p.getItemInventory(tpl) ?? p.propBag;
  if (inv.addTemplate(item, count)) return;
  item.UserID = 0; item.BagType = -1; item.Place = -1;
  await saveItem(ctx.db.db, item);
  await sendMail(ctx.db.db, { Content: "背包已满，道具已放入附件。", Title: "农场道具", Annex1: String(item.ItemID), Annex1Name: tpl.Name ?? "", Gold: 0, Money: 0, Type: 9, Receiver: p.info.NickName ?? "", ReceiverID: p.id, Sender: "农场", SenderID: 0 } as never);
  p.send(Out.mailResponse(p.id, 1));
}

export function registerFarm(r: HandlerRegistry): void {
  r.player(81, "FARM", async (ctx, p, pkt) => {
    if (isWarrior(p)) return;
    if (p.info.Grade < MIN_GRADE) return p.sendMessage(0, `需要达到${MIN_GRADE}级才能使用此功能。`);
    const type = pkt.readByte();
    const s = await st(ctx, p);
    switch (type) {
      case 1: { // ENTER_FARM: int ownerId (0 = self)
        const ownerId = pkt.readInt();
        if (!ownerId || ownerId === p.id) { s.viewing = null; p.send(farmSnapshot(1, p.id, p.info.NickName ?? "", s.farm.isFarmHelper, [...s.fields.values()])); return; }
        const other = ctx.world.get(ownerId);
        const { farm, fields } = other ? (stateByPlayer.get(other) ?? (await st(ctx, other))) : await loadFarm(ctx, ownerId, "");
        s.viewing = ownerId;
        p.send(farmSnapshot(1, ownerId, farm.FarmerName ?? other?.info.NickName ?? "", farm.isFarmHelper, [...fields.values()]));
        return;
      }
      case 16: // EXIT_FARM
        s.viewing = null;
        return;
      case 2: { // GROW_FIELD: byte _, int seedTpl, int fieldId
        pkt.readByte();
        const seedTpl = pkt.readInt();
        const fieldId = pkt.readInt();
        const f = s.fields.get(fieldId);
        const now = ctx.now();
        if (!f || !isUnlocked(f, now) || f.SeedID !== 0) return;
        const t = ctx.templates.findItem(seedTpl);
        if (!t) return;
        const inv = p.getInventory(BagType.FarmBag);
        const seed = inv?.getItemByTemplateID(0, seedTpl);
        if (!seed || !inv!.removeCountFromStack(seed, 1)) return p.sendMessage(0, "种子不足。");
        f.SeedID = seedTpl; f.PlantTime = now; f.GainCount = t.Property2; f.FieldValidDate = Math.max(1, t.Property3); f.AccelerateTime = 0;
        await saveField(ctx, p.id, f);
        p.send(fieldPacket(f));
        return;
      }
      case 18: { // FRAM_GROP_FASTFORWARD: bool useGiftToken, bool all, int fieldId
        const useGiftToken = pkt.readBoolean();
        const all = pkt.readBoolean();
        const fieldId = pkt.readInt();
        const now = ctx.now();
        const targets = all ? [...s.fields.values()].filter((f) => f.SeedID !== 0 && !isRipe(f, now)) : [s.fields.get(fieldId)].filter((f): f is FieldRow => !!f && f.SeedID !== 0 && !isRipe(f, now));
        if (!targets.length) return;
        const unit = ctx.templates.cfgInt("FastGrowNeedMoney", 10);
        const cost = unit * targets.length;
        if (useGiftToken) { if (p.info.GiftToken < cost) return p.sendMessage(0, "所需货币不足。"); p.removeGiftToken(cost); }
        else { if (p.info.Money + p.info.MoneyLock < cost) return p.sendMessage(0, "所需货币不足。"); p.removeMoney(cost); }
        for (const f of targets) { f.AccelerateTime += FAST_GROW_SUB_MIN; await saveField(ctx, p.id, f); p.send(fieldPacket(f)); }
        return;
      }
      case 4: { // GAIN_FIELD: int ownerId, int fieldId
        const ownerId = pkt.readInt();
        const fieldId = pkt.readInt();
        const now = ctx.now();
        if (!ownerId || ownerId === p.id) {
          const f = s.fields.get(fieldId);
          if (!f || !isRipe(f, now)) return;
          const t = ctx.templates.findItem(f.SeedID);
          const goodsT = t ? ctx.templates.findItem(t.Property4) : undefined;
          const count = f.GainCount;
          f.SeedID = 0; f.FieldValidDate = 1; f.AccelerateTime = 0; f.GainCount = 0;
          await saveField(ctx, p.id, f);
          if (goodsT && count > 0) await giveOrMail(ctx, p, goodsT, count);
          p.send(fieldPacket(f));
          return;
        }
        // friend farm: single steal while fresh (GainCount > 9, matches PlayerFarm.GainFriendFields)
        const other = ctx.world.get(ownerId);
        const owner = other ? stateByPlayer.get(other) : undefined;
        const theirFields = owner?.fields ?? (await loadFarm(ctx, ownerId, "")).fields;
        const f = theirFields.get(fieldId);
        if (!f || !isRipe(f, now) || f.GainCount <= 9) return;
        const t = ctx.templates.findItem(f.SeedID);
        const goodsT = t ? ctx.templates.findItem(t.Property4) : undefined;
        f.GainCount -= 1;
        await saveField(ctx, ownerId, f);
        if (goodsT) await giveOrMail(ctx, p, goodsT, 1);
        p.send(fieldPacket(f));
        other?.send(fieldPacket(f));
        return;
      }
      case 7: { // KILLCROP_FIELD: int fieldId
        const fieldId = pkt.readInt();
        const f = s.fields.get(fieldId);
        if (!f) return;
        f.SeedID = 0; f.FieldValidDate = 1; f.AccelerateTime = 0; f.GainCount = 0;
        await saveField(ctx, p.id, f);
        p.send(fieldPacket(f));
        return;
      }
      case 6: { // PAY_FIELD: int n, n*int fieldId, int months (0 = week, else month, like the shop AUnit convention)
        const n = pkt.readInt();
        const ids = Array.from({ length: n }, () => pkt.readInt());
        const months = pkt.readInt();
        const week = months === 0;
        const hours = week ? ctx.templates.cfgInt("FarmFieldWeekHours", 168) : ctx.templates.cfgInt("FarmFieldMonthHours", 720);
        const price = week ? ctx.templates.cfgInt("FarmFieldWeekPrice", 5000) : ctx.templates.cfgInt("FarmFieldMonthPrice", 18000);
        const total = price * ids.length;
        if (p.info.Gold < total) return p.sendMessage(0, "所需货币不足。");
        const now = ctx.now();
        for (const id of ids) {
          if (id < STARTER_FIELDS || id >= FIELD_CAPACITY) continue;
          let f = s.fields.get(id);
          const base = f && f.PayTime.getTime() > now.getTime() ? f.PayTime.getTime() : now.getTime();
          const payTime = new Date(base + hours * 3_600_000);
          if (!f) { f = { ID: 0, FarmID: p.id, FieldID: id, SeedID: 0, PlantTime: now, AccelerateTime: 0, FieldValidDate: 1, PayTime: payTime, GainCount: 0, AutoSeedID: 0, AutoFertilizerID: 0, AutoSeedIDCount: 0, AutoFertilizerCount: 0, isAutomatic: false, AutomaticTime: now, IsExit: true, payFieldTime: hours } as FieldRow; }
          else { f.PayTime = payTime; f.payFieldTime = hours; }
          await saveField(ctx, p.id, f);
          s.fields.set(id, f);
        }
        p.removeGold(total);
        p.send(farmSnapshot(6, p.id, p.info.NickName ?? "", s.farm.isFarmHelper, [...s.fields.values()]));
        return;
      }
      case 8: { // HELPER_PAY_FIELD: int validity (days) — renews the helper slot itself (not the seed contract)
        const validity = pkt.readInt();
        const price = validity > 1 ? ctx.templates.cfgInt("FarmHelperMonthPrice", 300) : ctx.templates.cfgInt("FarmHelperWeekPrice", 100);
        if (p.info.Money + p.info.MoneyLock < price) return p.sendMessage(0, "所需货币不足。");
        p.removeMoney(price);
        s.farm.VipLimitLevel = validity;
        await saveFarm(ctx, s.farm);
        p.send(helperPacket(s.farm));
        return;
      }
      case 9: { // HELPER_SWITCH_FIELD: bool on, int seedId, int seedTime, int seedCount, int getCount, int payType, int price
        const on = pkt.readBoolean();
        const seedId = pkt.readInt();
        const seedTime = pkt.readInt();
        const seedCount = pkt.readInt();
        const getCount = pkt.readInt();
        const payType = pkt.readInt();
        pkt.readInt(); // client-sent price — IGNORED (exploit fix, see module header)
        if (on) {
          const perMin = ctx.templates.cfgInt("FarmHelperPricePerMin", 2);
          const price = Math.max(1, perMin * Math.max(1, seedTime)) * Math.max(1, seedCount);
          if (payType === -2) { if (p.info.GiftToken < price) return p.sendMessage(0, "所需货币不足。"); p.removeGiftToken(price); }
          else { if (p.info.Money + p.info.MoneyLock < price) return p.sendMessage(0, "所需货币不足。"); p.removeMoney(price); }
          for (const f of s.fields.values()) { f.SeedID = 0; f.FieldValidDate = 1; f.AccelerateTime = 0; f.GainCount = 0; await saveField(ctx, p.id, f); }
        }
        s.farm.isFarmHelper = on;
        s.farm.isAutoId = on ? seedId : 0;
        s.farm.AutoPayTime = ctx.now();
        s.farm.AutoValidDate = on ? seedTime : 0;
        s.farm.GainFieldId = on ? Math.trunc(getCount / 10) : 0;
        s.farm.KillCropId = on ? getCount : 0;
        await saveFarm(ctx, s.farm);
        p.send(helperPacket(s.farm));
        return;
      }
      default:
        ctx.log.debug(`81 FARM: sub ${type} not handled`);
    }
  }, "partial");
}
