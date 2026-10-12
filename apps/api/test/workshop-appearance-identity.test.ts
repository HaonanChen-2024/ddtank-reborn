import { describe, expect, it } from "vitest";
import { appearanceEquipSlot, appearanceStyleIndex, assertEquippedStyleFits, createAppearancePic } from "../scripts/workshop-appearance-identity.js";

describe("workshop appearance identities", () => {
  it("makes deterministic, path-safe identities for all six local categories and both sources", () => {
    const pics: string[] = [];
    for (let category = 1; category <= 6; category++) for (const kind of ["official", "reference"] as const) {
      const id = category * 1_000_000 + 999100, pic = createAppearancePic(id, kind);
      expect(pic).toBe(`${kind === "reference" ? "r" : "o"}${id.toString(36)}`);
      expect(pic).toMatch(/^[or][a-z0-9]+$/);
      expect(`${id}|${pic}`.length).toBeLessThanOrEqual(14);
      expect(createAppearancePic(id, kind)).toBe(pic);
      pics.push(pic);
    }
    expect(new Set(pics).size).toBe(12);
    expect(createAppearancePic(1_000_000)).toBe(`o${(1_000_000).toString(36)}`);
    expect(createAppearancePic(6_999_999, "reference")).toBe(`r${(6_999_999).toString(36)}`);
  });

  it("rejects IDs outside local categories 1-6 and 13, and unknown source kinds", () => {
    for (const id of [0, -1, 999999, 7000000, 10000000, 12999999, 14000000, 1999100.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => createAppearancePic(id)).toThrow(/local ID/);
    }
    expect(() => createAppearancePic("1999100" as unknown as number)).toThrow(/local ID/);
    expect(() => createAppearancePic(1999100, "../reference" as "reference")).toThrow(/unknown appearance source/);
  });

  it("preserves the 13 suit prefix and fits an eight-digit ID in a 15-character segment", () => {
    for (const id of [13000000, 13999100, 13999999]) for (const kind of ["official", "reference"] as const) {
      const pic = createAppearancePic(id, kind);
      expect(String(id).startsWith("13")).toBe(true);
      expect(pic).toBe(`${kind === "reference" ? "r" : "o"}${id.toString(36)}`);
      expect(`${id}|${pic}`).toHaveLength(15);
    }
  });

  it("projects suit slot 11 into Style index 7 without overwriting the weapon or later slots", () => {
    expect(appearanceEquipSlot(13)).toBe(11);
    expect(appearanceStyleIndex(13)).toBe(7);
    const id = 13999100, pic = createAppearancePic(id, "reference");
    // Only replacing index 7 removes this overlong old suit. Replacing index 11 would fail.
    const style = Array<string>(16).fill(""); style[6] = "7001|axe"; style[7] = "x".repeat(201); style[11] = "later-part";
    expect(() => assertEquippedStyleFits(style.join(","), 11, id, pic)).not.toThrow();
    expect(style[6]).toBe("7001|axe"); expect(style[7]).toHaveLength(201); expect(style[11]).toBe("later-part");
    expect(() => assertEquippedStyleFits(style.join(","), 7, id, pic)).toThrow(/slot/);
    expect(() => assertEquippedStyleFits(style.join(","), 12, id, pic)).toThrow(/slot/);
    expect(() => assertEquippedStyleFits(style.join(","), 0, id, pic)).toThrow(/category does not match/);
    expect(() => assertEquippedStyleFits(style.join(","), 11, 1999100, "r16ul0")).toThrow(/category does not match/);
  });

  it("keeps the 200-character whole-Style boundary when a suit and all ordinary slots coexist", () => {
    const id = 13999100, pic = createAppearancePic(id), segment = `${id}|${pic}`;
    const style = Array<string>(16).fill("");
    for (let category = 1; category <= 6; category++) {
      const part = category * 1000000 + 999100;
      style[category - 1] = `${part}|${createAppearancePic(part)}`;
    }
    style[6] = "7001|axe";
    style[7] = "13100|suits0";
    const projected = [...style]; projected[7] = segment;
    style[8] = "x".repeat(200 - projected.join(",").length);
    expect(() => assertEquippedStyleFits(style.join(","), 11, id, pic)).not.toThrow();
    style[8] += "x";
    expect(() => assertEquippedStyleFits(style.join(","), 11, id, pic)).toThrow(/exceeds the legacy save field/);
  });

  it("fits the real full-equipment regression in 174 characters instead of the previous 204", () => {
    const ids = [1999102, 2999100, 3999102, 4999100, 5999108, 6999102];
    // GamePlayer.recalcStats order: 0-6, 11, 13-20. These extras are existing seed items.
    const extras = ["7001|axe", "13100|suits0", "15002|wing002", "16001|chatBall1", "17001|offhand1", "", "50101|recruit", "", "", ""];
    const previous = [...ids.map(id => `${id}|wr${id.toString(36)}18a1`), ...extras].join(",");
    const current = [...ids.map(id => `${id}|${createAppearancePic(id, "reference")}`), ...extras].join(",");
    expect(previous.length).toBe(204);
    expect(current.length).toBe(174);
    expect(() => assertEquippedStyleFits(previous, 5, ids[5]!, `wr${ids[5]!.toString(36)}18a1`)).toThrow(/exceeds the legacy save field/);
    for (let slot = 0; slot < 6; slot++) {
      expect(() => assertEquippedStyleFits(current, slot, ids[slot]!, createAppearancePic(ids[slot]!, "reference"))).not.toThrow();
    }
  });

  it("accepts exactly 200 projected characters and rejects 201 before a move", () => {
    const id = 1999102, pic = createAppearancePic(id, "reference"), segment = `${id}|${pic}`;
    const style = (length: number) => ["", "x".repeat(length - segment.length - 15), ...Array<string>(14).fill("")].join(",");
    expect(assertEquippedStyleFits(style(200), 0, id, pic)).toBeUndefined();
    expect(() => assertEquippedStyleFits(style(201), 0, id, pic)).toThrow(/exceeds the legacy save field/);
  });

  it("replaces the target slot and preserves legacy safe Pic names for resumed receipts", () => {
    const id = 1999102, existing = ["x".repeat(201), ...Array<string>(15).fill("")].join(",");
    expect(() => assertEquippedStyleFits(existing, 0, id, createAppearancePic(id))).not.toThrow();
    expect(() => assertEquippedStyleFits(Array<string>(16).fill("").join(","), 0, id, "ww_official_1234_abcd1234")).not.toThrow();
  });

  it("rejects illegal slots, mismatched categories and path or Style delimiters", () => {
    const style = Array<string>(16).fill("").join(","), id = 1999102, pic = createAppearancePic(id);
    for (const slot of [-1, 6, 31, 0.5, NaN, Infinity]) {
      expect(() => assertEquippedStyleFits(style, slot, id, pic)).toThrow(/slot must be 0-5/);
    }
    expect(() => assertEquippedStyleFits(style, 1, id, pic)).toThrow(/category does not match/);
    expect(() => assertEquippedStyleFits(style, 0, 7000000, pic)).toThrow(/local ID/);
    expect(() => assertEquippedStyleFits(null as unknown as string, 0, id, pic)).toThrow(/must be a string/);
    for (const invalid of ["", ".", "..", "../pic", "a/b", "a\\b", "a:b", "a,b", "a|b", "a\n", "a\0", "%2e%2e"]) {
      expect(() => assertEquippedStyleFits(style, 0, id, invalid)).toThrow(/safe path segment/);
    }
  });
});
