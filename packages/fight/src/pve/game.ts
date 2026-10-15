/**
 * PvE game: port of Game.Logic/PVEGame.cs + Actions/CheckPVEGameStateAction.cs + the Living action timeline
 * (Actions/Living*Action.cs). Same I/O-free contract as PvpGame: `handle()` commands, `update(now)` every 40 ms, events
 * out. Scripts (game / mission / brain) run through `runScript` (try/catch like the C# call sites) and use the
 * PascalCase API below, which mirrors the C# member names so transpiled donor scripts run unchanged.
 */
import { BaseGame, GameState, type GameOptions, type QueuedAction } from "../game/game.js";
import type { DropItem, FightCommand, FightEvent, RawField } from "../game/events.js";
import { Living, LivingConfig, Player, TurnedLiving } from "../game/living.js";
import type { Box } from "../game/box.js";
import { f32, int } from "../math/num.js";
import type { Point } from "../phy/rect.js";
import { isEmptyPoint } from "../phy/rect.js";
import { CsList, rngNext, setScriptRng } from "./cs.js";
import { Ball, Layer, LayerTop, type MissionInfo, type NpcInfo, PhysicalObj, type PveInfo, SimpleBoss, SimpleNpc, TransmissionGate, resetRectWithDir } from "./livings.js";
import { AMissionControl, APVEGameControl, GenericGameControl, GenericMission, createScript } from "./script.js";

export const eHardLevel = { Easy: 0, Normal: 1, Hard: 2, Terror: 3, Epic: 4, Simple: 5 } as const;
export const eRoomType = { Match: 0, Freedom: 1, Exploration: 2, Boss: 3, Dungeon: 4, FightLab: 5, Freshman: 10, Academy: 11, WordBossFight: 14, Labyrinth: 15, ConsortiaBoss: 17, FightGround: 18, CoupleBoss: 20, ActivityDungeon: 21, SpecialActivityDungeon: 23, FightFootballTime: 30, Christmas: 40 } as const;
export const eGameType = { Free: 0, Guild: 1, Training: 2, ALL: 4, Exploration: 5, Boss: 6, Dungeon: 7, FightLab: 8, Freshman: 10 } as const;

export interface PveData {
  npc(id: number): NpcInfo | undefined;
  mission(id: number): MissionInfo | undefined;
}
export interface PveDrops {
  /** DropInventory.CopyDrop(copyId, user) (eDropType.Copy = 5) */
  copyDrop?(missionId: number, user: number): DropItem[] | null;
  /** DropInventory.NPCDrop(dropId) (eDropType.NPC = 3) */
  npcDrop?(dropId: number): DropItem[] | null;
}
export interface PveGameOptions extends Omit<GameOptions, "mapId"> {
  pveInfo: PveInfo;
  hardLevel: number;
  currentFloor?: number;
  data: PveData;
  drops?: PveDrops;
  log?: (m: string) => void;
  /** map used before the mission script calls SetMap (default: first packed map) */
  placeholderMapId?: number;
  /** World boss remaining HP (server-wide pool): a boss created with config.IsWorldBoss starts at min(NPC blood, this) — 6600 PVEGame.CreateBoss WorldbossBood. */
  worldBossBlood?: number;
  /** Opt-in local challenges must fail closed instead of substituting generic scripts. Default preserves donor behavior. */
  strictScripts?: boolean;
  /** Activity settlement is the only award owner for these explicitly configured challenges. */
  suppressDefaultRewards?: boolean;
}

interface PlayerPve {
  ready: boolean;
  canTakeOut: number;
  finishTakeCard: boolean;
  gainGP: number;
  bossCardCount: number;
  totalAllKill: number;
  totalAllHurt: number;
  totalAllScore: number;
  totalAllCure: number;
  totalAllExperience: number;
}

export class PveGame extends BaseGame {
  readonly info: PveInfo;
  readonly data: PveData;
  readonly drops: PveDrops;
  private readonly logFn: (m: string) => void;
  readonly strictScripts: boolean;
  private readonly suppressDefaultRewards: boolean;
  /** m_livings: SimpleNpc & other non-turned livings */
  readonly livings: Living[] = [];
  /** m_turnQueue: players + bosses */
  readonly turnQueue: TurnedLiving[] = [];
  readonly physObjs = new Set<PhysicalObj>();
  readonly loadingFiles: { type: number; path: string; className: string }[] = [];
  readonly gameOverResources: string[] = [];
  readonly Misssions = new Map<number, MissionInfo>();
  readonly pp = new Map<Player, PlayerPve>();
  readonly missingScripts: { kind: string; name: string }[] = [];
  readonly scriptErrors: string[] = [];
  private gameAI: APVEGameControl;
  private missionAI: AMissionControl = new GenericMission();
  private missionInfo: MissionInfo | null = null;
  private hardLevel: number;
  private beginPlayersCount: number;
  private mapPos: { posX: Point[]; posX1: Point[] } | null = null;
  cards: number[];
  /** spawned NPCs/bosses this session (GenericMission) */
  spawnedCount = 0;

  // ---- C# public fields used by scripts (PascalCase on purpose)
  SessionId = 0;
  worldBossBlood: number | undefined;
  TotalMissionCount = 0;
  TotalCount = 0;
  TotalTurn = 0;
  TotalKillCount = 0;
  TotalNpcExperience = 0;
  TotalNpcGrade = 0;
  IsWin = false;
  CanEndGame = false;
  CanEnterGate = false;
  CanShowBigBox = false;
  IsPassDrama = false;
  Param1 = -1;
  Param2 = -1;
  Param3 = -1;
  Param4 = -1;
  Param5 = 0;
  Param6 = 0;
  ParamLiving: Living | null = null;
  WantTryAgain = 0;
  IsBossWar = "";
  Pic = "";
  TakeCardId = 0;
  PveGameDelay = 0;
  BossCardCountValue = 0;
  MapHistoryIds = new CsList<number>();
  ConFineWind = false;
  private gameStateModify: number = GameState.Playing;

  constructor(o: PveGameOptions) {
    const placeholder = o.placeholderMapId ?? (o.assets.maps.has(1001) ? 1001 : [...o.assets.maps.keys()][0]!);
    super({ ...o, mapId: placeholder, frozenWind: o.frozenWind ?? false });
    this.info = o.pveInfo;
    this.data = o.data;
    this.strictScripts = o.strictScripts === true;
    this.suppressDefaultRewards = o.suppressDefaultRewards === true;
    this.worldBossBlood = o.worldBossBlood;
    this.drops = o.drops ?? {};
    this.logFn = o.log ?? (() => {});
    this.emitLog = this.logFn;
    this.hardLevel = o.hardLevel;
    this.beginPlayersCount = this.players.length;
    this.cards = new Array(this.roomType === eRoomType.Dungeon ? 21 : 9).fill(0);
    for (const p of this.players) {
      this.turnQueue.push(p);
      p.team = 1;
      p.direction = this.rng.nextRange(0, 1) === 0 ? 1 : -1;
      this.pp.set(p, { ready: false, canTakeOut: 0, finishTakeCard: false, gainGP: 0, bossCardCount: 0, totalAllKill: 0, totalAllHurt: 0, totalAllScore: 0, totalAllCure: 0, totalAllExperience: 0 });
    }
    this.SessionId = o.currentFloor && o.currentFloor > 0 ? o.currentFloor - 1 : 0;
    const scriptName = this.scriptFor(o.pveInfo, o.hardLevel);
    let ai = createScript<APVEGameControl>(scriptName, (m) => this.log(m), APVEGameControl);
    if (!ai) {
      this.reportMissing("game", scriptName || `(Pve_Info ${o.pveInfo.ID})`);
      ai = new GenericGameControl();
    }
    this.gameAI = ai;
    ai.Game = this;
    this.runScript("game.OnCreated", () => ai!.OnCreated());
  }

  // ------------------------------------------------------------------------------------------- plumbing
  log(m: string): void {
    this.logFn(m);
  }
  reportMissing(kind: string, name: string): void {
    this.missingScripts.push({ kind, name });
    if (this.strictScripts) throw new Error(`Required ${kind} script missing: ${name}`);
    this.log(`pve: missing ${kind} script ${name} -> generic AI`);
  }
  /** every C# script call site is wrapped in try/catch (PVEGame.cs passim) */
  runScript<T>(what: string, fn: () => T, fallback?: T): T | undefined {
    setScriptRng(this.rng);
    try {
      return fn();
    } catch (e) {
      const at = ((e as Error)?.stack ?? "").split("\n").find((l) => /[\\/]scripts[\\/]/.test(l)) ?? "";
      const where = at ? ` @${at.trim().replace(/^at /, "").replace(/\(.*[\\/]scripts[\\/]/, "(")}` : "";
      const msg = `pve script ${what} error: ${(e as Error)?.message ?? e}${where}`;
      if (this.scriptErrors.length < 200) this.scriptErrors.push(msg);
      this.log(msg);
      if (this.strictScripts) { this.IsWin = false; this.stop(); throw e; }
      return fallback;
    } finally {
      setScriptRng(null);
    }
  }
  override onActionError(e: unknown): void {
    if (this.strictScripts) { this.IsWin = false; this.stop(); throw e; }
    super.onActionError(e);
  }
  raw(code: number, livingId: number, body: RawField[]): void {
    this.emit({ cmd: "RAW", code, livingId, body });
  }
  override pveIncrementDelay(): number | null {
    return this.missionInfo?.IncrementDelay ?? 0;
  }
  private scriptFor(info: PveInfo, hard: number): string {
    switch (hard) {
      case eHardLevel.Easy: return info.SimpleGameScript ?? "";
      case eHardLevel.Normal: return info.NormalGameScript ?? "";
      case eHardLevel.Hard: return info.HardGameScript ?? "";
      case eHardLevel.Terror: return info.TerrorGameScript ?? "";
      case eHardLevel.Epic: return info.EpicGameScript ?? "";
      default: return info.SimpleGameScript ?? "";
    }
  }
  /** GenericGameControl: no game script — guess the missions from Mission_Info ids sharing the Pve id prefix */
  fallbackMissionIds(): number[] {
    const out: number[] = [];
    for (let i = 1; i <= 9; i++) {
      const id = this.info.ID * 100 + i;
      if (this.data.mission(id)) out.push(id);
    }
    if (!out.length && this.data.mission(this.info.ID)) out.push(this.info.ID);
    return out;
  }
  get missionScript(): AMissionControl {
    return this.missionAI;
  }

  /** CheckPVEGameStateAction: stays queued until the wait timer elapsed (CheckPVEGameStateAction.cs:17). */
  override checkState(delay: number): void {
    this.addStepAction(delay, 0, (now) => {
      if (this.getWaitTimer() >= now) return false;
      this.checkStateNow();
      return true;
    }, "check");
  }

  protected override checkStateNow(): void {
    switch (this.state as number) {
      case GameState.Inited: this.prepare(); break;
      case GameState.Prepared: this.prepareNewSession(); break;
      case GameState.Loading:
        if (this.isAllComplete()) this.startGame();
        else this.waitTime(1000);
        break;
      case GameState.GameStart:
        if (this.roomType === eRoomType.FightLab) {
          if (this.currentActionCount <= 1) this.prepareFightingLivings();
        } else this.prepareNewGame();
        break;
      case GameState.Playing:
        if ((this.currentLiving && this.currentLiving.isAttacking) || this.currentActionCount > 1) break;
        if (this.canGameOver()) {
          if (this.currentActionCount <= 1) {
            if (this.isCanPrepareGameOver()) this.prepareGameOver();
            else this.gameOver();
          }
        } else if (this.gameStateModify === GameState.Waiting) this.waitingGameState();
        else this.nextTurnPve();
        break;
      case GameState.Waiting: this.waitingGameState(); break;
      case GameState.PrepareGameOver:
        if (this.CanEndGame) this.gameOver();
        else this.prepareGameOver();
        break;
      case GameState.GameOver:
        if (!this.hasNextSession()) this.gameOverAllSession();
        else this.prepareNewSession();
        break;
      case GameState.SessionPrepared:
        if (this.canStartNewSession()) this.startLoading();
        else this.waitTime(1000);
        break;
      case GameState.ALLSessionStopped:
        if (this.players.length === 0 || this.WantTryAgain === 0) this.stopPve();
        else if (this.WantTryAgain === 2) {
          this.SessionId--;
          this.prepareNewSession();
        } else if (this.WantTryAgain === 1) this.prepareNewSession();
        else this.waitTime(1000);
        break;
    }
  }

  private get fightPlayers(): Player[] {
    return this.players.filter((p) => p.isActive);
  }
  private isAllComplete(): boolean {
    return this.fightPlayers.every((p) => p.loadingProcess >= 100);
  }

  /** PVEGame.Prepare (PVEGame.cs:1541) */
  private prepare(): void {
    if (this.fightPlayers.length === 0) {
      this.state = GameState.Stopped;
      return;
    }
    this.state = GameState.Prepared;
    this.emit({
      cmd: "GAME_CREATE", livingId: 0, roomType: this.roomType, gameType: this.gameType, timeType: this.timeType,
      players: this.players.map((p) => ({ userId: p.spec.userId, team: p.team, livingId: p.id, maxBlood: p.spec.hp })),
    });
    this.checkState(0);
    this.runScript("game.OnPrepated", () => this.gameAI.OnPrepated());
  }

  /** PVEGame.PrepareNewSession (PVEGame.cs:1622) */
  private prepareNewSession(): void {
    const s = this.state as number;
    if (s !== GameState.Prepared && s !== GameState.GameOver && s !== GameState.ALLSessionStopped && s !== GameState.TryAgain) return;
    this.state = GameState.SessionPrepared;
    this.SessionId++;
    this.loadingFiles.length = 0;
    this.clearMissionData();
    this.gameOverResources.length = 0;
    this.WantTryAgain = 0;
    const mi = this.Misssions.get(this.SessionId);
    if (!mi) {
      this.log(`pve ${this.id}: no mission for session ${this.SessionId}`);
      this.state = GameState.ALLSessionStopped;
      return;
    }
    this.missionInfo = mi;
    this.PveGameDelay = mi.Delay;
    this.TotalCount = mi.TotalCount;
    this.TotalTurn = mi.TotalTurn;
    this.Param1 = mi.Param1;
    this.Param2 = mi.Param2;
    this.Param3 = -1;
    this.Param4 = -1;
    this.spawnedCount = 0;
    let m = createScript<AMissionControl>(mi.Script, (x) => this.log(x), AMissionControl);
    if (!m) {
      this.reportMissing("mission", mi.Script || `(Mission_Info ${mi.Id})`);
      m = new GenericMission();
    }
    this.missionAI = m;
    if (this.roomType === eRoomType.Dungeon) this.Pic = `show${this.SessionId}.jpg`;
    m.Game = this;
    const ok = this.runScript("mission.OnPrepareNewSession", () => (m!.OnPrepareNewSession(), true), false);
    if (!ok && !(m instanceof GenericMission)) {
      // a broken mission script must not freeze the dungeon: generic rules on the same map
      this.log(`pve: mission ${mi.Script} failed to prepare -> generic mission`);
      this.missionAI = new GenericMission();
      this.missionAI.Game = this;
    }
  }

  /** PVEGame.ClearMissionData */
  private clearMissionData(): void {
    for (const l of this.livings) l.dispose();
    this.livings.length = 0;
    const keep = this.turnQueue.filter((t) => t instanceof Player && t.isLiving);
    for (const t of this.turnQueue) if (!(t instanceof Player)) t.dispose();
    this.turnQueue.length = 0;
    this.turnQueue.push(...keep);
    for (const o of [...this.physObjs]) {
      o.dispose();
      this.physObjs.delete(o);
    }
  }

  private canStartNewSession(): boolean {
    return this.turnIndex === 0 || this.fightPlayers.every((p) => this.pp.get(p)!.ready);
  }

  /** PVEGame.StartLoading (PVEGame.cs:2091) */
  private startLoading(): void {
    if ((this.state as number) !== GameState.SessionPrepared) return;
    this.state = GameState.Loading;
    this.turnIndex = 0;
    for (const p of this.players) p.loadingProcess = 0;
    this.SendMissionInfo();
    this.emit({ cmd: "GAME_LOAD", livingId: 0, maxTime: 60, mapId: this.map.info.id, files: [...this.loadingFiles] });
    this.loadingWait = this.addAction(61000, () => {
      if ((this.state as number) !== GameState.Loading) return;
      for (const p of this.players) if (p.loadingProcess < 100) this.removePlayer(p.spec.userId);
      this.checkState(0);
    }, "waitLoading");
  }

  /** PVEGame.StartGame (PVEGame.cs:2009) */
  private startGame(): void {
    if ((this.state as number) !== GameState.Loading) return;
    this.state = GameState.GameStart;
    if (this.loadingWait) this.loadingWait.done = true;
    this.emit({ cmd: "SYNC_LIFETIME", livingId: 0, lifeTime: this.lifeTime });
    this.TotalKillCount = 0;
    this.TotalNpcGrade = 0;
    this.TotalNpcExperience = 0;
    this.totalHurt = 0;
    this.BossCardCountValue = 0;
    this.mapPos = this.pveMapPos();
    const list = this.fightPlayers;
    for (const p of list) {
      if (!p.isLiving && !this.turnQueue.includes(p)) this.turnQueue.push(p);
      p.reset();
      const pt = this.playerPoint();
      p.place(pt.x, pt.y);
      this.map.addPhysical(p);
      p.startMoving();
      p.direction = pt.x < 600 ? 1 : -1;
    }
    this.emit({
      cmd: "START_GAME", livingId: 0,
      players: list.map((p) => ({
        id: p.id, x: p.x, y: p.y, direction: p.direction, blood: p.blood, maxBlood: p.maxBlood, team: p.team,
        weaponRefineryLevel: p.spec.weapon.refineryLevel ?? 0, powerRatio: 50, dander: p.dander, buffs: [], isFrost: p.isFrost, isHide: p.isHide, isNoHole: p.isNoHole,
      })),
    });
    this.runScript("mission.OnPrepareStartGame", () => this.missionAI.OnPrepareStartGame());
    this.SendUpdateUiData();
    this.waitTime(this.players.length * 2500 + 1000);
  }

  /** MapMgr.GetPVEMapRandomPos + BaseGame.GetPlayerPoint(team 1 → PosX) */
  private pveMapPos(): { posX: Point[]; posX1: Point[] } {
    const parse = (s?: string) =>
      (s ?? "").split("|").map((t) => t.split(",").map(Number)).filter((a) => a.length === 2 && a.every(Number.isFinite)).map(([x, y]) => ({ x: x!, y: y! }));
    return { posX: parse(this.map.info.posX), posX1: parse(this.map.info.posX1) };
  }
  private playerPoint(): Point {
    const l = this.mapPos?.posX ?? [];
    if (l.length) return l.splice(this.rng.nextMax(l.length), 1)[0]!;
    const l2 = this.mapPos?.posX1 ?? [];
    if (l2.length) return l2.splice(this.rng.nextMax(l2.length), 1)[0]!;
    return { x: 200 + this.rng.nextMax(200), y: 0 };
  }

  /** PVEGame.PrepareNewGame (PVEGame.cs:1564) */
  private prepareNewGame(): void {
    if ((this.state as number) !== GameState.GameStart) return;
    this.state = GameState.Playing;
    this.BossCardCountValue = 0;
    this.emit({ cmd: "SYNC_LIFETIME", livingId: 0, lifeTime: this.lifeTime });
    this.waitTime(this.players.length * 1000);
    this.runScript("mission.OnPrepareNewGame", () => this.missionAI.OnPrepareNewGame());
    this.runScript("mission.OnStartGame", () => this.missionAI.OnStartGame());
  }
  private prepareFightingLivings(): void {
    if ((this.state as number) !== GameState.GameStart) return;
    this.state = GameState.Playing;
    this.emit({ cmd: "SYNC_LIFETIME", livingId: 0, lifeTime: this.lifeTime });
    this.waitTime(this.players.length * 1000);
    this.runScript("mission.OnPrepareNewGame", () => this.missionAI.OnPrepareNewGame());
  }
  private waitingGameState(): void {
    const s = this.state as number;
    if (s === GameState.Playing || s === GameState.Waiting) {
      this.state = this.gameStateModify as typeof this.state;
      this.runScript("mission.OnWaitingGameState", () => this.missionAI.OnWaitingGameState());
    }
  }
  private prepareGameOver(): void {
    if ((this.state as number) !== GameState.Playing) return;
    this.state = GameState.PrepareGameOver;
    this.runScript("mission.OnPrepareGameOver", () => this.missionAI.OnPrepareGameOver());
  }
  private isCanPrepareGameOver(): boolean {
    const id = this.map.info.id;
    return id === 1166 || id === 1207 || id === 1209 || id === 1216;
  }

  /** PVEGame.CanGameOver (PVEGame.cs:432) */
  override canGameOver(): boolean {
    const fp = this.fightPlayers;
    if (fp.length === 0) return true;
    if (fp.every((p) => !p.isLiving)) {
      this.IsWin = false;
      return true;
    }
    return this.runScript("mission.CanGameOver", () => this.missionAI.CanGameOver(), true) ?? true;
  }

  /** BaseGame.FindAllTurnLiving + FindNextTurnedLiving (BaseGame.cs:491) */
  private findNextTurnedLivingPve(): TurnedLiving | null {
    const list = this.turnQueue.filter((t) => (t instanceof Player ? t.isLiving && t.isActive : t instanceof SimpleBoss && t.config.IsTurn && t.isLiving));
    if (list.length === 0) return null;
    let t = list[this.rng.nextMax(list.length)]!;
    let d = t.delay;
    for (const l of list)
      if (l.delay < d && l.isLiving) {
        d = l.delay;
        t = l;
      }
    t.turnNum++;
    return t;
  }

  /** PVEGame.MinusDelays + BaseGame.MinusDelays */
  private minusDelays(v: number): void {
    this.PveGameDelay = Math.max(0, this.PveGameDelay - v);
    for (const t of this.turnQueue) t.delay -= v;
  }

  /** PVEGame.ConfigLivingSayRule (PVEGame.cs:1323) */
  private configLivingSayRule(): void {
    const n = this.livings.length;
    if (n === 0) return;
    for (const l of this.livings) l.isSay = false;
    if (this.turnIndex % 2 === 0) return;
    const say = n <= 5 ? this.rng.nextRange(0, 2) : n > 10 ? this.rng.nextRange(1, 4) : this.rng.nextRange(1, 3);
    let i = 0, guard = 0;
    while (i < say && guard++ < 100) {
      const l = this.livings[this.rng.nextRange(0, n)]!;
      if (!l.isSay) {
        l.isSay = true;
        i++;
      }
    }
  }

  /** BaseGame.ClearDiedPhysicals (PvE lists) */
  private clearDiedPve(): void {
    for (const l of [...this.livings]) if (!l.isLiving) {
      this.livings.splice(this.livings.indexOf(l), 1);
      l.dispose();
    }
    for (const t of [...this.turnQueue]) if (!t.isLiving && !(t instanceof Player)) this.turnQueue.splice(this.turnQueue.indexOf(t), 1);
    for (const p of [...this.map.physics]) if (!p.isLiving && !(p instanceof Player)) this.map.removePhysical(p);
  }

  /** PVEGame.NextTurn (PVEGame.cs:1387-1493) */
  private nextTurnPve(): void {
    if ((this.state as number) !== GameState.Playing) return;
    this.IsPassDrama = false;
    this.clearWaitTimer();
    this.clearDiedPve();
    this.checkBox();
    this.configLivingSayRule();
    for (const ph of [...this.map.physics]) {
      ph.prepareNewTurn();
      if (ph instanceof Living && !(ph instanceof Player) && ph.config.isShowBlood && ph.blood > 0) ph.addBlood(0, 1);
    }
    const newBoxes = this.createBox(); // PVEGame.cs:1403
    this.runScript("mission.OnNewTurnStarted", () => this.missionAI.OnNewTurnStarted());
    const cur = this.findNextTurnedLivingPve();
    this.currentLiving = cur;
    if (cur) {
      this.turnIndex++;
      this.SendUpdateUiData();
      if (cur instanceof SimpleBoss && cur.config.IsShowBloodBar) this.raw(73, 0, [["i32", cur.id]]);
      const npcs = this.livings.filter((l) => l.isLiving && l instanceof SimpleNpc && l.config.IsTurn);
      if (npcs.length > 0 && cur.delay >= this.PveGameDelay) {
        this.minusDelays(this.PveGameDelay);
        for (const l of [...this.livings]) {
          l.prepareSelfTurn();
          if (!l.isFrost) l.startAttacking();
        }
        this.sendNextTurn(npcs[0] as unknown as TurnedLiving, newBoxes);
        for (const l of this.livings) if (l.isAttacking) l.stopAttacking();
        this.PveGameDelay += this.missionInfo?.IncrementDelay ?? 0;
        this.checkState(0);
      } else {
        this.minusDelays(cur.delay);
        if (cur instanceof Player) this.updateWind(this.getNextWind(), false);
        cur.prepareSelfTurn();
        if (!cur.isFrost && !cur.blockTurn && cur.isLiving) {
          cur.startAttacking();
          this.emit({ cmd: "SYNC_LIFETIME", livingId: 0, lifeTime: this.lifeTime });
          this.sendNextTurn(cur, newBoxes);
          if (cur.isAttacking) {
            const ti = this.turnIndex;
            this.attackWait = this.addAction((this.timeType + 20) * 1000, () => {
              if (this.turnIndex === ti && cur.isAttacking) {
                cur.stopAttacking();
                this.checkState(0);
              }
            }, "waitAttack");
          }
        }
      }
    }
    this.runScript("mission.OnBeginNewTurn", () => this.missionAI.OnBeginNewTurn());
  }

  /** BaseGame.SendGameNextTurn with the NPC/boss as current living */
  protected override sendNextTurn(l: TurnedLiving, newBoxes: Box[] = []): void {
    super.sendNextTurn(l, newBoxes);
  }

  override enemiesOf(_bot: Living): Living[] {
    return [...this.livings, ...this.turnQueue].filter((l) => l.isLiving && !(l instanceof Player) && l.config.CanTakeDamage && !l.config.IsHelper);
  }
  override bodiesFor(bot: Living): Living[] {
    return [...this.livings, ...this.turnQueue].filter((l) => l.isLiving && l !== bot);
  }
  /** PVEGame.living_Died (PVEGame.cs:1238) */
  override onLivingDied(l: Living): void {
    const cur = this.currentLiving;
    if (cur instanceof Player && !(l instanceof Player) && l !== cur && l.config.CanCountKill) {
      this.TotalKillCount++;
      this.TotalNpcExperience += l.experience;
      this.TotalNpcGrade += l.grade;
    }
    if (!(l instanceof Player)) this.runScript("mission.OnDied", () => this.missionAI.OnDied());
  }
  override onBombShooted(): void {
    this.runScript("mission.OnShooted", () => this.missionAI.OnShooted());
  }

  // ------------------------------------------------------------------------------------------- game over
  hasNextSession(): boolean {
    if (this.fightPlayers.length === 0 || !this.IsWin || this.isShowLargeCards()) return false;
    return this.Misssions.has(this.SessionId + 1);
  }
  private isShowLargeCards(): boolean {
    return this.IsWin && this.Misssions.has(this.SessionId + 1) && (this.info.ID === 5 || this.info.ID === 14);
  }
  private isTrainer(): boolean {
    return this.roomType === eRoomType.Freshman;
  }
  private nextHardLevel(h: number): number {
    return h === eHardLevel.Easy ? eHardLevel.Normal : h === eHardLevel.Normal ? eHardLevel.Hard : h === eHardLevel.Hard ? eHardLevel.Terror : eHardLevel.Epic;
  }

  /** PVEGame.CalculateExperience (PVEGame.cs:365) */
  calculateExperience(p: Player): number {
    if (this.suppressDefaultRewards) return 0;
    if (this.TotalKillCount === 0) return 1;
    const gap = Math.abs(p.grade - this.TotalNpcGrade / this.TotalKillCount);
    if (gap >= 7) return 1;
    let share = 0;
    if (this.TotalKillCount > 0) share += (p.totalKill / this.TotalKillCount) * 0.4;
    if (this.totalHurt > 0) share += (p.totalHurt / this.totalHurt) * 0.4;
    if (p.isLiving) share += 0.4;
    const lk = gap >= 3 && gap <= 4 ? 0.7 : gap >= 5 && gap <= 6 ? 0.4 : 1;
    const tk = (0.9 + (this.beginPlayersCount - 1) * 0.4) / this.players.length;
    let e = this.TotalNpcExperience * share * lk * tk;
    if (e === 0) e = 1;
    return Math.trunc(e);
  }
  /** PVEGame.CalculateScore (PVEGame.cs:414) */
  calculateScore(p: Player): number {
    let n = (200 - this.turnIndex) * 5 + p.totalKill * 5 + Math.trunc(p.blood / p.maxBlood) * 10;
    if (!this.IsWin) n -= 400;
    return n;
  }

  /** PVEGame.GameOver (PVEGame.cs:773-919) */
  private gameOver(): void {
    const s = this.state as number;
    if (s !== GameState.Playing && s !== GameState.PrepareGameOver) return;
    this.state = GameState.GameOver;
    this.SendUpdateUiData();
    this.runScript("mission.OnGameOver", () => this.missionAI.OnGameOver());
    const mi = this.missionInfo!;
    let cards = 1;
    this.TakeCardId = mi.Id;
    const isEndSession = this.hasNextSession();
    if (!this.IsWin || !isEndSession) cards = 0;
    if (this.IsWin && !isEndSession && !this.isTrainer()) cards = 2; // PVEGame.cs:798 (isEndSession = HasNextSession)
    if (this.suppressDefaultRewards) cards = 0;
    this.BossCardCountValue = cards;
    this.showCardsSent = false;
    if (cards > 0) this.bossCards = new Array(9).fill(0);
    const showLarge = isEndSession || this.isShowLargeCards();
    const players = this.fightPlayers.map((p) => {
      const x = this.pp.get(p)!;
      for (const k of [...p.effects.keys()]) p.stopEffect(k);
      const exp = this.calculateExperience(p);
      const score = this.calculateScore(p);
      x.canTakeOut = cards;
      if (p.currentIsHitTarget) p.totalHitTargetCount++;
      x.totalAllHurt += p.totalHurt;
      x.totalAllCure += p.totalCure;
      x.totalAllKill += p.totalKill;
      x.gainGP = exp;
      x.totalAllExperience += exp;
      x.totalAllScore += score;
      x.bossCardCount = cards;
      x.ready = false;
      x.finishTakeCard = false;
      return { userId: p.spec.userId, livingId: p.id, grade: p.grade, gainGP: exp, isWin: this.IsWin, bossCardCount: cards, turnNum: p.turnNum };
    });
    this.emit({
      cmd: "GAME_MISSION_OVER", livingId: 0, bossCardCount: cards, showLarge, pic: `show${1 + this.SessionId}.jpg`, missionId: mi.Id, isWin: this.IsWin,
      players, resources: cards > 0 ? [...this.gameOverResources] : null,
    });
  }
  bossCards: number[] | null = null;
  private showCardsSent = false;

  /** PVEGame.GameOverAllSession (PVEGame.cs:944-1011) */
  private gameOverAllSession(): void {
    if ((this.state as number) !== GameState.GameOver) return;
    this.state = GameState.ALLSessionStopped;
    this.runScript("game.OnGameOverAllSession", () => this.gameAI.OnGameOverAllSession());
    const n = this.suppressDefaultRewards || !this.IsWin ? 0 : this.roomType === eRoomType.Dungeon ? 2 : 1;
    const players = this.fightPlayers.map((p) => {
      const x = this.pp.get(p)!;
      x.canTakeOut = n;
      x.finishTakeCard = false;
      return { userId: p.spec.userId, totalKill: x.totalAllKill, totalHurt: x.totalAllHurt, totalScore: x.totalAllScore, totalCure: x.totalAllCure, totalExp: x.totalAllExperience, isWin: this.IsWin, canTakeOut: n, turnNum: p.turnNum };
    });
    this.cards.fill(0);
    this.showCardsSent = false;
    this.emit({ cmd: "GAME_ALL_MISSION_OVER", livingId: 0, isWin: this.IsWin, roomType: this.roomType, gameType: this.gameType, players, resources: [...this.gameOverResources] });
    this.waitTime(this.isShowLargeCards() ? 16000 : 23000);
    // CanStopGame
    if (this.IsWin && this.Misssions.has(this.SessionId + 1) && (this.info.ID === 5 || this.info.ID === 14)) this.WantTryAgain = 1;
  }

  /** PVEGame.Stop (PVEGame.cs:2104) */
  private stopPve(): void {
    if ((this.state as number) !== GameState.ALLSessionStopped) return;
    if (this.IsWin) {
      for (const p of this.fightPlayers) {
        const x = this.pp.get(p)!;
        const n = x.canTakeOut;
        for (let i = 0; i < n; i++) this.takeCardAuto(p);
      }
      if (this.roomType === eRoomType.Dungeon) this.sendShowCards();
    }
    this.emit({ cmd: "PVE_STOPPED", livingId: 0, isWin: this.IsWin, hasNextMission: this.Misssions.has(this.SessionId + 1) });
    this.stop();
  }

  /** PVEGame.SendShowCards: remaining cards revealed (CopySystemDrop simplified to CopyDrop(id, 1)) */
  private sendShowCards(): void {
    const free = this.cards.map((c, i) => (c === 0 ? i : -1)).filter((i) => i >= 0);
    const body: RawField[] = [["i32", free.length]];
    for (const i of free) {
      const it = this.drops.copyDrop?.(this.missionInfo?.Id ?? 0, 1)?.[0];
      body.push(["u8", i], ["i32", it?.templateId ?? 0], ["i32", it?.count ?? 0]);
    }
    this.raw(89, 0, body);
  }

  takeCardAuto(p: Player): boolean {
    const i = this.cards.findIndex((c) => c === 0);
    return this.takeCard(p, i < 0 ? 0 : i, true);
  }
  /** PVEGame.TakeCard (PVEGame.cs:2180) */
  takeCard(p: Player, index: number, isAuto: boolean): boolean {
    const x = this.pp.get(p);
    if (!x || x.canTakeOut === 0 || !p.isActive || x.finishTakeCard) return false;
    if (index < 0 || index >= this.cards.length || this.cards[index]! > 0) {
      const f = this.cards.findIndex((c) => c === 0);
      if (f < 0) return false;
      index = f;
      isAuto = true;
    }
    let templateId = 0, count = 0;
    const id = this.TakeCardId === 0 ? (this.missionInfo?.Id ?? 0) : this.TakeCardId;
    const items = this.drops.copyDrop?.(id, 1) ?? null;
    if (items?.length) {
      for (const it of items) {
        templateId = it.templateId;
        count = it.count;
      }
      this.emit({ cmd: "PVE_AWARD", livingId: p.id, userId: p.spec.userId, items, bag: "temp" });
    }
    if (this.roomType === eRoomType.Dungeon) {
      x.canTakeOut--;
      if (x.canTakeOut === 0) x.finishTakeCard = true;
    } else x.finishTakeCard = true;
    this.cards[index] = 1;
    this.raw(98, p.id, [["bool", isAuto], ["u8", index], ["i32", templateId], ["i32", count], ["bool", false]]);
    return true;
  }

  /** SimpleNpc.GetDropItemInfo: NPCDrop for the player whose turn it is */
  npcDrop(npc: SimpleNpc): void {
    if (this.suppressDefaultRewards) return;
    const cur = this.currentLiving;
    if (!(cur instanceof Player) || !npc.npcInfo.DropId) return;
    const items = this.drops.npcDrop?.(npc.npcInfo.DropId) ?? null;
    if (items?.length) this.emit({ cmd: "PVE_AWARD", livingId: cur.id, userId: cur.spec.userId, items, bag: "fight" });
  }

  // ------------------------------------------------------------------------------------------- commands
  override handle(userId: number, c: FightCommand, now: number = this.now): FightEvent[] {
    const p = this.findByUser(userId);
    if (!p) return super.handle(userId, c, now);
    const s = this.state as number;
    switch (c.cmd) {
      case "MISSION_PREPARE":
        // MissionPrepareCommand (116): ready flag, echoed to all
        if (s === GameState.SessionPrepared || s === GameState.GameOver) {
          const x = this.pp.get(p)!;
          if (x.ready !== c.ready) {
            x.ready = c.ready;
            this.raw(116, p.id, [["bool", c.ready]]);
          }
          this.checkState(0);
        }
        return this.drain();
      case "TAKE_CARD":
        if (this.suppressDefaultRewards) return this.drain();
        this.now = Math.max(this.now, now);
        if (this.pp.get(p)!.canTakeOut > 0) this.takeCard(p, c.index, false);
        else if ((c.index < 0 || c.index >= this.cards.length) && !this.showCardsSent) {
          // The card board's countdown sends TAKE_CARD(100) even when every pick is spent; the board only closes on an
          // auto pick or on SHOW_CARDS, so reveal the rest now (deviation: the C# stayed silent → board frozen at "00").
          this.showCardsSent = true;
          this.sendShowCards();
        }
        return this.drain();
      case "PASS_DRAMA":
        if (s !== GameState.Playing) {
          this.IsPassDrama = c.pass;
          this.checkState(0);
        }
        return this.drain();
      case "TRY_AGAIN":
        // TryAgainCommand (119): the donor server always gives up (try-again disabled)
        this.raw(119, p.id, [["i32", c.tryAgain], ["bool", c.isHost]]);
        this.WantTryAgain = 0;
        this.raw(119, 0, [["i32", 0]]);
        if (s === GameState.ALLSessionStopped) this.stopPve();
        return this.drain();
      case "DELIVER":
        // TransmissionGateCommand (137): stepping onto the gate readies the player for the next floor; unlike
        // MISSION_PREPARE(116) this only ever sets Ready (never clears it) and isn't echoed to other clients.
        if ((s === GameState.SessionPrepared || s === GameState.GameOver) && c.ready) {
          this.pp.get(p)!.ready = true;
          this.checkState(0);
        }
        return this.drain();
      case "MISSION_EVENT":
        if (s === GameState.Playing) {
          // GSPacketIn-like reader over the ints that followed the sub (scripts call packet.ReadInt())
          let i = 0;
          const pkt = { ReadInt: () => c.data[i++] ?? 0, ReadBoolean: () => (c.data[i++] ?? 0) !== 0, ReadByte: () => c.data[i++] ?? 0 };
          this.runScript("mission.OnGeneralCommand", () => this.missionAI.OnGeneralCommand(pkt));
        }
        return this.drain();
    }
    return super.handle(userId, c, now);
  }

  /** PVEGame.RemovePlayer: the player leaves the turn queue (−grade·12 GP applied by the server) */
  override removePlayer(userId: number): boolean {
    const p = this.findByUser(userId);
    if (!p || !p.isActive) return false;
    const fled = super.removePlayer(userId);
    const i = this.turnQueue.indexOf(p);
    if (i >= 0) this.turnQueue.splice(i, 1);
    return fled;
  }

  // ===========================================================================================================
  // Living action timeline (Actions/Living*Action.cs). Each is a BaseAction(delay, finishDelay) step action.
  // ===========================================================================================================
  emitMoveTo(l: Living, fx: number, fy: number, tx: number, ty: number, action: string, speed: number, sAction: string): void {
    this.raw(55, l.id, [["i32", fx], ["i32", fy], ["i32", tx], ["i32", ty], ["i32", speed], ["str", action ?? ""], ["str", sAction ?? ""]]);
  }
  setLivingDirection(l: Living, d: number): void {
    d = d >= 0 ? 1 : -1;
    if (l.direction !== d) {
      l.direction = d;
      resetRectWithDir(l);
      if (l.syncAtTime) this.raw(7, l.id, [["i32", d]]);
    }
  }
  livingCallFunction(l: Living, fn: (() => void) | null | undefined, delay: number): void {
    if (!fn) return;
    this.addStepAction(delay, 0, () => {
      this.runScript("CallFuction", fn);
      return true;
    });
  }
  /** Living.MoveTo (Living.cs:1213) + LivingMoveToAction */
  livingMoveTo(l: Living, x: number, y: number, action: string, sAction: string, speed: number, delay: number, cb?: (() => void) | null, delayCallback = 0): boolean {
    x = int(x);
    y = int(y);
    speed = int(speed) || 3;
    if (l.x === x && l.y === y) return false;
    if (x < 0 || !l.map || x > this.map.bound.width) return false;
    const path: Point[] = [];
    let tx = l.x, ty = l.y;
    const dir = x > tx ? 1 : -1;
    if (l.config.IsFly) {
      let cx = tx, cy = ty;
      for (let guard = 0; guard < 5000; guard++) {
        const ox = x - cx, oy = y - cy;
        const len = Math.sqrt(ox * ox + oy * oy);
        if (len > speed) {
          cx += int((ox / len) * speed);
          cy += int((oy / len) * speed);
          path.push({ x: cx, y: cy });
        } else {
          path.push({ x, y });
          break;
        }
      }
    } else {
      for (let guard = 0; guard < 5000 && (x - tx) * dir > 0; guard++) {
        const s1164 = this.map.info.id === 1164;
        const p = this.map.findNextWalkPointDown(tx, ty, dir, speed * (s1164 ? 1 : 3), speed * (s1164 ? 3 : 7));
        if (isEmptyPoint(p)) break;
        path.push(p);
        tx = p.x;
        ty = p.y;
      }
    }
    if (!path.length) return false;
    let sent = false, idx = 0;
    this.addStepAction(delay, 0, () => {
      if (!sent) {
        sent = true;
        this.emitMoveTo(l, l.x, l.y, path[path.length - 1]!.x, path[path.length - 1]!.y, action, speed, sAction);
      }
      idx++;
      if (idx >= path.length) {
        const last = path[idx - 1]!;
        this.setLivingDirection(l, last.x > l.x ? 1 : -1);
        l.setXY(last.x, last.y);
        if (cb) this.livingCallFunction(l, cb, delayCallback);
        return true;
      }
      return false;
    }, "move");
    return true;
  }
  /** Living.FallFrom + LivingFallingAction(delay, 2000) */
  livingFallFrom(l: Living, x: number, y: number, action: string | null, delay: number, type: number, speed: number, cb?: (() => void) | null): boolean {
    let p = this.map.findYLineNotEmptyPointDown(int(x), int(y));
    if (isEmptyPoint(p)) p = { x: int(x), y: this.map.bound.height + 1 };
    if (l.y < p.y) {
      this.livingFallTo(l, p.x, p.y, action, delay, type, speed, cb);
      return true;
    }
    return false;
  }
  livingFallTo(l: Living, toX: number, toY: number, action: string | null, delay: number, type: number, speed: number, cb?: (() => void) | null): void {
    speed = int(speed) || 10;
    let sent = false;
    this.addStepAction(delay, 2000, () => {
      if (!sent) {
        sent = true;
        this.raw(56, l.id, [["i32", toX], ["i32", toY], ["i32", speed], ["str", action ?? ""], ["i32", type]]);
      }
      if (toY > l.y + speed) {
        l.setXY(toX, l.y + speed);
        return false;
      }
      l.setXY(toX, toY);
      if (this.map.isOutMap(toX, toY)) {
        l.syncAtTime = false;
        l.die();
        l.syncAtTime = true;
      }
      if (cb) this.livingCallFunction(l, cb, 0);
      return true;
    }, "fall");
  }
  /** Living.JumpTo + LivingJumpAction */
  livingJumpTo(l: Living, x: number, y: number, action: string, delay: number, type: number, speed = 20, cb?: (() => void) | null, value = 0): boolean {
    const p = this.map.findYLineNotEmptyPointDown(int(x), int(y));
    if (p.y >= l.y && value !== 1) return false;
    speed = int(speed) || 20;
    let sent = false;
    this.addStepAction(delay, 2000, () => {
      if (!sent) {
        sent = true;
        this.raw(57, l.id, [["i32", p.x], ["i32", p.y], ["i32", speed], ["str", action ?? ""], ["i32", type]]);
      }
      if (p.y < l.y - speed) {
        l.setXY(p.x, l.y - speed);
        return false;
      }
      l.setXY(p.x, p.y);
      if (cb) this.livingCallFunction(l, cb, 0);
      return true;
    }, "jump");
    return true;
  }
  /** Living.MakeDamage (Living.cs:1133) — melee / range base damage */
  livingMakeDamage(l: Living, target: Living): number {
    let guard = target.baseGuard, def = target.defence;
    if (target instanceof Player) {
      const a = target.armorBonus();
      guard += a;
      def += a;
    }
    if (l.ignoreArmor || target.config.CancelGuard) {
      guard = 0;
      def = 0;
    }
    const g = (0.95 * (guard - 3 * l.grade)) / (500 + guard - 3 * l.grade);
    const d = def - l.lucky < 0 ? 0 : (0.95 * (def - l.lucky)) / (600 + def - l.lucky);
    const v = l.baseDamage * (1 + l.attack * 0.001) * (1 - (g + d - g * d)) * f32(l.currentDamagePlus) * f32(l.currentShootMinus);
    return v < 0 ? 1 : Math.trunc(v);
  }
  /** Living.Beat (Living.cs:744) + LivingBeatAction */
  livingBeat(l: Living, target: Living | null, action: string, _dmg: number, crit: number, delay: number, livingCount = 1, attackEffect = 1): boolean {
    if (!target || !target.isLiving) return false;
    const d = { damage: this.livingMakeDamage(l, target), critical: crit | 0 };
    l.onBeforeTakedDamage(target, d);
    if (int(target.damageDistance({ x: l.x, y: l.y })) > l.maxBeatDis) return false;
    this.setLivingDirection(l, l.x - target.x > 0 ? -1 : 1);
    this.addStepAction(delay, 0, () => {
      target.syncAtTime = false;
      try {
        if (target.takeDamage(l, d)) {
          const dander = target instanceof Player ? target.dander : 0;
          const body: RawField[] = [["str", action ?? ""], ["i32", livingCount]];
          for (let i = 1; i <= livingCount; i++) body.push(["i32", target.id], ["i32", d.damage + d.critical], ["i32", target.blood], ["i32", dander], ["i32", attackEffect]);
          this.raw(58, l.id, body);
        }
        target.isFrost = false;
      } finally {
        target.syncAtTime = true;
      }
      return true;
    }, "beat");
    return true;
  }
  /** Living.GetShootForceAndAngle (Living.cs:1019) */
  shootForceAndAngle(l: Living, tx: number, ty: number, ballId: number, minTime: number, maxTime: number, time: number): { x: number; y: number; force: number; angle: number } | null {
    if (minTime >= maxTime) return null;
    const ball = this.assets.ball(ballId);
    if (!ball) return null;
    const sp = l.getShootPoint();
    const dx = f32(tx - sp.x), dy = f32(ty - sp.y);
    const af = f32(this.map.airResistance * ball.dragIndex);
    const f = f32(f32(this.map.gravity * ball.weight) * ball.mass);
    const fw = f32(this.map.wind * ball.wind);
    const m = f32(ball.mass);
    let force = 0, angle = 0, found = false;
    for (let t = f32(time); t <= 4; t = f32(t + f32(0.6))) {
      // Living.ComputeVx/ComputeVy: (dx - (double)(f / m * t * t / 2f)) / t + (af / m) * dx * k
      const vx = (dx - f32(f32(f32(f32(fw / m) * t) * t) / 2)) / t + f32(af / m) * dx * 0.7;
      const vy = (dy - f32(f32(f32(f32(f / m) * t) * t) / 2)) / t + f32(af / m) * dy * 1.3;
      if (vy >= 0 || vx * l.direction <= 0) continue;
      const v = Math.sqrt(vx * vx + vy * vy);
      if (v < 2000) {
        force = Math.trunc(v);
        angle = Math.trunc((Math.atan(vy / vx) / Math.PI) * 180);
        if (vx < 0) angle += 180;
        found = true;
        break;
      }
    }
    return found ? { x: sp.x, y: sp.y, force, angle } : { x: sp.x, y: sp.y, force: 0, angle: 0 };
  }
  /** Living.ShootPoint (Living.cs:1915) + LivingShootAction(delay, 1000) */
  livingShootPoint(l: Living, x: number, y: number, ballId: number, minTime: number, maxTime: number, bombCount: number, time: number, delay: number, cb?: (() => void) | null): boolean {
    this.addStepAction(delay, 1000, () => {
      const r = this.shootForceAndAngle(l, int(x), int(y), ballId, minTime, maxTime, time);
      if (!r) return true;
      const before = this.getWaitTimer();
      if (this.shootImp(l, ballId, r.x, r.y, r.force, r.angle, bombCount, 0)) {
        l.lastLifeTimeShoot = Math.max(0, this.getWaitTimer() - Math.max(before, this.now));
        if (cb) this.livingCallFunction(l, cb, l.lastLifeTimeShoot);
      }
      return true;
    }, "shoot");
    return true;
  }
  livingSay(l: Living, msg: string, type: number, delay: number, finish = 1000): void {
    this.addStepAction(delay, finish, () => {
      this.raw(59, l.id, [["str", String(msg ?? "")], ["i32", type]]);
      return true;
    }, "say");
  }
  livingPlayMovie(l: Living, action: string, delay: number, movieTime: number, cb?: (() => void) | null): void {
    this.addStepAction(delay, movieTime, () => {
      this.raw(60, l.id, [["str", action ?? ""]]);
      if (cb) this.livingCallFunction(l, cb, movieTime);
      return true;
    }, "movie");
  }
  physPlayMovie(o: PhysicalObj, action: string, delay: number, movieTime: number): void {
    this.addStepAction(delay, movieTime, () => {
      o.currentAction = action;
      this.raw(66, 0, [["i32", o.id], ["str", action ?? ""]]);
      return true;
    }, "objmovie");
  }
  livingChangeDirection(l: Living, dir: number, delay: number): void {
    if (delay > 0) this.addStepAction(delay, 0, () => (this.setLivingDirection(l, dir), true));
    else this.setLivingDirection(l, dir);
  }
  livingDie(l: Living, delay: number, sendToClient = false): void {
    if (!l.isLiving) return;
    this.addStepAction(delay, 1000, () => {
      if (sendToClient && l.blood > 0) {
        l.blood = 0;
        this.emit({ cmd: "HEALTH", livingId: l.id, type: 6, blood: 0, value: 0 });
      }
      l.die();
      return true;
    }, "die");
  }
  livingBoltMove(l: Living, x: number, y: number, delay: number): void {
    this.addStepAction(delay, 0, () => {
      l.setXY(int(x), int(y));
      this.raw(72, l.id, [["i32", l.x], ["i32", l.y]]);
      return true;
    });
  }
  /** Living.RangeAttacking + LivingRangeAttackingAction(delay, 1000) */
  livingRangeAttacking(l: Living, fx: number, tx: number, action: string, delay: number, removeFrost: boolean, directDamage: boolean, players: Player[] | null): boolean {
    this.addStepAction(delay, 1000, () => {
      let targets: Living[] = (players && players.length ? players : this.players).filter((p) => p.isLiving && p.x >= fx && p.x <= tx);
      if (l instanceof Player) targets = [...this.livings, ...this.turnQueue.filter((t) => !(t instanceof Player)), ...this.players].filter((x) => x.isLiving);
      const list = targets.filter((t) => !l.isFriendly(t));
      const body: RawField[] = [["i32", list.length]];
      l.syncAtTime = false;
      try {
        for (const t of list) {
          t.syncAtTime = false;
          if (t.isHide) t.isHide = false;
          if (removeFrost && t.isFrost) t.isFrost = false;
          let dmg = this.livingMakeDamage(l, t);
          if (!directDamage) {
            const r = t.getDirectDemageRect();
            const dist = Math.sqrt((r.x - l.x) ** 2 + (r.y - l.y) ** 2);
            dmg = Math.trunc(dmg * (1 - dist / Math.max(1, Math.abs(tx - fx)) / 4));
            if (dmg < 0) dmg = 1;
          }
          const lucky = l.lucky;
          const crit = (75000 * lucky) / (lucky + 800) <= this.rng.nextMax(100000) ? 0 : Math.trunc((0.5 + lucky * 0.0003) * dmg);
          const d = { damage: dmg, critical: crit };
          let total = 0;
          if (t.takeDamage(l, d)) total = d.damage + d.critical;
          body.push(["i32", t.id], ["i32", total], ["i32", t.blood], ["i32", t instanceof Player ? t.dander : 0], ["i32", 1]);
        }
        this.raw(61, l.id, body);
      } finally {
        l.syncAtTime = true;
        for (const t of list) t.syncAtTime = true;
      }
      return true;
    }, "range");
    return true;
  }

  // ===========================================================================================================
  // C# PVEGame / BaseGame API used by scripts (names and overloads as in C#)
  // ===========================================================================================================
  get Random(): { Next(a?: number, b?: number): number; NextDouble(): number } {
    const r = this.rng;
    return { Next: (a?: number, b?: number) => rngNext(r, a, b), NextDouble: () => r.nextDouble() };
  }
  get TurnIndex(): number { return this.turnIndex; }
  set TurnIndex(v: number) { this.turnIndex = v; }
  get PlayerCount(): number { return this.fightPlayers.length; }
  get MissionInfo(): MissionInfo { return this.missionInfo!; }
  get MissionAI(): AMissionControl { return this.missionAI; }
  get Info(): PveInfo { return this.info; }
  get HandLevel(): number { return this.hardLevel; }
  get RoomType(): number { return this.roomType; }
  get GameType(): number { return this.gameType; }
  get GameState(): number { return this.state; }
  get GameStateModify(): number { return this.gameStateModify; }
  set GameStateModify(v: number) { this.gameStateModify = v; }
  get CurrentLiving(): TurnedLiving | null { return this.currentLiving; }
  get CurrentPlayer(): Player | null { return this.currentLiving instanceof Player ? this.currentLiving : null; }
  get CurrentTurnLiving(): TurnedLiving | null { return this.currentLiving; }
  get TurnQueue(): CsList<TurnedLiving> { return CsList.from2(this.turnQueue); }
  get Players(): Map<number, Player> { return new Map(this.players.map((p) => [p.id, p])); }
  get Map(): { Info: { ID: number }; Bound: { Width: number; Height: number; X: number; Y: number }; wind: number; IsEmpty(x: number, y: number): boolean; IsOutMap(x: number, y: number): boolean; FindYLineNotEmptyPointDown(x: number, y: number): { X: number; Y: number } } {
    const m = this.map;
    return {
      Info: { ID: m.info.id }, Bound: { Width: m.bound.width, Height: m.bound.height, X: 0, Y: 0 }, wind: m.wind,
      IsEmpty: (x, y) => m.isEmpty(int(x), int(y)), IsOutMap: (x, y) => m.isOutMap(int(x), int(y)),
      FindYLineNotEmptyPointDown: (x, y) => { const p = m.findYLineNotEmptyPointDown(int(x), int(y)); return { X: p.x, Y: p.y }; },
    };
  }
  get GameOverResources(): string[] { return this.gameOverResources; }
  get BossCardCount(): number { return this.BossCardCountValue; }
  set BossCardCount(v: number) { if (v > 0) { this.bossCards = new Array(9).fill(0); this.BossCardCountValue = v; } }
  get LifeTime(): number { return this.lifeTime; }
  get TotalHurt(): number { return this.totalHurt; }
  set TotalHurt(v: number) { this.totalHurt = v; }
  get PhysicalId(): number { return this.physicalId; }

  SetupMissions(csv: string): void {
    if (!csv) return;
    let k = 0;
    for (const s of String(csv).split(",")) {
      const id = parseInt(s, 10);
      if (!Number.isFinite(id)) continue;
      k++;
      const mi = this.data.mission(id);
      if (mi) this.Misssions.set(k, mi);
      else {
        if (this.strictScripts) throw new Error(`Required Mission_Info ${id} not found`);
        this.log(`pve: Mission_Info ${id} not found`);
      }
    }
  }
  /** BaseGame.SetMap (BaseGame.cs:3037) */
  SetMap(mapId: number): boolean {
    if (!this.assets.maps.has(mapId)) {
      this.log(`pve: map ${mapId} not packed`);
      return false;
    }
    const old = [...this.map.physics];
    this.map = this.assets.createMap(mapId);
    for (const p of old) if (p instanceof Player) this.map.addPhysical(p);
    this.MapHistoryIds.push(mapId);
    return true;
  }
  AddLoadingFile(type: number, path: string, className: string): void {
    if (path != null && className != null) this.loadingFiles.push({ type, path, className });
  }
  ClearLoadingFiles(): void { this.loadingFiles.length = 0; }
  LoadResources(ids: number[]): void {
    for (const id of ids ?? []) {
      const n = this.data.npc(id);
      if (n) this.AddLoadingFile(2, n.ResourcesPath, n.ModelID);
      else {
        if (this.strictScripts) throw new Error(`Required resource NPC ${id} missing`);
        this.log(`pve: LoadResources npc ${id} missing`);
      }
    }
  }
  LoadNpcGameOverResources(ids: number[]): void {
    for (const id of ids ?? []) {
      const n = this.data.npc(id);
      if (n) this.gameOverResources.push(n.ModelID);
    }
  }
  SendLoadResource(files: { Type?: number; Path?: string; ClassName?: string; type?: number; path?: string; className?: string }[]): void {
    if (!files?.length) return;
    const body: RawField[] = [["i32", files.length]];
    for (const f of files) body.push(["i32", f.Type ?? f.type ?? 2], ["str", f.Path ?? f.path ?? ""], ["str", f.ClassName ?? f.className ?? ""]);
    this.raw(67, 0, body);
  }
  BaseLivingConfig(): LivingConfig {
    const c = new LivingConfig();
    c.isBotom = 1; c.IsTurn = true; c.isShowBlood = true; c.isShowSmallMapPoint = true; c.ReduceBloodStart = 1;
    c.DamageForzen = false; c.CanTakeDamage = true; c.HaveShield = false; c.CancelGuard = false; c.CanCountKill = true; c.CanCollied = true; c.IsShowBloodBar = false;
    return c;
  }
  /** BaseGame.AddLiving: map + list + ADD_LIVING (64, BaseGame.cs:1935) */
  AddLiving(l: Living): void {
    this.map.addPhysical(l);
    if (l instanceof TurnedLiving) {
      if (!this.turnQueue.includes(l)) this.turnQueue.push(l);
    } else if (!this.livings.includes(l)) this.livings.push(l);
    if (!(l instanceof Player)) this.sendAddLiving(l);
  }
  sendAddLiving(l: Living): void {
    this.raw(64, l.id, [
      ["u8", l.livingType], ["i32", l.id], ["str", l.name], ["str", l.modelId], ["str", l.actionStr ?? ""], ["i32", l.x], ["i32", l.y], ["i32", l.blood], ["i32", l.maxBlood],
      ["i32", l.team], ["u8", l.direction & 0xff], ["u8", l.config.isBotom], ["bool", l.config.isShowBlood], ["bool", l.config.isShowSmallMapPoint], ["i32", 0], ["i32", 0],
      ["bool", l.isFrost], ["bool", l.isHide], ["bool", l.isNoHole], ["bool", false], ["i32", 0],
      ...(this.roomType === eRoomType.ActivityDungeon && l instanceof SimpleBoss ? ([["i32", l.npcInfo.ID]] as RawField[]) : []),
    ]);
  }
  private npcInfoOrThrow(id: number): NpcInfo {
    const n = this.data.npc(id);
    if (!n) throw new Error(`NPC_Info ${id} not found`);
    if (this.strictScripts && !n.Script) this.reportMissing("brain", `(NPC_Info ${id})`);
    return n;
  }
  /** CreateNpc(npcId, x, y, type[, direction][, action][, config]) (PVEGame.cs:324-363) */
  CreateNpc(npcId: number, x: number, y: number, type: number, ...rest: unknown[]): SimpleNpc {
    let direction = -1, action = "", config: LivingConfig | null = null;
    for (const a of rest) {
      if (typeof a === "number") direction = a;
      else if (typeof a === "string") action = a;
      else if (a instanceof LivingConfig) config = a;
    }
    const n = new SimpleNpc(this.physicalId++, this, this.npcInfoOrThrow(npcId), type, direction, action);
    n.config = config ?? this.BaseLivingConfig();
    n.reset();
    if (n.config.ReduceBloodStart > 1) n.blood = Math.trunc(n.npcInfo.Blood / n.config.ReduceBloodStart);
    n.setXY(int(x), int(y));
    this.AddLiving(n);
    n.startMoving();
    this.spawnedCount++;
    return n;
  }
  /** CreateBoss(npcId, x, y, direction, type[, action][, config]) (PVEGame.cs:632-665) */
  CreateBoss(npcId: number, x: number, y: number, direction: number, type: number, ...rest: unknown[]): SimpleBoss {
    let action = "", config: LivingConfig | null = null;
    for (const a of rest) {
      if (typeof a === "string") action = a;
      else if (a instanceof LivingConfig) config = a;
    }
    const b = new SimpleBoss(this.physicalId++, this, this.npcInfoOrThrow(npcId), direction, type, action);
    b.config = config ?? this.BaseLivingConfig();
    b.reset();
    if (b.config.ReduceBloodStart > 1) b.blood = Math.trunc(b.npcInfo.Blood / b.config.ReduceBloodStart);
    else if (b.config.IsWorldBoss && this.worldBossBlood && this.worldBossBlood > 0) b.blood = Math.min(b.blood, Math.trunc(this.worldBossBlood));
    b.setXY(int(x), int(y));
    this.AddLiving(b);
    b.startMoving();
    this.spawnedCount++;
    return b;
  }
  CreateWingBoss(npcId: number, x: number, y: number, direction: number, type: number, bloodInver = 100): SimpleBoss {
    const b = this.CreateBoss(npcId, x, y, direction, type);
    b.blood = Math.trunc(b.blood / 100) * bloodInver;
    return b;
  }
  AddPhysicalObj(o: PhysicalObj, send: boolean): void {
    this.map.addPhysical(o);
    o.game = this;
    this.physObjs.add(o);
    if (send) this.raw(48, 0, [["i32", o.id], ["i32", o.phyType], ["i32", o.x], ["i32", o.y], ["str", o.model], ["str", o.currentAction], ["i32", o.scale], ["i32", o.scale], ["i32", o.rotation], ["i32", o.phyBringToFront], ["i32", o.typeEffect]]);
  }
  CreatePhysicalObj(x: number, y: number, name: string, model: string, action: string, scale: number, rotation: number, typeEffect = 0): PhysicalObj {
    const o = new PhysicalObj(this.physicalId++, name, model, action, scale, rotation, typeEffect);
    o.setXY(int(x), int(y));
    this.AddPhysicalObj(o, true);
    return o;
  }
  Createlayer(x: number, y: number, name: string, model: string, action: string, scale: number, rotation: number, canPenetrate = false): Layer {
    const o = new Layer(this.physicalId++, name, model, action, scale, rotation, canPenetrate);
    o.setXY(int(x), int(y));
    this.AddPhysicalObj(o, true);
    return o;
  }
  Createlayerboss(x: number, y: number, name: string, model: string, action: string, scale: number, rotation: number): Layer {
    return this.Createlayer(x, y, name, model, action, scale, rotation);
  }
  CreateLayerTop(x: number, y: number, name: string, model: string, action: string, scale: number, rotation: number): LayerTop {
    const o = new LayerTop(this.physicalId++, name, model, action, scale, rotation);
    o.setXY(int(x), int(y));
    this.AddPhysicalObj(o, true);
    return o;
  }
  CreateBall(x: number, y: number, a: string, b?: string, scale = 1, rotation = 0): Ball {
    const o = new Ball(this.physicalId++, b !== undefined ? a : "ball", b ?? a, scale, rotation);
    o.setXY(int(x), int(y));
    this.AddPhysicalObj(o, true);
    if (b !== undefined) this.SendLivingActionMapping(o, "pick", a);
    return o;
  }
  CreateTransmissionGate(x: number, y: number, name: string, model: string, action: string, scale: number, rotation: number): TransmissionGate {
    const o = new TransmissionGate(this.physicalId++, name, model, action, scale, rotation);
    o.setXY(int(x), int(y));
    this.AddPhysicalObj(o, true);
    return o;
  }
  /** SkelletonX/DDTank4.1 PVEGame.cs:2068-2071: permission only; GameOverMovie creates the physical gate later. */
  CreateGate(isEnter: boolean): void;
  CreateGate(x: number, y: number, name?: string, model?: string, action?: string): TransmissionGate;
  CreateGate(x: number | boolean, y?: number, name = "gate", model = "game.asset.Gate", action = "start"): TransmissionGate | void {
    if (typeof x === "boolean") {
      this.CanEnterGate = x;
      return;
    }
    return this.CreateTransmissionGate(x, y!, name, model, action, 1, 1);
  }
  /** donor-only: CreateTip (physical tip, packet 68) */
  CreateTip(x: number, y: number, name: string, model: string, action: string, scale: number, rotation: number): PhysicalObj {
    const o = new PhysicalObj(this.physicalId++, name, model, action, scale, rotation);
    o.setXY(int(x), int(y));
    this.map.addPhysical(o);
    o.game = this;
    this.physObjs.add(o);
    this.raw(68, 0, [["i32", o.id], ["i32", o.phyType], ["i32", o.x], ["i32", o.y], ["str", o.model], ["str", o.currentAction], ["i32", o.scale], ["i32", o.rotation]]);
    return o;
  }
  RemovePhysicalObj(o: PhysicalObj | null, send = true): void {
    if (!o) return;
    this.map.removePhysical(o);
    this.physObjs.delete(o);
    o.game = null;
    if (send) this.raw(53, 0, [["i32", o.id]]);
  }
  RemoveLiving(a: number | Living, send = true): void {
    if (typeof a === "number") {
      this.raw(53, 0, [["i32", a]]);
      return;
    }
    this.map.removePhysical(a);
    if (send) this.raw(53, 0, [["i32", a.id]]);
  }
  RemoveLivings(id: number): void { this.RemoveLiving(id); }
  ClearAllChild(): void {
    for (const l of [...this.livings]) if (l instanceof SimpleNpc && l.isLiving) l.die();
  }
  ClearAllNpc(): void {
    for (const l of [...this.livings]) if (l instanceof SimpleNpc) {
      this.livings.splice(this.livings.indexOf(l), 1);
      l.dispose();
      this.raw(53, 0, [["i32", l.id]]);
    }
  }

  // ---- queries
  GetAllFightPlayers(): CsList<Player> { return CsList.from2(this.players.filter((p) => p.isActive)); }
  GetAllFightingPlayers(): CsList<Player> { return this.GetAllFightPlayers(); }
  GetAllLivingPlayers(): CsList<Player> { return CsList.from2(this.players.filter((p) => p.isLiving && p.isActive)); }
  GetAllPlayers(): CsList<Player> { return CsList.from2(this.players); }
  GetAllEnemyPlayers(l: Living): CsList<Player> { return CsList.from2(this.players.filter((p) => p.team !== l.team)); }
  GetDiedPlayerCount(): number { return this.players.filter((p) => !p.isLiving).length; }
  FindPlayer(id: number): Player | null { return this.players.find((p) => p.id === id) ?? null; }
  FindPlayerWithId(id: number): Player | null { return this.players.find((p) => p.spec.userId === id || p.id === id) ?? null; }
  FindRandomPlayer(max?: number): Player | null | CsList<Player> {
    const list = this.players.filter((p) => p.isLiving && p.isActive);
    if (max !== undefined) {
      const out = new CsList<Player>();
      for (let i = 0; i < max && list.length; i++) out.push(list.splice(this.rng.nextRange(0, list.length), 1)[0]!);
      return out;
    }
    if (!list.length) return null;
    return list[this.rng.nextRange(0, list.length)]!;
  }
  FindRandomPlayerNotLock(): Player | null { return this.FindRandomPlayer() as Player | null; }
  FindRandomLiving(): Living | null {
    const l = this.livings.filter((x) => x.isLiving);
    const i = this.rng.nextRange(0, l.length);
    return l.length ? l[i]! : null;
  }
  FindNearestPlayer(x: number, y: number): Player | null {
    let best: Player | null = null, d = Infinity;
    for (const p of this.players) if (p.isLiving && p.isActive) {
      const v = p.distance(x, y);
      if (v < d) { d = v; best = p; }
    }
    return best;
  }
  FindFarPlayer(x: number, y: number): Player | null {
    let best: Player | null = null, d = -Infinity;
    for (const p of this.players) if (p.isLiving && p.isActive) {
      const v = p.distance(x, y);
      if (v > d) { d = v; best = p; }
    }
    return best;
  }
  FindNearestHelper(x: number, y: number): Living | null {
    let best: Living | null = null, d = Infinity;
    for (const t of this.turnQueue) if (t.isLiving && (t instanceof Player || t.config.IsHelper)) {
      const v = t.distance(x, y);
      if (v < d) { d = v; best = t; }
    }
    return best;
  }
  FindNearestAdverseNpc(x: number, y: number, camp: number): SimpleNpc | null {
    let best: SimpleNpc | null = null, d = Infinity;
    for (const l of this.livings) if (l instanceof SimpleNpc && l.isLiving && l.npcInfo.Camp !== camp) {
      const v = l.distance(x, y);
      if (v < d) { d = v; best = l; }
    }
    return best;
  }
  /** BaseGame.FindlivingbyDir (BaseGame.cs:949) */
  FindlivingbyDir(npc: Living): number {
    let right = 0, left = 0;
    for (const p of this.players) if (p.isLiving && p.isActive) (p.x > npc.x ? right++ : left++);
    return right > left ? 1 : right < left ? -1 : -npc.direction;
  }
  GetLivedLivings(): CsList<Living> { return CsList.from2(this.livings.filter((l) => l.isLiving)); }
  GetLivedLivingsHadTurn(): CsList<Living> { return CsList.from2(this.livings.filter((l) => l.isLiving && l instanceof SimpleNpc && l.config.IsTurn)); }
  GetLivedNpcs(npcId: number): CsList<Living> { return CsList.from2(this.livings.filter((l) => l.isLiving && l instanceof SimpleNpc && l.npcInfo.ID === npcId)); }
  GetNPCLivingWithID(id: number): CsList<SimpleNpc> { return CsList.from2(this.livings.filter((l): l is SimpleNpc => l instanceof SimpleNpc && l.isLiving && l.npcInfo.ID === id)); }
  FindAllNpc(): CsList<SimpleNpc> { return CsList.from2(this.livings.filter((l): l is SimpleNpc => l instanceof SimpleNpc)); }
  FindAllNpcLiving(): CsList<SimpleNpc> { return CsList.from2(this.livings.filter((l): l is SimpleNpc => l instanceof SimpleNpc && l.isLiving)); }
  FindLivingTurnBossWithID(id: number): CsList<SimpleBoss> { return CsList.from2(this.turnQueue.filter((t): t is SimpleBoss => t instanceof SimpleBoss && t.isLiving && t.npcInfo.ID === id)); }
  FindAllTurnBossLiving(): CsList<SimpleBoss> { return CsList.from2(this.turnQueue.filter((t): t is SimpleBoss => t instanceof SimpleBoss && t.isLiving)); }
  FindAllTurnBoss(): CsList<SimpleBoss> { return CsList.from2(this.turnQueue.filter((t): t is SimpleBoss => t instanceof SimpleBoss)); }
  FindBossWithID(id: number): SimpleBoss | null { return this.turnQueue.find((t): t is SimpleBoss => t instanceof SimpleBoss && t.npcInfo.ID === id) ?? null; }
  GetDiedBossCount(): number { return this.turnQueue.filter((t) => t instanceof SimpleBoss && !t.isLiving).length; }
  FindAppointDeGreeNpc(degree: number): CsList<Living> { return CsList.from2(this.livings.filter((l) => l.isLiving && ((l as unknown as { degree?: number }).degree ?? 0) === degree)); }
  FindPhysicalObjByName(name: string): CsList<PhysicalObj> { return CsList.from2([...this.physObjs].filter((o) => o.name === name)); }
  FindBombPlayerX(x: number): CsList<Player> { return CsList.from2(this.players.filter((p) => p.isLiving && Math.abs(p.x - x) < 100)); }
  GetFrostPlayerRadom(): Player | null {
    const l = this.players.filter((p) => p.isLiving && p.isFrost);
    return l.length ? l[this.rng.nextRange(0, l.length)]! : null;
  }
  GetHighDelayTurn(): TurnedLiving | null {
    let best: TurnedLiving | null = null;
    for (const t of this.turnQueue) if (t.isLiving && (!best || t.delay > best.delay)) best = t;
    return best;
  }
  FindTurnNpcRank(): number { return 0; }
  /** donor-only: sum of fight power proxies (attack+defence+agility+lucky) of the team */
  GetTeamFightPower(): number {
    return this.players.reduce((s, p) => s + (p.spec.attack + p.spec.defence + p.spec.agility + p.spec.lucky), 0);
  }

  // ---- flow
  WaitTime(ms: number): void { this.waitTime(ms); }
  GetWaitTimerLeft(): number { return Math.max(0, this.getWaitTimer() - this.now); }
  ClearWaitTimer(): void { this.clearWaitTimer(); }
  CheckState(delay: number): void { this.checkState(delay); }
  /** AddAction(IAction): script-built actions are `{ Execute(game, tick) }` or functions */
  AddAction(a: unknown, delay = 0): void {
    if (typeof a === "function") this.addStepAction(delay, 0, () => (this.runScript("AddAction", a as () => void), true));
    else if (a && typeof (a as { run?: unknown }).run === "function") {
      const act = a as { run(g: PveGame): void; delay?: number };
      this.addStepAction(delay + (act.delay ?? 0), 0, () => (this.runScript("AddAction", () => act.run(this)), true));
    }
  }
  /** donor-only: ChangeMissionDelay */
  ChangeMissionDelay(delay: number): void { this.PveGameDelay = delay; }
  /** donor-only: JumpToSpeed — skip remaining NPC wait */
  JumpToSpeed(): void { this.clearWaitTimer(); }
  SendPassDrama(isShow: boolean): void { this.raw(133, 0, [["bool", isShow]]); }
  SendQuizWindow(..._a: unknown[]): void {}
  SendCloseQuizWindow(): void {}
  SendLivingToTop(l: Living): void { this.SendLivingActionMapping(l, "top", "top"); }
  TakeConsortiaBossAward(..._a: unknown[]): void {}
  CreateBox(): CsList<unknown> { return new CsList(); }
  DoOther(): void { this.runScript("mission.DoOther", () => this.missionAI.DoOther()); }

  // ---- camera / UI packets
  SendMissionInfo(): void {
    const m = this.missionInfo;
    if (!m) return;
    this.raw(113, 0, [
      ["i32", m.Id], ["str", m.Name ?? ""], ["str", m.Success ?? ""], ["str", m.Failure ?? ""], ["str", m.Description ?? ""], ["str", m.Title ?? ""],
      ["i32", this.TotalMissionCount], ["i32", this.SessionId], ["i32", this.TotalTurn], ["i32", this.TotalCount], ["i32", this.Param2], ["i32", this.Param4], ["i32", this.WantTryAgain], ["str", this.Pic ?? ""],
    ]);
  }
  /** PVEGame.SendUpdateUiData (PVEGame.cs:1944): BARRIER_INFO 104 */
  SendUpdateUiData(): void {
    const v = this.runScript("mission.UpdateUIData", () => this.missionAI.UpdateUIData(), 0) ?? 0;
    this.raw(104, 0, [["i32", this.turnIndex], ["i32", int(v)], ["i32", this.Param1], ["i32", this.Param3]]);
  }
  SendObjectFocus(o: { x: number; y: number } | null, type: number, delay: number, finish: number): void {
    if (!o) return;
    this.addStepAction(delay, finish, () => (this.raw(62, 0, [["i32", type], ["i32", o.x], ["i32", o.y]]), true));
  }
  SendGameFocus(a: unknown, b: number, c: number, d?: number, e?: number): void {
    if (typeof a === "number") this.SendFreeFocus(a, b, c, d ?? 0, e ?? 0);
    else this.SendObjectFocus(a as Living, 1, b, c);
  }
  SendFreeFocus(x: number, y: number, type: number, delay: number, finish: number): void {
    this.addStepAction(delay, finish, () => (this.raw(62, 0, [["i32", type], ["i32", int(x)], ["i32", int(y)]]), true));
  }
  SendGameObjectFocus(type: number, name: string, delay: number, finish: number): void {
    for (const o of this.FindPhysicalObjByName(name)) this.SendObjectFocus(o, type, delay, finish);
  }
  SendHideBlood(l: Living, hide: number): void { this.raw(80, l.id, [["i32", l.id], ["i32", hide]]); }
  SendLivingShowBlood(l: Living, show: number): void { this.SendHideBlood(l, show); }
  SendLivingActionMapping(l: { id: number } | number | null, source: string, value: string): void {
    if (l == null) return;
    const id = typeof l === "number" ? l : l.id;
    this.raw(223, id, [["i32", id], ["str", source ?? ""], ["str", value ?? ""]]);
  }
  SendPlaySound(s: string): void { this.raw(63, 0, [["str", s ?? ""]]); }
  SendPlayBackgroundSound(play: boolean): void { this.raw(71, 0, [["bool", !!play]]); }
  SendSyncLifeTime(): void { this.emit({ cmd: "SYNC_LIFETIME", livingId: 0, lifeTime: this.lifeTime }); }
  SendPlayersPicture(l: Living, type: number, state: boolean): void { this.raw(29, l.id, [["i32", type], ["bool", state]]); }
  SendGameChangeTarget(id: number): void { this.raw(73, 0, [["i32", id]]); }
  ChangeTarget(id: number): void { this.SendGameChangeTarget(id); }
  SendLockFocus(lock: boolean): void { this.raw(109, 0, [["bool", lock]]); }
  SendIsLastMission(isLast: boolean): void { this.raw(160, 0, [["bool", isLast]]); }
  SendGamePlayerProperty(l: Living, type: string, state: string): void { this.raw(41, l.id, [["str", type], ["str", state]]); }
  /** queued action list (debug) */
  get pendingActions(): readonly QueuedAction[] { return this.actions; }
}
