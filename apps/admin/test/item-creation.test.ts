import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createDevAccounts, game, migrateDb, seedDatabase, type DbHandle } from "../../../packages/db/src/index.js";
import { buildApp } from "../../api/src/app.js";
import { Templates } from "../../game/src/db/templates.js";
import { setItemType } from "../../game/src/handlers/items.js";
import { items } from "../src/resources/items.js";
import { resourceByName } from "../src/resources/index.js";
import { buildSchema, copyForCreate, fromFormValues, toFormValues } from "../src/crud/schema.js";
import type { ResourceDef, Row } from "../src/crud/types.js";

const tmp = mkdtempSync(join(tmpdir(), "ddt-item-form-"));
let h: DbHandle;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
let auth: Record<string, string>;
let source: Row;
const schema = buildSchema(items.fields, "create", (key) => key, (text) => typeof text === "string" ? text : text?.["pt-BR"] ?? "");

beforeAll(async () => {
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await seedDatabase(h, { only: ["Shop_Goods"] });
  await createDevAccounts(h);
  source = (await h.db.select().from(game.Shop_Goods)).find((row) => row.CategoryID === 5 && row.NeedLevel <= 100)!;
  ({ app } = await buildApp({
    db: h,
    logger: false,
    env: {},
    skipTemplates: true,
    config: {
      NODE_ENV: "test", DB_MIGRATE: false, DB_SEED_IF_EMPTY: false,
      GAME_INTERNAL_URL: "", PUBLIC_URL: "http://api.test",
      FLASH_DIR: join(tmp, "flash"), RESOURCE_DIR: join(tmp, "resource"), UPLOAD_DIR: join(tmp, "uploads"),
    },
  }));
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
  expect(login.statusCode).toBe(200);
  auth = { authorization: `Bearer ${login.json().token}` };
}, 120_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

function formPayload(initial: Row | undefined, changes: Row): Row {
  const values = schema.parse({ ...toFormValues(items.fields, initial, "create"), ...changes });
  return { ...initial, ...fromFormValues(items.fields, values, "create") };
}

function resourcePayload(def: ResourceDef, changes: Row, initial?: Row, mode: "create" | "edit" = "create"): Row {
  const formSchema = buildSchema(def.fields, mode, key => key, text => typeof text === "string" ? text : text?.["zh-CN"] ?? "");
  const parsed = formSchema.parse({ ...toFormValues(def.fields, initial, mode), ...changes });
  return fromFormValues(def.fields, parsed, mode);
}

describe("item create form + API", () => {
  it("a new item's form defaults satisfy the real DB contract and rebuild the Flash template", async () => {
    const payload = formPayload(undefined, { TemplateID: 990001, Name: "Workshop clothing", CategoryID: 5, Pic: "workshop", CanEquip: true });
    const created = await app.inject({ method: "POST", url: "/api/admin/items", headers: auth, payload });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ TemplateID: 990001, Name: "Workshop clothing", Property8: 0, CanRecycle: 0, ReclaimValue: 0 });
    const xml = await app.inject({ url: "/request/templatealllist.xml" });
    expect(inflateSync(xml.rawPayload).toString("utf8")).toContain('Name="Workshop clothing"');
  }, 20_000);

  it("copy keeps category-specific and hidden columns, requires a new id, and leaves the source unchanged", async () => {
    const initial = copyForCreate(items, source);
    expect(initial.TemplateID).toBeUndefined();
    expect(source.TemplateID).toBeDefined();
    const payload = formPayload(initial, { TemplateID: 990002, Name: "Copied clothing" });
    const created = await app.inject({ method: "POST", url: "/api/admin/items", headers: auth, payload });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ Property1: source.Property1, Property7: source.Property7, Colors: source.Colors, Count: source.Count });
    const original = await app.inject({ url: `/api/admin/items/${source.TemplateID}`, headers: auth });
    expect(original.json().Name).toBe(source.Name);
    const collision = await app.inject({ method: "POST", url: "/api/admin/items", headers: auth, payload: { ...payload, TemplateID: source.TemplateID } });
    expect(collision.statusCode).toBe(409);
    expect((await app.inject({ url: `/api/admin/items/${source.TemplateID}`, headers: auth })).json().Name).toBe(source.Name);
  }, 20_000);

  it("rejects missing required numeric properties and names longer than the DB's 50 characters", () => {
    const values = { ...toFormValues(items.fields, undefined, "create"), TemplateID: 990003, Name: "Valid name" };
    expect(schema.safeParse({ ...values, Property2: "" }).success).toBe(false);
    expect(schema.safeParse({ ...values, Name: "a".repeat(51) }).success).toBe(false);
    expect(schema.safeParse({ ...values, Name: "a".repeat(50) }).success).toBe(true);
  });

  it("nested asset folders immediately serve the uploaded bytes through the Flash resource overlay", async () => {
    const boundary = "ddt-item-form";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="folder"\r\n\r\nimage/equip/m/cloth/workshop/1\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="show.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await app.inject({ method: "POST", url: "/api/admin/assets", headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect(uploaded.json().key).toBe("image/equip/m/cloth/workshop/1/show.png");
    const resource = await app.inject({ url: "/resource/IMAGE/EQUIP/M/CLOTH/WORKSHOP/1/SHOW.PNG" });
    expect(resource.rawPayload).toEqual(png);
    expect(resource.headers["x-placeholder"]).toBeUndefined();
  });
});

describe("registered shop forms + existing API and game template owners", () => {
  it("creates a normal item, preserves all three costs in Flash XML/game pricing, and registers its display entry", async () => {
    const shop = resourceByName.get("shop")!, display = resourceByName.get("shop-show")!;
    const item = await app.inject({ method: "POST", url: "/api/admin/items", headers: auth, payload: formPayload(undefined, { TemplateID: 990010, Name: "Workshop material", CategoryID: 11, Pic: "symbol3" }) });
    expect(item.statusCode, item.body).toBe(201);
    const payload = resourcePayload(shop, {
      ID: "990011", ShopID: "1", TemplateID: "990010", BuyType: "1", AUnit: "1", BUnit: "-1", CUnit: "-1", Beat: "0.8",
      APrice1: "-1", AValue1: "159", APrice2: "-4", AValue2: "8", APrice3: "11408", AValue3: "2",
      StartDate: "2025-01-01T00:00", EndDate: "2050-01-01T00:00",
    });
    const created = await app.inject({ method: "POST", url: "/api/admin/shop", headers: auth, payload });
    expect(created.statusCode, created.body).toBe(201);
    const shopXml = await app.inject({ url: "/request/ShopItemList.xml" });
    const text = inflateSync(shopXml.rawPayload).toString("utf8"), line = text.split("\n").find(value => value.includes('ID="990011"'))!;
    expect(line).toContain('APrice1="-1" AValue1="159"');
    expect(line).toContain('APrice2="-4" AValue2="8"');
    expect(line).toContain('APrice3="11408" AValue3="2"');
    const templates = await new Templates().load(h.db, 1);
    expect(templates.findItem(990010)?.CategoryID).toBe(11);
    expect(templates.isOnShop(990011)).toBe(false);
    const totals = { gold: 0, money: 0, offer: 0, gifttoken: 0, petScore: 0, score: 0, dmgScore: 0 };
    expect(setItemType(templates.shop.get(990011)!, 1, totals)).toEqual([11408, 2]);
    expect(totals).toMatchObject({ money: 127, gifttoken: 6, gold: 0 });
    const shown = await app.inject({ method: "POST", url: "/api/admin/shop-show", headers: auth, payload: resourcePayload(display, { Type: "25", ShopId: "990011" }) });
    expect(shown.statusCode, shown.body).toBe(201);
    expect(shown.json().TempID).toBeGreaterThan(0);
    const displayXml = await app.inject({ url: "/request/ShopGoodsShowList.xml" });
    expect(inflateSync(displayXml.rawPayload).toString("utf8")).toContain('Type="25" ShopId="990011"');
    await templates.load(h.db, 1);
    expect(templates.isOnShop(990011)).toBe(true);
  }, 20_000);

  it("edits prices while preserving the original disabled tier sentinels", async () => {
    const shop = resourceByName.get("shop")!;
    const created = await app.inject({ method: "POST", url: "/api/admin/shop", headers: auth, payload: resourcePayload(shop, { ID: 990012, ShopID: 1, TemplateID: source.TemplateID, AUnit: 7, AValue1: 159, CUnit: -1, CValue1: -1, IsBind: "1", IsVouch: "1" }) });
    expect(created.statusCode, created.body).toBe(201);
    const edited = await app.inject({ method: "PATCH", url: "/api/admin/shop/990012", headers: auth, payload: resourcePayload(shop, { AValue1: "100" }, created.json(), "edit") });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ APrice1: -1, AValue1: 100, CUnit: -1, CValue1: -1, IsBind: 1, IsVouch: 1 });
  }, 20_000);

  it("uses the existing form validation for integral costs and rejects malformed values", () => {
    const shop = resourceByName.get("shop")!, display = resourceByName.get("shop-show")!;
    const base = { ID: 990013, ShopID: 1, TemplateID: source.TemplateID };
    expect(() => resourcePayload(shop, { ...base, AValue1: "not-a-number" })).toThrow();
    expect(() => resourcePayload(shop, { ...base, AValue1: 1.5 })).toThrow();
    expect(() => resourcePayload(shop, { ...base, AValue1: -2 })).toThrow();
    expect(() => resourcePayload(shop, { ...base, APrice1: 11408.5 })).toThrow();
    expect(() => resourcePayload(display, { Type: 25 })).toThrow();
  });
});
