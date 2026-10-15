/** Labyrinth persistence/economy owner. Incomplete production definitions still
 * refuse admission; the combat coordinator owns each admitted run's lifetime. */
import { eq } from "drizzle-orm";
import { player as P, type Database } from "@ddt/db";
import { GSPacket } from "@ddt/protocol";
import type { GamePlayer } from "./player.js";
import type { ServerContext } from "../session/context.js";
import { eventsRuntime } from "../handlers/events.js";
import { grantRewards, type Reward } from "./events.js";
import { commitPlayerMutation, PlayerMutationCommittedError } from "./player-transaction.js";
import { labyrinthCombatOwner } from "./labyrinth-combat.js";
import { labyrinthCleanOutOwner } from "./labyrinth-clean-out.js";
import { initialLabyrinthCleanOutPhase, readLabyrinthCleanOutPhase, saveLabyrinthCleanOutPhase } from "./labyrinth-clean-out-checkpoint.js";

export type LabyrinthRow = typeof P.Sys_Users_Labyrinth.$inferSelect;

export function initProcessAward(): string {
  return Array.from({ length: 99 }, (_, i) => String(i)).join("-");
}

function params(ctx: ServerContext): Record<string, unknown> {
  return (eventsRuntime(ctx).scheduler.events.find(e => e.kind === "labyrinth")?.params ?? {}) as Record<string, unknown>;
}

function price(ctx: ServerContext, key: string, fallback: number): number {
  const n = params(ctx)[key] ?? fallback;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid Labyrinth price: ${key}`);
  return n;
}

export function labyrinthTryAgainMoney(ctx: ServerContext, l: LabyrinthRow): number {
  for (let i = 0; i < l.myProgress; i += 2) if (l.currentFloor === i) return price(ctx, "priceBig", 5000);
  return price(ctx, "priceSmall", 1000);
}

export function labyrinthUpdatePkt(id: number, l: LabyrinthRow): GSPacket {
  const p = new GSPacket(131, id);
  p.writeByte(2);
  // LabyrinthManager.__onUpdataInfo / original SendLabyrinthUpdataInfo wire order.
  p.writeInt(l.myProgress); p.writeInt(l.currentFloor); p.writeBoolean(l.completeChallenge);
  p.writeInt(l.remainTime); p.writeInt(l.accumulateExp); p.writeInt(l.cleanOutAllTime);
  p.writeInt(l.cleanOutGold); p.writeInt(l.myRanking); p.writeBoolean(l.isDoubleAward);
  p.writeBoolean(l.isInGame); p.writeBoolean(l.isCleanOut); p.writeBoolean(l.serverMultiplyingPower);
  return p;
}

function freshRow(id: number, now: Date): LabyrinthRow {
  return { UserID: id, myProgress: 0, myRanking: 0, completeChallenge: true, isDoubleAward: false,
    currentFloor: 1, accumulateExp: 0, remainTime: 0, currentRemainTime: 0, cleanOutAllTime: 0,
    cleanOutGold: 50, tryAgainComplete: true, isInGame: false, isCleanOut: false,
    serverMultiplyingPower: false, LastDate: now, ProcessAward: initProcessAward() };
}

async function loadLocked(db: Database, id: number, now: Date, create: boolean): Promise<LabyrinthRow | null> {
  if (create) await db.insert(P.Sys_Users_Labyrinth).values(freshRow(id, now)).onConflictDoNothing();
  return (await db.select().from(P.Sys_Users_Labyrinth).where(eq(P.Sys_Users_Labyrinth.UserID, id)).for("update"))[0] ?? null;
}

async function save(db: Database, l: LabyrinthRow): Promise<void> {
  await db.update(P.Sys_Users_Labyrinth).set(l).where(eq(P.Sys_Users_Labyrinth.UserID, l.UserID));
}

const day = (date: Date) => date.toISOString().slice(0, 10);

function resetDay(l: LabyrinthRow, now: Date): void {
  l.completeChallenge = true; l.accumulateExp = 0; l.isInGame = false; l.currentFloor = 1;
  l.tryAgainComplete = true; l.LastDate = now; l.ProcessAward = initProcessAward();
  l.isCleanOut = false; l.remainTime = 0; l.currentRemainTime = 0; l.cleanOutAllTime = 0;
}

function isUnusedLegacyRow(l: LabyrinthRow): boolean {
  return l.ProcessAward === "-1" && l.myProgress === 0 && l.currentFloor === 1 && l.accumulateExp === 0
    && l.completeChallenge && l.tryAgainComplete && !l.isInGame && !l.isCleanOut && !l.isDoubleAward
    && l.remainTime === 0 && l.currentRemainTime === 0 && l.cleanOutAllTime === 0;
}

/** Original CompleteGetAward stores one claimed prefix, followed by exact floor
 * tokens. A progressed legacy '-1' row must be reset explicitly, never reopened
 * merely because an award or a status request arrived. */
function processTokens(value: string): string[] {
  const tokens = value.split("-");
  let available = false;
  if (tokens.length !== 99 || tokens.some((token, i) => {
    if (token === String(i)) { available = true; return false; }
    return token !== "i" || available;
  })) throw new Error("Invalid Labyrinth ProcessAward; an explicit reset is required");
  return tokens;
}

interface CleanOutAward { floor: number; exp: number; hardCurrency: number; materials: Reward[] }
interface PublishedState { row: LabyrinthRow; messages: string[]; awards?: CleanOutAward[]; resetSweepPhase?: boolean; sweepPhase?: number }

/** A committed notification error is not a failed business transaction. */
async function mutate<T>(ctx: ServerContext, p: GamePlayer,
  work: Parameters<typeof commitPlayerMutation<T>>[2]): Promise<T | null> {
  try { return await commitPlayerMutation(ctx, p, work); }
  catch (error) {
    if (!(error instanceof PlayerMutationCommittedError)) throw error;
    ctx.log.warn(`Labyrinth user ${p.id}: committed; notification failed: ${error.cause}`);
    return error.value as T;
  }
}

function publish(ctx: ServerContext, p: GamePlayer, value: PublishedState): void {
  for (const send of [...(value.awards ?? []).map(award => () => {
    // PlayerActives.method_3: the original per-floor sweep log, after COMMIT.
    const packet = new GSPacket(131, p.id); packet.writeByte(7); packet.writeInt(award.floor); packet.writeInt(award.exp);
    packet.writeInt(award.materials.length);
    for (const item of award.materials) { packet.writeInt(item.templateId); packet.writeInt(item.count); }
    packet.writeInt(award.hardCurrency); p.send(packet);
  }), () => p.send(labyrinthUpdatePkt(p.id, value.row)),
    ...value.messages.map(message => () => p.sendMessage(0, message))]) {
    try { send(); } catch (error) { ctx.log.warn(`Labyrinth user ${p.id}: notification failed: ${error}`); }
  }
}

function hasPendingFloors(l: LabyrinthRow): boolean {
  return l.completeChallenge && Number.isInteger(l.currentFloor) && Number.isInteger(l.myProgress)
    && l.currentFloor >= 1 && l.currentFloor <= l.myProgress && l.myProgress <= floorMaterials.length;
}

function completeCleanOut(l: LabyrinthRow): void {
  l.currentFloor = l.myProgress; l.completeChallenge = false;
  l.remainTime = 0; l.currentRemainTime = 0; l.cleanOutAllTime = 0; l.isCleanOut = false; l.isInGame = false;
}

function quoteCleanOut(ctx: ServerContext, l: LabyrinthRow, phase: number): number {
  if (!hasPendingFloors(l)) { l.remainTime = l.currentRemainTime = l.cleanOutAllTime = 0; return 0; }
  if (phase < 1) phase = ctx.templates.cfgInt("WarriorFamRaidTimeRemain", 120);
  const total = phase + (l.myProgress - l.currentFloor) * 120;
  if (!Number.isSafeInteger(phase) || phase < 1 || !Number.isSafeInteger(total) || total > 0x7fffffff)
    throw new Error("Invalid Labyrinth clean-out quote");
  // Default timing is unchanged. Honor a configured first phase without
  // exhausting the total before its last reward, and retain a known partial phase.
  l.remainTime = l.currentRemainTime = l.cleanOutAllTime = total;
  return phase;
}

/** PlayerActives.method_1/2: every floor grants GP and attempts one card;
 * only even floors use the original material/currency columns. No ProcessAward. */
function cleanOutAward(ctx: ServerContext, p: GamePlayer, l: LabyrinthRow, now: Date) {
  const floor = l.currentFloor;
  if (!hasPendingFloors(l)) throw new Error("Invalid Labyrinth clean-out floor");
  if (!p.propBag.getItemByTemplateID(0, 11916) || !p.propBag.removeTemplate(11916, 1)) l.isDoubleAward = false;
  const multiple = l.isDoubleAward ? 2 : 1;
  const exp = (660 + 690 * (floor - 1)) * multiple;
  const hardCurrency = floor % 2 === 0 ? floorCurrency[floor - 1]! * multiple : 0;
  const materials: Reward[] = floor % 2 === 0 ? (ctx.templates.pveDrop("copy", 2, 40002) ?? []).map(drop => ({
    templateId: drop.templateId, count: floorMaterials[floor - 1]! * multiple, validDate: drop.validDate, isBind: true,
  })) : [];
  for (const item of materials) if (!ctx.templates.findItem(item.templateId)) throw new Error("Labyrinth material template is missing");
  const grant = grantRewards(p, materials, ctx.templates.findItem, now);
  p.addGP(exp, false); p.addHardCurrency(hardCurrency); l.accumulateExp += exp;
  return { award: { floor, exp, hardCurrency, materials }, overflow: grant.overflow };
}

export async function labyrinthHandler(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  const sub = pkt.readInt();
  if (![1, 2, 3, 4, 5, 6, 9].includes(sub)) return;
  const enabled = eventsRuntime(ctx).scheduler.events.find(e => e.kind === "labyrinth")?.enabled !== false;
  if (!enabled) return p.sendMessage(0, "勇士迷宫暂未开放。");
  if (labyrinthCombatOwner(ctx).stopping) return p.sendMessage(0, "服务器正在停止，迷宫暂不接受新操作。");
  if (labyrinthCleanOutOwner(ctx).stopping) return p.sendMessage(0, "服务器正在停止，迷宫暂不接受新操作。");
  if (labyrinthCombatOwner(ctx).busy(p)) return p.sendMessage(0, "迷宫战斗或结算尚未结束，请稍后再操作。");
  if (labyrinthCleanOutOwner(ctx).recovering(p)) return p.sendMessage(0, "迷宫扫荡正在恢复结算，请稍后再操作。");
  // This handler already owns GameClient.chain. Waiting for an award queued
  // behind it would deadlock; the combat owner rejects administrative mutations
  // for the whole admitted run and settles accepted outcomes on that same queue.
  if (p.currentRoom?.game) return p.sendMessage(0, "战斗期间暂时无法操作迷宫，请结束战斗后重试。");
  if (p.worldBossAwardPending) return p.sendMessage(0, "正在结算活动奖励，请稍后再操作迷宫。");
  const on = sub === 1 ? pkt.readBoolean() : false;
  const again = sub === 9 ? pkt.readBoolean() : false;
  if (sub === 9) pkt.readBoolean();
  await p.withWorldBossAward(async () => {
    const result = await p.withPersistenceLock(async () => {
      if (!p.isActive || p.quitting || p.currentRoom?.game) return null;
      return mutate<PublishedState>(ctx, p, async (db, staged, now) => {
        if (!p.isActive || p.quitting || p.currentRoom?.game) return null;
        const l = (await loadLocked(db, p.id, now, true))!;
        const rollover = day(now) !== day(l.LastDate);
        if (rollover) resetDay(l, now);
        else if (isUnusedLegacyRow(l)) l.ProcessAward = initProcessAward();
        const messages: string[] = [];
        let resetSweepPhase = rollover;
        let sweepPhase = rollover ? 0 : (await readLabyrinthCleanOutPhase(db, l)) ?? initialLabyrinthCleanOutPhase(ctx, l);
        const awards: CleanOutAward[] = [], overflow: ReturnType<typeof grantRewards>["overflow"] = [];
        switch (sub) {
          case 1:
            if (on && !l.isDoubleAward && staged.propBag.getItemByTemplateID(0, 11916)
              && staged.propBag.removeTemplate(11916, 1)) l.isDoubleAward = true;
            break;
          case 2: {
            // Refreshing an active or paused checkpoint must not rewind its
            // remaining seconds, partial floor, or original progress-bar total.
            if (sweepPhase > 0) break;
            // A legacy row without a recoverable phase may explicitly request
            // a fresh current-floor quote; it never receives an inferred award.
            resetSweepPhase ||= sweepPhase === 0;
            sweepPhase = quoteCleanOut(ctx, l, sweepPhase);
            break;
          }
          case 3: {
            if (!hasPendingFloors(l) || l.isCleanOut) break;
            if (l.currentRemainTime <= 0 || l.remainTime <= 0) sweepPhase = quoteCleanOut(ctx, l, sweepPhase);
            if (sweepPhase < 1) { messages.push("扫荡计时无法安全恢复，请重新打开迷宫刷新计时。"); break; }
            const amount = price(ctx, "cleanOutGiftToken", 100);
            if (staged.info.GiftToken < amount) { messages.push("礼金不足。"); l.isCleanOut = false; break; }
            staged.removeGiftToken(amount); l.isCleanOut = true; l.isInGame = true;
            break;
          }
          case 4: {
            if (!l.isCleanOut) { messages.push("当前没有正在进行的迷宫扫荡。"); break; }
            if (!hasPendingFloors(l)) break;
            const amount = price(ctx, "pricePerMin", 10) * Math.abs(Math.floor(l.currentRemainTime / 60));
            if (!Number.isSafeInteger(amount)) throw new Error("Invalid Labyrinth speed-up amount");
            if (staged.info.Money < amount) break;
            staged.removeMoney(amount);
            for (; l.currentFloor <= l.myProgress; l.currentFloor++) {
              const result = cleanOutAward(ctx, staged, l, now); awards.push(result.award); overflow.push(...result.overflow);
            }
            completeCleanOut(l);
            break;
          }
          case 5: l.isCleanOut = false; break;
          case 6:
            if (l.tryAgainComplete) {
              l.currentFloor = 1; l.accumulateExp = 0; l.tryAgainComplete = false; l.ProcessAward = initProcessAward();
              l.completeChallenge = true; l.isCleanOut = false; l.isInGame = false;
              l.remainTime = 0; l.currentRemainTime = 0; l.cleanOutAllTime = 0;
              resetSweepPhase = true;
              sweepPhase = 0;
              messages.push("迷宫已重置。");
            } else messages.push("本次迷宫已重置过，请稍后再试。");
            break;
          case 9:
            if (again) {
              const amount = labyrinthTryAgainMoney(ctx, l);
              if (staged.info.Money >= amount) {
                staged.removeMoney(amount); l.completeChallenge = true; l.isInGame = true; messages.push("继续挑战迷宫。");
              }
            } else messages.push("迷宫挑战已暂停。");
            break;
        }
        await save(db, l);
        await saveLabyrinthCleanOutPhase(db, l, hasPendingFloors(l) && sweepPhase > 0 ? sweepPhase : null);
        return { value: { row: l, messages, awards, resetSweepPhase, sweepPhase }, overflow, mailTitle: "迷宫奖励" };
      });
    });
    if (result) {
      publish(ctx, p, result);
      labyrinthCleanOutOwner(ctx).sync(p, result.row, result.resetSweepPhase, result.sweepPhase);
    }
  });
}

// GamePlayer.cs labyrinthGolds[40]. These rows do not create combat missions.
const floorMaterials = [0, 2, 0, 2, 0, 2, 0, 3, 0, 3, 0, 3, 0, 4, 0, 4, 0, 4, 0, 5, 0, 5, 0, 5, 0, 6, 0, 6, 0, 6, 0, 8, 0, 8, 0, 8, 0, 10, 0, 10];
const floorCurrency = [0, 2, 0, 2, 0, 3, 0, 3, 0, 4, 0, 4, 0, 5, 0, 5, 0, 6, 0, 6, 0, 7, 0, 7, 0, 8, 0, 8, 0, 10, 0, 10, 0, 11, 0, 11, 0, 12, 0, 12];

export interface LabyrinthCleanOutSnapshot {
  day: string; currentFloor: number; myProgress: number;
  remainTime: number; currentRemainTime: number; cleanOutAllTime: number;
}

/** Accepted online seconds, called only by the server-owned client queue while
 * holding the player's award/fight barriers. No wall-clock/offline rewards. */
export async function advanceLabyrinthCleanOut(ctx: ServerContext, p: GamePlayer, expected: LabyrinthCleanOutSnapshot,
  seconds: number, untilFloor: number): Promise<{ row: LabyrinthRow; untilFloor: number } | null> {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || !Number.isSafeInteger(untilFloor) || untilFloor < 1)
    throw new Error("Invalid Labyrinth clean-out timer");
  const result = await p.withPersistenceLock(() => mutate<PublishedState & { untilFloor: number }>(ctx, p, async (db, staged, now) => {
    const l = await loadLocked(db, p.id, now, false);
    if (!l) throw new Error("Labyrinth clean-out row is missing");
    if (day(l.LastDate) !== expected.day || (["currentFloor", "myProgress", "remainTime", "currentRemainTime", "cleanOutAllTime"] as const)
      .some(key => l[key] !== expected[key])) throw new Error("Labyrinth clean-out run was replaced");
    if (!l.isCleanOut || !hasPendingFloors(l)) return null;
    if (![l.remainTime, l.currentRemainTime, l.cleanOutAllTime].every(value => Number.isSafeInteger(value) && value >= 0))
      throw new Error("Invalid Labyrinth clean-out remaining time");
    const durablePhase = await readLabyrinthCleanOutPhase(db, l);
    if (durablePhase !== null && durablePhase !== untilFloor)
      throw new Error("Labyrinth clean-out phase was replaced");
    if (untilFloor + (l.myProgress - l.currentFloor) * 120 > Math.min(l.remainTime, l.currentRemainTime))
      throw new Error("Labyrinth clean-out remaining time cannot cover its pending floors");
    let left = seconds;
    const awards: CleanOutAward[] = [], overflow: ReturnType<typeof grantRewards>["overflow"] = [];
    while (left > 0 && l.remainTime > 0 && l.currentRemainTime > 0) {
      const step = Math.min(left, untilFloor, l.remainTime, l.currentRemainTime);
      left -= step; untilFloor -= step; l.remainTime -= step; l.currentRemainTime -= step;
      if (untilFloor === 0) {
        const award = cleanOutAward(ctx, staged, l, now); awards.push(award.award); overflow.push(...award.overflow);
        untilFloor = 120; l.currentFloor++;
        if (l.currentFloor > l.myProgress) { completeCleanOut(l); break; }
      }
    }
    await save(db, l);
    await saveLabyrinthCleanOutPhase(db, l, hasPendingFloors(l) ? untilFloor : null);
    return { value: { row: l, untilFloor, awards, messages: [] }, overflow, mailTitle: "迷宫奖励" };
  }));
  if (result) publish(ctx, p, result);
  return result && { row: result.row, untilFloor: result.untilFloor };
}

export interface LabyrinthFloorAward { floor: number; missionId: number; bigAward: boolean }
export interface LabyrinthAwardResult extends PublishedState { exp: number; hardCurrency: number; materials: Reward[] }
export interface LabyrinthRunSnapshot { day: string; processAward: string; currentFloor: number }

function checkRun(l: LabyrinthRow, expected: LabyrinthRunSnapshot): void {
  if (day(l.LastDate) !== expected.day || l.ProcessAward !== expected.processAward || l.currentFloor !== expected.currentFloor)
    throw new Error("Labyrinth run was replaced; settlement refused");
}

/** Called from the real host's packet queue, after configuration/room checks. */
export function prepareLabyrinthRun(ctx: ServerContext, p: GamePlayer): Promise<LabyrinthRow | null> {
  return p.withPersistenceLock(() => mutate(ctx, p, async (db, _staged, now) => {
    if (!p.isActive || p.quitting || p.currentRoom?.game) return null;
    const l = (await loadLocked(db, p.id, now, true))!;
    if (day(now) !== day(l.LastDate)) resetDay(l, now);
    else if (isUnusedLegacyRow(l)) l.ProcessAward = initProcessAward();
    processTokens(l.ProcessAward);
    if (!l.completeChallenge || l.isCleanOut || l.currentFloor < 1 || l.currentFloor > 30) return null;
    l.isInGame = true;
    await save(db, l);
    return { value: l };
  }));
}

/** Original GamePlayer.OutLabyrinth/ResetLabyrinth (4315-4351). The coordinator
 * seals the producer and drains accepted layer awards before reopening tokens. */
export async function finishLabyrinthRun(ctx: ServerContext, p: GamePlayer, expected: LabyrinthRunSnapshot, isWin: boolean): Promise<void> {
  const result = await p.withPersistenceLock(() => mutate(ctx, p, async (db, _staged, now) => {
    const l = await loadLocked(db, p.id, now, false);
    if (!l) throw new Error("Labyrinth run is missing");
    checkRun(l, expected);
    const retryPrice = !isWin && l.currentFloor > 1 ? labyrinthTryAgainMoney(ctx, l) : null;
    l.isInGame = false; l.completeChallenge = false; l.ProcessAward = initProcessAward();
    await save(db, l);
    return { value: { row: l, retryPrice, messages: [] } };
  }));
  if (!result) return;
  publish(ctx, p, result);
  if (result.retryPrice !== null) {
    const pkt = new GSPacket(131, p.id); pkt.writeByte(9); pkt.writeInt(result.retryPrice);
    try { p.send(pkt); } catch (error) { ctx.log.warn(`Labyrinth user ${p.id}: retry quote notification failed: ${error}`); }
  }
}

/** Original GamePlayer.UpdateLabyrinth business transaction. The combat
 * adapter must authenticate actual fight/participant/run identity and hold its
 * settlement barrier before calling this internal owner. No packet calls it. */
export async function awardLabyrinthFloor(ctx: ServerContext, p: GamePlayer, award: LabyrinthFloorAward, expected?: LabyrinthRunSnapshot): Promise<LabyrinthAwardResult | null> {
  const { floor, missionId, bigAward } = award;
  if (!Number.isInteger(floor) || floor < 1 || floor > 30 || missionId !== 40000 + floor
    || typeof bigAward !== "boolean" || (bigAward && floor % 2 !== 0)) throw new Error("Invalid Labyrinth floor award");
  const result = await p.withPersistenceLock(() => mutate<LabyrinthAwardResult>(ctx, p, async (db, staged, now) => {
    const l = await loadLocked(db, p.id, now, false);
    if (!l) throw new Error("Labyrinth run is missing");
    if (expected) checkRun(l, expected);
    const tokens = processTokens(l.ProcessAward);
    if (tokens[floor] !== String(floor)) return null;
    if (!l.completeChallenge || !l.isInGame || l.isCleanOut || (!expected && day(l.LastDate) !== day(now)) || l.currentFloor !== floor)
      throw new Error("Labyrinth award does not match the active current-floor run");
    // The original attempts this consumption even when double rewards are off.
    if (!staged.propBag.getItemByTemplateID(0, 11916) || !staged.propBag.removeTemplate(11916, 1)) l.isDoubleAward = false;
    const multiple = l.isDoubleAward ? 2 : 1;
    const exp = (660 + 690 * (floor - 1)) * multiple;
    const hardCurrency = bigAward ? floorCurrency[floor - 1]! * multiple : 0;
    const count = floorMaterials[floor - 1]! * multiple;
    const materials: Reward[] = bigAward ? (ctx.templates.pveDrop("copy", 2, 40002) ?? []).map(drop => ({
      templateId: drop.templateId, count, validDate: drop.validDate, isBind: true,
    })) : [];
    for (const item of materials) if (!ctx.templates.findItem(item.templateId)) throw new Error("Labyrinth material template is missing");
    const grant = grantRewards(staged, materials, ctx.templates.findItem, now);
    staged.addGP(exp, false); staged.addHardCurrency(hardCurrency);
    for (let i = 0; i <= floor; i++) tokens[i] = "i";
    l.ProcessAward = tokens.join("-"); l.myProgress = Math.max(l.myProgress, floor + 1);
    l.currentFloor = Math.max(l.currentFloor, floor + 1); l.accumulateExp += exp;
    await save(db, l);
    const message = [`迷宫：经验 +${exp}`, ...grant.summary, ...(bigAward ? [`迷宫币 +${hardCurrency}`] : [])].join("，");
    return { value: { row: l, exp, hardCurrency, materials, messages: [message] }, overflow: grant.overflow, mailTitle: "迷宫奖励" };
  }));
  if (result) publish(ctx, p, result);
  return result;
}
