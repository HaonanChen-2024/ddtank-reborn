import assert from "node:assert/strict";

function appearanceCategory(localId: number): number {
  assert.ok(Number.isSafeInteger(localId) && localId >= 1_000_000 && localId < 7_000_000,
    "appearance ID must be a seven-digit local ID in categories 1-6");
  return Math.floor(localId / 1_000_000);
}

/** Source IDs remain in the receipt; only the unique local ID belongs in the path. */
export function createAppearancePic(localId: number, kind: "official" | "reference" = "official"): string {
  appearanceCategory(localId);
  assert.ok(kind === "official" || kind === "reference", "unknown appearance source kind");
  const pic = `${kind === "reference" ? "r" : "o"}${localId.toString(36)}`;
  assert.ok(`${localId}|${pic}`.length <= 14, "appearance segment exceeds the legacy style budget");
  return pic;
}

/** Categories 1-6 occupy both equipment slots and Style indexes 0-5. */
export function assertEquippedStyleFits(currentStyle: string, slot: number, localId: number, pic: string): void {
  assert.equal(typeof currentStyle, "string", "current Style must be a string");
  assert.ok(Number.isInteger(slot) && slot >= 0 && slot <= 5, "appearance slot must be 0-5");
  assert.equal(appearanceCategory(localId) - 1, slot, "appearance ID category does not match its slot");
  // Legacy receipts use longer names with underscores; retain their resume support.
  assert.ok(typeof pic === "string" && /^[A-Za-z0-9_]+$/.test(pic), "appearance Pic must be a safe path segment");
  const projected = currentStyle.split(",");
  projected[slot] = `${localId}|${pic}`;
  assert.ok(projected.join(",").length <= 200,
    "equipped Style exceeds the legacy save field; keep resource Pic names short");
}
