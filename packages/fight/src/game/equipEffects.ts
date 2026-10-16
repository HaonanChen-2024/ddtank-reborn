/**
 * Gem/rune "equip effects": `Game.Logic/Effects/*.cs`, dispatched by `Player.InitBuffer(equpedEffect)`
 * (Player.cs:680-767) — a switch on `ItemTemplateInfo.Property3` (1..26) over the gem/rune ids worn in the
 * equipment holes (`GamePlayer.EquipEffect`, Property3=special-effect kind, Property4=count/value, Property5=
 * probability·100 (0..10000) or turn-count, depending on the kind). `applyEquipEffects` below is `InitBuffer`.
 *
 * Every effect here is `BasePlayerEffect` (player-only, Effects/BasePlayerEffect.cs) and almost all gate on the
 * shared per-Living `attackGemLimit`/`defendGemLimit` cooldown (Living.cs:168-170/1597-1607: at most one attack-gem
 * proc every `EQUIP_PROC.attack` rounds, one defence-gem proc every `EQUIP_PROC.defend` rounds — decremented once
 * per round in `Living.prepareNewTurn`, see living.ts).
 *
 * Deviation from the C#: each `AbstractEffect` there owns a fresh unseeded `System.Random` (reseeded by wall clock
 * on every construction) — i.e. gem procs are *not* part of the C# server's own determinism story either way. We
 * route the proc rolls through the game's seeded `DotNetRandom` instead, so this port stays bit-reproducible under
 * the same seed (consistent with the rest of `@ddt/fight`); see README "Deviations from the C#".
 *
 * Client-visible: a proc sends PICTURE (128, buff icon) and/or an EQUIP_EFFECT_MSG (packet 3, floating text) exactly
 * like `BaseGame.SendPlayerPicture`/`SendEquipEffect` (BaseGame.cs:2146/2834); see game/events.ts.
 */
import type { Living, Player } from "./living.js";
import { isSpecialBall } from "../data/types.js";
import { AbstractEffect, BasePlayerEffect, EQUIP_PROC } from "./effects.js";
import { LanguageMgr } from "../pve/cs.js";

const T = {
  AddAttack: 101, AddDefence: 102, AddAgility: 103, AddLucky: 104, AddDamage: 105, ReduceDamage: 106, AddBlood: 107,
  Fatal: 108, IceFronzeEquip: 109, NoHoleEquip: 110, AtomBomb: 111, ArmorPiercer: 112, AvoidDamage: 113, MakeCritical: 114,
  AssimilateDamage: 115, AssimilateBlood: 116, SealEquip: 117, AddTurnEquip: 118, AddDander: 119, ReflexDamage: 120,
  ReduceStrengthEquip: 121, ContinueReduceBloodEquip: 122, LockDirectionEquip: 123, AddBombEquip: 124,
  ContinueReduceDamageEquip: 125, RecoverBlood: 126,
  // status sub-effects applied to a killed target (no existing analog in Living's ice/hide/nohole/seal map)
  LockDirection: 150, ReduceStrength: 151, ContinueReduceBlood: 152, ContinueReduceDamage: 153,
} as const;

const roll = (l: Living, p: number) => l.game.rng.nextMax(100) < p;
const picture = (l: Living, type: number, state: boolean) => l.game.emit({ cmd: "SEND_PICTURE", livingId: l.id, type, state });
const msg = (l: Living, text: string) => l.game.emit({ cmd: "EQUIP_EFFECT_MSG", livingId: l.id, message: text });
/** Resolve the server translator at proc time; standalone engines keep their English notices. */
function effectMessage(key: string, fallback: string): string {
  const text = String(LanguageMgr.GetTranslation(key));
  return text === key ? fallback : text;
}
const PROC_MSG = {
  get attack() { return effectMessage("AttackEffect.Success", "Attack gem effect!"); },
  get defend() { return effectMessage("DefenceEffect.Success", "Defence gem effect!"); },
  get fatal() { return effectMessage("FatalEffect.Success", "First shot: guided!"); },
};

// ---------------------------------------------------------------------------- status sub-effects (kill-triggered)

/** Effects/LockDirectionEffect.cs — direction locked for `count` self-turns. */
export class LockDirectionEffect extends AbstractEffect {
  constructor(private count: number) {
    super(T.LockDirection);
  }
  private readonly tick = (l: Living) => {
    if (--this.count < 0) this.stop();
  };
  override start(living: Living): boolean {
    const o = living.effectList.getOfType(T.LockDirection) as LockDirectionEffect | undefined;
    if (o) {
      o.count = this.count;
      return true;
    }
    return super.start(living);
  }
  override onAttached(l: Living): void {
    l.hooks.on("beginSelfTurn", this.tick);
    l.lockDirection = true;
    picture(l, 3, true);
  }
  override onRemoved(l: Living): void {
    l.hooks.off("beginSelfTurn", this.tick);
    l.lockDirection = false;
    picture(l, 3, false);
  }
}

/** Effects/ReduceStrengthEffect.cs — energy drained by `reduce` every self-turn for `count` turns. */
export class ReduceStrengthEffect extends AbstractEffect {
  constructor(private count: number, private reduce: number) {
    super(T.ReduceStrength);
  }
  private readonly tick = (l: Living) => {
    this.count--;
    const p = l as Player;
    if (p.kind === "player") p.energy -= this.reduce;
    if (this.count < 0) this.stop();
  };
  override start(living: Living): boolean {
    const o = living.effectList.getOfType(T.ReduceStrength) as ReduceStrengthEffect | undefined;
    if (o) {
      o.count = this.count;
      return true;
    }
    return super.start(living);
  }
  override onAttached(l: Living): void {
    l.hooks.on("beginSelfTurn", this.tick);
    picture(l, 1, true);
  }
  override onRemoved(l: Living): void {
    l.hooks.off("beginSelfTurn", this.tick);
    picture(l, 1, false);
  }
}

/** Effects/ContinueReduceBloodEffect.cs — `blood` HP lost every self-turn for `count` turns (a bleed/poison DOT). */
export class ContinueReduceBloodEffect extends AbstractEffect {
  constructor(private count: number, private blood: number, private source: Living | null) {
    super(T.ContinueReduceBlood);
  }
  private readonly tick = (l: Living) => {
    if (--this.count < 0) {
      this.stop();
      return;
    }
    l.addBlood(-this.blood, 1);
  };
  override start(living: Living): boolean {
    const o = living.effectList.getOfType(T.ContinueReduceBlood) as ContinueReduceBloodEffect | undefined;
    if (o) {
      o.count = this.count;
      return true;
    }
    return super.start(living);
  }
  override onAttached(l: Living): void {
    l.hooks.on("beginSelfTurn", this.tick);
    picture(l, 2, true);
  }
  override onRemoved(l: Living): void {
    l.hooks.off("beginSelfTurn", this.tick);
    picture(l, 2, false);
  }
}

/** Effects/ContinueReduceDamageEffect.cs — outgoing BaseDamage cut to 5% for `count` self-turns. */
export class ContinueReduceDamageEffect extends AbstractEffect {
  constructor(private count: number) {
    super(T.ContinueReduceDamage);
  }
  private readonly tick = (l: Living) => {
    if (--this.count < 0) this.stop();
  };
  override start(living: Living): boolean {
    const o = living.effectList.getOfType(T.ContinueReduceDamage) as ContinueReduceDamageEffect | undefined;
    if (o) {
      o.count = this.count;
      return true;
    }
    return super.start(living);
  }
  override onAttached(l: Living): void {
    l.hooks.on("beginSelfTurn", this.tick);
    l.baseDamage = (l.baseDamage * 5) / 100;
    picture(l, 4, true);
  }
  override onRemoved(l: Living): void {
    l.hooks.off("beginSelfTurn", this.tick);
    l.baseDamage = (l.baseDamage * 100) / 5;
    picture(l, 4, false);
  }
}

// ---------------------------------------------------------------------------- proc effects (Player.InitBuffer 1..26)

/** Shared skeleton: one proc roll against `probability`/100, gated by the attack/defend gem cooldown, refreshing
 * `probability` (not count) on re-Start like every C# effect here does. */
abstract class ProcEffect extends BasePlayerEffect {
  protected probability: number;
  constructor(type: number, protected count: number, probability: number, private gem: "attack" | "defend" = "attack") {
    super(type);
    this.probability = probability;
  }
  override start(living: Living): boolean {
    const o = living.effectList.getOfType(this.type) as ProcEffect | undefined;
    if (o) {
      o.probability = Math.max(this.probability, o.probability);
      return true;
    }
    return super.start(living);
  }
  /** common gate: CurrentBall must not be special, and the shared gem cooldown must be free. */
  protected tryProc(p: Player): boolean {
    this.isTrigger = false;
    if (isSpecialBall(p.currentBall.id)) return false;
    const limit = this.gem === "attack" ? p.attackGemLimit : p.defendGemLimit;
    if (limit > 0) return false;
    if (!roll(p, this.probability)) return false;
    if (this.gem === "attack") p.attackGemLimit = EQUIP_PROC.attack;
    else p.defendGemLimit = EQUIP_PROC.defend;
    this.isTrigger = true;
    p.effectTrigger = true;
    return true;
  }
}

/** case 1: AddAttackEffect — +count Attack for the shot about to be fired. */
export class AddAttackEffect extends ProcEffect {
  private added = 0;
  constructor(count: number, probability: number) {
    super(T.AddAttack, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    p.attack -= this.added;
    this.added = 0;
    if (this.tryProc(p)) {
      p.attack += this.count;
      this.added = this.count;
      msg(p, PROC_MSG.attack);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
  }
}

/** case 2: AddDefenceEffect — +count Defence while about to be hit. */
export class AddDefenceEffect extends ProcEffect {
  private added = 0;
  constructor(count: number, probability: number) {
    super(T.AddDefence, count, probability, "defend");
  }
  private readonly onAttacked = (l: Living) => {
    l.defence -= this.added;
    this.added = 0;
    if (this.tryProc(l as Player)) {
      l.defence += this.count;
      this.added = this.count;
      msg(l, PROC_MSG.defend);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("beginAttacked", this.onAttacked);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("beginAttacked", this.onAttacked);
  }
}

/** case 3: AddAgilityEffect — +count Agility while about to be hit. */
export class AddAgilityEffect extends ProcEffect {
  private added = 0;
  constructor(count: number, probability: number) {
    super(T.AddAgility, count, probability, "defend");
  }
  private readonly onAttacked = (l: Living) => {
    l.agility -= this.added;
    this.added = 0;
    if (this.tryProc(l as Player)) {
      l.agility += this.count;
      this.added = this.count;
      msg(l, PROC_MSG.defend);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("beginAttacked", this.onAttacked);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("beginAttacked", this.onAttacked);
  }
}

/** case 4: AddLuckyEffect — +count Lucky for the shot about to be fired. */
export class AddLuckyEffect extends ProcEffect {
  private added = 0;
  constructor(count: number, probability: number) {
    super(T.AddLucky, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    p.lucky -= this.added;
    this.added = 0;
    if (this.tryProc(p)) {
      p.lucky += this.count;
      this.added = this.count;
      msg(p, PROC_MSG.attack);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
  }
}

/** case 5: AddDamageEffect — +count flat damage on the hit this shot lands. */
export class AddDamageEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.AddDamage, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    if (this.tryProc(p)) msg(p, PROC_MSG.attack);
  };
  private readonly onBeforeTakeDamage = (_l: Living, _s: Living, d: { damage: number; critical: number }) => {
    if (this.isTrigger) d.damage += this.count;
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
    // TakePlayerDamage fires on the attacker's own living (acting on the eventual victim's `d`), same site as
    // BeforeTakeDamage in this port: a shared hook fired from the victim's takeDamage(). We subscribe through the
    // victim side instead (next shot's target), handled centrally by effectList lookup in game.ts bombImp.
    p.hooks.on("beforeTakeDamage", this.onBeforeTakeDamage);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
    p.hooks.off("beforeTakeDamage", this.onBeforeTakeDamage);
  }
}

/** case 6: ReduceDamageEffect — flat damage reduction (min 1) on the next hit taken. */
export class ReduceDamageEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.ReduceDamage, count, probability, "defend");
  }
  private readonly onBeforeTakeDamage = (l: Living, _s: Living, d: { damage: number; critical: number }) => {
    if (this.tryProc(l as Player)) {
      d.damage = Math.max(1, d.damage - this.count);
      msg(l, PROC_MSG.defend);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("beforeTakeDamage", this.onBeforeTakeDamage);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("beforeTakeDamage", this.onBeforeTakeDamage);
  }
}

/** case 7: AddBloodEffect — heal `count` HP on shoot or on being attacked. */
export class AddBloodEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.AddBlood, count, probability, "attack");
  }
  private readonly onProc = (l: Living) => {
    if (this.tryProc(l as Player)) {
      l.addBlood(this.count);
      msg(l, PROC_MSG.attack);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onProc);
    p.hooks.on("beginAttacked", this.onProc);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onProc);
    p.hooks.off("beginAttacked", this.onProc);
  }
}

/** case 8: FatalEffect — the "guided shot" aim-assist effect (also the server's free-for-new-players variant,
 * `probability === 15112004`, always on and silent after the first proc — Player.Shoot.cs:2417). */
export class FatalEffect extends ProcEffect {
  private saycount = 0;
  constructor(count: number, probability: number) {
    super(T.Fatal, count, probability, "attack");
  }
  private readonly onNewTurn = () => {
    this.saycount = 0;
  };
  private readonly onShoot = (p: Player) => {
    this.saycount++;
    this.isTrigger = false;
    const free = this.probability === 15112004;
    const procs = free ? true : isSpecialBall(p.currentBall.id) ? false : p.attackGemLimit <= 0 && roll(p, this.probability);
    if (!procs) return;
    if (!free) p.attackGemLimit = EQUIP_PROC.attack;
    p.shootMovieDelay = 50;
    this.isTrigger = true;
    if (p.currentBall.id !== 3) p.controlBall = true;
    if (this.saycount === 1) {
      p.effectTrigger = true;
      msg(p, free ? PROC_MSG.fatal : PROC_MSG.attack);
    }
  };
  private readonly onBeforeTakeDamage = (_l: Living, _s: Living, d: { damage: number; critical: number }) => {
    if (this.isTrigger && this.probability !== 15112004) d.damage = Math.trunc((d.damage * (100 - this.count)) / 100);
  };
  private readonly onAfterShot = (p: Player) => {
    this.isTrigger = false;
    p.controlBall = false;
    p.effectTrigger = false;
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
    p.hooks.on("beforeTakeDamage", this.onBeforeTakeDamage);
    p.hooks.on("beginNewTurn", this.onNewTurn);
    p.hooks.on("afterPlayerShooted", this.onAfterShot);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
    p.hooks.off("beforeTakeDamage", this.onBeforeTakeDamage);
    p.hooks.off("beginNewTurn", this.onNewTurn);
    p.hooks.off("afterPlayerShooted", this.onAfterShot);
  }
}

/** case 9: IceFronzeEquipEffect — chance to fire the frost ball instead. */
export class IceFronzeEquipEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.IceFronzeEquip, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    if (this.tryProc(p)) {
      p.setBall(1);
      msg(p, PROC_MSG.attack);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
  }
}

/** case 10: NoHoleEquipEffect — on being hit, chance to become NoHole for 1 self-turn. Approximation: the C#
 * fires on `Player.CollidByObject` (the instant a bomb touches the player); we fire from `beginAttacked`
 * (the closest hook we have at the "about to take damage" moment) — see README deviations. */
export class NoHoleEquipEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.NoHoleEquip, count, probability, "defend");
  }
  private readonly onAttacked = (l: Living) => {
    if (roll(l, this.probability) && l.defendGemLimit <= 0) {
      l.defendGemLimit = EQUIP_PROC.defend;
      l.effectTrigger = true;
      l.startEffect("nohole", 1);
      msg(l, PROC_MSG.defend);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("beginAttacked", this.onAttacked);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("beginAttacked", this.onAttacked);
  }
}

/** case 11: AtomBombEquipEffect — chance to fire the nuke ball (id 4) instead. */
export class AtomBombEquipEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.AtomBomb, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    if ((isSpecialBall(p.currentBall.id)) || p.attackGemLimit > 0) return;
    if (roll(p, this.probability) && roll(p, this.probability)) {
      p.setBall(4);
      msg(p, PROC_MSG.attack);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
  }
}

/** case 12: ArmorPiercerEquipEffect — chance to ignore armour for one shot. */
export class ArmorPiercerEquipEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.ArmorPiercer, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    if ((isSpecialBall(p.currentBall.id)) || p.attackGemLimit > 0) return;
    if (roll(p, this.probability) && roll(p, this.probability)) {
      p.attackGemLimit = 5;
      p.ignoreArmor = true;
      p.effectTrigger = true;
      msg(p, PROC_MSG.attack);
    }
  };
  private readonly onAfterShot = (p: Player) => {
    p.ignoreArmor = false;
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
    p.hooks.on("afterPlayerShooted", this.onAfterShot);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
    p.hooks.off("afterPlayerShooted", this.onAfterShot);
  }
}

/** case 13: AvoidDamageEffect — % damage reduction on the next hit taken. */
export class AvoidDamageEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.AvoidDamage, count, probability, "defend");
  }
  private readonly onBeforeTakeDamage = (l: Living, _s: Living, d: { damage: number; critical: number }) => {
    if (this.tryProc(l as Player)) {
      d.damage = Math.trunc((d.damage * (100 - this.count)) / 100);
      msg(l, PROC_MSG.defend);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("beforeTakeDamage", this.onBeforeTakeDamage);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("beforeTakeDamage", this.onBeforeTakeDamage);
  }
}

/** case 14: MakeCriticalEffect — forces a critical hit (Lucky-scaled) on the shot landing. */
export class MakeCriticalEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.MakeCritical, count, probability, "attack");
  }
  private readonly onBeforeTakeDamage = (l: Living, source: Living, d: { damage: number; critical: number }) => {
    if (this.tryProc(source as Player)) {
      d.critical = Math.trunc(0.5 + source.lucky * 0.0005 * d.damage);
      source.flyingPartical = 65;
      msg(source, PROC_MSG.attack);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("beforeTakeDamage", this.onBeforeTakeDamage);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("beforeTakeDamage", this.onBeforeTakeDamage);
  }
}

/** case 15: AssimilateDamageEffect — absorb the incoming hit as healing instead of damage (capped at `count`). */
export class AssimilateDamageEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.AssimilateDamage, count, probability, "defend");
  }
  private readonly onBeforeTakeDamage = (l: Living, _s: Living, d: { damage: number; critical: number }) => {
    if (this.tryProc(l as Player)) {
      l.addBlood(Math.min(d.damage, this.count));
      d.damage = 0;
      d.critical = 0;
      msg(l, PROC_MSG.defend);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("beforeTakeDamage", this.onBeforeTakeDamage);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("beforeTakeDamage", this.onBeforeTakeDamage);
  }
}

/** case 16: AssimilateBloodEffect — lifesteal: heal count% of the hit this shot lands. */
export class AssimilateBloodEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.AssimilateBlood, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    if (this.tryProc(p)) msg(p, PROC_MSG.attack);
  };
  private readonly onBeforeTakeDamage = (l: Living, source: Living, d: { damage: number; critical: number }) => {
    if (l.isLiving && (source.effectList.getOfType(T.AssimilateBlood) as AssimilateBloodEffect | undefined)?.isTrigger) {
      source.addBlood(Math.trunc((d.damage * this.count) / 100));
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
    p.hooks.on("beforeTakeDamage", this.onBeforeTakeDamage);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
    p.hooks.off("beforeTakeDamage", this.onBeforeTakeDamage);
  }
}

/** case 17: SealEquipEffect — on killing/hitting a living, 2-turn Seal on the attacker's next shot. */
export class SealEquipEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.SealEquip, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    if (this.tryProc(p)) msg(p, PROC_MSG.attack);
  };
  private readonly onAfterKilling = (l: Living, target: Living) => {
    if (this.isTrigger) target.startEffect("seal", 2);
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
    p.hooks.on("afterKillingLiving", this.onAfterKilling);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
    p.hooks.off("afterKillingLiving", this.onAfterKilling);
  }
}

/** case 18: AddTurnEquipEffect — "extra turn" gem: on proc, next turn's delay is slashed count% and energy is
 * reset to a weapon-tier percentage (Player.cs:2396-2416 hard-coded table). */
const ADD_TURN_ENERGY: Record<number, number> = {
  311112: 50, 311129: 50, 311212: 50, 311229: 55, 311312: 60, 311329: 65, 311412: 70, 311429: 75, 311512: 75, 311529: 75,
};
export class AddTurnEquipEffect extends ProcEffect {
  constructor(count: number, probability: number, private templateId: number) {
    super(T.AddTurnEquip, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    if (this.tryProc(p)) msg(p, PROC_MSG.attack);
  };
  private readonly onAfterShot = (p: Player) => {
    if (this.isTrigger) {
      p.addQuipTurn = true;
      p.delay = 0;
    }
  };
  private readonly onSelfTurn = (l: Living) => {
    if (!this.isTrigger || l.kind !== "player") return;
    const p = l as Player;
    p.addQuipTurn = false;
    p.delay += Math.trunc((p.delay * this.count) / 100);
    const energyPct = ADD_TURN_ENERGY[this.templateId] ?? 0;
    p.energy = Math.trunc((p.energy * energyPct) / 100);
    this.isTrigger = false;
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
    p.hooks.on("afterPlayerShooted", this.onAfterShot);
    p.hooks.on("beginSelfTurn", this.onSelfTurn);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
    p.hooks.off("afterPlayerShooted", this.onAfterShot);
    p.hooks.off("beginSelfTurn", this.onSelfTurn);
  }
}

/** case 19: AddDanderEquipEffect — on being hit, chance to gain `count` dander (special-skill gauge). */
export class AddDanderEquipEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.AddDander, count, probability, "defend");
  }
  private readonly onAttacked = (l: Living) => {
    if (this.tryProc(l as Player)) {
      (l as Player).addDander(this.count);
      msg(l, PROC_MSG.defend);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("beginAttacked", this.onAttacked);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("beginAttacked", this.onAttacked);
  }
}

/** case 20: ReflexDamageEquipEffect — on being hit, chance to reflect `count` HP back at the attacker. */
export class ReflexDamageEquipEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.ReflexDamage, count, probability, "defend");
  }
  private readonly onAttacked = (l: Living) => {
    if (this.tryProc(l as Player)) msg(l, PROC_MSG.defend);
  };
  private readonly onTakenHit = (l: Living, source: Living) => {
    if (this.isTrigger) source.addBlood(-this.count);
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("beginAttacked", this.onAttacked);
    p.hooks.on("afterTakenHit", this.onTakenHit);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("beginAttacked", this.onAttacked);
    p.hooks.off("afterTakenHit", this.onTakenHit);
  }
}

/** case 21: ReduceStrengthEquipEffect — on killing/hitting, 2-turn energy drain on the target. */
export class ReduceStrengthEquipEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.ReduceStrengthEquip, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    if (this.tryProc(p)) msg(p, PROC_MSG.attack);
  };
  private readonly onAfterKilling = (l: Living, target: Living) => {
    if (this.isTrigger) new ReduceStrengthEffect(2, this.count).start(target);
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
    p.hooks.on("afterKillingLiving", this.onAfterKilling);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
    p.hooks.off("afterKillingLiving", this.onAfterKilling);
  }
}

/** case 22: ContinueReduceBloodEquipEffect — on killing/hitting, 2-turn bleed on the target. */
export class ContinueReduceBloodEquipEffect extends ProcEffect {
  constructor(private blood: number, probability: number) {
    super(T.ContinueReduceBloodEquip, blood, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    if (this.tryProc(p)) msg(p, PROC_MSG.attack);
  };
  private readonly onAfterKilling = (l: Living, target: Living) => {
    if (this.isTrigger) new ContinueReduceBloodEffect(2, this.blood, l).start(target);
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
    p.hooks.on("afterKillingLiving", this.onAfterKilling);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
    p.hooks.off("afterKillingLiving", this.onAfterKilling);
  }
}

/** case 23: LockDirectionEquipEffect — on killing/hitting, 2-turn direction-lock on the target. */
export class LockDirectionEquipEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.LockDirectionEquip, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    if (this.tryProc(p)) msg(p, PROC_MSG.attack);
  };
  private readonly onAfterKilling = (l: Living, target: Living) => {
    if (this.isTrigger) new LockDirectionEffect(2).start(target);
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
    p.hooks.on("afterKillingLiving", this.onAfterKilling);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
    p.hooks.off("afterKillingLiving", this.onAfterKilling);
  }
}

/** case 24: AddBombEquipEffect — chance for +count extra shots this turn. */
export class AddBombEquipEffect extends ProcEffect {
  private shown = false;
  constructor(count: number, probability: number) {
    super(T.AddBombEquip, count, probability, "attack");
  }
  private readonly onBeginAttacking = (l: Living) => {
    if (this.tryProc(l as Player)) {
      this.shown = true;
      (l as Player).setShootCount((l as Player).shootCount + this.count);
    }
  };
  private readonly onShoot = (p: Player) => {
    if (this.isTrigger && this.shown) {
      msg(p, PROC_MSG.attack);
      this.shown = false;
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
    p.hooks.on("beginAttacking", this.onBeginAttacking);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
    p.hooks.off("beginAttacking", this.onBeginAttacking);
  }
}

/** case 25: ContinueReduceDamageEquipEffect — on killing/hitting, 2-turn "outgoing damage cut to 5%" on the target. */
export class ContinueReduceDamageEquipEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.ContinueReduceDamageEquip, count, probability, "attack");
  }
  private readonly onShoot = (p: Player) => {
    if (this.tryProc(p)) msg(p, PROC_MSG.attack);
  };
  private readonly onAfterKilling = (l: Living, target: Living) => {
    if (this.isTrigger) new ContinueReduceDamageEffect(2).start(target);
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("playerShoot", this.onShoot);
    p.hooks.on("afterKillingLiving", this.onAfterKilling);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("playerShoot", this.onShoot);
    p.hooks.off("afterKillingLiving", this.onAfterKilling);
  }
}

/** case 26: RecoverBloodEffect — on taking a hit, chance to heal `count` HP. */
export class RecoverBloodEffect extends ProcEffect {
  constructor(count: number, probability: number) {
    super(T.RecoverBlood, count, probability, "defend");
  }
  private readonly onTakenHit = (l: Living) => {
    if (l.isLiving && this.tryProc(l as Player)) {
      l.addBlood(this.count);
      msg(l, PROC_MSG.defend);
    }
  };
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on("afterTakenHit", this.onTakenHit);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off("afterTakenHit", this.onTakenHit);
  }
}

// ---------------------------------------------------------------------------- dispatcher (Player.InitBuffer)

export interface EquipEffectTemplate {
  property3: number;
  property4: number;
  property5: number;
  templateId: number;
}

/** Player.InitBuffer(equpedEffect) (Player.cs:680-767): one effect per worn gem/rune template id. */
export function applyEquipEffects(player: Player, templates: EquipEffectTemplate[]): void {
  for (const t of templates) {
    switch (t.property3) {
      case 1: new AddAttackEffect(t.property4, t.property5).start(player); break;
      case 2: new AddDefenceEffect(t.property4, t.property5).start(player); break;
      case 3: new AddAgilityEffect(t.property4, t.property5).start(player); break;
      case 4: new AddLuckyEffect(t.property4, t.property5).start(player); break;
      case 5: new AddDamageEffect(t.property4, t.property5).start(player); break;
      case 6: new ReduceDamageEffect(t.property4, t.property5).start(player); break;
      case 7: new AddBloodEffect(t.property4, t.property5).start(player); break;
      case 8: new FatalEffect(t.property4, t.property5).start(player); break;
      case 9: new IceFronzeEquipEffect(t.property4, t.property5).start(player); break;
      case 10: new NoHoleEquipEffect(t.property4, t.property5).start(player); break;
      case 11: new AtomBombEquipEffect(t.property4, t.property5).start(player); break;
      case 12: new ArmorPiercerEquipEffect(t.property4, t.property5).start(player); break;
      case 13: new AvoidDamageEffect(t.property4, t.property5).start(player); break;
      case 14: new MakeCriticalEffect(t.property4, t.property5).start(player); break;
      case 15: new AssimilateDamageEffect(t.property4, t.property5).start(player); break;
      case 16: new AssimilateBloodEffect(t.property4, t.property5).start(player); break;
      case 17: new SealEquipEffect(t.property4, t.property5).start(player); break;
      case 18: new AddTurnEquipEffect(t.property4, t.property5, t.templateId).start(player); break;
      case 19: new AddDanderEquipEffect(t.property4, t.property5).start(player); break;
      case 20: new ReflexDamageEquipEffect(t.property4, t.property5).start(player); break;
      case 21: new ReduceStrengthEquipEffect(t.property4, t.property5).start(player); break;
      case 22: new ContinueReduceBloodEquipEffect(t.property4, t.property5).start(player); break;
      case 23: new LockDirectionEquipEffect(t.property4, t.property5).start(player); break;
      case 24: new AddBombEquipEffect(t.property4, t.property5).start(player); break;
      case 25: new ContinueReduceDamageEquipEffect(t.property4, t.property5).start(player); break;
      case 26: new RecoverBloodEffect(t.property4, t.property5).start(player); break;
      default: break;
    }
  }
}
