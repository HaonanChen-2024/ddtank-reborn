import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { advanceTreasure, readTreasureState, viewTreasureNative } from "../src/activities/treasure-native.js";
import { completeTreasureCatalog, inspectTreasureCatalog, TREASURE_ENTRIES, TREASURE_IDS, TREASURE_POOL_VERSION, type TreasureCatalog, type TreasureTemplate } from "../src/activities/treasure-catalog.js";
import { createActivityState, transitionActivity, viewActivities } from "../src/activities/engine.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityState } from "../src/activities/types.js";

const clock: ActivityContext = { now: new Date("2026-10-15T12:00:00Z"), signDays: [], ownedTemplateIds: [] };
const wallet = { points: 2000, earned: 40, revision: 0 };
const noRandom = () => { throw new Error("Unexpected RNG"); };
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
    expect(actual.preview.filter(x => x.status === "ready").every(x => [11560,11561,11562,11901,11902,11903,11904,11906].includes(x.templateId))).toBe(true);
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
});
