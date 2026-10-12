import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadPackedAssets, type LocalWeaponExtension } from "@ddt/fight/node";
import { testConfig } from "../src/config.js";
import { DdtFightEngine } from "../src/fight/ddt.js";

const dir = mkdtempSync(join(tmpdir(), "ddt-game-weapon-"));
const path = join(dir, "fight.json");
afterAll(() => {
  // Only this test's newly created private directory is removed.
  if (resolve(dir).startsWith(resolve(tmpdir()) + "/") || resolve(dir).startsWith(resolve(tmpdir()) + "\\"))
    rmSync(dir, { recursive: true, force: true });
});

describe("weapon extension at the game engine boundary", () => {
  it("uses the configured pack while leaving ordinary engines unchanged", () => {
    const base = loadPackedAssets();
    const original = base.items.get(7001)!;
    const config = base.ballConfigs.get(7001)!;
    const id = 910000001;
    const pack: LocalWeaponExtension = {
      schemaVersion: 1, source: "local-compat",
      items: [{ ...original, templateId: id, categoryId: 7 }],
      ballConfigs: [{ ...config, templateId: id }], balls: [],
    };
    writeFileSync(path, JSON.stringify(pack));
    const cfg = testConfig({ FIGHT_WEAPON_EXTENSION: path });
    const engine = new DdtFightEngine({ weaponExtensionPath: cfg.FIGHT_WEAPON_EXTENSION, manualClock: true });
    expect(engine.assets.items.get(id)).toEqual(pack.items[0]);
    expect(engine.assets.ballConfigs.get(id)).toEqual(pack.ballConfigs[0]);
    expect(engine.assets.ball(config.common)).toEqual(base.ball(config.common));
    expect(engine.assets.items.get(7001)).toEqual(original);
    expect(new DdtFightEngine({ manualClock: true }).assets.items.has(id)).toBe(false);
  });

  it("rejects an invalid configured pack instead of silently using the default weapon", () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, source: "local-compat", items: [], ballConfigs: [], balls: [] }));
    expect(() => new DdtFightEngine({ weaponExtensionPath: path })).toThrow("must contain a weapon");
    expect(() => new DdtFightEngine({ weaponExtensionPath: join(dir, "missing.json") })).toThrow();
  });

  it("does not silently ignore an extension when callers inject assets", () => {
    expect(() => new DdtFightEngine({ assets: loadPackedAssets(), weaponExtensionPath: path })).toThrow("not both");
  });
});
