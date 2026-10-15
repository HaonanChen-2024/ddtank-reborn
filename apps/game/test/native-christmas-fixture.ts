/** Minimal synthetic fixture; no full seed and no existing account/database. */
import { app, type DbHandle } from "@ddt/db";
import { exchangeFixture, seedExchangeTemplates } from "./native-exchange-fixture.js";
export { seedExchangeTemplates as seedChristmasTemplates };
export function christmasRoot(now = new Date(), actions = 0) {
  const day=now.toISOString().slice(0,10);
  return { version:1,day,daily:{ actions, other:7 },games:{ christmas:{ cells:[2,5,9],opened:[2],found:1,expires:"2099-01-01T00:00:00.000Z",claimed:false,round:1 }, retained:{ nested:true } },
    completed:{ retained:2 },claims:["sign","mines","pair","explore"].map(t=>`task:${day}:${t}`),history:["synthetic only"],unknownRoot:{keep:true} };
}
export async function christmasFixture(h:DbHandle,id=916, now=new Date()) {
  const f=await exchangeFixture(h,id);let clock=now;f.ctx.now=()=>clock;
  await h.db.insert(app.ActivityWallet).values({UserID:id,Points:100,Earned:200});
  await h.db.insert(app.ActivityStates).values({UserID:id,Activity:"reference",State:christmasRoot(clock)});
  return {...f,setNow:(n:Date)=>{clock=n;}};
}
