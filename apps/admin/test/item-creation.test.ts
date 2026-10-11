import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createDevAccounts, game, migrateDb, seedDatabase, type DbHandle } from "../../../packages/db/src/index.js";
import { buildApp } from "../../api/src/app.js";
import { items } from "../src/resources/items.js";
import { buildSchema, copyForCreate, fromFormValues, toFormValues } from "../src/crud/schema.js";
import type { Row } from "../src/crud/types.js";

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
