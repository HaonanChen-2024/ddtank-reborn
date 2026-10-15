import { randomUUID } from "node:crypto";
import { game, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import type { AppCtx } from "../src/context.js";
import { activityRoutes } from "../src/routes/activities.js";
import { signJwt } from "../src/lib/jwt.js";
import { q, q1 } from "../src/lib/db.js";
import { CiTree, ResourceIndex } from "../src/lib/resources.js";
import { PRIZES } from "../src/activities/config.js";
import { createActivityState } from "../src/activities/engine.js";
import { createCaveState, type CaveView, type CaveState } from "../src/activities/caveloot-native.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import type { ActivityResult } from "../src/activities/service.js";
export const uid = 917, secret = "caveloot-native-isolated-tests-only", name = "caveloot-native-tests";
export async function seedTemplates(h: DbHandle) {
  const base: typeof game.Shop_Goods.$inferInsert = { TemplateID: 11019, Name: "Synthetic ordinary material", CanRecycle: 0, CategoryID: 11,
    Attack: 12, Defence: 13, Agility: 14, Luck: 15, Level: 1, Quality: 1, MaxCount: 5, NeedSex: 0, NeedLevel: 1,
    CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
    Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
    BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
  await h.db.insert(game.Shop_Goods).values(PRIZES.map(p => ({ ...base, TemplateID: p.templateId, Name: p.name })));
}
export async function buildTestApi(h: DbHandle, resourceDir: string) {
  const api = Fastify({ logger: false }), cfg = loadConfig({}, { NODE_ENV: "test", JWT_SECRET: secret, GAME_INTERNAL_URL: "" });
  const ctx = { h, cfg, resources: new ResourceIndex([new CiTree(resourceDir)]), log: { info() {}, warn() {}, error() {} } } as unknown as AppCtx;
  await activityRoutes(api, ctx); await api.ready(); return api;
}
export const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name, role: "player" }, secret, 3600)}` });
const requests = new Map<string, ActivityAction>();
export const actionFor = (result: ActivityResult) => result.nativeCaveLootAction ? requests.get(result.nativeCaveLootAction.requestId) : undefined;
export const post = (api: FastifyInstance, action: ActivityAction, requestId = randomUUID(), id = "caveloot-native", characterId = uid) => {
  requests.set(requestId, structuredClone(action));
  return api.inject({ method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId, requestId, action } });
};
export async function snapshot(api: FastifyInstance): Promise<ActivityResult> {
  const r = await api.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  if (r.statusCode !== 200) throw Error(`GET ${r.statusCode}: ${r.body}`); return r.json();
}
export const native = async (api: FastifyInstance, action: ActivityAction, requestId = randomUUID()) => {
  const v = (await snapshot(api)).nativeCaveLoot; if (!v.available) throw Error("Unavailable fixture"); return post(api, { ...action, choice: v.stateToken }, requestId);
};
export async function clean(h: DbHandle) {
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS caveloot_receipt_failure`);
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS caveloot_mail_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "MaxCount"=5,"CanEquip"=false`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,${name},'synthetic-only'),(2,'other-caveloot-test','synthetic-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},${name},'Cave native test',true,'2000-01-01',1),(918,'other-caveloot-test','Other native test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,40)`);
}
export const state = async (h: DbHandle) => (await q1<{ State: ActivityState }>(h, sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))?.State;
export async function persistState(h: DbHandle, root: ActivityState) {
  await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(root)}::jsonb)
    ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=EXCLUDED."State"`);
}
export async function seedNative(h: DbHandle, changes: Partial<CaveState> = {}, actions = 0) {
  const root = createActivityState(new Date()); root.daily.actions = actions; root.games.untouched = { private: "preserve" };
  root.games.cave = { ...createCaveState(), ...changes }; await persistState(h, root); return root;
}
export async function persisted(h: DbHandle) { return {
  wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
export const available = (x: ActivityResult): CaveView => { if (!x.nativeCaveLoot.available) throw Error("Unavailable fixture"); return x.nativeCaveLoot; };
