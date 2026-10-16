/**
 * Card set bonuses: `Game.Logic/CardEffect/Effects/*.cs` (30 classes), dispatched by `Player.InitCardBuffer(cards)`
 * (Player.cs:1534-1850) — for each card *group* (deck), count how many of its member cards the player has equipped
 * (Place 0..4), retain the last eligible `CardBuffInfo` visited, then the switch on
 * `CardBuffInfo.CardID` (1..15) instantiates one-or-more tiered effect classes, each reading its own `Value`
 * (a `|`-joined per-"index" number list; `index` = the lowest equipped-card level bracket, 0..3, encoded in a
 * 1000 + level sentinel by PlayerDetail.CardBuff). Original positive-condition rows are visited descending;
 * later eligible rows overwrite earlier ones, so the lowest satisfied tier wins, not the highest.
 *
 * `AresDeck`/`HappinessDeck`/`LegendaryWeaponDeck` have an `eCardEffectType` id but `CardID` 1..15 never selects
 * them (same in the original — not a porting gap); kept here for completeness, not wired into `applyCardEffects`.
 *
 * Faithfully-ported *dead code* (verified by grepping all of `Game.Logic` for each read site, not "fixed" per the
 * port's fidelity goal):
 *  - `GuluKingdom4`/`EvilTribe5`/`ShadowDevil4Effect` mutate the `damageAmount`/`criticalAmount` *parameters* of an
 *    `AfterKillingLiving` handler — but that delegate passes them by value (`KillLivingEventHanlde`, no `ref`), and
 *    fires *after* `Living.TakeDamage` already applied the hit, so the mutation is discarded. No bonus is dealt.
 *  - `Goblin4Effect`/`RunRunChicken4Effect` expose `ReduceValue`; `GuluSportsMeeting2Effect`/`TimeVortex5Effect`
 *    expose `CureValue` — set on `PlayerAfterReset`/`PlayerCure` but never read anywhere else in `Game.Logic`.
 *  - `FiveGodSoldier2Effect`'s lifesteal is gated on `m_added > 0.0` checked *before* `m_added` is ever assigned
 *    (it's zero-initialized and only ever written inside that same gated block) — the heal can never trigger.
 */
import type { Living, Player } from "./living.js";
import { AbstractCardEffect, type HookName } from "./effects.js";
import { PvpGame, RoomType } from "./game.js";

const T = {
  AntCave: 0, GuluKingdom2: 1, GuluKingdom4: 2, EvilTribe3: 3, EvilTribe5: 4, ShadowDevil2: 5, ShadowDevil4: 6,
  FourArtifacts2: 7, FourArtifacts4: 8, Goblin2: 9, Goblin4: 10, Goblin5: 11, RunRunChicken2: 12, RunRunChicken4: 13,
  GuluSportsMeeting2: 14, GuluSportsMeeting4: 15, GuluSportsMeeting5: 16, FiveGodSoldier2: 17, FiveGodSoldier5: 18,
  TimeVortex3: 19, TimeVortex5: 20, WarriorsArena3: 21, WarriorsArena5: 22, PioneerDeck: 23, WeaponMasterDeck: 24,
  DivineDeck: 25, LuckyDeck: 26, HappinessDeck: 27, LegendaryWeaponDeck: 28, AresDeck: 29,
} as const;

/** `(player.Game as PVEGame).Info.ID` without importing the PVE module (keeps game/ decoupled from pve/). */
const pveId = (game: Living["game"]): number | undefined => (game as unknown as { info?: { ID: number } }).info?.ID;
/** AbstractGame.IsMatchOrFreedom (AbstractGame.cs:46) */
const isMatchOrFreedom = (game: Living["game"]): boolean => game.roomType === RoomType.Match || game.roomType === RoomType.Freedom;
/** Groups 5/9 also require the original concrete PVPGame type, not only its room number. */
const isPvpMatchOrFreedom = (game: Living["game"]): boolean => game instanceof PvpGame && isMatchOrFreedom(game);
/** `SimpleBoss.NpcInfo.ID`, duck-typed for the same reason as `pveId`. */
const bossNpcId = (l: Living): number | undefined => (l as unknown as { npcInfo?: { ID: number } }).npcInfo?.ID;
/** `CardBuffInfo.Value.Split('|')[index]`, 0 when out of range (matches the C# "if index < length" guard). */
export const valueAt = (value: string, index: number): number => {
  const parts = value.split("|");
  return index < parts.length ? Number(parts[index]) || 0 : 0;
};

/** Every one of the 30 C# classes subscribes to exactly one `Player.*` event — `BaseCardEffect` plus that one
 * `+=`/`-=` pair, parameterized instead of subclassed 30 times. */
class HookCardEffect<K extends HookName> extends AbstractCardEffect {
  constructor(type: number, private hook: K, private handler: (...a: never[]) => void) {
    super(type);
  }
  protected override onAttachedToPlayer(p: Player): void {
    p.hooks.on(this.hook, this.handler as never);
  }
  protected override onRemovedFromPlayer(p: Player): void {
    p.hooks.off(this.hook, this.handler as never);
  }
}
/** `AbstractCardEffect.Start`: a second instance of the same type on the same Living is a no-op refresh (every one
 * of the 30 C# `Start` overrides does exactly this). */
function startOnce(living: Living, type: number, build: () => AbstractCardEffect): boolean {
  return living.cardEffectList.getOfType(type) ? true : build().start(living);
}

// ---------------------------------------------------------------------------- the 30 classes

/** case 1: AntCaveEffect — ±maxBlood on reset while in PVE mission 2. */
export const AntCaveEffect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.AntCave, () => {
    const v = valueAt(value, index);
    let added = 0;
    return new HookCardEffect(T.AntCave, "playerAfterReset", (p: Player) => {
      if (added) { p.addMaxBlood(-added); added = 0; }
      if (pveId(p.game) === 2) { p.addMaxBlood(v); added = v; }
    });
  });

/** case 2 (cond ≥2): GuluKingdom2Effect — dander += 2·value every self-turn while in PVE mission 1 (not just once). */
export const GuluKingdom2Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.GuluKingdom2, () => {
    const v = valueAt(value, index);
    return new HookCardEffect(T.GuluKingdom2, "beginSelfTurn", (l: Living) => {
      if (pveId(l.game) === 1) (l as Player).addDander(v * 2);
    });
  });
/** case 2 (cond ≥4): GuluKingdom4Effect — dead code, see file header (AfterKillingLiving damage bonus is discarded). */
export const GuluKingdom4Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.GuluKingdom4, () => new HookCardEffect(T.GuluKingdom4, "afterKillingLiving", () => {
    void valueAt(value, index);
  }));

/** case 3 (cond ≥3): EvilTribe3Effect — flat damage reduction on the hit about to land, PVE mission 3. */
export const EvilTribe3Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.EvilTribe3, () => {
    const v = valueAt(value, index);
    return new HookCardEffect(T.EvilTribe3, "beforeTakeDamage", (l: Living, _s: Living, d: { damage: number; critical: number }) => {
      if (pveId(l.game) === 3) d.damage -= v;
    });
  });
/** case 3 (cond ≥5): EvilTribe5Effect — dead code, see file header. */
export const EvilTribe5Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.EvilTribe5, () => new HookCardEffect(T.EvilTribe5, "afterKillingLiving", () => {
    void valueAt(value, index);
  }));

/** case 4 (cond ≥2): ShadowDevil2Effect — ±stat flat + PowerRatio reset on reset, PVE mission 4. */
export const ShadowDevil2Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.ShadowDevil2, () => resetStatFlat(T.ShadowDevil2, valueAt(value, index), (g) => pveId(g) === 4, true));
/** case 4 (cond ≥4): ShadowDevil4Effect — dead code, see file header (crit bonus on kill is discarded). */
export const ShadowDevil4Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.ShadowDevil4, () => new HookCardEffect(T.ShadowDevil4, "afterKillingLiving", (l: Living, _t: Living, _d: number, critical: number) => {
    if (pveId(l.game) === 4 && critical > 0) void valueAt(value, index);
  }));

/** case 5 (cond ≥2): FourArtifacts2Effect — dander per landed hit in Match/Freedom (AfterKillingLiving also fires on nonlethal hits). */
export const FourArtifacts2Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.FourArtifacts2, () => {
    const v = valueAt(value, index);
    return new HookCardEffect(T.FourArtifacts2, "afterKillingLiving", (l: Living) => {
      if (isPvpMatchOrFreedom(l.game)) (l as Player).addDander(v);
    });
  });
/** case 5 (cond ≥4): FourArtifacts4Effect — ±stat flat on reset, Match/Freedom. */
export const FourArtifacts4Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.FourArtifacts4, () => resetStatFlat(T.FourArtifacts4, valueAt(value, index), isPvpMatchOrFreedom));

/** case 6 (cond ≥2): Goblin2Effect — dander += value exactly once (the very first eligible BeginNextTurn while
 * attached), PVE mission 5 — the C# gates on `m_added == 0`, which is only ever true before the first proc. */
export const Goblin2Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.Goblin2, () => {
    const v = valueAt(value, index);
    let added = 0;
    return new HookCardEffect(T.Goblin2, "beginNewTurn", (l: Living) => {
      if (added === 0 && pveId(l.game) === 5) {
        (l as Player).addDander(v);
        added = v;
      }
    });
  });
/** case 6 (cond ≥4): Goblin4Effect — dead code, see file header (`ReduceValue` never read). */
export const Goblin4Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.Goblin4, () => new HookCardEffect(T.Goblin4, "playerAfterReset", (p: Player) => {
    if (pveId(p.game) === 5) void valueAt(value, index);
  }));
/** case 6 (cond ≥5): Goblin5Effect — ±stat flat on reset, PVE mission 5. */
export const Goblin5Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.Goblin5, () => resetStatFlat(T.Goblin5, valueAt(value, index), (g) => pveId(g) === 5));

/** case 7 (cond ≥2): RunRunChicken2Effect — BaseGuard += BaseGuard·value% on reset, PVE mission 7 (feeds shellDamage). */
export const RunRunChicken2Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.RunRunChicken2, () => {
    const v = valueAt(value, index);
    let added = 0;
    return new HookCardEffect(T.RunRunChicken2, "playerAfterReset", (p: Player) => {
      if (added) { p.baseGuard -= added; added = 0; }
      if (pveId(p.game) === 7) { added = (p.baseGuard * v) / 100; p.baseGuard += added; }
    });
  });
/** case 7 (cond ≥4): RunRunChicken4Effect — dead code, see file header (`ReduceValue` never read). */
export const RunRunChicken4Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.RunRunChicken4, () => new HookCardEffect(T.RunRunChicken4, "playerAfterReset", (p: Player) => {
    if (pveId(p.game) === 7) void valueAt(value, index);
  }));

/** case 8 (cond ≥2): GuluSportsMeeting2Effect — dead code, see file header (`CureValue` never read). */
export const GuluSportsMeeting2Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.GuluSportsMeeting2, () => new HookCardEffect(T.GuluSportsMeeting2, "playerCure", (p: Player) => {
    if (pveId(p.game) === 6) void valueAt(value, index);
  }));
/** case 8 (cond ≥4): GuluSportsMeeting4Effect — ±stat flat on reset, PVE mission 6. */
export const GuluSportsMeeting4Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.GuluSportsMeeting4, () => resetStatFlat(T.GuluSportsMeeting4, valueAt(value, index), (g) => pveId(g) === 6));
/** case 8 (cond ≥5): GuluSportsMeeting5Effect — ±stat flat + PowerRatio reset on reset, PVE mission 6. */
export const GuluSportsMeeting5Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.GuluSportsMeeting5, () => resetStatFlat(T.GuluSportsMeeting5, valueAt(value, index), (g) => pveId(g) === 6, true));

/** case 9 (cond ≥2): FiveGodSoldier2Effect — dead code, see file header (self-heal gate can never pass). */
export const FiveGodSoldier2Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.FiveGodSoldier2, () => new HookCardEffect(T.FiveGodSoldier2, "afterKillingLiving", (l: Living) => {
    if (isPvpMatchOrFreedom(l.game)) void valueAt(value, index); // m_added > 0.0 gate is always false — no heal.
  }));
/** case 9 (cond ≥5): FiveGodSoldier5Effect — thorns: reflect value% of the hit you just took back at the attacker,
 * Match/Freedom (`AfterKilledByLiving` fires on the victim; `source` here is that attacker). */
export const FiveGodSoldier5Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.FiveGodSoldier5, () => {
    const v = valueAt(value, index);
    return new HookCardEffect(T.FiveGodSoldier5, "afterTakenHit", (l: Living, source: Living, damage: number) => {
      const added = Math.trunc((damage * v) / 100);
      if (isPvpMatchOrFreedom(l.game) && added > 0) source.addBlood(-added, 1);
    });
  });

/** case 10 (cond ≥3): TimeVortex3Effect — ±stat flat on reset, PVE mission 12. */
export const TimeVortex3Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.TimeVortex3, () => resetStatFlat(T.TimeVortex3, valueAt(value, index), (g) => pveId(g) === 12));
/** case 10 (cond ≥5): TimeVortex5Effect — dead code, see file header (`CureValue` never read). */
export const TimeVortex5Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.TimeVortex5, () => new HookCardEffect(T.TimeVortex5, "playerCure", (p: Player) => {
    if (pveId(p.game) === 12) void valueAt(value, index);
  }));

/** case 11 (cond ≥3): WarriorsArena3Effect — ±maxBlood on reset, PVE mission 13. */
export const WarriorsArena3Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.WarriorsArena3, () => {
    const v = valueAt(value, index);
    let added = 0;
    return new HookCardEffect(T.WarriorsArena3, "playerAfterReset", (p: Player) => {
      if (added) { p.addMaxBlood(-added); added = 0; }
      if (pveId(p.game) === 13) { p.addMaxBlood(v); added = v; }
    });
  });
/** case 11 (cond ≥5): WarriorsArena5Effect — flat damage reduction for 5 specific boss ids, PVE mission 13. */
const WARRIORS_ARENA_BOSSES = new Set([13007, 13107, 13207, 13307, 13407]);
export const WarriorsArena5Effect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.WarriorsArena5, () => {
    const v = valueAt(value, index);
    return new HookCardEffect(T.WarriorsArena5, "beforeTakeDamage", (l: Living, _s: Living, d: { damage: number; critical: number }) => {
      const id = bossNpcId(l);
      if (pveId(l.game) === 13 && l.kind !== "player" && id !== undefined && WARRIORS_ARENA_BOSSES.has(id)) d.damage -= v;
    });
  });

/** case 12: PioneerEffect — ±maxBlood on reset, Match/Freedom. */
export const PioneerEffect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.PioneerDeck, () => {
    const v = valueAt(value, index);
    let added = 0;
    return new HookCardEffect(T.PioneerDeck, "playerAfterReset", (p: Player) => {
      if (added) { p.addMaxBlood(-added); added = 0; }
      if (isMatchOrFreedom(p.game)) { p.addMaxBlood(v); added = v; }
    });
  });
/** case 13: WeaponMasterEffect — ±stat flat on reset, Match/Freedom. */
export const WeaponMasterEffect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.WeaponMasterDeck, () => resetStatFlat(T.WeaponMasterDeck, valueAt(value, index), isMatchOrFreedom));
/** case 14: DivineEffect — ±maxBlood on reset, Match/Freedom. */
export const DivineEffect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.DivineDeck, () => {
    const v = valueAt(value, index);
    let added = 0;
    return new HookCardEffect(T.DivineDeck, "playerAfterReset", (p: Player) => {
      if (added) { p.addMaxBlood(-added); added = 0; }
      if (isMatchOrFreedom(p.game)) { p.addMaxBlood(v); added = v; }
    });
  });
/** case 15: LuckyEffect — ±stat flat on reset, Match/Freedom. */
export const LuckyEffect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.LuckyDeck, () => resetStatFlat(T.LuckyDeck, valueAt(value, index), isMatchOrFreedom));

/** Not reached by `applyCardEffects` (see file header) — defined for completeness/fidelity. */
export const HappinessEffect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.HappinessDeck, () => {
    const v = valueAt(value, index);
    let added = 0;
    return new HookCardEffect(T.HappinessDeck, "playerAfterReset", (p: Player) => {
      if (added) { p.addMaxBlood(-added); added = 0; }
      if (isMatchOrFreedom(p.game)) { p.addMaxBlood(v); added = v; }
    });
  });
export const LegendaryWeaponEffect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.LegendaryWeaponDeck, () => resetStatFlat(T.LegendaryWeaponDeck, valueAt(value, index), isMatchOrFreedom));
export const AresEffect = (index: number, value: string) => (living: Living) =>
  startOnce(living, T.AresDeck, () => {
    const v = valueAt(value, index);
    let added = 0;
    return new HookCardEffect(T.AresDeck, "playerAfterReset", (p: Player) => {
      if (added) { p.addMaxBlood(-added); added = 0; }
      if (isMatchOrFreedom(p.game)) { p.addMaxBlood(v); added = v; }
    });
  });

function resetStatFlat(type: number, value: number, cond: (g: Living["game"]) => boolean, zeroPowerRatio = false): HookCardEffect<"playerAfterReset"> {
  let added = 0;
  return new HookCardEffect(type, "playerAfterReset", (p: Player) => {
    if (added) {
      p.attack -= added; p.agility -= added; p.lucky -= added; p.defence -= added;
      added = 0;
    }
    if (cond(p.game)) {
      added = value;
      p.attack += added; p.agility += added; p.lucky += added; p.defence += added;
      if (zeroPowerRatio) p.powerRatio = 0;
    }
  });
}

// ---------------------------------------------------------------------------- dispatcher (Player.InitCardBuffer)

export interface CardSetTables {
  /** CardBuffMgr.GetAllCard(): cardId (= CardBuffInfo.CardID) → the deck's member card template ids. */
  groups: Map<number, number[]>;
  /** CardBuffMgr.FindCardBuffs(cardId): condition-tiered bonuses for that deck. */
  buffs(cardId: number): { condition: number; value: string }[] | undefined;
}

/** Player.InitCardBuffer(cards) (Player.cs:1534-1850). `cards` = equipped template ids plus the 1000 + minimum
 * equipped-card level sentinel. Preserve group/row iteration and overwrite order from CardBuffMgr. */
export function applyCardEffects(player: Player, cards: number[], tables: CardSetTables): void {
  let minLv = 30;
  for (const c of cards) if (c < 1100) minLv = c - 1000;
  const index = minLv >= 30 ? 3 : minLv >= 20 ? 2 : minLv >= 10 ? 1 : 0;

  let finalCardId = -1;
  let finalValue = "";
  let finalCondition = -1;
  let finalBuffs: { condition: number; value: string }[] = [];
  for (const [cardId, members] of tables.groups) {
    let counter = 0;
    for (const member of members) for (const card of cards) if (member === card) counter++;
    const buffs = tables.buffs(cardId);
    if (!buffs) continue;
    for (const b of buffs) if (counter >= b.condition) { finalCardId = cardId; finalCondition = b.condition; finalValue = b.value; finalBuffs = buffs; }
  }
  if (finalCardId < 0) return;

  switch (finalCardId) {
    case 1: AntCaveEffect(index, finalValue)(player); break;
    case 2:
      if (finalCondition >= 4) for (const b of finalBuffs) {
        if (b.condition >= 4) GuluKingdom4Effect(index, b.value)(player);
        if (b.condition >= 2) GuluKingdom2Effect(index, b.value)(player);
      }
      if (finalCondition >= 2) GuluKingdom2Effect(index, finalValue)(player);
      break;
    case 3:
      if (finalCondition >= 5) for (const b of finalBuffs) {
        if (b.condition >= 5) EvilTribe5Effect(index, b.value)(player);
        if (b.condition >= 3) EvilTribe3Effect(index, b.value)(player);
      }
      if (finalCondition >= 3) EvilTribe3Effect(index, finalValue)(player);
      break;
    case 4:
      if (finalCondition >= 4) for (const b of finalBuffs) {
        if (b.condition >= 4) ShadowDevil4Effect(index, b.value)(player);
        if (b.condition >= 2) ShadowDevil2Effect(index, b.value)(player);
      }
      if (finalCondition >= 2) ShadowDevil2Effect(index, finalValue)(player);
      break;
    case 5:
      if (finalCondition >= 4) for (const b of finalBuffs) {
        if (b.condition >= 4) FourArtifacts4Effect(index, b.value)(player);
        if (b.condition >= 2) FourArtifacts2Effect(index, b.value)(player);
      }
      if (finalCondition >= 2) FourArtifacts2Effect(index, finalValue)(player);
      break;
    case 6:
      if (finalCondition >= 5) for (const b of finalBuffs) {
        if (b.condition >= 5) Goblin5Effect(index, b.value)(player);
        if (b.condition >= 4) Goblin4Effect(index, b.value)(player);
        if (b.condition >= 2) Goblin2Effect(index, b.value)(player);
      }
      if (finalCondition >= 4) for (const b of finalBuffs) {
        if (b.condition >= 4) Goblin4Effect(index, b.value)(player);
        if (b.condition >= 2) Goblin2Effect(index, b.value)(player);
      }
      if (finalCondition >= 2) Goblin2Effect(index, finalValue)(player);
      break;
    case 7:
      if (finalCondition >= 4) for (const b of finalBuffs) {
        if (b.condition >= 4) RunRunChicken4Effect(index, b.value)(player);
        if (b.condition >= 2) RunRunChicken2Effect(index, b.value)(player);
      }
      if (finalCondition >= 2) RunRunChicken2Effect(index, finalValue)(player);
      break;
    case 8:
      if (finalCondition >= 5) for (const b of finalBuffs) {
        if (b.condition >= 5) GuluSportsMeeting5Effect(index, b.value)(player);
        if (b.condition >= 4) GuluSportsMeeting4Effect(index, b.value)(player);
        if (b.condition >= 2) GuluSportsMeeting2Effect(index, b.value)(player);
      }
      if (finalCondition >= 4) for (const b of finalBuffs) {
        if (b.condition >= 4) GuluSportsMeeting4Effect(index, b.value)(player);
        if (b.condition >= 2) GuluSportsMeeting2Effect(index, b.value)(player);
      }
      if (finalCondition >= 2) GuluSportsMeeting2Effect(index, finalValue)(player);
      break;
    case 9:
      if (finalCondition >= 5) for (const b of finalBuffs) {
        if (b.condition >= 5) FiveGodSoldier5Effect(index, b.value)(player);
        if (b.condition >= 2) FiveGodSoldier2Effect(index, b.value)(player);
      }
      if (finalCondition >= 2) FiveGodSoldier2Effect(index, finalValue)(player);
      break;
    case 10:
      if (finalCondition >= 5) for (const b of finalBuffs) {
        if (b.condition >= 5) TimeVortex5Effect(index, b.value)(player);
        if (b.condition >= 3) TimeVortex3Effect(index, b.value)(player);
      }
      if (finalCondition >= 3) TimeVortex3Effect(index, finalValue)(player);
      break;
    case 11:
      if (finalCondition >= 5) for (const b of finalBuffs) {
        if (b.condition >= 5) WarriorsArena5Effect(index, b.value)(player);
        if (b.condition >= 3) WarriorsArena3Effect(index, b.value)(player);
      }
      if (finalCondition >= 3) WarriorsArena3Effect(index, finalValue)(player);
      break;
    case 12: PioneerEffect(index, finalValue)(player); break;
    case 13: WeaponMasterEffect(index, finalValue)(player); break;
    case 14: DivineEffect(index, finalValue)(player); break;
    case 15: LuckyEffect(index, finalValue)(player); break;
    default: break;
  }
}
