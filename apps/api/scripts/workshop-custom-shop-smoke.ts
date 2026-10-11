/** One isolated non-suit listing: normal admin CRUD, real HTTP/RSA/WS purchase, then exact rollback.
 * --run refuses an existing journal; --rollback resumes it; --verify only reads the completed rollback.
 * Retains the test account, quest effects and the logically deleted purchase row. No resource writes or CU.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { inflateSync } from "node:zlib";
import { buildLoginPayload, bytesToBase64, GSPacket, parseDotNetRsaXml, rsaEncryptPkcs1, type RsaPrivateKey } from "@ddt/protocol";
import { FakeClient, type Received } from "../../game/test/helpers.js";

process.env.TZ = "UTC";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtime = resolve(repo, "../../runtime");
const reportPath = resolve(runtime, "content-research/custom-shop-lifecycle.json");
const credentialsPath = resolve(runtime, "credentials/custom-shop-fixture-account.json");
const base = new URL(process.env.WORKSHOP_API_URL ?? "http://127.0.0.1:8080");
const SOURCE_ID = 7008, PRICE = 37;
const run = process.argv.includes("--run"), rollback = process.argv.includes("--rollback"), verify = process.argv.includes("--verify");
type Row = Record<string, unknown>;
type Resource = "items" | "shop" | "shop-show";
type Account = { username: string; password: string; nickname: string; sex: boolean; ownerTag: string };
type Auth = { token: string; user: { role: string }; play: { flashvars: { key: string } } };
type Balance = Record<"Money" | "MoneyLock" | "Gold" | "GiftToken" | "Offer" | "Score" | "petScore" | "damageScores", number>;
type Owned = { resource: Resource; id: number; pk: "TemplateID" | "ID" | "TempID"; expected: Row; created?: Row };
type Slot = { bag: number; slot: number; item?: { UserID: number; ItemID: number; Count: number; Place: number; TemplateID: number; IsBinds: boolean; ValidDate: number; Pic: string } };
type Receipt = {
  version: 1; date: string; node: string; base: string; ownerTag: string; phase: string;
  ok: boolean; insufficientAccepted: boolean; businessAccepted: boolean; cleanupAccepted: boolean; sensitiveAuditAccepted: boolean; renderingAccepted: false;
  checks: string[]; operations: { method: string; path: string; before: unknown; body?: unknown; state: "planned" | "applied"; after?: unknown }[];
  snapshots: { stage: string; value: unknown }[]; error?: string; cleanupError?: string;
  source?: { template: Row; shop: Row; shows: Row[]; xml: { path: string; hash: string; rows: number }[] };
  owned?: Owned[]; characterId?: number; baselineStyle?: string; baseline?: Balance; baselineItemIds?: number[];
  funded?: Balance; expectedPaid?: Balance; purchaseSent?: boolean; itemId?: number;
  retainedTestAccount: true; questSideEffectsRetained: true; inactivePurchasedRowRetained: true; resourceWrites: 0;
};
let receipt: Receipt | undefined, token = "", account: Account | undefined, rsa: RsaPrivateKey;
const clients: FakeClient[] = [], secrets = new Set<string>();
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const canonical = (row: Row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function remember(value: string) {
  if (value) for (const v of [value, value.toLowerCase(), value.toUpperCase()]) {
    for (const variant of [v, encodeURI(v), encodeURIComponent(v), JSON.stringify(v).slice(1, -1), Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url"), Buffer.from(v).toString("hex"), v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")]) secrets.add(variant);
  }
  return value;
}
function redact(value: string) { for (const s of [...secrets].sort((a, b) => b.length - a.length)) value = value.split(s).join("[redacted]"); return value; }
const replacer = (_key: string, value: unknown) => typeof value === "string" ? redact(value) : value;
function journal() { assert.ok(receipt, "journal is missing"); return receipt; }
function save(first = false) {
  const r = journal(); mkdirSync(dirname(reportPath), { recursive: true });
  const fd = openSync(reportPath, first ? "wx" : "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(r, replacer, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
function check(message: string) { journal().checks.push(message); save(); console.log(redact(message)); }
function snapshot(stage: string, value: unknown) { journal().snapshots.push({ stage, value }); save(); }
async function request(path: string, init: RequestInit = {}) {
  return fetch(new URL(path, base), { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers }, signal: AbortSignal.timeout(20_000) });
}
async function json<T = Row>(path: string, method = "GET", body?: unknown, expected = 200): Promise<T> {
  const res = await request(path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  assert.equal(res.status, expected, `${method} ${path}: unexpected status`);
  return expected === 204 ? undefined as T : res.json() as Promise<T>;
}
async function maybe(resource: string, id: number): Promise<Row | undefined> {
  const res = await request(`/api/admin/${resource}/${id}`); if (res.status === 404) { await res.arrayBuffer(); return; }
  assert.equal(res.status, 200, `read ${resource}/${id}`); return res.json() as Promise<Row>;
}
async function list(resource: string, needle: string) {
  const result = await json<{ items: Row[]; total: number }>(`/api/admin/${resource}?pageSize=500&q=${encodeURIComponent(needle)}`);
  assert.ok(result.total <= 500, "bounded fixture query overflow"); return result.items;
}
async function mutate(path: string, method: string, body: unknown, before: unknown, expected = 200) {
  const op: Receipt["operations"][number] = { method, path, before, ...(body === undefined ? {} : { body }), state: "planned" };
  journal().operations.push(op); save(); // Compensation/ownership data reaches disk before each reversible write.
  const result = await json(path, method, body, expected); op.state = "applied"; op.after = result; save(); return result;
}
async function poll<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string): Promise<T> {
  for (let n = 0; n < 80; n++) { const value = await read(); if (accepts(value)) return value; await delay(250); }
  throw new Error(`timed out: ${label}`);
}
function balance(row: Row): Balance {
  const value = Object.fromEntries(["Money", "MoneyLock", "Gold", "GiftToken", "Offer", "Score", "petScore", "damageScores"].map(k => [k, Number(row[k])])) as Balance;
  assert.ok(Object.values(value).every(Number.isFinite), "invalid fixture balance"); return value;
}
async function character() {
  const r = journal(); assert.ok(r.characterId && account, "fixture identity missing");
  const row = await json(`/api/admin/players/${r.characterId}`);
  assert.equal(row.UserID, r.characterId); assert.equal(row.UserName, account.username, "fixture owner changed"); return row;
}
async function ownedItems() { const id = journal().characterId; assert.ok(id); return (await list("player-items", String(id))).filter(row => row.UserID === id); }
async function xml(path: string) {
  const res = await request("/request/" + path); assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer()), text = (bytes[0] === 0x78 ? inflateSync(bytes) : bytes).toString("utf8");
  assert.match(text, /<Result\b[^>]*\bvalue="true"/); return text;
}
function xmlRows(text: string) { return [...text.matchAll(/<Item\b[^>]*>/g)].map(m => Object.fromEntries([...m[0].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]]))); }
async function preflight() {
  const r = journal(); assert.equal((await json<{ ok: boolean }>("/healthz")).ok, true);
  const template = await json(`/api/admin/items/${SOURCE_ID}`), shop = await json(`/api/admin/shop/${SOURCE_ID}`);
  assert.equal(template.CategoryID, 7); assert.ok(typeof template.Pic === "string" && template.Pic); assert.equal(template.MaxCount, 1);
  for (const [k, v] of Object.entries({ ID: SOURCE_ID, TemplateID: SOURCE_ID, ShopID: 1, BuyType: 0, Beat: 1, AUnit: 7, APrice1: -1, AValue1: 130, APrice2: -1, AValue2: 0, APrice3: -1, AValue3: 0 })) assert.equal(shop[k], v, `original shop ${k}`);
  const shows = (await list("shop-show", String(SOURCE_ID))).filter(x => x.ShopId === SOURCE_ID);
  assert.ok(shows.length && new Set(shows.map(x => x.Type)).size === 2); assert.deepEqual([...new Set(shows.map(x => x.Type))].sort(), [5, 6]);
  const originalXml = [];
  for (const path of ["templatealllist.xml", "ShopItemList.xml", "ShopGoodsShowList.xml"]) { const text = await xml(path); originalXml.push({ path, hash: sha(text), rows: xmlRows(text).length }); }
  r.source = { template, shop, shows, xml: originalXml };
  const templateId = 1_398_000 + randomInt(1000), shopId = templateId * 100 + 1;
  const item = { ...template, TemplateID: templateId, Name: `WorkshopShop_${r.ownerTag}`, Remark: `Isolated custom shop ${r.ownerTag}` };
  r.owned = [{ resource: "items", id: templateId, pk: "TemplateID", expected: item }, { resource: "shop", id: shopId, pk: "ID", expected: { ...shop, ID: shopId, TemplateID: templateId, AValue1: PRICE } }];
  for (const [index, type] of [5, 6].entries()) {
    const source = shows.find(x => x.Type === type)!;
    r.owned.push({ resource: "shop-show", id: shopId + index + 1, pk: "TempID", expected: { ...source, TempID: shopId + index + 1, ShopId: shopId } });
  }
  for (const owned of r.owned) assert.equal(await maybe(owned.resource, owned.id), undefined, "candidate key conflict");
  assert.equal((await list("items", String(item.Name))).filter(x => x.Name === item.Name).length, 0, "candidate name conflict");
  save(); check("source 7008 verified: non-suit Category7, original Pic, 7-day Money shop, exact existing show Type5/6; all new keys absent");
}
function contentPlan() {
  const r = journal(); assert.ok(r.source && r.owned && /^[a-f0-9]{12}$/.test(r.ownerTag), "missing content ownership plan");
  const item = r.owned.find(x => x.resource === "items")!, shop = r.owned.find(x => x.resource === "shop")!;
  assert.ok(item && shop); assert.equal(item.expected.TemplateID, item.id); assert.equal(item.expected.Name, `WorkshopShop_${r.ownerTag}`);
  assert.equal(item.expected.Pic, r.source.template.Pic); assert.equal(item.expected.CategoryID, 7);
  assert.ok(item.id >= 1_398_000 && item.id < 1_399_000); assert.equal(shop.id, item.id * 100 + 1);
  assert.equal(shop.expected.ID, shop.id); assert.equal(shop.expected.TemplateID, item.id); assert.equal(shop.expected.AValue1, PRICE);
  const shows = r.owned.filter(x => x.resource === "shop-show"); assert.equal(shows.length, 2);
  for (const [index, entry] of shows.entries()) { assert.equal(entry.id, shop.id + index + 1); assert.equal(entry.expected.TempID, entry.id); assert.equal(entry.expected.ShopId, shop.id); assert.equal(entry.expected.Type, [5, 6][index]); }
  return { item, shop, shows };
}
async function verifyOriginals() {
  const source = journal().source; assert.ok(source);
  assert.equal(canonical(await json(`/api/admin/items/${SOURCE_ID}`)), canonical(source.template));
  assert.equal(canonical(await json(`/api/admin/shop/${SOURCE_ID}`)), canonical(source.shop));
  for (const show of source.shows) assert.equal(canonical(await json(`/api/admin/shop-show/${show.TempID}`)), canonical(show));
}
async function verifyListing(present: boolean) {
  const { item, shop, shows } = contentPlan();
  const templates = xmlRows(await xml("templatealllist.xml")).filter(x => Number(x.TemplateID) === item.id);
  const listings = xmlRows(await xml("ShopItemList.xml")).filter(x => Number(x.ID) === shop.id);
  const display = xmlRows(await xml("ShopGoodsShowList.xml")).filter(x => Number(x.ShopId) === shop.id);
  assert.equal(templates.length, present ? 1 : 0); assert.equal(listings.length, present ? 1 : 0); assert.equal(display.length, present ? 2 : 0);
  if (present) {
    assert.equal(templates[0]!.Pic, item.expected.Pic); assert.equal(Number(templates[0]!.CategoryID), 7);
    for (const key of ["ID", "TemplateID", "ShopID", "BuyType", "Beat", "AUnit", "APrice1", "AValue1", "APrice2", "AValue2", "APrice3", "AValue3"]) assert.equal(Number(listings[0]![key]), shop.expected[key], `new XML ${key}`);
    assert.deepEqual(display.map(x => Number(x.Type)).sort(), shows.map(x => x.expected.Type).sort());
  }
}
function packet(r: Received) { return GSPacket.wrap(r.pkt.buffer.slice(), r.pkt.length); }
function style(r: Received) { const p = packet(r); for (let n = 0; n < 13; n++) p.readInt(); return p.readString(); }
function privateBalance(r: Received) { const p = packet(r), money = p.readInt(); p.readInt(); p.readInt(); return { money, gold: p.readInt(), giftToken: p.readInt() }; }
function inventory(r: Received): Slot[] {
  const p = packet(r), bag = p.readInt(), count = p.readInt(), rows: Slot[] = []; assert.ok(count >= 0 && count <= 127);
  for (let n = 0; n < count; n++) {
    const slot = p.readInt(); if (!p.readBoolean()) { rows.push({ bag, slot }); continue; }
    const item = { UserID: p.readInt(), ItemID: p.readInt(), Count: p.readInt(), Place: p.readInt(), TemplateID: p.readInt(), IsBinds: false, ValidDate: 0, Pic: "" };
    for (let k = 0; k < 6; k++) p.readInt(); item.IsBinds = p.readBoolean(); p.readBoolean(); p.offset += 7; item.ValidDate = p.readInt();
    p.readString(); p.readString(); p.readBoolean(); for (let k = 0; k < 6; k++) p.readInt(); item.Pic = p.readString(); p.readInt(); p.offset += 7; p.readInt(); p.readByte(); p.readInt(); p.readByte(); p.readInt();
    if (p.readBoolean()) { p.readInt(); p.offset += 7; } p.readString(); p.readString(); p.offset += 7; rows.push({ bag, slot, item });
  }
  return rows;
}
function assertPurchased(item: NonNullable<Slot["item"]>) {
  const plan = contentPlan(); assert.equal(item.TemplateID, plan.item.id); assert.equal(item.Count, 1); assert.equal(item.ValidDate, 7); assert.equal(item.IsBinds, true);
  assert.equal(item.Pic, plan.item.expected.Pic); assert.ok(item.Place >= 31, "purchase must remain unequipped");
}
function buyOne(c: FakeClient) {
  const { shop } = contentPlan();
  c.out(44, p => { p.writeInt(1); p.writeInt(shop.id); p.writeInt(1); p.writeString(""); p.writeBoolean(false); p.writeString(""); p.writeInt(0); p.writeInt(0); });
}
async function legacy(path: string, params: Record<string, string>) {
  const res = await request("/request/" + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) }); assert.equal(res.status, 200); return res.text();
}
async function enter() {
  const r = journal(); assert.ok(account, "fixture credentials missing");
  const login = await json<Auth>("/api/auth/login", "POST", { username: account.username, password: account.password }); remember(login.token); remember(login.play.flashvars.key); assert.equal(login.user.role, "player");
  const temp = remember(randomBytes(12).toString("hex"));
  const date = buildLoginPayload(`${account.username},${login.play.flashvars.key},${temp}`, account.nickname, new Array(8).fill(0)).subarray(0, 7);
  const blob = remember(bytesToBase64(rsaEncryptPkcs1(rsa, Buffer.concat([date, Buffer.from(`${account.username},${login.play.flashvars.key},${temp},${account.nickname}`)]))));
  const result = await legacy("Login.ashx", { p: blob, site: "" }); assert.match(result, /<Result value="true"/);
  const id = Number(/<Item ID="(\d+)"/.exec(result)?.[1]); assert.ok(id > 0);
  if (r.characterId) assert.equal(id, r.characterId); else { r.characterId = id; save(); }
  if (/NickName=""/.test(result)) assert.match(await legacy("VisualizeRegister.ashx", { Name: account.username, Pass: temp, NickName: account.nickname, Sex: String(account.sex) }), /<Result value="true"/);
  const c = await FakeClient.ws("ws://127.0.0.1:9300/ws", "http://127.0.0.1:5173"); clients.push(c); c.login(account.username, temp, rsa); await c.code(95); c.out(16, p => p.writeInt(1)); await c.code(94, 9);
  return { c, style: style(await c.code(67)), funds: privateBalance(await c.code(38)) };
}
async function disconnect(c: FakeClient) {
  c.close(); await c.waitClosed(); const row = await poll(character, x => x.State === 0, "State0 normal disconnect persistence");
  if (journal().baselineStyle !== undefined) assert.equal(row.Style, journal().baselineStyle); return row;
}
async function findPurchasedItem() {
  const r = journal(), plan = contentPlan(); assert.ok(r.baselineItemIds);
  const rows = (await ownedItems()).filter(x => x.TemplateID === plan.item.id && !r.baselineItemIds!.includes(Number(x.ItemID)));
  assert.ok(rows.length <= 1, "ambiguous owned purchase rows");
  if (rows.length) { r.itemId = Number(rows[0]!.ItemID); assert.ok(r.itemId > 0); save(); } return rows[0];
}
async function removeContent(owned: Owned) {
  const plan = contentPlan(), row = await maybe(owned.resource, owned.id); if (!row) return;
  assert.equal(canonical(row), canonical(owned.created ?? owned.expected), "owned content full row changed");
  const exact = (await list(owned.resource, String(owned.id))).filter(x => x[owned.pk] === owned.id); assert.equal(exact.length, 1, "duplicate owned primary key");
  const template = await maybe("items", plan.item.id); assert.ok(template, "owned Name/Pic relation missing before deletion");
  assert.equal(canonical(template), canonical(plan.item.created ?? plan.item.expected)); assert.equal(template.Name, `WorkshopShop_${journal().ownerTag}`); assert.equal(template.Pic, journal().source!.template.Pic);
  const sameName = (await list("items", String(template.Name))).filter(x => x.Name === template.Name); assert.equal(sameName.length, 1); assert.equal(sameName[0]!.TemplateID, plan.item.id);
  await verifyOriginals(); await mutate(`/api/admin/${owned.resource}/${owned.id}`, "DELETE", undefined, row, 204); assert.equal(await maybe(owned.resource, owned.id), undefined);
}
async function cleanup() {
  const r = journal(); for (const c of clients) if (!c.closed) await disconnect(c);
  if (r.characterId) {
    const before = await character(); assert.equal(before.State, 0, "refuse online fixture edits");
    if (r.purchaseSent) { assert.ok(r.baseline && r.baselineItemIds); await findPurchasedItem(); }
    if (r.itemId) {
      const row = await json(`/api/admin/player-items/${r.itemId}`); assert.equal(row.ItemID, r.itemId); assert.equal(row.UserID, r.characterId); assert.equal(row.TemplateID, contentPlan().item.id);
      assert.ok(r.baselineItemIds && !r.baselineItemIds.includes(r.itemId)); assert.ok(Number(row.Place) >= 31, "owned purchase became equipped");
      const changed = await mutate(`/api/admin/player-items/${r.itemId}`, "PATCH", { IsExist: false, Count: 0 }, row); assert.equal(changed.IsExist, false); assert.equal(changed.Count, 0);
    }
    if (r.baseline) {
      await mutate(`/api/admin/players/${r.characterId}`, "PATCH", r.baseline, balance(before)); assert.deepEqual(balance(await character()), r.baseline);
      const restored = await enter(); assert.equal(restored.style, r.baselineStyle); assert.deepEqual(restored.funds, { money: r.baseline.Money + r.baseline.MoneyLock, gold: r.baseline.Gold, giftToken: r.baseline.GiftToken });
      await restored.c.waitFor(x => x.code === 64 && inventory(x).some(s => s.bag === 0));
      assert.ok(!restored.c.received.filter(x => x.code === 64).flatMap(inventory).some(s => s.item?.TemplateID === contentPlan().item.id));
      const final = await disconnect(restored.c); assert.deepEqual(balance(final), r.baseline);
      assert.deepEqual((await ownedItems()).filter(x => x.IsExist === true).map(x => Number(x.ItemID)).sort((a, b) => a - b), r.baselineItemIds);
      snapshot("restored-fixture", { state: final.State, style: final.Style, funds: balance(final), inactiveItemId: r.itemId });
    }
  }
  if (r.owned && r.source) {
    const plan = contentPlan(); for (const show of plan.shows) await removeContent(show); await removeContent(plan.shop); await removeContent(plan.item);
    await json("/api/admin/events/reload", "POST", {}); await verifyListing(false); await verifyOriginals();
    for (const before of r.source.xml) { const text = await xml(before.path); assert.equal(sha(text), before.hash, `original XML ${before.path} hash`); assert.equal(xmlRows(text).length, before.rows); }
  }
  r.cleanupAccepted = true; r.phase = "rolled-back"; save(); check("rollback: owned show→shop→template absent, original full rows/XML restored; fixture balance/style/State0 restored; test account/quests/inactive item retained");
}
async function verifyRollback() {
  const r = journal(); assert.equal(r.phase, "rolled-back"); assert.equal(r.insufficientAccepted, true); assert.equal(r.businessAccepted, true); assert.equal(r.cleanupAccepted, true);
  const plan = contentPlan(); for (const owned of r.owned!) assert.equal(await maybe(owned.resource, owned.id), undefined, "owned content remains after rollback");
  await verifyListing(false); await verifyOriginals();
  for (const before of r.source!.xml) { const text = await xml(before.path); assert.equal(sha(text), before.hash); assert.equal(xmlRows(text).length, before.rows); }
  const player = await character(); assert.equal(player.State, 0); assert.equal(player.Style, r.baselineStyle); assert.deepEqual(balance(player), r.baseline);
  const rows = await ownedItems(); assert.deepEqual(rows.filter(x => x.IsExist === true).map(x => Number(x.ItemID)).sort((a, b) => a - b), r.baselineItemIds);
  assert.ok(!rows.some(x => x.TemplateID === plan.item.id && x.IsExist === true)); assert.ok(r.itemId);
  const retained = await json(`/api/admin/player-items/${r.itemId}`); assert.equal(retained.ItemID, r.itemId); assert.equal(retained.UserID, r.characterId); assert.equal(retained.TemplateID, plan.item.id); assert.equal(retained.IsExist, false); assert.equal(retained.Count, 0);
  snapshot("independent-rollback-readback", { contentKeysAbsent: r.owned!.length, sourceXmlHashesRestored: r.source!.xml.length, state: player.State, style: player.Style, funds: balance(player), inactiveItemId: r.itemId, inactiveItemCount: retained.Count });
  check("read-only verification: all four owned content keys absent, original rows/XML baseline equal, fixture State0/style/8 balances/active ItemIDs restored, exact retained item inactive");
}
async function main() {
  assert.equal([run, rollback, verify].filter(Boolean).length, 1, "choose --run, --rollback or --verify"); assert.equal(base.protocol, "http:"); assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)); assert.ok(!base.username && !base.password);
  if (run) {
    assert.ok(!existsSync(reportPath), "existing custom-shop journal: use --rollback, never overwrite or register again"); assert.ok(!existsSync(credentialsPath), "existing custom-shop credentials: preserve and inspect the journal");
    receipt = { version: 1, date: new Date().toISOString(), node: process.version, base: base.href, ownerTag: randomBytes(6).toString("hex"), phase: "preflight", ok: false, insufficientAccepted: false, businessAccepted: false, cleanupAccepted: false, sensitiveAuditAccepted: false, renderingAccepted: false, checks: [], operations: [], snapshots: [], retainedTestAccount: true, questSideEffectsRetained: true, inactivePurchasedRowRetained: true, resourceWrites: 0 };
    try { save(true); } catch (error) { receipt = undefined; throw error; }
  } else { receipt = JSON.parse(readFileSync(reportPath, "utf8")); assert.equal(journal().version, 1); assert.equal(journal().base, base.href); }
  const env = parseEnv(readFileSync(resolve(repo, ".env.workshop"), "utf8")); for (const [k, v] of Object.entries(env)) if (v && /SECRET|TOKEN|PASSWORD|RSA_PRIVATE_KEY_FILE|DATABASE_URL/.test(k)) remember(v);
  rsa = parseDotNetRsaXml(remember(readFileSync(env.RSA_PRIVATE_KEY_FILE!, "utf8"))) as RsaPrivateKey;
  const admins: (Account & { admin?: boolean })[] = JSON.parse(readFileSync(resolve(runtime, "credentials/smoke-accounts.json"), "utf8")); const gm = admins.find(x => x.admin === true); assert.ok(gm); remember(gm.username); remember(gm.password);
  const auth = await json<Auth>("/api/auth/login", "POST", { username: gm.username, password: gm.password }); remember(auth.play.flashvars.key); token = remember(auth.token); assert.equal(auth.user.role, "admin");
  if (rollback || verify) { account = JSON.parse(readFileSync(credentialsPath, "utf8")); assert.equal(account!.ownerTag, journal().ownerTag); remember(account!.username); remember(account!.password); remember(account!.nickname); if (verify) await verifyRollback(); else await cleanup(); }
  else {
    await preflight(); const r = journal();
    const tag = randomBytes(4).toString("hex"); account = { username: remember(`cshop_${tag}`), password: remember(randomBytes(18).toString("hex")), nickname: remember(`CShop${tag}`), sex: false, ownerTag: r.ownerTag };
    mkdirSync(dirname(credentialsPath), { recursive: true }); writeFileSync(credentialsPath, JSON.stringify(account, null, 2) + "\n", { mode: 0o600, flag: "wx" }); r.phase = "register-planned"; save();
    const registered = await json<Auth>("/api/auth/register", "POST", { username: account.username, password: account.password }, 201); remember(registered.token); remember(registered.play.flashvars.key); assert.equal(registered.user.role, "player");
    const initial = await enter(), first = await disconnect(initial.c); r.baselineStyle = initial.style; r.baseline = balance(first); r.baselineItemIds = (await ownedItems()).filter(x => x.IsExist === true).map(x => Number(x.ItemID)).sort((a, b) => a - b); r.phase = "baseline-saved"; save();
    for (const owned of r.owned!) { assert.equal(await maybe(owned.resource, owned.id), undefined); owned.created = await mutate(`/api/admin/${owned.resource}`, "POST", owned.expected, null, 201); assert.equal(canonical(owned.created), canonical(owned.expected)); save(); }
    snapshot("cache-reload", await json("/api/admin/events/reload", "POST", {})); await verifyListing(true); await verifyOriginals(); r.phase = "listed"; save(); check("new non-suit template, positive-cost shop and source Type5/6 shows are present in real generated static XML");
    assert.equal(r.baseline.Money, 0, "insufficient-funds check requires the untouched fresh zero Money balance"); assert.equal(r.baseline.MoneyLock, 0);
    const empty = await enter(); assert.equal(empty.style, r.baselineStyle); assert.deepEqual(empty.funds, { money: 0, gold: r.baseline.Gold, giftToken: r.baseline.GiftToken });
    await empty.c.waitFor(x => x.code === 64 && inventory(x).some(s => s.bag === 0));
    const emptyMark = empty.c.mark(); r.purchaseSent = true; r.phase = "insufficient-purchase-sent"; save(); buyOne(empty.c);
    const deniedReply = packet(await empty.c.code(44, undefined, emptyMark)); assert.equal(deniedReply.readInt(), 1); assert.equal(deniedReply.readInt(), 3);
    const deniedSaved = await disconnect(empty.c), deniedPackets = empty.c.received.slice(emptyMark); assert.deepEqual(balance(deniedSaved), r.baseline);
    for (const received of deniedPackets.filter(x => x.code === 38)) assert.deepEqual(privateBalance(received), empty.funds);
    assert.ok(!deniedPackets.filter(x => x.code === 64).flatMap(inventory).some(s => s.item?.TemplateID === contentPlan().item.id));
    const deniedItems = await ownedItems(); assert.equal(deniedItems.filter(x => x.TemplateID === contentPlan().item.id).length, 0);
    assert.deepEqual(deniedItems.filter(x => x.IsExist === true).map(x => Number(x.ItemID)).sort((a, b) => a - b), r.baselineItemIds);
    r.insufficientAccepted = true; snapshot("insufficient-funds", { price: PRICE, code44: [1, 3], state: deniedSaved.State, funds: balance(deniedSaved), activeItemIds: r.baselineItemIds, newTemplateRows: 0 }); check("zero Money real 44 attempt: normal disconnect remains State0, all balances and active ItemIDs unchanged, no row for the new template");
    const before = await character(); assert.equal(before.State, 0); assert.deepEqual(balance(before), r.baseline);
    if (r.baseline.Money + r.baseline.MoneyLock < PRICE) await mutate(`/api/admin/players/${r.characterId}`, "PATCH", { Money: r.baseline.Money + PRICE }, balance(before));
    r.funded = balance(await character()); const fromLock = Math.min(r.funded.MoneyLock, PRICE); r.expectedPaid = { ...r.funded, MoneyLock: r.funded.MoneyLock - fromLock, Money: r.funded.Money - (PRICE - fromLock) }; r.phase = "ready-to-buy"; save();
    const live = await enter(); assert.equal(live.style, r.baselineStyle); assert.deepEqual(live.funds, { money: r.funded.Money + r.funded.MoneyLock, gold: r.funded.Gold, giftToken: r.funded.GiftToken });
    const mark = live.c.mark(), plan = contentPlan(); r.purchaseSent = true; r.phase = "purchase-sent"; save();
    buyOne(live.c);
    const reply = packet(await live.c.code(44, undefined, mark)); assert.equal(reply.readInt(), 1); assert.equal(reply.readInt(), 3);
    const update = await live.c.waitFor(x => x.code === 38 && privateBalance(x).money === r.expectedPaid!.Money + r.expectedPaid!.MoneyLock, 4000, mark); assert.deepEqual(privateBalance(update), { money: r.expectedPaid.Money + r.expectedPaid.MoneyLock, gold: r.expectedPaid.Gold, giftToken: r.expectedPaid.GiftToken });
    const changed = await live.c.waitFor(x => x.code === 64 && inventory(x).some(s => s.bag === 0 && s.item?.TemplateID === plan.item.id), 4000, mark), bought = inventory(changed).filter(s => s.item?.TemplateID === plan.item.id); assert.equal(bought.length, 1); assertPurchased(bought[0]!.item!); snapshot("purchase-packets", { code44: [1, 3], funds: privateBalance(update), item: bought[0] });
    const saved = await disconnect(live.c); assert.deepEqual(balance(saved), r.expectedPaid);
    const row = await poll(findPurchasedItem, x => !!x, "stable purchased ItemID persistence"); assert.ok(row); assert.equal(row.UserID, r.characterId); assert.equal(row.IsExist, true); assert.equal(row.Count, 1); assert.equal(row.ValidDate, 7); assert.equal(row.IsBinds, true);
    assert.deepEqual((await ownedItems()).filter(x => x.IsExist === true && x.ItemID !== r.itemId).map(x => Number(x.ItemID)).sort((a, b) => a - b), r.baselineItemIds); snapshot("saved-purchase", { state: saved.State, funds: balance(saved), itemId: r.itemId, templateId: row.TemplateID });
    const fresh = await enter(); assert.equal(fresh.style, r.baselineStyle); assert.deepEqual(fresh.funds, { money: r.expectedPaid.Money + r.expectedPaid.MoneyLock, gold: r.expectedPaid.Gold, giftToken: r.expectedPaid.GiftToken });
    const loaded = await fresh.c.waitFor(x => x.code === 64 && inventory(x).some(s => s.item?.ItemID === r.itemId)); const item = inventory(loaded).find(s => s.item?.ItemID === r.itemId)!.item!; assertPurchased(item); assert.equal(item.UserID, r.characterId); await disconnect(fresh.c);
    r.businessAccepted = true; r.phase = "persistent-purchase"; snapshot("fresh-login", { funds: fresh.funds, item }); check("real 44 purchase: 38 debits 37 Money, 64 contains one bound 7-day non-suit item; State0 and fresh HTTP/RSA/WS login persist the same ItemID"); await cleanup();
  }
  journal().ok = journal().insufficientAccepted && journal().businessAccepted && journal().cleanupAccepted; save(); if (!journal().ok) process.exitCode = 1;
}
try { await main(); }
catch (error) {
  if (receipt) { receipt.ok = false; receipt.error = redact(error instanceof Error ? error.message : String(error)); save();
    if (run && token && receipt.source) try { await cleanup(); } catch (cleanupError) { receipt.cleanupError = redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)); save(); }
  }
  process.exitCode = 1; console.error(redact(error instanceof Error ? error.message : String(error)));
} finally {
  for (const c of clients) if (!c.closed) { c.close(); await c.waitClosed().catch(() => undefined); }
  if (receipt) {
    receipt.sensitiveAuditAccepted = false; save(); const report = readFileSync(reportPath, "utf8");
    if ([...secrets].some(s => report.includes(s))) { receipt.ok = false; receipt.error = "private value or encoding reached the journal"; process.exitCode = 1; }
    else receipt.sensitiveAuditAccepted = true;
    save(); console.log(JSON.stringify({ ok: receipt.ok, phase: receipt.phase, insufficientAccepted: receipt.insufficientAccepted, businessAccepted: receipt.businessAccepted, cleanupAccepted: receipt.cleanupAccepted, sensitiveAuditAccepted: receipt.sensitiveAuditAccepted, renderingAccepted: false, error: receipt.error, cleanupError: receipt.cleanupError, reportPath }, replacer, 2));
  }
}
