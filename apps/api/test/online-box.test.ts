import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, createDevAccounts, game, migrateDb, seedDatabase, type DbHandle } from "@ddt/db";
import { asc } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const tmp = mkdtempSync(join(tmpdir(), "ddt-online-box-"));
let h: DbHandle;
let built: Awaited<ReturnType<typeof buildApp>>;
let auth: Record<string, string>, playerAuth: Record<string, string>;
let originalOnline: (typeof game.User_Box.$inferSelect)[];
let originalLegacy: (typeof game.LoadUserBox.$inferSelect)[];
const tiers = [
  { ID: 1, Type: 0, Level: 60, Condition: 15, TemplateID: 1120090 },
  { ID: 2, Type: 0, Level: 60, Condition: 40, TemplateID: 1120091 },
  { ID: 3, Type: 0, Level: 60, Condition: 60, TemplateID: 1120092 },
  { ID: 4, Type: 0, Level: 60, Condition: 75, TemplateID: 1120093 },
];

beforeAll(async () => {
  // Fixed isolated database: never read environment or attach to the running game DB.
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await seedDatabase(h, { only: ["game.User_Box", "game.LoadUserBox"] });
  await createDevAccounts(h);
  originalOnline = await h.db.select().from(game.User_Box).orderBy(asc(game.User_Box.ID));
  originalLegacy = await h.db.select().from(game.LoadUserBox).orderBy(asc(game.LoadUserBox.ID));
  built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config: {
    NODE_ENV: "test", DB_MIGRATE: false, DB_SEED_IF_EMPTY: false, GAME_INTERNAL_URL: "",
    FLASH_DIR: join(tmp, "flash"), RESOURCE_DIR: join(tmp, "resource"), UPLOAD_DIR: join(tmp, "uploads"), PUBLIC_URL: "http://api.test",
  } });
  const login = async (username: string) => {
    const response = await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: username } });
    expect(response.statusCode).toBe(200);
    return { authorization: `Bearer ${response.json().token}` };
  };
  auth = await login("admin");
  playerAuth = await login("test");
});

afterAll(async () => { await built?.app.close(); await h?.close(); });
const get = (url: string, headers = auth) => built.app.inject({ url, headers });

describe("read-only online boxes", () => {
  it("keeps the existing admin authentication for list, detail and writes", async () => {
    for (const [headers, status] of [[{}, 401], [playerAuth, 403]] as const) {
      for (const url of ["/api/admin/online-box", "/api/admin/online-box/1"]) {
        expect((await get(url, headers)).statusCode).toBe(status);
      }
      expect((await built.app.inject({ method: "POST", url: "/api/admin/online-box", headers, payload: tiers[0] })).statusCode).toBe(status);
      for (const method of ["PATCH", "DELETE"] as const) {
        expect((await built.app.inject({ method, url: "/api/admin/online-box/1", headers })).statusCode).toBe(status);
      }
    }
  });

  it("lists the actual User_Box four tiers, including the 75-minute fourth tier", async () => {
    const response = await get("/api/admin/online-box?Type=1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: tiers, total: 4, page: 1, pageSize: 20 });
    expect(originalOnline.filter((row) => row.Type === 0)).toEqual(tiers);
    expect(originalLegacy.filter((row) => row.Type === 0).map((row) => [row.ID, row.Condition, row.TemplateID])).toEqual([
      [1, 15, 1120090], [2, 40, 1120091], [4, 60, 1120093], [31, 60, 1120094],
    ]);
  });

  it("filters before counting and paging, with stable ID ordering for equal sort values", async () => {
    expect((await get("/api/admin/online-box?page=1&pageSize=2&sort=Level")).json()).toEqual({ items: tiers.slice(0, 2), total: 4, page: 1, pageSize: 2 });
    expect((await get("/api/admin/online-box?page=2&pageSize=2&sort=Level")).json()).toEqual({ items: tiers.slice(2), total: 4, page: 2, pageSize: 2 });
    expect((await get("/api/admin/online-box?page=3&pageSize=2")).json()).toEqual({ items: [], total: 4, page: 3, pageSize: 2 });
    expect((await get("/api/admin/online-box?sort=-Condition")).json().items).toEqual([...tiers].reverse());
    expect((await get("/api/admin/online-box?q=75")).json()).toEqual({ items: [tiers[3]], total: 1, page: 1, pageSize: 20 });
    expect((await get("/api/admin/online-box?q=999999")).json()).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it("never exposes User_Box Type 1/2 through detail or list searches", async () => {
    for (const type of [1, 2]) {
      const row = originalOnline.find((box) => box.Type === type)!;
      expect(row).toBeDefined();
      expect((await get(`/api/admin/online-box/${row.ID}`)).statusCode).toBe(404);
      const matches = (await get(`/api/admin/online-box?q=${row.ID}`)).json().items as typeof tiers;
      expect(matches.every((box) => box.Type === 0)).toBe(true);
      expect(matches.some((box) => box.ID === row.ID)).toBe(false);
    }
    expect((await get("/api/admin/online-box/1")).json()).toEqual(tiers[0]);
    for (const id of ["missing", "1.5", "2147483648", "999999"]) {
      expect((await get(`/api/admin/online-box/${id}`)).statusCode).toBe(404);
    }
  });

  it("rejects all online writes without changing any User_Box data", async () => {
    expect((await built.app.inject({ method: "POST", url: "/api/admin/online-box", headers: auth, payload: { ...tiers[0], ID: 999999 } })).statusCode).toBe(405);
    for (const id of [1, originalOnline.find((box) => box.Type === 1)!.ID]) {
      expect((await built.app.inject({ method: "PATCH", url: `/api/admin/online-box/${id}`, headers: auth, payload: { Condition: 1 } })).statusCode).toBe(405);
      expect((await built.app.inject({ method: "DELETE", url: `/api/admin/online-box/${id}`, headers: auth })).statusCode).toBe(405);
    }
    expect(await h.db.select().from(game.User_Box).orderBy(asc(game.User_Box.ID))).toEqual(originalOnline);
  });

  it("preserves the legacy time-box API and its Type 0 CRUD without changing online rewards", async () => {
    const listed = await get("/api/admin/time-box?pageSize=500");
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ items: originalLegacy, total: originalLegacy.length, page: 1, pageSize: 500 });
    expect((await get("/api/admin/time-box/31")).json()).toEqual(originalLegacy.find((box) => box.ID === 31));
    const legacy = { ID: 9876543, Type: 0, Level: 60, Condition: 19, TemplateID: 1120090 };
    expect((await built.app.inject({ method: "POST", url: "/api/admin/time-box", headers: auth, payload: legacy })).statusCode).toBe(201);
    const updated = await built.app.inject({ method: "PATCH", url: `/api/admin/time-box/${legacy.ID}`, headers: auth, payload: { Condition: 21 } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ ...legacy, Condition: 21 });
    expect((await built.app.inject({ method: "DELETE", url: `/api/admin/time-box/${legacy.ID}`, headers: auth })).statusCode).toBe(204);
    expect(await h.db.select().from(game.LoadUserBox).orderBy(asc(game.LoadUserBox.ID))).toEqual(originalLegacy);
    expect((await get("/api/admin/online-box")).json().items).toEqual(tiers);
  });
});
