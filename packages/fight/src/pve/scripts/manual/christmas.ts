/** Explicit local missions; these do not claim to reproduce missing official Christmas AI. */
import { ABrain, AMissionControl, APVEGameControl, registerScript } from "../runtime.js";
import type { SimpleNpc } from "../../livings.js";

// Explicit local arena; this is not an implementation of the missing original Christmas dungeons.
const LOCAL_MAPS = new Map([[164001, 1201], [164002, 1201], [164003, 1201]]);
export class ChristmasLocalGame extends APVEGameControl {
  override OnCreated(): void {
    if (!LOCAL_MAPS.has(this.Game.info.ID)) throw new Error("Unknown local Christmas mission");
    this.Game.SetupMissions(String(this.Game.info.ID));
    this.Game.TotalMissionCount = 1;
  }
  override OnPrepated(): void { this.Game.SessionId = 0; }
}

export class ChristmasLocalMission extends AMissionControl {
  private npc: SimpleNpc | null = null;
  override OnPrepareNewSession(): void {
    const id = this.Game.info.ID, mapId = LOCAL_MAPS.get(id);
    const npc = this.Game.data.npc(id);
    if (!mapId || this.Game.Param1 !== mapId || this.Game.Param2 !== id || !npc || !npc.ModelID || !npc.ResourcesPath) throw new Error("Incomplete local Christmas mission");
    if (!this.Game.SetMap(mapId)) throw new Error(`Missing local Christmas map ${mapId}`);
    // The original arena also has disconnected roof spawns. Keep this local challenge on its real walkable lane.
    // createMap clones terrain; the asset table / other 1201 games keep their original spawn list.
    this.Game.map = this.Game.assets.createMap(mapId, { ...this.Game.map.info, posX: "424,1112", posX1: "424,1112" });
    this.Game.LoadResources([id]);
  }
  override OnStartGame(): void {
    const player = this.Game.GetAllFightPlayers().find((p) => p.isLiving && p.isActive);
    if (!player) throw new Error("Christmas player unavailable");
    const map = this.Game.map;
    const x = Math.min(map.bound.width - 100, player.x + 90);
    const point = map.findYLineNotEmptyPointDown(x, Math.max(0, player.y - 120));
    if ((point.x === 0 && point.y === 0) || map.isOutMap(point.x, point.y)) throw new Error("Christmas NPC spawn has no terrain");
    this.npc = this.Game.CreateNpc(this.Game.info.ID, point.x, point.y, 0, -1, "stand");
    this.npc.maxBeatDis = 70;
  }
  override CanGameOver(): boolean {
    if (!this.Game.GetAllFightPlayers().some((p) => p.isActive && p.isLiving)) { this.Game.IsWin = false; return true; }
    if (this.npc && !this.npc.isLiving && this.Game.TotalKillCount === 1) { this.Game.IsWin = true; return true; }
    if (this.Game.TurnIndex >= 30) { this.Game.IsWin = false; return true; }
    return false;
  }
  override OnGameOver(): void {
    this.Game.IsWin = !!this.npc && !this.npc.isLiving && this.Game.TotalKillCount === 1 && this.Game.GetAllFightPlayers().some((p) => p.isActive && p.isLiving);
  }
  override UpdateUIData(): number { return this.Game.TotalKillCount; }
}

export class ChristmasLocalMelee extends ABrain {
  override OnStartAttacking(): void {
    const body = this.Body as SimpleNpc;
    // Living0012 has no beatA. It is intentionally a passive training target.
    if (body.npcInfo.ID === 164001) return;
    if (body.npcInfo.ID !== 164002 && body.npcInfo.ID !== 164003) throw new Error("Unknown Christmas melee NPC");
    const target = this.Game.FindNearestPlayer(body.x, body.y);
    if (!target) return;
    if (body.Beat(target, "beatA", 0, 0, 0)) return;
    const direction = target.x > body.x ? 1 : -1;
    const distance = Math.min(180, Math.max(0, Math.abs(target.x - body.x) - 55));
    if (distance > 0) body.MoveTo(body.x + direction * distance, body.y, "walk", 0, () => body.Beat(target, "beatA", 0, 0, 0));
  }
}

registerScript("Workshop.Christmas.LocalGame", ChristmasLocalGame, "game", "manual");
registerScript("Workshop.Christmas.LocalMission", ChristmasLocalMission, "mission", "manual");
registerScript("Workshop.Christmas.LocalMelee", ChristmasLocalMelee, "brain", "manual");
