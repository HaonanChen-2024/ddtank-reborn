/** F2 public projection adapter. The game owns admission, combat and rewards. */
import type { AppCtx } from "../context.js";
import type { Claims } from "../lib/jwt.js";
import { ActivityError, type ActivityAction } from "./types.js";
import { readChristmasProjection, validChristmasView, type ChristmasNativeView, type ChristmasReward } from "./christmas-native.js";

export type SnowfieldType = 0 | 1 | 2;
export type SnowfieldAction = { type: "enter" | "npc-claim"; choice: string }
  | { type: "challenge"; index: SnowfieldType; choice: string };
export interface SnowfieldView {
  version: 1; kind: "christmas-snowfield"; rulesVersion: 1; catalogVersion: "christmas-snowfield-local-v1";
  day: string; serverNow: string; revision: number; authority: "online" | "offline" | "unavailable";
  available: boolean; reason: string; stateToken: string | null; currency: "local-task-points"; points: number; taskEarned: number;
  entry: { available: boolean; reason: string };
  ticket: { claimKey: string; qualifiedToday: boolean; issuedToday: boolean; issuedAt: string | null; expiresAt: string | null; valid: boolean; durationSeconds: 1800 };
  scene: { revision: string | null; state: "outside" | "loading" | "inside" | "fighting" | "settling"; people: number; capacity: 20; canResume: boolean; reason: string };
  challenges: { index: SnowfieldType; type: SnowfieldType; title: string; monsterId: number | null;
    state: "unavailable" | "alive" | "reserved" | "fighting" | "dead"; originalMissionId: 40001 | 40002 | 40003;
    localPveId: 164001 | 164002 | 164003; battleMapId: 1201; usedToday: number; remainingToday: number; limit: 3;
    canChallenge: boolean; reason: string; reward: ChristmasReward }[];
  attempt: { state: "none" | "admitted" | "launching" | "fighting" | "settling"; type: SnowfieldType | null; canResume: boolean; refundPending: boolean; reason: string };
  npc: { hasSettledWinToday: boolean; claimed: boolean; canClaim: boolean; reason: string; reward: ChristmasReward | null };
  rules: string[]; unavailable: { id: "original-economy" | "original-mission-rules"; reason: string }[];
}
export interface SnowfieldPair { snowman: ChristmasNativeView; snowfield: SnowfieldView }
export type SnowfieldEffect =
  | { type: "entered"; issued: boolean; issuedAt: string; expiresAt: string; committedRevision: number; committedSceneRevision: string }
  | { type: "challenged"; index: SnowfieldType; monsterId: number; originalMissionId: 40001 | 40002 | 40003; localPveId: 164001 | 164002 | 164003;
      usedToday: number; committedRevision: number; committedSceneRevision: string }
  | { type: "npc-claimed"; rewards: [ChristmasReward]; committedRevision: number; committedSceneRevision: string };
export interface SnowfieldEnvelope { requestId: string; effects: [SnowfieldEffect] }
interface SnowfieldResult { pair: SnowfieldPair; requestId: string; replayed: boolean; message: string; mailedCount: number; nativeChristmasAction?: SnowfieldEnvelope }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const int = (v: unknown, min = 0, max = 2147483647): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 1000;
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0,10) === v;
const instant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const digest = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const token = (v: unknown): v is string => typeof v === "string" && date(v.slice(0,10)) && v[10] === "." && digest(v.slice(11));
const prize = (v: unknown, templateId: number): boolean => object(v) && exact(v,["templateId","name","itemCount","bound","validDays"])
  && v.templateId === templateId && text(v.name) && v.itemCount === 1 && v.bound === true && v.validDays === 0;

export const isSnowfieldAction = (a: ActivityAction) => ["enter","challenge","npc-claim"].includes(a.type);
export function validateSnowfieldAction(a: ActivityAction): asserts a is SnowfieldAction {
  const v = a as unknown as Record<string, unknown>;
  if (!token(v.choice) || (v.type === "challenge" ? !exact(v,["type","index","choice"]) || !int(v.index,0,2)
    : (v.type!=="enter"&&v.type!=="npc-claim") || !exact(v,["type","choice"]))) throw new ActivityError("雪场操作或状态凭证无效。");
}
export function unavailableSnowfield(revision: number, day: string, points: number, taskEarned: number): SnowfieldView {
  const reason = "雪场服务暂不可用，尚未取得场景与战斗权威状态。";
  return { version:1,kind:"christmas-snowfield",rulesVersion:1,catalogVersion:"christmas-snowfield-local-v1",day,serverNow:new Date().toISOString(),revision,
    authority:"unavailable",available:false,reason,stateToken:null,currency:"local-task-points",points,taskEarned,entry:{available:false,reason},
    ticket:{claimKey:`task:${day}:sign`,qualifiedToday:false,issuedToday:false,issuedAt:null,expiresAt:null,valid:false,durationSeconds:1800},
    scene:{revision:null,state:"outside",people:0,capacity:20,canResume:false,reason},challenges:[],
    attempt:{state:"none",type:null,canResume:false,refundPending:false,reason},
    npc:{hasSettledWinToday:false,claimed:false,canClaim:false,reason,reward:null},rules:[reason],
    unavailable:[{id:"original-economy",reason:"采用本地签到票与独立次数。"},{id:"original-mission-rules",reason:"本地1201地图与明确本地战斗规则。"}] };
}
export function validSnowfieldView(v: unknown): v is SnowfieldView {
  if (!object(v) || !exact(v,["version","kind","rulesVersion","catalogVersion","day","serverNow","revision","authority","available","reason","stateToken","currency","points","taskEarned","entry","ticket","scene","challenges","attempt","npc","rules","unavailable"])
    || v.version!==1 || v.kind!=="christmas-snowfield" || v.rulesVersion!==1 || v.catalogVersion!=="christmas-snowfield-local-v1" || !date(v.day) || !instant(v.serverNow) || v.serverNow.slice(0,10)!==v.day
    || !int(v.revision) || !["online","offline","unavailable"].includes(v.authority as string) || typeof v.available!=="boolean" || !text(v.reason)
    || (v.available ? v.authority!=="online" || !token(v.stateToken) || !v.stateToken.startsWith(v.day+".") : v.stateToken!==null)
    || v.currency!=="local-task-points" || !int(v.points) || !int(v.taskEarned)) return false;
  const e=v.entry,t=v.ticket,s=v.scene,a=v.attempt,n=v.npc;
  if (!object(e)||!exact(e,["available","reason"])||typeof e.available!=="boolean"||!text(e.reason)||e.available&&!v.available
    || !object(t)||!exact(t,["claimKey","qualifiedToday","issuedToday","issuedAt","expiresAt","valid","durationSeconds"])||t.claimKey!==`task:${v.day}:sign`||![t.qualifiedToday,t.issuedToday,t.valid].every(x=>typeof x==="boolean")||t.durationSeconds!==1800
    || !(t.issuedAt===null&&t.expiresAt===null||instant(t.issuedAt)&&instant(t.expiresAt)&&Date.parse(t.expiresAt)-Date.parse(t.issuedAt)===1800000)
    || t.issuedToday&&(!instant(t.issuedAt)||t.issuedAt.slice(0,10)!==v.day)
    || t.valid&&(!instant(t.issuedAt)||!instant(t.expiresAt)||Date.parse(t.issuedAt)>Date.parse(v.serverNow)||Date.parse(t.expiresAt)<=Date.parse(v.serverNow))
    || !object(s)||!exact(s,["revision","state","people","capacity","canResume","reason"])||!(digest(s.revision)||s.revision===null&&v.authority==="unavailable")||!["outside","loading","inside","fighting","settling"].includes(s.state as string)||!int(s.people,0,20)||s.capacity!==20||typeof s.canResume!=="boolean"||!text(s.reason)
    || s.canResume&&(!v.available||!t.valid||s.state!=="loading")
    || !object(a)||!exact(a,["state","type","canResume","refundPending","reason"])||!["none","admitted","launching","fighting","settling"].includes(a.state as string)||!(a.state==="none"?a.type===null:int(a.type,0,2))||![a.canResume,a.refundPending].every(x=>typeof x==="boolean")||!text(a.reason)
    || a.canResume&&(!v.available||!t.valid||a.state!=="admitted"||s.state!=="inside")
    || !object(n)||!exact(n,["hasSettledWinToday","claimed","canClaim","reason","reward"])||![n.hasSettledWinToday,n.claimed,n.canClaim].every(x=>typeof x==="boolean")||!text(n.reason)||n.claimed&&!n.hasSettledWinToday||n.canClaim&&(!v.available||!n.hasSettledWinToday||n.claimed)
    || !Array.isArray(v.rules)||v.rules.length<1||v.rules.length>20||!v.rules.every(text)
    || !Array.isArray(v.unavailable)||v.unavailable.length!==2||!v.unavailable.every((u,i)=>object(u)&&exact(u,["id","reason"])&&u.id===["original-economy","original-mission-rules"][i]&&text(u.reason))||!Array.isArray(v.challenges)) return false;
  if (v.challenges.length===0) return v.authority==="unavailable"&&!v.available&&!e.available&&s.revision===null&&s.state==="outside"&&s.people===0&&!s.canResume&&!t.qualifiedToday&&!t.issuedToday&&t.issuedAt===null&&!t.valid&&a.state==="none"&&!a.canResume&&!a.refundPending&&!n.hasSettledWinToday&&!n.claimed&&!n.canClaim&&n.reward===null;
  return prize(n.reward,11002)&&v.challenges.length===3&&v.challenges.every((c,i)=>object(c)&&exact(c,["index","type","title","monsterId","state","originalMissionId","localPveId","battleMapId","usedToday","remainingToday","limit","canChallenge","reason","reward"])
    &&c.index===i&&c.type===i&&text(c.title)&&(c.monsterId===null||int(c.monsterId,1))&&["unavailable","alive","reserved","fighting","dead"].includes(c.state as string)&&c.originalMissionId===40001+i&&c.localPveId===164001+i&&c.battleMapId===1201&&int(c.usedToday,0,3)&&c.remainingToday===3-Number(c.usedToday)&&c.limit===3&&typeof c.canChallenge==="boolean"&&text(c.reason)&&prize(c.reward,[11019,11001,11021][i])
    &&(!c.canChallenge||v.available&&t.valid&&s.state==="inside"&&c.state==="alive"&&c.monsterId!==null&&(Number(c.remainingToday)>0||a.refundPending&&a.type===i)));
}
export function validSnowfieldPair(v: unknown): v is SnowfieldPair {
  if (!object(v)||!exact(v,["snowman","snowfield"])||!validChristmasView(v.snowman,true)||!validSnowfieldView(v.snowfield)) return false;
  const m=v.snowman,f=v.snowfield;
  return m.day===f.day&&m.revision===f.revision&&m.points===f.points&&m.taskEarned===f.taskEarned&&m.snowfield.available===f.entry.available&&m.snowfield.reason===f.entry.reason;
}
const uncertain = (): never => { throw new ActivityError("雪场结果暂不确定，请保留同一请求编号重试。",503); };
async function internal(app: AppCtx,path:string,body:unknown):Promise<Record<string,unknown>> {
  if (!app.cfg.GAME_INTERNAL_URL) return uncertain();
  try { const res=await fetch(`${app.cfg.GAME_INTERNAL_URL.replace(/\/+$/,"")}/activity-christmas-snowfield/${path}`,{method:"POST",signal:AbortSignal.timeout(5000),headers:{"content-type":"application/json",...(app.cfg.GAME_INTERNAL_TOKEN?{authorization:`Bearer ${app.cfg.GAME_INTERNAL_TOKEN}`}:{})},body:JSON.stringify(body)});
    if(!res.ok)return uncertain();const v:unknown=await res.json();if(!object(v)||typeof v.ok!=="boolean")return uncertain();
    if(!v.ok){if(!exact(v,["ok","status","message"])||typeof v.status!=="number"||![400,401,403,409,503].includes(v.status)||!text(v.message))return uncertain();throw new ActivityError(v.message,v.status);}
    if(!exact(v,["ok","value"])||!object(v.value))return uncertain();return v.value;
  }catch(e){if(e instanceof ActivityError)throw e;return uncertain();}
}
export async function readSnowfieldPair(app:AppCtx,claims:Claims,characterId:number,revision:number,day:string,points:number,taskEarned:number):Promise<SnowfieldPair>{
  try {const pair=await internal(app,"read",{actor:{accountId:claims.sub,accountName:claims.name},characterId});
    if(validSnowfieldPair(pair)&&pair.snowman.revision===revision&&pair.snowman.day===day&&pair.snowman.points===points&&pair.snowman.taskEarned===taskEarned)return pair;
  }catch{/* Old services retain snowman support and a closed snowfield entry. */}
  const snowfield=unavailableSnowfield(revision,day,points,taskEarned);
  return {snowman:{...await readChristmasProjection(app,claims,characterId,revision,day,points,taskEarned),snowfield:snowfield.entry},snowfield};
}
export async function commandSnowfield(app:AppCtx,claims:Claims,characterId:number,requestId:string,action:ActivityAction):Promise<SnowfieldResult>{
  validateSnowfieldAction(action);
  const v=await internal(app,"action",{actor:{accountId:claims.sub,accountName:claims.name},characterId,requestId,action});
  if(!exact(v,["pair","requestId","replayed","message","mailedCount",...(v.replayed===false?["nativeChristmasAction"]:[])])||!validSnowfieldPair(v.pair)||v.requestId!==requestId||typeof v.replayed!=="boolean"||!text(v.message)||!int(v.mailedCount,0,1000))return uncertain();
  if(!v.replayed){const env=v.nativeChristmasAction;if(!object(env)||!exact(env,["requestId","effects"])||env.requestId!==requestId||!Array.isArray(env.effects)||env.effects.length!==1)return uncertain();
    const e:unknown=env.effects[0];if(!object(e)||!int(e.committedRevision,1,v.pair.snowfield.revision)||!digest(e.committedSceneRevision))return uncertain();
    if(action.type==="enter") {if(!exact(e,["type","issued","issuedAt","expiresAt","committedRevision","committedSceneRevision"])||e.type!=="entered"||typeof e.issued!=="boolean"||!instant(e.issuedAt)||!instant(e.expiresAt)||Date.parse(e.expiresAt)-Date.parse(e.issuedAt)!==1800000||v.mailedCount!==0)return uncertain();}
    else if(action.type==="challenge") {if(!exact(e,["type","index","monsterId","originalMissionId","localPveId","usedToday","committedRevision","committedSceneRevision"])||e.type!=="challenged"||e.index!==action.index||!int(e.monsterId,1)||e.originalMissionId!==40001+action.index||e.localPveId!==164001+action.index||!int(e.usedToday,1,3)||v.mailedCount!==0)return uncertain();}
    else if(!exact(e,["type","rewards","committedRevision","committedSceneRevision"])||e.type!=="npc-claimed"||!Array.isArray(e.rewards)||e.rewards.length!==1||!prize(e.rewards[0],11002)||!int(v.mailedCount,1,1000))return uncertain();
  }
  return v as unknown as SnowfieldResult;
}
