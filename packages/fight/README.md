# @ddt/fight

Pure TypeScript, I/O-free, deterministic port of the DDTank 4.1 fight engine (`vendor/DDTank41/Game.Logic`:
`Phy/**`, `Living`, `TurnedLiving`, `Player`, `SimpleBomb`, `BaseGame`, `PVPGame`, `Spells/**`). It runs in the
game server today (`apps/game/src/fight/ddt.ts`) and can run unchanged in the future PixiJS client (no Node APIs in
`@ddt/fight`; Node file loaders live in `@ddt/fight/node`). Spec: `docs/spec/combat/00-fight-engine.md`, `02-bots.md`.

```ts
import { PvpGame, BotRunner, solveAim } from "@ddt/fight";
import { loadPackedAssets } from "@ddt/fight/node";

const assets = loadPackedAssets();                       // data/ (balls, maps, crater shapes, props)
const game = new PvpGame({ id: 1, roomType: 0, gameType: 0, timeType: 3, mapId: 1001, assets, seed: 42,
  players: [
    { userId: 10, nickname: "a", team: 1, grade: 20, attack: 300, defence: 200, agility: 300, lucky: 200,
      baseAttack: 250, baseDefence: 150, hp: 1500, weapon: { templateId: 7001, property8: 5 } },
    { userId: -1, nickname: "bot", team: 2, grade: 20, /* … */ isBot: true } as never,
  ] });
const bots = new BotRunner(game, new Map([[-1, { difficulty: 80 }]]));

setInterval(() => {                                       // 40 ms, like GameMgr.THREAD_INTERVAL
  const now = Date.now();
  for (const ev of [...game.update(now), ...bots.update(now)]) send(ev);   // ev.cmd / ev.code = eTankCmdType
}, 40);
onClientGameCmd((userId, cmd) => game.handle(userId, cmd).forEach(send));   // { cmd: "FIRE", x, y, force, angle } …
```

## API

| Module | Exports |
|---|---|
| `phy/` | `Tile` (1-bit bitmap, `dig`, `isEmpty`, `isRectangleEmptyQuick`), `GameMap` (two layers + physics set, ground search, walking, `findHitByHitPoint`), `Physics`/`LivingBody`, `BombObject`/`SimpleBomb` (float32 Euler flight, 3 px swept collision, BombAction timeline), `simulateShot()` (stand-alone trajectory, used by bots and usable for client prediction) |
| `game/` | `PvpGame` (`handle(userId, FightCommand)`, `update(now)`, `drain()`), `Player`/`Living`/`TurnedLiving`, pure formulas (`turnDelay`, `turnTime`, `nextWind`, `vane`, `shellDamage`, `criticalDamage`, `hertAddition`, `analyticAim`, `calculateExperience`, `calculateOffer`, `playerKillOffer`) |
| `game/events.ts` | `FightEvent` union — one per S→C GAME_CMD packet, `cmd`/`code` from `@ddt/protocol` `eTankCmdType`, `livingId` = header Parameter1, fields in C# write order (cited per type); `FightCommand` — parsed C→S commands |
| `game/effects.ts` | In-fight effect layer core: `HookBus` (`Living.hooks` — the C# `BeginSelfTurn`/`PlayerShoot`/… multicast events as typed pub/sub), `EffectListOf<E>` (`Living.effectList`/`cardEffectList`/`petEffectList`, generic `EffectList.cs`/`CardEffectList.cs`/`PetEffectList.cs`), `AbstractEffect`/`BasePlayerEffect`/`AbstractCardEffect`/`AbstractPetEffect` |
| `game/equipEffects.ts` | Gem/rune special effects (`Effects/*.cs`, `Player.InitBuffer`): all 26 `Property3` kinds (stat procs, Ice/Seal/NoHole/LockDirection/ReduceStrength/ContinueReduceBlood/ContinueReduceDamage on-kill, armour-piercer, lifesteal, thorns, extra shots, …) + `applyEquipEffects(player, templates)` |
| `game/cardEffects.ts` | Card set bonuses (`CardEffect/Effects/*.cs`, `Player.InitCardBuffer`): all 30 classes (15 wired by `CardID` 1..15, like the original) + `applyCardEffects(player, cards, tables)` |
| `game/petEffects.ts` | Pet skill elements (`PetEffects/**`, `Player.InitPetSkillEffect`): framework + `CE1067` (thorns) as a worked example + `applyPetSkillEffects(player, skills)` — the ~250 remaining `AE####`/`PE####`/`CE####` ids are a documented follow-up (see file header) |
| `bot/` | `solveAim()` (angle × force search with the real integrator), `planBotTurn()`, `BotRunner`, `difficultyParams()` (02-bots §2.3 table) |
| `math/` | `DotNetRandom` (bit-exact `System.Random(seed)`), `f32`/`int`/`roundEven` C# numeric helpers |
| `data/` | `FightAssets`, `.ddtm`/`.ddtb` codecs, `inflateRaw()` (browser) |

Determinism: all randomness goes through `DotNetRandom(seed)`; same seed + same commands + same clock ⇒ same event
stream (tested).

## PvE

`PveGame` (`src/pve/game.ts`) ports `PVEGame.cs` + `CheckPVEGameStateAction.cs` + the `Living*Action` timeline
(step actions with finish delays, so `Say`/`PlayMovie` block the turn like in C#). Scripts use the **C# member names**
(`Game.CreateNpc`, `Body.MoveTo`, `Game.Random.Next`, PascalCase on purpose; `src/pve/compat.ts` installs them on the
engine bodies) so the 611 donor classes are transpiled mechanically:

```
pnpm --filter @ddt/fight transpile-pve   # vendor/DDTank4.1 .../AI/*.cs → src/pve/scripts/generated (+ report.json)
pnpm --filter @ddt/fight pve-smoke       # every Mission_Info row with 2 bots → generated/smoke.json
```

```ts
import { PveGame } from "@ddt/fight";
import "@ddt/fight/pve-scripts";          // registers generated + manual scripts
const g = new PveGame({ id, roomType: 4, gameType: 7, timeType: 3, assets, players, pveInfo, hardLevel: 0,
  data: { npc: (id) => npcRows.get(id), mission: (id) => missionRows.get(id) },
  drops: { copyDrop: (missionId, user) => [...], npcDrop: (dropId) => [...] } });
```

Extra events: `RAW` (pre-encoded PvE packets: 64 add living, 55-61 NPC actions, 104, 113…), `GAME_MISSION_OVER`,
`GAME_ALL_MISSION_OVER`, `PVE_AWARD` (items to give), `PVE_STOPPED`. Missing / broken scripts fall back to
`GenericNpcBrain` / `GenericMission` / `GenericGameControl` — never a frozen mission. Guide (PT-BR): `docs/guides/pve.md`.

Labyrinth currently has two compatibility fixes: a manual `OnCreated` override translates the donor's
`String.Split` while preserving its 30 mission IDs and inherited scoring, and `CreateGate(bool)` only sets
`CanEnterGate`, as in SkelletonX/DDTank4.1 `PVEGame.cs:2068-2071` (commit `09f8cdb`). The coordinate overload
still creates a physical gate. `test/labyrinth-gate.test.ts` exercises the actual first-floor script, NPCs and map
with explicitly test-only mission headers; production 401/30-floor configuration, `GameOverMovie`, big-box
settlement and persistent progression remain incomplete. These checks do not establish a playable Labyrinth.

## Assets

`pnpm --filter @ddt/fight pack-assets` converts the original files into `data/` (≈3 MB, committed):
`balls.json`, `ballconfig.json`, `items.json` (weapons, deputy weapons, props 10001-10025), `maps.json` (from
`packages/db/seed/game`), `maps/{id}.ddtm` (fore+dead `.map` layers, deflate-raw) and `bombs.ddtb` (all crater
`.bomb` shapes). Binaries are read from `$DDT_FIGHT_ASSETS` (default `vendor/DDTank41/Fighting.Service/bin/Debug/net48`,
`map/{id}/{fore,dead}.map`, `bomb/{id}.bomb`); `--maps=1001,1002` packs a subset. Alternatively
`loadVendorAssets(dir)` reads the original files directly at runtime. A browser fetches `.ddtm`, `inflateRaw()`s it and
calls `assets.setTerrain(id, …)` via `decodeMapPack`.

## Golden tests (C# oracle)

`csharp-oracle/` is a .NET 10 console app that compiles ORIGINAL sources: verbatim `Tile.cs`, `Map.cs`,
`EulerVector.cs`, `PointHelper.cs`, `Physics.cs`, `BombObject.cs`, `BombAction.cs`, `BallInfo.cs`… plus verbatim
method bodies extracted from `SimpleBomb.cs` (ctor, `StartMoving`, `MakeDamage`, collide callbacks), `Living.cs`
(`BoundDistance`, `Distance`, `MakeCriticalDamage`, `GetShootForceAndAngle`, `ComputeVx/Vy`, `getHertAddition`,
`GetShootPoint`), `TurnedLiving.GetTurnDelay`, `BaseGame.GetNextWind/getTurnTime/GetVane`, `WindMgr.GetWindID`.
`original/` is gitignored and recreated by the sync script; `Stubs.cs` only holds data members.

```
pnpm --filter @ddt/fight sync-oracle-sources   # re-copy/extract C# from vendor/
pnpm --filter @ddt/fight oracle                # regenerate test/golden/vectors.json (dotnet 10 SDK)
pnpm --filter @ddt/fight test                  # 145 tests
```

Vectors (real maps/balls): `System.Random` (8 seeds incl. int.MinValue/MaxValue), 10 Euler runs × 50 steps, 48 crater
digs on 4 maps (SHA-256 of the terrain after each, incl. edge/out-of-bounds centres), 72 walk/ground searches,
**36 trajectories** (6 maps incl. dead-only and weight-6 maps, winds −5…+5, angles both directions, forces 200–2000,
triple shots, homing ball, frost/fly/normal balls, bodies in the way: velocities, every BombAction, impact, lifetime,
temp points, victims, terrain hash), 40 damage cases, 5 crit sequences, 30 analytic-aim cases, wind sequences, vanes,
turn time/delay. All match bit-for-bit.

## Deviations from the C# (deliberate)

- `Player.SetXY` energy: the original subtracts `|m_x − x|` after assigning `m_x` (always 0); we charge the real
  distance, and `MOVESTART` is clamped to the remaining energy (the original trusts the client, spec §3.4).
- Not modelled yet: drop boxes (`CreateBox`/fire drops — need drop tables), PvE extras (Labyrinth gates, effects with
  real stat changes); world boss dragon scripts are hand-ported from DDT-6600 (`src/pve/scripts/manual/worldboss.ts`,
  players act first), achievements, ghost movement and dead-teammate props. `GAME_CREATE` carries only the fight
  fields (the server adds the lobby fields). Level-up from GP is delegated to the server (`gradeForGp`).
- Card/equip-gem/pet effect gem procs (`equipEffects.ts`/`cardEffects.ts`/`petEffects.ts`) roll through the game's
  seeded `DotNetRandom` instead of each C# `AbstractEffect`'s own unseeded `new Random()` (reseeded by wall clock on
  every construction) — the original isn't part of the fight's own determinism story either way, and routing through
  the shared RNG keeps this port's "same seed ⇒ same event stream" guarantee intact. `NoHoleEquipEffect` fires from
  `beginAttacked` instead of the C# `Player.CollidByObject` (closest equivalent hook we expose).
- Guild-skill fight buffs (`Game.Server/Buffer/Consortion*Buffer.cs`, `GamePlayer.FightBuffers`) are resolved to flat
  stat/maxBlood/critical deltas by the caller and passed in via `PlayerSpec.guildBuffs`, applied once in
  `Player.reset()` — the pure engine never talks to `BufferList`/the DB.
- `BaseGame.SendGameNextTurn` passes the float wind to `GetVane(int)` (decompiled code); we use `wind×10` like FIRE/VANE.
- Safety cap of 1500 integration steps (60 s) per projectile (the original could loop forever with no gravity).
- `Tile.Remove` writes past the end of the buffer are dropped (C# would throw).
