import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { encodeBombPack } from "../src/data/assets.js";
import { mergeWeaponExtension, type LocalWeaponExtension } from "../src/data/weapon-extension.js";
import type { BallInfo, ItemTemplate } from "../src/data/types.js";
import { loadPackedAssets } from "../src/node.js";
import { Tile } from "../src/phy/tile.js";

// Synthetic loader fixtures only; these numbers do not describe an actual weapon.
const baseBall: BallInfo = { id: 20, power: 1, radii: 2, mass: 10, weight: 70, wind: 240, dragIndex: 1, amount: 1, delay: 200, hasTunnel: true, flyingPartical: "fixture" };
const baseItem: ItemTemplate = { templateId: 7001, categoryId: 7, property1: 20, property2: 20, property3: 0, property4: 0, property5: 25, property6: 60, property7: 175, property8: 5 };
const baseConfig = { templateId: 7001, common: 20, special: 20, commonAddWound: 20, commonMultiBall: 20 };
const base = { items: [baseItem], balls: [baseBall], ballConfigs: [baseConfig], maps: [] };
const shape = new Tile(Uint8Array.of(0x80), 1, 1, false);
const shapes = new Map([[20, shape], [29, shape.clone()]]);
const dir = mkdtempSync(join(tmpdir(), "ddt-weapon-extension-"));
const path = join(dir, "weapon-extension.json");
for (const [file, data] of [["balls.json", base.balls], ["items.json", base.items], ["ballconfig.json", base.ballConfigs], ["maps.json", base.maps]] as const)
  writeFileSync(join(dir, file), JSON.stringify(data));
writeFileSync(join(dir, "bombs.ddtb"), deflateRawSync(encodeBombPack([...shapes].map(([id, tile]) => [id, tile.toFile()]))));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function extension(): LocalWeaponExtension {
  return {
    schemaVersion: 1, source: "local-compat",
    items: [{ ...baseItem, templateId: 900001, property1: 900011, property2: 900011 }],
    ballConfigs: [{ templateId: 900001, common: 900011, special: 900011, commonAddWound: 900011, commonMultiBall: 900011 }],
    balls: [{ ...baseBall, id: 900011, shapeId: 20, shapeSource: "local-compat" }],
  };
}

function load(pack: unknown) {
  writeFileSync(path, JSON.stringify(pack));
  return loadPackedAssets(dir, { weaponExtensionPath: path });
}

function derivedShapeExtension(): LocalWeaponExtension {
  const pack = extension();
  delete pack.balls[0].shapeId;
  delete pack.balls[0].shapeSource;
  pack.shapes = [{ ballId: 900011, source: "official-image-derived-local-mask", fileBase64: Buffer.from(new Tile(Uint8Array.of(0xc0), 2, 1, false).toFile()).toString("base64") }];
  return pack;
}

describe("explicit local weapon extension", () => {
  it("is disabled by default and adds all branches without changing base weapons or files", () => {
    const files = ["items.json", "balls.json", "ballconfig.json", "bombs.ddtb"].map((f) => [f, readFileSync(join(dir, f))] as const);
    const pack = extension(), loaded = load(pack);
    expect(loadPackedAssets(dir).items.has(900001)).toBe(false);
    expect(loaded.items.get(900001)).toEqual(pack.items[0]);
    expect(loaded.ballConfigs.get(900001)).toEqual(pack.ballConfigs[0]);
    expect(loaded.ball(900011)).toEqual({ ...baseBall, id: 900011 });
    expect(loaded.items.get(7001)).toEqual(baseItem);
    expect(loaded.ballConfigs.get(7001)).toEqual(baseConfig);
    expect(loaded.ball(20)).toEqual(baseBall);
    expect(loaded.shape(900011)?.data).toEqual(loaded.shape(20)?.data);
    expect(loaded.shape(900011)).not.toBe(loaded.shape(20));
    loaded.shape(900011)!.data[0] = 0;
    expect(loaded.shape(20)!.data[0]).toBe(0x80);
    for (const [file, bytes] of files) expect(readFileSync(join(dir, file))).toEqual(bytes);
    expect(loadPackedAssets(dir).balls.has(900011)).toBe(false);
  });

  it("allows existing balls and reuse of the same ball in all four branches", () => {
    const pack = extension();
    pack.balls = [];
    pack.items[0].property1 = pack.items[0].property2 = 20;
    pack.ballConfigs[0] = { templateId: 900001, common: 20, special: 20, commonAddWound: 20, commonMultiBall: 20 };
    const loaded = load(pack);
    expect(loaded.ballConfigs.get(900001)).toEqual(pack.ballConfigs[0]);
    expect(loaded.balls.size).toBe(1);
  });

  it("allows explicit non-tunneling balls without a shape", () => {
    const pack = extension();
    pack.balls[0].hasTunnel = false;
    delete pack.balls[0].shapeId;
    delete pack.balls[0].shapeSource;
    expect(load(pack).shape(900011)).toBeNull();
  });

  it("loads an image-derived local mask without borrowing or changing the base shape", () => {
    const pack = derivedShapeExtension(), loaded = load(pack);
    expect(loaded.shape(900011)?.width).toBe(2);
    expect(loaded.shape(900011)?.height).toBe(1);
    expect(loaded.shape(900011)?.data).toEqual(Uint8Array.of(0xc0));
    expect(loaded.shape(20)?.data).toEqual(Uint8Array.of(0x80));
    expect(loaded.shape(900011)?.digable).toBe(false);
    expect(loaded.shapes.has(29)).toBe(true);
  });

  it.each([
    ["base ball", (p: LocalWeaponExtension) => { p.shapes![0].ballId = 20; }, /must belong to a new ball/],
    ["unknown ball", (p: LocalWeaponExtension) => { p.shapes![0].ballId = 900099; }, /must belong to a new ball/],
    ["duplicate shape", (p: LocalWeaponExtension) => { p.shapes!.push({ ...p.shapes![0] }); }, /duplicate or conflicting/],
    ["both shape kinds", (p: LocalWeaponExtension) => { p.balls[0].shapeId = 20; p.balls[0].shapeSource = "local-compat"; }, /duplicate or conflicting/],
    ["non-tunneling shape", (p: LocalWeaponExtension) => { p.balls[0].hasTunnel = false; }, /does not tunnel/],
    ["missing shape", (p: LocalWeaponExtension) => { p.shapes = []; }, /ball 900011 has no shape/],
    ["whitespace base64", (p: LocalWeaponExtension) => { p.shapes![0].fileBase64 += "\n"; }, /canonical base64/],
    ["invalid base64", (p: LocalWeaponExtension) => { p.shapes![0].fileBase64 = "!!!!"; }, /canonical base64/],
    ["noncanonical padding", (p: LocalWeaponExtension) => { p.shapes![0].fileBase64 = "AB=="; }, /canonical base64/],
    ["truncated header", (p: LocalWeaponExtension) => { p.shapes![0].fileBase64 = "AA=="; }, /header is truncated/],
  ])("rejects image-derived %s", (_name, mutate, error) => {
    const pack = derivedShapeExtension();
    mutate(pack);
    expect(() => load(pack)).toThrow(error);
  });

  it.each([[0, 1], [-1, 1], [1, 0], [1, 4097], [4097, 1]])("rejects image-derived dimensions %s x %s", (width, height) => {
    const pack = derivedShapeExtension(), bytes = Buffer.alloc(9);
    bytes.writeInt32LE(width, 0); bytes.writeInt32LE(height, 4);
    pack.shapes![0].fileBase64 = bytes.toString("base64");
    expect(() => load(pack)).toThrow(/dimensions must be 1\.\.4096/);
  });

  it("rejects truncated/trailing image-derived bytes and wrong provenance", () => {
    for (const length of [8, 10]) {
      const pack = derivedShapeExtension(), bytes = Buffer.alloc(length);
      bytes.writeInt32LE(2, 0); bytes.writeInt32LE(1, 4);
      pack.shapes![0].fileBase64 = bytes.toString("base64");
      expect(() => load(pack)).toThrow(/byte length does not match/);
    }
    const pack = derivedShapeExtension();
    expect(() => load({ ...pack, shapes: [{ ...pack.shapes![0], source: "official" }] })).toThrow(/source.*official-image-derived-local-mask/);
  });

  it.each([
    ["existing item", (p: LocalWeaponExtension) => { p.items[0].templateId = 7001; }, /item ID 7001 already exists/],
    ["existing configuration", (p: LocalWeaponExtension) => { p.ballConfigs[0].templateId = 7001; }, /configuration ID 7001 already exists/],
    ["existing ball", (p: LocalWeaponExtension) => { p.balls[0].id = 20; }, /ball\/shape ID 20 already exists/],
    ["existing shape ID", (p: LocalWeaponExtension) => { p.balls[0].id = 29; }, /ball\/shape ID 29 already exists/],
    ["duplicate item", (p: LocalWeaponExtension) => { p.items.push({ ...p.items[0] }); }, /item ID 900001 already exists/],
    ["duplicate config", (p: LocalWeaponExtension) => { p.ballConfigs.push({ ...p.ballConfigs[0] }); }, /configuration ID 900001 already exists/],
    ["duplicate ball", (p: LocalWeaponExtension) => { p.balls.push({ ...p.balls[0] }); }, /ball\/shape ID 900011 already exists/],
    ["orphan item", (p: LocalWeaponExtension) => { p.ballConfigs = []; }, /weapon 900001 has no configuration/],
    ["orphan config", (p: LocalWeaponExtension) => { p.ballConfigs[0].templateId = 900002; }, /no new weapon item 900002/],
    ["orphan ball", (p: LocalWeaponExtension) => { p.balls.push({ ...p.balls[0], id: 900012 }); }, /ball 900012 is not referenced/],
    ["missing branch", (p: LocalWeaponExtension) => { delete (p.ballConfigs[0] as Partial<typeof baseConfig>).special; }, /special.*positive int32/],
    ["unknown branch", (p: LocalWeaponExtension) => { p.ballConfigs[0].commonMultiBall = 900099; }, /ball 900099 does not exist/],
    ["missing shape", (p: LocalWeaponExtension) => { delete p.balls[0].shapeId; }, /shapeId.*positive int32/],
    ["unknown shape", (p: LocalWeaponExtension) => { p.balls[0].shapeId = 900099; }, /base shape 900099 does not exist/],
    ["shape provenance omitted", (p: LocalWeaponExtension) => { delete p.balls[0].shapeSource; }, /shapeSource.*local-compat/],
    ["idle shape", (p: LocalWeaponExtension) => { p.balls[0].hasTunnel = false; }, /non-tunneling ball must not specify a shape/],
    ["non-weapon", (p: LocalWeaponExtension) => { p.items[0].categoryId = 1; }, /weapon category 7/],
    ["zero mass", (p: LocalWeaponExtension) => { p.balls[0].mass = 0; }, /mass.*positive/],
    ["underflowing mass", (p: LocalWeaponExtension) => { p.balls[0].mass = 1e-100; }, /mass.*positive/],
    ["fractional amount", (p: LocalWeaponExtension) => { p.balls[0].amount = 1.5; }, /amount.*positive int32/],
  ])("rejects %s", (_name, mutate, error) => {
    const pack = extension();
    mutate(pack);
    expect(() => load(pack)).toThrow(error);
  });

  it.each(["power", "radii", "mass", "weight", "wind", "dragIndex", "amount", "delay"] as const)("rejects non-finite %s and float32 overflow", (field) => {
    for (const value of [NaN, Infinity, -Infinity, 1e100]) {
      const pack = extension();
      pack.balls[0][field] = value;
      expect(() => mergeWeaponExtension(base, shapes, pack)).toThrow(/finite float32/);
    }
  });

  it("rejects malformed JSON, unknown schemas/provenance and JSON numeric overflow", () => {
    writeFileSync(path, "{");
    expect(() => loadPackedAssets(dir, { weaponExtensionPath: path })).toThrow(SyntaxError);
    expect(() => load({ ...extension(), schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => load({ ...extension(), source: "official" })).toThrow(/source.*local-compat/);
    const pack = extension();
    expect(() => load({ ...pack, balls: [{ ...pack.balls[0], shapeSource: "official" }] })).toThrow(/shapeSource.*local-compat/);
    expect(() => load({ ...pack, items: null })).toThrow(/items.*array/);
    expect(() => load({ ...pack, items: [{ ...pack.items[0], property8: null }] })).toThrow(/property8.*finite/);
    writeFileSync(path, JSON.stringify(pack).replace('"mass":10', '"mass":1e999'));
    expect(() => loadPackedAssets(dir, { weaponExtensionPath: path })).toThrow(/mass.*finite/);
  });

  it("rejects a referenced base tunneling ball without its shape", () => {
    const pack = extension();
    const missingBaseShape = { ...base, balls: [...base.balls, { ...baseBall, id: 21 }] };
    pack.ballConfigs[0].special = 21;
    expect(() => mergeWeaponExtension(missingBaseShape, shapes, pack)).toThrow(/ball 21 has no shape/);
  });

  it("resolves duplicate base ball rows with the same first-row rule as FightAssets", () => {
    const pack = extension();
    pack.ballConfigs[0].special = 21;
    const duplicateBase = { ...base, balls: [...base.balls, { ...baseBall, id: 21, hasTunnel: false }, { ...baseBall, id: 21 }] };
    expect(() => mergeWeaponExtension(duplicateBase, shapes, pack)).not.toThrow();
  });

  it("validates the complete pack before applying or cloning any shape", () => {
    const pack = extension(), before = JSON.stringify(base), shapeBytes = shape.data.slice();
    const clone = vi.spyOn(shape, "clone");
    pack.ballConfigs.push({ ...pack.ballConfigs[0], templateId: 900099 });
    try {
      expect(() => mergeWeaponExtension(base, shapes, pack)).toThrow(/no new weapon item/);
      expect(clone).not.toHaveBeenCalled();
      expect(JSON.stringify(base)).toBe(before);
      expect([...shapes.keys()]).toEqual([20, 29]);
      expect(shape.data).toEqual(shapeBytes);
    } finally {
      clone.mockRestore();
    }
  });
});
