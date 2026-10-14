import { describe, expect, it } from "vitest";
import { advanceWardrobe, viewWardrobe } from "../src/activities/wardrobe.js";
import { WARDROBE_SETS } from "../src/activities/wardrobe-sets.js";
import { ActivityError, type ActivityContext } from "../src/activities/types.js";

const restore = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const context = (overrides: Partial<ActivityContext> = {}): ActivityContext => ({
  now: new Date("2026-10-14T00:00:00Z"), signDays: [], ownedTemplateIds: [], wardrobeItems: [], ...overrides,
});
const stat = (view: ReturnType<typeof viewWardrobe>, label: string) => view.stats.find(item => item.label === label)?.value;

describe("reference wardrobe set collection", () => {
  it("browses all 52 real sets exactly once and opens at most eight original parts", () => {
    expect(WARDROBE_SETS).toHaveLength(52);
    expect(new Set(WARDROBE_SETS.map(set => set.id)).size).toBe(52);
    const seen: number[] = [];
    let state: unknown = undefined;
    for (;;) {
      const view = viewWardrobe(state, context());
      expect(stat(view, "真实套装")).toBe(52);
      expect(view.cells!.length).toBeLessThanOrEqual(12);
      for (const cell of view.cells!) {
        const id = Number(cell.action!.choice);
        seen.push(id);
        const original = WARDROBE_SETS.find(set => set.id === id)!;
        const detailState = advanceWardrobe(state, cell.action!);
        const detail = viewWardrobe(detailState, context());
        expect(detail.cells!.map(part => Number(part.label.replace("部件 #", "")))).toEqual([...original.parts]);
        expect(detail.cells!.length).toBeGreaterThan(0);
        expect(detail.cells!.length).toBeLessThanOrEqual(8);
        expect(new Set(original.parts).size).toBe(original.parts.length);
        const back = advanceWardrobe(detailState, detail.actions[0].action);
        expect(viewWardrobe(back, context())).toEqual(view);
      }
      const next = view.actions.find(button => button.label === "下一页")!;
      if (next.disabled) break;
      state = advanceWardrobe(state, next.action);
    }
    expect(seen).toEqual(Array.from({ length: 52 }, (_, index) => 52 - index));
  });

  it("counts only the owned required IDs once, independently of local installation", () => {
    const state = advanceWardrobe(undefined, { type: "select-set", choice: "52" });
    const ctx = context({
      ownedTemplateIds: [11000020, 11000020, 3534, 999999],
      wardrobeItems: [
        { templateId: 11000020, name: "落九乌帽", category: 1, icon: "/images/hat.png" },
        { templateId: 5941, name: "落九乌衣", category: 5 },
      ],
    });
    const view = viewWardrobe(state, ctx);
    expect(stat(view, "收集进度")).toBe("2/4");
    expect(stat(view, "本地已安装")).toBe("2/4");
    expect(view.cells).toMatchObject([
      { label: "落九乌帽", detail: "编号 11000020 · 已拥有 · 本地已安装", tone: "success", image: "/images/hat.png" },
      { label: "部件 #3534", detail: "编号 3534 · 已拥有 · 本地未安装", tone: "danger" },
      { label: "落九乌衣", detail: "编号 5941 · 未拥有 · 本地已安装", tone: "hidden" },
      { label: "部件 #6392", detail: "编号 6392 · 未拥有 · 本地未安装", tone: "danger" },
    ]);
    expect(view.cells!.every(cell => cell.action === undefined)).toBe(true);
    const allOwned = viewWardrobe(undefined, context({ ownedTemplateIds: [...WARDROBE_SETS.find(set => set.id === 52)!.parts] }));
    expect(stat(allOwned, "已集齐")).toBe(1);
  });

  it("keeps the installed parts catalog secondary and its owned filter as an intersection", () => {
    const ctx = context({
      ownedTemplateIds: [17, 9999],
      wardrobeItems: Array.from({ length: 25 }, (_, index) => ({ templateId: index + 1, name: `衣服${index + 1}`, category: 5 })),
    });
    const directory = viewWardrobe(undefined, ctx);
    expect(directory.cells![0].action).toEqual({ type: "select-set", choice: "52" });
    let state = advanceWardrobe(undefined, directory.actions.find(button => button.label === "全部本地服饰")!.action);
    expect(stat(viewWardrobe(state, ctx), "部件数量")).toBe(25);
    state = advanceWardrobe(state, { type: "page", index: 2, choice: "catalog" });
    expect(viewWardrobe(state, ctx).cells).toHaveLength(1);
    state = advanceWardrobe(state, { type: "page", index: 10000, choice: "owned" });
    const owned = viewWardrobe(state, ctx);
    expect(stat(owned, "部件数量")).toBe(1);
    expect(stat(owned, "页码")).toBe("1/1");
    expect(owned.cells![0].label).toBe("衣服17");
    expect(stat(viewWardrobe(state, context()), "页码")).toBe("1/1");
    expect(viewWardrobe(state, context()).cells).toEqual([]);
    expect(viewWardrobe(advanceWardrobe(state, { type: "directory" }), ctx)).toEqual(directory);
  });

  it("rejects unknown set IDs, reward actions and invalid pagination", () => {
    for (const choice of ["0", "53", "01", "1.0", "NaN", "__proto__", "", undefined]) {
      expect(() => advanceWardrobe(undefined, { type: "select-set", choice })).toThrow(ActivityError);
    }
    for (const type of ["claim", "activate", "draw", "equip", "unexpected"]) {
      expect(() => advanceWardrobe(undefined, { type })).toThrow(ActivityError);
    }
    for (const index of [-1, 0.5, NaN, Infinity, 10001, undefined]) {
      expect(() => advanceWardrobe(undefined, { type: "page", index, choice: "catalog" })).toThrow(ActivityError);
    }
    expect(() => advanceWardrobe(undefined, { type: "page", index: 5, choice: "sets" })).toThrow(ActivityError);
    expect(() => advanceWardrobe(undefined, { type: "page", index: 0, choice: "other" })).toThrow(ActivityError);
  });

  it("normalizes old browse state, rejects malformed state and never leaks internal data", () => {
    expect(viewWardrobe({ page: 100, owned: true }, context())).toEqual(viewWardrobe(undefined, context()));
    for (const state of [null, [], 1, {}, { version: 2 },
      { version: 1, kind: "wardrobe", mode: "set", page: 0, setId: 53 },
      { version: 1, kind: "wardrobe", mode: "sets", page: 5 },
      { version: 1, kind: "wardrobe", mode: "sets", page: 0, setId: 1 },
    ]) {
      expect(() => viewWardrobe(state, context())).toThrow(ActivityError);
      expect(() => advanceWardrobe(state, { type: "directory" })).toThrow(ActivityError);
    }
    const state = freeze({ version: 1, kind: "wardrobe", mode: "sets", page: 0, secret: "PRIVATE_STATE" });
    const ctx = freeze(context({
      ownedTemplateIds: [9999],
      wardrobeItems: [{ templateId: 9999, name: "普通服饰", category: 5, secret: "PRIVATE_TEMPLATE" } as NonNullable<ActivityContext["wardrobeItems"]>[number]],
    }));
    const before = restore(state);
    const next = advanceWardrobe(state, { type: "select-set", choice: "18" });
    expect(restore(next)).toEqual(next);
    expect(viewWardrobe(restore(next), ctx)).toEqual(viewWardrobe(next, ctx));
    expect(state).toEqual(before);
    expect(JSON.stringify(next)).not.toContain("PRIVATE");
    const catalog = advanceWardrobe(next, { type: "page", index: 0, choice: "catalog" });
    const view = viewWardrobe(catalog, ctx);
    expect(restore(view)).toEqual(view);
    expect(Object.keys(view).sort()).toEqual(["actions", "cells", "columns", "rules", "stats"]);
    expect(JSON.stringify(view)).not.toContain("PRIVATE");
    expect(JSON.stringify(view)).not.toContain("ownedTemplateIds");
  });
});
