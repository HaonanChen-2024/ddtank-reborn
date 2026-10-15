/**
 * Generic in-fight effect-layer core, mirroring `Game.Logic/Effects/AbstractEffect.cs` + `EffectList.cs` (gem/equip
 * special effects), `Game.Logic/CardEffect/{AbstractCardEffect,CardEffectList}.cs` (card set bonuses) and
 * `Game.Logic/PetEffects/{AbstractPetEffect,PetEffectList}.cs` (pet skill elements). All three C# families share the
 * exact same shape (type id, Start/Stop via a per-Living list, OnAttached/OnRemoved, "same type already running →
 * refresh instead of stacking"), so one generic `EffectListOf<E>` serves all three — `Living.effectList` /
 * `cardEffectList` / `petEffectList` below.
 *
 * Hook bus: the C# events (`Living.BeginSelfTurn`, `Player.PlayerShoot`, …) are plain C# multicast delegates that
 * effects `+=`/`-=` on attach/detach. `HookBus` is the same thing — effects call `living.hooks.on("beginSelfTurn",
 * fn)` in `onAttached` and `.off(...)` in `onRemoved`. Fired from the exact call sites cited per hook below (all in
 * `living.ts`/`game.ts`), so timing matches the C# invoke sites (`OnBeginSelfTurn`, `OnPlayerShoot`, …).
 */
import type { Living } from "./living.js";
import type { Player } from "./living.js";

export interface DamageRef {
  damage: number;
  critical: number;
}

/** Event name → the exact args the C# delegate carries (living/player first, like the C# `this` receiver). */
export interface HookArgs {
  /** Living.BeginSelfTurn (Living.cs:1345, fired from OnBeginSelfTurn) */
  beginSelfTurn: [living: Living];
  /** Living.BeginNextTurn (Living.cs:1338, fired from OnBeginNewTurn — C#'s naming, not "next" as in "self") */
  beginNewTurn: [living: Living];
  /** Living.BeginAttacking (Living.cs:1388, OnStartAttacking) */
  beginAttacking: [living: Living];
  /** Living.BeginAttacked (Living.cs:1380/2214, OnStartAttacked/OnMakeDamage(living)) */
  beginAttacked: [living: Living];
  /** Living.BeforeTakeDamage (Living.cs:1330, OnBeforeTakedDamage — ref damageAmount/criticalAmount) */
  beforeTakeDamage: [living: Living, source: Living, d: DamageRef];
  /** Living.TakePlayerDamage (Living.cs:1402), fired on the SHOOTER by SimpleBomb.cs:273 before victim.TakeDamage. */
  takePlayerDamage: [living: Living, source: Living, d: DamageRef];
  /** Living.AfterKilledByLiving (Living.cs:1314→, OnAfterTakedDamage) — fires on the VICTIM; `source` = attacker. */
  afterTakenHit: [living: Living, source: Living, damage: number, critical: number];
  /** Living.AfterKillingLiving (Living.cs:1283/2291) — fires on the ATTACKER; `target` = victim. */
  afterKillingLiving: [living: Living, target: Living, damage: number, critical: number];
  /** Player.PlayerShoot (Player.cs:2427, OnPlayerShoot) — before the ball id / damage is resolved. */
  playerShoot: [player: Player];
  /** Player.AfterPlayerShooted (Player.cs:2539, OnAfterPlayerShoot) */
  afterPlayerShooted: [player: Player];
  /** Player.PlayerAfterReset (Player.cs:2232-ish, end of Reset) */
  playerAfterReset: [player: Player];
  /** Player.PlayerCure (fired on the healed player when a CURE ball/spell adds blood) */
  playerCure: [player: Player, heal: number];
}
export type HookName = keyof HookArgs;

/** Living.BeginSelfTurn += fn / -= fn, as a plain typed pub/sub (one per Living, like the C# multicast delegate). */
export class HookBus {
  private readonly m = new Map<string, Set<(...a: never[]) => void>>();
  on<K extends HookName>(event: K, fn: (...a: HookArgs[K]) => void): void {
    (this.m.get(event) ?? this.m.set(event, new Set()).get(event)!).add(fn as never);
  }
  off<K extends HookName>(event: K, fn: (...a: HookArgs[K]) => void): void {
    this.m.get(event)?.delete(fn as never);
  }
  emit<K extends HookName>(event: K, ...a: HookArgs[K]): void {
    const set = this.m.get(event);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) (fn as unknown as (...a: HookArgs[K]) => void)(...a);
  }
}

export interface EffectLike {
  readonly type: number;
  onAttached(living: Living): void;
  onRemoved(living: Living): void;
}

/**
 * Game.Logic/Effects/EffectList.cs (and the identically-shaped CardEffectList.cs / PetEffectList.cs): a bag of
 * effects per Living, "same type twice" refreshes (callers re-check `getOfType` in their own `Start` override —
 * same as C#, this list itself just stores/attaches), optional immunity bitmask (`(1 << id-1) & immunity`, ids
 * 1..40 only — NPC config, always 0 for players so every effect type is always addable here).
 */
export class EffectListOf<E extends EffectLike> {
  private list: E[] = [];
  constructor(private readonly owner: Living, private immunity = 0) {}
  get all(): readonly E[] {
    return this.list;
  }
  canAdd(id: number): boolean {
    return id <= 0 || id > 40 ? true : ((1 << (id - 1)) & this.immunity) === 0;
  }
  add(effect: E): boolean {
    if (!this.canAdd(effect.type)) return false;
    this.list.push(effect);
    effect.onAttached(this.owner);
    return true;
  }
  remove(effect: E): boolean {
    const i = this.list.indexOf(effect);
    if (i < 0) return false;
    this.list.splice(i, 1);
    effect.onRemoved(this.owner);
    return true;
  }
  getOfType(type: number): E | undefined {
    return this.list.find((e) => e.type === type);
  }
  stopAll(): void {
    for (const e of [...this.list]) (e as unknown as { stop?(): void }).stop?.();
  }
}

/** Game.Logic/Effects/AbstractEffect.cs — gem/equip effects (`Living.effectList`). */
export abstract class AbstractEffect implements EffectLike {
  protected living!: Living;
  /** AbstractEffect.IsTrigger: set true by the effect's own proc logic so sibling handlers can read "did I just fire". */
  isTrigger = false;
  constructor(readonly type: number) {}
  start(living: Living): boolean {
    this.living = living;
    return living.effectList.add(this);
  }
  stop(): boolean {
    return this.living ? living_remove(this.living, this) : false;
  }
  onAttached(_living: Living): void {}
  onRemoved(_living: Living): void {}
}
function living_remove(living: Living, e: AbstractEffect): boolean {
  return living.effectList.remove(e);
}

/** Effects/BasePlayerEffect.cs — every gem effect except the pure status ones (Ice/Hide/NoHole/Seal) is player-only. */
export abstract class BasePlayerEffect extends AbstractEffect {
  override start(living: Living): boolean {
    return living.kind === "player" ? super.start(living) : false;
  }
  override onAttached(living: Living): void {
    if (living.kind === "player") this.onAttachedToPlayer(living as Player);
  }
  override onRemoved(living: Living): void {
    if (living.kind === "player") this.onRemovedFromPlayer(living as Player);
  }
  protected onAttachedToPlayer(_player: Player): void {}
  protected onRemovedFromPlayer(_player: Player): void {}
}

/** Game.Logic/CardEffect/AbstractCardEffect.cs — card set bonuses (`Living.cardEffectList`). All are player-only
 * (Game.Logic/CardEffects/BaseCardEffect.cs: `Start` returns false unless `living is Player`). */
export abstract class AbstractCardEffect implements EffectLike {
  protected living!: Living;
  isTrigger = false;
  constructor(readonly type: number) {}
  start(living: Living): boolean {
    if (living.kind !== "player") return false;
    this.living = living;
    return living.cardEffectList.add(this);
  }
  stop(): boolean {
    return this.living ? this.living.cardEffectList.remove(this) : false;
  }
  onAttached(living: Living): void {
    this.onAttachedToPlayer(living as Player);
  }
  onRemoved(living: Living): void {
    this.onRemovedFromPlayer(living as Player);
  }
  protected onAttachedToPlayer(_player: Player): void {}
  protected onRemovedFromPlayer(_player: Player): void {}
}

/** Game.Logic/PetEffects/AbstractPetEffect.cs — pet skill elements (`Living.petEffectList`); also player-only
 * (battle pets are the player's own, there's no NPC-side pet). */
export abstract class AbstractPetEffect implements EffectLike {
  protected living!: Living;
  isTrigger = false;
  constructor(readonly type: number) {}
  start(living: Living): boolean {
    if (living.kind !== "player") return false;
    this.living = living;
    return living.petEffectList.add(this);
  }
  stop(): boolean {
    return this.living ? this.living.petEffectList.remove(this) : false;
  }
  onAttached(living: Living): void {
    this.onAttachedToPlayer(living as Player);
  }
  onRemoved(living: Living): void {
    this.onRemovedFromPlayer(living as Player);
  }
  protected onAttachedToPlayer(_player: Player): void {}
  protected onRemovedFromPlayer(_player: Player): void {}
}

/** `Living.EffectTrigger`/`AttackGemLimit`/`DefendGemLimit` shared cooldown gate (Living.cs:168-170, 1597-1607):
 * at most one attack-gem ("AttackGemLimit") and one defence-gem ("DefendGemLimit") proc every 4 / 3 turns — ticked
 * once per *round* (Living.PrepareNewTurn), not per self-turn. */
export const EQUIP_PROC = { attack: 4, defend: 3 } as const;
