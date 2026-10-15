/** Local snowfield: original145 scene, durable admission and real fight outcomes. */
import type { ChristmasNativeView, ChristmasAction, ChristmasEffect } from "./activity-christmas-native.js";
export const SNOWFIELD_HTTP_ID = "christmas-native" as const;
export const SNOWFIELD_STATE_ID = "christmas-snowfield" as const;
export const SNOWFIELD_CATALOG = "christmas-snowfield-local-v1" as const;
export type SnowfieldType = 0 | 1 | 2;
/** Root final decision: local arena1201 for all3, not original Christmas missions. */
export const SNOWFIELD_LOCAL_LEVELS = [
  { type: 0, originalMissionId: 40001, localPveId: 164001, battleMapId: 1201, passive: true },
  { type: 1, originalMissionId: 40002, localPveId: 164002, battleMapId: 1201, passive: false },
  { type: 2, originalMissionId: 40003, localPveId: 164003, battleMapId: 1201, passive: false },
] as const;
export type SnowfieldToken = string; // real UTC YYYY-MM-DD + '.' + full SHA256 base64url43 =54
export type SnowfieldAuthority = "online" | "offline" | "unavailable";
export interface SnowfieldReward {
  templateId: 11019 | 11001 | 11021 | 11002;
  name: string; itemCount: 1; bound: true; validDays: 0;
}
/** Reject extra keys. The outer existing characterId/requestId UUID schema is unchanged. */
export type SnowfieldAction =
  | { type: "enter"; choice: SnowfieldToken }
  | { type: "challenge"; index: SnowfieldType; choice: SnowfieldToken }
  | { type: "npc-claim"; choice: SnowfieldToken };
export interface SnowfieldEntry {
  available: boolean; reason: string;
}
export interface SnowfieldChallenge {
  index: SnowfieldType; // fixed catalog index0/1/2, NOT original server monsterID
  type: SnowfieldType;
  title: string;
  monsterId: number | null; // actual145 instance; null until authoritative spawn
  state: "unavailable" | "alive" | "reserved" | "fighting" | "dead";
  originalMissionId: 40001 | 40002 | 40003;
  localPveId: 164001 | 164002 | 164003;
  battleMapId: 1201; // actual arena map; room MapId remains localPveId
  usedToday: number; // stored UTC-day quota,0..3
  remainingToday: number; //3-usedToday
  limit: 3;
  canChallenge: boolean;
  reason: string;
  reward: SnowfieldReward;
}
export interface SnowfieldView {
  version: 1; kind: "christmas-snowfield"; rulesVersion: 1;
  catalogVersion: typeof SNOWFIELD_CATALOG;
  day: string; serverNow: string; revision: number;
  authority: SnowfieldAuthority; available: boolean; reason: string;
  stateToken: SnowfieldToken | null;
  currency: "local-task-points"; points: number; taskEarned: number;
  /** Exact mirror source for nativeChristmas.snowfield; not nativeChristmas.available. */
  entry: SnowfieldEntry;
  ticket: {
    claimKey: string; // task:${day}:sign, exact already-claimed key only
    qualifiedToday: boolean;
    issuedToday: boolean;
    issuedAt: string | null;
    expiresAt: string | null;
    valid: boolean; durationSeconds: 1800;
  };
  scene: {
    revision: string | null; // full SHA256 base64url43; only API unreachable skeleton uses null
    state: "outside" | "loading" | "inside" | "fighting" | "settling";
    people: number; capacity: 20;
    canResume: boolean; // explicit click only; resume already committed phase2
    reason: string;
  };
  /** Game always3 ordered rows. API unreachable skeleton [] and npc.reward=null. */
  challenges: SnowfieldChallenge[];
  attempt: {
    state: "none" | "admitted" | "launching" | "fighting" | "settling";
    type: SnowfieldType | null;
    canResume: boolean; // explicit145/22 handoff, never GET/replay side effect
    refundPending: boolean; // definitely never launched; next explicit POST reconciles once
    reason: string;
  };
  npc: {
    hasSettledWinToday: boolean; claimed: boolean; canClaim: boolean;
    reason: string; reward: SnowfieldReward | null;
  };
  rules: string[];
  unavailable: { id: "original-economy" | "original-mission-rules"; reason: string }[];
}
/** Extends the EXISTING nativeChristmasAction union, no new effect-envelope key. */
export type SnowfieldEffect =
  | { type: "entered"; issued: boolean; issuedAt: string; expiresAt: string; committedRevision: number; committedSceneRevision: string }
  | { type: "challenged"; index: SnowfieldType; monsterId: number;
      originalMissionId: 40001 | 40002 | 40003; localPveId: 164001 | 164002 | 164003;
      usedToday: number; committedRevision: number; committedSceneRevision: string }
  | { type: "npc-claimed"; rewards: [SnowfieldReward]; committedRevision: number; committedSceneRevision: string };
export interface SnowfieldEnvelope { requestId: string; effects: [SnowfieldEffect] }
export type ChristmasActivityAction = ChristmasAction | SnowfieldAction;
export type ChristmasActivityEffect = ChristmasEffect | SnowfieldEffect;
/** Same queue+persistence read, not two calls joined by equal wallet revisions. */
export type PairedChristmasNativeView = Omit<ChristmasNativeView, "snowfield"> & { snowfield: SnowfieldEntry };
export interface SnowfieldPair { snowman: PairedChristmasNativeView; snowfield: SnowfieldView }
export interface SnowfieldRead {
  actor: { accountId: number; accountName: string }; characterId: number;
}
export interface SnowfieldCommand extends SnowfieldRead { requestId: string; action: SnowfieldAction }
export interface SnowfieldResult {
  pair: SnowfieldPair; requestId: string; replayed: boolean;
  message: string; mailedCount: number;
  nativeChristmasAction?: SnowfieldEnvelope;
}
export type SnowfieldReply<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

/** Private game owner only. Preserve unknown fields; future/corrupt version is unavailable. */
export interface SnowfieldState {
  version: 1; kind: "christmas-snowfield"; rulesVersion: 1;
  catalogVersion: typeof SNOWFIELD_CATALOG;
  day: string; usedToday: [number, number, number];
  hasSettledWinToday: boolean; npcClaimedToday: boolean;
  ticket: { issuedDay: string; issuedAt: string; expiresAt: string } | null;
  active: SnowfieldAttempt | null;
  /** Bounded current-day terminals; global ActivityActions retains historical UUID replay. */
  terminals: SnowfieldTerminal[];
  [key: string]: unknown;
}
export interface SnowfieldAttempt {
  id: string; // private server UUID
  admissionRequestId: string; launchRequestId: string; settlementRequestId: string;
  admittedDay: string; admittedAt: string; handoffUntil: string; //30s, not battle timer
  serverInstance: string; sceneEpoch: string; monsterGeneration: number;
  characterId: number; clientId: number;
  type: SnowfieldType; monsterId: number;
  originalMissionId: 40001 | 40002 | 40003; localPveId: 164001 | 164002 | 164003;
  status: "admitted" | "launching" | "fighting" | "settling";
  launchIntentAt: string | null; roomId: number | null; fightId: number | null;
  quotaCharged: true;
  [key: string]: unknown;
}
export interface SnowfieldTerminal {
  attemptId: string; admittedDay: string; settledDay: string;
  type: SnowfieldType; outcome: "win" | "loss" | "aborted";
  fightId: number | null; settlementRequestId: string;
  quotaReturned: boolean; rewardMailed: boolean;
}

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { app, member, player, activityUtcDay, validActivityDay, type Database } from "@ddt/db";
import { GSPacket, ProtocolRangeError } from "@ddt/protocol";
import type { GameClient } from "../session/client.js";
import type { ServerContext } from "../session/context.js";
import type { GamePlayer, RoomMember } from "./player.js";
import type { BaseRoom } from "../rooms/room.js";
import type { FightGame } from "../fight/types.js";
import type { HandlerRegistry } from "../handlers/registry.js";
import { christmasCanonical, ChristmasError, christmasOwnerAuth, christmasOwnerWallet, christmasOwnerSaved,
  christmasOwnerView, christmasOwnerQueued, readChristmasReference, type ChristmasWallet } from "./activity-christmas-native.js";
import { isChristmasWalkable, isChristmasSegmentClear } from "./christmas-navigation.js";
import { bindChristmasPveAdmission, readChristmasPveAdmission, revokeChristmasPveAdmission, CHRISTMAS_PVE_CLIENT_READINESS } from "./christmas-pve.js";
import { ItemInfo } from "./item.js";
import { saveItem } from "../db/items.js";
import { sendMail, type MailRow } from "../db/social.js";
import * as Out from "../packets/out.js";

const MAX = 2147483647, UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, lo = 0, hi = MAX): v is number => Number.isSafeInteger(v) && Number(v) >= lo && Number(v) <= hi;
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
function need(ok: unknown, message: string, status = 409): asserts ok { if (!ok) throw new ChristmasError(message, status); }
const digest = (v: unknown) => createHash("sha256").update(christmasCanonical(v));
export const snowfieldSignature = (action: SnowfieldAction) => digest({ activityId: SNOWFIELD_HTTP_ID, action }).digest("hex");
export function validateSnowfieldAction(v: unknown): asserts v is SnowfieldAction {
  need(obj(v) && typeof v.choice === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(v.choice) && validActivityDay(v.choice.slice(0, 10)) &&
    (v.type === "challenge" ? exact(v, ["type", "index", "choice"]) && integer(v.index, 0, 2) :
      (v.type === "enter" || v.type === "npc-claim") && exact(v, ["type", "choice"])), "雪场操作或状态凭证无效。", 400);
}
function request(value: unknown, write: boolean): SnowfieldRead | SnowfieldCommand {
  need(obj(value) && exact(value, ["actor", "characterId", ...(write ? ["requestId", "action"] : [])]) && integer(value.characterId, 1) && obj(value.actor) &&
    exact(value.actor, ["accountId", "accountName"]) && integer(value.actor.accountId, 1) && typeof value.actor.accountName === "string" && value.actor.accountName.length > 0 && value.actor.accountName.length <= 256, "雪场角色账户参数无效。", 400);
  if (write) { need(typeof value.requestId === "string" && UUID.test(value.requestId), "雪场请求编号无效。", 400); validateSnowfieldAction(value.action); }
  return value as unknown as SnowfieldRead | SnowfieldCommand;
}
export function readSnowfieldState(raw: unknown, now: Date): SnowfieldState {
  const day = activityUtcDay(now);
  if (raw === undefined) return { version: 1, kind: "christmas-snowfield", rulesVersion: 1, catalogVersion: SNOWFIELD_CATALOG, day,
    usedToday: [0, 0, 0], hasSettledWinToday: false, npcClaimedToday: false, ticket: null, active: null, terminals: [] };
  need(obj(raw) && raw.version === 1 && raw.kind === "christmas-snowfield" && raw.rulesVersion === 1 && raw.catalogVersion === SNOWFIELD_CATALOG && validActivityDay(raw.day) &&
    Array.isArray(raw.usedToday) && raw.usedToday.length === 3 && raw.usedToday.every(n => integer(n, 0, 3)) && typeof raw.hasSettledWinToday === "boolean" && typeof raw.npcClaimedToday === "boolean" &&
    (raw.ticket === null || obj(raw.ticket) && validActivityDay(raw.ticket.issuedDay) && date(raw.ticket.issuedAt) && date(raw.ticket.expiresAt) && Date.parse(raw.ticket.expiresAt) - Date.parse(raw.ticket.issuedAt) === 1800000) &&
    Array.isArray(raw.terminals) && raw.terminals.length <= 64 && raw.terminals.every(t => obj(t) && typeof t.attemptId === "string" && UUID.test(t.attemptId) && validActivityDay(t.admittedDay) && validActivityDay(t.settledDay) && integer(t.type, 0, 2) &&
      ["win", "loss", "aborted"].includes(String(t.outcome)) && (t.fightId === null || integer(t.fightId, 1)) && typeof t.settlementRequestId === "string" && UUID.test(t.settlementRequestId) && typeof t.quotaReturned === "boolean" && typeof t.rewardMailed === "boolean"), "雪场存档不兼容；原数据已保留。", 503);
  const a = raw.active;
  need(a === null || obj(a) && ["id", "admissionRequestId", "launchRequestId", "settlementRequestId", "serverInstance", "sceneEpoch"].every(k => typeof a[k] === "string" && UUID.test(a[k] as string)) &&
    validActivityDay(a.admittedDay) && date(a.admittedAt) && date(a.handoffUntil) && integer(a.characterId, 1) && integer(a.clientId, 1) && integer(a.type, 0, 2) && integer(a.monsterId, 1) && integer(a.monsterGeneration, 1) &&
    a.originalMissionId === 40001 + Number(a.type) && a.localPveId === 164001 + Number(a.type) && ["admitted", "launching", "fighting", "settling"].includes(String(a.status)) &&
    (a.launchIntentAt === null || date(a.launchIntentAt)) && (a.roomId === null || integer(a.roomId, 1)) && (a.fightId === null || integer(a.fightId, 1)) && a.quotaCharged === true, "雪场准入存档不兼容；原数据已保留。", 503);
  const s = structuredClone(raw) as unknown as SnowfieldState;
  if (s.day !== day) { s.day = day; s.usedToday = [0, 0, 0]; s.hasSettledWinToday = false; s.npcClaimedToday = false; s.terminals = s.terminals.filter(t => t.settledDay === day); }
  return s;
}
type Point = { x: number; y: number };
interface Member { p: GamePlayer; c: GameClient; position: Point; route: Point[]; movedAt: number; state: number }
interface Reservation { p: GamePlayer; c: GameClient; until: number; epoch: string }
interface Monster { id: number; type: SnowfieldType; position: Point; generation: number; attempt: string | null; state: number }
export interface SnowfieldLease {
  readonly player: GamePlayer; readonly client: GameClient; readonly room: BaseRoom;
  readonly attemptId: string; readonly serverInstance: string; readonly originalMissionId: 40001 | 40002 | 40003; readonly localPveId: 164001 | 164002 | 164003;
}
interface Lease extends SnowfieldLease { actor: SnowfieldRead["actor"]; attempt: SnowfieldAttempt; prepared: boolean; acceptedId: number | null; sealed: boolean; refund: boolean; outcome: "win" | "loss" | "aborted" | null; pending: Promise<void> | null }
export type SnowfieldPermit = { ok: true; lease: SnowfieldLease } | { ok: false; message: string };
export interface SnowfieldSetup { roomType: number; mapId: number; originalMissionId?: number; hardLevel: number; timeMode: number; levelLimits: number; isOpenBoss: boolean; isCrosszone: boolean; name: string; password: string }
export interface ChristmasSnowfieldRoomAccess {
  canCreateRoom(p: RoomMember): boolean;
  roomCreated(p: GamePlayer, room: BaseRoom): void;
  checkRoom(room: BaseRoom, players: readonly RoomMember[], setup?: SnowfieldSetup, forStart?: boolean): SnowfieldPermit;
  fightAccepted(lease: SnowfieldLease, game: FightGame): void;
  fightFinished(lease: SnowfieldLease, id: number, won: boolean): void;
  fightStopped(lease: SnowfieldLease, id: number | null): void;
  startFailed(lease: SnowfieldLease, reason: string): void;
}
const rewards: SnowfieldReward[] = [
  { templateId: 11019, name: "强化石1级", itemCount: 1, bound: true, validDays: 0 },
  { templateId: 11001, name: "朱雀石1级", itemCount: 1, bound: true, validDays: 0 },
  { templateId: 11021, name: "强化石2级", itemCount: 1, bound: true, validDays: 0 },
  { templateId: 11002, name: "朱雀石2级", itemCount: 1, bound: true, validDays: 0 },
];
const positions: Point[] = [{ x: 650, y: 500 }, { x: 1450, y: 400 }, { x: 1100, y: 900 }];
const rules = ["本地雪场：今日已领取签到任务后可免费申请一次30分钟票，UTC跨日不延长原票。", "每类雪人每天3次、总9次，0积分；不计共享500次，不增加雪包、雪人数或任务积分。",
  "三关统一使用本地竞技地图1201；训练雪人被动，其余为真实近战挑战，不代表原服副本或数值。", "真实胜利分别寄送永久绑定普通材料1份；当天首个已结算胜利后可领NPC日礼1次。",
  "只在服务器确认未开始的技术故障归还一次准入；已开战失败、逃跑不返次。入场和挑战丢包可明确点击继续，不自动重发经济操作。"];
export interface SnowfieldOptions { /** Only isolated tests may override production client readiness. */ isolatedTestFixture?: true; ready?: boolean }
export class ChristmasSnowfieldOwner implements ChristmasSnowfieldRoomAccess {
  readonly serverInstance = randomUUID();
  private readonly epoch = randomUUID();
  private sequence = 0;
  private closing = false;
  private readonly members = new Map<number, Member>();
  private readonly reservations = new Map<number, Reservation>();
  private readonly admissions = new Map<number, { attempt: SnowfieldAttempt; actor: SnowfieldRead["actor"]; p: GamePlayer; c: GameClient; ticketExpiresAt: number }>();
  private readonly leases = new Map<GamePlayer, Lease>();
  private readonly creating = new Set<GamePlayer>();
  private readonly pending = new Set<Promise<void>>();
  private readonly failures = new Map<string, unknown>();
  private readonly monsters: Monster[] = positions.map((position, type) => ({ id: type + 1, type: type as SnowfieldType, position, generation: 1, attempt: null, state: 0 }));
  constructor(private readonly ctx: ServerContext, private readonly options: SnowfieldOptions = {}) {
    need(!options.ready || options.isolatedTestFixture === true, "雪场测试就绪开关只允许隔离fixture。", 503);
    owners.set(ctx, this);
  }
  private ready() { return !this.closing && (CHRISTMAS_PVE_CLIENT_READINESS.ready || this.options.isolatedTestFixture === true && this.options.ready === true); }
  private revision() { return digest({ server: this.serverInstance, epoch: this.epoch, sequence: this.sequence }).digest("base64url"); }
  private changed() { this.sequence++; }
  private online(p: GamePlayer | null | undefined, c?: GameClient) { return !!p && !!c && c.player === p && !c.closed && !p.quitting && p.isActive && this.ctx.world.get(p.id) === p; }
  private free(p: GamePlayer) { return !(p.info.HasBagPassword && p.info.IsLocked) && !p.currentRoom; }
  private templatesReady() { return rewards.every(r => { const t = this.ctx.templates.findItem(r.templateId); return t && t.CategoryID === 11 && !t.CanEquip && t.NeedSex === 0 && integer(t.MaxCount, 1); }); }
  private people() { return this.members.size + [...this.reservations.entries()].filter(([id, r]) => !this.members.has(id) && r.until > this.ctx.now().getTime()).length; }
  private trajectory(m: Member, now: number): { position: Point; remaining: Point[] } {
    let distance = Math.max(0, now - m.movedAt) * 0.16, from = m.position;
    for (let i = 0; i < m.route.length; i++) { const end = m.route[i]!, length = Math.hypot(end.x - from.x, end.y - from.y);
      if (distance < length) return { position: { x: from.x + (end.x - from.x) * distance / length, y: from.y + (end.y - from.y) * distance / length }, remaining: m.route.slice(i) };
      distance -= length; from = end;
    }
    return { position: { ...from }, remaining: [] };
  }
  private position(m: Member, now = this.ctx.now().getTime()): Point { return this.trajectory(m, now).position; }
  private pair(req: SnowfieldRead, saved: Awaited<ReturnType<typeof christmasOwnerSaved>>, w: ChristmasWallet, now: Date, c?: GameClient): SnowfieldPair {
    const snowman = christmasOwnerView(this.ctx, req, saved, w, now, c), p = c?.player;
    let state = readSnowfieldState(undefined, now), compatible = true, why = "请登录游戏后使用雪场。", reference = readChristmasReference(undefined, now);
    try { state = readSnowfieldState(saved.snowfield, now); reference = readChristmasReference(saved.reference, now); } catch (e) { if (!(e instanceof ChristmasError)) throw e; compatible = false; why = e.message; }
    const online = this.online(p, c) && p!.id === req.characterId, authority = !compatible ? "unavailable" as const : online ? "online" as const : "offline" as const;
    const available = compatible && online && this.ready() && this.templatesReady();
    if (compatible && !online) why = "角色离线；已确认胜奖仍会结算。";
    else if (compatible && !this.ready()) why = "雪场客户端资源与AVM2尚未验收，入口保持关闭。";
    else if (compatible && !this.templatesReady()) why = "雪场普通奖励模板暂不可用。";
    else if (available) why = "真实雪场本地规则已就绪。";
    const locked = !!p && !!(p.info.HasBagPassword && p.info.IsLocked), room = p?.currentRoom, member = p && this.members.get(p.id), r = p && this.reservations.get(p.id), active = state.active;
    const valid = !!state.ticket && Date.parse(state.ticket.expiresAt) > now.getTime(), qualified = reference.claims.includes(`task:${activityUtcDay(now)}:sign`), issuedToday = state.ticket?.issuedDay === activityUtcDay(now);
    const currentAdmission = !!active && !!p && !!c && active.serverInstance === this.serverInstance && active.clientId === c.id && this.admissions.get(p.id)?.attempt.id === active.id;
    const liveLease = p && this.leases.get(p);
    const refundPending = !!active && active.status === "admitted" && active.launchIntentAt === null && (active.serverInstance !== this.serverInstance || Date.parse(active.handoffUntil) <= now.getTime());
    const sceneResume = available && !locked && !room && !!r && r.c === c && r.p === p && r.epoch === this.epoch && r.until > now.getTime() && valid;
    const activeMonster = active && this.monsters[active.type], currentPosition = member && this.position(member);
    const attemptResume = available && !locked && !room && valid && !!member && member.c === c && currentAdmission && active!.status === "admitted" && active!.sceneEpoch === this.epoch && Date.parse(active!.handoffUntil) > now.getTime() && activeMonster?.attempt === active!.id && activeMonster.generation === active!.monsterGeneration && !!currentPosition && Math.hypot(currentPosition.x - activeMonster.position.x, currentPosition.y - activeMonster.position.y) <= 150;
    let entryReason = !available ? why : locked ? "请先解除背包锁定。" : room ? "请先退出当前战斗房间。" : active && !refundPending && active.serverInstance === this.serverInstance ? "已有挑战正在处理中，请继续该挑战或等待结算。" : !valid && (!qualified || issuedToday) ? issuedToday ? "今日票已到期，明日签到后可再申请。" : "请先领取今日签到任务积分。" : this.people() >= 20 && !member && !sceneResume ? "雪场已满20人。" : "可以进入或返回雪场。";
    const entry = { available: entryReason === "可以进入或返回雪场。", reason: entryReason };
    const sceneState = liveLease?.pending ? "settling" : liveLease?.acceptedId ? "fighting" : sceneResume ? "loading" : member ? "inside" : "outside";
    const canNpc = available && !locked && !room && state.hasSettledWinToday && !state.npcClaimedToday && w.Revision < MAX;
    const challenges = this.monsters.map(m => {
      const sameRefund = refundPending && active!.type === m.type, remaining = 3 - state.usedToday[m.type], pos = member && this.position(member);
      const reason = !available ? why : locked ? "请先解除背包锁定。" : sceneResume || !member || member.c !== c || !!room ? "请先进入雪场。" : !valid ? "票已过期，只能退出或领取已获得的奖励。" : active && !sameRefund ? "请先结束或结清已有挑战。" : m.attempt && m.attempt !== active?.id ? "该雪人正由真实玩家挑战。" : !p!.hasMainWeapon ? "请先装备武器。" : !pos || Math.hypot(pos.x - m.position.x, pos.y - m.position.y) > 150 ? "请先走近雪人再挑战。" : remaining <= 0 && !sameRefund ? "本类今日3次准入已用完。" : w.Revision >= MAX ? "活动钱包版本已达上限。" : sameRefund ? "先结清未启动准入再重试。" : "可以挑战。";
      return { index: m.type, type: m.type, title: m.type === 0 ? "本地被动训练雪人" : `本地近战雪人${m.type + 1}`, monsterId: m.id, state: sameRefund && m.attempt === active?.id ? "alive" as const : m.state === 1 ? "fighting" as const : m.attempt ? "reserved" as const : "alive" as const,
        originalMissionId: (40001 + m.type) as 40001 | 40002 | 40003, localPveId: (164001 + m.type) as 164001 | 164002 | 164003, battleMapId: 1201 as const, usedToday: state.usedToday[m.type], remainingToday: remaining, limit: 3 as const,
        canChallenge: reason === "可以挑战。" || reason === "先结清未启动准入再重试。", reason, reward: { ...rewards[m.type]! } };
    });
    const sf: SnowfieldView = { version: 1, kind: "christmas-snowfield", rulesVersion: 1, catalogVersion: SNOWFIELD_CATALOG, day: activityUtcDay(now), serverNow: now.toISOString(), revision: w.Revision,
      authority, available, reason: why, stateToken: available ? `${activityUtcDay(now)}.${digest({ wallet: w, raw: saved.snowfield ?? null, reference: saved.reference ?? null, day: activityUtcDay(now), scene: this.revision(), session: c?.id,
        locked, room: room?.RoomId ?? null, member: !!member, positions: member ? { route: member.route, movedAt: member.movedAt, position: member.position } : null, readiness: this.ready(), catalog: SNOWFIELD_CATALOG }).digest("base64url")}` : null,
      currency: "local-task-points", points: w.Points, taskEarned: w.Earned, entry, ticket: { claimKey: `task:${activityUtcDay(now)}:sign`, qualifiedToday: qualified, issuedToday, issuedAt: state.ticket?.issuedAt ?? null, expiresAt: state.ticket?.expiresAt ?? null, valid, durationSeconds: 1800 },
      scene: { revision: this.revision(), state: sceneState, people: this.people(), capacity: 20, canResume: sceneResume, reason: sceneResume ? "点击继续入场加载已确认的票。" : sceneState === "inside" ? "已在真实雪场中。" : why },
      challenges, attempt: { state: liveLease?.pending ? "settling" : liveLease?.acceptedId ? "fighting" : active?.status ?? "none", type: active?.type ?? null, canResume: attemptResume, refundPending, reason: attemptResume ? "点击继续挑战，不重复扣次数。" : refundPending ? "存在确定未启动的准入；下次明确操作可结清。" : active ? "已有准入正在处理。" : "当前没有待处理挑战。" },
      npc: { hasSettledWinToday: state.hasSettledWinToday, claimed: state.npcClaimedToday, canClaim: canNpc, reason: !available ? why : state.npcClaimedToday ? "今日首胜礼已领取。" : canNpc ? "可以领取今日已结算首胜礼。" : "需先完成并结算一次真实胜利。", reward: { ...rewards[3]! } }, rules: [...rules],
      unavailable: [{ id: "original-economy", reason: "使用明确本地签到票和普通材料规则，不连接真实付款。" }, { id: "original-mission-rules", reason: "使用本地竞技地图和可核近战脚本，不宣称原圣诞副本。" }] };
    return { snowman: { ...snowman, snowfield: { ...entry } }, snowfield: sf };
  }
  async read(value: unknown, client?: GameClient): Promise<SnowfieldReply<SnowfieldPair>> {
    return this.reply(async () => { const req = request(value, false) as SnowfieldRead; return christmasOwnerQueued(client, () => this.ctx.db.db.transaction(async tx => {
      const db = tx as unknown as Database, w = await christmasOwnerWallet(db, req.characterId, false), now = this.ctx.now(); await christmasOwnerAuth(db, req, now, false);
      return this.pair(req, await christmasOwnerSaved(db, req.characterId), w, now, client);
    })); });
  }
  private async reply<T>(work: () => Promise<T>): Promise<SnowfieldReply<T>> { try { return { ok: true, value: await work() }; } catch (e) { if (e instanceof ChristmasError) return { ok: false, status: e.status, message: e.message }; throw e; } }
  private async save(db: Database, id: number, state: SnowfieldState) { await db.insert(app.ActivityStates).values({ UserID: id, Activity: SNOWFIELD_STATE_ID, State: state }).onConflictDoUpdate({ target: [app.ActivityStates.UserID, app.ActivityStates.Activity], set: { State: state } }); }
  private async mail(db: Database, id: number, nickname: string, reward: SnowfieldReward, now: Date): Promise<number> {
    const t = this.ctx.templates.findItem(reward.templateId); need(t && t.CategoryID === 11 && !t.CanEquip && t.NeedSex === 0 && integer(t.MaxCount, 1), "雪场奖励模板暂不可用。", 503);
    const item = ItemInfo.createFromTemplate(t, 1, 0, now); item.IsBinds = true; item.ValidDate = 0; await saveItem(db, item);
    const mail: MailRow = { ReceiverID: id, Receiver: nickname, SenderID: 0, Sender: "活动奖励", Title: "本地雪场奖励", Content: "真实战斗结算或每日首胜礼；永久绑定普通材料。", Type: 1, Gold: 0, Money: 0, GiftToken: 0, SendTime: now, SendDate: now,
      Annex1: String(item.ItemID), Annex1Name: t.Name }; await sendMail(db, mail); return 1;
  }
  private terminal(s: SnowfieldState, a: SnowfieldAttempt, outcome: SnowfieldTerminal["outcome"], fightId: number | null, refund: boolean, mailed: boolean, now: Date) {
    if (refund && a.admittedDay === s.day) s.usedToday[a.type] = Math.max(0, s.usedToday[a.type] - 1);
    s.terminals = [...s.terminals, { attemptId: a.id, admittedDay: a.admittedDay, settledDay: activityUtcDay(now), type: a.type, outcome, fightId, settlementRequestId: a.settlementRequestId, quotaReturned: refund, rewardMailed: mailed }].slice(-64);
    s.active = null;
  }
  private releaseAttempt(a: SnowfieldAttempt) {
    if (this.admissions.get(a.characterId)?.attempt.id === a.id) this.admissions.delete(a.characterId); const m = this.monsters[a.type]!;
    if (m.attempt === a.id) { m.attempt = null; m.state = 0; m.generation++; this.changed(); this.broadcast(this.monsterPacket(3, m)); }
  }
  async command(value: unknown, client?: GameClient): Promise<SnowfieldReply<SnowfieldResult>> {
    return this.reply(async () => { const req = request(value, true) as SnowfieldCommand; req.requestId = req.requestId.toLowerCase();
      return christmasOwnerQueued(client, async () => {
        let committed = false;
        let held: Reservation | undefined, heldMonster: Monster | undefined, displaced: SnowfieldAttempt | null = null;
        try {
          const result = await this.ctx.db.db.transaction(async tx => {
            const db = tx as unknown as Database, w = await christmasOwnerWallet(db, req.characterId, true), now = this.ctx.now(), who = await christmasOwnerAuth(db, req, now, true);
            const signature = snowfieldSignature(req.action), [receipt] = await db.select().from(app.ActivityActions).where(and(eq(app.ActivityActions.UserID, req.characterId), eq(app.ActivityActions.RequestID, req.requestId)));
            const saved = await christmasOwnerSaved(db, req.characterId);
            if (receipt) { need(receipt.Signature === signature, "requestId已用于另一操作。"); const r = receipt.Result as { message: string; mailedCount: number }; need(typeof r.message === "string" && integer(r.mailedCount, 0, 1), "雪场回执不可用。", 503); return { saved, wallet: w, replayed: true, ...r }; }
            let before = this.pair(req, saved, w, now, client).snowfield;
            need(before.available && !!client?.player, before.reason); need(req.action.choice === before.stateToken, "雪场任务、场景或状态已变化，请刷新重试。"); need(w.Revision < MAX, "活动钱包版本已达上限。", 503);
            const p = client.player, next = readSnowfieldState(saved.snowfield, now); let message = "", mailedCount = 0;
            if (next.active) { const a = next.active;
              if (before.attempt.refundPending) { this.terminal(next, a, "aborted", null, true, false, now); displaced = a; }
              else if (a.serverInstance !== this.serverInstance) { this.terminal(next, a, "aborted", a.fightId, false, false, now); displaced = a;
                before = this.pair(req, { ...saved, snowfield: next }, w, now, client).snowfield; }
            }
            let effect: SnowfieldEffect;
            if (req.action.type === "enter") {
              need(before.entry.available || before.attempt.refundPending, before.entry.reason); need(this.free(p), "请回大厅并解除背包锁定。"); need(!next.active, "请先结束当前挑战。"); need(this.people() < 20 || this.members.has(p.id) || !!this.reservations.get(p.id), "雪场已满20人。");
              const issued = !next.ticket || Date.parse(next.ticket.expiresAt) <= now.getTime();
              if (issued) { need(before.ticket.qualifiedToday && !before.ticket.issuedToday, "今日签到票不可再次申请。"); next.ticket = { issuedDay: next.day, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 1800000).toISOString() }; }
              held = { p, c: client, until: now.getTime() + 30000, epoch: this.epoch }; this.reservations.set(p.id, held); this.changed();
              effect = { type: "entered", issued, issuedAt: next.ticket!.issuedAt, expiresAt: next.ticket!.expiresAt, committedRevision: w.Revision + 1, committedSceneRevision: this.revision() }; message = "雪场票已确认，请明确继续入场。";
            } else if (req.action.type === "challenge") {
              const row = before.challenges[req.action.index]!; need(row.canChallenge, row.reason); need(!next.active, "当前已有待处理挑战。"); const m = this.monsters[req.action.index]!;
              need(!m.attempt || displaced?.id === m.attempt, "该雪人正由另一位真实玩家挑战。");
              const attempt: SnowfieldAttempt = { id: randomUUID(), admissionRequestId: req.requestId, launchRequestId: randomUUID(), settlementRequestId: randomUUID(), admittedDay: next.day, admittedAt: now.toISOString(), handoffUntil: new Date(now.getTime() + 30000).toISOString(),
                serverInstance: this.serverInstance, sceneEpoch: this.epoch, monsterGeneration: m.generation, characterId: p.id, clientId: client.id, type: m.type, monsterId: m.id, originalMissionId: row.originalMissionId, localPveId: row.localPveId, status: "admitted", launchIntentAt: null, roomId: null, fightId: null, quotaCharged: true };
              next.usedToday[m.type]++; next.active = attempt; m.attempt = attempt.id; heldMonster = m; this.changed();
              effect = { type: "challenged", index: m.type, monsterId: m.id, originalMissionId: row.originalMissionId, localPveId: row.localPveId, usedToday: next.usedToday[m.type], committedRevision: w.Revision + 1, committedSceneRevision: this.revision() }; message = "挑战准入已确认，请明确继续挑战。";
            } else {
              need(before.npc.canClaim, before.npc.reason); next.npcClaimedToday = true; mailedCount = await this.mail(db, p.id, who.NickName!, rewards[3]!, now);
              effect = { type: "npc-claimed", rewards: [{ ...rewards[3]! }], committedRevision: w.Revision + 1, committedSceneRevision: this.revision() }; message = "今日已结算首胜礼已寄往游戏邮件。";
            }
            await this.save(db, req.characterId, next); await db.update(app.ActivityWallet).set({ Revision: w.Revision + 1 }).where(eq(app.ActivityWallet.UserID, req.characterId));
            await db.insert(app.ActivityActions).values({ UserID: req.characterId, RequestID: req.requestId, Signature: signature, Result: { message, mailedCount } });
            return { saved: { ...saved, snowfield: next }, wallet: { ...w, Revision: w.Revision + 1 }, replayed: false, message, mailedCount, effect };
          });
          committed = true;
          if (!result.replayed) {
            if (displaced) this.releaseAttempt(displaced);
            const a = (result.saved.snowfield as SnowfieldState).active;
            if (a && client?.player) this.admissions.set(req.characterId, { attempt: a, actor: req.actor, p: client.player, c: client, ticketExpiresAt: Date.parse((result.saved.snowfield as SnowfieldState).ticket!.expiresAt) });
          }
          const pair = this.pair(req, result.saved, result.wallet, this.ctx.now(), client);
          const e = "effect" in result ? result.effect : undefined;
          const fresh = !result.replayed && e && pair.snowfield.available && pair.snowfield.revision === e.committedRevision && pair.snowfield.scene.revision === e.committedSceneRevision &&
            (e.type === "entered" ? pair.snowfield.scene.canResume : e.type === "challenged" ? pair.snowfield.attempt.canResume : true);
          if (!result.replayed && result.mailedCount && client?.player) this.notice(client.player);
          return { pair, requestId: req.requestId, replayed: !fresh, message: result.message, mailedCount: result.mailedCount, ...(fresh ? { nativeChristmasAction: { requestId: req.requestId, effects: [e] as [SnowfieldEffect] } } : {}) };
        } catch (e) {
          if (!committed && held && this.reservations.get(req.characterId) === held) { this.reservations.delete(req.characterId); this.changed(); }
          if (!committed && heldMonster) { heldMonster.attempt = (displaced as SnowfieldAttempt | null)?.id ?? null; this.changed(); }
          throw e;
        }
      });
    });
  }
  private notice(p: GamePlayer) { if (this.ctx.world.get(p.id) === p) { try { p.send(Out.mailResponse(p.id, 1)); } catch { this.ctx.log.warn("snowfield committed mail notification failed"); } } }
  private send(p: GamePlayer, packet: GSPacket) { try { p.send(packet); } catch { this.ctx.log.warn("snowfield scene notification failed"); } }
  private broadcast(packet: GSPacket, except?: GamePlayer) { for (const m of this.members.values()) if (m.p !== except && this.online(m.p, m.c)) this.send(m.p, packet); }
  private packet(sub: number) { const b = new GSPacket(145); b.writeByte(sub); return b; }
  private playersPacket(ms: Member[], now = this.ctx.now().getTime()) { const b = this.packet(18); b.writeInt(ms.length); for (const m of ms) { const i = m.p.info, pos = this.position(m, now);
    for (const n of [i.Grade, i.Hide, i.Repute, m.p.id]) b.writeInt(n); b.writeString(i.NickName ?? ""); b.writeByte(i.typeVIP); b.writeInt(i.VIPLevel); b.writeBoolean(i.Sex);
    for (const s of [i.Style, i.Colors, i.Skin]) b.writeString(s ?? ""); for (const n of [i.FightPower, i.Win, i.Total, i.Offer]) b.writeInt(Number(n ?? 0)); b.writeInt(Math.round(pos.x)); b.writeInt(Math.round(pos.y)); b.writeByte(m.state); } return b; }
  private monsterPacket(op = 0, one?: Monster) { const b = this.packet(22); b.writeByte(op); if (op === 3 && one) { b.writeInt(one.id); b.writeInt(one.state); }
    else { b.writeInt(this.monsters.length); for (const m of this.monsters) { b.writeInt(m.id); b.writeInt(m.type); b.writeInt(m.state); b.writeInt(m.position.x); b.writeInt(m.position.y); } } return b; }
  async enterScene(c: GameClient, p: GamePlayer, _requested: Point): Promise<void> {
    need(this.online(p, c) && this.ready() && this.free(p), "当前不可进入雪场。"); const r = this.reservations.get(p.id), existing = this.members.get(p.id);
    need(existing?.c === c || r?.p === p && r.c === c && r.epoch === this.epoch && r.until > this.ctx.now().getTime(), "请先通过活动窗口确认雪场票。");
    await p.withPersistenceLock(async () => { const saved = await christmasOwnerSaved(this.ctx.db.db, p.id), s = readSnowfieldState(saved.snowfield, this.ctx.now()); need(s.ticket && Date.parse(s.ticket.expiresAt) > this.ctx.now().getTime(), "雪场票已到期。"); });
    need(this.online(p, c) && this.free(p) && this.ready(), "雪场会话已变化。");
    if (!existing) { need(this.members.size < 20 && isChristmasWalkable(500, 500), "雪场已满或出生点不可用。"); const m: Member = { p, c, position: { x: 500, y: 500 }, route: [], movedAt: this.ctx.now().getTime(), state: 0 }; this.members.set(p.id, m); this.ctx.rooms.waitingRemove(p); this.changed(); this.broadcast(this.playersPacket([m]), p); }
    if (this.reservations.get(p.id)?.c === c) { this.reservations.delete(p.id); this.changed(); }
    this.send(p, this.playersPacket([...this.members.values()])); this.send(p, this.monsterPacket());
  }
  private rejectMovement(c: GameClient, p: GamePlayer, error: unknown): never {
    if (error instanceof ChristmasError || error instanceof ProtocolRangeError) {
      const m = this.members.get(p.id);
      if (this.online(p, c) && this.ready() && m?.p === p && m.c === c && m.state === 0 && !p.currentRoom && !this.leases.has(p) && !this.creating.has(p)) {
        const now = this.ctx.now().getTime(), { position, remaining } = this.trajectory(m, now), end = remaining.at(-1) ?? position;
        this.send(p, this.playersPacket([m], now)); const b = this.packet(21); b.writeInt(p.id); b.writeInt(Math.round(end.x)); b.writeInt(Math.round(end.y)); b.writeString(remaining.flatMap(q => [q.x, q.y]).join(",")); this.send(p, b);
      }
      if (error instanceof ProtocolRangeError) throw new ChristmasError("雪场移动包无效。", 400);
    }
    throw error;
  }
  move(c: GameClient, p: GamePlayer, end: Point, path: string): void {
    try {
    const m = this.members.get(p.id); need(this.online(p, c) && this.ready() && m?.c === c && !p.currentRoom && m.state === 0, "当前不能移动。"); need(path.length > 0 && path.length <= 4096, "雪场路径无效。", 400);
    const values = path.split(",").map(Number); need(values.length >= 2 && values.length <= 256 && values.length % 2 === 0 && values.every(n => Number.isFinite(n) && Math.abs(n) <= 4096), "雪场路径无效。", 400);
    const points: Point[] = []; for (let i = 0; i < values.length; i += 2) points.push({ x: values[i]!, y: values[i + 1]! }); const last = points.at(-1)!;
    need(Math.hypot(last.x - end.x, last.y - end.y) <= 2, "雪场目标与路径不一致。", 400); let from = this.position(m), distance = 0;
    for (const next of points) { need(isChristmasSegmentClear(from, next), "路径经过不可通行区域。"); distance += Math.hypot(next.x - from.x, next.y - from.y); from = next; } need(distance <= 5000, "雪场路径过长。", 400);
    m.position = this.position(m); m.route = points; m.movedAt = this.ctx.now().getTime(); this.changed(); const b = this.packet(21); b.writeInt(p.id); b.writeInt(end.x); b.writeInt(end.y); b.writeString(points.flatMap(q => [q.x, q.y]).join(",")); this.broadcast(b);
    } catch (e) { this.rejectMovement(c, p, e); }
  }
  canCreateRoom(p: RoomMember) { const a = this.admissions.get(p.id), member = this.members.get(p.id), m = a && this.monsters[a.attempt.type];
    return !p.isBot && this.creating.has(p as GamePlayer) && this.ready() && !!a && a.p === p && this.online(a.p, a.c) && this.free(a.p) && member?.p === p && member.c === a.c &&
      a.attempt.sceneEpoch === this.epoch && a.ticketExpiresAt > this.ctx.now().getTime() && Date.parse(a.attempt.handoffUntil) > this.ctx.now().getTime() && m?.attempt === a.attempt.id && m.generation === a.attempt.monsterGeneration &&
      Math.hypot(this.position(member).x - m.position.x, this.position(member).y - m.position.y) <= 150; }
  roomCreated(p: GamePlayer, room: BaseRoom) { const a = this.admissions.get(p.id); need(a && this.creating.has(p) && room.MapId === a.attempt.localPveId, "雪场房间准入已失效。");
    const lease: Lease = { player: p, client: a.c, room, attemptId: a.attempt.id, serverInstance: this.serverInstance, originalMissionId: a.attempt.originalMissionId, localPveId: a.attempt.localPveId,
      actor: a.actor, attempt: a.attempt, prepared: false, acceptedId: null, sealed: false, refund: false, outcome: null, pending: null };
    bindChristmasPveAdmission(room, { player: p, localPveId: lease.localPveId, attemptId: lease.attemptId, serverInstance: this.serverInstance }); this.leases.set(p, lease); this.changed(); }
  async handoffChallenge(c: GameClient, p: GamePlayer, id: number): Promise<void> {
    const a = this.admissions.get(p.id), m = a && this.monsters[a.attempt.type]!;
    need(this.online(p, c) && this.ready() && a?.p === p && a.c === c && m?.id === id && m.attempt === a.attempt.id && m.generation === a.attempt.monsterGeneration, "没有可继续的真实雪场准入。");
    const previous = this.leases.get(p); if (previous && p.currentRoom === previous.room && previous.attemptId === a.attempt.id) { this.send(p, Out.roomCreate(previous.room)); return; }
    need(this.free(p) && Date.parse(a.attempt.handoffUntil) > this.ctx.now().getTime(), "挑战握手已过期或角色不在大厅。");
    await p.withPersistenceLock(async () => { const saved = await christmasOwnerSaved(this.ctx.db.db, p.id), s = readSnowfieldState(saved.snowfield, this.ctx.now());
      need(s.active?.id === a.attempt.id && s.ticket && Date.parse(s.ticket.expiresAt) > this.ctx.now().getTime(), "挑战票或准入已失效。"); });
    const member = this.members.get(p.id);
    need(this.online(p, c) && member?.p === p && member.c === c && this.free(p) && a.attempt.sceneEpoch === this.epoch && Math.hypot(this.position(member).x - m.position.x, this.position(member).y - m.position.y) <= 150, "请保持在原雪人附近继续挑战。");
    this.creating.add(p); try { const room = await this.ctx.rooms.createSnowfieldRoom(p, a.attempt.localPveId); if (!room) await this.abortAdmission(p, true); }
    finally { this.creating.delete(p); }
  }
  checkRoom(room: BaseRoom, players: readonly RoomMember[], setup?: SnowfieldSetup, forStart = false): SnowfieldPermit {
    const p = players[0] as GamePlayer | undefined, lease = p && this.leases.get(p), permit = readChristmasPveAdmission(room);
    if (!this.ready() || !p || players.length !== 1 || p.isBot || p.isViewer || !lease || lease.sealed || forStart && !lease.prepared || lease.room !== room || lease.player.currentRoom !== room || room.host !== p || room.RoomType !== 40 || room.MapId !== lease.localPveId || !this.online(p, lease.client) || !permit || permit.attemptId !== lease.attemptId ||
      setup && (setup.roomType !== 40 || setup.mapId !== lease.localPveId || setup.originalMissionId !== lease.originalMissionId || setup.hardLevel !== 0 || setup.timeMode !== 3 || setup.levelLimits !== 0 || setup.isCrosszone || setup.isOpenBoss || setup.name !== "" || setup.password !== "")) return { ok: false, message: "雪场房间或服务器准入已失效。" };
    return { ok: true, lease };
  }
  async prepareStart(c: GameClient, p: GamePlayer, room: BaseRoom): Promise<SnowfieldPermit> {
    const checked = this.checkRoom(room, room.getPlayers()); if (!checked.ok) return checked; const lease = checked.lease as Lease;
    if (lease.prepared || lease.acceptedId !== null || lease.client !== c) return { ok: false, message: "挑战已经开始或会话变化。" };
    await p.withPersistenceLock(() => this.ctx.db.db.transaction(async tx => {
      const db = tx as unknown as Database, now = this.ctx.now(), w = await christmasOwnerWallet(db, p.id, true); await christmasOwnerAuth(db, { actor: lease.actor, characterId: p.id }, now, true);
      need(this.checkRoom(room, room.getPlayers()).ok && Date.parse(lease.attempt.handoffUntil) > now.getTime(), "雪场启动许可已失效。"); const saved = await christmasOwnerSaved(db, p.id), s = readSnowfieldState(saved.snowfield, now);
      need(s.active?.id === lease.attemptId && s.active.status === "admitted" && !s.active.launchIntentAt, "雪场挑战不能重复启动。");
      s.active.status = "launching"; s.active.roomId = room.RoomId; s.active.launchIntentAt = now.toISOString();
      await this.save(db, p.id, s); await db.update(app.ActivityWallet).set({ Revision: Math.min(MAX, w.Revision + 1) }).where(eq(app.ActivityWallet.UserID, p.id));
      await db.insert(app.ActivityActions).values({ UserID: p.id, RequestID: s.active.launchRequestId, Signature: digest({ activityId: SNOWFIELD_STATE_ID, kind: "launch", attempt: lease.attemptId }).digest("hex"), Result: { message: "雪场启动意图已持久化。", mailedCount: 0 } });
      lease.attempt = s.active;
    })); lease.prepared = true; this.changed(); return { ok: true, lease };
  }
  fightAccepted(value: SnowfieldLease, game: FightGame) { const l = value as Lease; if (l.sealed || this.leases.get(l.player) !== l || l.acceptedId !== null) return; l.acceptedId = game.id; l.attempt.status = "fighting"; l.attempt.fightId = game.id; const m = this.monsters[l.attempt.type]!; m.state = 1; this.changed(); this.broadcast(this.monsterPacket(3, m)); }
  fightFinished(value: SnowfieldLease, id: number, won: boolean) { const l = value as Lease; if (l.acceptedId !== id || l.sealed || l.outcome) return; this.outcome(l, won ? "win" : "loss", false); }
  fightStopped(value: SnowfieldLease, id: number | null) { const l = value as Lease; if (l.acceptedId !== id || l.sealed || l.outcome) return; this.outcome(l, "aborted", false); }
  startFailed(value: SnowfieldLease, _why: string) { const l = value as Lease; if (l.acceptedId === null && !l.sealed && !l.outcome) this.outcome(l, "aborted", true); }
  private outcome(l: Lease, outcome: "win" | "loss" | "aborted", refund: boolean) {
    if (l.outcome || l.sealed) return; l.outcome = outcome; l.refund = refund; l.sealed = true; this.changed();
    const work = this.settle(l, outcome, refund); l.pending = work; this.pending.add(work);
    void work.then(() => { this.pending.delete(work); this.failures.delete(l.attemptId); }, e => { this.pending.delete(work); this.failures.set(l.attemptId, e); this.ctx.log.error("snowfield outcome persistence failed", e); });
  }
  private async settle(l: Lease, outcome: "win" | "loss" | "aborted", refund: boolean) {
    const mailed = await l.player.withPersistenceLock(() => this.ctx.db.db.transaction(async tx => {
      const db = tx as unknown as Database, now = this.ctx.now(), w = await christmasOwnerWallet(db, l.player.id, true);
      await db.select().from(member.Accounts).where(eq(member.Accounts.ID, l.actor.accountId)).for("share");
      const [who] = await db.select().from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, l.player.id)).for("update"); need(who, "雪场结算角色不存在。", 503);
      const signature = digest({ activityId: SNOWFIELD_STATE_ID, kind: "settle", attempt: l.attemptId }).digest("hex"), [receipt] = await db.select().from(app.ActivityActions).where(and(eq(app.ActivityActions.UserID, l.player.id), eq(app.ActivityActions.RequestID, l.attempt.settlementRequestId)));
      if (receipt) { need(receipt.Signature === signature, "雪场结算回执冲突。", 503); return 0; }
      const saved = await christmasOwnerSaved(db, l.player.id), state = readSnowfieldState(saved.snowfield, now);
      need(state.active?.id === l.attemptId && state.active.serverInstance === l.serverInstance && state.active.clientId === l.client.id, "雪场结算准入不匹配。", 503);
      need(outcome !== "win" || l.acceptedId !== null && state.active.launchIntentAt && state.active.roomId === l.room.RoomId, "未经实际战斗不能结算胜利。", 503);
      const mailedCount = outcome === "win" ? await this.mail(db, who.UserID, who.NickName!, rewards[l.attempt.type]!, now) : 0;
      if (outcome === "win") state.hasSettledWinToday = true;
      this.terminal(state, state.active, outcome, l.acceptedId, refund && l.acceptedId === null, mailedCount > 0, now); await this.save(db, who.UserID, state);
      await db.update(app.ActivityWallet).set({ Revision: Math.min(MAX, w.Revision + 1) }).where(eq(app.ActivityWallet.UserID, who.UserID));
      await db.insert(app.ActivityActions).values({ UserID: who.UserID, RequestID: l.attempt.settlementRequestId, Signature: signature, Result: { message: outcome === "win" ? "真实雪场胜奖已寄送。" : "雪场挑战已结束。", mailedCount, outcome, fightId: l.acceptedId, quotaReturned: refund && l.acceptedId === null } }); return mailedCount;
    }));
    this.releaseAttempt(l.attempt); revokeChristmasPveAdmission(l.room, l.attemptId);
    if (this.leases.get(l.player) === l) this.leases.delete(l.player);
    const m = this.members.get(l.player.id); if (m?.p === l.player) m.state = 0;
    if (mailed) this.notice(l.player);
  }
  private async abortAdmission(p: GamePlayer, refund: boolean) {
    const a = this.admissions.get(p.id); if (!a) return; const existing = this.leases.get(p); if (existing) { this.startFailed(existing, "服务器无法建立战斗。"); await existing.pending; return; }
    await p.withPersistenceLock(() => this.ctx.db.db.transaction(async tx => { const db = tx as unknown as Database, now = this.ctx.now(), w = await christmasOwnerWallet(db, p.id, true);
      await christmasOwnerAuth(db, { actor: a.actor, characterId: p.id }, now, true); const saved = await christmasOwnerSaved(db, p.id), s = readSnowfieldState(saved.snowfield, now);
      if (s.active?.id !== a.attempt.id) return; this.terminal(s, s.active, "aborted", null, refund, false, now); await this.save(db, p.id, s);
      await db.update(app.ActivityWallet).set({ Revision: Math.min(MAX, w.Revision + 1) }).where(eq(app.ActivityWallet.UserID, p.id));
      await db.insert(app.ActivityActions).values({ UserID: p.id, RequestID: a.attempt.settlementRequestId, Signature: digest({ activityId: SNOWFIELD_STATE_ID, kind: "settle", attempt: a.attempt.id }).digest("hex"), Result: { message: "未启动准入已结束。", mailedCount: 0, quotaReturned: refund } }).onConflictDoNothing();
    })); this.releaseAttempt(a.attempt);
  }
  async leaveScene(c: GameClient, p: GamePlayer): Promise<void> { if (this.members.get(p.id)?.c !== c && this.reservations.get(p.id)?.c !== c) return;
    const l = this.leases.get(p); if (l && !l.outcome) { this.outcome(l, "aborted", false); l.room.game?.removePlayer(p); } else if (!l) await this.abortAdmission(p, false);
    if (l?.pending) await l.pending;
    if (l?.player === p && l.client === c && l.serverInstance === this.serverInstance) {
      const room = l.room;
      // A CREATE response may still be unseen. Release only this settled lease's room, rechecking after the room queue wait.
      this.ctx.rooms.exitRoom(room, p, () => p.currentRoom === room && room.IsUsing && room.RoomType === 40 && room.MapId === l.localPveId && room.host === p &&
        room.getPlayers().length === 1 && room.getPlayers()[0] === p && !this.leases.has(p) && !this.admissions.has(p.id));
    }
    this.removeMember(p); }
  private removeMember(p: GamePlayer) { if (this.members.get(p.id)?.p === p) { this.members.delete(p.id); const b = this.packet(19); b.writeInt(p.id); this.broadcast(b); this.send(p, b); } if (this.reservations.get(p.id)?.p === p) this.reservations.delete(p.id); this.changed(); }
  async revive(c: GameClient, p: GamePlayer): Promise<void> { const m = this.members.get(p.id); need(this.online(p, c) && m?.c === c && !p.currentRoom && !this.leases.has(p), "当前不能在雪场复活。"); m.position = { x: 500, y: 500 }; m.route = []; m.state = 0; this.changed(); const b = this.packet(20); b.writeInt(p.id); b.writeByte(0); b.writeInt(500); b.writeInt(500); this.broadcast(b); }
  async beforeQuit(p: GamePlayer): Promise<void> { const l = this.leases.get(p); if (l) { if (!l.outcome) this.outcome(l, "aborted", false);
    if (this.failures.has(l.attemptId) && l.outcome) { this.failures.delete(l.attemptId); const retry = this.settle(l, l.outcome, l.refund); l.pending = retry; this.pending.add(retry); void retry.then(() => this.pending.delete(retry), e => { this.pending.delete(retry); this.failures.set(l.attemptId, e); }); }
    if (l.pending) await l.pending; } else await this.abortAdmission(p, false); this.removeMember(p); }
  beginShutdown() { this.closing = true; this.changed(); for (const l of this.leases.values()) if (!l.outcome) this.outcome(l, "aborted", false); }
  async drain() { while (this.pending.size) await Promise.all([...this.pending]); if (this.failures.size) throw new Error("雪场结算尚未持久化，不能关闭数据库。"); }
  async handle(p: GamePlayer, c: GameClient, pkt: GSPacket) { try { const sub = pkt.readByte();
    if (sub === 17) { const phase = pkt.readByte(); if (phase === 2) { const point = { x: pkt.readInt(), y: pkt.readInt() }; need(pkt.dataLeft === 0, "雪场入场包无效。", 400); await this.enterScene(c, p, point); } else if (phase === 1 && pkt.dataLeft === 0) await this.leaveScene(c, p); else need(false, "请使用本地活动窗口确认免费票。", 400); }
    else if (sub === 21) { let delegated = false; try { const end = { x: pkt.readInt(), y: pkt.readInt() }, path = pkt.readString(); need(pkt.dataLeft === 0, "雪场移动包无效。", 400); delegated = true; this.move(c, p, end, path); }
      catch (e) { if (delegated) throw e; this.rejectMovement(c, p, e); } }
    else if (sub === 22) { const id = pkt.readInt(); need(pkt.dataLeft === 0, "雪场挑战包无效。", 400); await this.handoffChallenge(c, p, id); }
    else if (sub === 29 && pkt.dataLeft === 0) await this.revive(c, p); else need(false, "原服付款和经济操作未接入，请使用本地活动窗口。", 400);
  } catch (e) { if (e instanceof ChristmasError) p.sendMessage(0, e.message); else throw e; } }
}
const owners = new WeakMap<ServerContext, ChristmasSnowfieldOwner>();
export function christmasSnowfieldOwner(ctx: ServerContext): ChristmasSnowfieldOwner { let o = owners.get(ctx); if (!o) { o = new ChristmasSnowfieldOwner(ctx); owners.set(ctx, o); } return o; }
export function registerChristmasSnowfield(r: HandlerRegistry) { r.player(145, "CHRISTMAS_LOCAL_SCENE", (ctx, p, pkt, c) => christmasSnowfieldOwner(ctx).handle(p, c, pkt), "partial"); }
