import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CHRISTMAS_NAVIGATION, isChristmasSegmentClear, isChristmasWalkable, type ChristmasNavigationPoint as Point } from "../src/game/christmas-navigation.js";
import { CHRISTMAS_NAVIGATION_GZIP_BASE64 } from "../src/game/christmas-navigation-data.js";

const { width, height, bounds } = CHRISTMAS_NAVIGATION;
const packed = gunzipSync(Buffer.from(CHRISTMAS_NAVIGATION_GZIP_BASE64, "base64"));
const blocked = (x: number, y: number) => x < 0 || y < 0 || x >= width || y >= height || ((packed[(y * width + x) >>> 3] >>> ((y * width + x) & 7)) & 1) !== 0;

// Independent oracle: closed rectangle edges + orientation intersections, no column/t clipping.
// Fixtures use 1/1024 px integers. All cross products are < 2^53 and therefore exact here.
const SCALE = 1024;
function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function onSegment(a: Point, b: Point, p: Point): boolean {
  return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const p = orientation(a, b, c), q = orientation(a, b, d), r = orientation(c, d, a), s = orientation(c, d, b);
  if (p === 0 && onSegment(a, b, c) || q === 0 && onSegment(a, b, d) || r === 0 && onSegment(c, d, a) || s === 0 && onSegment(c, d, b)) return true;
  return (p < 0 && q > 0 || p > 0 && q < 0) && (r < 0 && s > 0 || r > 0 && s < 0);
}
function touchesRectangle(a: Point, b: Point, x: number, y: number): boolean {
  const left = x * SCALE, top = y * SCALE, right = left + SCALE, bottom = top + SCALE;
  const inside = (p: Point) => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
  if (inside(a) || inside(b)) return true;
  const corners = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  return corners.some((c, i) => intersects(a, b, c, corners[(i + 1) % 4]));
}
function oracle(from: Point, to: Point): boolean {
  for (const p of [from, to]) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= bounds.maxX || p.y >= bounds.maxY) return false;
    if (!Number.isInteger(p.x * SCALE) || !Number.isInteger(p.y * SCALE)) throw new Error("Oracle fixtures must use exact fixed-point coordinates");
  }
  const a = { x: from.x * SCALE, y: from.y * SCALE }, b = { x: to.x * SCALE, y: to.y * SCALE };
  for (let y = Math.floor(Math.min(from.y, to.y)) - 1; y <= Math.floor(Math.max(from.y, to.y)); y++) {
    for (let x = Math.floor(Math.min(from.x, to.x)) - 1; x <= Math.floor(Math.max(from.x, to.x)); x++) {
      if (blocked(x, y) && touchesRectangle(a, b, x, y)) return false;
    }
  }
  return true;
}

function boundary(): { x: number; y: number } {
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    if (!blocked(x - 1, y) && blocked(x, y)) return { x, y };
  }
  throw new Error("Pinned mask has no free/blocked vertical edge");
}
function corner(): { a: Point; b: Point; vertex: Point } {
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    if (!blocked(x - 1, y - 1) && !blocked(x, y) && (blocked(x - 1, y) || blocked(x, y - 1))) {
      return { a: { x: x - 0.25, y: y - 0.25 }, b: { x: x + 0.25, y: y + 0.25 }, vertex: { x, y } };
    }
  }
  throw new Error("Pinned mask has no diagonal corner fixture");
}

describe("pinned Christmas offline navigation", () => {
  it("exposes frozen CPU-only provenance and verifies the compressed payload on import", () => {
    expect(CHRISTMAS_NAVIGATION.navHash).toBe("873f9594cfa29ca91ff2adf9e26f959ea9e43f09ad67d481735f3e5450e24ffa");
    expect(CHRISTMAS_NAVIGATION.sha256.raw).toBe("5fb6fb76844bf32e3c447c40f1defbcd3d40c7c758634701dc1f394813d7338c");
    expect(CHRISTMAS_NAVIGATION.sha256.packed).toBe("318a8a21737ea77a6f3474caeff11e1090e1bd9d2a649f254672c39a47b17d1c");
    expect(CHRISTMAS_NAVIGATION.sha256.gzip).toBe("7fd23c71f16b28139f6e60dcea88fdcf26a1915fc3ee9c89eb7b4fb052e124e3");
    expect(packed.length).toBe(282534);
    expect(CHRISTMAS_NAVIGATION.status).toContain("not-avm2-accepted-or-deployed");
    for (const v of [CHRISTMAS_NAVIGATION, CHRISTMAS_NAVIGATION.bounds, CHRISTMAS_NAVIGATION.sha256, CHRISTMAS_NAVIGATION.spawn, CHRISTMAS_NAVIGATION.npc, CHRISTMAS_NAVIGATION.localMonsterCandidates, ...CHRISTMAS_NAVIGATION.localMonsterCandidates]) expect(Object.isFrozen(v)).toBe(true);
  });

  it("fails closed on non-finite coordinates, outer edges and final partial cells", () => {
    const good = { x: 500, y: 500 };
    const bad = [NaN, Infinity, -Infinity, -1, Number.MAX_VALUE];
    for (const n of bad) {
      expect(isChristmasWalkable(n, 500)).toBe(false);
      expect(isChristmasWalkable(500, n)).toBe(false);
      expect(isChristmasSegmentClear(good, { x: n, y: 500 })).toBe(false);
      expect(isChristmasSegmentClear({ x: 500, y: n }, good)).toBe(false);
    }
    for (const p of [{ x: 0, y: 500 }, { x: 500, y: 0 }, { x: 1735.4, y: 500 }, { x: 500, y: 1301.5 }, { x: 1735.1, y: 500 }, { x: 500, y: 1301.25 }]) {
      expect(isChristmasWalkable(p.x, p.y)).toBe(false);
      expect(isChristmasSegmentClear(good, p)).toBe(false);
    }
  });

  it("checks both sides of grid lines, all four vertex cells and a conservative near-edge halo", () => {
    const { x, y } = boundary();
    expect(isChristmasWalkable(x - 0.25, y + 0.5)).toBe(true);
    expect(isChristmasWalkable(x, y + 0.5)).toBe(false);
    expect(isChristmasWalkable(x - 5e-10, y + 0.5)).toBe(false);
    expect(isChristmasWalkable(x - 1e-6, y + 0.5)).toBe(true);
    expect(isChristmasSegmentClear({ x, y: y + 0.25 }, { x, y: y + 0.75 })).toBe(false);
    const c = corner();
    expect(isChristmasWalkable(c.a.x, c.a.y)).toBe(true);
    expect(isChristmasWalkable(c.b.x, c.b.y)).toBe(true);
    expect(isChristmasWalkable(c.vertex.x, c.vertex.y)).toBe(false);
    expect(isChristmasSegmentClear(c.a, c.b)).toBe(false);
    expect(isChristmasSegmentClear(c.b, c.a)).toBe(false);
    expect(oracle(c.a, c.b)).toBe(false);
    for (const shift of [-5e-10, 5e-10]) {
      const a = { x: c.a.x + shift, y: c.a.y - shift }, b = { x: c.b.x + shift, y: c.b.y - shift };
      expect(isChristmasSegmentClear(a, b)).toBe(false);
      expect(isChristmasSegmentClear(b, a)).toBe(false);
    }
  });

  it("accepts zero, subpixel and integer-grid clear segments without tunnelling through real obstacles", () => {
    const a = { x: 650, y: 500 }, b = { x: 650.0000000001, y: 500.0000000001 };
    expect(isChristmasSegmentClear(a, a)).toBe(true);
    expect(isChristmasSegmentClear(a, b)).toBe(true);
    expect(isChristmasSegmentClear({ x: 640, y: 500 }, { x: 660, y: 500 })).toBe(true);
    const from = { x: 500, y: 500 }, to = { x: 1450, y: 400 };
    expect(isChristmasWalkable(from.x, from.y) && isChristmasWalkable(to.x, to.y)).toBe(true);
    expect(oracle(from, to)).toBe(false);
    expect(isChristmasSegmentClear(from, to)).toBe(false);
    expect(isChristmasSegmentClear(to, from)).toBe(false);
  });

  it("matches an independent closed-rectangle oracle for deterministic local and long segments", () => {
    let state = 0x16c0ffee;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
    const point = () => ({ x: Math.floor(random() * 1734 * SCALE) / SCALE, y: Math.floor(random() * 1300 * SCALE) / SCALE });
    const pairs: [Point, Point][] = [];
    for (let i = 0; i < 96; i++) {
      const a = point();
      const b = i < 48 ? point() : { x: Math.max(1, Math.min(1734, a.x + Math.floor(random() * 65) - 32)), y: Math.max(1, Math.min(1300, a.y + Math.floor(random() * 65) - 32)) };
      pairs.push([a, b]);
    }
    let testedFreeEndpoints = 0;
    for (const [a, b] of pairs) {
      const expected = oracle(a, b);
      expect(isChristmasSegmentClear(a, b), JSON.stringify([a, b])).toBe(expected);
      expect(isChristmasSegmentClear(b, a), JSON.stringify([b, a])).toBe(expected);
      if (isChristmasWalkable(a.x, a.y) && isChristmasWalkable(b.x, b.y)) testedFreeEndpoints++;
    }
    expect(testedFreeEndpoints).toBeGreaterThan(15);
  });

  it("keeps the pinned spawn, logical NPC radius and three explicitly local monster clearances", () => {
    expect(isChristmasWalkable(500, 500)).toBe(true);
    // The logical NPC radius center's floor cell is free, but its closed boundary touches an obstacle.
    expect(blocked(1200, 510)).toBe(false);
    expect(oracle({ x: 1200, y: 510 }, { x: 1200, y: 510 })).toBe(false);
    expect(isChristmasWalkable(1200, 510)).toBe(false);
    const candidate = { x: 1001.5, y: 661.5 };
    expect(Math.hypot(candidate.x - 1200, candidate.y - 510)).toBeLessThan(250);
    expect(isChristmasWalkable(candidate.x, candidate.y)).toBe(true);
    // Collinear compression of the already pinned 662-step CPU route; no new flood/pathfinder.
    const route = [{ x: 500, y: 500 }, { x: 500.5, y: 500.5 }, { x: 500.5, y: 661.5 }, candidate];
    for (let i = 1; i < route.length; i++) {
      expect(isChristmasSegmentClear(route[i - 1], route[i])).toBe(true);
      expect(isChristmasSegmentClear(route[i], route[i - 1])).toBe(true);
      expect(oracle(route[i - 1], route[i])).toBe(true);
    }
    for (const p of CHRISTMAS_NAVIGATION.localMonsterCandidates) {
      expect(isChristmasWalkable(p.x, p.y)).toBe(true);
      for (const d of [{ x: -32, y: -32 }, { x: 32, y: 32 }, { x: -32, y: 32 }, { x: 32, y: -32 }]) {
        const edge = { x: p.x + d.x, y: p.y + d.y };
        expect(isChristmasSegmentClear(p, edge)).toBe(true);
        expect(oracle(p, edge)).toBe(true);
      }
    }
  });
});
