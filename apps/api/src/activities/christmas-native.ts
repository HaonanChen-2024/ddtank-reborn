/** Thin authenticated game authority adapter. No economic state is written by API. */
import type { AppCtx } from "../context.js";
import type { Claims } from "../lib/jwt.js";
import { ActivityError, type ActivityAction } from "./types.js";
/** Frozen first-slice contract A. Local rules; original snowfield remains unavailable. */
export type ChristmasAuthority = "online" | "offline" | "unavailable";
export type ChristmasTask = "sign" | "mines" | "pair" | "explore";
export type ChristmasTier = 1 | 2 | 3 | 4;
export interface ChristmasReward {
  templateId: 11019 | 11001 | 11021 | 11002; name: string; itemCount: number; bound: true; validDays: 0;
}
export interface ChristmasQuote {
  count: number; double: boolean; resourceCost: number; pointCost: number; experienceGained: number;
  canCraft: boolean; reason: string;
}
export interface ChristmasTierView {
  tier: ChristmasTier; title: string; repeatable: boolean; threshold: number; cycle: number; nextTarget: number;
  claimed: boolean; canClaim: boolean; reason: string; reward: ChristmasReward;
}
export interface ChristmasNativeView {
  version: 1; kind: "christmas-native"; rulesVersion: 1; catalogVersion: "christmas-snowman-local-v1";
  day: string; revision: number; authority: ChristmasAuthority; available: boolean; reason: string; stateToken: string | null;
  activity: { open: true; beginAt: "1970-01-01T00:00:00.000Z"; endAt: "2099-12-31T23:59:59.999Z"; title: string };
  snowfield: { available: false; reason: string };
  currency: "local-task-points"; points: number; taskEarned: number; dailyActionsRemaining: number;
  snowman: {
    resource: "local-task-snowpacks"; resourceLabel: string; balance: number; entitlement: number; usedToday: number;
    count: number; exp: number; totalExp: 10; maxCount: number; maxDoubleCount: number;
    tasks: { id: ChristmasTask; claimKey: string; completed: boolean; packs: number }[];
    quotes: ChristmasQuote[];
  };
  rewards: ChristmasTierView[];
  rules: string[];
  unavailable: { id: "original-economy" | "snowfield" | "official-snowpacks"; reason: string }[];
}
/** HTTP uses existing fields; marked is the original double Boolean, index is expected cycle. */
export type ChristmasAction =
  | { type: "craft"; count: number; marked: boolean; choice: string }
  | { type: "claim"; tier: ChristmasTier; index: number; choice: string };
export type ChristmasEffect =
  | { type: "crafted"; count: number; double: boolean; resourceCost: number; pointCost: number; experienceGained: number;
      before: { count: number; exp: number }; after: { count: number; exp: number }; isUp: boolean; committedRevision: number }
  | { type: "claimed"; tier: ChristmasTier; cycle: number; rewards: ChristmasReward[]; committedRevision: number };
export interface ChristmasEnvelope { requestId: string; effects: ChristmasEffect[] }

interface ChristmasResult { view: ChristmasNativeView; requestId: string; replayed: boolean; message: string; mailedCount: number; nativeChristmasAction?: ChristmasEnvelope }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, min = 0, max = 2147483647): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 1000;
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && Object.keys(v).every(k => fields.includes(k));
const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const token = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(v) && day(v.slice(0, 10));
export function validateChristmasAction(v: ActivityAction) {
  const a = v as unknown as Record<string, unknown>;
  if (!token(a.choice) || !(a.type === "craft" ? exact(a, ["type", "count", "marked", "choice"]) && int(a.count, 1, 10) && typeof a.marked === "boolean"
    : a.type === "claim" && exact(a, ["type", "tier", "index", "choice"]) && int(a.tier, 1, 4) && int(a.index, 0, 499999998) && (a.tier === 4 || a.index === 0))) throw new ActivityError("圣诞操作、数量或状态凭证无效。");
}
const reward = (v: unknown): v is ChristmasReward => obj(v) && exact(v, ["templateId", "name", "itemCount", "bound", "validDays"]) && [11019,11001,11021,11002].includes(Number(v.templateId)) && text(v.name) && int(v.itemCount, 1) && v.bound === true && v.validDays === 0;
export function unavailableChristmas(revision: number, date: string, points: number, taskEarned: number): ChristmasNativeView {
  return { version: 1, kind: "christmas-native", rulesVersion: 1, catalogVersion: "christmas-snowman-local-v1", day: date, revision, authority: "unavailable", available: false, reason: "堆雪人服务暂不可用；其它活动可继续使用。", stateToken: null,
    activity: { open: true, beginAt: "1970-01-01T00:00:00.000Z", endAt: "2099-12-31T23:59:59.999Z", title: "快乐圣诞·堆雪人" }, snowfield: { available: false, reason: "真实雪场尚未移植。" }, currency: "local-task-points", points, taskEarned, dailyActionsRemaining: 0,
    snowman: { resource: "local-task-snowpacks", resourceLabel: "本地任务雪包", balance: 0, entitlement: 0, usedToday: 0, count: 0, exp: 0, totalExp: 10, maxCount: 0, maxDoubleCount: 0, tasks: [], quotes: [] }, rewards: [], rules: ["服务暂不可用，未取得权威堆雪人状态。"],
    unavailable: [{ id: "original-economy", reason: "当前为明确本地任务规则。" }, { id: "snowfield", reason: "真实雪场未开放。" }, { id: "official-snowpacks", reason: "不伪造原背包雪包。" }] };
}
export function validChristmasView(v: unknown): v is ChristmasNativeView {
  if (!obj(v) || !exact(v, ["version","kind","rulesVersion","catalogVersion","day","revision","authority","available","reason","stateToken","activity","snowfield","currency","points","taskEarned","dailyActionsRemaining","snowman","rewards","rules","unavailable"]) ||
    v.version !== 1 || v.kind !== "christmas-native" || v.rulesVersion !== 1 || v.catalogVersion !== "christmas-snowman-local-v1" || !day(v.day) || !int(v.revision) || !["online","offline","unavailable"].includes(String(v.authority)) || typeof v.available !== "boolean" || !text(v.reason) ||
    (v.available ? v.authority !== "online" || !token(v.stateToken) || !v.stateToken.startsWith(`${v.day}.`) : v.stateToken !== null) || v.currency !== "local-task-points" || !int(v.points) || !int(v.taskEarned) || !int(v.dailyActionsRemaining,0,500) ||
    !obj(v.activity) || !exact(v.activity,["open","beginAt","endAt","title"]) || v.activity.open !== true || v.activity.beginAt !== "1970-01-01T00:00:00.000Z" || v.activity.endAt !== "2099-12-31T23:59:59.999Z" || !text(v.activity.title) ||
    !obj(v.snowfield) || !exact(v.snowfield,["available","reason"]) || v.snowfield.available !== false || !text(v.snowfield.reason) || !Array.isArray(v.rules) || v.rules.length<1 || v.rules.length>10 || !v.rules.every(text) ||
    !Array.isArray(v.unavailable) || v.unavailable.length !== 3 || !v.unavailable.every((u,i)=>obj(u)&&exact(u,["id","reason"])&&u.id===["original-economy","snowfield","official-snowpacks"][i]&&text(u.reason)) || !Array.isArray(v.rewards)) return false;
  const s = v.snowman;
  if (!obj(s) || !exact(s,["resource","resourceLabel","balance","entitlement","usedToday","count","exp","totalExp","maxCount","maxDoubleCount","tasks","quotes"]) || s.resource !== "local-task-snowpacks" || !text(s.resourceLabel) || !int(s.balance,0,30) || !int(s.entitlement,0,30) || !int(s.usedToday,0,30) || !int(s.count,0,1000000000) || !int(s.exp,0,9) || s.totalExp !== 10 || !int(s.maxCount,0,10) || !int(s.maxDoubleCount,0,10) || !Array.isArray(s.tasks) || !Array.isArray(s.quotes)) return false;
  if (v.authority === "unavailable" && s.tasks.length===0 && s.quotes.length===0 && v.rewards.length===0) return !v.available && v.dailyActionsRemaining===0 && [s.balance,s.entitlement,s.usedToday,s.count,s.exp,s.maxCount,s.maxDoubleCount].every(n=>n===0);
  if (s.balance !== s.entitlement-s.usedToday || s.tasks.length!==4 || !s.tasks.every((t,i)=>obj(t)&&exact(t,["id","claimKey","completed","packs"])&&t.id===["sign","mines","pair","explore"][i]&&t.claimKey===`task:${v.day}:${t.id}`&&typeof t.completed==="boolean"&&t.packs===[5,10,10,5][i])) return false;
  if (s.entitlement!==s.tasks.reduce((n,t)=>n+(t.completed?Number(t.packs):0),0) || s.quotes.length!==20 || !s.quotes.every((q,i)=>obj(q)&&exact(q,["count","double","resourceCost","pointCost","experienceGained","canCraft","reason"])&&q.count===i%10+1&&q.double===(i>=10)&&q.resourceCost===q.count&&q.pointCost===(i>=10?Number(q.count)*2:0)&&q.experienceGained===Number(q.count)*(i>=10?2:1)&&typeof q.canCraft==="boolean"&&text(q.reason)&&(!q.canCraft||v.available&&v.dailyActionsRemaining!==0&&Number(q.count)<=Number(s.balance)&&Number(q.pointCost)<=Number(v.points)&&Number(s.count)+Math.floor((Number(s.exp)+Number(q.experienceGained))/10)<=1000000000))) return false;
  if (s.maxCount!==Math.max(0,...s.quotes.filter(q=>!q.double&&q.canCraft).map(q=>Number(q.count))) || s.maxDoubleCount!==Math.max(0,...s.quotes.filter(q=>q.double&&q.canCraft).map(q=>Number(q.count)))) return false;
  return v.rewards.length===4&&v.rewards.every((r,i)=>obj(r)&&exact(r,["tier","title","repeatable","threshold","cycle","nextTarget","claimed","canClaim","reason","reward"])&&r.tier===i+1&&text(r.title)&&text(r.reason)&&r.repeatable===(i===3)&&int(r.cycle,0,499999998)&&(i===3||r.cycle===0)&&r.threshold===[1,3,6,6][i]&&r.nextTarget===(i===3?6+2*(Number(r.cycle)+1):r.threshold)&&typeof r.claimed==="boolean"&&typeof r.canClaim==="boolean"&&reward(r.reward)&&r.reward.templateId===[11019,11001,11021,11002][i]&&r.reward.itemCount===[3,5,8,2][i]&&(!r.canClaim||v.available&&!r.claimed&&Number(s.count)>=Number(r.nextTarget)));
}
function uncertain(): never { throw new ActivityError("圣诞结果暂不确定，请保留同一请求编号重试。",503); }
async function internal(app: AppCtx,path:string,body:unknown) {
  if (!app.cfg.GAME_INTERNAL_URL) return uncertain();
  try { const res=await fetch(`${app.cfg.GAME_INTERNAL_URL.replace(/\/+$/,"")}/activity-christmas/${path}`,{method:"POST",signal:AbortSignal.timeout(5000),headers:{"content-type":"application/json",...(app.cfg.GAME_INTERNAL_TOKEN?{authorization:`Bearer ${app.cfg.GAME_INTERNAL_TOKEN}`}:{})},body:JSON.stringify(body)});
    if (!res.ok) return uncertain(); const v:unknown=await res.json(); if(!obj(v)||typeof v.ok!=="boolean")return uncertain();
    if(!v.ok){if(!exact(v,["ok","status","message"])||![400,401,403,409,503].includes(Number(v.status))||!text(v.message))return uncertain();throw new ActivityError(v.message,Number(v.status));}
    if(!exact(v,["ok","value"])||!obj(v.value))return uncertain(); return v.value;
  }catch(e){if(e instanceof ActivityError)throw e;return uncertain();}
}
const actor=(claims:Claims)=>({accountId:claims.sub,accountName:claims.name});
export async function readChristmasProjection(app:AppCtx,claims:Claims,characterId:number,revision:number,date:string,points:number,taskEarned:number):Promise<ChristmasNativeView>{
  try{const v=await internal(app,"read",{actor:actor(claims),characterId});return validChristmasView(v)&&v.revision===revision&&v.day===date&&v.points===points&&v.taskEarned===taskEarned?v:unavailableChristmas(revision,date,points,taskEarned);}catch{return unavailableChristmas(revision,date,points,taskEarned);}
}
export async function commandChristmas(app:AppCtx,claims:Claims,characterId:number,requestId:string,action:ActivityAction):Promise<ChristmasResult>{
  validateChristmasAction(action);const v=await internal(app,"action",{actor:actor(claims),characterId,requestId,action});
  if(!exact(v,["view","requestId","replayed","message","mailedCount",...(v.replayed===false?["nativeChristmasAction"]:[])])||!validChristmasView(v.view)||v.requestId!==requestId||typeof v.replayed!=="boolean"||!text(v.message)||!int(v.mailedCount,0,1000))return uncertain();
  if(!v.replayed){const env=v.nativeChristmasAction;if(!obj(env)||!exact(env,["requestId","effects"])||env.requestId!==requestId||!Array.isArray(env.effects)||env.effects.length!==1)return uncertain();const e:unknown=env.effects[0];
    if(!obj(e)||!int(e.committedRevision,1,v.view.revision))return uncertain();
    if(action.type==="craft"){
      if(!exact(e,["type","count","double","resourceCost","pointCost","experienceGained","before","after","isUp","committedRevision"])||e.type!=="crafted"||e.count!==action.count||e.double!==action.marked||e.resourceCost!==action.count||e.pointCost!==(action.marked?action.count!*2:0)||e.experienceGained!==action.count!*(action.marked?2:1)||!obj(e.before)||!obj(e.after)||![e.before,e.after].every(x=>obj(x)&&exact(x,["count","exp"])&&int(x.count,0,1000000000)&&int(x.exp,0,9))||typeof e.isUp!=="boolean")return uncertain();
      if(e.after.count!==Number(e.before.count)+Math.floor((Number(e.before.exp)+Number(e.experienceGained))/10)||e.after.exp!==(Number(e.before.exp)+Number(e.experienceGained))%10||e.isUp!==(Number(e.after.count)>Number(e.before.count))||v.mailedCount!==0)return uncertain();
    }else if(!exact(e,["type","tier","cycle","rewards","committedRevision"])||e.type!=="claimed"||e.tier!==action.tier||e.cycle!==(action.tier===4?action.index!+1:0)||!Array.isArray(e.rewards)||e.rewards.length!==1||!reward(e.rewards[0])||e.rewards[0].templateId!==[11019,11001,11021,11002][action.tier!-1]||e.rewards[0].itemCount!==[3,5,8,2][action.tier!-1]||Number(v.mailedCount)<1)return uncertain();
  }
  return v as unknown as ChristmasResult;
}
