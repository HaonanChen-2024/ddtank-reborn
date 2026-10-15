/** Server-owned local snowfield challenges. No seed mutation, admission payment or activity award here. */
import { scriptInfo, type FightAssets, type MissionInfo, type NpcInfo, type PveData, type PveInfo } from "@ddt/fight";
import type { StartPveOptions } from "../fight/types.js";
import type { RoomMember } from "./player.js";
import type { BaseRoom } from "../rooms/room.js";

export type ChristmasPveId = 164001 | 164002 | 164003;
export interface ChristmasPveDefinition {
  readonly type: 0 | 1 | 2;
  readonly localPveId: ChristmasPveId;
  readonly originalMissionId: 40001 | 40002 | 40003;
  readonly mapId: 1201;
  readonly modelId: string;
  readonly resourcePath: string;
  readonly resourceSha256: string;
  readonly hp: number;
  readonly meleeDamage: number;
}
export const CHRISTMAS_PVE_DEFINITIONS: readonly ChristmasPveDefinition[] = Object.freeze([
  Object.freeze({ type: 0, localPveId: 164001, originalMissionId: 40001, mapId: 1201, modelId: "game.living.Living0012", resourcePath: "image/scene/christmas/workshop/living1.swf", resourceSha256: "9c9e7eafaee578e46dc63298f2785ae816c1fcff05ea8f2282b699b7f3e491aa", hp: 300, meleeDamage: 0 }),
  Object.freeze({ type: 1, localPveId: 164002, originalMissionId: 40002, mapId: 1201, modelId: "game.living.Living0014", resourcePath: "image/scene/christmas/workshop/living3.swf", resourceSha256: "e9cdca0cc0c17f5bab4419c021474a79ddeda69d78c9a56528014364a475acf1", hp: 600, meleeDamage: 30 }),
  Object.freeze({ type: 2, localPveId: 164003, originalMissionId: 40003, mapId: 1201, modelId: "game.living.Living0013", resourcePath: "image/scene/christmas/workshop/living2.swf", resourceSha256: "ab0500a1ef30d464612f68bf366b0c5a92b32572c138a8ecac154315046ef5b9", hp: 900, meleeDamage: 45 }),
]);
export function christmasPveDefinition(id: number): ChristmasPveDefinition | undefined {
  return CHRISTMAS_PVE_DEFINITIONS.find((d) => d.localPveId === id);
}

const GAME_SCRIPT = "Workshop.Christmas.LocalGame", MISSION_SCRIPT = "Workshop.Christmas.LocalMission", BRAIN_SCRIPT = "Workshop.Christmas.LocalMelee";
interface PveLookup {
  data: PveData;
  pveInfo(id: number, roomType: number, levelLimits: number): PveInfo | undefined;
}
/** Wrap lookups only; 40001..3 and every other template retain their existing owner. */
export function createChristmasPveOverlay(base: PveLookup): PveLookup {
  const pves = new Map<number, PveInfo>(), missions = new Map<number, MissionInfo>(), npcs = new Map<number, NpcInfo>();
  for (const d of CHRISTMAS_PVE_DEFINITIONS) {
    pves.set(d.localPveId, Object.freeze({ ID: d.localPveId, Name: `本地雪场挑战${d.type + 1}`, Type: 40, LevelLimits: 0,
      SimpleTemplateIds: String(d.localPveId), SimpleGameScript: GAME_SCRIPT }));
    missions.set(d.localPveId, Object.freeze({ Id: d.localPveId, Name: `本地雪场挑战${d.type + 1}`, TotalCount: 1, TotalTurn: 30,
      Script: MISSION_SCRIPT, Success: "击败雪人", Failure: "角色阵亡、退出或超过30回合", Description: "本地单人挑战；活动奖励另行结算。",
      IncrementDelay: 2000, Delay: 2000, Title: "雪场挑战", Param1: d.mapId, Param2: d.localPveId, TakeCard: 0, TryAgain: false, TryAgainCost: 0 }));
    npcs.set(d.localPveId, Object.freeze({ ID: d.localPveId, Name: d.type === 0 ? "训练雪人" : `雪场雪人${d.type + 1}`, Level: 1, Camp: 2, Type: 0,
      X: -35, Y: -85, Width: 70, Height: 85, Blood: d.hp, MoveMin: 100, MoveMax: 180, BaseDamage: d.meleeDamage, BaseGuard: 0,
      Defence: 0, Agility: 0, Lucky: 0, Attack: 0, ModelID: d.modelId, ResourcesPath: d.resourcePath, Experience: 0, Delay: 2000,
      Immunity: 0, Script: BRAIN_SCRIPT, FireX: 0, FireY: 0, DropId: 0, CurrentBallId: 0 }));
  }
  return {
    data: { npc: (id) => npcs.get(id) ?? base.data.npc(id), mission: (id) => missions.get(id) ?? base.data.mission(id) },
    pveInfo: (id, roomType, levelLimits) => roomType === 40 && pves.has(id) ? pves.get(id) : base.pveInfo(id, roomType, levelLimits),
  };
}

/** Physics-only closure. This does not certify the client GAME_LOAD paths or AVM2. */
export function assertChristmasPveTerrainReady(d: ChristmasPveDefinition, assets: FightAssets): void {
  for (const [name, kind] of [[GAME_SCRIPT, "game"], [MISSION_SCRIPT, "mission"], [BRAIN_SCRIPT, "brain"]] as const) {
    const script = scriptInfo(name);
    if (script?.kind !== kind || script.origin !== "manual") throw new Error(`Christmas script unavailable: ${name}`);
  }
  if (!assets.maps.has(d.mapId)) throw new Error(`Christmas map unavailable: ${d.mapId}`);
  const map = assets.createMap(d.mapId);
  if ((!map.ground && !map.deadTile) || map.bound.width <= 0 || map.bound.height <= 0) throw new Error(`Christmas terrain unavailable: ${d.mapId}`);
  for (const [x, y] of [[424, 1112], [514, 1056]] as const) {
    const at = map.findYLineNotEmptyPointDown(x, y);
    if ((at.x === 0 && at.y === 0) || map.isOutMap(at.x, at.y)) throw new Error(`Christmas spawn unavailable: ${d.mapId}`);
  }
}
/** Exact resources are cached, but the three isolated client paths have not been installed or exercised in AVM2. */
export const CHRISTMAS_PVE_CLIENT_READINESS = Object.freeze({
  ready: false as const,
  required: Object.freeze([...CHRISTMAS_PVE_DEFINITIONS.map((d) => d.resourcePath), "image/map/1201/fore.png", "image/map/1201/back.jpg", "sound/1201.flv"]),
  missing: Object.freeze([...CHRISTMAS_PVE_DEFINITIONS.map((d) => d.resourcePath), "client GAME_LOAD/AVM2 acceptance"]),
});
/** Production must remain closed until client resource installation and loading are independently verified. */
export function assertChristmasPveReady(d: ChristmasPveDefinition, assets: FightAssets): void {
  assertChristmasPveTerrainReady(d, assets);
  if (!CHRISTMAS_PVE_CLIENT_READINESS.ready) throw new Error(`Christmas client unavailable: ${CHRISTMAS_PVE_CLIENT_READINESS.missing.join(", ")}`);
}

export interface ChristmasPveAdmission {
  readonly player: RoomMember;
  readonly localPveId: ChristmasPveId;
  readonly attemptId: string;
  readonly serverInstance: string;
}
interface AdmissionRecord { readonly permit: Readonly<ChristmasPveAdmission>; state: "bound" | "consumed" | "revoked" }
const admissions = new WeakMap<BaseRoom, AdmissionRecord>();
const retired = new WeakMap<BaseRoom, Set<string>>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Only the scene owner calls this AFTER durable admission commits. No production caller until that slice is implemented. */
export function bindChristmasPveAdmission(room: BaseRoom, permit: ChristmasPveAdmission): void {
  if (!christmasPveDefinition(permit.localPveId) || !UUID.test(permit.attemptId) || !UUID.test(permit.serverInstance) || permit.player.isBot || permit.player.isViewer || permit.player.currentRoom !== room || !room.IsUsing || room.RoomType !== 40 || room.MapId !== permit.localPveId || room.HardLevel !== 0 || room.currentFloor !== 0 || room.host !== permit.player || room.getPlayers().length !== 1 || room.getPlayers()[0] !== permit.player) throw new Error("Invalid Christmas admission owner");
  const old = admissions.get(room);
  if (old) {
    const p = old.permit;
    if (p.player === permit.player && p.localPveId === permit.localPveId && p.attemptId === permit.attemptId && p.serverInstance === permit.serverInstance) return;
    if (old.state !== "revoked") throw new Error("Christmas room already has an admission");
  }
  if (retired.get(room)?.has(permit.attemptId)) throw new Error("Christmas admission already consumed or revoked");
  admissions.set(room, { permit: Object.freeze({ ...permit }), state: "bound" });
}
export function readChristmasPveAdmission(room: BaseRoom): Readonly<ChristmasPveAdmission> | null {
  const record = admissions.get(room);
  return record?.state === "bound" ? record.permit : null;
}
export function revokeChristmasPveAdmission(room: BaseRoom, attemptId: string): void {
  const record = admissions.get(room);
  if (record?.permit.attemptId === attemptId) {
    record.state = "revoked";
    let ids = retired.get(room); if (!ids) retired.set(room, (ids = new Set()));
    ids.add(attemptId);
  }
}
/** Check object identity and consume once; forged room IDs, replacement sessions and repeated starts fail closed. */
export function consumeChristmasPveAdmission(s: StartPveOptions): Readonly<ChristmasPveAdmission> | null {
  const player = s.players[0], room = player?.currentRoom;
  if (s.roomType !== 40 || s.players.length !== 1 || !room || player.isBot || player.isViewer || !room.IsUsing || room.RoomType !== 40 || room.RoomId !== s.roomId || room.MapId !== s.pveId || room.HardLevel !== 0 || room.currentFloor !== 0 || room.host !== player || room.getPlayers().length !== 1 || room.getPlayers()[0] !== player || s.hardLevel !== 0 || s.currentFloor !== 0) return null;
  const record = admissions.get(room);
  if (record?.state !== "bound" || record.permit.player !== player || record.permit.localPveId !== s.pveId) return null;
  record.state = "consumed";
  let ids = retired.get(room); if (!ids) retired.set(room, (ids = new Set()));
  ids.add(record.permit.attemptId);
  return record.permit;
}
