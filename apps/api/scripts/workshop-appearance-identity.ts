import assert from "node:assert/strict";

function appearanceCategory(localId: number): number {
  assert.ok(Number.isSafeInteger(localId) && ((localId >= 1_000_000 && localId < 7_000_000) || (localId >= 13_000_000 && localId < 14_000_000)),
    "appearance ID must be a local ID in categories 1-6 or 13");
  return Math.floor(localId / 1_000_000);
}

/** Original PlayerEquipInventory: suits use equipment slot 11, not CategoryID - 1. */
export function appearanceEquipSlot(category: number): number {
  assert.ok([1, 2, 3, 4, 5, 6, 13].includes(category), "unsupported appearance category");
  return category === 13 ? 11 : category - 1;
}

/** GamePlayer.recalcStats serializes equipment slots 0-6, 11, 13-20. */
export function appearanceStyleIndex(category: number): number {
  return category === 13 ? 7 : appearanceEquipSlot(category);
}

/** Source IDs remain in the receipt; only the unique local ID belongs in the path. */
export function createAppearancePic(localId: number, kind: "official" | "reference" = "official"): string {
  const category = appearanceCategory(localId);
  assert.ok(kind === "official" || kind === "reference", "unknown appearance source kind");
  const pic = `${kind === "reference" ? "r" : "o"}${localId.toString(36)}`;
  assert.ok(`${localId}|${pic}`.length <= (category === 13 ? 15 : 14), "appearance segment exceeds the legacy style budget");
  return pic;
}

/** slot is an equipment slot; suit slot 11 projects into Style index 7. */
export function assertEquippedStyleFits(currentStyle: string, slot: number, localId: number, pic: string): void {
  assert.equal(typeof currentStyle, "string", "current Style must be a string");
  assert.ok(Number.isInteger(slot) && ((slot >= 0 && slot <= 5) || slot === 11), "appearance slot must be 0-5 or 11");
  const category = appearanceCategory(localId);
  assert.equal(appearanceEquipSlot(category), slot, "appearance ID category does not match its slot");
  // Legacy receipts use longer names with underscores; retain their resume support.
  assert.ok(typeof pic === "string" && /^[A-Za-z0-9_]+$/.test(pic), "appearance Pic must be a safe path segment");
  const projected = currentStyle.split(",");
  projected[appearanceStyleIndex(category)] = `${localId}|${pic}`;
  assert.ok(projected.join(",").length <= 200,
    "equipped Style exceeds the legacy save field; keep resource Pic names short");
}
