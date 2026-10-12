/**
 * Node-only asset loaders (`@ddt/fight/node`). The engine itself (`@ddt/fight`) never touches the file system.
 *
 * - `loadPackedAssets(dir?, options?)` reads the compact files produced by `pnpm --filter @ddt/fight pack-assets`
 *   (default: this package's `data/`). An explicit weaponExtensionPath can add local compatibility weapons.
 * - `loadVendorAssets(assetsDir, dataDir?)` reads the ORIGINAL `map/{id}/{fore,dead}.map` and `bomb/{id}.bomb` from a
 *   build output dir (e.g. `vendor/DDTank41/Fighting.Service/bin/Debug/net48`, or `$DDT_FIGHT_ASSETS`); template JSON
 *   still comes from `dataDir`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { FightAssets, decodeBombPack, decodeMapPack } from "./data/assets.js";
import { mergeWeaponExtension } from "./data/weapon-extension.js";
import type { MapInfo } from "./phy/map.js";
import { Tile } from "./phy/tile.js";

export type { LocalWeaponExtension } from "./data/weapon-extension.js";

export interface PackedAssetOptions {
  /** Optional JSON LocalWeaponExtension; never discovered or enabled automatically. */
  weaponExtensionPath?: string;
}

export const PACKAGE_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../data");
export const DEFAULT_VENDOR_ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../vendor/DDTank41/Fighting.Service/bin/Debug/net48");

function readTemplates(dataDir: string) {
  const j = (f: string) => JSON.parse(readFileSync(join(dataDir, f), "utf8"));
  return { balls: j("balls.json"), ballConfigs: j("ballconfig.json"), items: j("items.json"), maps: j("maps.json") as MapInfo[] };
}

export function loadPackedAssets(dataDir: string = PACKAGE_DATA_DIR, options: PackedAssetOptions = {}): FightAssets {
  const t = readTemplates(dataDir);
  const shapes = decodeBombPack(inflateRawSync(readFileSync(join(dataDir, "bombs.ddtb"))));
  const init = options.weaponExtensionPath === undefined ? { ...t, shapes }
    : mergeWeaponExtension(t, shapes, JSON.parse(readFileSync(options.weaponExtensionPath, "utf8")));
  return new FightAssets(init, (id) => {
    const f = join(dataDir, "maps", `${id}.ddtm`);
    return existsSync(f) ? decodeMapPack(inflateRawSync(readFileSync(f))) : null;
  });
}

export function loadVendorAssets(assetsDir: string = process.env.DDT_FIGHT_ASSETS ?? DEFAULT_VENDOR_ASSETS, dataDir: string = PACKAGE_DATA_DIR): FightAssets {
  const t = readTemplates(dataDir);
  const shapes = new Map<number, Tile>();
  const bombDir = join(assetsDir, "bomb");
  if (existsSync(bombDir))
    for (const f of readdirSync(bombDir)) {
      const m = /^(\d+)\.bomb$/.exec(f);
      if (m) shapes.set(Number(m[1]), Tile.fromFile(new Uint8Array(readFileSync(join(bombDir, f))), false));
    }
  return new FightAssets({ ...t, shapes }, (id) => {
    const layer = (n: string, dig: boolean) => {
      const f = join(assetsDir, "map", String(id), n);
      return existsSync(f) ? Tile.fromFile(new Uint8Array(readFileSync(f)), dig) : null;
    };
    return { fore: layer("fore.map", true), dead: layer("dead.map", false) };
  });
}
