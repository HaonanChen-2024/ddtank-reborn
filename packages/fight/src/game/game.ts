import type { FightAssets } from "../data/assets.js";
import { ActionType, type BallInfo, BombType, type ItemTemplate, getBallType, isSpecialBall } from "../data/types.js";
import { f32, int, roundEven } from "../math/num.js";
import { DotNetRandom, type Rng } from "../math/random.js";
import { BombAction, SimpleBomb, type BombHost, initialVelocity, normalizePointF } from "../phy/bomb.js";
import type { GameMap } from "../phy/map.js";
import type { Point } from "../phy/rect.js";
import { type FightCommand, type FightEvent, type FightEventInit, type FireBomb, withCode } from "./events.js";
import { calculateExperience, calculateOffer, criticalDamage, nextWind, playerKillOffer, shellDamage, turnTime, vane, type WindState } from "./formulas.js";
import { Living, Player, type PlayerSpec, TurnedLiving } from "./living.js";
import { Box } from "./box.js";
import type { DropItem } from "./events.js";

/** eGameState (Game.Logic/eGameState.cs) */
export const GameState = { Inited: 0, Prepared: 1, Loading: 2, GameStartMovie: 3, GameStart: 4, Playing: 5, GameOverMovie: 6, PrepareGameOver: 7, GameOver: 8, TryAgain: 9, Stopped: 10, SessionPrepared: 11, ALLSessionStopped: 12, Waiting: 13 } as const;
export type GameState = (typeof GameState)[keyof typeof GameState];
export const RoomType = { Match: 0, Freedom: 1 } as const;
export const GameType = { Free: 0, Guild: 1 } as const;

/** Match reward ranges (Fighting.Service/App.config:6-32 defaults). All inputs as data. */
export interface RewardConfig {
  moneyWin: [number, number];
  moneyLose: [number, number];
  giftWin: [number, number];
  giftLose: [number, number];
  doubleEvent: boolean;
  /** VIP: +10 gp, +1 offer */
  vipBonus: boolean;
}
export const DEFAULT_REWARDS: RewardConfig = { moneyWin: [500, 700], moneyLose: [400, 500], giftWin: [100, 150], giftLose: [50, 100], doubleEvent: false, vipBonus: true };

export interface GameOptions {
  id: number;
  roomType: number;
  gameType: number;
  timeType: number;
  mapId: number;
  assets: FightAssets;
  players: PlayerSpec[];
  /** RNG seed (default: Date.now()) — same seed + same commands = same game */
  seed?: number;
  /** wall clock in ms at creation */
  now?: number;
  rewards?: Partial<RewardConfig>;
  /** BaseGame.FrozenWind (PvP: any player grade ≤ 9, PVPGame.cs:102) — computed when omitted */
  frozenWind?: boolean;
  /** DropInventory.BoxDrop(roomType) — items for the in-battle drop boxes (eDropType.Box); none when omitted */
  boxDrop?: () => DropItem[] | null;
  /**
   * GamePlayer.UsePropItem(game, bag, place, templateId, isLiving): consume the prop from the player's bags (bag 1 = PropBag
   * 10001-10008, place −1 = free; bag 2 = FightBag). Returns false when the player does not have it. Default: always true.
   */
  usePropItem?: (userId: number, bag: number, place: number, templateId: number, isLiving: boolean) => boolean;
  /** GamePlayer.RemoveHealstone (EquipBag slot 18) — true when one healstone was consumed */
  removeHealstone?: (userId: number) => boolean;
}

export interface QueuedAction {
  at: number;
  run: (now: number) => void;
  done: boolean;
  tag?: string;
  /** BaseAction with ExecuteImp called every tick until it returns true (then `finishDelay` keeps it pending) */
  step?: (now: number) => boolean;
  finishDelay?: number;
  finishAt?: number;
}

/**
 * PvP game (port of BaseGame + PVPGame state machine, turn loop, shooting and explosion). I/O-free: feed it
 * commands with `handle()` and time with `update(now)` (every 40 ms like GameMgr.THREAD_INTERVAL); each returns
 * the outgoing events since the last call.
 */
export class BaseGame implements BombHost {
  readonly id: number;
  readonly roomType: number;
  readonly gameType: number;
  readonly timeType: number;
  readonly assets: FightAssets;
  map: GameMap;
  readonly rng: Rng;
  readonly players: Player[] = [];
  readonly rewards: RewardConfig;
  state: GameState = GameState.Inited;
  turnIndex = 0;
  lifeTime = 0;
  totalHurt = 0;
  currentLiving: TurnedLiving | null = null;
  winTeam = -1;
  physicalId = 0;
  readonly tempPoints: Point[] = [];
  /** BaseGame.m_tempBox / m_tempGhostPoints / CurrentTurnTotalDamage */
  readonly tempBoxes: Box[] = [];
  private tempGhostPoints: Point[] = [];
  currentTurnTotalDamage = 0;
  readonly opts: GameOptions;
  private outbox: FightEvent[] = [];
  protected actions: QueuedAction[] = [];
  /** BaseGame.CurrentActionCount (actions alive at the start of the last update) */
  currentActionCount = 0;
  protected waitTimer = 0;
  protected loadingWait: QueuedAction | null = null;
  protected attackWait: QueuedAction | null = null;
  protected now: number;
  protected readonly windState: WindState;

  constructor(o: GameOptions) {
    this.opts = o;
    this.id = o.id;
    this.roomType = o.roomType;
    this.gameType = o.gameType;
    this.timeType = o.timeType;
    this.assets = o.assets;
    this.map = o.assets.createMap(o.mapId);
    this.rng = new DotNetRandom(o.seed ?? Date.now() | 0);
    this.now = o.now ?? 0;
    this.rewards = { ...DEFAULT_REWARDS, ...o.rewards };
    o.players.forEach((s, i) => this.players.push(new Player(i, this, s)));
    this.physicalId = this.players.length;
    this.windState = { wind: 0, nextWind: 0, frozen: o.frozenWind ?? this.players.some((p) => p.grade <= 9 && !p.spec.isBot) };
    this.checkState(0);
  }

  // ---------------------------------------------------------------- plumbing
  emit(e: FightEventInit): void {
    this.outbox.push(withCode(e));
  }
  drain(): FightEvent[] {
    const o = this.outbox;
    this.outbox = [];
    return o;
  }
  get clock(): number {
    return this.now;
  }
  ball(id: number): BallInfo {
    const b = this.assets.ball(id) ?? this.assets.ball(0);
    if (!b) throw new Error(`ball ${id} not found`);
    return b;
  }
  get wind(): number {
    return this.map.wind;
  }
  addTempPoint(x: number, y: number): void {
    this.tempPoints.push({ x, y });
  }
  addAction(delay: number, run: (now: number) => void, tag?: string): QueuedAction {
    const a = { at: this.now + delay, run, done: false, tag };
    this.actions.push(a);
    return a;
  }
  /** BaseAction(delay, finishDelay): `step` runs every tick from `delay` on until it returns true. */
  addStepAction(delay: number, finishDelay: number, step: (now: number) => boolean, tag?: string): QueuedAction {
    const a: QueuedAction = { at: this.now + delay, run: () => {}, done: false, tag, step, finishDelay };
    this.actions.push(a);
    return a;
  }
  getWaitTimer(): number {
    return this.waitTimer;
  }
  clearWaitTimer(): void {
    this.waitTimer = 0;
  }
  /** BaseGame.WaitTime */
  waitTime(ms: number): void {
    this.waitTimer = Math.max(this.waitTimer, this.now + ms);
  }
  checkState(delay: number): void {
    this.addAction(delay, () => this.checkStateNow(), "check");
  }
  /** called by Living.StopAttacking: finishes the WaitLivingAttackingAction (EndAttacking event) */
  onEndAttacking(_l: Living): void {
    if (this.attackWait) this.attackWait.done = true;
  }
  /** bot targets (PvP: living players of the other team; PvE: NPCs/bosses) */
  enemiesOf(bot: Living): Living[] {
    return this.players.filter((p) => p.isLiving && p.team !== bot.team);
  }
  /** bodies that can block / receive a bot shot */
  bodiesFor(bot: Living): Living[] {
    return this.players.filter((p) => p.isLiving && p !== bot);
  }
  /** PvE: MissionInfo.IncrementDelay (TurnedLiving.AddDelay); null in PvP */
  pveIncrementDelay(): number | null {
    return null;
  }
  /** PVEGame.living_Died hook */
  onLivingDied(_l: Living): void {}
  findPlayer(livingId: number): Player | undefined {
    return this.players.find((p) => p.id === livingId);
  }
  findByUser(userId: number): Player | undefined {
    return this.players.find((p) => p.spec.userId === userId);
  }

  /** BaseGame.Update (BaseGame.cs:3174) */
  update(now: number): FightEvent[] {
    this.now = now;
    if (this.state === GameState.Stopped) return this.drain();
    this.lifeTime++;
    const list = this.actions.filter((a) => !a.done);
    this.actions = [];
    this.currentActionCount = list.length;
    if (list.length > 0) {
      const left: QueuedAction[] = [];
      for (const a of list) {
        if (!a.done && a.at <= now) {
          if (a.step) {
            if (a.finishAt === undefined) {
              try {
                if (a.step(now)) a.finishAt = now + (a.finishDelay ?? 0);
              } catch (e) {
                a.finishAt = now;
                this.onActionError(e);
              }
            }
            if (a.finishAt !== undefined && a.finishAt <= now) a.done = true;
          } else {
            a.done = true;
            a.run(now);
          }
        }
        if (!a.done) left.push(a);
      }
      this.actions.unshift(...left);
    } else if (this.waitTimer < now) {
      this.checkState(0);
    }
    return this.drain();
  }

  /** script/action errors never kill the loop (BaseGame.Update catches per action) */
  onActionError(e: unknown): void {
    this.emitLog?.(`action error: ${(e as Error)?.stack ?? e}`);
  }
  emitLog?: (m: string) => void;

  // ---------------------------------------------------------------- state machine (CheckPVPGameStateAction)
  protected checkStateNow(): void {
    switch (this.state) {
      case GameState.Inited:
        this.pvpPrepare();
        break;
      case GameState.Prepared:
        this.pvpStartLoading();
        break;
      case GameState.Loading:
        if (this.players.every((p) => p.loadingProcess >= 100 || !p.isActive)) this.pvpStartGame();
        break;
      case GameState.Playing:
        if (!this.currentLiving || !this.currentLiving.isAttacking) {
          if (this.turnIndex >= 100 && this.roomType === RoomType.Match) this.pvpGameOver();
          if (this.canGameOver()) this.pvpGameOver();
          else this.pvpNextTurn();
        }
        break;
      case GameState.GameOver:
        this.stop();
        break;
    }
  }

  /** PVPGame.Prepare (PVPGame.cs:637) */
  private pvpPrepare(): void {
    this.emit({
      cmd: "GAME_CREATE", livingId: 0, roomType: this.roomType, gameType: this.gameType, timeType: this.timeType,
      players: this.players.map((p) => ({ userId: p.spec.userId, team: p.team, livingId: p.id, maxBlood: p.spec.hp })),
    });
    this.state = GameState.Prepared;
    this.checkState(0);
  }

  /** PVPGame.StartLoading (PVPGame.cs:842) + WaitPlayerLoadingAction(61000) */
  private pvpStartLoading(): void {
    this.waitTimer = 0;
    this.emit({ cmd: "GAME_LOAD", livingId: 0, maxTime: 60, mapId: this.map.info.id });
    this.loadingWait = this.addAction(61000, () => {
      if (this.state !== GameState.Loading) return;
      for (const p of this.players) if (p.loadingProcess < 100) this.removePlayer(p.spec.userId);
      this.checkState(0);
    }, "waitLoading");
    this.state = GameState.Loading;
  }

  /** PVPGame.StartGame (PVPGame.cs:771) */
  private pvpStartGame(): void {
    this.state = GameState.Playing;
    this.waitTimer = 0;
    // WaitPlayerLoadingAction.IsFinished once the game left Loading
    if (this.loadingWait) this.loadingWait.done = true;
    this.emit({ cmd: "SYNC_LIFETIME", livingId: 0, lifeTime: this.lifeTime });
    const pos = this.pvpSpawnPoints();
    for (const p of this.players) {
      p.reset();
      const list = p.team === 1 ? pos[0] : pos[1];
      let pt: Point;
      if (list.length) pt = list.splice(this.rng.nextMax(list.length), 1)[0];
      else pt = { x: 100 + this.rng.nextMax(Math.max(1, this.map.bound.width - 200)), y: 0 };
      p.place(pt.x, pt.y);
      this.map.addPhysical(p);
      p.startMoving();
      if (!p.isActive) p.die();
    }
    this.emit({
      cmd: "START_GAME", livingId: 0,
      players: this.players.map((p) => ({
        id: p.id, x: p.x, y: p.y, direction: p.direction, blood: p.blood, maxBlood: p.maxBlood, team: p.team,
        weaponRefineryLevel: p.spec.weapon.refineryLevel ?? 0, powerRatio: 50, dander: p.dander, buffs: [], isFrost: p.isFrost, isHide: p.isHide, isNoHole: p.isNoHole,
      })),
    });
    this.waitTime(this.players.length * 1000);
  }

  /** MapMgr.GetMapRandomPos (MapMgr.cs:88-114): parse `x,y|x,y`, randomly swap the team lists. */
  private pvpSpawnPoints(): [Point[], Point[]] {
    const parse = (s?: string) =>
      (s ?? "").split("|").map((t) => t.split(",").map(Number)).filter((a) => a.length === 2 && a.every(Number.isFinite)).map(([x, y]) => ({ x, y }));
    const a = parse(this.map.info.posX);
    const b = parse(this.map.info.posX1);
    return this.rng.nextMax(2) === 1 ? [a, b] : [b, a];
  }

  /** PVPGame.CanGameOver (PVPGame.cs:301) */
  canGameOver(): boolean {
    const alive = (t: number) => this.players.some((p) => p.team === t && p.isLiving);
    return !alive(1) || !alive(2);
  }

  /** BaseGame.FindNextTurnedLiving (BaseGame.cs:491) */
  private pvpFindNextTurnedLiving(): TurnedLiving | null {
    const list = this.players.filter((p) => p.isLiving && p.isActive);
    if (list.length === 0) return null;
    let t: TurnedLiving = list[this.rng.nextMax(list.length)];
    let d = t.delay;
    for (const l of list)
      if (l.delay < d && l.isLiving) {
        d = l.delay;
        t = l;
      }
    t.turnNum++;
    return t;
  }

  /** PVPGame.NextTurn (PVPGame.cs:590-635) */
  private pvpNextTurn(): void {
    if (this.state !== GameState.Playing) return;
    this.waitTimer = 0;
    this.clearDiedPhysicals();
    this.checkBox();
    this.turnIndex++;
    const newBoxes = this.createBox();
    for (const p of [...this.map.physics]) p.prepareNewTurn();
    const cur = this.pvpFindNextTurnedLiving();
    this.currentLiving = cur;
    if (!cur) return;
    if ((cur as Player).vaneOpen) this.updateWind(this.getNextWind(), false);
    for (const p of this.players) p.delay -= cur.delay;
    cur.prepareSelfTurn();
    if (!cur.isFrost && cur.isLiving) {
      cur.startAttacking();
      this.sendNextTurn(cur, newBoxes);
      if (cur.isAttacking) {
        const ti = this.turnIndex;
        this.attackWait = this.addAction(
          (this.timeType + 20) * 1000,
          () => {
            if (this.turnIndex === ti && cur.isAttacking) {
              cur.stopAttacking();
              this.checkState(0);
            }
          },
          "waitAttack",
        );
      }
    }
  }

  protected clearDiedPhysicals(): void {
    for (const p of [...this.map.physics]) if (!p.isLiving && !(p instanceof Living) && !(p instanceof Box)) this.map.removePhysical(p);
  }

  // ---------------------------------------------------------------- drop boxes (BaseGame.cs:604-764)
  /** BaseGame.AddBox / AddGhostBox: boxes are announced in the next TURN packet (sendToClient false). */
  addBox(item: DropItem | null, pos: Point, type: number): Box {
    const box = new Box(this.physicalId++, type, item, (b, phy) => {
      // only real shots of this game (bot aim simulations use another BombHost)
      if (phy instanceof SimpleBomb && phy.host === this && phy.owner instanceof Player) phy.owner.pickBox(b);
    });
    box.place(pos.x, pos.y);
    this.map.addPhysical(box); // AddPhysicalObj / AddGhostBoxObj
    this.tempBoxes.push(box);
    return box;
  }
  /** BaseGame.CheckBox: dead (picked) boxes leave the map → 53 DISAPPEAR. */
  checkBox(): void {
    for (const b of [...this.tempBoxes]) {
      if (b.isLiving) continue;
      this.tempBoxes.splice(this.tempBoxes.indexOf(b), 1);
      this.map.removePhysical(b);
      this.emit({ cmd: "RAW", code: 53, livingId: 0, body: [["i32", b.id]] });
    }
  }
  /** BaseGame.CreateGhostPoints / DrawCirclePoints (background size ≈ the foreground size here). */
  private createGhostPoints(): void {
    const h = this.map.info.foregroundHeight ?? 600, w = this.map.info.foregroundWidth ?? 1000;
    const cx = w / 2, cy = h / 2, step = (Math.PI * 2) / h;
    const pts: Point[] = [];
    for (let r = h - 180; r > 30; r -= 30) for (let i = 0; i < h; i++) pts.push({ x: Math.trunc(cx + r * Math.cos(step * i)), y: Math.trunc(cy + r * Math.sin(step * i)) });
    this.tempGhostPoints = pts;
  }
  /** BaseGame.CreateBox (BaseGame.cs:692): 1-2 item boxes on last turn's trajectory points when damage was dealt, ghost boxes when someone is dead. */
  createBox(): Box[] {
    const max = this.players.length + 2;
    let n = 0;
    let info: DropItem[] | null = null;
    if (this.currentTurnTotalDamage > 0) {
      n = this.rng.nextRange(1, 3);
      if (this.tempBoxes.length + n > max) n = max - this.tempBoxes.length;
      if (n > 0) info = this.opts.boxDrop?.() ?? null;
    }
    this.currentTurnTotalDamage = 0;
    const dead = this.players.filter((p) => !p.isLiving && p.isActive).length;
    const out: Box[] = [];
    if (dead > 0) {
      this.rng.nextMax(dead);
      if (this.tempGhostPoints.length < max) this.createGhostPoints();
      const g = this.tempGhostPoints;
      for (let i = 0; i < g.length; i++) {
        const j = this.rng.nextMax(g.length);
        [g[i], g[j]] = [g[j]!, g[i]!];
      }
      const want = dead + max - this.tempBoxes.filter((b) => b.isGhost).length;
      if (g.length > want)
        for (let i = 0; i < want; i++) {
          const type = [2, 3][this.rng.nextMax(2)]!;
          out.push(this.addBox(null, g[this.rng.nextMax(g.length)]!, type));
        }
    }
    if (info) {
      const t = this.tempPoints;
      for (let i = 0; i < t.length; i++) {
        const j = this.rng.nextMax(t.length);
        [t[i], t[j]] = [t[j]!, t[i]!];
      }
      const k = Math.min(info.length, t.length);
      for (let i = 0; i < k; i++) out.push(this.addBox(info[i]!, t[i]!, 1));
    }
    this.tempPoints.length = 0;
    this.tempGhostPoints = [];
    return out;
  }

  getNextWind(): number {
    this.windState.wind = this.map.wind;
    return nextWind(this.windState, this.rng);
  }
  /** BaseGame.UpdateWind (BaseGame.cs:3218) */
  updateWind(w: number, send: boolean): void {
    if (this.map.wind !== f32(w)) {
      this.map.wind = w;
      if (send) {
        const w10 = int(f32(w * 10));
        this.emit({ cmd: "VANE", livingId: 0, wind10: w10, windPositive: w10 > 0, vane1: vane(w10, 1), vane2: vane(w10, 2), vane3: vane(w10, 3) });
      }
    }
  }

  /** BaseGame.SendGameNextTurn (BaseGame.cs:2190) — vanes from wind×10 like FIRE/VANE. */
  protected sendNextTurn(l: TurnedLiving, newBoxes: Box[] = []): void {
    const w = int(f32(this.map.wind * 10));
    this.emit({
      cmd: "TURN", livingId: l.id, windPositive: this.map.wind > 0, vane1: vane(w, 1), vane2: vane(w, 2), vane3: vane(w, 3),
      isHide: l.isHide, turnTime: turnTime(this.timeType), boxes: newBoxes.map((b) => ({ id: b.id, x: b.x, y: b.y, type: b.type })),
      players: this.players.map((p) => ({
        id: p.id, isLiving: p.isLiving, x: p.x, y: p.y, blood: p.blood, isNoHole: p.isNoHole, energy: p.energy, psychic: p.psychic,
        dander: p.dander, petMaxMP: p.spec.pet ? 100 : 0, petMP: p.spec.pet ? p.petMP : 0, shootCount: p.shootCount, flyCount: p.canFly ? 1 : 0,
      })),
      turnIndex: this.turnIndex,
    });
  }

  /** PVPGame.GameOver (PVPGame.cs:329-561) */
  private pvpGameOver(): void {
    if (this.state !== GameState.Playing) return;
    this.state = GameState.GameOver;
    this.waitTimer = 0;
    let winTeam = this.players.find((p) => p.isLiving)?.team ?? -1;
    if (winTeam === -1 && this.currentLiving) winTeam = this.currentLiving.team;
    this.winTeam = winTeam;
    const isMatch = this.roomType === RoomType.Match;
    const teamHurt = (t: number) => this.players.some((p) => p.team === t && p.totalHurt > 0);
    const avg = (t: number) => {
      const l = this.players.filter((p) => p.team === t);
      return l.length ? l.reduce((s, p) => s + p.grade, 0) / l.length : 0;
    };
    const R = this.rewards;
    const rnd = ([a, b]: [number, number]) => a + this.rng.nextMax(b - a + 1);
    const players = this.players.map((p) => {
      const opp = p.team === 1 ? 2 : 1;
      const oppAvg = avg(opp);
      const oppCount = this.players.filter((q) => q.team === opp).length;
      const won = p.team === winTeam;
      let gp = 0;
      let offer = 0;
      let reward = 0;
      if (isMatch || Math.abs(oppAvg - p.grade) < 5) {
        const e = calculateExperience({
          isMatch, won, grade: p.grade, totalHurt: p.totalHurt, totalKill: p.totalKill, totalShootCount: p.totalShootCount,
          totalHitTargetCount: p.totalHitTargetCount, opponentAvgLevel: oppAvg, opponentCount: oppCount, gameTotalHurt: this.totalHurt, doubleEvent: R.doubleEvent,
        });
        gp = e.gp;
        reward = e.reward;
        offer = calculateOffer({ isMatch, isGuild: this.gameType === GameType.Guild, won, opponentCount: oppCount, gainOffer: p.gainOffer, killedPunishmentOffer: p.killedPunishmentOffer, doubleEvent: R.doubleEvent });
      }
      let money = 0;
      let giftToken = 0;
      if (isMatch && p.totalHurt > 0 && !p.spec.isBot) {
        money = rnd(won ? R.moneyWin : R.moneyLose);
        giftToken = rnd(won ? R.giftWin : R.giftLose);
      }
      const vip = R.vipBonus && !!p.spec.isVip;
      if (vip) {
        gp += 10;
        offer += 1;
      }
      return {
        id: p.id, userId: p.spec.userId, win: won, grade: p.grade, gp: 0, totalKill: p.totalKill, gpGained: gp, hitCount: p.totalHitTargetCount,
        psychic: p.psychic, vipBonus: vip ? 10 : 0, reward, offer, isVip: !!p.spec.isVip, gainOffer: p.gainOffer,
        canTakeOut: teamHurt(p.team) ? 1 : 0, money, giftToken, totalHurt: p.totalHurt,
      };
    });
    this.emit({ cmd: "GAME_OVER", livingId: 0, winTeam, players, riches: 0 });
    this.waitTime(20000);
  }

  stop(): void {
    if (this.state === GameState.Stopped) return;
    this.state = GameState.Stopped;
    this.actions = [];
  }

  /** BaseGame.RemovePlayer: a leaver dies (PVPGame leaving punishment is applied by the server). */
  /** Returns true when the leaver fled alive from a started game (PVPGame.RemovePlayer: GP / offer penalty by the server). */
  removePlayer(userId: number): boolean {
    const p = this.findByUser(userId);
    if (!p || !p.isActive) return false;
    p.isActive = false;
    const fled = p.isLiving && this.state !== GameState.Loading && this.state !== GameState.Inited && this.state !== GameState.Prepared && this.state < GameState.GameOver;
    if (this.state === GameState.Playing && p.isLiving) {
      p.die();
    }
    // PVPGame.RemovePlayer: only one team left → end the current turn
    if (this.state === GameState.Playing && this.canGameOver() && this.currentLiving?.isAttacking) this.currentLiving.stopAttacking();
    this.checkState(0);
    return fled;
  }

  // ---------------------------------------------------------------- commands
  /** Applies one client action (GAME_CMD from `userId`) and returns the resulting events. */
  handle(userId: number, c: FightCommand, now: number = this.now): FightEvent[] {
    this.now = Math.max(this.now, now);
    const p = this.findByUser(userId);
    if (!p) return this.drain();
    switch (c.cmd) {
      case "LOAD":
        if (this.state === GameState.Loading) {
          p.loadingProcess = c.progress;
          this.emit({ cmd: "LOAD", livingId: p.id, progress: c.progress, userId: p.spec.userId });
          if (p.loadingProcess >= 100) this.checkState(0);
        }
        break;
      case "FIRE_TAG":
        // FireTagCommand: rebroadcast to all + SYNC_LIFETIME, then PrepareShoot
        if (p.isAttacking) {
          this.emit({ cmd: "FIRE_TAG", livingId: p.id, hasTime: c.hasTime, speedTime: c.speedTime });
          this.emit({ cmd: "SYNC_LIFETIME", livingId: 0, lifeTime: this.lifeTime });
          if (c.hasTime) p.prepareShoot(c.speedTime);
        }
        break;
      case "FIRE":
        if (p.isAttacking) p.shoot(c.x, c.y, c.force, c.angle);
        break;
      case "SKIPNEXT":
        p.skip();
        break;
      case "DIRECTION":
        p.direction = c.direction >= 0 ? 1 : -1;
        this.emit({ cmd: "DIRECTION", livingId: p.id, direction: p.direction, except: p.id });
        break;
      case "MOVESTART":
        this.pvpMoveStart(p, c);
        break;
      case "PROP":
        this.propUse(p, c.bag, c.templateId, c.place);
        break;
      case "PICK":
        // PickCommand → Player.OpenBox (boxes picked by a shot are opened at once; this re-tries a pending one)
        p.openBox(c.boxId);
        break;
      case "PET_SKILL":
        // PetKillCommand (144)
        if (this.state === GameState.Playing && p.isAttacking) p.petUseKill(c.skillId, c.type);
        break;
      case "STUNT":
        if (p.isAttacking) p.useSpecialSkill();
        break;
      case "AIRPLANE":
        if (p.isAttacking) p.useFlySkill();
        break;
      case "USE_DEPUTY_WEAPON":
        if (p.isAttacking) p.useSecondWeapon();
        break;
      case "SUICIDE":
        if (p.isLiving && this.state === GameState.Playing) p.die();
        break;
      case "GHOST_TARGET":
        p.targetPoint = { x: c.x, y: c.y };
        break;
      case "BOT_COMMAND":
        this.emit({ cmd: "BOT_COMMAND", livingId: p.id });
        break;
    }
    return this.drain();
  }

  /** MoveStartCommand + sanity check (the original trusts the client, see 00-fight-engine §3.4). */
  private pvpMoveStart(p: Player, c: { type: number; x: number; y: number; dir: number; isLiving: boolean }): void {
    if (!p.isAttacking || !p.isLiving) return;
    const dx = Math.abs(c.x - p.x);
    let x = c.x;
    if (dx > p.energy + 2) x = p.x + Math.sign(c.x - p.x) * Math.max(0, p.energy);
    this.emit({ cmd: "MOVESTART", livingId: p.id, type: c.type, x: c.x, y: c.y, dir: c.dir, isLiving: c.isLiving, except: p.id });
    p.direction = c.dir === 1 ? 1 : -1;
    p.setXY(x, c.y);
    p.startMoving();
    if (Math.abs(p.y - c.y) > 1 || p.x !== c.x || p.isLiving !== c.isLiving)
      this.emit({ cmd: "MOVESTART", livingId: p.id, type: 3, x: p.x, y: p.y, dir: p.direction === 1 ? 1 : 0, isLiving: p.isLiving });
  }

  /** PropUseCommand (Cmd/PropUseCommand.cs) */
  propUse(p: Player, bag: number, templateId: number, place = -1): boolean {
    const item = this.assets.items.get(templateId);
    if (!item || this.state !== GameState.Playing || p.isSeal) return false;
    if (bag === 2 && (templateId < 10001 || templateId > 10022)) return false;
    if (bag === 1 && (templateId < 10001 || templateId > 10008)) return false;
    if (p.spec.props && !p.spec.props.includes(templateId)) return false;
    const usePropItem = (): boolean => this.opts.usePropItem?.(p.spec.userId, bag, place, templateId, p.isLiving) ?? true;
    if (p.isLiving) {
      if (!p.checkCanUseItem(templateId) || !p.canUseItem(item)) return false;
      if (templateId === 10001 || templateId === 10002 || templateId === 10003) p.canFly = false;
      if (!usePropItem() || !p.useItem(item)) return false;
      // PropUseCommand.cs:93-110: two +2 / +50% props select CommonMultiBall / CommonAddWound.
      // The port unifies free and bag consumption; count only a successfully applied prop.
      if ((templateId === 10001 || templateId === 10004) && p.prop < templateId * 2) p.prop += templateId;
    } else {
      // a dead teammate (ghost) uses a prop for the current living: bag 2 = FightBag item, place −1 = paid with psychic
      if (bag === 2 && !usePropItem()) return false;
      if (!p.useItemDead(item, place)) return false;
    }
    // PropUseCommand.cs:126-138 — post effects on the current shooter
    const cur = this.currentLiving instanceof Player ? this.currentLiving : p;
    if (templateId === 10015 || templateId === 10016) {
      cur.shootCount = 1;
      cur.ballCount = 1;
    } else if (templateId === 10020 || templateId === 10022) cur.isBombOrIgnoreArmor = templateId === 10020 ? 1 : 2;
    else if (item.categoryId === 17) cur.shootCount = 1;
    // Player.UseItem(item, place): Property6 == 1 ends the turn
    if (item.property6 === 1 && cur.isAttacking) {
      cur.stopAttacking();
      this.checkState(0);
    }
    return true;
  }

  /** SpellMgr.ExecuteSpell by ItemTemplate.Property1 (Spells/**) */
  executeSpell(p: Player, item: ItemTemplate): void {
    const all = this.players;
    switch (item.property1) {
      case 1: // AddLifeSpell
        if (item.property2 === 0) p.addBlood(item.property3);
        else for (const q of all) if (q.isLiving && q.team === p.team) q.addBlood(item.property3);
        break;
      case 2: // FrostSpell
        p.setBall(1);
        break;
      case 3: // HideSpell
        if (item.property2 === 0) p.startEffect("hide", item.property3);
        else for (const q of all) if (q.isLiving && q.team === p.team) q.startEffect("hide", item.property3);
        break;
      case 5: // CarrySpell
        p.setBall(3);
        break;
      case 7: // VaneSpell
        this.updateWind(-this.map.wind, true);
        break;
      case 8: // BreachDefenceSpell
        p.ignoreArmor = true;
        break;
      case 9: // NoHoleSpell
        p.startEffect("nohole", item.property3);
        break;
      case 10: // ABombSpell
        p.setBall(4);
        break;
      case 11: // AttackUpSpell
        p.addDander(item.property2);
        break;
      case 12: // ShootStraightSpell
        p.controlBall = true;
        p.currentShootMinus = f32(p.currentShootMinus * f32(0.5));
        break;
      case 13: // AddWoudSpell
        p.currentDamagePlus = f32(p.currentDamagePlus + f32(item.property2 / 100));
        break;
      case 14: {
        // AddAttackSpell
        const b = p.currentBall.id;
        if ((b !== 3 && b !== 5 && b !== 1) || (item.templateId !== 10001 && item.templateId !== 10002)) {
          p.setShootCount(p.shootCount + item.property2);
          p.currentShootMinus = f32(p.currentShootMinus * f32(item.property2 === 2 ? 0.6 : 0.9));
        } else p.setShootCount(1);
        break;
      }
      case 15: {
        // AddBallSpell
        if (p.isSpecialSkill) break;
        const b = p.currentBall.id;
        if ((b === 3 || b === 5 || b === 1) && item.templateId === 10003) p.ballCount = 1;
        else {
          p.currentDamagePlus = f32(p.currentDamagePlus * f32(0.5));
          p.ballCount = item.property2;
        }
        break;
      }
      case 30: // SealSpell
        p.startEffect("seal", item.property3);
        break;
    }
  }

  // ---------------------------------------------------------------- shooting
  /** Living.ShootImp (Living.cs:1761-1870) */
  shootImp(l: Living, ballId: number, x: number, y: number, force: number, angle: number, bombCount: number, shootCount: number): boolean {
    const info = this.assets.ball(ballId);
    if (!info) return false;
    const shape = this.assets.shape(ballId);
    const type = getBallType(ballId);
    const w10 = int(this.map.wind * 10.0);
    let maxLife = 0;
    const bombs: FireBomb[] = [];
    for (let i = 0; i < bombCount; i++) {
      const { vx, vy } = initialVelocity(force, angle, i);
      const b = new SimpleBomb(this.physicalId++, type, l, this, info, shape, l.controlBall, angle);
      b.setXY(x, y);
      b.setSpeedXY(vx, vy);
      this.map.addPhysical(b);
      b.startMoving();
      // Player.FlyingPartical: a gem proc (effects.ts/equipEffects.ts) can override the ball's own glow for this shot.
      const partical = l instanceof Player && l.flyingPartical ? String(l.flyingPartical) : info.flyingPartical;
      bombs.push({
        bombCount, shootCount, digMap: b.digMap, bombId: b.id, x, y, vx, vy, ballId: info.id, flyingPartical: partical,
        radii: int((info.radii * 1000) / 4), power: int(info.power) * 1000, actions: b.actions,
      });
      maxLife = Math.max(maxLife, b.lifeTime);
    }
    this.emit({ cmd: "FIRE", livingId: l.id, wind10: w10, windPositive: w10 > 0, vane1: vane(w10, 1), vane2: vane(w10, 2), vane3: vane(w10, 3), bombs, petActions: [], petFlag: 0 });
    this.waitTime(int(f32(f32(f32(maxLife + 2) + int(bombCount / 3)) * 1000)));
    return true;
  }

  /** SimpleBomb.BombImp (SimpleBomb.cs:89-415) — PvP subset (no pets / NPC configs / achievements). */
  bombImp(bomb: SimpleBomb): void {
    const owner = bomb.owner as Living;
    const cp = bomb.getCollidePoint();
    const around = this.map.findHitByHitPoint(cp, bomb.radius) as Living[];
    for (const p of around) {
      if (p.isNoHole || p.noHoleTurn) {
        p.noHoleTurn = true;
        if (!isSpecialBall(bomb.info.id)) bomb.digMap = false;
      }
      p.syncAtTime = false;
    }
    owner.syncAtTime = false;
    const t = bomb.lifeTime;
    const act = (type: number, a: number, b2: number, c: number, d: number) => bomb.actions.push(new BombAction(t, type, a, b2, c, d));
    try {
      if (bomb.digMap) this.map.dig(bomb.x, bomb.y, bomb.shape, null);
      act(ActionType.BOMB, bomb.x, bomb.y, bomb.digMap ? 1 : 0, 0);
      switch (bomb.type) {
        case BombType.FORZEN:
          for (const p of around) {
            if (p.startEffect("ice", 2)) act(ActionType.FORZEN, p.id, 0, 0, 0);
          }
          break;
        case BombType.FLY:
          if (bomb.y > 10 && t > f32(0.04)) {
            let bx = bomb.x;
            let by = bomb.y;
            if (!this.map.isEmpty(bx, by)) {
              const n = normalizePointF(f32(0 - bomb.vX), f32(0 - bomb.vY), 5);
              bx -= int(n.x);
              by -= int(n.y);
            }
            if (owner instanceof Player) owner.place(bx, by);
            else owner.setXY(bx, by);
            owner.startMoving();
            act(ActionType.TRANSLATE, bx, by, 0, 0);
            act(ActionType.START_MOVE, owner.id, owner.x, owner.y, owner.isLiving ? 1 : 0);
          }
          break;
        case BombType.CURE: {
          const dw = (owner as Player).spec?.deputyWeapon;
          for (const p of around) {
            const k = this.map.findPlayersCount2(cp, bomb.radius) ? 0.4 : 1.0;
            const heal = dw ? int(dw.template.property7 * Math.pow(1.1, dw.strengthenLevel) * k) : 0;
            if (p instanceof Player) {
              p.totalCure += heal;
              p.addBlood(heal);
              p.hooks.emit("playerCure", p, heal); // Player.PlayerCure
              act(ActionType.CURE, p.id, p.blood, heal, 0);
            }
          }
          break;
        }
        default:
          for (const p of around) {
            if (owner.isFriendly(p) || (owner.kind === "player" && p.config.IsHelper) || (p.kind !== "player" && (!p.config.CanTakeDamage || p.config.HaveShield))) continue;
            const d = { damage: this.makeDamage(bomb, owner, p), critical: 0 };
            if (d.damage !== 0) {
              d.critical = criticalDamage(this.rng, owner.lucky, d.damage, { critRate: owner.critRate, targetReduce: p.reduceCrit, guildAddCritical: owner.guildAddCritical });
              const wasLiving = p.isLiving;
              if (p.takeDamage(owner, d)) {
                act(ActionType.KILL_PLAYER, p.id, d.damage + d.critical, d.critical === 0 ? 1 : 2, p.blood);
                if (wasLiving && !p.isLiving && p instanceof Player && owner instanceof Player && p.team !== owner.team) {
                  const off = playerKillOffer({ isGuildGame: this.gameType === GameType.Guild, bothInGuilds: !!(p.spec.inGuild && owner.spec.inGuild), victimTotalHurt: p.totalHurt });
                  owner.gainOffer += off;
                  p.killedPunishmentOffer += off;
                }
              } else act(ActionType.UNFORZEN, p.id, 0, 0, 0);
              if (p instanceof Player) act(ActionType.DANDER, p.id, p.dander, 0, 0);
            }
            if (p.isLiving) {
              p.startMoving();
              act(ActionType.START_MOVE, p.id, p.x, p.y, p.isLiving ? 1 : 0);
            }
          }
          this.onBombShooted();
      }
      bomb.die();
    } finally {
      owner.syncAtTime = true;
      for (const p of around) p.syncAtTime = true;
    }
  }

  /** PVEGame.OnShooted (mission hook) */
  onBombShooted(): void {}

  /** SimpleBomb.MakeDamage (SimpleBomb.cs:478) */
  makeDamage(bomb: SimpleBomb, owner: Living, target: Living): number {
    return shellDamage(
      { baseDamage: owner.baseDamage, attack: owner.attack, grade: owner.grade, lucky: owner.lucky, currentDamagePlus: owner.currentDamagePlus, currentShootMinus: owner.currentShootMinus, ignoreArmor: owner.ignoreArmor || target.config.CancelGuard },
      { baseGuard: target.baseGuard, defence: target.defence, armorBonus: target instanceof Player ? target.armorBonus() : 0 },
      target.damageDistance({ x: bomb.x, y: bomb.y }),
      bomb.radius,
    );
  }

  /** `(int)Math.Round` helper used by actions timing */
  static timeInt(sec: number): number {
    return int(roundEven(f32(sec * 1000)));
  }
}

/** PvP game (PVPGame / BattleGame). */
export class PvpGame extends BaseGame {}
