/**
 * RoomMgr + BaseWaitingRoom + room IActions (Game.Server/Rooms/*.cs). Actions are queued and executed in order on a
 * 40 ms tick (RoomMgr.THREAD_INTERVAL); empty rooms are stopped every 400 ms (CLEAR_ROOM_INTERVAL).
 * Match rooms (type 0) go to the auto-match queue (replaces BattleMgr.AddRoom -> Fighting.Server matchmaking).
 */
import * as Out from "../packets/out.js";
import { PlayerState, type RoomMember } from "../game/player.js";
import type { FightEngine } from "../fight/types.js";
import type { BotProvider, VirtualPlayer } from "../bots/bot.js";
import { BaseRoom, RoomType } from "./room.js";
import type { WorldBossRoomAccess } from "../game/world-boss-access.js";
import type { ChristmasSnowfieldRoomAccess, SnowfieldLease } from "../game/activity-christmas-snowfield.js";
import type { GamePlayer } from "../game/player.js";

export interface RoomMgrOptions {
  maxRooms: number;
  fight: FightEngine;
  lang: (id: string, ...a: unknown[]) => string;
  bots?: BotProvider;
  /** Seconds before an unmatched Match room is paired with bots (if a provider exists). */
  botFallbackSec?: number;
  random?: () => number;
  worldBossAccess?: WorldBossRoomAccess;
  christmasSnowfield?: ChristmasSnowfieldRoomAccess;
}

type Action = () => void;

export class RoomMgr {
  readonly rooms: BaseRoom[];
  /** BaseWaitingRoom.m_list (players in the lobby scene). */
  readonly waiting = new Map<number, RoomMember>();
  private queue: Action[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastClear = 0;
  private matchQueue: { room: BaseRoom; since: number }[] = [];
  private bossAwardStarts = new Set<BaseRoom>();
  private stopped = false;
  private readonly snowfieldCreates = new Set<() => void>();
  private readonly rnd: () => number;

  constructor(private readonly o: RoomMgrOptions) {
    this.rnd = o.random ?? Math.random;
    const env = { onRoomChanged: (r: BaseRoom) => this.sendUpdateCurrentRoom(r), lang: o.lang };
    this.rooms = Array.from({ length: Math.max(1, o.maxRooms) }, (_, i) => new BaseRoom(i + 1, env));
  }

  start(): void {
    this.stopped = false;
    if (!this.timer) this.timer = setInterval(() => this.tick(), 40);
  }

  stop(): void {
    this.stopped = true;
    for (const cancel of this.snowfieldCreates) cancel();
    this.snowfieldCreates.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** RoomMgr.AddAction. */
  addAction(a: Action): void {
    this.queue.push(a);
  }

  private addRoomEntry(p: RoomMember, action: Action, skipped?: () => void): void {
    this.addAction(() => {
      if (!p.runRoomEntry) return action(); // Bots retain the synchronous path.
      let ran = false;
      const pending = p.runRoomEntry(() => { ran = true; try { action(); } catch (err) { skipped?.(); throw err; } });
      if (pending) void pending.then(() => { if (!ran) skipped?.(); }, err => { skipped?.(); console.error("RoomMgr entry action error", err); });
      else if (!ran) skipped?.();
    });
  }

  /** One RoomThread iteration (also used by tests). */
  tick(now = Date.now()): number {
    let n = 0;
    while (this.queue.length) {
      const batch = this.queue;
      this.queue = [];
      for (const a of batch) {
        n++;
        try {
          a();
        } catch (err) {
          console.error("RoomMgr action error", err);
        }
      }
    }
    if (now - this.lastClear >= 400) {
      this.lastClear = now;
      for (const r of this.rooms) if (r.IsUsing && r.PlayerCount === 0 && r.viewerCnt === 0) r.stop();
      this.processMatchQueue(now);
    }
    return n;
  }

  // ------------------------------------------------------------------ lists
  getAllRooms(): BaseRoom[] {
    return this.rooms.filter((r) => !r.IsEmpty);
  }
  getAllMatchRooms(): BaseRoom[] {
    return this.rooms.filter((r) => r.IsUsing && (r.RoomType === RoomType.Match || r.RoomType === RoomType.Freedom));
  }
  getAllPveRooms(): BaseRoom[] {
    return this.rooms.filter((r) => r.IsUsing && (r.RoomType === RoomType.Dungeon || r.RoomType === RoomType.Academy || r.RoomType === RoomType.Boss));
  }
  usingRooms(): BaseRoom[] {
    return this.rooms.filter((r) => r.IsUsing);
  }

  // ------------------------------------------------------------------ waiting room (BaseWaitingRoom.cs)
  private sendToWaiting(pkt: Parameters<RoomMember["send"]>[0], except?: RoomMember): void {
    for (const p of this.waiting.values()) if (p !== except) p.send(pkt);
  }

  waitingAdd(p: RoomMember): boolean {
    if (this.waiting.has(p.id)) return false;
    this.waiting.set(p.id, p);
    const pkt = Out.sceneAddPlayer(p.info);
    p.send(pkt);
    this.sendToWaiting(pkt, p);
    return true;
  }

  waitingRemove(p: RoomMember): void {
    if (this.waiting.delete(p.id)) {
      const pkt = Out.sceneRemovePlayer(p.id);
      p.send(pkt);
      this.sendToWaiting(pkt, p);
    }
  }

  /** BaseWaitingRoom.SendUpdateRoom(player). */
  sendRoomListTo(p: RoomMember): void {
    p.send(Out.roomList(p.playerState === PlayerState.Away ? this.getAllPveRooms() : this.getAllMatchRooms()));
  }

  /** BaseWaitingRoom.SendUpdateRoom(room): lobby players get the PvP or PvE list by their state. */
  sendUpdateRoom(): void {
    const pvp: BaseRoom[] = [];
    const pve: BaseRoom[] = [];
    for (const r of this.getAllRooms()) {
      if (r.RoomType === RoomType.Freedom || r.RoomType === RoomType.Match) pvp.push(r);
      if (r.RoomType === RoomType.Dungeon || r.RoomType === 18 || r.RoomType === 21 || r.RoomType === 23) pve.push(r);
    }
    const a = Out.roomList(pvp);
    const b = Out.roomList(pve);
    for (const p of this.waiting.values()) {
      if (p.playerState === PlayerState.Online) p.send(a);
      else if (p.playerState === PlayerState.Away) p.send(b);
    }
  }

  /** BaseWaitingRoom.SendUpdateCurrentRoom: room members get [own room + list]. */
  sendUpdateCurrentRoom(room: BaseRoom): void {
    const list = [room, ...(room.host?.playerState === PlayerState.Away ? this.getAllPveRooms() : this.getAllMatchRooms())];
    const pkt = Out.roomList(list);
    for (const p of room.getPlayers()) p.send(pkt);
  }

  // ------------------------------------------------------------------ actions
  /** EnterWaitingRoomAction. */
  enterWaitingRoom(p: RoomMember): void {
    this.addAction(() => {
      if (p.currentRoom?.RoomType === 40) return;
      p.currentRoom?.removePlayer(p);
      if (this.waitingAdd(p)) {
        p.send(Out.roomList(this.getAllRooms()));
        for (const o of this.waiting.values()) if (o !== p) p.send(Out.sceneAddPlayer(o.info));
      } else {
        this.sendRoomListTo(p);
        const pkt = Out.sceneAddPlayer(p.info);
        p.send(pkt);
        this.sendToWaiting(pkt, p);
        for (const o of this.waiting.values()) if (o !== p) p.send(Out.sceneAddPlayer(o.info));
      }
    });
  }

  exitWaitingRoom(p: RoomMember): void {
    this.addAction(() => this.waitingRemove(p));
  }

  /** CreateRoomAction (Rooms/CreateRoomAction.cs). */
  createRoom(p: RoomMember, name: string, password: string, roomType: number, timeType: number,
    completed?: (room: BaseRoom | null) => void, snowfieldPveId?: number): void {
    this.addRoomEntry(p, () => {
      if (p.currentRoom?.RoomType === 40) { completed?.(null); return; }
      if (roomType === 40 && (this.stopped || !snowfieldPveId || !this.o.christmasSnowfield?.canCreateRoom(p))) { completed?.(null); return; }
      if (roomType === 14) {
        const permit = this.o.worldBossAccess?.check([p]);
        if (!permit || permit.error) { p.sendMessage(0, permit?.error ?? "世界 BOSS 当前不可挑战。"); return; }
      }
      p.currentRoom?.removePlayer(p);
      let room: BaseRoom | null = null;
      let idx = Math.floor(this.rnd() * this.rooms.length);
      for (let i = 0; i < this.rooms.length; i++) {
        if (!this.rooms[idx]!.IsUsing) {
          room = this.rooms[idx]!;
          break;
        }
        idx = Math.floor(this.rnd() * this.rooms.length);
      }
      room ??= this.rooms.find((r) => !r.IsUsing) ?? null; // C# gives up after N random probes; we fall back to a scan
      if (!room) {
        p.sendMessage(1, this.o.lang("CreateRoomAction.MaxRoom"));
        completed?.(null);
        return;
      }
      this.waitingRemove(p);
      room.start();
      if (roomType === RoomType.Dungeon) {
        room.HardLevel = 1;
        room.LevelLimits = BaseRoom.levelLimit(p.info.Grade);
        room.maxViewerCnt = 1;
      }
      room.updateRoom(name, password, roomType, timeType, 0);
      if (roomType === 40) { room.MapId = snowfieldPveId!; room.HardLevel = 0; room.LevelLimits = 0; room.maxViewerCnt = 0; }
      p.send(Out.roomCreate(room));
      room.addPlayer(p);
      if (roomType === 40) {
        try { this.o.christmasSnowfield!.roomCreated(p as GamePlayer, room); }
        catch { room.removePlayer(p); room.stop(); completed?.(null); return; }
      }
      this.sendUpdateCurrentRoom(room);
      this.sendUpdateRoom();
      completed?.(room);
    }, () => completed?.(null));
  }

  /** Only the server-owned committed handoff may request this controlled room. */
  createSnowfieldRoom(p: GamePlayer, localPveId: number): Promise<BaseRoom | null> {
    if (this.stopped) return Promise.resolve(null);
    return new Promise(resolve => {
      const cancel = () => { this.snowfieldCreates.delete(cancel); resolve(null); };
      this.snowfieldCreates.add(cancel);
      this.createRoom(p, "", "", 40, 3, room => { this.snowfieldCreates.delete(cancel); resolve(room); }, localPveId);
    });
  }

  /** GameRoom/Handle/Login.cs (runs inline in the original, here queued to keep room ordering). */
  enterRoom(p: RoomMember, roomId: number, pwd: string, hallType: number): void {
    this.addRoomEntry(p, () => {
      if (p.currentRoom?.RoomType === 40) return;
      const fail = (key?: string) => {
        if (key) p.sendMessage(1, this.o.lang(key));
        p.send(Out.roomLoginResult(false));
      };
      if (!p.hasMainWeapon) return fail("Game.Server.SceneGames.NoEquip");
      p.currentRoom?.removePlayer(p);
      let room: BaseRoom | null;
      if (roomId === -1) {
        room = this.rooms.find((r) => r.PlayerCount > 0 && r.canAddPlayer() && !r.NeedPassword && !r.IsPlaying && r.RoomType !== RoomType.Freshman && r.RoomType === hallType) ?? null;
        if (!room) return fail("EnterRoomAction.noroom");
      } else {
        room = roomId > 0 && roomId <= this.rooms.length ? this.rooms[roomId - 1]! : null;
        if (!room) return fail("EnterRoomAction.noexist");
      }
      if (!room.IsUsing) return fail("EnterRoomAction.noexist");
      if (room.RoomType === 40) return fail("EnterRoomAction.noexist");
      if (room.IsPlaying) return fail("EnterRoomAction.start");
      if (room.PlayerCount === room.PlacesCount) {
        if (!room.canAddViewPlayer()) return fail("EnterRoomAction.full");
        this.waitingRemove(p);
        p.send(Out.roomLoginResult(true));
        p.send(Out.roomCreate(room));
        room.addPlayer(p);
        this.sendUpdateCurrentRoom(room);
        p.send(Out.roomSetupChange(room));
        room.updatePlayerState(p, 1, false);
        return;
      }
      if (room.NeedPassword && room.Password !== pwd) return fail(pwd ? "EnterRoomAction.passworderror" : "EnterRoomAction.EnterPassword");
      if (room.RoomType === RoomType.Dungeon && room.LevelLimits > BaseRoom.levelLimit(p.info.Grade)) return fail("EnterRoomAction.level");
      this.waitingRemove(p);
      p.send(Out.roomLoginResult(true));
      p.send(Out.roomCreate(room));
      room.addPlayer(p);
      this.sendRoomListTo(p);
      p.send(Out.roomSetupChange(room));
    });
  }

  /** ExitRoomAction. */
  exitRoom(room: BaseRoom, p: RoomMember, canExit?: () => boolean): void {
    this.addAction(() => {
      if (canExit && !canExit()) return;
      room.removePlayer(p);
      room.sendPlaceState();
      this.sendUpdateCurrentRoom(room);
      if (room.IsEmpty) room.stop();
      this.sendUpdateRoom();
    });
  }

  kickPlayer(room: BaseRoom, place: number): void {
    this.addAction(() => room.removePlayerAt(place));
  }

  switchTeam(p: RoomMember): void {
    this.addAction(() => p.currentRoom?.switchTeam(p));
  }

  updatePlayerState(p: RoomMember, state: number): void {
    const room = p.currentRoom;
    this.addAction(() => {
      if (room && p.currentRoom === room) room.updatePlayerState(p, state, true);
    });
  }

  updateRoomPos(room: BaseRoom, pos: number, isOpened: boolean, place: number, placeView: number): void {
    this.addAction(() => {
      if (room.PlayerCount > 0 && room.updatePos(pos, isOpened, place, placeView)) this.sendUpdateCurrentRoom(room);
    });
  }

  /** RoomSetupChangeAction (subset: map, type, password, name, time mode, hardness, level limit). */
  setupChange(room: BaseRoom, s: { mapId: number; roomType: number; password: string; name: string; timeMode: number; hardLevel: number; levelLimits: number; isCrosszone: boolean; isOpenBoss: boolean }): void {
    const host = room.host;
    this.addAction(() => {
      if (room.RoomType === 40 || s.roomType === 40) {
        const permit = this.o.christmasSnowfield?.checkRoom(room, room.getPlayers(), s);
        if (!permit?.ok) return;
      }
      if (room.RoomType === 14 || s.roomType === 14) {
        if (!room.IsUsing || !host || room.host !== host || host.currentRoom !== room || room.IsPlaying || room.game) return;
        if (s.roomType === 14) {
          const permit = this.o.worldBossAccess?.check(room.getPlayersFight(), s.mapId);
          if (!permit || permit.error) { host.sendMessage(0, permit?.error ?? "世界 BOSS 当前不可挑战。"); return; }
        }
      }
      room.MapId = s.mapId;
      room.RoomType = s.roomType;
      room.Password = s.password;
      room.Name = s.name;
      room.TimeMode = s.timeMode;
      room.HardLevel = s.hardLevel;
      room.LevelLimits = s.levelLimits;
      room.isCrosszone = s.isCrosszone;
      room.isOpenBoss = s.isOpenBoss;
      room.updateRoomGameType();
      room.sendRoomSetupChange();
      this.sendUpdateCurrentRoom(room);
    });
  }

  /** StartGameAction (Rooms/StartGameAction.cs). */
  startGame(room: BaseRoom): void {
    const host = room.host;
    const expected = room.getPlayersFight();
    this.addAction(() => {
      if (room.RoomType === 40) {
        const permit = this.o.christmasSnowfield?.checkRoom(room, room.getPlayers(), undefined, true);
        if (!permit?.ok || room.IsPlaying || room.game) return;
      }
      if (room.RoomType === 14 && (!room.IsUsing || room.IsPlaying || room.game || !host || room.host !== host ||
          host.currentRoom !== room || !expected.length || expected.length !== room.PlayerCount ||
          room.getPlayersFight().some((p, i) => p !== expected[i] || p.currentRoom !== room))) return;
      if (!room.canStart()) return;
      const players = room.getPlayersFight();
      const awards = players.flatMap((p) => p.worldBossAwardPending ? [p.worldBossAwardPending] : []);
      if (awards.length) {
        if (!this.bossAwardStarts.has(room)) {
          this.bossAwardStarts.add(room);
          void Promise.all(awards).then(() => {
            this.bossAwardStarts.delete(room);
            const current = room.getPlayersFight();
            if (room.IsUsing && !room.IsPlaying && (room.RoomType !== 14 || room.host === host) && current.length > 0 && current.length === players.length &&
                current.every((p, i) => p === players[i] && p.currentRoom === room)) this.startGame(room);
          });
        }
        return;
      }
      if (room.RoomType === RoomType.Freedom) {
        const red = players.filter((p) => p.roomTeam === 1);
        const blue = players.filter((p) => p.roomTeam !== 1);
        this.launch([room], red, blue, room.RoomType, room.GameType, room.TimeMode, room.MapId);
      } else if (room.RoomType === RoomType.Match) {
        room.IsPlaying = true;
        room.matching = true;
        room.sendStartPickUp();
        this.matchQueue.push({ room, since: Date.now() });
        this.processMatchQueue(Date.now());
      } else this.launchPve(room, players);
      this.sendUpdateCurrentRoom(room);
    });
  }

  /** GamePickupCancel (GameRoom/Handle/GamePickupCancel.cs). */
  cancelPickup(p: RoomMember): void {
    this.addAction(() => {
      const room = p.currentRoom;
      if (!room) return;
      if (room.matching) {
        this.matchQueue = this.matchQueue.filter((q) => q.room !== room);
        room.matching = false;
        room.IsPlaying = false;
        room.sendCancelPickUp();
        if (p !== room.host) {
          room.host?.sendMessage(3, this.o.lang("Game.Server.SceneGames.PairUp.Failed"));
          room.updatePlayerState(p, 0, true);
        } else room.updatePlayerState(p, 2, true);
      } else room.removePlayer(p);
    });
  }

  /** Auto-match: pairs queued Match rooms with the same player count (Fighting.Server matchmaking). */
  private processMatchQueue(now: number): void {
    this.matchQueue = this.matchQueue.filter((q) => q.room.matching && q.room.IsUsing && q.room.PlayerCount > 0);
    for (let i = 0; i < this.matchQueue.length; i++) {
      const a = this.matchQueue[i]!;
      if (a.room.getPlayersFight().some((p) => p.worldBossAwardPending)) continue;
      // guild rooms (GameStyle 1) only meet another guild (Fighting.Server ProxyRoomMgr: same GuildId never matched)
      const j = this.matchQueue.findIndex((b, k) => k > i && !b.room.getPlayersFight().some((p) => p.worldBossAwardPending) && b.room.PlayerCount === a.room.PlayerCount && b.room.GameType === a.room.GameType && (a.room.GameStyle !== 1 || a.room.host?.info.ConsortiaID !== b.room.host?.info.ConsortiaID));
      if (j !== -1) {
        const b = this.matchQueue[j]!;
        this.matchQueue.splice(j, 1);
        this.matchQueue.splice(i, 1);
        i--;
        this.launch([a.room, b.room], a.room.getPlayersFight(), b.room.getPlayersFight(), RoomType.Match, a.room.GameType, a.room.TimeMode, 0);
        continue;
      }
      const fallback = this.o.botFallbackSec ?? 30;
      if (this.o.bots && now - a.since >= fallback * 1000) {
        const bots = a.room.getPlayersFight().map((p) => this.o.bots!.acquire(p.info.Grade)).filter((x): x is NonNullable<typeof x> => !!x);
        if (bots.length === a.room.PlayerCount) {
          this.matchQueue.splice(i, 1);
          i--;
          this.launch([a.room], a.room.getPlayersFight(), bots, RoomType.Match, a.room.GameType, a.room.TimeMode, 0);
        } else bots.forEach((b) => this.o.bots!.release(b));
      }
    }
  }

  /** StartGameAction PvE branch → GameMgr.StartPVEGame (Rooms/StartGameAction.cs:55-75). */
  private launchPve(room: BaseRoom, players: RoomMember[]): void {
    if (room.RoomType === 40) { this.launchSnowfield(room, players); return; }
    const labyrinth = room.RoomType === 15;
    const access = room.RoomType === 14 ? this.o.worldBossAccess : undefined;
    const permit = room.RoomType === 14 ? access?.check(players, room.MapId) : undefined;
    if (room.RoomType === 14 && (!permit || permit.error)) {
      room.sendMessage(0, permit?.error ?? "世界 BOSS 当前不可挑战。");
      room.sendCancelPickUp();
      return;
    }
    const key = permit?.key;
    let acceptedId: number | null = null;
    let stoppedDuringStart = false;
    const earlyFinished = new Set<number>();
    const finish = (id: number) => {
      if (!key || !players.some((p) => p.id === id)) return;
      if (acceptedId === null) earlyFinished.add(id);
      else access!.finished(key, id, acceptedId);
    };
    const game = this.o.fight.startPve?.({
      roomId: room.RoomId, roomType: room.RoomType, gameType: room.GameType, timeType: room.TimeMode, pveId: room.MapId,
      hardLevel: room.HardLevel, levelLimits: room.LevelLimits, currentFloor: room.currentFloor, players,
      onStopped: () => {
        if (labyrinth) {
          if (acceptedId === null) { stoppedDuringStart = true; return; }
          if (room.game?.id !== acceptedId) return;
        }
        if (key) {
          if (acceptedId === null) { stoppedDuringStart = true; return; }
          for (const p of players) finish(p.id);
          // An old room's late stop must not detach a replacement game.
          if (room.game?.id !== acceptedId) return;
        }
        room.onGameStopped();
      },
      ...(key ? { onParticipantFinished: finish } : {}),
      // PlayerDetail.ResetRoom (GamePlayer.cs): a dungeon room goes back to "choose a dungeon"
      onFinished: () => {
        if (labyrinth && room.game?.id !== acceptedId) return;
        if (room.RoomType === RoomType.Dungeon) {
          room.Pic = "";
          room.MapId = 10000;
          room.currentFloor = 0;
          room.isOpenBoss = false;
          room.sendRoomSetupChange();
        }
      },
    }) ?? null;
    if (!game || stoppedDuringStart) {
      game?.stop();
      room.IsPlaying = false;
      room.sendPlayerState();
      room.sendMessage(3, this.o.lang("StartGameAction.noBattleServe"));
      room.sendCancelPickUp();
      return;
    }
    if (key) {
      acceptedId = game.id;
      access!.started(key, players, game.id);
      for (const id of earlyFinished) finish(id);
    }
    if (labyrinth) acceptedId = game.id;
    room.startGame(game);
  }

  private launchSnowfield(room: BaseRoom, players: RoomMember[]): void {
    const access = this.o.christmasSnowfield, permit = access?.checkRoom(room, players, undefined, true);
    if (!access || !permit?.ok) return;
    const lease: SnowfieldLease = permit.lease;
    let accepted: number | null = null;
    const early: ({ type: "finish"; won: boolean } | { type: "stop" })[] = [];
    const finish = (won: boolean) => { if (accepted === null) early.push({ type: "finish", won }); else access.fightFinished(lease, accepted, won); };
    const stop = () => { if (accepted === null) { early.push({ type: "stop" }); return; } access.fightStopped(lease, accepted); if (room.game?.id === accepted) room.onGameStopped(); };
    let game: ReturnType<NonNullable<FightEngine["startPve"]>> = null;
    try { game = this.o.fight.startPve?.({ roomId: room.RoomId, roomType: 40, gameType: room.GameType, timeType: 3, pveId: room.MapId,
      hardLevel: 0, levelLimits: 0, currentFloor: 0, players, onFinished: finish, onStopped: stop }) ?? null; }
    catch { access.startFailed(lease, "战斗引擎技术故障，尚未开始。"); }
    if (!game) { access.startFailed(lease, "战斗引擎未接受挑战。"); room.IsPlaying = false; room.sendCancelPickUp(); return; }
    accepted = game.id; access.fightAccepted(lease, game);
    if (!early.some(e => e.type === "stop")) room.startGame(game);
    for (const e of early) e.type === "finish" ? finish(e.won) : stop();
  }

  private launch(rooms: BaseRoom[], red: RoomMember[], blue: RoomMember[], roomType: number, gameType: number, timeType: number, mapId: number): void {
    for (const r of rooms) r.matching = false;
    const game = this.o.fight.startPvp({
      roomId: rooms[0]!.RoomId,
      roomType,
      gameType,
      timeType,
      mapId,
      red,
      blue,
      onStopped: () => {
        rooms.forEach((r) => r.onGameStopped());
        for (const m of [...red, ...blue]) if (m.isBot) this.o.bots?.release(m as VirtualPlayer);
      },
    });
    if (!game) {
      for (const r of rooms) {
        r.IsPlaying = false;
        r.sendPlayerState();
        r.sendMessage(3, this.o.lang("StartGameAction.noBattleServe"));
        r.sendCancelPickUp();
      }
      return;
    }
    for (const r of rooms) {
      r.startGame(game);
      this.sendUpdateCurrentRoom(r);
    }
  }
}
