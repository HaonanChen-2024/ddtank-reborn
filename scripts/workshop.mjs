#!/usr/bin/env node
// Project-local stack: a persistent embedded Postgres shared by API and game.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = resolve(repo, "..", "..");
const runtime = join(project, "runtime");
const envFile = join(repo, ".env.workshop");
const settings = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
for (const key of ["FLASH_DIR", "FLASH_OVERLAY_DIR", "RESOURCE_DIR", "RUFFLE_DIR", "RSA_PRIVATE_KEY_FILE", "UPLOAD_DIR"]) {
  if (settings[key]) settings[key] = resolve(repo, settings[key]);
}
const ports = { db: 55432, api: 8080, game: 9200, ws: 9300, policy: 843, control: 9400, web: 5173, admin: 5174 };
const lanArgument = process.argv.find(arg => arg === "--lan" || arg.startsWith("--lan="));
let publicHost = "127.0.0.1";
let databaseName = "ddtank";
let restored;
const lockFile = join(runtime, "workshop-session.json");
const runId = randomUUID();
const controlPipe = process.platform === "win32" ? `\\\\.\\pipe\\ddtank-workshop-${runId}` : join(runtime, `control-${runId}.sock`);
const children = [];
let control;
let stopping = false;
let acquired = false;
let shutdown;
let rejectFailure;
const failure = new Promise((_resolve, reject) => { rejectFailure = reject; });
failure.catch(() => {});

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
function readSession() {
  try { return JSON.parse(readFileSync(lockFile, "utf8")); } catch { return null; }
}
function saveSession() {
  if (acquired) writeFileSync(lockFile, JSON.stringify({ runId, controlPipe, managerPid: process.pid, startedAt, publicHost, databaseName, children: children.filter((c) => c.exitCode === null && c.signalCode === null).map((c) => ({ name: c.workshopName, pid: c.pid })), ports }, null, 2));
}
const startedAt = new Date().toISOString();
export async function selectRestoredBackup(args, dataDir) {
  const options = args.filter(arg => arg === "--restored" || arg.startsWith("--restored="));
  if (!options.length) return null;
  if (options.length !== 1 || !options[0].startsWith("--restored=") || !options[0].slice(11)) throw new Error("使用 start --restored=完整的备份.dump.json路径");
  // The optional mode must never initialise an empty cluster or create a substitute database.
  if (!existsSync(join(dataDir, "PG_VERSION"))) throw new Error("恢复副本需要已有 PostgreSQL 存档；不会新建空库");
  const { readRestoredBackup } = await import("./workshop-backup.mjs");
  return readRestoredBackup(options[0].slice(11));
}
function acquireSession() {
  mkdirSync(runtime, { recursive: true });
  if (existsSync(lockFile)) {
    const session = readSession();
    // A recorded PID is never a reason to kill a process. Be conservative on stale/ambiguous files.
    if (!session || alive(session.managerPid) || session.children?.some((c) => alive(c.pid))) {
      throw new Error("存在运行中或状态不明的启动记录；不会停止其进程。请先检查 workshop status。");
    }
    unlinkSync(lockFile);
  }
  closeSync(openSync(lockFile, "wx"));
  acquired = true;
  saveSession();
}

export function selectLanHost(requested, interfaces = networkInterfaces()) {
  const privateIPv4 = address => {
    if (net.isIP(address) !== 4) return false;
    const [a, b] = address.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  };
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? []).filter(item => !item.internal && privateIPv4(item.address) &&
      (requested || !/VMware|Virtual|Hyper-V|WSL|VPN|TAP|TUN|Mihomo|Clash/i.test(name))).map(item => item.address));
  if (requested) {
    if (!candidates.includes(requested)) throw new Error("局域网地址必须是本机网卡上的私有 IPv4 地址");
    return requested;
  }
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) throw new Error("无法唯一确定局域网网卡；请使用 start --lan=本机私有IPv4");
  return unique[0];
}
const listenerHost = (name, host) => ["db", "control", "admin"].includes(name) ? "127.0.0.1" : host;
export function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolveOpen) => {
    const socket = net.connect({ host, port });
    let finished = false;
    const finish = (open) => { if (!finished) { finished = true; socket.destroy(); resolveOpen(open); } };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
export async function ensurePortsFree(required, host = "127.0.0.1") {
  const occupied = (await Promise.all(Object.entries(required).map(async ([name, port]) => {
    const target = listenerHost(name, host);
    return await portOpen(port) || (target !== "127.0.0.1" && await portOpen(port, target)) ? `${name}:${port}` : null;
  }))).filter(Boolean);
  if (occupied.length) throw new Error(`端口已占用：${occupied.join(", ")}；不会停止已有进程。`);
}
async function waitReady(name, ready, timeout = 120_000) {
  await Promise.race([failure, (async () => {
    const end = Date.now() + timeout;
    while (!stopping && Date.now() < end) {
      if (await ready()) return;
      await delay(400);
    }
    throw new Error(`${name} 未在时限内就绪`);
  })()]);
}
const httpReady = async (url, token) => {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000), headers: token ? { Authorization: `Bearer ${token}` } : {} })).ok; } catch { return false; }
};

function runNode(name, code, env, cwd = repo, once = false) {
  const stopHook = `process.on("message", message => { if (message === "workshop-stop") process.emit("SIGTERM", "SIGTERM"); });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", stopHook + code], {
    cwd, env, windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.workshopName = name;
  children.push(child);
  saveSession();
  child.once("error", (error) => rejectFailure(new Error(`${name}: ${error.message}`)));
  child.once("exit", (code, signal) => {
    saveSession();
    if (!stopping && (!once || code !== 0)) rejectFailure(new Error(`${name} 已退出 (${code ?? signal})`));
  });
  return child;
}
function runEntry(name, entry, env) {
  return runNode(name, `await import(${JSON.stringify(pathToFileURL(join(repo, entry)).href)});`, env);
}
export async function stopOwnedChild(child, timeout = child.workshopName === "db" ? 30_000 : 10_000) {
  let forced = false;
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  if (!hasExited() && child.pid) {
    const exited = new Promise(resolveExit => child.once("exit", resolveExit));
    if (child.connected) child.send("workshop-stop", () => {});
    await Promise.race([exited, delay(timeout)]);
    if (!hasExited()) {
      forced = true;
      child.kill("SIGTERM"); // Only a ChildProcess created by this run, never a historical PID.
      await Promise.race([exited, delay(2000)]);
    }
  }
  return { name: child.workshopName, pid: child.pid, stopped: hasExited(), forced, exitCode: child.exitCode, signal: child.signalCode, graceful: hasExited() && !forced && child.exitCode === 0 };
}
async function stop() {
  if (shutdown) return shutdown;
  stopping = true;
  shutdown = (async () => {
    // Stop game before DB so its normal SIGTERM handler can save player state.
    const outcomes = [];
    for (const child of [...children].reverse()) outcomes.push(await stopOwnedChild(child));
    const result = { runId, stoppedAt: new Date().toISOString(), normal: outcomes.every(child => child.graceful), allStopped: outcomes.every(child => child.stopped), children: outcomes };
    writeFileSync(join(runtime, "last-shutdown.json"), JSON.stringify(result, null, 2));
    if (result.allStopped) control?.close();
    if (result.normal && acquired && readSession()?.runId === runId) { unlinkSync(lockFile); acquired = false; }
    else saveSession(); // Keep an abnormal or incomplete shutdown visible; never claim it saved normally.
    return result;
  })();
  return shutdown;
}

async function start() {
  if (!existsSync(envFile)) throw new Error(`缺少本地配置：${envFile}`);
  const data = join(runtime, "data", "postgres");
  restored = await selectRestoredBackup(process.argv.slice(3), data);
  databaseName = restored?.database ?? "ddtank";
  publicHost = lanArgument ? selectLanHost(lanArgument.startsWith("--lan=") ? lanArgument.slice(6) : undefined) : "127.0.0.1";
  await ensurePortsFree(ports, publicHost);
  for (const key of ["FLASH_DIR", "RESOURCE_DIR", "RUFFLE_DIR", "RSA_PRIVATE_KEY_FILE"]) {
    if (!settings[key] || !existsSync(settings[key])) throw new Error(`配置路径缺失或不存在：${key}`);
  }
  for (const key of ["JWT_SECRET", "ADMIN_TOKEN", "PG_PASSWORD"]) {
    if (!settings[key] || settings[key].length < 16) throw new Error(`需配置随机本地值：${key}`);
  }
  acquireSession();
  process.once("SIGINT", () => { void stop().then(result => process.exit(result.normal ? 0 : 1)); });
  process.once("SIGTERM", () => { void stop().then(result => process.exit(result.normal ? 0 : 1)); });
  const databaseUrl = `postgres://postgres:${encodeURIComponent(settings.PG_PASSWORD)}@127.0.0.1:${ports.db}/${databaseName}`;
  const env = {
    ...process.env, ...settings, TZ: "UTC", NODE_ENV: "development",
    DATABASE_URL: databaseUrl, PG_DATABASE: databaseName, PG_DIR: data, PG_PORT: String(ports.db), PG_SEED_DEV_ACCOUNTS: "false",
    PG_READY_FILE: join(runtime, "postgres-ready.json"),
    HOST: publicHost, PORT: String(ports.api), PUBLIC_URL: `http://${publicHost}:${ports.api}`,
    SITE_URL: `http://${publicHost}:${ports.web}`, SERVER_ID: "4",
    BIND_HOST: publicHost, PUBLIC_HOST: publicHost, GAME_HOST: publicHost, GAME_PORT: String(ports.game),
    WS_PORT: String(ports.ws), WS_PATH: "/ws", WS_ENABLED: "true",
    GAME_WS_URL: `ws://${publicHost}:${ports.ws}/ws`, WS_PUBLIC_URL: `ws://${publicHost}:${ports.ws}/ws`,
    POLICY_ENABLED: "true", POLICY_PORT: String(ports.policy),
    ADMIN_ENABLED: "true", ADMIN_HOST: "127.0.0.1", ADMIN_PORT: String(ports.control),
    GAME_INTERNAL_URL: `http://127.0.0.1:${ports.control}`, GAME_INTERNAL_TOKEN: settings.ADMIN_TOKEN,
    CORS_ORIGINS: `http://${publicHost}:${ports.web},http://127.0.0.1:${ports.admin}`,
    WS_ALLOWED_ORIGINS: `http://${publicHost}:${ports.web},http://127.0.0.1:${ports.admin}`,
    RSA_USE_VENDOR_KEY: "false", DEV_ALLOW_ANY_TICKET: "false", DB_MIGRATE: "false", DB_SEED_IF_EMPTY: "false",
    VITE_USE_MOCKS: "false", VITE_API_PROXY_TARGET: `http://${publicHost}:${ports.api}`,
  };
  // Do not inherit a conflicting inline RSA key or a test-only fight engine from the calling shell.
  delete env.RSA_PRIVATE_KEY;
  delete env.FIGHT_ENGINE;
  try {
    control = net.createServer(socket => {
      socket.setTimeout(2000, () => socket.destroy());
      let input = "";
      socket.on("data", data => {
        input += data;
        if (input.length > 256) return socket.destroy();
        if (!input.includes("\n")) return;
        socket.removeAllListeners("data");
        let command;
        try { command = JSON.parse(input); } catch { return socket.destroy(); }
        if (command.runId !== runId || command.action !== "stop") return socket.destroy();
        socket.setTimeout(0);
        void stop().then(result => socket.end(result.normal ? "stopped\n" : "abnormal\n", () => {
          if (result.allStopped) process.exit(result.normal ? 0 : 1);
        }));
      });
      socket.on("error", () => {});
    });
    await new Promise((res, rej) => control.once("error", rej).listen(controlPipe, res));
    const db = runEntry("db", "packages/db/scripts/serve-pg.ts", env);
    await waitReady("数据库初始化", () => existsSync(join(runtime, "postgres-ready.json")) && (() => {
      try {
        const ready = JSON.parse(readFileSync(join(runtime, "postgres-ready.json"), "utf8"));
        return ready.pid === db.pid && ready.databaseName === databaseName;
      }
      catch { return false; }
    })());
    if (restored) {
      const { readRestoredBackup, confirmRestoredDatabase } = await import("./workshop-backup.mjs");
      // Re-read the proof after DB startup; no game/API writes precede this confirmation.
      const current = readRestoredBackup(restored.path);
      if (current.database !== databaseName || current.restoreProofSha256 !== restored.restoreProofSha256) throw new Error("恢复证明在启动期间发生变化");
      await confirmRestoredDatabase(current, data, join(runtime, "restored-databases", databaseName + ".json"));
    }
    runEntry("api", "apps/api/src/index.ts", env);
    await waitReady("API", () => httpReady(`${env.PUBLIC_URL}/healthz`));
    runEntry("game", "apps/game/src/index.ts", env);
    await waitReady("游戏服务", () => httpReady(`${env.GAME_INTERNAL_URL}/status`, env.ADMIN_TOKEN));
    for (const name of ["web", "admin"]) {
      const host = listenerHost(name, publicHost);
      runNode(name, `
        const { createServer } = await import("vite");
        const server = await createServer({ server: { host: ${JSON.stringify(host)}, port: ${ports[name]}, strictPort: true } });
        process.once("SIGTERM", () => { void server.close().then(() => process.exit(0)); });
        await server.listen();
      `, env, join(repo, "apps", name));
      await waitReady(name, () => httpReady(`http://${host}:${ports[name]}`));
    }
    console.log(`服务就绪：游戏 http://${publicHost}:${ports.web}  管理 http://127.0.0.1:${ports.admin}  存档 ${databaseName}`);
    console.log("Ctrl+C 正常保存并停止本次服务。");
    await failure;
  } finally { if (!(await stop()).normal) process.exitCode = 1; }
}

async function stopCurrent() {
  const session = readSession();
  if (!session) { console.log("没有本项目的启动记录。"); return; }
  if (!session.controlPipe || !alive(session.managerPid)) throw new Error("启动记录没有可用的控制通道；不会按历史 PID 停止进程。");
  await new Promise((res, rej) => {
    const socket = net.connect(session.controlPipe, () => socket.write(JSON.stringify({ runId: session.runId, action: "stop" }) + "\n"));
    let answer = "";
    socket.on("data", data => { answer += data; });
    socket.once("error", rej);
    socket.setTimeout(60_000, () => { socket.destroy(); rej(new Error("正常停止未在时限内完成；不会强制终止其他进程。")); });
    socket.once("end", () => answer.trim() === "stopped" ? res() : rej(new Error("未确认正常保存与停止；详见 runtime/last-shutdown.json，异常记录已保留")));
  });
  console.log("已正常停止本次项目服务。");
}

async function status() {
  const session = readSession();
  const host = session?.publicHost ?? "127.0.0.1";
  console.log(JSON.stringify({
    manager: session ? { pid: session.managerPid, alive: alive(session.managerPid), startedAt: session.startedAt } : null,
    databaseName: session?.databaseName ?? "ddtank",
    gameUrl: `http://${host}:${ports.web}`,
    children: session?.children?.map((c) => ({ ...c, alive: alive(c.pid) })) ?? [],
    listening: Object.fromEntries(await Promise.all(Object.entries(ports).map(async ([name, port]) => {
      const address = listenerHost(name, host);
      return [name, { host: address, port, open: await portOpen(port, address) }];
    }))),
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? "status";
  try {
    if (command === "start") await start();
    else if (command === "status") await status();
    else if (command === "stop") await stopCurrent();
    else throw new Error("usage: node scripts/workshop.mjs start [--lan[=IPv4]] [--restored=backup.dump.json] | stop | status");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
