/**
 * Dev database: a REAL Postgres (binaries shipped via npm `embedded-postgres`, nothing installed system-wide)
 * at packages/db/.data/pg on 127.0.0.1:5432 (env PG_PORT). Safe for many concurrent connections (api + game + studio).
 * DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/ddtank
 * First run initialises the cluster, creates DB "ddtank", migrates and seeds.
 */
import EmbeddedPostgres from "embedded-postgres";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, createDevAccounts, migrateDb, seedDatabase } from "../src/index.js";

const dir = process.env.PG_DIR ?? fileURLToPath(new URL("../.data/pg", import.meta.url));
const port = Number(process.env.PG_PORT ?? 5432);
const fresh = !existsSync(dir);
const password = process.env.PG_PASSWORD ?? "postgres";
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password, port, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "timezone=UTC", "-c", "log_timezone=UTC"] });
let started = false;
if (process.platform === "win32") {
  // embedded-postgres uses taskkill /f on Windows. Use PostgreSQL's own shutdown protocol,
  // including its registered exit hook, so normal stops complete a checkpoint.
  const require = createRequire(import.meta.url);
  const requirePg = createRequire(require.resolve("embedded-postgres"));
  const ctl = resolve(dirname(requirePg.resolve(`@embedded-postgres/windows-${process.arch}`)), "../native/bin/pg_ctl.exe");
  let shutdown: Promise<void> | undefined;
  pg.stop = () => !started ? Promise.resolve() : shutdown ??= new Promise<void>((res, rej) => {
    const child = spawn(ctl, ["stop", "-D", dir, "-m", "fast", "-w", "-t", "20"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let error = "";
    child.stderr.on("data", b => { error += b; });
    child.once("error", rej);
    child.once("exit", code => code === 0 ? res() : rej(new Error(`pg_ctl stop failed (${code}): ${error.trim()}`)));
  });
}
if (fresh) await pg.initialise();
await pg.start();
started = true;
const url = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/ddtank`;
if (fresh) {
  await pg.createDatabase("ddtank");
}
const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
let h;
try {
  h = await createDb(url);
  await migrateDb(h);
  if (fresh) {
    await seedDatabase(h);
    if (process.env.PG_SEED_DEV_ACCOUNTS !== "false") await createDevAccounts(h);
  }
  await h.close();
  h = undefined;
  if (process.env.PG_READY_FILE) writeFileSync(process.env.PG_READY_FILE, JSON.stringify({ pid: process.pid, port }));
  console.log(`Postgres ready: 127.0.0.1:${port}/ddtank${fresh ? " (new cluster: migrated, seeded)" : ""}`);
} catch (error) {
  await h?.close();
  await pg.stop();
  throw error;
}
