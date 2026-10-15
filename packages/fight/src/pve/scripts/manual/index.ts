/**
 * Hand-fixed / hand-authored scripts. Registered AFTER the generated ones, so a class here replaces the transpiled
 * version with the same full name. Prefer subclassing the generated class and overriding only the broken member.
 */
// @ts-nocheck — the generated bases are untyped
import { registerScript } from "../runtime.js";
import { TVS12004 } from "../generated/Messions/TVS12004.js";
import { GCGCT1161 } from "../generated/Messions/GCGCT1161.js";
import { GCGCK1161 } from "../generated/Messions/GCGCK1161.js";

/** donor bug: OnGameOver dereferences the king even when the players died before it spawned (C# NullReference) */
class TVS12004Fixed extends TVS12004 {
  OnGameOver() {
    this.Game.IsWin = this.king != null && !this.king.IsLiving;
  }
}
registerScript("GameServerScript.AI.Messions.TVS12004", TVS12004Fixed, "mission", "manual");

/** donor bug: maxRedOnMap / maxBlueOnMap exceed the spawn point tables (index out of range in C#) — wrap around */
function wrapSpawns<T extends new () => object>(Base: T): T {
  return class extends (Base as new () => Record<string, unknown>) {
    RespawnRedNpc(count: number) {
      const pts = this.m_pointRed as { X: number; Y: number }[];
      for (let i = 0; i < count; i++) {
        const p = pts[i % pts.length]!;
        (this.redNpc as { Add(x: unknown): void }).Add((this.Game as any).CreateNpc(this.redNpcID, p.X, p.Y, 0, -1));
      }
    }
    RespawnBlueNpc(count: number) {
      const pts = this.m_pointBlue as { X: number; Y: number }[];
      for (let i = 0; i < count; i++) {
        const p = pts[i % pts.length]!;
        (this.blueNpc as { Add(x: unknown): void }).Add((this.Game as any).CreateNpc(this.redNpcID, p.X, p.Y, 0, -1));
      }
    }
  } as unknown as T;
}
registerScript("GameServerScript.AI.Messions.GCGCT1161", wrapSpawns(GCGCT1161), "mission", "manual");
registerScript("GameServerScript.AI.Messions.GCGCK1161", wrapSpawns(GCGCK1161), "mission", "manual");

import "./worldboss.js";
import "./christmas.js";
import "./labyrinth.js";

export const MANUAL_SCRIPTS = ["TVS12004", "GCGCT1161", "GCGCK1161", "ACDragon", "AC1243", "WorldAcientDragon", "Labyrinth"];
