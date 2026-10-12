/**
 * Hot spring (spa) — codes 187/190/201/202/212/169/12/191/175. Ports Managers/HotSpringMgr.cs, HotSpringRooms/HotSpringRoom.cs,
 * Packets/Client/HotSpring*.cs, TankHandle/TargetPointCmd.cs and GameUtils/PlayerExtra.HotSpringCheck.
 *
 * Fixes vs the original:
 *  - 191/1 TARGET_POINT moved ANY player id the client named; now the server moves only the sender, clamps the target to
 *    the scene and re-serializes the path from validated integers (server-authoritative position).
 *  - 202 took the 10000 gold only after AddPlayer succeeded with no rollback when RemoveGold failed; now gold is checked
 *    and taken before joining.
 *  - 191/4 INVITE had no handler (the 4.1 client has no receiver either): the invitee gets a notice + room number.
 *  - MinHotSpring (60 free minutes/day) is reset on the first entry of a new UTC day and persisted in Sys_Users_Extra.
 */
import { sql } from "drizzle-orm";
import { PacketOut } from "@ddt/protocol";
import type { GamePlayer } from "../game/player.js";
import * as Out from "../packets/out.js";
import type { ServerContext } from "../session/context.js";
import { SubRouter, type HandlerRegistry } from "./registry.js";

export interface SpaRoomInfo {
  roomID: number; roomNumber: number; roomName: string; roomPassword: string | null; effectiveTime: number; playerID: number;
  playerName: string; startTime: Date; roomIntroduction: string; roomType: number; maxCount: number;
}

export const SCENE = { minX: 0, maxX: 2000, minY: 0, maxY: 1200 } as const;
const DEFAULT_POS = { x: 480, y: 560, dir: 3 } as const;

export class SpaRoom {
  readonly players: GamePlayer[] = [];
  constructor(readonly info: SpaRoomInfo) {}
  get count(): number { return this.players.length; }
  send(pkt: PacketOut, except?: GamePlayer): void {
    for (const p of this.players) if (p !== except) p.send(pkt);
  }
}

interface SpaState { x: number; y: number; dir: number; room: SpaRoom | null; timer: NodeJS.Timeout | null; min: number; lastTime: Date }

export class HotSpringMgr {
  readonly rooms = new Map<number, SpaRoom>();
  /** WorldMgr.HotSpringScene: players looking at the room list. */
  readonly scene = new Set<GamePlayer>();
  readonly state = new WeakMap<GamePlayer, SpaState>();
  expTable: number[] = [];
  tickMs = 60_000;
  constructor(private readonly ctx: ServerContext) {}

  async load(): Promise<void> {
    const rows = (await this.ctx.db.db.execute(sql`SELECT * FROM game."HotSpringRoom" ORDER BY "roomID"`)) as unknown;
    const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    for (const r of list) {
      const info: SpaRoomInfo = {
        roomID: Number(r.roomID), roomNumber: Number(r.roomNumber), roomName: String(r.roomName ?? ""), roomPassword: (r.roomPassword as string | null) ?? null,
        effectiveTime: Number(r.effectiveTime ?? 0), playerID: Number(r.playerID ?? 0), playerName: String(r.playerName ?? ""),
        startTime: r.startTime ? new Date(r.startTime as string) : new Date(), roomIntroduction: String(r.roomIntroduction ?? ""),
        roomType: Number(r.roomType ?? 0), maxCount: Number(r.maxCount ?? 10),
      };
      this.rooms.set(info.roomID, new SpaRoom(info));
    }
    this.expTable = String(this.ctx.templates.serverConfig.get("HotSpringExp") ?? "").split(",").map((x) => Number(x) || 0);
  }

  st(p: GamePlayer): SpaState {
    let s = this.state.get(p);
    if (!s) {
      const e = (p.extra ?? {}) as { MinHotSpring?: number; LastTimeHotSpring?: Date; LastFreeTimeHotSpring?: Date };
      s = { ...DEFAULT_POS, room: null, timer: null, min: e.MinHotSpring ?? 60, lastTime: e.LastTimeHotSpring ?? new Date(0) };
      // GamePlayer.CheckNewDay → MinHotSpring = 60 (we do it lazily on the first spa use of a new UTC day)
      const free = e.LastFreeTimeHotSpring ? new Date(e.LastFreeTimeHotSpring) : new Date(0);
      if (free.toISOString().slice(0, 10) !== this.ctx.now().toISOString().slice(0, 10)) s.min = 60;
      this.state.set(p, s);
    }
    return s;
  }

  /** HotSpringMgr.GetExpWithLevel. */
  expWithLevel(grade: number): number {
    return grade >= 1 && grade <= this.expTable.length ? this.expTable[grade - 1]! : 0;
  }

  async saveExtra(p: GamePlayer): Promise<void> {
    const s = this.st(p);
    const now = this.ctx.now();
    await this.ctx.db.db.execute(sql`INSERT INTO player."Sys_Users_Extra" ("UserID", "MinHotSpring", "LastTimeHotSpring", "LastFreeTimeHotSpring") VALUES (${p.id}, ${s.min}, ${s.lastTime}, ${now})
      ON CONFLICT ("UserID") DO UPDATE SET "MinHotSpring" = EXCLUDED."MinHotSpring", "LastTimeHotSpring" = EXCLUDED."LastTimeHotSpring", "LastFreeTimeHotSpring" = EXCLUDED."LastFreeTimeHotSpring"`);
    const e = p.extra as Record<string, unknown> | null;
    if (e) { e.MinHotSpring = s.min; e.LastTimeHotSpring = s.lastTime; e.LastFreeTimeHotSpring = now; }
  }

  roomList(rooms: SpaRoom[]): PacketOut {
    const pk = new PacketOut(197);
    pk.writeInt(rooms.length);
    for (const r of rooms) {
      const i = r.info;
      pk.writeInt(i.roomNumber); pk.writeInt(i.roomID); pk.writeString(i.roomName); pk.writeString(i.roomPassword != null ? "password" : "");
      pk.writeInt(i.effectiveTime); pk.writeInt(r.count); pk.writeInt(i.playerID); pk.writeString(i.playerName);
      Out.wd(pk, i.startTime); pk.writeString(i.roomIntroduction); pk.writeInt(i.roomType); pk.writeInt(i.maxCount);
    }
    return pk;
  }
  /** HotSpringMgr.SendUpdateAllRoom(null, rooms) → HotSpringScene.SendToALL. */
  broadcastRooms(rooms: SpaRoom[]): void {
    const pk = this.roomList(rooms);
    for (const p of this.scene) p.send(pk);
  }

  playerInfo(p: GamePlayer): PacketOut {
    const s = this.st(p);
    const c = p.info;
    const pk = new PacketOut(198, p.id);
    pk.writeInt(p.id); pk.writeInt(c.Grade); pk.writeInt(c.Hide); pk.writeInt(c.Repute); pk.writeString(c.NickName ?? "");
    pk.writeByte(c.typeVIP ?? 0); pk.writeInt(c.VIPLevel ?? 0); pk.writeBoolean(!!c.Sex); pk.writeString(c.Style ?? ""); pk.writeString(c.Colors ?? "");
    pk.writeString(c.Skin ?? ""); pk.writeInt(s.x); pk.writeInt(s.y); pk.writeInt(c.FightPower); pk.writeInt(c.Win); pk.writeInt(c.Total); pk.writeInt(s.dir);
    return pk;
  }

  /** AbstractPacketLib.SendEnterHotSpringRoom (202). */
  enterPacket(p: GamePlayer, r: SpaRoom): PacketOut {
    const s = this.st(p);
    const i = r.info;
    const pk = new PacketOut(202, p.id);
    pk.writeInt(i.roomID); pk.writeInt(i.roomNumber); pk.writeString(i.roomName); pk.writeString(i.roomPassword ?? "");
    pk.writeInt(i.effectiveTime); pk.writeInt(r.count); pk.writeInt(i.playerID); pk.writeString(i.playerName);
    Out.wd(pk, i.startTime); pk.writeString(i.roomIntroduction); pk.writeInt(i.roomType); pk.writeInt(i.maxCount);
    Out.wd(pk, s.lastTime); pk.writeInt(s.min);
    return pk;
  }

  /** HotSpringRoom.AddPlayer. */
  add(p: GamePlayer, r: SpaRoom): boolean {
    const s = this.st(p);
    if (p.currentRoom || s.room) return false;
    if (r.count >= r.info.maxCount) { p.sendMessage(0, "Sala cheia"); return false; }
    if (s.min <= 0) { p.sendMessage(0, "Seu tempo de participação de hoje acabou"); return false; }
    r.players.push(p);
    s.room = r;
    s.lastTime = this.ctx.now();
    Object.assign(s, { x: DEFAULT_POS.x, y: DEFAULT_POS.y, dir: DEFAULT_POS.dir });
    this.scene.delete(p);
    this.startTimer(p);
    void this.saveExtra(p).catch(() => {});
    this.broadcastRooms([r]);
    r.send(this.playerInfo(p), p);
    return true;
  }

  /** HotSpringRoom.RemovePlayer. */
  remove(p: GamePlayer): boolean {
    const s = this.st(p);
    const r = s.room;
    if (!r) return false;
    const i = r.players.indexOf(p);
    if (i >= 0) r.players.splice(i, 1);
    this.stopTimer(p);
    const pk = new PacketOut(199, p.id);
    pk.writeInt(p.id);
    pk.writeString("");
    r.send(pk);
    p.send(pk);
    Object.assign(s, { x: DEFAULT_POS.x, y: DEFAULT_POS.y, dir: DEFAULT_POS.dir, room: null });
    this.broadcastRooms([r]);
    void this.saveExtra(p).catch(() => {});
    return true;
  }

  startTimer(p: GamePlayer): void {
    const s = this.st(p);
    this.stopTimer(p);
    const room = s.room;
    const timer = setInterval(() => {
      // Timers run outside GameClient.chain. Wait for an in-flight reward/save,
      // then reject a tick belonging to a departed room or replaced timer.
      void p.withPersistenceLock(async () => {
        if (s.timer === timer && s.room === room && !p.quitting && p.isActive) this.tick(p);
      }).catch((error) => this.ctx.log.error("hot spring tick failed", error));
    }, this.tickMs);
    s.timer = timer;
    s.timer.unref?.();
  }
  stopTimer(p: GamePlayer): void {
    const s = this.st(p);
    if (s.timer) clearInterval(s.timer);
    s.timer = null;
  }

  /** PlayerExtra.HotSpringCheck: every minute −1 free minute, GP = HotSpringExp[grade]/10 × VIP factor, +50 honor/10 bound Xu/50 gold. */
  tick(p: GamePlayer): number {
    const s = this.st(p);
    if (!s.room) { this.stopTimer(p); return 0; }
    if (s.min <= 0) {
      p.sendMessage(0, "Seu tempo nas Termas acabou.");
      this.remove(p);
      return 0;
    }
    let gp = Math.trunc(this.expWithLevel(p.info.Grade) / 10);
    if (gp <= 0) return 0;
    s.min--;
    if (s.min <= 5) p.sendMessage(0, `Restam apenas ${s.min} minuto(s).`);
    const vip = p.info.VIPLevel ?? 0;
    const mul = vip >= 8 ? 4 : vip > 5 ? 3 : vip >= 3 ? 2 : 1;
    gp *= mul;
    const honor = 50, giftToken = 10, gold = 50;
    p.addHonor(honor);
    p.addGiftToken(giftToken);
    p.addGold(gold);
    p.addGP(gp, false);
    p.sendMessage(0, vip >= 3
      ? `VIP [${vip}]: você recebe x${mul} de experiência. Você recebeu ${gp} de experiência, ${honor} de honra, ${giftToken} Cupons vinculados e ${gold} de ouro!`
      : `Você recebeu ${gp} de experiência, ${honor} de honra, ${giftToken} Cupons vinculados e ${gold} de ouro!`);
    const pk = new PacketOut(191, p.id);
    pk.writeByte(7);
    pk.writeInt(s.min);
    pk.writeInt(gp);
    p.send(pk);
    void this.saveExtra(p).catch(() => {});
    return gp;
  }
}

const mgrs = new WeakMap<ServerContext, Promise<HotSpringMgr>>();
export function hotSpringMgr(ctx: ServerContext): Promise<HotSpringMgr> {
  let m = mgrs.get(ctx);
  if (!m) {
    const x = new HotSpringMgr(ctx);
    m = x.load().then(() => x);
    mgrs.set(ctx, m);
  }
  return m;
}

/** Parses the client walk path "x1,y1,x2,y2…" into validated integers (max 100 points, clamped to the scene). */
export function sanitizePath(path: string): number[] {
  const nums = String(path).split(",").slice(0, 200).map((v) => Math.trunc(Number(v)));
  if (nums.length % 2 === 1) nums.pop();
  const out: number[] = [];
  for (let i = 0; i < nums.length; i += 2) {
    const x = nums[i]!, y = nums[i + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    out.push(Math.min(SCENE.maxX, Math.max(SCENE.minX, x)), Math.min(SCENE.maxY, Math.max(SCENE.minY, y)));
  }
  return out;
}

export function hotSpringCmdRouter(): SubRouter {
  return new SubRouter("byte", "HOTSPRING_CMD")
    .on(1, "TARGET_POINT", async (ctx, p, pkt) => {
      const m = await hotSpringMgr(ctx);
      const s = m.st(p);
      if (!s.room) return;
      const path = sanitizePath(pkt.readString());
      pkt.readInt(); // client-named player id: ignored, only the sender moves
      let x = pkt.readInt();
      let y = pkt.readInt();
      pkt.readInt();
      const dir = pkt.readInt();
      if (path.length >= 2) { x = path[path.length - 2]!; y = path[path.length - 1]!; }
      s.x = Math.min(SCENE.maxX, Math.max(SCENE.minX, x));
      s.y = Math.min(SCENE.maxY, Math.max(SCENE.minY, y));
      s.dir = dir >= 1 && dir <= 8 ? dir : s.dir;
      const out = new PacketOut(191, p.id);
      out.writeByte(1);
      out.writeString(path.join(","));
      out.writeInt(p.id);
      out.writeInt(s.x);
      out.writeInt(s.y);
      s.room.send(out, p);
    })
    .on(3, "HOTSPRING_ROOM_RENEWAL_FEE", (_ctx, _p, pkt) => { pkt.readInt(); }, "stub")
    .on(4, "HOTSPRING_ROOM_INVITE", async (ctx, p, pkt) => {
      const id = pkt.readInt();
      const m = await hotSpringMgr(ctx);
      const r = m.st(p).room;
      const o = ctx.world.get(id);
      if (!r || !o) return p.sendMessage(0, ctx.lang.t("FriendAddHandler.Ofline"));
      o.sendMessage(0, `[${p.info.NickName}] convidou você para a Fonte Termal — sala ${r.info.roomNumber} (${r.info.roomName}).`);
      p.sendMessage(0, `Convite enviado para [${o.info.NickName}].`);
    })
    .on(6, "HOTSPRING_ROOM_EDIT", () => {}, "stub")
    .on(9, "HOTSPRING_ROOM_ADMIN_REMOVE_PLAYER", () => {}, "stub")
    .on(10, "HOTSPRING_ROOM_PLAYER_CONTINUE", () => {}, "stub");
}

export async function hotSpringOnQuit(ctx: ServerContext, p: GamePlayer): Promise<void> {
  const m = mgrs.get(ctx);
  if (!m) return;
  const x = await m;
  x.remove(p);
  x.scene.delete(p);
}

export function registerHotSpring(r: HandlerRegistry): SubRouter {
  // 187 HOTSPRING_ENTER: join the scene, room list
  r.player(187, "HOTSPRING_ENTER", async (ctx, p) => {
    const m = await hotSpringMgr(ctx);
    m.scene.add(p);
    p.send(m.roomList([...m.rooms.values()]));
  });
  // 202 HOTSPRING_ROOM_ENTER: int roomId, str pwd; 10000 gold
  r.player(202, "HOTSPRING_ROOM_ENTER", async (ctx, p, pkt) => {
    const id = pkt.readInt();
    pkt.readString();
    const m = await hotSpringMgr(ctx);
    if (m.st(p).room) return;
    const room = m.rooms.get(id);
    if (!room) return p.sendMessage(0, ctx.lang.t("SpaRoomLoginHandler.Failed4"));
    const need = 10000;
    if (p.info.Gold < need) return p.sendMessage(0, ctx.lang.t("HotSpringRoomEnterDataHandler.NotEmoughtGold"));
    if (!m.add(p, room)) return;
    p.removeGold(need);
    p.send(m.enterPacket(p, room));
  });
  // 190 HOTSPRING_ROOM_QUICK_ENTER: random non-full room, free (fixed: the original indexed Next(0, 4) into a shorter list)
  r.player(190, "HOTSPRING_ROOM_QUICK_ENTER", async (ctx, p) => {
    const m = await hotSpringMgr(ctx);
    if (m.st(p).room) return p.sendMessage(0, ctx.lang.t("SpaRoomLoginHandler.Failed"));
    const free = [...m.rooms.values()].filter((r) => r.count < r.info.maxCount);
    const room = free[Math.floor(Math.random() * Math.min(4, free.length))];
    if (!room) return p.sendMessage(0, ctx.lang.t("SpaRoomLoginHandler.Failed4"));
    if (m.add(p, room)) p.send(m.enterPacket(p, room));
  });
  // 212 HOTSPRING_ROOM_ENTER_CONFIRM
  r.player(212, "HOTSPRING_ROOM_ENTER_CONFIRM", async (ctx, p, pkt) => {
    const id = pkt.readInt();
    const m = await hotSpringMgr(ctx);
    if (m.st(p).room) return;
    if (!m.rooms.has(id)) return p.sendMessage(0, ctx.lang.t("SpaRoomLoginHandler.Failed4"));
    const pk = new PacketOut(212);
    pk.writeInt(id);
    p.send(pk);
  });
  // 201 HOTSPRING_ROOM_ENTER_VIEW: every player of the room as 198
  r.player(201, "HOTSPRING_ROOM_ENTER_VIEW", async (ctx, p) => {
    const m = await hotSpringMgr(ctx);
    const room = m.st(p).room;
    if (!room) return;
    for (const o of room.players) p.send(m.playerInfo(o));
  });
  // 169 HOTSPRING_ROOM_PLAYER_REMOVE
  r.player(169, "HOTSPRING_ROOM_PLAYER_REMOVE", async (ctx, p) => {
    const m = await hotSpringMgr(ctx);
    if (!m.remove(p)) return;
    const pk = new PacketOut(169);
    pk.writeString("Você saiu das Termas!");
    p.send(pk);
  });
  // 12 HOTSPRING_CMD_B: byte 11 = buy SpaPriRoomContinueTime minutes for SpaAddictionMoneyNeeded Xu
  r.player(12, "HOTSPRING_CMD_B", async (ctx, p, pkt) => {
    if (pkt.readByte() !== 11) return;
    const price = ctx.templates.cfgInt("SpaAddictionMoneyNeeded", 1299);
    if (p.info.Money < price) return p.sendMessage(0, "Seus Cupons não são suficientes.");
    const mins = ctx.templates.cfgInt("SpaPriRoomContinueTime", 30);
    const m = await hotSpringMgr(ctx);
    p.info.Money -= price;
    p.updateProperties();
    m.st(p).min += mins;
    await m.saveExtra(p);
    const pk = new PacketOut(191);
    pk.writeByte(12);
    p.send(pk);
    p.sendMessage(0, `Renovado com sucesso! Foram descontados ${price} Cupons e você ganhou mais ${mins} minuto(s)`);
  });
  r.player(175, "HOTSPRING_ROOM_CREATE", () => {}, "stub");
  const cmd = hotSpringCmdRouter();
  r.player(191, "HOTSPRING_CMD", async (ctx, p, pkt, client) => {
    const m = await hotSpringMgr(ctx);
    if (!m.st(p).room) return;
    await cmd.handler(ctx, p, pkt, client);
  });
  return cmd;
}
