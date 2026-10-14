import { ActivityError, type ActivityAction, type ActivityContext, type ActivityView } from "./types.js";
import { WARDROBE_SETS } from "./wardrobe-sets.js";

type WardrobeView = Pick<ActivityView, "rules" | "stats" | "cells" | "columns" | "actions">;
type WardrobeState = {
  version: 1;
  kind: "wardrobe";
  mode: "sets" | "set" | "catalog" | "owned";
  page: number;
  setId?: number;
};
const PAGE_SIZE = 12;
const SETS = [...WARDROBE_SETS].sort((a, b) => b.id - a.id);
const SET_IDS = new Set<number>(SETS.map(set => set.id));
const PART_IDS = new Set<number>(SETS.flatMap(set => [...set.parts]));
const LAST_SET_PAGE = Math.ceil(SETS.length / PAGE_SIZE) - 1;
const initial = (): WardrobeState => ({ version: 1, kind: "wardrobe", mode: "sets", page: 0 });
const pageNumber = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10000;

function readState(raw: unknown): WardrobeState {
  if (raw === undefined) return initial();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ActivityError("衣橱浏览状态无效");
  const value = raw as Record<string, unknown>;
  // The former parts-only catalog had no version. Reopen it at the real set directory.
  if (Object.keys(value).length === 2 && pageNumber(value.page) && typeof value.owned === "boolean") return initial();
  if (value.version !== 1 || value.kind !== "wardrobe" || !pageNumber(value.page)
    || !["sets", "set", "catalog", "owned"].includes(value.mode as string)) throw new ActivityError("衣橱浏览状态无效");
  const mode = value.mode as WardrobeState["mode"];
  if ((mode === "sets" || mode === "set") && value.page > LAST_SET_PAGE) throw new ActivityError("衣橱目录页码无效");
  if (mode === "set") {
    if (typeof value.setId !== "number" || !SET_IDS.has(value.setId)) throw new ActivityError("套装不存在");
    return { version: 1, kind: "wardrobe", mode, page: value.page, setId: value.setId };
  }
  if (value.setId !== undefined) throw new ActivityError("衣橱浏览状态无效");
  return { version: 1, kind: "wardrobe", mode, page: value.page };
}

export function advanceWardrobe(state: unknown, action: ActivityAction): unknown {
  const current = readState(state);
  if (action.type === "select-set") {
    const set = SETS.find(item => String(item.id) === action.choice);
    if (!set) throw new ActivityError("套装不存在");
    return { version: 1, kind: "wardrobe", mode: "set", page: Math.floor(SETS.indexOf(set) / PAGE_SIZE), setId: set.id } satisfies WardrobeState;
  }
  if (action.type === "directory") return { ...initial(), page: current.mode === "set" || current.mode === "sets" ? current.page : 0 };
  if (action.type === "page" && pageNumber(action.index) && ["sets", "catalog", "owned"].includes(action.choice ?? "")) {
    if (action.choice === "sets" && action.index > LAST_SET_PAGE) throw new ActivityError("衣橱目录页码无效");
    return { version: 1, kind: "wardrobe", mode: action.choice, page: action.index };
  }
  throw new ActivityError("请选择有效套装或目录页码");
}

export function viewWardrobe(state: unknown, ctx: ActivityContext): WardrobeView {
  const current = readState(state);
  const owned = new Set(ctx.ownedTemplateIds);
  const installed = new Map((ctx.wardrobeItems ?? []).map(item => [item.templateId, item]));
  const ownedCount = (parts: readonly number[]) => parts.filter(id => owned.has(id)).length;
  const rules = [
    "按参考服公开衣橱配置展示 52 套服饰；点击套装查看所需部件。",
    "收集进度按角色实际持有的部件计算，已安装资源不代表已经拥有。",
    "此处浏览服饰与收集进度，不消耗积分，也不改变装备属性。",
  ];
  const partCell = (id: number) => {
    const item = installed.get(id);
    return {
      label: item?.name ?? `部件 #${id}`,
      detail: `编号 ${id} · ${owned.has(id) ? "已拥有" : "未拥有"} · ${item ? "本地已安装" : "本地未安装"}`,
      tone: !item ? "danger" as const : owned.has(id) ? "success" as const : "hidden" as const,
      ...(item?.icon ? { image: item.icon } : {}),
    };
  };
  if (current.mode === "set") {
    const set = SETS.find(item => item.id === current.setId)!;
    return {
      rules,
      stats: [
        { label: "当前套装", value: `${set.name}（${set.sex === 1 ? "男" : "女"}）` },
        { label: "收集进度", value: `${ownedCount(set.parts)}/${set.parts.length}` },
        { label: "本地已安装", value: `${set.parts.filter(id => installed.has(id)).length}/${set.parts.length}` },
      ],
      columns: 4,
      cells: set.parts.map(partCell),
      actions: [{ label: "返回套装目录", action: { type: "directory" } }],
    };
  }
  const isSets = current.mode === "sets";
  const items = [...installed.values()].filter(item => current.mode !== "owned" || owned.has(item.templateId)).sort((a, b) => a.templateId - b.templateId);
  const count = isSets ? SETS.length : items.length;
  const lastPage = Math.max(0, Math.ceil(count / PAGE_SIZE) - 1);
  const page = Math.min(current.page, lastPage);
  const stats: WardrobeView["stats"] = isSets ? [
    { label: "真实套装", value: SETS.length },
    { label: "已集齐", value: SETS.filter(set => ownedCount(set.parts) === set.parts.length).length },
    { label: "已拥有套装部件", value: `${[...PART_IDS].filter(id => owned.has(id)).length}/${PART_IDS.size}` },
  ] : [
    { label: "服饰部件目录", value: current.mode === "owned" ? "已拥有且已安装" : "全部本地服饰" },
    { label: "部件数量", value: count },
  ];
  return {
    rules: isSets ? rules : [...rules, "本页是独立的本地服饰部件目录，部件数量不代表套装数量。"],
    stats: [...stats, { label: "页码", value: `${page + 1}/${lastPage + 1}` }],
    columns: 4,
    cells: isSets ? SETS.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(set => {
      const held = ownedCount(set.parts);
      return {
        label: `${set.name}（${set.sex === 1 ? "男" : "女"}）`,
        detail: `已拥有 ${held}/${set.parts.length} 件 · 本地已安装 ${set.parts.filter(id => installed.has(id)).length}/${set.parts.length} 件`,
        tone: held === set.parts.length ? "success" as const : "gold" as const,
        action: { type: "select-set", choice: String(set.id) },
      };
    }) : items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(item => partCell(item.templateId)),
    actions: [
      { label: "套装目录", action: { type: "page", index: 0, choice: "sets" }, disabled: isSets && page === 0 },
      { label: "全部本地服饰", action: { type: "page", index: 0, choice: "catalog" }, disabled: current.mode === "catalog" && page === 0 },
      { label: "已拥有本地服饰", action: { type: "page", index: 0, choice: "owned" }, disabled: current.mode === "owned" && page === 0 },
      { label: "上一页", action: { type: "page", index: Math.max(0, page - 1), choice: current.mode }, disabled: page === 0 },
      { label: "下一页", action: { type: "page", index: Math.min(lastPage, page + 1), choice: current.mode }, disabled: page === lastPage },
    ],
  };
}
