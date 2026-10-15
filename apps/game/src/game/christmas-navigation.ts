import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { CHRISTMAS_NAVIGATION_DATA, CHRISTMAS_NAVIGATION_GZIP_BASE64, CHRISTMAS_NAVIGATION_PROVENANCE } from "./christmas-navigation-data.js";

export type ChristmasNavigationPoint = Readonly<{ x: number; y: number }>;

/** Pinned offline CPU geometry; this does not assert AVM2 parity or enable scene admission. */
export const CHRISTMAS_NAVIGATION = CHRISTMAS_NAVIGATION_DATA;

const { width, height, bounds, sha256 } = CHRISTMAS_NAVIGATION;
const EPSILON = CHRISTMAS_NAVIGATION.boundaryEpsilonPixels;
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function loadMask(): Buffer {
  const gzip = Buffer.from(CHRISTMAS_NAVIGATION_GZIP_BASE64, "base64");
  assert.equal(gzip.length, CHRISTMAS_NAVIGATION.gzipBytes, "Christmas navigation gzip length");
  assert.equal(hash(gzip), sha256.gzip, "Christmas navigation gzip hash");
  const packed = gunzipSync(gzip, { maxOutputLength: CHRISTMAS_NAVIGATION.packedBytes });
  assert.equal(packed.length, CHRISTMAS_NAVIGATION.packedBytes, "Christmas navigation packed length");
  assert.equal(hash(packed), sha256.packed, "Christmas navigation packed hash");
  // Expanding LSB0 once also verifies the bit order against the original Python uint8 mask.
  const raw = Buffer.alloc(width * height);
  for (let i = 0; i < raw.length; i++) raw[i] = (packed[i >>> 3] >>> (i & 7)) & 1;
  assert.equal(raw.length, CHRISTMAS_NAVIGATION.rawBytes, "Christmas navigation raw length");
  assert.equal(hash(raw), sha256.raw, "Christmas navigation raw hash / LSB0 order");
  assert.equal(hash(CHRISTMAS_NAVIGATION_PROVENANCE), CHRISTMAS_NAVIGATION.navHash, "Christmas navigation provenance hash");
  const provenance = JSON.parse(CHRISTMAS_NAVIGATION_PROVENANCE);
  assert.deepEqual(provenance.dimensionsPixels, [width, height]);
  assert.deepEqual(provenance.backgroundBoundsPixels, [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]);
  assert.equal(provenance.maskSha256, sha256.raw);
  assert.equal(provenance.rawMapSha256, sha256.originalMap);
  assert.equal(provenance.geometrySha256, sha256.geometry);
  assert.equal(provenance.rasterizerSha256, sha256.rasterizer);
  assert.equal(provenance.coordinateModel, CHRISTMAS_NAVIGATION.coordinateModel);
  return packed;
}

// Private immutable-by-ownership buffer; queries never decompress or rescan the whole mask.
const mask = loadMask();

function inDomain(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= bounds.minX && y >= bounds.minY && x < bounds.maxX && y < bounds.maxY;
}

function clearCell(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = y * width + x;
  return ((mask[i >>> 3] >>> (i & 7)) & 1) === 0;
}

/** Closed-cell point test: integer edges touch both cells, vertices touch all four. */
export function isChristmasWalkable(x: number, y: number): boolean {
  if (!inDomain(x, y)) return false;
  for (let column = Math.floor(x - EPSILON); column <= Math.floor(x + EPSILON); column++) {
    for (let row = Math.floor(y - EPSILON); row <= Math.floor(y + EPSILON); row++) {
      if (!clearCell(column, row)) return false;
    }
  }
  return true;
}

/**
 * Closed-cell supercover by column slabs, not endpoint checks or sampled/Bresenham steps.
 * Each touched column clips the full double-precision segment to its expanded x slab;
 * the complete resulting y interval covers every touched row, including corner peers.
 * A uniform 1e-9 px halo may reject additional near-boundary paths, never permit a gap.
 * Integer protocol endpoints and fractional internal path points use the same predicate.
 * Finite map bounds cap both loops; endpoint ordering makes reversed calls identical.
 */
export function isChristmasSegmentClear(from: ChristmasNavigationPoint, to: ChristmasNavigationPoint): boolean {
  if (!isChristmasWalkable(from.x, from.y) || !isChristmasWalkable(to.x, to.y)) return false;
  let a = from, b = to;
  if (a.x > b.x || (a.x === b.x && a.y > b.y)) [a, b] = [b, a];
  const dx = b.x - a.x, dy = b.y - a.y;
  const firstColumn = Math.floor(a.x - EPSILON), lastColumn = Math.floor(b.x + EPSILON);
  for (let column = firstColumn; column <= lastColumn; column++) {
    let enter = 0, leave = 1;
    if (dx !== 0) {
      enter = Math.max(0, (column - EPSILON - a.x) / dx);
      leave = Math.min(1, (column + 1 + EPSILON - a.x) / dx);
      if (enter > leave) continue;
    }
    const y1 = a.y + dy * enter, y2 = a.y + dy * leave;
    const firstRow = Math.floor(Math.min(y1, y2) - EPSILON);
    const lastRow = Math.floor(Math.max(y1, y2) + EPSILON);
    for (let row = firstRow; row <= lastRow; row++) {
      if (!clearCell(column, row)) return false;
    }
  }
  return true;
}
