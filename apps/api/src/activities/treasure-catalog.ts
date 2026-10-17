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
  Quality?: number; Property3?: number; Property4?: number; Property5?: number; Property6?: number;
  CanStrengthen?: boolean; CanCompose?: boolean; NeedLevel?: number; Attack?: number; Defence?: number; Agility?: number; Luck?: number; SuitId?: number;
  boxRewards?: readonly TreasureBoxReward[];
  cardConfig?: TreasureCardConfig;
}
export interface TreasureCardConfig {
  cards: readonly TreasureTemplate[];
  groups: readonly object[]; buffs: readonly object[]; conditions: readonly object[]; updates: readonly object[];
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
export const TREASURE_TRAINING_POOL_VERSION = "2dfe8803e62b81696aff8ed27dfe977f16a93f574b5001c906c507e0a98b4861";
export const TREASURE_SECOND_WEAPON_POOL_VERSION = "3d5ce0281aba81b5a732b14fa2912983a7db3720ac7dcbf051ea28061f52d7f9";
export const TREASURE_NECKLACE_POOL_VERSION = "a8cd548f7462ac10441245fbaf073f6a02f62f5e072b903fc5f140ceb5eec3c3";
export const TREASURE_CARD_BOX_POOL_VERSION = "a60b589ef43fe36fea9ebb9e6187d4dffb31db7344424f67c1b86b39024990c2";
export const TREASURE_JEWELRY_POOL_VERSION = "fa8df945f65d175282a29fa13cdd97c29d870efd47ffebbd35579752a2f4de74";
export const TREASURE_POOL_VERSION = createHash("sha256").update(JSON.stringify({ source: treasureCatalogSource,
  entries: treasureEntries, policy: "verified-use-routes-v10-petfood68", rule: "local-equal-rows-30-60-no-pity-v2" })).digest("hex");
export function isKnownTreasurePoolVersion(value: unknown): value is string {
  return value === TREASURE_POOL_VERSION || value === TREASURE_JEWELRY_POOL_VERSION || value === TREASURE_CARD_BOX_POOL_VERSION || value === TREASURE_NECKLACE_POOL_VERSION || value === TREASURE_SECOND_WEAPON_POOL_VERSION || value === TREASURE_TRAINING_POOL_VERSION || value === TREASURE_COMPOSE_HONOR_POOL_VERSION || value === TREASURE_STRENGTHEN_POOL_VERSION
    || value === TREASURE_DRILL_POOL_VERSION || value === TREASURE_PREVIOUS_POOL_VERSION;
}
export const originalTreasureCategories = () => treasureCategories.map(x => ({ ...x, entryKeys: [...x.entryKeys] }));

// Exact local seed contract, reproduced by test/fixtures/treasure-cardbox.json with source hashes.
// CardDataHandler 216 uses boxes with CanUse=false; no other category-18 row is admitted.
const cardBoxes: Record<number, string> = {
  20117:"8d42c00e97b716d88f25170f7de3f962b7469d2fdb4b60d1e1f84608df01e475",
  20118:"9ca48e88fa356bc076e59c631dba1b161c700c446b85fe8b8597a10deda36aa9",
  20119:"52b497ed97fa34efe4a7e21913a771a9652bb3eadb49c2fb0a58ccc59d8d413c",
  20120:"d3568f6609a690d7381196619e1e5df555e506f5c75f65994188c784bfb66a2b",
  20135:"5624f5f41569a8286ef1b18ee0ee0d8115cb506c1599c45cb9c75eaa606e1143",
  20136:"d89d75997c98849a3e4c612cbc56475f267afaa96544829487dcdf2991a5f85c",
  20137:"0a8570b37f71a0c93bb545283a1eef1110eb13600b3ae2cfdf21c50407740831",
  20138:"e24a82ced9080b80c46a1c0a3477b1b6090b1fb97e0a2d8f1277e412ea9fae8a",
  20139:"82f32df3802dc9e3a6e0357e8fef1afe736e2a6fa59b7a5ae7a7521235af2e6d",
};
export const TREASURE_CARD_BOX_IDS = Object.keys(cardBoxes).map(Number);
export const TREASURE_CARD_IDS = TREASURE_CARD_BOX_IDS.map(id => id + 294000);
const cardGoodsFields = ["TemplateID","CategoryID","Pic","NeedSex","NeedLevel","MaxCount","CanEquip","CanUse","CanStrengthen","CanCompose",
  "Level","Quality","Attack","Defence","Agility","Luck","SuitId",...Array.from({length:8},(_,i)=>`Property${i+1}`)];
function cardRowsDigest(rows: readonly object[], fields: readonly string[]): string {
  const values = rows.map(row => fields.map(field => (row as Record<string, unknown>)[field])).sort((a,b) => {
    const left=JSON.stringify(a),right=JSON.stringify(b); return left<right?-1:left>right?1:0;
  });
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
/** Reject a substituted box before loading its dependent cards/configuration. */
export function matchesTreasureCardBox(item: TreasureTemplate): boolean {
  return !!cardBoxes[item.TemplateID] && cardRowsDigest([item],cardGoodsFields)===cardBoxes[item.TemplateID];
}
function cardBoxReady(item: TreasureTemplate): boolean {
  const c=item.cardConfig;
  return !!c && matchesTreasureCardBox(item)
    && cardRowsDigest(c.cards,cardGoodsFields)==="d2ee8d290b1bce8081f27c9919f7681c2aea6dc6a7864bccb04a7cb31b565c93"
    && cardRowsDigest(c.groups,["ID","CardID","TemplateID"])==="f6bb3332bf6f17eb56c7da9c9486d9eea395f173e37015b1b3b7b96add51873e"
    && cardRowsDigest(c.buffs,["ID","CardID","condition","PropertiesDscripID","value"])==="e70c673c88503bae2495db3744c54414106d701ab5946a40046a37af97032805"
    && cardRowsDigest(c.conditions,["Level","Exp","MinExp","MaxExp","UpdateCardCount","ResetCardCount","ResetMoney"])==="654cda3ce3b0abde10bb2d58b40ad0ea409a337e9d08a59ef9380ca96848271c"
    // Original CardMgr has 31 conditions, but these nine cards have update rows only at levels1..30.
    && cardRowsDigest(c.updates,["Id","Level","Attack","Defend","Agility","Lucky","Guard","Damage"])==="0055a9e60e350dde1ef2202d8fd5de9dcf3254ab69c62a8e5b528338e68d67ba";
}

// Original Shop_Goods combat fields match packed-fight rows. Columns: P2, metadata(P6), H(P7), each base stat, SuitId.
// A matching picture must not admit an inflated same-id private-server substitute.
const guards: Record<number, readonly [number, number, number, number, number]> = {
  // 17012's guard is supported, but its SuitId=12 skill 1010810 remains unverified.
  17006: [300,3,80,30,0], 17022: [300,2,100,30,0],
  17023: [1000,2,120,50,0], 17016: [1000,2,120,50,0],
};
// Genuine local Shop_Goods rows; columns are blood percent(P1), original metadata(P2), each base stat.
// Slot 12 and GetBaseBlood consume these exact values; conflicting/missing original IDs stay blocked.
const necklaces: Record<number, readonly [number, number, number]> = {
  14006:[18,1,0], 14007:[28,2,0], 14008:[38,3,0], 14009:[48,4,0], 14010:[58,5,0],
  14028:[63,6,20], 14038:[78,100,30], 14046:[80,0,35], 14056:[83,7,40],
};
// Genuine suitless jewelry: category, each base stat, P2 metadata and P4 metadata.
// Template Name/P1 '+5' is not an awarded item's StrengthenLevel; mail still grants level0.
const jewelry: Record<number, readonly [number,number,number,number]> = {
  8514:[8,53,146261,8414], 9523:[9,80,292523,9423],
};
/** Only verified current owners are admitted. An existing template or matching icon alone is not use evidence. */
function functionReady(entry: TreasureEntry, item: TreasureTemplate): boolean {
  // Genuine high-grade food, consumed and durably saved by PET68/4; no other pet item is admitted.
  if (entry.templateId === 334103) return item.CategoryID === 34 && item.CanUse === true && item.CanEquip === false
    && item.CanStrengthen === false && item.CanCompose === false && item.MaxCount === 9999 && item.NeedLevel === 0
    && item.Level === 2 && item.Quality === 3 && item.SuitId === 0
    && item.Property1 === 1500 && item.Property2 === 20000 && item.Property3 === 20000
    && [item.Property4,item.Property5,item.Property6,item.Property7,item.Property8,item.Attack,item.Defence,item.Agility,item.Luck].every(value => value === 0);
  if (cardBoxes[entry.templateId]) return cardBoxReady(item);
  const jewel=jewelry[entry.templateId];
  if(jewel) return item.CategoryID===jewel[0] && item.CanEquip===true && item.CanUse===true && item.CanStrengthen===false && item.CanCompose===true
    && item.MaxCount===1 && item.NeedLevel===0 && item.Level===3 && item.Quality===4 && item.SuitId===0
    && item.Property1===5 && item.Property2===jewel[2] && item.Property3===2 && item.Property4===jewel[3]
    && [item.Property5,item.Property6,item.Property7].every(value=>value===0) && item.Property8===1
    && [item.Attack,item.Defence,item.Agility,item.Luck].every(stat=>stat===jewel[1]);
  const necklace = necklaces[entry.templateId];
  if (necklace) return item.CategoryID === 14 && item.CanEquip === true && item.CanUse === true && item.CanStrengthen === false
    && item.MaxCount === 1 && item.NeedLevel === 0 && item.SuitId === 0 && item.Property1 === necklace[0] && item.Property2 === necklace[1]
    && [item.Property3,item.Property4,item.Property5,item.Property6,item.Property7].every(value => value === 0) && item.Property8 === 1
    && [item.Attack,item.Defence,item.Agility,item.Luck].every(stat => stat === necklace[2]);
  const guard = guards[entry.templateId];
  if (guard) return item.CategoryID === 17 && item.CanEquip && item.CanUse && item.CanStrengthen === true && item.MaxCount === 1 && item.NeedLevel === 1
    && item.Property1 === 0 && item.Property2 === guard[0] && item.Property3 === 31 && item.Property4 === 200
    && item.Property5 === 2 && item.Property6 === guard[1] && item.Property7 === guard[2] && item.Property8 === 500
    && [item.Attack,item.Defence,item.Agility,item.Luck].every(stat => stat === guard[3]) && item.SuitId === guard[4];
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
