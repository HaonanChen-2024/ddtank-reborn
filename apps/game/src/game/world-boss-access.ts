import type { RoomMember } from "./player.js";

export interface WorldBossAccessWindow {
  key: string;
  pveId: number;
  start: Date;
  end: Date;
  blood: number;
  settling: boolean;
}
export type WorldBossPermit = { key: string; error?: never } | { error: string; key?: never };
/** Room actions and all start shortcuts share this owner; a client status byte is never a permit. */
export interface WorldBossRoomAccess {
  check(players: readonly RoomMember[], pveId?: number): WorldBossPermit;
  started(key: string, players: readonly RoomMember[], fightId: number): void;
  finished(key: string, userId: number, fightId: number): void;
}

/** Reference Create.cs:GetTimeDelay. This is a creation interval, not the post-fight delay. */
export function worldBossCreationDelay(fightPower: number): number {
  return fightPower < 1_000_000 ? 45 : fightPower < 2_000_000 ? 120 : fightPower < 4_000_000 ? 180
    : fightPower < 6_000_000 ? 240 : fightPower < 8_000_000 ? 300 : 600;
}

/** Local reconciliation of two reference clocks: successful launch + Create.GetTimeDelay,
 * and real finish/exit + BaseWorldBossRoom.TimeCd (15s). Neither relogin nor scene status clears them.
 * In-memory, scoped to one occurrence; it deliberately does not claim restart persistence. */
export class WorldBossAccess implements WorldBossRoomAccess {
  private key: string | null = null;
  private readonly users = new Map<number, { fightId: number; active: boolean; createUntil: number; returnUntil: number }>();
  constructor(private readonly window: () => WorldBossAccessWindow | null,
    private readonly now: () => number, private readonly isCurrent: (p: RoomMember) => boolean) {}

  clear(): void { this.key = null; this.users.clear(); }

  private current(): WorldBossAccessWindow | null {
    const w = this.window(), now = this.now();
    if (!w || w.settling || now < +w.start || now >= +w.end || w.blood <= 0) { this.clear(); return null; }
    if (this.key !== w.key) { this.clear(); this.key = w.key; }
    return w;
  }

  remaining(userId: number): number {
    if (!this.current()) return 0;
    const u = this.users.get(userId);
    return u ? Math.max(0, Math.ceil((Math.max(u.createUntil, u.returnUntil) - this.now()) / 1000)) : 0;
  }

  check(players: readonly RoomMember[], pveId?: number): WorldBossPermit {
    const w = this.current();
    if (!w) return { error: "世界 BOSS 当前不可挑战。" };
    if (pveId !== undefined && pveId !== w.pveId) return { error: "世界 BOSS 关卡不匹配。" };
    if (!players.length || new Set(players.map((p) => p.id)).size !== players.length) return { error: "世界 BOSS 参战成员无效。" };
    for (const p of players) {
      if (p.isBot || !this.isCurrent(p)) return { error: "世界 BOSS 角色会话已失效。" };
      if (!p.hasMainWeapon) return { error: "请先装备武器再挑战世界 BOSS。" };
      if (!Number.isFinite(p.info.FightPower) || p.info.FightPower < 0) return { error: "世界 BOSS 战斗力数据无效。" };
      if (this.users.get(p.id)?.active || p.currentRoom?.IsPlaying || p.currentRoom?.game) return { error: "请先结束当前战斗再挑战世界 BOSS。" };
      const seconds = this.remaining(p.id);
      if (seconds) return { error: `请等待 ${seconds} 秒后再免费挑战世界 BOSS。` };
    }
    return { key: w.key };
  }

  started(key: string, players: readonly RoomMember[], fightId: number): void {
    if (this.current()?.key !== key) return;
    for (const p of players) this.users.set(p.id, { fightId, active: true,
      createUntil: this.now() + worldBossCreationDelay(p.info.FightPower) * 1000, returnUntil: 0 });
  }

  finished(key: string, userId: number, fightId: number): void {
    if (this.current()?.key !== key) return;
    const u = this.users.get(userId);
    if (!u || !u.active || u.fightId !== fightId) return;
    u.active = false;
    u.returnUntil = this.now() + 15_000;
  }
}
