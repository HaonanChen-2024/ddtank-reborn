import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { advanceTreasure, prepareTreasureTicketPurchase, readTreasureState, viewTreasureNative } from "../src/activities/treasure-native.js";
import { completeTreasureCatalog, inspectTreasureCatalog, isKnownTreasurePoolVersion, TREASURE_ENTRIES, TREASURE_IDS, TREASURE_POOL_VERSION, TREASURE_PREVIOUS_POOL_VERSION, TREASURE_DRILL_POOL_VERSION, TREASURE_STRENGTHEN_POOL_VERSION, TREASURE_COMPOSE_HONOR_POOL_VERSION, TREASURE_TRAINING_POOL_VERSION, type TreasureCatalog, type TreasureTemplate } from "../src/activities/treasure-catalog.js";
import { treasureCatalogSource, treasureEntries } from "../src/activities/treasure-catalog-data.js";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityState } from "../src/activities/types.js";

const clock: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), signDays: [], ownedTemplateIds: [] };
const wallet = { points: 2000, earned: 40, revision: 0 };
const noRandom = () => { throw new Error("Unexpected RNG"); };
const useFixture = JSON.parse(readFileSync(new URL("./fixtures/treasure-compose-honor.json", import.meta.url), "utf8"));
const trainingFixture = JSON.parse(readFileSync(new URL("./fixtures/treasure-training.json", import.meta.url), "utf8"));
const guardFixture = JSON.parse(readFileSync(new URL("./fixtures/treasure-second-weapon.json", import.meta.url), "utf8"));
// Synthetic internal use evidence for pure transitions, never a production readiness override.
const readyCatalog = (): TreasureCatalog => ({ poolVersion: TREASURE_POOL_VERSION,
  preview: TREASURE_ENTRIES.map(x => ({ ...x, status: "ready", reasons: [] })),
  readiness: { status: "ready", totalRows: 158, readyRows: 158, blocked: [], description: "Synthetic complete test catalog" } });
const ctx = (): ActivityContext => ({ ...clock, treasureCatalog: readyCatalog() });
const old = () => ({ bag: [{ templateId: 11019, count: 2 }, { templateId: 11021, count: 4 }], draws: 10, score: 20,
  fragments: 10, pity: 8, choices: ["强化石1级"], claimed: [1] });
const token = (value: unknown, context: ActivityContext = ctx()) => viewTreasureNative(value, context, wallet).bagToken;
function session(value?: unknown, context = ctx()) {
  let state = createActivityState(context.now), funds = { ...wallet };
  if (value !== undefined) state.games.treasure = value;
  const view = () => viewActivities(state, funds, context).nativeTreasure;
  return { get state() { return state; }, get wallet() { return funds; }, view,
    act(action: ActivityAction, id = "treasure-native", rng: () => number = noRandom) {
      const result = transitionActivity(state, id, action, context, funds, rng);
      state = JSON.parse(JSON.stringify(result.state)) as ActivityState;
      funds = { ...funds, points: funds.points + result.pointsDelta, earned: funds.earned + result.earnedDelta, revision: funds.revision + 1 };
      return result;
    }, draw(count = 1, mode: "normal" | "advanced" = "normal", rng = () => 0, selection = mode === "advanced" ? [4, 1, 12, 7] : []) {
      return this.act({ type: "draw", mode, count, selection, poolVersion: view().poolVersion, choice: view().bagToken }, "treasure-native", rng);
    } };
}
const advance = (value: unknown, action: ActivityAction, context = ctx(), funds = wallet) =>
  advanceTreasure(value, { ...action, choice: token(value, context) }, context, funds, noRandom, true);

// Both the runtime-data generator and tests use the exact pinned original ordering, never inferred template/category IDs.
describe("complete original treasure catalog", () => {
  it("retains 158 original rows, 157 templates, all 15 categories and both 11905 quantities", () => {
    const view = viewTreasureNative(undefined, clock, wallet);
    expect(view).toMatchObject({ version: 2, bagCapacity: 100, canDraw: false, readiness: { status: "blocked", totalRows: 158, readyRows: 0 } });
    expect(view.preview).toHaveLength(158); expect(TREASURE_IDS).toHaveLength(157);
    expect(view.categories.map(x => x.entryKeys.length)).toEqual([12,12,12,12,12,9,10,12,5,8,12,6,12,12,12]);
    expect(view.categories.map(x => x.sourceOriginalIndex)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(view.categories.filter(x => x.selectable)).toHaveLength(14); expect(view.categories[14]).toMatchObject({ special: true, selectable: false });
    expect(view.preview.filter(x => x.templateId === 11905).map(x => [x.sourceOriginalIndex, x.count])).toEqual([[7,10],[12,5]]);
    expect(new Set(view.preview.map(x => x.entryKey)).size).toBe(158); expect(view).not.toHaveProperty("previewTemplateIds");
    if (process.env.TREASURE_V2_SNAPSHOT_OUT) writeFileSync(process.env.TREASURE_V2_SNAPSHOT_OUT, JSON.stringify(view, null, 2));
  });
  it("requires actual matching identity, function and local icon without assuming weapons or equipment work", () => {
    const templates: TreasureTemplate[] = TREASURE_ENTRIES.map(x => ({ TemplateID: x.templateId, CategoryID: x.categoryId,
      Pic: x.pic, NeedSex: x.needSex, MaxCount: 99, CanEquip: x.categoryId === 7, CanUse: true,
      Property1: [11560,11561,11562].includes(x.templateId) ? 10 : 21, Property2: 1000 }));
    const actual = inspectTreasureCatalog(templates, () => true);
    expect(actual.readiness.status).toBe("blocked"); expect(actual.readiness.readyRows).toBeGreaterThan(0);
    expect(actual.preview.filter(x => x.status === "ready").every(x => [11560,11561,11562,11901,11902,11903,11904,11905,11906].includes(x.templateId))).toBe(true);
    expect(actual.preview.find(x => x.categoryId === 7)!.reasons.join()).toContain("官方武器");
    const candidate = templates.find(x => x.TemplateID === 11904)!; candidate.Pic = "wrong";
    expect(inspectTreasureCatalog(templates, () => false).preview.find(x => x.templateId === 11904)!.reasons).toEqual(expect.arrayContaining(["同号显示身份冲突", "本地图标尚未就绪"]));
  });
  it("refuses ready subsets, forged display identity and inconsistent blocked details", () => {
    const good = readyCatalog(); expect(completeTreasureCatalog(good)).toBe(good);
    const partial = inspectTreasureCatalog(); partial.preview[0].status = "ready"; partial.preview[0].reasons = [];
    expect(() => completeTreasureCatalog(partial)).toThrow(/complete treasure catalog/);
    const badRow = readyCatalog(); badRow.preview[0].count++;
    expect(() => completeTreasureCatalog(badRow)).toThrow(/complete treasure catalog/);
    const wrongBlock = inspectTreasureCatalog(); wrongBlock.readiness.blocked[0].entryKey = wrongBlock.readiness.blocked[1].entryKey;
    expect(() => completeTreasureCatalog(wrongBlock)).toThrow(/complete treasure catalog/);
  });
  it("admits only thirty-two original rows with verified original owners from genuine seed templates", () => {
    const seed = JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/db/seed/game/Shop_Goods.json.gz", import.meta.url))).toString("utf8")) as TreasureTemplate[];
    seed.find(item => item.TemplateID === 11917)!.boxRewards = useFixture.boxes;
    const catalog = inspectTreasureCatalog(seed, () => true);
    const expected = [11019,11021,11022,11023,11024,11026,11027,11030,11031,11032,11033,11034,11035,11036,11560,11561,11562,11901,11902,11903,11904,11905,11905,11906,11917,17006,17016,17022,17023,40001,40002,40003];
    expect(catalog.preview.filter(x => x.status === "ready").map(x => x.templateId).sort((a,b) => a-b)).toEqual(expected);
    expect(catalog.readiness).toMatchObject({ status: "blocked", readyRows: 32 });
    expect(seed.filter(x => [11026,11027,11034,11035,11036,11560,11561,11562].includes(x.TemplateID)).every(x => !x.CanUse)).toBe(true);
    expect(catalog.preview.filter(x => x.templateId === 11905).map(x => x.count)).toEqual([10,5]);
    expect(inspectTreasureCatalog(seed, () => false).readiness.readyRows).toBe(0);
    const previous = createHash("sha256").update(JSON.stringify({ source:treasureCatalogSource,entries:treasureEntries,
      policy:"verified-use-routes-v1",rule:"local-equal-rows-30-60-no-pity-v2" })).digest("hex");
    expect(TREASURE_PREVIOUS_POOL_VERSION).toBe(previous); expect(TREASURE_POOL_VERSION).not.toBe(previous);
    const drillPolicy = createHash("sha256").update(JSON.stringify({ source:treasureCatalogSource,entries:treasureEntries,
      policy:"verified-use-routes-v2-drill217",rule:"local-equal-rows-30-60-no-pity-v2" })).digest("hex");
    expect(TREASURE_DRILL_POOL_VERSION).toBe(drillPolicy); expect(TREASURE_POOL_VERSION).not.toBe(drillPolicy);
    const strengthenPolicy = createHash("sha256").update(JSON.stringify({ source:treasureCatalogSource,entries:treasureEntries,
      policy:"verified-use-routes-v3-strengthen59",rule:"local-equal-rows-30-60-no-pity-v2" })).digest("hex");
    expect(TREASURE_STRENGTHEN_POOL_VERSION).toBe(strengthenPolicy); expect(TREASURE_POOL_VERSION).not.toBe(strengthenPolicy);
    const composeHonorPolicy = createHash("sha256").update(JSON.stringify({ source:treasureCatalogSource,entries:treasureEntries,
      policy:"verified-use-routes-v4-compose58-box63",rule:"local-equal-rows-30-60-no-pity-v2" })).digest("hex");
    expect(TREASURE_COMPOSE_HONOR_POOL_VERSION).toBe(composeHonorPolicy); expect(TREASURE_POOL_VERSION).not.toBe(composeHonorPolicy);
    const trainingPolicy = createHash("sha256").update(JSON.stringify({ source:treasureCatalogSource,entries:treasureEntries,
      policy:"verified-use-routes-v5-training99",rule:"local-equal-rows-30-60-no-pity-v2" })).digest("hex");
    expect(TREASURE_TRAINING_POOL_VERSION).toBe(trainingPolicy); expect(TREASURE_POOL_VERSION).not.toBe(trainingPolicy);
    for (const version of [previous,drillPolicy,strengthenPolicy,composeHonorPolicy,trainingPolicy,TREASURE_POOL_VERSION]) expect(isKnownTreasurePoolVersion(version)).toBe(true);
    for (const version of [undefined,null,3,"", "a".repeat(64),`${drillPolicy} `]) expect(isKnownTreasurePoolVersion(version)).toBe(false);
  });
  it("requires genuine training potion identities, category and exact experience amounts", () => {
    const templates = trainingFixture.goods as TreasureTemplate[];
    expect(inspectTreasureCatalog(templates, () => true).preview.filter(row => row.status === "ready")
      .map(row => [row.templateId,row.count])).toEqual([[40001,10],[40002,10],[40003,10]]);
    for (const item of templates) for (const patch of [{CategoryID:11},{Property1:21},{Property2:item.Property2+1},
      {CanUse:false},{Pic:"wrong"},{NeedSex:1},{MaxCount:0}]) {
      const changed = templates.map(row => row.TemplateID === item.TemplateID ? {...row,...patch} : row);
      expect(inspectTreasureCatalog(changed, () => true).preview.find(row => row.templateId === item.TemplateID)?.status).toBe("blocked");
    }
    expect(inspectTreasureCatalog(templates, () => false).readiness.readyRows).toBe(0);
  });
  it("admits four genuine shields, preserves the unresolved suit shield and rejects altered stats or combat fields", () => {
    const templates = guardFixture.goods as TreasureTemplate[];
    expect(inspectTreasureCatalog(templates, () => true).preview.filter(row => row.status === "ready")
      .map(row => [row.templateId,row.count])).toEqual([17006,17022,17023,17016].map(id => [id,1]));
    expect(inspectTreasureCatalog(templates, () => true).preview.find(row => row.templateId === 17012))
      .toMatchObject({status:"blocked",reasons:expect.arrayContaining(["装备属性或技能尚未核验"])});
    const changes = [{CategoryID:7},{CanEquip:false},{CanUse:false},{CanStrengthen:false},{MaxCount:2},{NeedLevel:99},
      {Property1:1},{Property2:-1},{Property3:32},{Property4:0},{Property5:0},{Property6:9},{Property7:9999},{Property8:0},
      {Attack:9999},{Defence:9999},{Agility:9999},{Luck:9999},{SuitId:-1},{Pic:"wrong"},{NeedSex:1}];
    for (const item of templates) for (const patch of changes) {
      const changed = templates.map(row => row.TemplateID === item.TemplateID ? {...row,...patch} : row);
      expect(inspectTreasureCatalog(changed, () => true).preview.find(row => row.templateId === item.TemplateID)?.status).toBe("blocked");
    }
    expect(inspectTreasureCatalog(templates, () => false).readiness.readyRows).toBe(0);
  });
  it("does not admit altered drill experience ranges, missing properties or forged dedicated owners", () => {
    const row = TREASURE_ENTRIES.find(x => x.templateId === 11034)!;
    const drill: TreasureTemplate = { TemplateID:11034,CategoryID:11,Pic:row.pic,NeedSex:row.needSex,MaxCount:99,
      CanEquip:false,CanUse:false,Property1:16,Property2:0,Property7:14,Property8:17 };
    expect(inspectTreasureCatalog([drill], () => true).preview.find(x => x.templateId === 11034)!.status).toBe("ready");
    for (const patch of [{Property1:21},{Property7:undefined},{Property8:undefined},{Property7:15},{Property8:18},{Property7:NaN},{CategoryID:7},{Pic:"wrong"},{MaxCount:0}]) {
      expect(inspectTreasureCatalog([{...drill,...patch}], () => true).preview.find(x => x.templateId === 11034)!.status).toBe("blocked");
    }
  });
  it("admits five strengthen stones only with the exact level consumed by owner 59, never an inferred picture level", () => {
    for (const [i,id] of [11019,11021,11022,11023,11024].entries()) {
      const row = TREASURE_ENTRIES.find(x => x.templateId === id)!;
      const stone: TreasureTemplate = {TemplateID:id,CategoryID:11,Pic:row.pic,NeedSex:row.needSex,MaxCount:9999,
        CanEquip:false,CanUse:false,Property1:2,Property2:0,Level:i+1};
      expect(inspectTreasureCatalog([stone],()=>true).preview.find(x=>x.templateId===id)!.status).toBe("ready");
      for (const patch of [{Level:undefined},{Level:0},{Level:i+2},{Level:NaN},{Property1:1},{Property1:35},{CategoryID:7},{Pic:"wrong"},{MaxCount:0}]) {
        expect(inspectTreasureCatalog([{...stone,...patch}],()=>true).preview.find(x=>x.templateId===id)!.status).toBe("blocked");
      }
      expect(inspectTreasureCatalog([stone],()=>false).preview.find(x=>x.templateId===id)!.status).toBe("blocked");
    }
  });
  it("requires the four actual compose attributes and Quality, and the full deterministic honor recipe", () => {
    for (const item of useFixture.goods as TreasureTemplate[]) {
      const value = { ...item, ...(item.TemplateID === 11917 ? { boxRewards: useFixture.boxes } : {}) };
      const status = (patch: Partial<TreasureTemplate>, icons = true) => inspectTreasureCatalog([{...value,...patch}],()=>icons)
        .preview.find(row => row.templateId === item.TemplateID)!.status;
      expect(status({})).toBe("ready"); expect(status({},false)).toBe("blocked");
      const patches: Partial<TreasureTemplate>[] = item.TemplateID === 11917
        ? [{Property1:1},{Property4:0},{boxRewards:undefined},{boxRewards:[]},{boxRewards:[...useFixture.boxes,...useFixture.boxes]},
          ...[{TemplateId:-200},{IsSelect:false},{IsBind:false},{ItemCount:501},{ItemValid:1},{Random:1},{AttackCompose:1}]
            .map(patch => ({boxRewards: [{...useFixture.boxes[0],...patch}]}))]
        : [{Property1:2},{Quality:undefined},{Quality:4},{Property3:undefined},{Property3:item.Property3!+1},
          {Property4:undefined},{Property4:49}];
      for (const patch of [...patches,{CategoryID:7},{Pic:"wrong"},{MaxCount:0}]) expect(status(patch)).toBe("blocked");
    }
  });
});

describe("original v2 treasure transitions and legacy entitlements", () => {
  it("reads old state without writing, retains counters/choices/pity and exposes only public origins", () => {
    const saved = old(), before = structuredClone(saved), view = viewTreasureNative(saved, clock, wallet, true,
      ["2026-10-15T12:00:00Z 原生迷宫寻宝：完成1次", "2026-10-15T11:00:00Z 月光宝盒：完成1次"]);
    expect(saved).toEqual(before); expect(view).toMatchObject({ started: true, bagSlotsUsed: 2, draws: 10, progressScore: 20, fragments: 10, pityRemaining: 2, canTake: true, canRecycle: true });
    expect(view.bag.every(x => x.origin === "legacy-four-material" && x.recycleUnitPoints === 2)).toBe(true); expect(view.records).toHaveLength(1);
    expect(view.bagToken).toMatch(/^2026-10-15:[A-Za-z0-9_-]{43}$/);
    expect(token(saved, { ...clock, now: new Date("2026-10-16T00:00:00Z") })).not.toBe(view.bagToken);
    expect(readTreasureState(saved)).toMatchObject({ version: 2, pity: 8, choices: saved.choices });
    expect(JSON.stringify(view)).not.toMatch(/"(?:state|games|seed|effects|choices)"\s*:/);
  });
  it("blocks all new draws on an incomplete pool, including selected-ready advanced categories and old web calls", () => {
    const run = session(undefined, clock), before = structuredClone(run.state);
    expect(run.view().drawChoices.every(x => !x.canDraw)).toBe(true);
    expect(() => run.draw(1, "advanced", noRandom)).toThrow(/完整奖池/); expect(run.state).toEqual(before);
    expect(() => run.act({ type: "draw", count: 1 }, "treasure", noRandom)).toThrow(ActivityError);
    expect(() => run.act({ type: "category", choice: "强化石1级" }, "treasure")).toThrow(/14选4/);
    expect(() => run.act({ type: "choose", index: 0, marked: true, choice: run.view().bagToken })).toThrow(ActivityError);
    const web = viewActivities(run.state, wallet, clock).activities.find(x => x.id === "treasure")!;
    expect(web.actions.filter(x => x.action.type === "draw").every(x => x.disabled)).toBe(true);
    expect(web.rules.join()).not.toContain("55%");
  });
  it("normal draws use original row counts without advanced doubling or the legacy four-material guarantee", () => {
    const run = session(old()), before = old();
    run.draw(5, "normal", () => 0); run.draw(5, "advanced", () => 0.999999);
    expect(run.wallet.points).toBe(1550); expect(readTreasureState(run.state.games.treasure)).toMatchObject({ draws: 20, score: 35, fragments: 20, pity: before.pity, choices: before.choices });
    expect(run.view().bag[2]).toMatchObject({ templateId: TREASURE_ENTRIES[0].templateId, itemCount: TREASURE_ENTRIES[0].count, sourceOriginalIndex: 1 });
    const last = TREASURE_ENTRIES.at(-1)!;
    expect(run.view().bag.at(-1)).toMatchObject({ templateId: last.templateId, itemCount: last.count, sourceOriginalIndex: 15 });
    expect(run.view().bag.slice(2).every(x => x.origin === "original-catalog" && x.recycleUnitPoints === null && x.poolVersion === TREASURE_POOL_VERSION)).toBe(true);
  });
  it("uses the submitted four categories plus 15, keeps selection order and distinguishes repeated template source rows", () => {
    for (const sourceOriginalIndex of [7,12]) {
      const selection = sourceOriginalIndex === 7 ? [7,4,1,2] : [12,4,1,2];
      const candidates = TREASURE_ENTRIES.filter(x => x.sourceOriginalIndex === 15 || selection.includes(x.sourceOriginalIndex));
      const index = candidates.findIndex(x => x.templateId === 11905), run = session();
      const actionSelection = [...selection]; const result = run.draw(1, "advanced", () => (index + 0.1) / candidates.length, actionSelection);
      expect(actionSelection).toEqual(selection);
      expect(result.nativeTreasureEffects![0]).toMatchObject({ type: "drawn", count: 1, cost: 60,
        rewards: [{ templateId: 11905, sourceOriginalIndex, itemCount: sourceOriginalIndex === 7 ? 10 : 5, entryKey: candidates[index].entryKey }] });
    }
  });
  it("rejects malformed/stale/foreign draw selection before RNG and retains the complete state", () => {
    const run = session(old()), before = structuredClone(run.state);
    const valid = { type: "draw", mode: "advanced" as const, count: 1, selection: [4,1,7,12], poolVersion: TREASURE_POOL_VERSION, choice: run.view().bagToken };
    for (const invalid of [{...valid,selection:[]}, {...valid,selection:[1,2,3,15]}, {...valid,selection:[1,1,2,3]}, {...valid,selection:[1,2,3,4,5]},
      {...valid,selection:[0,1,2,3]}, {...valid,selection:[1,2,3,4.5]}, {...valid,poolVersion:"0".repeat(64)}, {...valid,choice:"stale"},
      {...valid,mode:"normal",selection:[1,2,3,4]}, {...valid,count:6}, {...valid,count:0}, {...valid,index:0}]) {
      expect(() => run.act(invalid as ActivityAction, "treasure-native", noRandom)).toThrow(ActivityError); expect(run.state).toEqual(before);
    }
  });
  it("takes a single full original row, reindexes safely, preserves mixed old items and rejects all mixed recycling", () => {
    const run = session(old()); run.draw(2); const before = structuredClone(run.state), stale = run.view().bagToken;
    expect(run.view().canRecycle).toBe(false); expect(() => run.act({ type: "recycle", choice: stale })).toThrow(/混合包/); expect(run.state).toEqual(before);
    const take = run.act({ type: "take", index: 2, choice: stale });
    expect(take.rewards).toEqual([{ ...readTreasureState(before.games.treasure).bag[2] }]); expect(take.nativeTreasureEffects![0]).toMatchObject({ type: "taken", items: [{ index: 2 }] });
    expect(run.view().bag.map(x => x.index)).toEqual([0,1,2]); expect(() => run.act({ type: "take", index: 2, choice: stale })).toThrow(/已更新/);
    const all = run.act({ type: "take" }, "treasure"); expect(all.rewards).toHaveLength(3); expect(run.view().bag).toEqual([]);
  });
  it("settles legacy take/recycle/exchange/progress despite blocked new pool and daily 500", () => {
    const run = session(old(), clock); run.state.daily.actions = 500;
    expect(run.act({ type: "progress", tier: 2, choice: run.view().bagToken }).rewards).toEqual([{ templateId: 11019, count: 4 }]);
    expect(run.act({ type: "exchange", choice: run.view().bagToken }).rewards).toEqual([{ templateId: 11021, count: 2 }]);
    expect(run.act({ type: "take", index: 0, choice: run.view().bagToken }).rewards[0]).toMatchObject({ templateId: 11019, count: 2 });
    expect(run.act({ type: "recycle", choice: run.view().bagToken }).pointsDelta).toBe(8);
    expect(run.state.daily.actions).toBe(500); expect(run.state.games.treasure).toMatchObject({ version: 2, bag: [], pity: 8, claimed: [1,2], fragments: 0 });
  });
  it("bounds 100 per-draw slots, counters, wallet headroom and atomic invalid RNG", () => {
    const state = readTreasureState(old()); state.bag = Array.from({ length: 98 }, () => ({ templateId: 11019, count: 2, origin: "legacy-four-material" }));
    expect(viewTreasureNative(state, ctx(), wallet).drawChoices.filter(x => x.mode === "normal").map(x => x.canDraw)).toEqual([true,true,false,false,false]);
    expect(() => advance(state, {type:"draw",mode:"normal",count:3,selection:[],poolVersion:TREASURE_POOL_VERSION})).toThrow(/已满/);
    expect(() => advance(state, {type:"recycle"}, ctx(), {...wallet,points:2147483647})).toThrow(/超过上限/);
    expect(() => advance({...state,score:999999999}, {type:"draw",mode:"advanced",count:1,selection:[1,2,3,4],poolVersion:TREASURE_POOL_VERSION})).toThrow(/已达上限/);
    const run = session(), before = structuredClone(run.state); let calls = 0;
    expect(() => run.draw(5,"normal",()=>++calls===4?NaN:0)).toThrow(/随机源/); expect(calls).toBe(4); expect(run.state).toEqual(before);
  });
  it("refuses damaged/unknown saves without resetting or fabricating rewards", () => {
    for (const saved of [{...old(),version:3}, {...old(),bag:Array(30)}, {...old(),choices:[]}, {...old(),claimed:[1,1]}, {...old(),pity:10},
      {...old(),bag:[{templateId:11019,count:3}]}, {...readTreasureState(old()),bag:[{templateId:11905,count:5,origin:"original-catalog",entryKey:TREASURE_ENTRIES[0].entryKey,sourceOriginalIndex:12,poolVersion:TREASURE_POOL_VERSION}]}]) {
      const before = structuredClone(saved); expect(() => readTreasureState(saved)).toThrow(ActivityError); expect(saved).toEqual(before);
    }
  });
  it.each([TREASURE_PREVIOUS_POOL_VERSION,TREASURE_DRILL_POOL_VERSION,TREASURE_STRENGTHEN_POOL_VERSION,TREASURE_COMPOSE_HONOR_POOL_VERSION])("preserves verified prize identities and tokens for policy %s without accepting unknown versions", (poolVersion) => {
    const entry = TREASURE_ENTRIES.find(x => x.templateId === 11905 && x.sourceOriginalIndex === 7)!;
    const saved = readTreasureState(undefined);
    saved.bag = [{templateId:entry.templateId,count:entry.count,origin:"original-catalog",entryKey:entry.entryKey,
      sourceOriginalIndex:entry.sourceOriginalIndex,poolVersion}];
    const before = structuredClone(saved), {tickets:_tickets,...oldV2} = saved;
    const previousToken = `${clock.now.toISOString().slice(0,10)}:${createHash("sha256").update(JSON.stringify(oldV2)).digest("base64url")}`;
    const view = viewTreasureNative(saved,clock,wallet);
    expect(readTreasureState(saved)).toEqual(before); expect(saved).toEqual(before);
    expect(view.bagToken).toBe(previousToken); expect(view.poolVersion).toBe(TREASURE_POOL_VERSION);
    expect(view.bag[0].poolVersion).toBe(poolVersion);
    for (const poolVersion of ["a".repeat(64),"",undefined]) {
      expect(() => readTreasureState({...saved,bag:[{...saved.bag[0],poolVersion}]})).toThrow(ActivityError);
    }
    expect(() => readTreasureState({...saved,bag:[{...saved.bag[0],count:5}]})).toThrow(ActivityError);
    const result = advanceTreasure(saved,{type:"take",choice:view.bagToken,index:0},clock,wallet,noRandom,true);
    expect(result.rewards).toEqual([{...before.bag[0]}]); expect(result.state.bag).toEqual([]);
    expect(saved).toEqual(before);
  });
  it.each([TREASURE_PREVIOUS_POOL_VERSION,TREASURE_DRILL_POOL_VERSION,TREASURE_STRENGTHEN_POOL_VERSION,TREASURE_COMPOSE_HONOR_POOL_VERSION])("keeps existing prizes from %s while new draws require the current evidence version", (poolVersion) => {
    const entry = TREASURE_ENTRIES.find(x => x.templateId === 11905 && x.sourceOriginalIndex === 12)!;
    const saved = readTreasureState(undefined);
    saved.bag = [{templateId:entry.templateId,count:entry.count,origin:"original-catalog",entryKey:entry.entryKey,
      sourceOriginalIndex:entry.sourceOriginalIndex,poolVersion}];
    const run = session(saved), before = structuredClone(run.state);
    for (const action of [{type:"draw",mode:"normal",count:1,selection:[]},{type:"buy-tickets",mode:"normal",count:1}] as ActivityAction[]) {
      expect(() => run.act({...action,poolVersion,choice:run.view().bagToken},"treasure-native",noRandom)).toThrow(/版本已更新/);
      expect(run.state).toEqual(before);
    }
    run.draw(1,"normal",()=>0);
    expect(run.view().bag.map(x => x.poolVersion)).toEqual([poolVersion,TREASURE_POOL_VERSION]);
    expect(run.view().bag[0]).toMatchObject({templateId:11905,itemCount:5,sourceOriginalIndex:12});
  });
});

describe("independent local-task treasure tickets", () => {
  const buy = (run: ReturnType<typeof session>, mode: "normal" | "advanced", count: number) => run.act({ type: "buy-tickets", mode, count,
    poolVersion: TREASURE_POOL_VERSION, choice: run.view().bagToken });
  const drawAction = (run: ReturnType<typeof session>, mode: "normal" | "advanced" = "normal", count = 1): ActivityAction => ({
    type: "draw", mode, count, funding: "tickets", selection: mode === "advanced" ? [4,1,12,7] : [],
    poolVersion: TREASURE_POOL_VERSION, choice: run.view().bagToken });

  it("defaults old saves to zero without backfill or writes and preserves the exact old token bytes", () => {
    // Fixed SHA of the pre-ticket normalized JSON (version,bag,draws,score,fragments,pity,choices,claimed).
    const oldToken = "2026-10-15:-QfxTaCOajyVjmmneSLFDhP3zMT-ZkTaZrFC0LsfZf8", saved = old(), before = structuredClone(saved);
    const normalized = readTreasureState(saved), { tickets: _tickets, ...oldV2 } = normalized;
    expect(normalized.tickets).toEqual({ normal: 0, advanced: 0 }); expect(readTreasureState(undefined).tickets).toEqual({ normal: 0, advanced: 0 });
    expect(token(saved)).toBe(oldToken); expect(token(oldV2)).toBe(oldToken); expect(token(normalized)).toBe(oldToken);
    expect(viewTreasureNative(saved, clock, wallet).tickets).toEqual({ normal: 0, advanced: 0 }); expect(saved).toEqual(before);
    const held = { ...normalized, tickets: { normal: 7, advanced: 2 } }, heldBefore = structuredClone(held);
    expect(readTreasureState(held)).toEqual(held); expect(token(held)).not.toBe(oldToken);
    expect(token({ ...held, tickets: { normal: 6, advanced: 2 } })).not.toBe(token(held)); expect(held).toEqual(heldBefore);
  });

  it("rejects damaged, partial or overflowing ticket saves without silently resetting held rights", () => {
    for (const tickets of [undefined,null,[],{}, { normal: 1 }, { advanced: 1 }, { normal: 1, advanced: 2, extra: 0 },
      { normal: -1, advanced: 0 }, { normal: 0.5, advanced: 0 }, { normal: "1", advanced: 0 },
      { normal: NaN, advanced: 0 }, { normal: 0, advanced: Infinity }, { normal: 1_000_000_001, advanced: 0 }]) {
      const saved = { ...old(), tickets }, before = structuredClone(saved);
      expect(() => readTreasureState(saved)).toThrow(/寻宝券余额/); expect(saved).toEqual(before);
    }
    expect(readTreasureState({ ...old(), tickets: { normal: 1_000_000_000, advanced: 1_000_000_000 } }).tickets)
      .toEqual({ normal: 1_000_000_000, advanced: 1_000_000_000 });
  });

  it("exchanges one or 99 tickets at 30/60 points without RNG or fabricating draw progress", () => {
    const run = session(old()), oldState = readTreasureState(old()); run.wallet.points = 10_000;
    const first = buy(run, "normal", 1), advanced = buy(run, "advanced", 99);
    expect(first).toMatchObject({ pointsDelta: -30, earnedDelta: 0, rewards: [], nativeTreasureEffects: [
      { type: "tickets-bought", mode: "normal", count: 1, cost: 30, score: 9970, tickets: { normal: 1, advanced: 0 } }] });
    expect(advanced).toMatchObject({ pointsDelta: -5940, earnedDelta: 0, rewards: [], nativeTreasureEffects: [
      { type: "tickets-bought", mode: "advanced", count: 99, cost: 5940, score: 4030, tickets: { normal: 1, advanced: 99 } }] });
    expect(readTreasureState(run.state.games.treasure)).toEqual({ ...oldState, tickets: { normal: 1, advanced: 99 } });
    expect(run.state.completed.treasure).toBeUndefined(); expect(run.state.daily.draws ?? 0).toBe(0); expect(run.state.daily.actions).toBe(2);
    expect(run.wallet).toMatchObject({ points: 4030, earned: 40 });
    const action: ActivityAction = { type: "buy-tickets", mode: "normal", count: 1, poolVersion: TREASURE_POOL_VERSION, choice: token(old()) };
    const saved = old(), before = structuredClone(saved), request = structuredClone(action);
    expect(prepareTreasureTicketPurchase(saved, action, ctx(), wallet)).toMatchObject({ count: 1, cost: 30, state: { tickets: { normal: 0, advanced: 0 } } });
    expect(advanceTreasure(saved, action, ctx(), wallet, noRandom, true)).toMatchObject({ cost: 30, completed: false, draws: 0, rewards: [] });
    expect(saved).toEqual(before); expect(action).toEqual(request);
  });

  it("spends the matching tickets once per draw without a second points charge or changing old points effects", () => {
    const run = session(old()); buy(run, "normal", 5); buy(run, "advanced", 5);
    const before = run.wallet.points, ordinary = run.act(drawAction(run, "normal", 5), "treasure-native", () => 0);
    const advanced = run.act(drawAction(run, "advanced", 5), "treasure-native", () => 0.999999);
    expect(before).toBe(1550); expect(run.wallet.points).toBe(before);
    expect(ordinary).toMatchObject({ pointsDelta: 0, nativeTreasureEffects: [{ type: "drawn", mode: "normal", count: 5, cost: 0,
      funding: "tickets", ticketsSpent: 5, score: before, tickets: { normal: 0, advanced: 5 } }] });
    expect(advanced).toMatchObject({ pointsDelta: 0, nativeTreasureEffects: [{ type: "drawn", mode: "advanced", count: 5, cost: 0,
      funding: "tickets", ticketsSpent: 5, score: before, tickets: { normal: 0, advanced: 0 } }] });
    expect(readTreasureState(run.state.games.treasure)).toMatchObject({ draws: 20, score: 35, fragments: 20, pity: 8, choices: old().choices });
    expect(run.view().bag[2]).toMatchObject({ templateId: TREASURE_ENTRIES[0].templateId, itemCount: TREASURE_ENTRIES[0].count });
    expect(run.view().bag.at(-1)).toMatchObject({ templateId: TREASURE_ENTRIES.at(-1)!.templateId, itemCount: TREASURE_ENTRIES.at(-1)!.count });
    const points = run.draw(); expect(points.pointsDelta).toBe(-30);
    expect(Object.keys(points.nativeTreasureEffects![0]).sort()).toEqual(["type","mode","count","cost","score","draws","rewards"].sort());
  });

  it("allows a ticket draw at zero points but refuses cross-mode substitution, fallback and invalid funding", () => {
    const run = session({ ...old(), tickets: { normal: 2, advanced: 0 } }); run.wallet.points = 0;
    expect(run.view().drawChoices.every(row => !row.canDraw)).toBe(true);
    expect(run.view().ticketDrawChoices.filter(row => row.mode === "normal").map(row => row.canDraw)).toEqual([true,true,false,false,false]);
    expect(run.view().ticketDrawChoices.filter(row => row.mode === "advanced").every(row => !row.canDraw)).toBe(true);
    const before = structuredClone(run.state), request = drawAction(run, "advanced");
    expect(() => run.act(request)).toThrow(/寻宝券不足/); expect(run.state).toEqual(before);
    run.wallet.points = 2000;
    for (const funding of ["points","ticket","",null,undefined,0]) {
      expect(() => run.act({ ...drawAction(run), funding } as ActivityAction)).toThrow(/资金来源/); expect(run.state).toEqual(before);
    }
    run.wallet.points = 0; run.act(drawAction(run, "normal", 2), "treasure-native", () => 0);
    expect(run.wallet.points).toBe(0); expect(run.view().tickets).toEqual({ normal: 0, advanced: 0 });
    run.wallet.points = 2000; const exhausted = structuredClone(run.state);
    expect(() => run.act(drawAction(run))).toThrow(/寻宝券不足/); expect(run.state).toEqual(exhausted);
  });

  it("rejects malformed purchases before RNG and retains the exact input action, wallet and save", () => {
    const run = session(old()), base: ActivityAction = { type: "buy-tickets", mode: "normal", count: 1,
      poolVersion: TREASURE_POOL_VERSION, choice: run.view().bagToken }, before = structuredClone(run.state), funds = { ...run.wallet };
    for (const invalid of [{...base,count:0},{...base,count:100},{...base,count:-1},{...base,count:1.5},{...base,count:"1"},
      {...base,mode:"other"},{...base,mode:undefined},{...base,poolVersion:undefined},{...base,poolVersion:"0".repeat(64)},
      {...base,choice:"stale"},{...base,selection:[]},{...base,funding:"tickets"},{...base,index:0},{...base,price:0},{...base,readiness:{status:"ready"}}]) {
      const request = structuredClone(invalid);
      expect(() => run.act(invalid as ActivityAction)).toThrow(ActivityError);
      expect(invalid).toEqual(request); expect(run.state).toEqual(before); expect(run.wallet).toEqual(funds);
    }
    run.wallet.points = 29; expect(() => buy(run,"normal",1)).toThrow(/积分不足/); expect(run.state).toEqual(before);
  });

  it("blocks purchases and both funding paths on any unready row while preserving existing ticket and bag entitlements", () => {
    const partial = readyCatalog(), row = partial.preview.find(entry => entry.sourceOriginalIndex === 12)!;
    row.status = "blocked"; row.reasons = ["Unselected owner blocked"];
    partial.readiness = { status: "blocked", totalRows: 158, readyRows: 157, blocked: [{ entryKey: row.entryKey, reasons: [...row.reasons] }], description: "完整奖池尚未就绪" };
    for (const context of [clock, { ...clock, treasureCatalog: partial }]) {
      const run = session({ ...old(), tickets: { normal: 5, advanced: 5 } }, context), before = structuredClone(run.state), funds = { ...run.wallet };
      expect(run.view().ticketShop.offers.every(offer => !offer.canBuy)).toBe(true);
      expect(run.view().ticketDrawChoices.every(choice => !choice.canDraw)).toBe(true);
      for (const mode of ["normal","advanced"] as const) {
        expect(() => buy(run,mode,1)).toThrow(/完整奖池/);
        const draw = { ...drawAction(run,mode), selection: mode === "advanced" ? [1,2,3,4] : [] };
        expect(() => run.act(draw)).toThrow(/完整奖池/);
        const { funding: _funding, ...points } = draw; expect(() => run.act(points)).toThrow(/完整奖池/);
        expect(run.state).toEqual(before); expect(run.wallet).toEqual(funds);
      }
      run.state.daily.actions = 500;
      run.act({ type: "progress", tier: 2, choice: run.view().bagToken }); run.act({ type: "exchange", choice: run.view().bagToken });
      run.act({ type: "take", index: 0, choice: run.view().bagToken }); run.act({ type: "recycle", choice: run.view().bagToken });
      expect(run.view().tickets).toEqual({ normal: 5, advanced: 5 }); expect(run.view().bag).toEqual([]); expect(run.state.daily.actions).toBe(500);
    }
  });

  it("bounds purchase headroom, daily actions and finite ticket batches before RNG", () => {
    const state = { ...readTreasureState(old()), tickets: { normal: 999_999_998, advanced: 999_999_999 } };
    const view = viewTreasureNative(state,ctx(),wallet); expect(view.ticketShop).toMatchObject({ currency: "local-task-points", maxPurchase: 99,
      offers: [{ mode: "normal", unitCost: 30, maxCount: 2, canBuy: true }, { mode: "advanced", unitCost: 60, maxCount: 1, canBuy: true }] });
    expect(view.localRules).toMatchObject({ version: 2, ticketPrices: { normal: 30, advanced: 60 }, maxTicketPurchase: 99 });
    expect(view.ticketDrawChoices).toHaveLength(10);
    expect(() => advance(state,{type:"buy-tickets",mode:"normal",count:3,poolVersion:TREASURE_POOL_VERSION})).toThrow(/余额已达上限/);
    const held = { ...readTreasureState(old()), tickets: { normal: 5, advanced: 5 } }, run = session(held); run.state.daily.actions = 500;
    const before = structuredClone(run.state); expect(() => buy(run,"normal",1)).toThrow(/今日玩法次数/);
    expect(() => run.act(drawAction(run))).toThrow(/今日玩法次数/); expect(run.state).toEqual(before);
    const exhausted = viewTreasureNative(held,ctx(),wallet,false);
    expect(exhausted.ticketShop.offers.every(offer => !offer.canBuy)).toBe(true); expect(exhausted.ticketDrawChoices.every(choice => !choice.canDraw)).toBe(true);
    const full = { ...held, bag: Array.from({ length: 98 }, () => ({ templateId: 11019, count: 2, origin: "legacy-four-material" as const })) }, limited = session(full);
    expect(limited.view().ticketDrawChoices.filter(row=>row.mode==="normal").map(row=>row.canDraw)).toEqual([true,true,false,false,false]);
    expect(() => limited.act(drawAction(limited,"normal",3))).toThrow(/已满/);
    for (const field of ["draws","score","fragments"] as const) {
      const capped = session({ ...held, [field]: 1_000_000_000 }), saved = structuredClone(capped.state);
      expect(capped.view().ticketDrawChoices.every(choice => !choice.canDraw)).toBe(true);
      expect(() => capped.act(drawAction(capped))).toThrow(/已达上限/); expect(capped.state).toEqual(saved);
    }
  });

  it("keeps ticket batches atomic after late RNG failure and rejects stale purchase/date tokens without consumption", () => {
    const context = ctx(), run = session({ ...old(), tickets: { normal: 5, advanced: 5 } },context), before = structuredClone(run.state), funds = { ...run.wallet };
    const request = drawAction(run,"normal",5), raw = structuredClone(request); let calls = 0;
    expect(() => run.act(request,"treasure-native",()=>++calls===3?NaN:0)).toThrow(/随机源/);
    expect(calls).toBe(3); expect(request).toEqual(raw); expect(run.state).toEqual(before); expect(run.wallet).toEqual(funds);
    const stale = drawAction(run); buy(run,"normal",1); const bought = structuredClone(run.state), paid = { ...run.wallet };
    expect(() => run.act(stale)).toThrow(/已更新/); expect(run.state).toEqual(bought); expect(run.wallet).toEqual(paid);
    const purchase: ActivityAction = { type: "buy-tickets", mode: "advanced", count: 1, poolVersion: TREASURE_POOL_VERSION, choice: run.view().bagToken };
    context.now = new Date("2026-10-16T00:00:00Z"); expect(() => run.act(purchase)).toThrow(/已更新/);
    expect(run.state).toEqual(bought); expect(run.wallet).toEqual(paid); expect(run.view().tickets).toEqual({ normal: 6, advanced: 5 });
  });
});
