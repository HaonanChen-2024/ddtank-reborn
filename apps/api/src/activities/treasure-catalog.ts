import { createHash } from "node:crypto";
import { treasureCatalogSource, treasureCategories, treasureEntries } from "./treasure-catalog-data.js";

export interface TreasureEntry {
  entryKey: string; sourceRow: number; sourceId: number; sourceOriginalIndex: number; sourceTemplateId: number;
  templateId: number; count: number; name: string; categoryId: number; pic: string; needSex: number;
}
export interface TreasurePreview extends TreasureEntry { status: "ready" | "blocked"; reasons: string[] }
export interface TreasureReadiness {
  status: "ready" | "blocked"; totalRows: 158; readyRows: number;
  blocked: { entryKey: string; reasons: string[] }[]; description: string;
}
export interface TreasureCatalog { poolVersion: string; readiness: TreasureReadiness; preview: TreasurePreview[] }
export interface TreasureTemplate {
  TemplateID: number; CategoryID: number; Pic: string | null; NeedSex: number; MaxCount: number;
  CanEquip: boolean; CanUse: boolean; Property1: number; Property2: number;
}
export const TREASURE_CAPACITY = 100;
export const TREASURE_ENTRIES: readonly TreasureEntry[] = treasureEntries;
export const TREASURE_IDS = [...new Set(treasureEntries.map(x => x.templateId))].sort((a,b) => a-b);
// The version includes the delivery policy: changing mappings/evidence needs a distinct catalog version.
export const TREASURE_POOL_VERSION = createHash("sha256").update(JSON.stringify({ source: treasureCatalogSource,
  entries: treasureEntries, policy: "verified-use-routes-v1", rule: "local-equal-rows-30-60-no-pity-v2" })).digest("hex");
export const originalTreasureCategories = () => treasureCategories.map(x => ({ ...x, entryKeys: [...x.entryKeys] }));

/** Only verified current owners are admitted. An existing template or matching icon alone is not use evidence. */
function functionReady(entry: TreasureEntry, item: TreasureTemplate): boolean {
  if ([11560,11561,11562].includes(entry.templateId)) return item.CategoryID === 11 && item.CanUse && item.Property1 === 10;
  if ([11901,11902,11903,11904,11906].includes(entry.templateId)) return item.CategoryID === 11 && item.CanUse && item.Property1 === 21 && item.Property2 > 0;
  return false;
}
/** A projection of actual local templates; reference statistics never enter this module or Shop_Goods. */
export function inspectTreasureCatalog(items: readonly TreasureTemplate[] = [], iconReady: (entry: TreasureEntry) => boolean = () => false): TreasureCatalog {
  const byId = new Map(items.map(x => [x.TemplateID,x]));
  const preview: TreasurePreview[] = TREASURE_ENTRIES.map(entry => {
    const item = byId.get(entry.templateId), reasons: string[] = [];
    if (!item) reasons.push("缺少本地模板");
    else {
      if (item.CategoryID !== entry.categoryId || item.NeedSex !== entry.needSex || item.Pic?.trim().toLowerCase() !== entry.pic.trim().toLowerCase()) reasons.push("同号显示身份冲突");
      if (!Number.isSafeInteger(item.MaxCount) || item.MaxCount < 1) reasons.push("堆叠配置无效");
      if (item.CategoryID === 7) reasons.push("官方武器属性与完整特效尚未通过交付核验");
      else if (!functionReady(entry,item)) reasons.push(item.CanEquip ? "装备属性或技能尚未核验" : "实际用途尚未核验");
    }
    if (!iconReady(entry)) reasons.push("本地图标尚未就绪");
    return { ...entry, status: reasons.length ? "blocked" : "ready", reasons };
  });
  const blocked = preview.filter(x => x.status === "blocked").map(x => ({ entryKey:x.entryKey,reasons:[...x.reasons] }));
  return { poolVersion:TREASURE_POOL_VERSION, preview, readiness:{ status:blocked.length ? "blocked" : "ready", totalRows:158,
    readyRows:158-blocked.length,blocked,description:blocked.length ? `完整奖池尚有${blocked.length}条未就绪；可查看全部分类和奖品，暂不消耗积分抽取。` : "完整奖池已就绪。" } };
}

/** Internal context must describe this complete catalog, never a ready subset supplied by an action. */
export function completeTreasureCatalog(value?: TreasureCatalog): TreasureCatalog {
  if (!value) return inspectTreasureCatalog();
  if (value.poolVersion !== TREASURE_POOL_VERSION || value.preview.length !== 158 || value.readiness.totalRows !== 158
    || value.preview.some((x,i) => JSON.stringify(Object.fromEntries(Object.keys(TREASURE_ENTRIES[i]).map(k => [k,x[k as keyof TreasureEntry]]))) !== JSON.stringify(TREASURE_ENTRIES[i]))
    || value.readiness.readyRows !== value.preview.filter(x => x.status === "ready").length
    || value.readiness.blocked.length !== 158-value.readiness.readyRows
    || (value.readiness.status === "ready") !== (value.readiness.readyRows === 158)
    || value.preview.some(x => !["ready","blocked"].includes(x.status) || !Array.isArray(x.reasons)
      || x.reasons.some(reason => typeof reason !== "string" || !reason.trim()) || (x.status === "ready") !== (x.reasons.length === 0))
    || JSON.stringify(value.readiness.blocked) !== JSON.stringify(value.preview.filter(x => x.status === "blocked")
      .map(x => ({entryKey:x.entryKey,reasons:[...x.reasons]})))) throw new Error("Invalid internal complete treasure catalog");
  return value;
}
