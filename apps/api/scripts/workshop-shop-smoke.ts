/** One real local shop purchase: normal HTTP/RSA/WS login, persistence, then exact logical rollback.
 * Uses only a newly registered fixture account. Retains that account, quest progress and the inactive item row.
 * Run with --run; --rollback resumes cleanup from the journal without buying again. No mocks or UI input.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { inflateSync } from "node:zlib";
import { buildLoginPayload, bytesToBase64, GSPacket, parseDotNetRsaXml, rsaEncryptPkcs1, type RsaPrivateKey } from "@ddt/protocol";
import { FakeClient, type Received } from "../../game/test/helpers.js";

process.env.TZ = "UTC";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtime = resolve(repo, "../../runtime");
const env = parseEnv(readFileSync(resolve(repo, ".env.workshop"), "utf8"));
const base = new URL(process.env.WORKSHOP_API_URL ?? "http://127.0.0.1:8080");
assert.equal(base.protocol, "http:");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "only the project-local API is allowed");
assert.ok(!base.username && !base.password, "API URL must not contain credentials");
const run = process.argv.includes("--run"), rollback = process.argv.includes("--rollback");
assert.ok(run !== rollback, "choose --run or --rollback");
const reportPath = resolve(runtime, "content-research/shop-lifecycle.json");
const credentialsPath = resolve(runtime, "credentials/shop-fixture-account.json");
const SHOP_ID = 1310201, TEMPLATE_ID = 13102, PRICE = 159;
type Row = Record<string, unknown>;
type Account = { username: string; password: string; nickname: string; sex: boolean };
type Auth = { token: string; user: { role: string }; play: { flashvars: { key: string } } };
type Balance = { Money: number; MoneyLock: number; Gold: number; GiftToken: number; Offer: number; Score: number; petScore: number; damageScores: number };
type Slot = { bag: number; slot: number; item?: { UserID: number; ItemID: number; Count: number; Place: number; TemplateID: number; IsBinds: boolean; ValidDate: number; Pic: string } };
type Receipt = {
  date: string; node: string; base: string; phase: string; ok: boolean; businessAccepted: boolean; cleanupAccepted: boolean;
  renderingAccepted: false; checks: string[]; cleanup: string[]; snapshots: { stage: string; value: unknown }[]; error?: string; cleanupError?: string;
  shop?: Row; characterId?: number; baselineStyle?: string; baseline?: Balance; funded?: Balance; expectedPaid?: Balance;
  baselineItemIds?: number[]; itemId?: number; purchaseSent?: boolean;
  retainedTestAccount: true; questSideEffectsRetained: true; inactivePurchasedRowRetained: true;
};
// A refused repeat must not overwrite an unfinished cleanup journal or its credentials.
if (run && existsSync(reportPath)) {
  const old: Receipt = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.ok(old.phase === "rolled-back" || (old.phase === "preflight" && !old.characterId && !old.purchaseSent), "finish the earlier shop fixture rollback first");
}
const receipt: Receipt = rollback ? JSON.parse(readFileSync(reportPath, "utf8")) : {
  date: new Date().toISOString(), node: process.version, base: base.href, phase: "preflight", ok: false, businessAccepted: false, cleanupAccepted: false,
  renderingAccepted: false, checks: [], cleanup: [], snapshots: [], retainedTestAccount: true, questSideEffectsRetained: true, inactivePurchasedRowRetained: true,
};
const secrets = new Set<string>();
function remember(value: string) { if (value) for (const variant of [value, encodeURIComponent(value), encodeURI(value)]) secrets.add(variant); return value; }
function redact(value: string) { for (const secret of [...secrets].sort((a, b) => b.length - a.length)) value = value.split(secret).join("[redacted]"); return value; }
const replacer = (_key: string, value: unknown) => typeof value === "string" ? redact(value) : value;
function save() { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(receipt, replacer, 2) + "\n"); }
function check(message: string) { receipt.checks.push(message); save(); console.log(redact(message)); }
function snapshot(stage: string, value: unknown) { receipt.snapshots.push({ stage, value }); save(); }
let token = "", account: Account | undefined;
const clients: FakeClient[] = [];
const rsa = parseDotNetRsaXml(readFileSync(env.RSA_PRIVATE_KEY_FILE!, "utf8")) as RsaPrivateKey;
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function request(path: string, init: RequestInit = {}) {
  return fetch(new URL(path, base), { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers }, signal: AbortSignal.timeout(20_000) });
}
async function json<T = Row>(path: string, method = "GET", body?: unknown, expected = 200): Promise<T> {
  const response = await request(path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  assert.equal(response.status, expected, `${method} ${path}: unexpected status`);
  return response.json() as Promise<T>;
}
async function poll<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string): Promise<T> {
  for (let n = 0; n < 80; n++) { const value = await read(); if (accepts(value)) return value; await delay(250); }
  throw new Error(`timed out: ${label}`);
}
function balance(row: Row): Balance {
  const result = Object.fromEntries(["Money", "MoneyLock", "Gold", "GiftToken", "Offer", "Score", "petScore", "damageScores"].map(key => [key, Number(row[key])])) as Balance;
  assert.ok(Object.values(result).every(Number.isFinite), "invalid character balance"); return result;
}
async function character() {
  assert.ok(receipt.characterId && account, "fixture identity is missing");
  const row = await json(`/api/admin/players/${receipt.characterId}`);
  assert.equal(row.UserID, receipt.characterId); assert.equal(row.UserName, account.username, "fixture owner changed"); return row;
}
async function ownedItems() {
  const result = await json<{ items: Row[]; total: number }>(`/api/admin/player-items?pageSize=500&q=${receipt.characterId}`);
  assert.ok(result.total <= 500, "fixture item search exceeded the bounded single page");
  return result.items.filter(row => row.UserID === receipt.characterId);
}
async function xml(path: string) {
  const response = await request("/request/" + path); assert.equal(response.status, 200);
  const body = Buffer.from(await response.arrayBuffer()), text = (body[0] === 0x78 ? inflateSync(body) : body).toString("utf8");
  assert.ok(/<Result\b[^>]*\bvalue="true"/.test(text), "expected successful static shop XML"); return text;
}
function xmlRows(text: string) {
  return [...text.matchAll(/<Item\b[^>]*>/g)].map(match => Object.fromEntries([...match[0].matchAll(/(\w+)="([^"]*)"/g)].map(attr => [attr[1], attr[2]])));
}
async function preflight() {
  assert.equal((await json<{ ok: boolean }>("/healthz")).ok, true);
  const shop = await json(`/api/admin/shop/${SHOP_ID}`), template = await json(`/api/admin/items/${TEMPLATE_ID}`);
  for (const [key, expected] of Object.entries({ ID: SHOP_ID, TemplateID: TEMPLATE_ID, ShopID: 1, BuyType: 0, Beat: 1, AUnit: 7, APrice1: -1, AValue1: PRICE, APrice2: -1, AValue2: 0, APrice3: -1, AValue3: 0 })) assert.equal(shop[key], expected, `shop field ${key}`);
  assert.equal(template.CategoryID, 13); assert.equal(template.Pic, "suits2"); assert.equal(template.MaxCount, 1);
  const rows = xmlRows(await xml("ShopItemList.xml")).filter(row => Number(row.ID) === SHOP_ID);
  assert.equal(rows.length, 1, "shop XML must contain one matching listing");
  for (const key of ["ID", "TemplateID", "ShopID", "BuyType", "Beat", "AUnit", "APrice1", "AValue1", "APrice2", "AValue2", "APrice3", "AValue3"]) assert.equal(Number(rows[0]![key]), shop[key], `shop XML field ${key}`);
  assert.ok(xmlRows(await xml("ShopGoodsShowList.xml")).some(row => Number(row.ShopId) === SHOP_ID), "listing is absent from the real show list");
  if (receipt.shop) assert.deepEqual(shop, receipt.shop, "original shop listing changed"); else receipt.shop = shop;
  check("live API/XML: listed original Shop 1310201, one suits2, A tier 7 days / 159 Money");
}
function packet(r: Received) { return GSPacket.wrap(r.pkt.buffer.slice(), r.pkt.length); }
function style(r: Received) { const p = packet(r); for (let n = 0; n < 13; n++) p.readInt(); return p.readString(); }
function privateBalance(r: Received) { const p = packet(r), money = p.readInt(); p.readInt(); p.readInt(); return { money, gold: p.readInt(), giftToken: p.readInt() }; }
function inventory(r: Received): Slot[] {
  const p = packet(r), bag = p.readInt(), count = p.readInt(), rows: Slot[] = [];
  assert.ok(count >= 0 && count <= 127, "invalid inventory slot count");
  for (let n = 0; n < count; n++) {
    const slot = p.readInt(); if (!p.readBoolean()) { rows.push({ bag, slot }); continue; }
    const item = { UserID: p.readInt(), ItemID: p.readInt(), Count: p.readInt(), Place: p.readInt(), TemplateID: p.readInt(), IsBinds: false, ValidDate: 0, Pic: "" };
    for (let k = 0; k < 6; k++) p.readInt();
    item.IsBinds = p.readBoolean(); p.readBoolean(); p.offset += 7; item.ValidDate = p.readInt();
    p.readString(); p.readString(); p.readBoolean(); for (let k = 0; k < 6; k++) p.readInt();
    item.Pic = p.readString(); p.readInt(); p.offset += 7; p.readInt(); p.readByte(); p.readInt(); p.readByte(); p.readInt();
    if (p.readBoolean()) { p.readInt(); p.offset += 7; } p.readString(); p.readString(); p.offset += 7;
    rows.push({ bag, slot, item });
  }
  return rows;
}
function assertPurchased(item: NonNullable<Slot["item"]>) {
  assert.equal(item.TemplateID, TEMPLATE_ID); assert.equal(item.Count, 1); assert.equal(item.ValidDate, 7); assert.equal(item.IsBinds, true);
  assert.equal(item.Pic, "suits2"); assert.ok(item.Place >= 31, "purchase must remain in the bag, not replace equipped items");
}
async function legacy(path: string, params: Record<string, string>) {
  const response = await request("/request/" + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  assert.equal(response.status, 200); return response.text();
}
async function enter() {
  assert.ok(account, "fixture credentials are missing");
  const login = await json<Auth>("/api/auth/login", "POST", { username: account.username, password: account.password });
  remember(login.token); remember(login.play.flashvars.key); assert.equal(login.user.role, "player");
  const temp = remember(randomBytes(12).toString("hex"));
  const date = buildLoginPayload(`${account.username},${login.play.flashvars.key},${temp}`, account.nickname, new Array(8).fill(0)).subarray(0, 7);
  const blob = remember(bytesToBase64(rsaEncryptPkcs1(rsa, Buffer.concat([date, Buffer.from(`${account.username},${login.play.flashvars.key},${temp},${account.nickname}`)]))));
  const result = await legacy("Login.ashx", { p: blob, site: "" }); assert.match(result, /<Result value="true"/);
  const id = Number(/<Item ID="(\d+)"/.exec(result)?.[1]); assert.ok(id > 0);
  if (receipt.characterId) assert.equal(id, receipt.characterId, "character changed on reconnect"); else { receipt.characterId = id; save(); }
  if (/NickName=""/.test(result)) assert.match(await legacy("VisualizeRegister.ashx", { Name: account.username, Pass: temp, NickName: account.nickname, Sex: String(account.sex) }), /<Result value="true"/);
  const c = await FakeClient.ws("ws://127.0.0.1:9300/ws", "http://127.0.0.1:5173"); clients.push(c);
  c.login(account.username, temp, rsa); await c.code(95); c.out(16, p => p.writeInt(1)); await c.code(94, 9);
  const currentStyle = style(await c.code(67)); return { c, style: currentStyle, funds: privateBalance(await c.code(38)) };
}
async function disconnect(c: FakeClient) {
  c.close(); await c.waitClosed();
  const row = await poll(character, value => value.State === 0, "normal disconnect saved State 0");
  if (receipt.baselineStyle !== undefined) assert.equal(row.Style, receipt.baselineStyle, "purchase changed equipped appearance"); return row;
}
async function findPurchasedItem() {
  assert.ok(receipt.baselineItemIds, "pre-purchase item baseline is missing");
  const added = (await ownedItems()).filter(row => !receipt.baselineItemIds!.includes(Number(row.ItemID)) && row.TemplateID === TEMPLATE_ID);
  assert.ok(added.length <= 1, "multiple unjournalled suit rows; refusing ambiguous rollback");
  if (added.length) { receipt.itemId = Number(added[0]!.ItemID); assert.ok(receipt.itemId > 0); save(); }
  return added[0];
}
async function cleanup() {
  for (const c of clients) if (!c.closed) await disconnect(c);
  assert.ok(receipt.characterId && receipt.baseline && receipt.baselineItemIds, "incomplete fixture baseline; preserve the journal and refuse to guess original balances");
  const before = await character(); assert.equal(before.State, 0, "refuse offline edits while the fixture is online");
  snapshot("before-cleanup", { funds: balance(before), style: before.Style });
  if (receipt.purchaseSent && !receipt.itemId) await findPurchasedItem();
  if (receipt.itemId) {
    const row = await json(`/api/admin/player-items/${receipt.itemId}`);
    assert.equal(row.ItemID, receipt.itemId); assert.equal(row.UserID, receipt.characterId); assert.equal(row.TemplateID, TEMPLATE_ID);
    assert.ok(!receipt.baselineItemIds!.includes(receipt.itemId), "refuse to alter a baseline item"); assert.ok(Number(row.Place) >= 31, "fixture item unexpectedly equipped");
    const cleaned = await json(`/api/admin/player-items/${receipt.itemId}`, "PATCH", { IsExist: false, Count: 0 });
    assert.equal(cleaned.IsExist, false); assert.equal(cleaned.Count, 0); receipt.cleanup.push("exact owned purchase row marked IsExist=false, Count=0; row retained"); save();
  }
  await json(`/api/admin/players/${receipt.characterId}`, "PATCH", { Money: receipt.baseline.Money, MoneyLock: receipt.baseline.MoneyLock, Gold: receipt.baseline.Gold });
  receipt.cleanup.push("fixture Money/MoneyLock/Gold baseline restored while offline"); save();
  const current = await character(); assert.deepEqual(balance(current), receipt.baseline);
  const restored = await enter(); assert.equal(restored.style, receipt.baselineStyle);
  assert.deepEqual(restored.funds, { money: receipt.baseline.Money + receipt.baseline.MoneyLock, gold: receipt.baseline.Gold, giftToken: receipt.baseline.GiftToken });
  await restored.c.waitFor(r => r.code === 64 && inventory(r).some(slot => slot.bag === 0));
  assert.ok(!restored.c.received.filter(r => r.code === 64).flatMap(inventory).some(slot => (receipt.itemId !== undefined && slot.item?.ItemID === receipt.itemId) || slot.item?.TemplateID === TEMPLATE_ID), "rolled-back suit still loaded on a fresh connection");
  const final = await disconnect(restored.c); assert.deepEqual(balance(final), receipt.baseline);
  assert.deepEqual((await ownedItems()).filter(row => row.IsExist === true).map(row => Number(row.ItemID)).sort((a, b) => a - b), receipt.baselineItemIds);
  if (receipt.itemId) { const row = await json(`/api/admin/player-items/${receipt.itemId}`); assert.equal(row.UserID, receipt.characterId); assert.equal(row.TemplateID, TEMPLATE_ID); assert.equal(row.IsExist, false); assert.equal(row.Count, 0); }
  await preflight(); receipt.cleanupAccepted = true; receipt.phase = "rolled-back"; snapshot("final", { funds: balance(final), state: final.State, style: final.Style, inactiveItemId: receipt.itemId });
  check("rollback verified: original shop unchanged, fresh WS does not load purchased suit, balance/style baseline and State 0 restored; test account/quest effects/inactive row retained");
}

try {
  const accounts: (Account & { admin?: boolean })[] = JSON.parse(readFileSync(resolve(runtime, "credentials/smoke-accounts.json"), "utf8"));
  const gm = accounts[2]!; assert.equal(gm.admin, true); remember(gm.username); remember(gm.password);
  const auth = await json<Auth>("/api/auth/login", "POST", { username: gm.username, password: gm.password });
  assert.equal(auth.user.role, "admin"); token = remember(auth.token); remember(auth.play.flashvars.key);
  if (rollback) {
    account = JSON.parse(readFileSync(credentialsPath, "utf8")); remember(account!.username); remember(account!.password); remember(account!.nickname);
    await cleanup();
  } else {
    await preflight();
    const tag = randomBytes(4).toString("hex"); account = { username: remember(`shop_${tag}`), password: remember(randomBytes(18).toString("hex")), nickname: remember(`Shop${tag}`), sex: false };
    mkdirSync(dirname(credentialsPath), { recursive: true }); writeFileSync(credentialsPath, JSON.stringify(account, null, 2) + "\n", { mode: 0o600 });
    const registered = await json<Auth>("/api/auth/register", "POST", { username: account.username, password: account.password }, 201); remember(registered.token); remember(registered.play.flashvars.key);
    receipt.phase = "fixture-created"; save();
    const initial = await enter(), first = await disconnect(initial.c); receipt.baselineStyle = initial.style; receipt.baseline = balance(first);
    receipt.baselineItemIds = (await ownedItems()).filter(row => row.IsExist === true).map(row => Number(row.ItemID)).sort((a, b) => a - b);
    receipt.phase = "baseline-saved"; save(); // Persist compensation data before any balance write.
    assert.ok(!(await ownedItems()).some(row => row.TemplateID === TEMPLATE_ID && row.IsExist === true), "fresh fixture already owns the suit");
    if (receipt.baseline.Money + receipt.baseline.MoneyLock < PRICE) await json(`/api/admin/players/${receipt.characterId}`, "PATCH", { Money: receipt.baseline.Money + PRICE });
    receipt.funded = balance(await character()); const fromLock = Math.min(receipt.funded.MoneyLock, PRICE);
    receipt.expectedPaid = { ...receipt.funded, MoneyLock: receipt.funded.MoneyLock - fromLock, Money: receipt.funded.Money - (PRICE - fromLock) };
    receipt.phase = "ready-to-buy"; snapshot("baseline", { funds: receipt.baseline, funded: receipt.funded, style: receipt.baselineStyle, itemIds: receipt.baselineItemIds });
    const live = await enter(); assert.equal(live.style, receipt.baselineStyle);
    assert.deepEqual(live.funds, { money: receipt.funded.Money + receipt.funded.MoneyLock, gold: receipt.funded.Gold, giftToken: receipt.funded.GiftToken });
    const mark = live.c.mark(); receipt.purchaseSent = true; receipt.phase = "purchase-sent"; save();
    live.c.out(44, p => { p.writeInt(1); p.writeInt(SHOP_ID); p.writeInt(1); p.writeString(""); p.writeBoolean(false); p.writeString(""); p.writeInt(0); p.writeInt(0); });
    const reply = packet(await live.c.code(44, undefined, mark)); assert.equal(reply.readInt(), 1); assert.equal(reply.readInt(), 3);
    const update = await live.c.waitFor(r => r.code === 38 && privateBalance(r).money === receipt.expectedPaid!.Money + receipt.expectedPaid!.MoneyLock, 4000, mark);
    assert.deepEqual(privateBalance(update), { money: receipt.expectedPaid.Money + receipt.expectedPaid.MoneyLock, gold: receipt.expectedPaid.Gold, giftToken: receipt.expectedPaid.GiftToken });
    const changed = await live.c.waitFor(r => r.code === 64 && inventory(r).some(slot => slot.bag === 0 && slot.item?.TemplateID === TEMPLATE_ID), 4000, mark);
    const bought = inventory(changed).filter(slot => slot.item?.TemplateID === TEMPLATE_ID); assert.equal(bought.length, 1); assertPurchased(bought[0]!.item!);
    snapshot("purchase-packets", { code44: [1, 3], funds: privateBalance(update), item: bought[0] });
    const saved = await disconnect(live.c); assert.deepEqual(balance(saved), receipt.expectedPaid);
    const row = await poll(findPurchasedItem, value => !!value, "purchase saved with stable ItemID"); assert.ok(row); assert.equal(row.UserID, receipt.characterId); assert.equal(row.IsExist, true); assert.equal(row.Count, 1); assert.equal(row.ValidDate, 7); assert.equal(row.IsBinds, true);
    assert.deepEqual((await ownedItems()).filter(item => item.IsExist === true && item.ItemID !== receipt.itemId).map(item => Number(item.ItemID)).sort((a, b) => a - b), receipt.baselineItemIds);
    snapshot("persisted-purchase", { funds: balance(saved), itemId: receipt.itemId, templateId: row.TemplateID, count: row.Count, validDate: row.ValidDate, place: row.Place });
    check("real WS purchase: 44 plus exact 159-point debit in 38, one bound 7-day suits2 in 64; normal disconnect persisted one new ItemID");
    const reconnected = await enter(); assert.equal(reconnected.style, receipt.baselineStyle);
    assert.deepEqual(reconnected.funds, { money: receipt.expectedPaid.Money + receipt.expectedPaid.MoneyLock, gold: receipt.expectedPaid.Gold, giftToken: receipt.expectedPaid.GiftToken });
    const persisted = await reconnected.c.waitFor(r => r.code === 64 && inventory(r).some(slot => slot.item?.ItemID === receipt.itemId));
    const persistedItem = inventory(persisted).find(slot => slot.item?.ItemID === receipt.itemId)!.item!; assertPurchased(persistedItem); assert.equal(persistedItem.UserID, receipt.characterId);
    await disconnect(reconnected.c); receipt.businessAccepted = true; receipt.phase = "persistent-purchase"; snapshot("fresh-WS-purchase", { funds: reconnected.funds, item: persistedItem });
    check("new HTTP/RSA/WS connection retained the same purchased ItemID and exact spent balance");
    await cleanup();
  }
  receipt.ok = receipt.businessAccepted && receipt.cleanupAccepted;
  if (!receipt.ok && !rollback) process.exitCode = 1;
} catch (error) {
  receipt.ok = false; receipt.error = redact(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  if (run && token && account && receipt.characterId) {
    try { await cleanup(); } catch (cleanupError) { receipt.cleanupError = redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)); }
  }
} finally {
  for (const c of clients) if (!c.closed) { c.close(); await c.waitClosed().catch(() => undefined); }
  save(); console.log(JSON.stringify({ ok: receipt.ok, phase: receipt.phase, businessAccepted: receipt.businessAccepted, cleanupAccepted: receipt.cleanupAccepted, renderingAccepted: false, error: receipt.error, cleanupError: receipt.cleanupError, reportPath }, replacer, 2));
}
