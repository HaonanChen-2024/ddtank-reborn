import { createHash } from "node:crypto";
import { LOCAL_RULES as C, PRIZES } from "./config.js";
import { completeTreasureCatalog, originalTreasureCategories, TREASURE_CAPACITY, TREASURE_ENTRIES, TREASURE_POOL_VERSION } from "./treasure-catalog.js";
import { ActivityError, type ActivityAction, type ActivityContext, type ActivityReward, type ActivityWallet } from "./types.js";

export interface TreasureBagItem extends ActivityReward {
  origin: "legacy-four-material" | "original-catalog"; entryKey?: string; sourceOriginalIndex?: number; poolVersion?: string;
}
export interface TreasureTickets { normal: number; advanced: number }
/** Additive normalization only: old earned bags/counters/choices/pity remain intact. */
export interface TreasureState {
  version: 2; bag: TreasureBagItem[]; draws: number; score: number; fragments: number; pity: number; choices: string[]; claimed: number[];
  tickets: TreasureTickets;
}
type Clock = Pick<ActivityContext, "now" | "treasureCatalog">;
type Funds = Pick<ActivityWallet, "points">;
type Selection = { index: number; templateId: number; itemCount: number };
const MAX_TICKETS = 1_000_000_000;
export const treasureNativeLocalRules = Object.freeze({ version: 2, normalCost: C.treasureCost, advancedCost: C.treasureCost * 2,
  ticketPrices: { normal: C.treasureCost, advanced: C.treasureCost * 2 }, maxTicketPurchase: 99,
  bagCapacity: TREASURE_CAPACITY, recycleUnitPoints: 2, exchange: { fragmentCost: 10, templateId: 11021, itemCount: 2 },
  description: "本地规则：显示原15类158行宝物。普通每次30活动积分，从全部原行等权抽取；高级每次60积分，须从前14类选4类，从所选4类与第15特殊类的原行等权抽取，保留原数量。第15类不可选择。也可用本地任务活动积分换券：普通每张30、高级每张60，一次1至99张；这是本地兑换规则，不是原服售价或高级券来源。券抽取每次只扣对应券1张，不再扣积分，普通与高级券不能互代。完整奖池的模板、用途与武器官方属性/特效未全部核验前，全部禁止新购券及抽取，不用四材料替代。单次1至5次，连续按钮仅一次有限五次批量，不自动重复消费。暂存包最多100格；领取寄永久绑定邮件。旧材料包及计数、碎片、保底计数保留，旧包每个材料数量可回收2积分；新奖品未配置回收规则，混包不可全部回收。10碎片兑换强化石2级×2，10/20/30进度各领一次普通材料。新池不使用旧四材料保底。不接真实付款；幸运彩石排行及排行奖仍待实现。",
});
export type TreasureNativeEffect =
  | { type: "drawn"; mode: "normal" | "advanced"; count: number; cost: number; score: number; draws: number;
      funding?: "tickets"; ticketsSpent?: number; tickets?: TreasureTickets;
      rewards: (Selection & { entryKey: string; sourceOriginalIndex: number })[] }
  | { type: "tickets-bought"; mode: "normal" | "advanced"; count: number; cost: number; score: number; tickets: TreasureTickets }
  | { type: "taken"; itemCount: number; items: Selection[] }
  | { type: "recycled"; pointsAwarded: number; score: number; items: Selection[] }
  | { type: "exchanged"; fragmentsSpent: number; fragments: number; templateId: number; itemCount: number }
  | { type: "progress-claimed"; tier: number; templateId: number; itemCount: number };
export interface TreasureResult {
  state: TreasureState; pointsDelta: number; cost: number; rewards: ActivityReward[]; completed: boolean; draws: number;
  effects: TreasureNativeEffect[]; message: string;
}
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new ActivityError(message); }
function int(value: unknown, min = 0, max = 2_147_483_647): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function dayOf(ctx: Clock) {
  need(ctx?.now instanceof Date && Number.isFinite(ctx.now.getTime()), "寻宝日期无效。"); return ctx.now.toISOString().slice(0, 10);
}
function balance(funds: Funds, delta = 0) {
  need(int(funds?.points) && int(funds.points + delta), "活动积分不足或结算超过上限。"); return funds.points + delta;
}
const empty = (): TreasureState => ({ version:2, bag:[],draws:0,score:0,fragments:0,pity:0,choices:PRIZES.map(p=>p.name),claimed:[],tickets:{normal:0,advanced:0} });
function readBagItem(value: unknown, legacy: boolean): TreasureBagItem {
  need(value && typeof value === "object" && !Array.isArray(value), "寻宝奖品存档无效。");
  const item = value as TreasureBagItem;
  need(int(item.templateId,1) && int(item.count,1) && (item.validDays === undefined || item.validDays === 0), "寻宝奖品配方无效。");
  if (legacy || item.origin === "legacy-four-material") {
    need((legacy ? item.origin === undefined : item.origin === "legacy-four-material") && PRIZES.some(p=>p.templateId===item.templateId)
      && (item.templateId===11021 ? [1,2,4] : [1,2]).includes(item.count)
      && item.entryKey === undefined && item.sourceOriginalIndex === undefined && item.poolVersion === undefined, "寻宝旧材料配方无效。");
    return { templateId:item.templateId,count:item.count,...(item.validDays===0 ? {validDays:0}:{}),origin:"legacy-four-material" };
  }
  const row = TREASURE_ENTRIES.find(x=>x.entryKey===item.entryKey);
  need(item.origin === "original-catalog" && item.poolVersion === TREASURE_POOL_VERSION && row
    && row.templateId===item.templateId && row.count===item.count && row.sourceOriginalIndex===item.sourceOriginalIndex, "寻宝原目录奖品版本或身份无效，请保留存档。");
  return { templateId:item.templateId,count:item.count,...(item.validDays===0 ? {validDays:0}:{}),origin:"original-catalog",
    entryKey:row.entryKey,sourceOriginalIndex:row.sourceOriginalIndex,poolVersion:item.poolVersion };
}
export function readTreasureState(value: unknown): TreasureState {
  if (value===undefined) return empty();
  need(value && typeof value === "object" && !Array.isArray(value), "寻宝存档无效。"); const state=value as TreasureState;
  const legacy = state.version === undefined;
  need(legacy || state.version===2,"寻宝存档版本不兼容，请保留存档。");
  need([state.draws,state.score,state.fragments].every(n=>int(n,0,1_000_000_000)) && int(state.pity,0,C.cavePity-1)
    && Array.isArray(state.bag) && state.bag.length <= (legacy ? C.bagCapacity : TREASURE_CAPACITY)
    && Array.isArray(state.claimed) && state.claimed.length<=3 && state.claimed.every(t=>int(t,1,3)) && new Set(state.claimed).size===state.claimed.length
    && Array.isArray(state.choices) && state.choices.length>=1 && state.choices.length<=PRIZES.length
    && state.choices.every(name=>PRIZES.some(p=>p.name===name)) && new Set(state.choices).size===state.choices.length,"寻宝次数、背包或进度存档无效。");
  need(Array.from(state.claimed).every(t=>int(t,1,3)) && Array.from(state.choices).every(name=>PRIZES.some(p=>p.name===name)),"寻宝进度或分类存档无效。");
  const tickets = Object.hasOwn(state,"tickets") ? state.tickets : {normal:0,advanced:0};
  need(tickets && typeof tickets === "object" && !Array.isArray(tickets) && Object.keys(tickets).length===2
    && Object.hasOwn(tickets,"normal") && Object.hasOwn(tickets,"advanced") && int(tickets.normal,0,MAX_TICKETS) && int(tickets.advanced,0,MAX_TICKETS),"寻宝券余额存档无效，请保留存档。");
  return { version:2,bag:Array.from(state.bag,x=>readBagItem(x,legacy)),draws:state.draws,score:state.score,fragments:state.fragments,
    pity:state.pity,choices:[...state.choices],claimed:[...state.claimed],tickets:{normal:tickets.normal,advanced:tickets.advanced} };
}
function bagRows(state: Pick<TreasureState,"bag">) {
  return state.bag.map((item,index)=>({ index,templateId:item.templateId,itemCount:item.count,origin:item.origin,
    recycleUnitPoints:item.origin==="legacy-four-material" ? 2 : null,
    ...(item.origin==="original-catalog" ? {entryKey:item.entryKey!,sourceOriginalIndex:item.sourceOriginalIndex!,poolVersion:item.poolVersion!}: {}) }));
}
function bagToken(state:TreasureState,ctx:Clock) {
  const {tickets,...original}=state;
  return `${dayOf(ctx)}:${createHash("sha256").update(JSON.stringify(tickets.normal||tickets.advanced ? {...original,tickets} : original)).digest("base64url")}`;
}
function validateAction(action:ActivityAction,state:TreasureState,ctx:Clock) {
  need(action && typeof action==="object" && !Array.isArray(action) && Object.hasOwn(action,"type") && typeof action.choice==="string","寻宝操作或参数无效。");
  const fields:Record<string,string[]>={draw:["mode","count","selection","poolVersion","funding"],"buy-tickets":["mode","count","poolVersion"],take:["index"],recycle:[],exchange:[],progress:["tier"]};
  need(Object.hasOwn(fields,action.type) && Object.keys(action).every(k=>k==="type"||k==="choice"||fields[action.type].includes(k)),"寻宝操作或参数无效，请刷新原窗口。");
  need(action.choice===bagToken(state,ctx),"临时包或日期已更新，请重新查看后再确认。");
  if (action.type==="take" && Object.hasOwn(action,"index")) need(int(action.index,0,state.bag.length-1),"临时包格子无效。");
  if (action.type==="progress") need(int(action.tier,1,3),"寻宝奖励档位无效。");
}
export function prepareTreasureDraw(value:unknown,action:ActivityAction,ctx:Clock,funds:Funds,_native=false) {
  const state=readTreasureState(value); dayOf(ctx); balance(funds); validateAction(action,state,ctx);
  need(action.type==="draw" && ["normal","advanced"].includes(action.mode!) && int(action.count,1,5),"寻宝模式或1至5次批量无效，请刷新原窗口。");
  need(!Object.hasOwn(action,"funding") || action.funding==="tickets","寻宝资金来源无效。");
  need(action.poolVersion===TREASURE_POOL_VERSION && Array.isArray(action.selection),"原奖池版本已更新，请刷新原窗口。");
  const mode=action.mode!, advanced=mode==="advanced", count=action.count!;
  need(action.selection.length===(advanced?4:0) && action.selection.every(x=>int(x,1,14)) && new Set(action.selection).size===action.selection.length,
    advanced ? "高级寻宝须从前14类选择恰好4类。" : "普通寻宝不使用分类选择。");
  const catalog=completeTreasureCatalog(ctx.treasureCatalog);
  need(catalog.readiness.status==="ready",catalog.readiness.description);
  need(state.bag.length+count<=TREASURE_CAPACITY,"临时背包已满，请先领取或回收。");
  need(int(state.draws+count,0,1_000_000_000) && int(state.score+count*(advanced?2:1),0,1_000_000_000)
    && int(state.fragments+count,0,1_000_000_000),"寻宝进度已达上限。");
  const ticketFunded=action.funding==="tickets",cost=ticketFunded?0:C.treasureCost*(advanced?2:1)*count; balance(funds,-cost);
  if(ticketFunded)need(state.tickets[mode]>=count,"对应模式的寻宝券不足。");
  const candidates=catalog.preview.filter(x=>!advanced||x.sourceOriginalIndex===15||action.selection!.includes(x.sourceOriginalIndex));
  return {state,count,mode,advanced,cost,candidates,ticketFunded};
}
export function prepareTreasureTicketPurchase(value:unknown,action:ActivityAction,ctx:Clock,funds:Funds) {
  const state=readTreasureState(value);dayOf(ctx);balance(funds);validateAction(action,state,ctx);
  need(action.type==="buy-tickets" && ["normal","advanced"].includes(action.mode!) && int(action.count,1,99),"寻宝券模式或1至99张数量无效。");
  need(action.poolVersion===TREASURE_POOL_VERSION,"原奖池版本已更新，请刷新原窗口。");
  const catalog=completeTreasureCatalog(ctx.treasureCatalog);need(catalog.readiness.status==="ready",catalog.readiness.description);
  const mode=action.mode!,count=action.count!,cost=treasureNativeLocalRules.ticketPrices[mode]*count;balance(funds,-cost);
  need(int(state.tickets[mode]+count,0,MAX_TICKETS),"寻宝券余额已达上限。");
  return {state,mode,count,cost};
}
/** Caller owns wallet, immutable UUID receipt, template locks, mail, and one transaction. */
export function advanceTreasure(value:unknown,action:ActivityAction,ctx:Clock,funds:Funds,rng:()=>number,native=false):TreasureResult {
  const prepared=action?.type==="draw" ? prepareTreasureDraw(value,action,ctx,funds,native):undefined;
  const purchase=action?.type==="buy-tickets" ? prepareTreasureTicketPurchase(value,action,ctx,funds):undefined;
  const state=prepared?.state??purchase?.state??readTreasureState(value);
  if (!prepared&&!purchase) {dayOf(ctx);balance(funds);if(native)validateAction(action,state,ctx);}
  const effects:TreasureNativeEffect[]=[], rewards:ActivityReward[]=[];
  let pointsDelta=0,cost=0,completed=false,draws=0,message="活动进度已保存。";
  if(action.type==="buy-tickets") {
    const {mode,count}=purchase!;cost=purchase!.cost;pointsDelta=-cost;state.tickets[mode]+=count;
    if(native)effects.push({type:"tickets-bought",mode,count,cost,score:balance(funds,pointsDelta),tickets:{...state.tickets}});
    message=`已用${cost}活动积分兑换${count}张${mode==="normal"?"普通":"高级"}寻宝券。`;
  } else if(action.type==="draw") {
    const {count,mode,advanced,candidates,ticketFunded}=prepared!; cost=prepared!.cost;pointsDelta=ticketFunded?0:-cost;
    const found:(Selection & {entryKey:string;sourceOriginalIndex:number})[]=[];
    for(let i=0;i<count;i++) {
      const n=rng();need(Number.isFinite(n)&&n>=0&&n<1,"随机源异常，请重试。"); const row=candidates[Math.floor(n*candidates.length)];
      found.push({index:state.bag.length,templateId:row.templateId,itemCount:row.count,entryKey:row.entryKey,sourceOriginalIndex:row.sourceOriginalIndex});
      state.bag.push({templateId:row.templateId,count:row.count,validDays:0,origin:"original-catalog",entryKey:row.entryKey,sourceOriginalIndex:row.sourceOriginalIndex,poolVersion:TREASURE_POOL_VERSION});
      state.draws++;state.score+=advanced?2:1;state.fragments++;
    }
    if(ticketFunded)state.tickets[mode]-=count;
    if(native)effects.push({type:"drawn",mode,count,cost,score:balance(funds,pointsDelta),draws:state.draws,rewards:found,
      ...(ticketFunded?{funding:"tickets" as const,ticketsSpent:count,tickets:{...state.tickets}}:{})});
    completed=true;draws=count;message=`完成${count}次迷宫寻宝，奖品留在临时背包。`;
  } else if(action.type==="take"||action.type==="recycle") {
    need(state.bag.length>0,"临时背包为空。");
    const rows=bagRows(state), selections=native&&action.type==="take"&&action.index!==undefined?[rows[action.index]]:rows;
    need(selections.every(Boolean),"临时包格子无效。");
    const itemCount=selections.reduce((n,x)=>n+x.itemCount,0);
    if(action.type==="take") { rewards.push(...selections.map(x=>({...state.bag[x.index]}))); if(native)effects.push({type:"taken",itemCount,items:selections.map(({index,templateId,itemCount})=>({index,templateId,itemCount}))}); }
    else { need(state.bag.every(x=>x.origin==="legacy-four-material"),"新奖品尚未配置回收规则，请先领取；混合包不能全部回收。");pointsDelta=itemCount*2;const score=balance(funds,pointsDelta);if(native)effects.push({type:"recycled",pointsAwarded:pointsDelta,score,items:selections.map(({index,templateId,itemCount})=>({index,templateId,itemCount}))}); }
    const removed=new Set(selections.map(x=>x.index));state.bag=state.bag.filter((_,i)=>!removed.has(i));
    message=action.type==="take"?"临时包奖励已寄到邮件。":`材料已回收，获得${pointsDelta}活动积分。`;
  } else if(action.type==="exchange") {
    need(state.fragments>=10,"需要10枚活动碎片。");state.fragments-=10;rewards.push({templateId:11021,count:2});
    if(native)effects.push({type:"exchanged",fragmentsSpent:10,fragments:state.fragments,templateId:11021,itemCount:2});message="10枚碎片已兑换，奖励已寄出。";
  } else if(action.type==="progress") {
    need(int(action.tier,1,3)&&state.score>=action.tier*10,"尚未达到该档寻宝进度。");need(!state.claimed.includes(action.tier),"这档进度奖励已经领取。");
    state.claimed.push(action.tier);rewards.push({templateId:11019,count:action.tier*2});if(native)effects.push({type:"progress-claimed",tier:action.tier,templateId:11019,itemCount:action.tier*2});
  } else throw new ActivityError("分类已改为原窗口本地14选4，请刷新原窗口。");
  return {state,pointsDelta,cost,rewards,completed,draws,effects,message};
}
export function viewTreasureNative(value:unknown,ctx:Clock,funds:Funds,actionsRemaining=true,history:string[]=[]) {
  const state=readTreasureState(value),score=balance(funds),bag=bagRows(state),catalog=completeTreasureCatalog(ctx.treasureCatalog);
  const space=(advanced:boolean,count:number)=>catalog.readiness.status==="ready"&&actionsRemaining&&state.bag.length+count<=TREASURE_CAPACITY
    &&state.draws+count<=1_000_000_000&&state.score+count*(advanced?2:1)<=1_000_000_000&&state.fragments+count<=1_000_000_000;
  const drawChoices=(["normal","advanced"] as const).flatMap(mode=>[1,2,3,4,5].map(count=>{
    const advanced=mode==="advanced",cost=C.treasureCost*(advanced?2:1)*count;
    return {mode,count,cost,requiredSelection:advanced?4:0,canDraw:space(advanced,count)&&score>=cost};
  }));
  const ticketDrawChoices=(["normal","advanced"] as const).flatMap(mode=>[1,2,3,4,5].map(count=>({mode,count,ticketsRequired:count,
    requiredSelection:mode==="advanced"?4:0,canDraw:space(mode==="advanced",count)&&state.tickets[mode]>=count})));
  const offers=(["normal","advanced"] as const).map(mode=>{const unitCost=treasureNativeLocalRules.ticketPrices[mode],maxCount=Math.min(99,Math.floor(score/unitCost),MAX_TICKETS-state.tickets[mode]);
    return {mode,unitCost,maxCount,canBuy:catalog.readiness.status==="ready"&&actionsRemaining&&maxCount>0};});
  return {version:2 as const,kind:"treasure-native" as const,started:value!==undefined,day:dayOf(ctx),score,poolVersion:catalog.poolVersion,
    readiness:structuredClone(catalog.readiness),categories:originalTreasureCategories(),preview:structuredClone(catalog.preview),
    normalCost:C.treasureCost,advancedCost:C.treasureCost*2,bagCapacity:TREASURE_CAPACITY,bagSlotsUsed:state.bag.length,bagToken:bagToken(state,ctx),
    draws:state.draws,progressScore:state.score,fragments:state.fragments,pityRemaining:C.cavePity-state.pity,
    canDraw:drawChoices[0].canDraw,drawChoices,canTake:bag.length>0,
    tickets:{...state.tickets},ticketShop:{currency:"local-task-points" as const,maxPurchase:99,offers},ticketDrawChoices,
    canRecycle:bag.length>0&&state.bag.every(x=>x.origin==="legacy-four-material")&&score+bag.reduce((n,x)=>n+x.itemCount*2,0)<=2_147_483_647,bag,
    exchange:{...treasureNativeLocalRules.exchange,canExchange:state.fragments>=10},
    progress:[1,2,3].map(tier=>({tier,target:tier*10,templateId:11019,itemCount:tier*2,claimed:state.claimed.includes(tier),canClaim:state.score>=tier*10&&!state.claimed.includes(tier)})),
    records:history.filter(x=>x.includes(" 迷宫寻宝：")||x.includes(" 原生迷宫寻宝：")).slice(0,20),localRules:{version:2,ticketPrices:{...treasureNativeLocalRules.ticketPrices},maxTicketPurchase:99,description:treasureNativeLocalRules.description}};
}
export type TreasureNativeView=ReturnType<typeof viewTreasureNative>;
