import { updateRank } from "./rank.js";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import { join } from "node:path";
import { app as appTables, createDb, game, migrateDb, seedDatabase, type DbHandle } from "@ddt/db";
import { parseDotNetRsaXml, rsaKeyFromPem, type RsaPrivateKey } from "@ddt/protocol";
import { count, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, type Config } from "./config.js";
import type { AppCtx } from "./context.js";
import { CiTree, ResourceIndex } from "./lib/resources.js";
import { createStorage } from "./lib/storage.js";
import { adminRoutes, applyServerConfig, sampleProcess } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { activityRoutes } from "./routes/activities.js";
import { publicRoutes } from "./routes/public.js";
import { requestRoutes } from "./routes/request.js";
import { staticRoutes } from "./routes/static.js";
import { TemplateCache } from "./templates/cache.js";

process.env.TZ = "UTC"; // DB timestamps are wall-clock values (packages/db README "Type mapping")

export interface BuildOptions {
  config?: Partial<Config>;
  env?: Record<string, string | undefined>;
  /** Use an existing DB handle (tests). */
  db?: DbHandle;
  logger?: boolean;
  /** Skip building all templates at boot (tests build what they need). */
  skipTemplates?: boolean;
}

export function parseRsaKey(text: string): RsaPrivateKey | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith("<")) {
    const k = parseDotNetRsaXml(t);
    return "d" in k ? (k as RsaPrivateKey) : null;
  }
  return rsaKeyFromPem(t);
}

export async function buildApp(o: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppCtx }> {
  const cfg = loadConfig(o.env ?? process.env, o.config);
  const f = Fastify({
    logger: o.logger === false ? false : { level: cfg.LOG_LEVEL },
    routerOptions: { caseSensitive: false, ignoreTrailingSlash: true, ignoreDuplicateSlashes: true },
    trustProxy: true,
    bodyLimit: cfg.MAX_UPLOAD_MB * 1024 * 1024,
  });
  const log = {
    info: (m: string) => f.log.info(m),
    warn: (m: string) => f.log.warn(m),
    error: (m: string | object, ...a: unknown[]) => f.log.error(m as object, ...(a as [])),
  };

  const h = o.db ?? (await createDb(cfg.DATABASE_URL));
  if (cfg.DB_MIGRATE) await migrateDb(h);
  if (cfg.DB_SEED_IF_EMPTY) {
    const [r] = await h.db.select({ n: count() }).from(game.Shop_Goods);
    if (!Number(r?.n)) {
      log.info("db: game templates empty -> seeding packages/db/seed");
      await seedDatabase(h);
    }
  }

  const rsa = parseRsaKey(cfg.rsaKeyText);
  if (!rsa) log.warn("RSA private key not configured: Login.ashx will reject every login (set RSA_PRIVATE_KEY)");
  else log.info(`RSA key: ${cfg.rsaKeySource}`);

  const storage = createStorage(cfg);
  const overlay = new CiTree(storage.kind === "local" ? cfg.UPLOAD_DIR : "");
  // Installer-owned activity scene files share the deployment journal, apart from client SWFs.
  const nativeResources = new CiTree(cfg.FLASH_OVERLAY_DIR ? join(cfg.FLASH_OVERLAY_DIR, "native-resources") : "");
  const resources = new ResourceIndex([overlay, nativeResources, new CiTree(cfg.RESOURCE_DIR)]);
  const cache = new TemplateCache(h, { snapshotDir: cfg.REQUEST_SNAPSHOT_DIR, log: (m) => log.info(m) });

  const ctx: AppCtx = { cfg, h, cache, rsa, storage, resources, startedAt: new Date(), log };

  const [sc] = await h.db.select().from(appTables.Settings).where(eq(appTables.Settings.key, "server-config")).limit(1);
  if (sc) applyServerConfig(ctx, sc.value as Record<string, unknown>);

  await f.register(cors, { origin: cfg.CORS_ORIGINS === "*" ? true : cfg.CORS_ORIGINS.split(",").map((s) => s.trim()), credentials: true });
  await f.register(formbody);
  await f.register(multipart, { limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024 } });
  // Flash sends GET with odd queries; accept any content-type for POSTs to .ashx
  f.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

  f.get("/healthz", async () => ({ ok: true }));
  await authRoutes(f, ctx);
  await activityRoutes(f, ctx);
  await publicRoutes(f, ctx);
  await adminRoutes(f, ctx);
  await requestRoutes(f, ctx);
  await staticRoutes(f, ctx);

  if (!o.skipTemplates) {
    await updateRank(h).catch((e) => log.error(e as object, "updateRank"));
    await cache.buildAll();
  }

  const timers: NodeJS.Timeout[] = [];
  if (cfg.CELEB_REBUILD_MIN > 0 && !o.skipTemplates)
    timers.push(setInterval(() => void updateRank(h).then(() => cache.buildAll((d) => !!d.periodic)).catch((e) => log.error(e as object)), cfg.CELEB_REBUILD_MIN * 60_000));
  timers.push(setInterval(sampleProcess, 60_000));
  for (const t of timers) t.unref();
  f.addHook("onClose", async () => {
    for (const t of timers) clearInterval(t);
    if (!o.db) await h.close();
  });
  return { app: f, ctx };
}
