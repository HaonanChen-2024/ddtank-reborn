/** Real HTTP + encrypted TCP/WS smoke against the project-local stack. No mocks or auth bypass. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { inflateSync } from "node:zlib";
import { Accounts, createDb, findAccount } from "@ddt/db";
import { buildLoginPayload, bytesToBase64, parseDotNetRsaXml, rsaEncryptPkcs1, type RsaPrivateKey } from "@ddt/protocol";
import { eq } from "drizzle-orm";
import { FakeClient } from "../../game/test/helpers.js";

process.env.TZ = "UTC";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtime = resolve(repo, "../../runtime");
const env = parseEnv(readFileSync(resolve(repo, ".env.workshop"), "utf8"));
const base = "http://127.0.0.1:8080";
const credentialsFile = resolve(runtime, "credentials/smoke-accounts.json");
const reportFile = resolve(runtime, "live-smoke.json");
const previous = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : null;
type Account = { username: string; password: string; nickname: string; sex: boolean; admin?: boolean };
type Auth = { token: string; user: { role: string }; play: { flashvars: { key: string } } };
type Receipt = { date: string; checks: string[]; characters: { username: string; id: number; nickname: string; gold: number; money: number }[]; ok: boolean; error?: string };
const receipt: Receipt = { date: new Date().toISOString(), checks: [], characters: [], ok: false };
mkdirSync(dirname(credentialsFile), { recursive: true });
let accounts: Account[];
if (existsSync(credentialsFile)) accounts = JSON.parse(readFileSync(credentialsFile, "utf8"));
else {
  const suffix = randomBytes(4).toString("hex");
  accounts = [
    { username: `ws_${suffix}_a`, password: randomBytes(16).toString("hex"), nickname: `Local${suffix}A`, sex: true },
    { username: `ws_${suffix}_b`, password: randomBytes(16).toString("hex"), nickname: `Local${suffix}B`, sex: false },
    { username: `ws_${suffix}_gm`, password: randomBytes(16).toString("hex"), nickname: "", sex: true, admin: true },
  ];
  // Saved before registration, so an interrupted run resumes without resetting existing passwords.
  writeFileSync(credentialsFile, JSON.stringify(accounts, null, 2));
}
const rsa = parseDotNetRsaXml(readFileSync(env.RSA_PRIVATE_KEY_FILE!, "utf8")) as RsaPrivateKey;
const h = await createDb(`postgres://postgres:${encodeURIComponent(env.PG_PASSWORD!)}@127.0.0.1:55432/ddtank`);
const clients: FakeClient[] = [];
async function json(path: string, body?: unknown, token?: string, expected = 200) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, expected, `${path}: unexpected status`);
  return response.json();
}
async function legacy(path: string, params: Record<string, string>) {
  const response = await fetch(base + "/request/" + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, path);
  return response.text();
}
function blob(account: Account, webKey: string, temp: string) {
  const date = buildLoginPayload(`${account.username},${webKey},${temp}`, account.nickname, new Array(8).fill(0)).subarray(0, 7);
  return bytesToBase64(rsaEncryptPkcs1(rsa, Buffer.concat([date, Buffer.from(`${account.username},${webKey},${temp},${account.nickname}`)])));
}
async function auth(account: Account): Promise<Auth> {
  if (!await findAccount(h, account.username)) await json("/api/auth/register", { username: account.username, password: account.password }, undefined, 201);
  if (account.admin) {
    const acc = await findAccount(h, account.username);
    assert.ok(acc);
    if (!acc.IsAdmin) await h.db.update(Accounts).set({ IsAdmin: true }).where(eq(Accounts.ID, acc.ID));
  }
  return json("/api/auth/login", { username: account.username, password: account.password });
}
async function enter(account: Account, transport: "tcp" | "ws") {
  const login = await auth(account);
  const temp = randomBytes(12).toString("hex");
  const out = await legacy("Login.ashx", { p: blob(account, login.play.flashvars.key, temp), site: "" });
  assert.match(out, /<Result value="true"/);
  const id = Number(/<Item ID="(\d+)"/.exec(out)?.[1]);
  assert.ok(id > 0);
  if (/NickName=""/.test(out)) {
    const reg = await legacy("VisualizeRegister.ashx", { Name: account.username, Pass: temp, NickName: account.nickname, Sex: String(account.sex) });
    assert.match(reg, /<Result value="true"/);
  }
  const c = transport === "tcp" ? await FakeClient.tcp(9200) : await FakeClient.ws("ws://127.0.0.1:9300/ws", "http://127.0.0.1:5173");
  clients.push(c);
  c.login(account.username, temp, rsa);
  await c.code(95);
  c.out(16, p => p.writeInt(1));
  await c.code(94, 9);
  const before = receipt.characters.find(x => x.username === account.username);
  const profile = await json("/api/account/me", undefined, login.token);
  const char = profile.characters.find((x: { id: number }) => x.id === id);
  assert.equal(char?.nickname, account.nickname);
  const saved = previous?.characters?.find((x: { username: string }) => x.username === account.username);
  if (saved) assert.equal(char.id, saved.id, "character ID must survive service restart");
  if (before) assert.equal(char.id, before.id, "character identity persisted");
  else receipt.characters.push({ username: account.username, id, nickname: char.nickname, gold: char.gold, money: char.money });
  return { c, id, token: login.token };
}
try {
  assert.deepEqual(await json("/healthz"), { ok: true });
  receipt.checks.push("API health");
  const gm = await auth(accounts[2]!);
  assert.equal(gm.user.role, "admin");
  const me = await json("/api/auth/me", undefined, gm.token);
  assert.equal(me.user.role, "admin");
  await json("/api/auth/login", { username: accounts[0]!.username, password: "incorrect-test-password" }, undefined, 401);
  receipt.checks.push("independent local GM auth; invalid password rejected");
  const templateDir = resolve(runtime, "current-templates");
  mkdirSync(templateDir, { recursive: true });
  for (const name of ["templatealllist", "loadmapsitems", "npcinfolist", "balllist", "pettemplateinfo"]) {
    const response = await fetch(`${base}/request/${name}.xml`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-placeholder"), null);
    const body = Buffer.from(await response.arrayBuffer());
    const xml = body[0] === 0x78 ? inflateSync(body) : body;
    assert.match(xml.toString("utf8"), /<Result\b/);
    writeFileSync(resolve(templateDir, `${name}.xml`), xml);
  }
  receipt.checks.push("five live database templates exported (no placeholders)");
  // Ruffle's JS bootstrap alone is insufficient: both actual WASM payloads must be served intact.
  const lfs = JSON.parse(readFileSync(resolve(runtime, "lfs-stage/asset-report.json"), "utf8"));
  for (const file of lfs.files.filter((f: { name: string }) => f.name.startsWith("apps/client-harness/public/ruffle/"))) {
    const name = file.name.split("/").at(-1);
    const response = await fetch(`${base}/ruffle/${name}`);
    assert.equal(response.status, 200);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.subarray(0, 4).toString("hex"), "0061736d");
    assert.equal(body.length, file.size);
    assert.equal(createHash("sha256").update(body).digest("hex"), file.sha256);
  }
  receipt.checks.push("both Ruffle WASM binaries served with correct size and SHA256");
  const a = await enter(accounts[0]!, "tcp");
  const b = await enter(accounts[1]!, "ws");
  receipt.checks.push("REST → RSA Flash ticket → rolling cipher TCP + WS login → lobby");
  a.c.out(94, p => { p.writeInt(0); p.writeByte(1); p.writeByte(2); p.writeUTF("WorkshopSmoke"); p.writeUTF(""); });
  const created = await a.c.code(94, 0);
  created.pkt.readByte();
  const roomId = created.pkt.readInt();
  b.c.out(94, p => { p.writeInt(1); p.writeBoolean(false); p.writeInt(1); p.writeInt(-1); p.writeInt(roomId); p.writeUTF(""); });
  await b.c.code(94, 1);
  const mark = b.c.mark();
  a.c.out(19, p => { p.writeByte(0); p.writeBoolean(false); p.writeUTF(""); p.writeUTF("本地联机测试"); });
  const chat = await b.c.code(19, undefined, mark);
  assert.equal(chat.clientId, a.id);
  receipt.checks.push("TCP/WS two-account room join + chat");
  for (const c of clients) c.close();
  await new Promise(r => setTimeout(r, 1200));
  await enter(accounts[0]!, "ws");
  receipt.checks.push("disconnect → fresh REST/Flash ticket → WS reconnect preserves character ID");
  receipt.ok = true;
} catch (error) {
  receipt.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  for (const c of clients) c.close();
  await h.close();
  writeFileSync(reportFile, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
