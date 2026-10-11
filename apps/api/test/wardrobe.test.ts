import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createDb, createDevAccounts, game, migrateDb, type DbHandle } from "@ddt/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { WardrobeCheckResult } from "../src/lib/wardrobe.js";

const tmp = mkdtempSync(join(tmpdir(), "ddt-wardrobe-"));
const resource = join(tmp, "resource"), uploads = join(tmp, "uploads");
let h: DbHandle;
let built: Awaited<ReturnType<typeof buildApp>>;
let auth: Record<string, string>, playerAuth: Record<string, string>;
const fixtures = new Map<string, string>();
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function chunk(type: string, body: Buffer): Buffer {
  const result = Buffer.alloc(body.length + 12);
  result.writeUInt32BE(body.length);
  result.write(type, 4, "ascii");
  body.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + body.length)) >>> 0, 8 + body.length);
  return result;
}
/** Synthetic PNG fixtures with actual compressed RGBA scanlines; these are not gameplay art. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}
function file(root: string, rel: string, body: Buffer) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  fixtures.set(path, hash(body));
}
function suit(pic: string, sex: string, layers: number[], showHeight = 312, gameWidth = 1482, gameHeight = 285) {
  const root = `image/equip/${sex}/suits/${pic}`;
  file(resource, `${root}/icon_1.png`, png(78, 78));
  for (const layer of layers) {
    file(resource, `${root}/${layer}/SHOW.PNG`, png(1000, showHeight));
    file(resource, `${root}/${layer}/game.png`, png(gameWidth, gameHeight));
    file(resource, `${root}/${layer}/game1.png`, png(gameWidth, gameHeight));
  }
}

beforeAll(async () => {
  suit("draft", "m", [1, 2, 3]);
  suit("neutral", "f", [1]);
  suit("raw815", "m", [1], 312, 1280, 282);
  file(resource, "image/equip/m/suits/raw815/icon_1.png", png(117, 78));
  file(resource, "image/equip/m/suits/raw815/1/game1.png", png(1280, 316));
  suit("tall", "m", [1], 342, 1482, 326);
  suit("twoframes", "m", [1]);
  suit("trailing", "m", [1]);
  file(resource, "image/equip/m/suits/trailing/1/game.png", Buffer.concat([png(1482, 285), Buffer.alloc(512, 0xa5)]));
  file(resource, "image/equip/m/suits/twoframes/1/SHOW.PNG", png(500, 312));
  file(resource, "image/equip/f/suits/incomplete/1/game.png", png(1, 1));
  file(resource, "image/equip/f/suits/incomplete/1/game1.png", Buffer.from("broken"));
  const corrupt = png(78, 78); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  file(resource, "image/equip/m/suits/corrupt/icon_1.png", corrupt);
  suit("overlay", "m", [1]);
  file(uploads, "image/equip/m/suits/overlay/1/game.png", png(1280, 282));
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await createDevAccounts(h);
  built = await buildApp({ db: h, logger: false, skipTemplates: true, env: {}, config: {
    NODE_ENV: "test", DB_MIGRATE: false, DB_SEED_IF_EMPTY: false, GAME_INTERNAL_URL: "",
    FLASH_DIR: join(tmp, "flash"), RESOURCE_DIR: resource, UPLOAD_DIR: uploads, PUBLIC_URL: "http://api.test",
  } });
  const login = async (username: string) => {
    const response = await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: username } });
    expect(response.statusCode).toBe(200);
    return { authorization: `Bearer ${response.json().token}` };
  };
  auth = await login("admin"); playerAuth = await login("test");
});

afterAll(async () => { await built?.app.close(); await h?.close(); });
const draft = (Pic: string, NeedSex = 1, Property8 = 1) => ({ CategoryID: 13, Pic, NeedSex, Property8 });
async function check(payload: Record<string, unknown>): Promise<WardrobeCheckResult> {
  const response = await built.app.inject({ method: "POST", url: "/api/admin/items/wardrobe-check", headers: auth, payload });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

describe("read-only suit draft checks", () => {
  it("uses existing admin authorization and rejects unsafe/unsupported drafts", async () => {
    const request = (headers: Record<string, string>, payload: Record<string, unknown>) => built.app.inject({ method: "POST", url: "/api/admin/items/wardrobe-check", headers, payload });
    expect((await request({}, draft("draft"))).statusCode).toBe(401);
    expect((await request(playerAuth, draft("draft"))).statusCode).toBe(403);
    for (const Pic of ["../secret", "nested/path", "nested\\path", "%2e%2e", ".", ".."]) expect((await request(auth, draft(Pic))).statusCode).toBe(400);
    expect((await request(auth, { ...draft("draft"), CategoryID: 5 })).statusCode).toBe(400);
    expect((await request(auth, draft("draft", 1, 102))).statusCode).toBe(400);
  });

  it("checks an unsaved draft with three actual layers, using case-insensitive resources", async () => {
    const result = await check({ ...draft("draft", 1, 123), TemplateID: 1399999 });
    expect(result).toMatchObject({ pathSex: "m", state: "ok", readOnly: true, renderingAccepted: false });
    expect(result.assets).toHaveLength(10);
    expect(result.assets.every((asset) => asset.state === "ok")).toBe(true);
    expect(result.assets.filter((asset) => asset.kind === "show").map((asset) => asset.layer)).toEqual([1, 2, 3]);
    expect(result.assets[0]?.url).toBe("http://api.test/resource/image/equip/m/suits/draft/icon_1.png");
    expect(result.assets[1]).toMatchObject({ width: 1000, height: 312, warnings: ["show-padding", "pixel-decode-unchecked"], frames: [
      { owner: "ShowCharacter", columns: 2, frameWidth: 250, frameHeight: 342, state: "ok" },
      { owner: "RoomCharacter", columns: 4, frameWidth: 250, frameHeight: 342, state: "ok" },
    ] });
    expect(await h.db.select().from(game.Shop_Goods)).toHaveLength(0);
    expect((await check(draft("draft", 1, 112))).assets).toHaveLength(7);
  });

  it("resolves neutral NeedSex 0 and female 2 through f, preserving the client contract", async () => {
    for (const sex of [0, 2]) {
      const result = await check(draft("neutral", sex));
      expect(result).toMatchObject({ pathSex: "f", state: "ok" });
      expect(result.assets.every((asset) => asset.path.includes("/f/suits/neutral/"))).toBe(true);
    }
  });

  it("distinguishes missing, placeholder and invalid PNG files", async () => {
    const result = await check(draft("incomplete", 2));
    expect(result.state).toBe("incomplete");
    expect(result.assets.map((asset) => asset.state)).toEqual(["missing", "missing", "placeholder", "invalid"]);
    expect((await check(draft("corrupt"))).assets[0]?.state).toBe("invalid");
  });

  it("keeps 815 incompatible and distinguishes Show's two frames from Room's four", async () => {
    const result = await check(draft("raw815"));
    expect(result.state).toBe("incompatible");
    expect(result.renderingAccepted).toBe(false);
    expect(result.assets.map((asset) => asset.state)).toEqual(["ok", "ok", "incompatible", "incompatible"]);
    expect(result.assets[0]?.warnings).toContain("icon-size");
    const two = await check(draft("twoframes"));
    expect(two.assets[1]?.frames.map((frame) => frame.state)).toEqual(["ok", "incompatible"]);
    const tall = await check(draft("tall"));
    expect(tall.assets[2]?.state).toBe("incompatible");
  });

  it("uses the upload overlay and does not alter files, rows or missing-resource counters", async () => {
    const result = await check(draft("overlay"));
    expect(result.assets[2]).toMatchObject({ width: 1280, state: "incompatible" });
    expect(result.assets[2]?.sha256).toBe(fixtures.get(join(uploads, result.assets[2]!.path)));
    for (const [path, before] of fixtures) expect(hash(readFileSync(path))).toBe(before);
    expect(await h.db.select().from(game.Shop_Goods)).toHaveLength(0);
    expect(built.ctx.resources.misses.size).toBe(0);
  });

  it("accepts a valid IEND with donor trailing bytes while retaining the full-file hash", async () => {
    const result = await check(draft("trailing"));
    expect(result.state).toBe("ok");
    expect(result.renderingAccepted).toBe(false);
    const asset = result.assets[2]!;
    const body = readFileSync(join(resource, asset.path));
    expect(asset).toMatchObject({ state: "ok", width: 1482, height: 285, bytes: body.length, sha256: hash(body) });
    expect(hash(body.subarray(0, -512))).not.toBe(asset.sha256);
  });
});
