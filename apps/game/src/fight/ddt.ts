/**
 * Real combat: plugs @ddt/fight (pure engine) into the lobby's FightEngine boundary. One 40 ms loop drives every game
 * (GameMgr.THREAD_INTERVAL); engine events are serialized to 91 GAME_CMD packets exactly as the C# writers cited in
 * packages/fight/src/game/events.ts. Bots (VirtualPlayer seats) are played server-side by @ddt/fight's BotRunner.
 */
import { type BaseGame, type FightAssets, type FightCommand, type FightEvent, GameState, type PlayerSpec, PvpGame, PveGame, type PveData, type PveInfo, type DropItem, BotRunner, type BotProfile, hertAddition, setTranslator } from "@ddt/fight";
import "@ddt/fight/pve-scripts";
import { loadPackedAssets } from "@ddt/fight/node";
import { type GSPacket, PacketOut } from "@ddt/protocol";
import * as Out from "../packets/out.js";
import type { RoomMember } from "../game/player.js";
import type { FightEngine, FightGame, StartGameOptions, StartPveOptions } from "./types.js";
import type { WorldBossAttempt } from "../game/world-boss.js";
import { WorldBossSettlementGate } from "./world-boss-settlement.js";
import { unlockDungeonPvePermission } from "../game/pve-permissions.js";
import { assertChristmasPveReady, christmasPveDefinition, consumeChristmasPveAdmission, createChristmasPveOverlay } from "../game/christmas-pve.js";

/** Server-owned run identity and durable settlement; never supplied by a room packet. */
export interface LabyrinthFightBinding {
  processAwards: ReadonlyMap<number, string>;
  started(fight: FightGame): void;
  award(member: RoomMember, event: Extract<FightEvent, { cmd: "LABYRINTH_AWARD" }>): Promise<void>;
  finish(isWin: boolean): Promise<void>;
}

export interface DdtFightOptions {
  assets?: FightAssets;
  /** Explicit local compatibility pack for new weapons; never overrides packed weapon data. */
  weaponExtensionPath?: string;
  /** GameMgr/MapMgr.GetMapIndex — explicit map or a random open one */
  pickMap?: (mapId: number) => number;
  log?: (m: string) => void;
  /** difficulty for VirtualPlayer seats (default 50) */
  botProfile?: (bot: RoomMember) => BotProfile;
  /** level from total GP (LevelInfo); when omitted the grade is not recomputed */
  gradeForGp?: (gp: number) => number | undefined;
  /** Double-exp window multiplier (EventScheduler "double_exp"); applied to the GP of PvP/PvE rewards. */
  expRate?: () => number;
  /** World boss (room type 14, BaseWorldBossRoom.ReduceBlood/UpdateRank): damage a player dealt in the fight. */
  onWorldBossHurt?: (member: RoomMember, hurt: number, attempt: WorldBossAttempt) => void;
  /** Capture the admitted window and its HP together at fight creation. Null refuses a closed window. */
  worldBossWindow?: (pveId: number) => { key: string; blood: number } | null;
  /** PVPGame.TakeCard drop (DropInventory.CardDrop + AddTemplate TempBag); returns the card face shown to everyone */
  takeCard?: (member: RoomMember, roomType: number) => { templateId: number; count: number };
  /** PaymentTakeCardCommand.cs (GAME_CMD sub 114): charge for an extra card flip; false = too poor, nothing happens. */
  payTakeCard?: (member: RoomMember) => boolean;
  /** GamePlayer.OnGameOver (quest conditions) for every human seat */
  onPlayerGameOver?: (member: RoomMember, g: { roomType: number; gameType: number; isWin: boolean; kills: number; playerCount: number }) => void;
  /** PvE tables + drops (Templates); without it startPve returns null */
  pve?: {
    data: PveData;
    pveInfo(pveId: number, roomType: number, levelLimits: number): PveInfo | undefined;
    drop(kind: "copy" | "npc", id: number, user?: number): DropItem[] | null;
    translate?(key: string, args: unknown[]): string;
  };
  labyrinth?: { admit(s: StartPveOptions, fightId: number): LabyrinthFightBinding | null };
  /** Remaining server-wide world-boss HP (room type 14 fights start the dragon at this blood). */
  worldBossBlood?: () => number;
  /** GamePlayer.OnMissionOver (quest condition 21) */
  onMissionOver?: (member: RoomMember, m: { missionId: number; isWin: boolean; turnNum: number; roomType?: number; gameType?: number; pveId?: number; hardLevel?: number }) => void;
  /** Whole-game PvP result after the per-player rewards (PVPGame.CalculateGuildMatchResult: guild riches / offer). */
  onGameOver?: (g: { roomType: number; gameType: number; winTeam: number; players: { member: RoomMember; team: number; win: boolean; totalHurt: number }[] }) => void;
  /** PVE_AWARD: give items (temp/fight bag, special gold/money templates) */
  giveItems?: (member: RoomMember, items: DropItem[], bag: "temp" | "fight") => void;
  /** DropInventory.BoxDrop(roomType) (eDropType.Box = 2): item of an in-battle drop box */
  boxDrop?: (roomType: number) => DropItem[] | null;
  /** PVPGame.RemovePlayer: a living player left a started game (GP −grade×12, offer −5/−15 in Match) */
  onPlayerFlee?: (member: RoomMember, g: { roomType: number; gameType: number }) => void;
  /** Pet_Skill_Info row (battle pet skills) */
  petSkill?: (id: number) => { CostMP: number; ColdDown: number; NewBallID: number; BallType: number; Delay: number; Pic: number; EffectPic: string | null } | undefined;
  /** test hook: manual clock instead of setInterval */
  manualClock?: boolean;
  seed?: () => number;
}

let gameIdSeq = 1;

/** Item-like shapes we read from the lobby player without importing GamePlayer (bots don't have bags). */
type ItemLike = { TemplateID: number; StrengthenLevel?: number; RefineryLevel?: number; template: { Property7?: number | null; Property8?: number | null; Name?: string | null } };
type PetLike = { ID: number; Place: number; TemplateID: number; Name: string; UserID: number; Level: number; SkillEquip: string };
type BagLike = { getItemAt(i: number): (ItemLike & { Count: number }) | null; removeCountFromStack(it: unknown, n: number): boolean; removeItem(it: unknown): boolean };
type LobbyLike = RoomMember & {
  mainWeapon?: ItemLike | null;
  equipBag?: BagLike;
  propBag?: BagLike;
  fightBag?: BagLike;
  addGiftToken?(v: number): void;
  updateProperties?(): void;
  /** GamePlayer.GetBaseAttack / GetBaseDefence (game/stats.ts) */
  baseAttack?: number;
  baseDefence?: number;
  petBag?: { equipped(): PetLike | null; reduceHunger(): void };
  flushPets?(): void;
};

/** "id,slot|…" of UsersPetInfo.SkillEquip → [slot, id] with an id > 0 */
function petSkillEquip(s: string): [number, number][] {
  return (s || "").split("|").map((x) => x.split(",").map(Number)).filter((a) => a.length >= 2 && a[0]! > 0).map((a) => [a[1]!, a[0]!]);
}

export class DdtFightEngine implements FightEngine {
  readonly name = "ddt-fight";
  readonly games = new Map<number, DdtGame>();
  readonly assets: FightAssets;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly o: DdtFightOptions = {}) {
    if (o.assets && o.weaponExtensionPath) throw new Error("Provide assets or weaponExtensionPath, not both");
    this.assets = o.assets ?? loadPackedAssets(undefined, { weaponExtensionPath: o.weaponExtensionPath });
    if (o.pve?.translate) setTranslator(o.pve.translate);
  }

  /** GameMgr.StartPVEGame (Games/GameMgr.cs:140-165) */
  startPve(s: StartPveOptions): FightGame | null {
    // Original layer awards require one atomic ProcessAward/progress/inventory owner before admission.
    if (s.roomType === 15 && !this.o.labyrinth) {
      this.o.log?.("pve: Labyrinth room 15 requires the original reward settlement owner; combat start is disabled");
      return null;
    }
    const local = christmasPveDefinition(s.pveId);
    // The room protocol is not admission. All room40 starts remain closed until the scene owner binds a permit.
    if ((s.roomType === 40 && (!local || !consumeChristmasPveAdmission(s))) || (local && s.roomType !== 40)) return null;
    const base = this.o.pve;
    const pv = base && local ? { ...base, ...createChristmasPveOverlay(base) } : base;
    if (!pv) return null;
    const info = pv.pveInfo(s.pveId, s.roomType, s.levelLimits);
    if (!info) {
      this.o.log?.(`pve: no Pve_Info for map ${s.pveId} / type ${s.roomType}`);
      return null;
    }
    let starting: DdtGame | undefined;
    let labyrinth: LabyrinthFightBinding | null = null;
    try {
      if (local) assertChristmasPveReady(local, this.assets);
      const id = gameIdSeq++;
      if (s.roomType === 15 && !(labyrinth = this.o.labyrinth!.admit(s, id))) return null;
      const boss = s.roomType === 14 ? this.o.worldBossWindow?.(s.pveId) : undefined;
      if (s.roomType === 14 && this.o.worldBossWindow && !boss) return null;
      const specs = s.players.map((m) => specOf(m as LobbyLike, 1, this.assets, this.o.petSkill));
      const members = new Map(s.players.map((m) => [m.id, m as LobbyLike]));
      const game = new PveGame({
        id, roomType: s.roomType, gameType: s.gameType, timeType: s.timeType, assets: this.assets, players: specs, seed: this.o.seed?.() ?? (Date.now() ^ (id * 7919)) | 0, now: Date.now(),
        pveInfo: info, hardLevel: s.hardLevel, currentFloor: s.currentFloor, data: pv.data,
        ...(local ? { strictScripts: true, suppressDefaultRewards: true, placeholderMapId: local.mapId } : {}),
        ...(labyrinth ? { strictScripts: true, labyrinthProcessAwards: labyrinth.processAwards } : {}),
        worldBossBlood: s.roomType === 14 ? (boss?.blood ?? this.o.worldBossBlood?.()) : undefined,
        drops: local ? {} : { copyDrop: (mid, user) => pv.drop("copy", mid, user), npcDrop: (did) => pv.drop("npc", did) },
        log: (m) => this.o.log?.(m),
        ...gameHooks(this, s.roomType, members),
        ...(local ? { boxDrop: () => null } : {}),
      });
      const g = new DdtGame(id, game.map.info.id, { roomId: s.roomId, roomType: s.roomType, gameType: s.gameType, timeType: s.timeType, mapId: s.pveId, red: s.players, blue: [], onStopped: s.onStopped }, this, game, s, boss ? { windowKey: boss.key, fightId: id } : undefined, labyrinth ?? undefined);
      starting = g;
      labyrinth?.started(g);
      g.activatePets();
      this.games.set(g.id, g);
      this.ensureLoop();
      g.tick(Date.now());
      return g;
    } catch (e) {
      // A first-tick failure is not a successful boss admission. Do not leave an orphan engine game.
      if ((s.roomType === 14 || (s.roomType === 40 && local) || labyrinth) && starting) {
        this.games.delete(starting.id);
        try { starting.fail(e); } catch { /* Preserve the original startup error below. */ }
      } else if (labyrinth) {
        try { void labyrinth.finish(false).catch(error => this.o.log?.(`pve: Labyrinth startup settlement failed: ${String(error)}`)); }
        catch (error) { this.o.log?.(`pve: Labyrinth startup settlement failed: ${String(error)}`); }
      }
      this.o.log?.(`pve: cannot start game: ${(e as Error).stack}`);
      return null;
    }
  }

  startPvp(s: StartGameOptions): FightGame | null {
    let mapId = this.o.pickMap ? this.o.pickMap(s.mapId) : s.mapId;
    if (!this.assets.maps.has(mapId)) mapId = this.assets.maps.has(1001) ? 1001 : [...this.assets.maps.keys()][0]!;
    try {
      const g = new DdtGame(gameIdSeq++, mapId, s, this);
      g.activatePets();
      this.games.set(g.id, g);
      this.ensureLoop();
      g.tick(Date.now());
      return g;
    } catch (e) {
      this.o.log?.(`fight: cannot start game: ${(e as Error).message}`);
      return null;
    }
  }

  private ensureLoop(): void {
    if (this.timer || this.o.manualClock) return;
    this.timer = setInterval(() => this.tick(Date.now()), 40);
    this.timer.unref?.();
  }

  /** advances every game (exposed for tests with `manualClock`) */
  tick(now: number): void {
    for (const g of [...this.games.values()]) {
      try {
        g.tick(now);
      } catch (e) {
        this.o.log?.(`fight game ${g.id} update error: ${(e as Error).stack}`);
        if (g.game instanceof PveGame && g.game.strictScripts) g.fail(e);
      }
    }
    if (this.games.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Player.Reset stat inputs from the lobby character: Attack/Defence/Agility/Luck/hp and GetBaseAttack/GetBaseDefence come
 * from game/stats.ts (items, strengthen, gems, cards, pet, suits, totem — GamePlayer.UpdateProperties); bots (no bags) fall
 * back to the weapon/armour approximation.
 */
function specOf(m: LobbyLike, team: number, assets: FightAssets, petSkill?: DdtFightOptions["petSkill"]): PlayerSpec {
  const c = m.info;
  const w = m.mainWeapon ?? null;
  const wTpl = w ? assets.items.get(w.TemplateID) : undefined;
  const weaponTemplateId = w?.TemplateID ?? (m.view().weaponTemplateId > 0 ? m.view().weaponTemplateId : 7001);
  const p7 = (it: ItemLike | null | undefined) => (it ? hertAddition(it.template.Property7 ?? 0, it.StrengthenLevel ?? 0) : 0);
  const real = (m.baseAttack ?? 0) > 0;
  const baseAttack = real ? m.baseAttack! : w ? p7(w) : (assets.items.get(weaponTemplateId)?.property7 ?? 100);
  const baseDefence = real ? (m.baseDefence ?? 0) : m.equipBag ? p7(m.equipBag.getItemAt(0)) + p7(m.equipBag.getItemAt(4)) : 0;
  const dep = m.equipBag?.getItemAt(15) ?? null;
  const depTpl = dep ? assets.items.get(dep.TemplateID) : undefined;
  const hs = m.equipBag?.getItemAt(18) ?? null; // healstone slot (Player.m_Healstone = GamePlayer.Healstone)
  const pet = m.petBag?.equipped() ?? null;
  const equip = pet ? petSkillEquip(pet.SkillEquip) : [];
  return {
    userId: m.id, nickname: c.NickName ?? `p${m.id}`, team, grade: c.Grade, attack: c.Attack, defence: c.Defence, agility: c.Agility, lucky: c.Luck,
    baseAttack: Math.max(1, baseAttack), baseDefence, hp: Math.max(1, c.hp),
    weapon: { templateId: weaponTemplateId, property8: wTpl?.property8 ?? w?.template.Property8 ?? 0, refineryLevel: w?.RefineryLevel ?? 0 },
    deputyWeapon: dep && depTpl ? { template: depTpl, strengthenLevel: dep.StrengthenLevel ?? 0 } : null,
    isBot: m.isBot, isVip: (c.typeVIP ?? 0) > 0, inGuild: (c.ConsortiaID ?? 0) > 0,
    healstone: hs && hs.Count > 0 ? { heal: (hs.template as { Property2?: number | null }).Property2 ?? 0 } : null,
    pet: pet
      ? {
          id: pet.ID, place: pet.Place, templateId: pet.TemplateID, name: pet.Name, userId: pet.UserID, level: pet.Level, skillEquip: equip,
          skills: equip.flatMap(([, id]) => {
            const s = petSkill?.(id);
            return s ? [{ id, costMP: s.CostMP, coldDown: s.ColdDown, newBallId: s.NewBallID, ballType: s.BallType, delay: s.Delay, pic: String(s.Pic), effectPic: s.EffectPic ?? "" }] : [];
          }),
        }
      : null,
  };
}

/** BaseGame hooks backed by the lobby player (GamePlayer.UsePropItem / RemoveHealstone, DropInventory.BoxDrop). */
function gameHooks(engine: DdtFightEngine, roomType: number, members: Map<number, LobbyLike>) {
  return {
    boxDrop: () => engine.o.boxDrop?.(roomType) ?? null,
    usePropItem: (uid: number, bag: number, place: number, templateId: number, isLiving: boolean): boolean => {
      const m = members.get(uid);
      if (!m || m.isBot) return true;
      if (bag === 1 && templateId >= 10001 && templateId <= 10008) {
        if (!isLiving) return false;
        if (place === -1) return true; // CanUseProp: the basic props cost energy only
        const it = m.propBag?.getItemAt(place);
        return !!it && it.Count > 0 && m.propBag!.removeCountFromStack(it, 1);
      }
      const it = m.fightBag?.getItemAt(place);
      return !!it && it.TemplateID === templateId && m.fightBag!.removeItem(it);
    },
    removeHealstone: (uid: number): boolean => {
      const m = members.get(uid);
      const it = m?.equipBag?.getItemAt(18);
      return !!it && it.Count > 0 && m!.equipBag!.removeCountFromStack(it, 1);
    },
  };
}

class DdtGame implements FightGame {
  readonly game: BaseGame;
  readonly bots: BotRunner;
  private readonly members = new Map<number, LobbyLike>();
  private readonly teamOf = new Map<number, number>();
  private stopped = false;
  private lastInputTime = 0;
  private readonly settlement = new WorldBossSettlementGate();
  holdWorldBossSettlement(): Promise<() => void> { return this.settlement.acquire(); }
  async waitWorldBossSettlement(): Promise<void> {
    do {
      await Promise.all(this.labyrinthPending);
      await this.settlement.waitIdle();
    } while (this.labyrinthPending.size);
    if (this.labyrinthFailure !== undefined) throw this.labyrinthFailure;
  }
  private readonly labyrinthPending = new Set<Promise<void>>();
  private labyrinthFailure: unknown;
  private labyrinthClosing = false;
  private labyrinthFinish: Promise<void> | undefined;
  private settlementError = (error: unknown): void => { this.engine.o.log?.(`fight ${this.id}: queued operation failed: ${String(error)}`); };
  /** PVPGame.Cards (9 for PvP) and Player.CanTakeOut per userId, filled at GAME_OVER */
  private readonly cards: number[] = new Array(9).fill(0);
  private readonly canTakeOut = new Map<number, number>();

  private readonly pve: StartPveOptions | null;
  private readonly finishedParticipants = new Set<number>();
  private pveStoppedApplied = false;
  private finishParticipant(id: number): void {
    if (this.s.roomType !== 14 || this.finishedParticipants.has(id)) return;
    this.finishedParticipants.add(id);
    this.pve?.onParticipantFinished?.(id);
  }
  constructor(readonly id: number, readonly mapId: number, private readonly s: StartGameOptions, private readonly engine: DdtFightEngine, pveGame?: PveGame, pve?: StartPveOptions, private readonly bossAttempt?: WorldBossAttempt, private readonly labyrinth?: LabyrinthFightBinding) {
    this.pve = pve ?? null;
    const specs: PlayerSpec[] = [];
    for (const [team, list] of [[1, s.red], [2, s.blue]] as const)
      for (const m of list) {
        this.members.set(m.id, m as LobbyLike);
        this.teamOf.set(m.id, team);
        specs.push(specOf(m as LobbyLike, team, engine.assets, engine.o.petSkill));
      }
    this.game = pveGame ?? new PvpGame({ id, roomType: s.roomType, gameType: s.gameType, timeType: s.timeType, mapId, assets: engine.assets, players: specs, seed: engine.o.seed?.() ?? (Date.now() ^ (id * 7919)) | 0, now: Date.now(), ...gameHooks(engine, s.roomType, this.members) });
    const profiles = new Map<number, BotProfile>();
    for (const m of this.members.values()) if (m.isBot) profiles.set(m.id, engine.o.botProfile?.(m) ?? { difficulty: 50 });
    this.bots = new BotRunner(this.game, profiles, id);
  }

  activatePets(): void {
    // GameStart.cs:88 — only after the server-owned binding accepted the real fight.
    for (const m of this.members.values()) if (!m.isBot && m.petBag?.equipped()) { m.petBag.reduceHunger(); m.flushPets?.(); }
  }

  tick(now: number): void {
    if (this.settlement.held) { this.settlement.tick(now, (time) => this.tick(time), this.settlementError); return; }
    if (this.stopped) return;
    now = this.lastInputTime = Math.max(now, this.lastInputTime);
    if (this.labyrinthClosing) return;
    this.dispatch(this.game.update(now), () => {
      this.dispatch(this.bots.update(now), () => { if (this.game.state === GameState.Stopped) this.stop(); });
    });
  }

  processData(from: RoomMember, pkt: GSPacket, now = Date.now()): void | Promise<void> {
    if (this.settlement.held) return this.settlement.defer(() => this.processData(from, pkt, now));
    if (this.stopped || this.labyrinthClosing) return;
    now = this.lastInputTime = Math.max(now, this.lastInputTime);
    // TakeCardCommand (98) / BossTakeCardCommand (130): after GAME_OVER; index out of range (client sends 100 when
    // its countdown ends) = auto pick. Without an answer the client's card board never closes (stuck at "00").
    const at = pkt.offset;
    const sub = pkt.readByte();
    if (this.pve) {
      if (sub === 25 || sub === 99) return; // UpdatePlayStep / GeneralCommand: read and dropped (Cmd/UpdatePlayStep.cs)
      const c = parsePveCommand(sub, pkt);
      if (c) {
        this.dispatch(this.game.handle(from.id, c, now));
        return;
      }
    }
    if (sub === 98 || sub === 130) {
      this.takeCard(from.id, pkt.readByte(), false);
      return;
    }
    // PaymentTakeCardCommand.cs (114): pay Money for an extra card flip, then TakeCard like a normal pick
    // (index in range) or an auto pick (out of range, same fallback as 98/130).
    if (sub === 114) {
      if (this.s.roomType === 40 && this.game instanceof PveGame && this.game.strictScripts) return;
      const index = pkt.readByte();
      if (this.engine.o.payTakeCard?.(from)) {
        const left = this.canTakeOut.get(from.id) ?? 0;
        this.canTakeOut.set(from.id, left + 1);
        this.takeCard(from.id, index, false);
      }
      return;
    }
    // MoveStopCommand.cs (10) / WannaLeadCommand.cs (97): registered in the original with an empty HandleCommand
    // body — confirmed no-ops, not missing handlers.
    if (sub === 10 || sub === 97) return;
    pkt.offset = at;
    const cmd = parseCommand(pkt);
    if (!cmd) {
      // Confirmed dead in the original too (no Game.Logic.Cmd class carries these GAME_CMD subs — CommandMgr's
      // reflection scan never registers them, same silent drop as here): 3 BLAST, 19 CHANGEBALL, 21 KILLSELF,
      // 22 BEAT. 137 DELIVER is handled above via parsePveCommand (pve-only, like 116/98/130/133/119/23).
      this.engine.o.log?.(`fight ${this.id}: GAME_CMD sub ${sub} from ${from.id} ignored`);
      return;
    }
    this.dispatch(this.game.handle(from.id, cmd, now));
  }

  /** GameUserStartHandler (82): host forces every player Ready (PVEGame.MissionStart); no-op for PvP (AbstractGame
   * default). Reuses the DELIVER(137) semantics — set-only, no 116 echo — since GameUserStartHandler doesn't SendToAll. */
  missionStart(now = Date.now()): void | Promise<void> {
    if (this.settlement.held) return this.settlement.defer(() => this.missionStart(now));
    if (this.stopped || this.labyrinthClosing) return;
    if (!this.pve) return;
    now = this.lastInputTime = Math.max(now, this.lastInputTime);
    const ids = [...this.members.keys()];
    const ready = (index: number): void => {
      if (index < ids.length) this.dispatch(this.game.handle(ids[index]!, { cmd: "DELIVER", ready: true }, now), () => ready(index + 1));
    };
    ready(0);
  }

  removePlayer(p: RoomMember): void {
    if (this.labyrinth && this.members.get(p.id) === p) { this.stop(); return; }
    if (this.settlement.held) { void this.settlement.defer(() => this.removePlayer(p), `remove:${p.id}`).catch(this.settlementError); return; }
    if (this.stopped) return;
    const fled = this.game.removePlayer(p.id);
    if (this.members.get(p.id) === p) this.finishParticipant(p.id);
    if (fled && !p.isBot && !this.pve) {
      try {
        this.engine.o.onPlayerFlee?.(p, { roomType: this.s.roomType, gameType: this.s.gameType });
      } catch (err) {
        this.engine.o.log?.(`fight ${this.id}: flee penalty failed: ${(err as Error).message}`);
      }
    }
    this.dispatch(this.game.drain());
    this.members.delete(p.id);
    if ([...this.members.values()].every((m) => m.isBot)) {
      this.game.stop();
      this.stop();
    }
  }

  /** PVPGame.TakeCard(player, index, isAuto) (PVPGame.cs:143-200). */
  takeCard(userId: number, index: number, isAuto: boolean): boolean {
    const left = this.canTakeOut.get(userId) ?? 0;
    if (left <= 0) return false;
    if (index < 0 || index >= this.cards.length || this.cards[index]! > 0) {
      const free = this.cards.findIndex((c) => c === 0);
      if (free < 0) return false;
      index = free;
      isAuto = true;
    }
    const m = this.members.get(userId);
    const living = this.game.players.find((p) => p.spec.userId === userId);
    if (!m || !living) return false;
    this.canTakeOut.set(userId, left - 1);
    this.cards[index] = 1;
    const face = m.isBot ? { templateId: 0, count: 0 } : (this.engine.o.takeCard?.(m, this.s.roomType) ?? { templateId: 0, count: 0 });
    const p = new PacketOut(91, living.id, living.id);
    p.writeByte(98); p.writeBoolean(isAuto); p.writeByte(index); p.writeInt(face.templateId); p.writeInt(face.count); p.writeBoolean(false);
    for (const o of this.members.values()) o.send(p);
    return true;
  }

  stop(): void {
    if (this.labyrinth) {
      if (this.stopped || this.labyrinthClosing) return;
      this.labyrinthClosing = true;
      this.pauseLabyrinth(() => this.finishLabyrinth(false), () => this.cleanupStop(), true);
      return;
    }
    if (this.settlement.held) { void this.settlement.defer(() => this.stop(), "stop").catch(this.settlementError); return; }
    this.cleanupStop();
  }

  private cleanupStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const id of this.members.keys()) this.finishParticipant(id);
    // PVPGame.Stop: players that did not pick get an automatic card.
    for (const [uid, left] of this.canTakeOut) if (left > 0) this.takeCard(uid, -1, true);
    this.game.stop();
    this.engine.games.delete(this.id);
    this.s.onStopped();
  }

  /** Fatal strict-script/settlement failures remain observable to quit and shutdown drains. */
  fail(error: unknown): void {
    if (!this.labyrinth) { this.stop(); return; }
    this.labyrinthFailure ??= error;
    this.engine.o.log?.(`fight ${this.id}: Labyrinth settlement failed: ${String(error)}`);
    if (this.stopped || this.labyrinthClosing) return;
    this.labyrinthClosing = true;
    this.pauseLabyrinth(() => this.finishLabyrinth(false), () => this.cleanupStop(), true);
  }

  private finishLabyrinth(isWin: boolean): Promise<void> {
    if (!this.labyrinthFinish) {
      try { this.labyrinthFinish = this.labyrinth!.finish(isWin); }
      catch (error) { this.labyrinthFinish = Promise.reject(error); }
    }
    return this.labyrinthFinish;
  }

  /** Register synchronously, then detach from the triggering client packet's own queue. */
  private pauseLabyrinth(work: () => Promise<void>, resume: () => void, closing = false): void {
    const lease = this.settlement.acquire();
    let result: Promise<void>;
    try { result = work(); } catch (error) { result = Promise.reject(error); }
    // A queued lease can wait behind another commit; observe rejection immediately.
    const outcome = result.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    const pending = (async () => {
      const release = await lease;
      try {
        const completed = await outcome;
        if (!completed.ok) throw completed.error;
        if (!this.stopped && (!this.labyrinthClosing || closing)) resume();
      } catch (error) {
        this.labyrinthFailure ??= error;
        this.labyrinthClosing = true;
        this.engine.o.log?.(`fight ${this.id}: Labyrinth settlement failed: ${String(error)}`);
        try { await this.finishLabyrinth(false); }
        catch (finishError) { this.engine.o.log?.(`fight ${this.id}: Labyrinth exit failed: ${String(finishError)}`); }
        finally { this.cleanupStop(); }
      } finally { release(); }
    })();
    this.labyrinthPending.add(pending);
    void pending.finally(() => this.labyrinthPending.delete(pending)).catch(this.settlementError);
  }

  private send(e: FightEvent, pkt: GSPacket): void {
    const target = e.to ? new Set(e.to) : null;
    for (const p of this.game.players) {
      if (e.except === p.id || (target && !target.has(p.id))) continue;
      this.members.get(p.spec.userId)?.send(pkt);
    }
  }

  private dispatch(events: FightEvent[] | void, after?: () => void): void {
    const batch = events ?? [];
    for (let i = 0; i < batch.length; i++) {
      const e = batch[i]!;
      if (e.cmd === "LABYRINTH_AWARD") {
        if (!this.labyrinth || this.s.roomType !== 15 || !(this.game instanceof PveGame)) throw new Error(`Labyrinth award ${this.id}/${e.userId}/${e.floor} has no settlement owner`);
        const member = this.members.get(e.userId);
        const living = this.game.players.find(p => p.id === e.livingId && p.spec.userId === e.userId);
        if (!member || member.isBot || !living?.isActive || !Number.isInteger(e.floor) || e.floor < 1 || e.floor > 30 ||
          this.game.SessionId !== e.floor || this.game.MissionInfo?.Id !== e.missionId || e.missionId !== 40000 + e.floor ||
          typeof e.bigAward !== "boolean" || (e.bigAward && e.floor % 2 !== 0)) {
          const error = new Error(`Labyrinth award ${this.id}/${e.userId}/${e.floor} does not match its active mission/member`);
          this.fail(error);
          throw error;
        }
        this.pauseLabyrinth(() => this.labyrinth!.award(member, e), () => this.dispatch(batch.slice(i + 1), after));
        return;
      }
      if (e.cmd === "GAME_OVER") this.applyRewards(e);
      if (e.cmd === "GAME_MISSION_OVER") {
        this.applyMissionOver(e);
        this.engine.o.log?.(`pve ${this.id}: mission ${e.missionId} over, win=${e.isWin}`);
      }
      if (e.cmd === "GAME_ALL_MISSION_OVER") this.applyAllMissionOver(e);
      if (e.cmd === "PVE_AWARD") {
        const m = this.members.get(e.userId);
        if (m && !m.isBot) this.engine.o.giveItems?.(m, e.items, e.bag);
        continue;
      }
      if (e.cmd === "PVE_STOPPED") {
        if (this.labyrinth) {
          this.labyrinthClosing = true;
          this.pauseLabyrinth(() => this.finishLabyrinth(e.isWin), () => {
            this.applyPveStopped(e);
            this.dispatch(batch.slice(i + 1), () => this.cleanupStop());
          }, true);
          return;
        }
        this.applyPveStopped(e);
        continue;
      }
      const pkt = this.serialize(e);
      if (pkt) this.send(e, pkt);
    }
    after?.();
  }

  private applyPveStopped(e: Extract<FightEvent, { cmd: "PVE_STOPPED" }>): void {
    if (this.pveStoppedApplied) return;
    this.pveStoppedApplied = true;
    // PVEGame.Stop: unlock only after the whole Dungeon, before ResetRoom/onFinished.
    if (this.pve && this.game instanceof PveGame) {
      for (const living of this.game.players) {
        // Engine-side load timeouts can leave an inactive player in members; dead teammates remain eligible.
        if (!living.isActive) continue;
        const m = this.members.get(living.spec.userId);
        if (!m || m.isBot) continue;
        const permission = unlockDungeonPvePermission(m.info.PvePermission, this.game.info, {
          roomType: this.s.roomType, isWin: e.isWin, hasNextMission: e.hasNextMission, hardLevel: this.pve.hardLevel,
        });
        if (permission !== m.info.PvePermission) {
          m.info.PvePermission = permission;
          m.updateProperties?.();
        }
      }
    }
    this.engine.o.log?.(`pve ${this.id}: stopped, win=${e.isWin}`);
    this.pve?.onFinished?.(e.isWin);
  }

  /** PVEGame.GameOver: PlayerDetail.AddGP(exp) (grade is written after), OnMissionOver (quests) */
  private applyMissionOver(e: Extract<FightEvent, { cmd: "GAME_MISSION_OVER" }>): void {
    for (const r of e.players) {
      const m = this.members.get(r.userId);
      if (!m || m.isBot) continue;
      const xr = this.engine.o.expRate?.() ?? 1;
      if (xr > 1) r.gainGP = Math.trunc(r.gainGP * xr);
      const lp = m as LobbyLike & { addGP?(v: number): void };
      if (lp.addGP) lp.addGP(r.gainGP);
      else (m.info as unknown as Record<string, number>).GP += r.gainGP;
      r.grade = (m.info as unknown as Record<string, number>).Grade ?? r.grade;
      try {
        this.engine.o.onMissionOver?.(m, { missionId: e.missionId, isWin: r.isWin, turnNum: r.turnNum, roomType: this.s.roomType, gameType: this.s.gameType, pveId: this.pve?.pveId, hardLevel: this.pve?.hardLevel });
      } catch (err) {
        this.engine.o.log?.(`pve ${this.id}: onMissionOver failed: ${(err as Error).message}`);
      }
    }
  }
  /** PVEGame.GameOverAllSession: PlayerDetail.OnGameOver (quest game conditions) */
  private applyAllMissionOver(e: Extract<FightEvent, { cmd: "GAME_ALL_MISSION_OVER" }>): void {
    for (const r of e.players) {
      const m = this.members.get(r.userId);
      if (!m || m.isBot) continue;
      this.finishParticipant(r.userId);
      if (e.roomType === 14 && this.bossAttempt && r.totalHurt > 0) this.engine.o.onWorldBossHurt?.(m, r.totalHurt, this.bossAttempt);
      try {
        this.engine.o.onPlayerGameOver?.(m, { roomType: e.roomType, gameType: e.gameType, isWin: r.isWin, kills: r.totalKill, playerCount: e.players.length });
      } catch (err) {
        this.engine.o.log?.(`pve ${this.id}: onPlayerGameOver failed: ${(err as Error).message}`);
      }
    }
  }

  /** PVPGame.GameOver → PlayerDetail.AddGP / AddOffer / AddMoney / AddGiftToken; Match: Win/Total (GamePlayer.OnGameOver). */
  private applyRewards(e: Extract<FightEvent, { cmd: "GAME_OVER" }>): void {
    for (const r of e.players) {
      const m = this.members.get(r.userId);
      if (!m || m.isBot) continue;
      if (r.canTakeOut > 0) this.canTakeOut.set(r.userId, r.canTakeOut);
      const xr = this.engine.o.expRate?.() ?? 1;
      if (xr > 1) r.gpGained = Math.trunc(r.gpGained * xr);
      const c = m.info as unknown as Record<string, number>;
      c.GP = (c.GP ?? 0) + r.gpGained;
      const g = this.engine.o.gradeForGp?.(c.GP);
      if (g && g > (c.Grade ?? 0)) {
        c.Grade = g; // level up: HP and grade quests (GamePlayer.AddGP -> UpdateLevel)
        (m as LobbyLike & { updatePlayerProperties?(): void }).updatePlayerProperties?.();
        (m as LobbyLike & { questInv?: { refresh(): void } | null }).questInv?.refresh();
      }
      c.Offer = (c.Offer ?? 0) + r.offer;
      if (r.money > 0) c.Money = (c.Money ?? 0) + r.money;
      if (this.s.roomType === 0) {
        if (r.win) c.Win = (c.Win ?? 0) + 1;
        c.Total = (c.Total ?? 0) + 1;
      }
      if (r.giftToken > 0 && m.addGiftToken) m.addGiftToken(r.giftToken);
      else m.updateProperties?.();
      r.gp = c.GP;
      r.grade = c.Grade ?? r.grade;
      try {
        this.engine.o.onPlayerGameOver?.(m, { roomType: this.s.roomType, gameType: this.s.gameType, isWin: r.win, kills: r.totalKill, playerCount: e.players.length });
      } catch (err) {
        this.engine.o.log?.(`fight ${this.id}: onPlayerGameOver failed: ${(err as Error).message}`);
      }
    }
    try {
      const players = e.players.flatMap((r) => {
        const m = this.members.get(r.userId);
        return m && !m.isBot ? [{ member: m as RoomMember, team: this.teamOf.get(r.userId) ?? 0, win: r.win, totalHurt: r.totalHurt }] : [];
      });
      this.engine.o.onGameOver?.({ roomType: this.s.roomType, gameType: this.s.gameType, winTeam: e.winTeam, players });
    } catch (err) {
      this.engine.o.log?.(`fight ${this.id}: onGameOver failed: ${(err as Error).message}`);
    }
  }

  private serialize(e: FightEvent): PacketOut | null {
    if (e.cmd === "GAME_CREATE") {
      const views: Out.FightPlayerView[] = e.players.map((pl) => {
        const m = this.members.get(pl.userId)!;
        const v = m.view();
        const w = m.mainWeapon ?? null;
        const pet = this.game.players.find((x) => x.spec.userId === pl.userId)?.spec.pet ?? null;
        return { ...v, team: pl.team, livingId: pl.livingId, maxBlood: pl.maxBlood, weaponRefineryLevel: w?.RefineryLevel ?? 0, weaponName: w?.template.Name ?? "", pet };
      }).filter(Boolean);
      return Out.gameCreate(e.roomType, e.gameType, e.timeType, views);
    }
    if (e.cmd === "GAME_LOAD") {
      // GameNeedPetSkill: skill effect assets (only those of the battle pets in this game; the original sent every one)
      const seen = new Set<string>();
      const pets = this.game.players.flatMap((x) => x.spec.pet?.skills ?? []).filter((k) => k.effectPic && !seen.has(k.effectPic) && seen.add(k.effectPic)).map((k) => ({ pic: k.pic ?? "", effect: k.effectPic! }));
      return Out.gameLoad(e.maxTime, e.mapId, e.files ?? [], pets);
    }
    return serializeEvent(e);
  }
}

/** 91 GAME_CMD body writers for every engine event (C# file:line in packages/fight/src/game/events.ts). */
export function serializeEvent(e: FightEvent): PacketOut | null {
  if (e.cmd === "PVE_AWARD" || e.cmd === "PVE_STOPPED" || e.cmd === "LABYRINTH_AWARD") return null;
  // BaseGame.SendEquipEffect (BaseGame.cs:2146): not a GAME_CMD — its own packet (code 3: writeInt(3), writeString).
  if (e.cmd === "EQUIP_EFFECT_MSG") {
    const p = new PacketOut(3);
    p.writeInt(3);
    p.writeString(e.message);
    return p;
  }
  const p = new PacketOut(91, e.livingId, e.livingId);
  p.writeByte(e.code);
  switch (e.cmd) {
    case "SEND_PICTURE":
      p.writeInt(e.type);
      p.writeBoolean(e.state);
      break;
    case "RAW":
      for (const [t, v] of e.body) {
        if (t === "u8") p.writeByte((v as number) & 0xff);
        else if (t === "i32") p.writeInt(v as number);
        else if (t === "bool") p.writeBoolean(v as boolean);
        else if (t === "str") p.writeString(String(v ?? ""));
        else p.writeDateTime(new Date(v as number));
      }
      break;
    case "GAME_MISSION_OVER":
      // PVEGame.cs:809-877
      p.writeInt(e.bossCardCount);
      if (!e.showLarge) { p.writeBoolean(false); p.writeBoolean(false); }
      else { p.writeBoolean(true); p.writeString(e.pic); p.writeBoolean(true); }
      p.writeInt(e.players.length);
      for (const r of e.players) {
        p.writeInt(r.userId); p.writeInt(r.grade); p.writeInt(0); p.writeInt(Math.min(r.gainGP, 10000)); p.writeBoolean(r.isWin);
        p.writeInt(e.bossCardCount); p.writeInt(r.bossCardCount); p.writeBoolean(false); p.writeBoolean(false);
      }
      if (e.bossCardCount > 0) {
        p.writeInt(e.resources?.length ?? 0);
        for (const s of e.resources ?? []) p.writeString(s);
      }
      break;
    case "GAME_ALL_MISSION_OVER":
      // PVEGame.cs:960-1001
      p.writeInt(e.players.length);
      for (const r of e.players) {
        p.writeInt(r.userId); p.writeInt(r.totalKill); p.writeInt(r.totalHurt); p.writeInt(r.totalScore); p.writeInt(r.totalCure);
        for (let i = 0; i < 8; i++) p.writeInt(0);
        p.writeInt(r.totalExp); p.writeBoolean(r.isWin);
      }
      p.writeInt(e.resources.length);
      for (const s of e.resources) p.writeString(s);
      break;
    case "LOAD":
      p.writeInt(e.progress); p.writeInt(0); p.writeInt(e.userId);
      break;
    case "SYNC_LIFETIME":
      p.writeInt(e.lifeTime);
      break;
    case "START_GAME":
      p.writeInt(e.players.length);
      for (const s of e.players) {
        p.writeInt(s.id); p.writeInt(s.x); p.writeInt(s.y); p.writeInt(s.direction); p.writeInt(s.blood); p.writeInt(s.maxBlood); p.writeInt(s.team);
        p.writeInt(s.weaponRefineryLevel); p.writeInt(s.powerRatio); p.writeInt(s.dander); p.writeInt(s.buffs.length);
        for (const b of s.buffs) { p.writeInt(b.type); p.writeInt(b.value); }
        p.writeInt(0); p.writeBoolean(s.isFrost); p.writeBoolean(s.isHide); p.writeBoolean(s.isNoHole); p.writeBoolean(false); p.writeInt(0);
      }
      p.writeDateTime(new Date());
      break;
    case "TURN":
      p.writeBoolean(e.windPositive); p.writeByte(e.vane1); p.writeByte(e.vane2); p.writeByte(e.vane3); p.writeBoolean(e.isHide); p.writeInt(e.turnTime);
      p.writeInt(e.boxes.length);
      for (const b of e.boxes) { p.writeInt(b.id); p.writeInt(b.x); p.writeInt(b.y); p.writeInt(b.type); }
      p.writeInt(e.players.length);
      for (const t of e.players) {
        p.writeInt(t.id); p.writeBoolean(t.isLiving); p.writeInt(t.x); p.writeInt(t.y); p.writeInt(t.blood); p.writeBoolean(t.isNoHole); p.writeInt(t.energy);
        p.writeInt(t.psychic); p.writeInt(t.dander); p.writeInt(t.petMaxMP); p.writeInt(t.petMP); p.writeInt(t.shootCount); p.writeInt(t.flyCount);
      }
      p.writeInt(e.turnIndex);
      break;
    case "FIRE":
      p.writeInt(e.wind10); p.writeBoolean(e.windPositive); p.writeByte(e.vane1); p.writeByte(e.vane2); p.writeByte(e.vane3);
      p.writeInt(e.bombs.length);
      for (const b of e.bombs) {
        p.writeInt(b.bombCount); p.writeInt(b.shootCount); p.writeBoolean(b.digMap); p.writeInt(b.bombId); p.writeInt(b.x); p.writeInt(b.y);
        p.writeInt(b.vx); p.writeInt(b.vy); p.writeInt(b.ballId); p.writeString(b.flyingPartical); p.writeInt(b.radii); p.writeInt(b.power);
        p.writeInt(b.actions.length);
        for (const a of b.actions) { p.writeInt(a.timeInt); p.writeInt(a.type); p.writeInt(a.param1); p.writeInt(a.param2); p.writeInt(a.param3); p.writeInt(a.param4); }
      }
      if (e.petActions.length) {
        p.writeInt(e.petActions.length);
        for (const a of e.petActions) for (const v of a) p.writeInt(v);
        p.writeInt(1);
      } else { p.writeInt(0); p.writeInt(0); }
      break;
    case "HEALTH":
      p.writeByte(e.type & 0xff); p.writeInt(e.blood); p.writeInt(e.value);
      break;
    case "DANDER":
      p.writeInt(e.dander);
      break;
    case "DIRECTION":
      p.writeInt(e.direction);
      break;
    case "MOVESTART":
      p.writeBoolean(false); p.writeByte(e.type); p.writeInt(e.x); p.writeInt(e.y); p.writeByte(e.dir & 0xff); p.writeBoolean(e.isLiving);
      if (e.type === 2) {
        p.writeInt(e.boxes?.length ?? 0);
        for (const b of e.boxes ?? []) { p.writeInt(b.x); p.writeInt(b.y); }
      }
      break;
    case "SKIPNEXT":
    case "BOT_COMMAND":
      break;
    case "PROP":
      p.writeByte(e.type & 0xff); p.writeInt(e.place); p.writeInt(e.templateId); p.writeInt(e.userLivingId); p.writeBoolean(e.templateId === 10017);
      break;
    case "CHANGE_BALL":
      p.writeBoolean(e.special); p.writeInt(e.ballId);
      break;
    case "FROST":
    case "HIDE":
    case "NONOLE":
      p.writeBoolean(e.state);
      break;
    case "VANE":
      p.writeInt(e.wind10); p.writeBoolean(e.windPositive); p.writeByte(e.vane1); p.writeByte(e.vane2); p.writeByte(e.vane3);
      break;
    case "ADDATTACK":
      p.writeByte(e.shootCount & 0xff);
      break;
    case "FIRE_TAG":
      p.writeBoolean(e.hasTime); p.writeByte(e.speedTime & 0xff);
      break;
    case "USE_DEPUTY_WEAPON":
      p.writeInt(e.remaining);
      break;
    case "PLAYER_PROPERTY":
      p.writeString(e.type); p.writeString(e.state);
      break;
    case "GAME_OVER":
      p.writeInt(e.players.length);
      for (const r of e.players) {
        p.writeInt(r.id); p.writeBoolean(r.win); p.writeInt(r.grade); p.writeInt(r.gp); p.writeInt(r.totalKill); p.writeInt(r.gpGained); p.writeInt(r.hitCount);
        p.writeInt(r.psychic); p.writeInt(r.vipBonus); p.writeInt(0); p.writeInt(0); p.writeInt(0); p.writeInt(0); p.writeInt(0); p.writeInt(0); p.writeInt(r.reward);
        p.writeInt(0); p.writeInt(0); p.writeInt(r.gpGained); p.writeInt(r.offer); p.writeInt(0); p.writeInt(r.isVip ? 1 : 0); p.writeInt(0); p.writeInt(0); p.writeInt(0);
        p.writeInt(0); p.writeInt(r.offer); p.writeInt(r.canTakeOut);
      }
      p.writeInt(e.riches);
      break;
    default:
      return null;
  }
  return p;
}

/** PvE-only C→S GAME_CMD subs (MissionPrepare 116, TakeCard 98 / BossTakeCard 130, PassDrama 133, TryAgain 119, MissionEvent 23). */
export function parsePveCommand(sub: number, pkt: GSPacket): FightCommand | null {
  switch (sub) {
    case 116: return { cmd: "MISSION_PREPARE", ready: pkt.readBoolean() };
    case 98: case 130: return { cmd: "TAKE_CARD", index: pkt.readByte() };
    case 133: return { cmd: "PASS_DRAMA", pass: pkt.readBoolean() };
    case 119: return { cmd: "TRY_AGAIN", tryAgain: pkt.readInt(), isHost: pkt.readBoolean() };
    // TransmissionGateCommand (137): readies the player stepping onto the gate between multi-floor PvE sessions.
    case 137: return { cmd: "DELIVER", ready: pkt.readBoolean() };
    case 23: {
      // MissionEventCommand → PVEGame.GeneralCommand(packet): the script reads ints (fight lab: type, quizId, answer)
      const data: number[] = [];
      while (pkt.length - pkt.offset >= 4 && data.length < 16) data.push(pkt.readInt());
      return { cmd: "MISSION_EVENT", data };
    }
    default: return null;
  }
}

/** C→S GAME_CMD readers (Game.Logic/Cmd/*.cs). `pkt` is positioned at the body start. */
export function parseCommand(pkt: GSPacket): FightCommand | null {
  const sub = pkt.readByte();
  switch (sub) {
    case 16: return { cmd: "LOAD", progress: pkt.readInt() };
    case 2: return { cmd: "FIRE", x: pkt.readInt(), y: pkt.readInt(), force: pkt.readInt(), angle: pkt.readInt() };
    case 96: {
      const hasTime = pkt.readBoolean();
      return { cmd: "FIRE_TAG", hasTime, speedTime: hasTime ? pkt.readByte() : 0 };
    }
    case 12: return { cmd: "SKIPNEXT", spendTime: pkt.readByte() };
    case 7: return { cmd: "DIRECTION", direction: pkt.readInt() };
    case 9: {
      pkt.readBoolean();
      const type = pkt.readByte(), x = pkt.readInt(), y = pkt.readInt(), dir = pkt.readByte(), isLiving = pkt.readBoolean();
      return { cmd: "MOVESTART", type, x, y, dir, isLiving, turnIndex: pkt.readShort() };
    }
    case 32: return { cmd: "PROP", bag: pkt.readByte(), place: pkt.readInt(), templateId: pkt.readInt() };
    case 15: return { cmd: "STUNT" };
    case 40: return { cmd: "AIRPLANE" };
    case 17: return { cmd: "SUICIDE" };
    case 84: return { cmd: "USE_DEPUTY_WEAPON" };
    case 54: return { cmd: "GHOST_TARGET", x: pkt.readInt(), y: pkt.readInt() };
    case 143: return { cmd: "BOT_COMMAND" };
    case 49: return { cmd: "PICK", boxId: pkt.readInt() }; // PickCommand
    case 144: return { cmd: "PET_SKILL", skillId: pkt.readInt(), type: pkt.readInt() }; // PetKillCommand
    default: return null;
  }
}
