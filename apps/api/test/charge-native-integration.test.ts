import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDb, game, migrateDb, type DbHandle } from "@ddt/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { PRIZES } from "../src/activities/config.js";
import { createActivityState } from "../src/activities/engine.js";
import type { ActivityResult } from "../src/activities/service.js";
import type { ActivityAction, ActivityState } from "../src/activities/types.js";
import { q, q1 } from "../src/lib/db.js";
import { signJwt } from "../src/lib/jwt.js";

// Real HTTP/auth/SQL/mail in an isolated in-memory PGlite. No live DB or service.
const random = vi.hoisted(() => ({ fraction: 0.99 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  randomInt: (min: number, max?: number) => max === undefined ? Math.floor(random.fraction * min) : min + Math.floor(random.fraction * (max - min)) }));
const tmp = mkdtempSync(join(tmpdir(), "ddt-charge-native-"));
const uid = 811, otherUid = 812, secret = "charge-native-integration-tests-only";
let h: DbHandle, built: Awaited<ReturnType<typeof buildApp>>;
const config = { NODE_ENV: "test" as const, DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
  JWT_SECRET: secret, RSA_USE_VENDOR_KEY: false, RSA_PRIVATE_KEY: "", GAME_INTERNAL_URL: "",
  FLASH_DIR: join(tmp, "flash"), FLASH_OVERLAY_DIR: "", RESOURCE_DIR: join(tmp, "resource"),
  UPLOAD_DIR: join(tmp, "uploads"), REQUEST_SNAPSHOT_DIR: join(tmp, "snapshots"), RUFFLE_DIR: join(tmp, "ruffle"), CELEB_REBUILD_MIN: 0 };
const rebuild = async () => { built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config }); };
const headers = () => ({ authorization: `Bearer ${signJwt({ sub: 1, name: "charge-native-test", role: "player" }, secret, 3600)}` });
const post = (id: string, action: ActivityAction, requestId: string = randomUUID(), characterId = uid) => built.app.inject({
  method: "POST", url: `/api/account/activities/${id}/action`, headers: headers(), payload: { characterId, requestId, action } });
function noPrivatePayload(body: string) {
  const publicStates: Record<string, readonly string[]> = {
    "root.nativeChristmasSnowfield.scene": ["outside", "loading", "inside", "fighting", "settling"],
    "root.nativeChristmasSnowfield.attempt": ["none", "admitted", "launching", "fighting", "settling"],
    "root.nativeChristmasSnowfield.challenges[]": ["unavailable", "alive", "reserved", "fighting", "dead"],
  };
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) { for (const child of value) visit(child, `${path}[]`); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "state") expect(publicStates[path] ?? [], `${path}.state`).toContain(child);
      else if (key === "origin") {
        expect(path, `${path}.origin`).toBe("root.nativeTreasure.bag[]");
        expect(["legacy-four-material", "original-catalog"], `${path}.origin`).toContain(child);
      } else expect(["nativeChargeEffects", "games", "seed"], `${path}.${key}`).not.toContain(key);
      visit(child, `${path}.${key}`);
    }
  };
  visit(JSON.parse(body), "root");
}
async function snapshot(): Promise<ActivityResult> {
  const response = await built.app.inject({ url: `/api/account/activities?characterId=${uid}`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); const result = response.json<ActivityResult>();
  expect(result).not.toHaveProperty("nativeChargeAction"); noPrivatePayload(response.body); return result;
}
async function action(id: string, value: ActivityAction, requestId: string = randomUUID(), status = 200): Promise<ActivityResult> {
  const response = await post(id, value, requestId); expect(response.statusCode, response.body).toBe(status);
  noPrivatePayload(response.body); return response.json();
}
const native = (value: ActivityAction, requestId: string = randomUUID(), status = 200) => action("charge-native", value, requestId, status);
const request = async (value: ActivityAction, requestId: string = randomUUID()) => native({ ...value, choice: (await snapshot()).nativeCharge.stateToken }, requestId);
const saved = async () => (await q1<{ State: ActivityState }>(h, sql`SELECT "State" FROM app."ActivityStates" WHERE "UserID"=${uid} AND "Activity"='reference'`))?.State;
async function persisted() { return {
  wallets: await q(h, sql`SELECT * FROM app."ActivityWallet" ORDER BY "UserID"`),
  states: await q(h, sql`SELECT * FROM app."ActivityStates" ORDER BY "UserID","Activity"`),
  receipts: await q(h, sql`SELECT * FROM app."ActivityActions" ORDER BY "UserID","RequestID"`),
  goods: await q(h, sql`SELECT * FROM player."Sys_Users_Goods" ORDER BY "ItemID"`),
  mails: await q(h, sql`SELECT * FROM player."User_Messages" ORDER BY "ID"`),
}; }
beforeAll(async () => {
  h = await createDb("pglite:memory"); await migrateDb(h);
  const template: typeof game.Shop_Goods.$inferInsert = { TemplateID: 11019, Name: "Material", CanRecycle: 0, CategoryID: 11,
    Attack: 12, Defence: 13, Agility: 14, Luck: 15, Level: 1, Quality: 1, MaxCount: 2,
    NeedSex: 0, NeedLevel: 1, CanStrengthen: false, CanCompose: false, CanDrop: true, CanEquip: false, CanUse: true, CanDelete: true,
    Property1: 0, Property2: 0, Property3: 0, Property4: 0, Property5: 0, Property6: 0, Property7: 0, Property8: 0,
    BindType: 0, FusionType: 0, FusionRate: 0, FusionNeedRate: 0, RefineryLevel: 0, ReclaimValue: 0, ReclaimType: 0 };
  await h.db.insert(game.Shop_Goods).values(PRIZES.map(prize => ({ ...template, TemplateID: prize.templateId, Name: prize.name }))); await rebuild();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z")); random.fraction = 0.99;
  await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT IF EXISTS charge_native_second_mail_failure`);
  await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT IF EXISTS charge_native_receipt_failure`);
  await h.db.execute(sql`TRUNCATE app."ActivityActions",app."ActivityStates",app."ActivityWallet",app."EventClaims",
    member."Accounts",player."Sys_Users_Detail",player."Sys_Users_Goods",player."User_Messages"`);
  await h.db.execute(sql`UPDATE game."Shop_Goods" SET "CanEquip"=false,"MaxCount"=2`);
  await h.db.execute(sql`INSERT INTO member."Accounts" ("ID","UserName","PasswordHash") VALUES (1,'charge-native-test','tests-only'),(2,'other-charge-test','tests-only')`);
  await h.db.execute(sql`INSERT INTO player."Sys_Users_Detail" ("UserID","UserName","NickName","Sex","ForbidDate","IsFirst")
    VALUES (${uid},'charge-native-test','Charge native test',true,'2000-01-01',1),(${otherUid},'other-charge-test','Other test',true,'2000-01-01',1)`);
  await h.db.execute(sql`INSERT INTO app."ActivityWallet" ("UserID","Points","Earned") VALUES (${uid},1000,600)`);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await built?.app.close(); await h?.close();
  const root = realpathSync(tmpdir()), target = realpathSync(tmp), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Unsafe temporary test directory");
  rmSync(target, { recursive: true, force: true });
});

async function seedState(edit: (s: ActivityState) => void) {
  const s=(await saved())??createActivityState(new Date()); edit(s);
  await h.db.execute(sql`INSERT INTO app."ActivityStates" ("UserID","Activity","State") VALUES (${uid},'reference',${JSON.stringify(s)}::jsonb)
    ON CONFLICT ("UserID","Activity") DO UPDATE SET "State"=excluded."State"`);
}

describe("native charge through atomic account HTTP", () => {
  it("permits only exact public scene states and treasure bag origins while rejecting private payload fields", () => {
    noPrivatePayload(JSON.stringify({ nativeChristmasSnowfield: { scene: { state: "outside" }, attempt: { state: "none" }, challenges: [{ state: "dead" }] },
      nativeTreasure: { bag: [{ origin: "legacy-four-material" }, { origin: "original-catalog" }] } }));
    for (const invalid of [{ games: {} }, { seed: 1 }, { nativeChargeEffects: [] }, { nested: { state: "outside" } },
      { nativeChristmasSnowfield: { scene: { state: "dead" } } }, { nativeChristmasSnowfield: { challenges: { state: "dead" } } },
      { origin: "legacy-four-material" }, { nativeTreasure: { preview: [{ origin: "original-catalog" }] } },
      { nativeTreasure: { bag: [{ origin: "unknown" }] } }]) expect(() => noPrivatePayload(JSON.stringify(invalid))).toThrow();
  });
  it("keeps GET read-only and rejects foreign roles, fake prices, counts and malformed full tokens", async () => {
    await h.db.execute(sql`DELETE FROM app."ActivityWallet"`); const before=await persisted(),choice=(await snapshot()).nativeCharge.stateToken;
    expect((await built.app.inject({url:`/api/account/activities?characterId=${uid}`})).statusCode).toBe(401);
    expect((await post("charge-native",{type:"claim",index:1,tier:1,choice},randomUUID(),otherUid)).statusCode).toBe(403);
    for(const value of [{type:"claim",index:1,tier:1},{type:"claim",index:1,tier:1,choice,price:0},
      {type:"exchange",index:0,count:2,choice},{type:"exchange",index:7,count:1,choice},{type:"claim",index:1,tier:4,choice},
      {type:"exchange",index:0,count:1,choice,templateId:11019},{type:"exchange",index:0,count:1,choice,confirmed:true}]) {
      const response=await post("charge-native",value); expect([400,409],response.body).toContain(response.statusCode);
    }
    expect(await persisted()).toEqual(before); expect((await snapshot()).nativeCharge).toMatchObject({grossSpent:0,trackingStartedAt:null});
  });

  it("shares old points-gift claims and permits already-earned settlements after daily500", async () => {
    await action("points-gift",{type:"claim",tier:1}); expect((await snapshot()).nativeCharge.pages[1].tiers[0].claimed).toBe(true);
    const duplicate=await post("charge-native",{type:"claim",index:1,tier:1,choice:(await snapshot()).nativeCharge.stateToken}); expect([400,409]).toContain(duplicate.statusCode);
    await seedState(s=>{s.daily.actions=500;s.games.keep={untouched:true};});
    const claimed=await request({type:"claim",index:1,tier:3}); expect(claimed).toMatchObject({points:1000,earned:600,mailedCount:1});
    expect(claimed.nativeChargeAction!.effects).toMatchObject([{type:"claimed",claimKey:"points-gift:3",rewards:[{templateId:11019,count:9}]}]);
    expect((await post("points-gift",{type:"claim",tier:3})).statusCode).toBe(400);
    expect((await saved())!.daily.actions).toBe(500); expect((await saved())!.games.keep).toEqual({untouched:true});
    expect((await snapshot()).nativeCharge.exchange.rows.every(r=>!r.canExchange)).toBe(true);
  });

  it("uses only claimed UTC task points and rejects cross-day or changed-progress fingerprints", async () => {
    await seedState(s=>{s.daily.safe=8;s.daily.pairs=3;s.daily.draws=3;});
    expect((await snapshot()).nativeCharge.todayClaimedTaskPoints).toBe(0);
    await action("tasks",{type:"claim",choice:"mines"}); const old=(await snapshot()).nativeCharge.stateToken;
    await action("tasks",{type:"claim",choice:"pair"});
    expect((await post("charge-native",{type:"claim",index:0,tier:1,choice:old})).statusCode).toBe(400);
    const claimed=await request({type:"claim",index:0,tier:2}); expect(claimed.nativeCharge.todayClaimedTaskPoints).toBe(120);
    const previous=claimed.nativeCharge.stateToken; vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
    expect((await snapshot()).nativeCharge.todayClaimedTaskPoints).toBe(0);
    expect((await post("charge-native",{type:"claim",index:0,tier:1,choice:previous})).statusCode).toBe(400);
  });

  it("commits a confirmed exchange once, uses real stack splitting and replays after a reconstructed app without effects", async () => {
    const templates=await q(h,sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`);
    const value={type:"exchange",index:4,count:1,choice:(await snapshot()).nativeCharge.stateToken},requestId=randomUUID();
    const results=await Promise.all([native(value,requestId),native(value,requestId)]);
    expect(results.filter(r=>!r.replayed)).toHaveLength(1); expect(results.filter(r=>r.nativeChargeAction)).toHaveLength(1);
    const committed=results.find(r=>!r.replayed)!; expect(committed).toMatchObject({points:965,earned:600,nativeCharge:{grossSpent:35}});
    expect((await saved())!.daily.actions).toBe(1); expect((await persisted()).goods.map(r=>Number(r.Count))).toEqual([2,2,2]);
    expect((await persisted()).goods.every(r=>r.IsBinds&&Number(r.ValidDate)===0&&Number(r.TemplateID)===11019)).toBe(true);
    const delivered=await persisted(); await built.app.close(); await rebuild();
    const replay=await native(value,requestId); expect(replay.replayed).toBe(true); expect(replay.nativeChargeAction).toBeUndefined();
    expect(await persisted()).toEqual(delivered); expect((await post("charge-native",{...value,index:5},requestId)).statusCode).toBe(409);
    expect(await q(h,sql`SELECT * FROM game."Shop_Goods" ORDER BY "TemplateID"`)).toEqual(templates);
  });

  it("rolls back wallet, ledger, daily limit, receipts and all mail when delivery or the final receipt fails", async () => {
    for(const failure of ["mail","receipt"] as const) {
      const value={type:"claim",index:0,tier:1,choice:""}; await seedState(s=>{s.claims=["task:2026-10-15:sign"];});
      value.choice=(await snapshot()).nativeCharge.stateToken; const requestId=randomUUID(),before=await persisted();
      if(failure==="mail") await h.db.execute(sql`ALTER TABLE player."User_Messages" ADD CONSTRAINT charge_native_second_mail_failure CHECK ("Annex5" IS NOT NULL) NOT VALID`);
      else await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT charge_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
      const response=await post("charge-native",value,requestId); expect(response.statusCode,response.body).toBe(500); expect(await persisted()).toEqual(before);
      if(failure==="mail") await h.db.execute(sql`ALTER TABLE player."User_Messages" DROP CONSTRAINT charge_native_second_mail_failure`);
      else await h.db.execute(sql`ALTER TABLE app."ActivityActions" DROP CONSTRAINT charge_native_receipt_failure`);
      const retried=await native(value,requestId); expect(retried.nativeChargeAction!.effects).toMatchObject([{type:"claimed",index:0,tier:1}]);
      expect((await persisted()).receipts.filter(r=>r.RequestID===requestId)).toHaveLength(1);
    }
  });

  it("counts gross old/native costs once despite point returns and never counts recycling, replays or failed transactions", async () => {
    const old=await action("ddplay",{type:"spin"}); expect(old.points).toBeGreaterThan(1000); expect(old.nativeCharge.grossSpent).toBe(10);
    const moon=await action("moon",{type:"draw",count:1}); expect(moon.nativeCharge.grossSpent).toBe(30);
    await action("moon",{type:"recycle"}); expect((await snapshot()).nativeCharge.grossSpent).toBe(30);
    const snap=await snapshot(), beforeBlocked=await persisted();
    expect(snap.nativeTreasure.readiness.status).toBe("blocked");
    await action("treasure-native",{type:"draw",mode:"advanced",count:1,selection:[14,7,12,1],poolVersion:snap.nativeTreasure.poolVersion,
      choice:snap.nativeTreasure.bagToken},randomUUID(),400);
    expect(await persisted()).toEqual(beforeBlocked); expect((await snapshot()).nativeCharge.grossSpent).toBe(30);
    const value={type:"draw",count:3,choice:snap.nativeMoonlight.bagToken},requestId=randomUUID();
    const moonlight=await action("moonlight-native",value,requestId); expect(moonlight.nativeCharge.grossSpent).toBe(90);
    const replay=await action("moonlight-native",value,requestId); expect(replay.replayed).toBe(true); expect(replay.nativeCharge.grossSpent).toBe(90);
    await action("moon",{type:"recycle"}); expect((await snapshot()).nativeCharge.grossSpent).toBe(90);
    const exchange={type:"exchange",index:0,count:1,choice:(await snapshot()).nativeCharge.stateToken},before=await persisted();
    await h.db.execute(sql`ALTER TABLE app."ActivityActions" ADD CONSTRAINT charge_native_receipt_failure CHECK ("Signature"='cannot-pass-test') NOT VALID`);
    expect((await post("charge-native",exchange)).statusCode).toBe(500); expect(await persisted()).toEqual(before);
  });

  it("honors local qualification and UTC limits while preserving gross progress across midnight", async () => {
    await h.db.execute(sql`UPDATE app."ActivityWallet" SET "Earned"=99 WHERE "UserID"=${uid}`);
    const denied=await post("charge-native",{type:"exchange",index:2,count:1,choice:(await snapshot()).nativeCharge.stateToken}); expect(denied.statusCode).toBe(400);
    await request({type:"exchange",index:0,count:1});
    expect((await snapshot()).nativeCharge.exchange.rows[0]).toMatchObject({bought:1,remaining:0,canExchange:false});
    expect((await post("charge-native",{type:"exchange",index:0,count:1,choice:(await snapshot()).nativeCharge.stateToken})).statusCode).toBe(400);
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z")); const tomorrow=await snapshot();
    expect(tomorrow.nativeCharge).toMatchObject({grossSpent:15,todayClaimedTaskPoints:0}); expect(tomorrow.nativeCharge.exchange.rows[0].canExchange).toBe(true);
    expect((await request({type:"exchange",index:0,count:1})).nativeCharge.grossSpent).toBe(30);
  });
});
