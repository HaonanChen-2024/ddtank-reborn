import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createDb, migrateDb, type DbHandle } from "@ddt/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { APP_ROOT } from "../src/config.js";

const temp = mkdtempSync(join(tmpdir(), "ddt-flash-overlay-"));
const flashDir = join(temp, "flash");
const overlayDir = join(temp, "overlay");
const resourceDir = join(temp, "resources");
function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return chunk;
}
const header = Buffer.alloc(13);
header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(Buffer.alloc(18, 0))), pngChunk("IEND", Buffer.alloc(0))]);
const pngWithTail = Buffer.concat([png, Buffer.alloc(512, 0xff)]);
let h: DbHandle;
let deployed: FastifyInstance;
let defaults: FastifyInstance;

beforeAll(async () => {
  mkdirSync(flashDir, { recursive: true });
  mkdirSync(overlayDir, { recursive: true });
  mkdirSync(resourceDir, { recursive: true });
  for (const sex of ["M", "F"]) {
    const rel = `image/scene/christmas/workshop/cloth/${sex}/cloth/1.png`;
    for (const [root, body] of [[resourceDir, pngWithTail], [join(overlayDir, "native-resources"), png], ...(sex === "F" ? [[join(temp, "uploads"), pngWithTail]] : [])] as const) {
      const file = join(root as string, rel); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, body as Buffer);
    }
  }
  writeFileSync(join(resourceDir, "valid-tail.png"), pngWithTail);
  writeFileSync(join(resourceDir, "truncated.png"), png.subarray(0, png.length - 12));
  const bad = Buffer.from(png); bad[29] = bad[29]! ^ 1;
  writeFileSync(join(resourceDir, "bad-crc.png"), bad);
  writeFileSync(join(flashDir, "2.png"), "base-client");
  writeFileSync(join(flashDir, "base-only.txt"), "base-fallback");
  writeFileSync(join(flashDir, "config.xml"), '<root><config source="base"><REQUEST_PATH value="http://old/request/"/></config></root>');
  writeFileSync(join(overlayDir, "2.PNG"), "local-rsa-client");
  writeFileSync(join(overlayDir, "config.xml"), '<root><config source="deployment"><REQUEST_PATH value="http://old/request/"/></config></root>');
  h = await createDb("pglite:memory");
  await migrateDb(h);
  const options = {
    db: h,
    logger: false,
    skipTemplates: true,
    env: {},
    config: {
      NODE_ENV: "test" as const,
      FLASH_DIR: flashDir,
      RESOURCE_DIR: resourceDir,
      UPLOAD_DIR: join(temp, "uploads"),
      PUBLIC_URL: "http://api.test",
      GAME_INTERNAL_URL: "",
      RSA_USE_VENDOR_KEY: false,
      DB_MIGRATE: false,
      DB_SEED_IF_EMPTY: false,
    },
  };
  deployed = (await buildApp({ ...options, config: { ...options.config, FLASH_OVERLAY_DIR: overlayDir } })).app;
  defaults = (await buildApp(options)).app;
});

afterAll(async () => {
  await deployed?.close();
  await defaults?.close();
  await h?.close();
  rmSync(temp, { recursive: true, force: true });
});

describe("deployment Flash overlay", () => {
  it("serves journal-owned native scene resources below uploads, without changing the unset-overlay fallback", async () => {
    const rel = "/resource/image/scene/christmas/workshop/cloth/M/cloth/1.png";
    expect((await deployed.inject({ url: rel })).rawPayload).toEqual(png);
    expect((await defaults.inject({ url: rel })).rawPayload).toEqual(pngWithTail);
    expect((await deployed.inject({ url: rel.replace("/M/", "/F/") })).rawPayload).toEqual(pngWithTail);
    expect((await deployed.inject({ url: rel.toLowerCase() })).rawPayload).toEqual(png);
  });
  it("serves a valid donor PNG with trailing bytes and rejects corrupt or unterminated PNG data", async () => {
    expect((await deployed.inject({ url: "/resource/valid-tail.png" })).rawPayload).toEqual(pngWithTail);
    for (const path of ["bad-crc.png", "truncated.png"]) {
      const response = await deployed.inject({ url: `/resource/${path}` });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.readUInt32BE(16)).toBe(1);
      expect(response.rawPayload.readUInt32BE(20)).toBe(1);
    }
  });
  it("prefers the local client override to shipped and base copies, case-insensitively", async () => {
    const response = await deployed.inject({ url: "/flash/2.png" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("local-rsa-client");
  });

  it("falls back to the shipped overlay and then the base client", async () => {
    const base = await deployed.inject({ url: "/flash/base-only.txt" });
    expect(base.statusCode).toBe(200);
    expect(base.body).toBe("base-fallback");
    const name = "ui/vietnam/xml/xml.png";
    const shipped = await deployed.inject({ url: `/flash/${name}` });
    expect(shipped.statusCode).toBe(200);
    expect(shipped.rawPayload).toEqual(readFileSync(join(APP_ROOT, "assets", "flash", name)));
  });

  it("keeps config.xml dynamic even when its template comes from the deployment", async () => {
    const response = await deployed.inject({ url: "/flash/config.xml" });
    expect(response.body).toContain('source="deployment"');
    expect(response.body).toContain('value="http://api.test/request/"');
    expect(response.headers["cache-control"]).toBe("no-cache");
  });

  it("keeps the existing shipped-client and config behavior when the option is unset", async () => {
    const client = await defaults.inject({ url: "/flash/2.png" });
    expect(client.rawPayload).toEqual(readFileSync(join(APP_ROOT, "assets", "flash", "2.png")));
    const config = await defaults.inject({ url: "/flash/config.xml" });
    expect(config.body).toContain('source="base"');
    expect(config.body).toContain('value="http://api.test/request/"');
  });
});
