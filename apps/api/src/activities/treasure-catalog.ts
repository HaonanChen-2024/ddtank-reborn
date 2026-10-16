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
export interface TreasureBoxReward {
  TemplateId: number; IsSelect: boolean; IsBind: boolean; ItemValid: number; ItemCount: number;
  StrengthenLevel: number; AttackCompose: number; DefendCompose: number; AgilityCompose: number; LuckCompose: number; Random: number;
}
export interface TreasureTemplate {
  TemplateID: number; CategoryID: number; Pic: string | null; NeedSex: number; MaxCount: number;
  CanEquip: boolean; CanUse: boolean; Property1: number; Property2: number; Property7?: number; Property8?: number; Level?: number;
  Quality?: number; Property3?: number; Property4?: number; boxRewards?: readonly TreasureBoxReward[];
}
export const TREASURE_CAPACITY = 100;
export const TREASURE_ENTRIES: readonly TreasureEntry[] = treasureEntries;
export const TREASURE_IDS = [...new Set(treasureEntries.map(x => x.templateId))].sort((a,b) => a-b);
// The version includes the delivery policy: changing mappings/evidence needs a distinct catalog version.
// Issued prizes from these exact policies retain their unchanged display identities/counts.
export const TREASURE_PREVIOUS_POOL_VERSION = "0fef67b607c95434765a44660093ce2ec76635835f7146a971b4a81b9da0b31f";
export const TREASURE_DRILL_POOL_VERSION = "0865704466025c6222181f7bd8eff5234cdd9b30df796e1ed7df1a784b2c4e22";
export const TREASURE_STRENGTHEN_POOL_VERSION = "81fe46da0487983e3a1995945adb2a22a1591fdc31cbdf158e7a11512266941d";
export const TREASURE_COMPOSE_HONOR_POOL_VERSION = "43bc186dd4c11d8dc1b60fdf9a2f58bb5b4556c8efdb2c464da598aa66823f0c";
export const TREASURE_POOL_VERSION = createHash("sha256").update(JSON.stringify({ source: treasureCatalogSource,
  entries: treasureEntries, policy: "verified-use-routes-v5-training99", rule: "local-equal-rows-30-60-no-pity-v2" })).digest("hex");
export function isKnownTreasurePoolVersion(value: unknown): value is string {
  return value === TREASURE_POOL_VERSION || value === TREASURE_COMPOSE_HONOR_POOL_VERSION || value === TREASURE_STRENGTHEN_POOL_VERSION
    || value === TREASURE_DRILL_POOL_VERSION || value === TREASURE_PREVIOUS_POOL_VERSION;
}
export const originalTreasureCategories = () => treasureCategories.map(x => ({ ...x, entryKeys: [...x.entryKeys] }));

/** Only verified current owners are admitted. An existing template or matching icon alone is not use evidence. */
function functionReady(entry: TreasureEntry, item: TreasureTemplate): boolean {
  // Dedicated forge/box routes accept genuine templates with CanUse=false.
  if ([11560,11561,11562].includes(entry.templateId)) return item.CategoryID === 11 && item.Property1 === 10;
  if ([11901,11902,11903,11904,11905,11906].includes(entry.templateId)) return item.CategoryID === 11 && item.CanUse
    && item.Property1 === 21 && Number.isSafeInteger(item.Property2) && item.Property2 > 0;
  const training = [40001,40002,40003].indexOf(entry.templateId);
  if (training >= 0) return item.CategoryID === 20 && item.CanUse && item.Property1 === 0 && item.Property2 === [30,300,900][training];
  const drill = [11035,11036,11026,11027,11034].indexOf(entry.templateId);
  if (drill >= 0) return item.CategoryID === 11 && item.Property1 === 16 && item.Property7 === 2+drill*3 && item.Property8 === 5+drill*3;
  const stone = [11019,11021,11022,11023,11024].indexOf(entry.templateId);
  if (stone >= 0) return item.CategoryID === 11 && item.Property1 === 2 && item.Level === stone+1;
  const compose = [11030,11031,11032,11033].indexOf(entry.templateId);
  if (compose >= 0) return item.CategoryID === 11 && item.Property1 === 1 && item.Quality === 5
    && item.Property3 === compose+1 && item.Property4 === 50;
  if (entry.templateId === 11917) {
    const reward = item.boxRewards?.[0];
    return item.CategoryID === 11 && item.Property1 === 6 && item.Property4 === 2 && item.boxRewards?.length === 1 && !!reward
      && reward.TemplateId === -800 && reward.IsSelect === true && reward.IsBind === true
      && reward.ItemCount === 500 && reward.ItemValid === 0 && reward.Random === 10000
      && [reward.StrengthenLevel,reward.AttackCompose,reward.DefendCompose,reward.AgilityCompose,reward.LuckCompose].every(x => x === 0);
  }
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
