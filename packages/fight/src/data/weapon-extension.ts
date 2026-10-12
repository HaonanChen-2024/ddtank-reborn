import { Tile } from "../phy/tile.js";
import type { BallConfigInfo, BallInfo, ItemTemplate } from "./types.js";

/** Local compatibility data, not verified official weapon physics. Loaded only through the Node entrypoint. */
export interface LocalWeaponExtension {
  schemaVersion: 1;
  source: "local-compat";
  items: ItemTemplate[];
  ballConfigs: BallConfigInfo[];
  balls: (BallInfo & { shapeId?: number; shapeSource?: "local-compat" })[];
  shapes?: { ballId: number; source: "official-image-derived-local-mask"; fileBase64: string }[];
}

interface WeaponTemplates {
  items: ItemTemplate[];
  ballConfigs: BallConfigInfo[];
  balls: BallInfo[];
}

const branches = ["common", "special", "commonAddWound", "commonMultiBall"] as const;
const properties = ["property1", "property2", "property3", "property4", "property5", "property6", "property7", "property8"] as const;
const physics = ["power", "radii", "mass", "weight", "wind", "dragIndex", "amount", "delay"] as const;

function fail(at: string, reason: string): never {
  throw new Error(`Invalid weapon extension ${at}: ${reason}`);
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(at, "expected an object");
  return value as Record<string, unknown>;
}

function rows(value: unknown, at: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) fail(at, "expected an array");
  return value.map((v, i) => record(v, `${at}[${i}]`));
}

function id(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 0x7fffffff) fail(at, "expected a positive int32 ID");
  return value;
}

function finite(value: unknown, at: string): number {
  // The physics engine uses float32; a finite JSON number may still overflow it.
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) fail(at, "expected a finite float32 number");
  return value;
}

function optionalName(row: Record<string, unknown>, at: string): string | undefined {
  if (row.name !== undefined && typeof row.name !== "string") fail(`${at}.name`, "expected a string");
  return row.name as string | undefined;
}

/** Validate the whole addition before creating merged containers; never mutate the caller's base data. */
export function mergeWeaponExtension<T extends WeaponTemplates>(base: T, shapes: Map<number, Tile>, input: unknown): T & { shapes: Map<number, Tile> } {
  const pack = record(input, "pack");
  if (pack.schemaVersion !== 1) fail("schemaVersion", "expected 1");
  if (pack.source !== "local-compat") fail("source", "must be local-compat");
  const itemRows = rows(pack.items, "items"), configRows = rows(pack.ballConfigs, "ballConfigs"), ballRows = rows(pack.balls, "balls");
  if (!itemRows.length) fail("items", "must contain a weapon");
  const items = new Map<number, ItemTemplate>(), configs = new Map<number, BallConfigInfo>(), balls = new Map<number, BallInfo>();
  const baseItems = new Set(base.items.map((v) => v.templateId)), baseConfigs = new Set(base.ballConfigs.map((v) => v.templateId));
  const baseBalls = new Map<number, BallInfo>();
  for (const ball of base.balls) if (!baseBalls.has(ball.id)) baseBalls.set(ball.id, ball); // Match FightAssets' first-row rule.
  const shapeRefs = new Map<number, number>();

  for (const [i, row] of itemRows.entries()) {
    const at = `items[${i}]`, templateId = id(row.templateId, `${at}.templateId`);
    if (baseItems.has(templateId) || items.has(templateId)) fail(at, `item ID ${templateId} already exists`);
    if (row.categoryId !== 7) fail(`${at}.categoryId`, "expected weapon category 7");
    const item = { templateId, name: optionalName(row, at), categoryId: 7 } as ItemTemplate;
    for (const key of properties) item[key] = finite(row[key], `${at}.${key}`);
    items.set(templateId, item);
  }

  for (const [i, row] of ballRows.entries()) {
    const at = `balls[${i}]`, ballId = id(row.id, `${at}.id`);
    if (baseBalls.has(ballId) || shapes.has(ballId) || balls.has(ballId)) fail(at, `ball/shape ID ${ballId} already exists`);
    if (typeof row.hasTunnel !== "boolean") fail(`${at}.hasTunnel`, "expected a boolean");
    if (typeof row.flyingPartical !== "string") fail(`${at}.flyingPartical`, "expected a string");
    const ball = { id: ballId, name: optionalName(row, at), hasTunnel: row.hasTunnel, flyingPartical: row.flyingPartical } as BallInfo;
    for (const key of physics) ball[key] = finite(row[key], `${at}.${key}`);
    if (Math.fround(ball.mass) <= 0) fail(`${at}.mass`, "must be positive in float32");
    if (!Number.isInteger(ball.amount) || ball.amount < 1 || ball.amount > 0x7fffffff) fail(`${at}.amount`, "must be a positive int32");
    if (ball.power < 0 || ball.radii < 0 || ball.delay < 0) fail(at, "power, radii and delay must be nonnegative");
    if (ball.hasTunnel && (row.shapeId !== undefined || row.shapeSource !== undefined)) {
      const shapeId = id(row.shapeId, `${at}.shapeId`);
      if (row.shapeSource !== "local-compat") fail(`${at}.shapeSource`, "must be local-compat");
      if (!shapes.has(shapeId)) fail(`${at}.shapeId`, `base shape ${shapeId} does not exist`);
      shapeRefs.set(ballId, shapeId);
    } else if (!ball.hasTunnel && (row.shapeId !== undefined || row.shapeSource !== undefined)) fail(at, "a non-tunneling ball must not specify a shape");
    balls.set(ballId, ball);
  }

  const shapeFiles = new Map<number, Uint8Array>();
  for (const [i, row] of rows(pack.shapes === undefined ? [] : pack.shapes, "shapes").entries()) {
    const at = `shapes[${i}]`, ballId = id(row.ballId, `${at}.ballId`);
    if (!balls.has(ballId)) fail(at, `shape must belong to a new ball ${ballId}`);
    if (!balls.get(ballId)!.hasTunnel) fail(at, `ball ${ballId} does not tunnel`);
    if (shapes.has(ballId) || shapeFiles.has(ballId) || shapeRefs.has(ballId)) fail(at, `duplicate or conflicting shape for ball ${ballId}`);
    if (row.source !== "official-image-derived-local-mask") fail(`${at}.source`, "must be official-image-derived-local-mask");
    const encoded = row.fileBase64;
    if (typeof encoded !== "string" || !encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail(`${at}.fileBase64`, "expected canonical base64");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) fail(`${at}.fileBase64`, "expected canonical base64");
    if (bytes.length < 8) fail(at, "bomb header is truncated");
    const width = bytes.readInt32LE(0), height = bytes.readInt32LE(4);
    if (width < 1 || height < 1 || width > 4096 || height > 4096) fail(at, "bomb dimensions must be 1..4096");
    if (bytes.length !== 8 + (Math.floor(width / 8) + 1) * height) fail(at, "bomb byte length does not match dimensions");
    shapeFiles.set(ballId, bytes);
  }
  for (const ball of balls.values()) if (ball.hasTunnel && !shapeRefs.has(ball.id) && !shapeFiles.has(ball.id)) fail("balls", `ball ${ball.id} has no shape`);

  const usedBalls = new Set<number>();
  for (const [i, row] of configRows.entries()) {
    const at = `ballConfigs[${i}]`, templateId = id(row.templateId, `${at}.templateId`);
    if (baseConfigs.has(templateId) || configs.has(templateId)) fail(at, `configuration ID ${templateId} already exists`);
    if (!items.has(templateId)) fail(at, `no new weapon item ${templateId}`);
    const config = { templateId } as BallConfigInfo;
    for (const key of branches) {
      const ballId = id(row[key], `${at}.${key}`), ball = balls.get(ballId) ?? baseBalls.get(ballId);
      if (!ball) fail(`${at}.${key}`, `ball ${ballId} does not exist`);
      if (ball.hasTunnel && !shapeRefs.has(ballId) && !shapeFiles.has(ballId) && !shapes.has(ballId)) fail(`${at}.${key}`, `ball ${ballId} has no shape`);
      config[key] = ballId;
      usedBalls.add(ballId);
    }
    configs.set(templateId, config);
  }
  for (const templateId of items.keys()) if (!configs.has(templateId)) fail("ballConfigs", `weapon ${templateId} has no configuration`);
  for (const ballId of balls.keys()) if (!usedBalls.has(ballId)) fail("balls", `ball ${ballId} is not referenced by a weapon`);

  const mergedShapes = new Map(shapes);
  for (const [ballId, shapeId] of shapeRefs) mergedShapes.set(ballId, shapes.get(shapeId)!.clone());
  for (const [ballId, bytes] of shapeFiles) mergedShapes.set(ballId, Tile.fromFile(bytes, false));
  return { ...base, items: [...base.items, ...items.values()], ballConfigs: [...base.ballConfigs, ...configs.values()], balls: [...base.balls, ...balls.values()], shapes: mergedShapes };
}
