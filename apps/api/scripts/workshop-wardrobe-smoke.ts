/** Real local HTTP + encrypted TCP/WS wardrobe lifecycle. No mocks, CU or auth bypass.
 * --apply --hold leaves the isolated fixture equipped for the controller's AS3 visual check.
 * --rollback removes only journalled exact items/mail/template/upload keys after a fresh normal login.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { inflateSync } from "node:zlib";
import { buildLoginPayload, bytesToBase64, GSPacket, parseDotNetRsaXml, rsaEncryptPkcs1, type RsaPrivateKey } from "@ddt/protocol";
import { FakeClient, type Received } from "../../game/test/helpers.js";
import type { WardrobeCheckResult } from "../src/lib/wardrobe.js";

process.env.TZ = "UTC";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtime = resolve(repo, "../../runtime");
const env = parseEnv(readFileSync(resolve(repo, ".env.workshop"), "utf8"));
const base = new URL(process.env.WORKSHOP_API_URL ?? "http://127.0.0.1:8080");
assert.equal(base.protocol, "http:");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "only the project-local API is allowed");
const apply = process.argv.includes("--apply"), rollback = process.argv.includes("--rollback"), hold = process.argv.includes("--hold");
assert.ok(!(apply && rollback), "choose --apply or --rollback");
const reportPath = resolve(runtime, apply || rollback ? "content-research/wardrobe-lifecycle.json" : "content-research/wardrobe-live-preflight.json");
const credentialsPath = resolve(runtime, "credentials/wardrobe-fixture-account.json");
type Row = Record<string, unknown>;
type Account = { username: string; password: string; nickname: string; sex: boolean };
type Auth = { token: string; user: { role: string }; play: { flashvars: { key: string } } };
type AssetPlan = { key: string; source: string; sha256: string; bytes: number };
type Receipt = {
  date: string; node: string; base: string; phase: string; checks: string[]; cleanup: string[]; assets: AssetPlan[];
  renderingAccepted: false; protocolAccepted: boolean; ok: boolean; error?: string;
  source?: { id: number; hash: string; itemCount: number; xmlHash: string };
  template?: { id: number; pic: string; hash: string };
  fixture?: { username: string; characterId: number; nickname: string; credentialsPath: string; baselineStyle: string; gold: number; money: number };
  mail?: { id: number; itemId: number }; checks815?: WardrobeCheckResult; originalCheck?: WardrobeCheckResult; copiedCheck?: WardrobeCheckResult;
  snapshots: { stage: string; style: string; item?: Row }[];
};
// Reject before entering the receipt-writing finally block: a refused repeat must preserve the rollback journal.
if (apply && existsSync(reportPath)) {
  const old: Receipt = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.ok(["rolled-back", "preflight"].includes(old.phase), "an earlier wardrobe fixture needs rollback first");
}
const receipt: Receipt = rollback ? JSON.parse(readFileSync(reportPath, "utf8")) : { date: new Date().toISOString(), node: process.version, base: base.href, phase: "preflight", checks: [], cleanup: [], assets: [], snapshots: [], renderingAccepted: false, protocolAccepted: false, ok: false };
let token = "", fixtureAccount: Account | undefined;
const clients: FakeClient[] = [];
const rsa = parseDotNetRsaXml(readFileSync(env.RSA_PRIVATE_KEY_FILE!, "utf8")) as RsaPrivateKey;
const sha = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
const rowHash = (row: Row) => sha(JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))));
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function save() { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(receipt, null, 2) + "\n"); }
function check(message: string) { receipt.checks.push(message); save(); console.log(message); }
async function request(path: string, init: RequestInit = {}) {
  return fetch(new URL(path, base), { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers }, signal: AbortSignal.timeout(20_000) });
}
async function json<T = Row>(path: string, method = "GET", body?: unknown, expected = 200): Promise<T> {
  const response = await request(path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  assert.equal(response.status, expected, `${method} ${path}: unexpected status`);
  return expected === 204 ? undefined as T : response.json() as Promise<T>;
}
async function status(path: string) { const response = await request(path); await response.arrayBuffer(); return response.status; }
async function list(resource: string, q?: string): Promise<{ items: Row[]; total: number }> {
  return json(`/api/admin/${resource}?pageSize=500${q === undefined ? "" : "&q=" + encodeURIComponent(q)}`);
}
async function xml() {
  const response = await request("/request/templatealllist.xml"); assert.equal(response.status, 200);
  const body = Buffer.from(await response.arrayBuffer());
  return (body[0] === 0x78 ? inflateSync(body) : body).toString("utf8");
}
async function poll<T>(read: () => Promise<T>, accepts: (result: T) => boolean, label: string): Promise<T> {
  for (let n = 0; n < 80; n++) { const result = await read(); if (accepts(result)) return result; await delay(250); }
  throw new Error(`timed out: ${label}`);
}
function packet(r: Received) { return GSPacket.wrap(r.pkt.buffer.slice(), r.pkt.length); }
function style(r: Received) { const p = packet(r); for (let n = 0; n < 13; n++) p.readInt(); return p.readString(); }
function inventory(r: Received): { bag: number; slot: number; item?: Row }[] {
  const p = packet(r), bag = p.readInt(), count = p.readInt();
  const rows: { bag: number; slot: number; item?: Row }[] = [];
  assert.ok(count >= 0 && count <= 127, "invalid inventory slot count");
  for (let n = 0; n < count; n++) {
    const slot = p.readInt();
    if (!p.readBoolean()) { rows.push({ bag, slot }); continue; }
    const item: Row = { UserID: p.readInt(), ItemID: p.readInt(), Count: p.readInt(), Place: p.readInt(), TemplateID: p.readInt() };
    for (let k = 0; k < 6; k++) p.readInt();
    p.readBoolean(); p.readBoolean(); p.offset += 7; p.readInt(); p.readString(); p.readString(); p.readBoolean();
    for (let k = 0; k < 6; k++) p.readInt();
    item.Pic = p.readString(); p.readInt(); p.offset += 7; p.readInt();
    p.readByte(); p.readInt(); p.readByte(); p.readInt();
    if (p.readBoolean()) { p.readInt(); p.offset += 7; }
    p.readString(); p.readString(); p.offset += 7;
    rows.push({ bag, slot, item });
  }
  return rows;
}
async function legacy(path: string, params: Record<string, string>) {
  const response = await request("/request/" + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  assert.equal(response.status, 200); return response.text();
}
async function enter(account: Account, transport: "tcp" | "ws") {
  const login = await json<Auth>("/api/auth/login", "POST", { username: account.username, password: account.password });
  assert.equal(login.user.role, "player");
  const temp = randomBytes(12).toString("hex");
  const date = buildLoginPayload(`${account.username},${login.play.flashvars.key},${temp}`, account.nickname, new Array(8).fill(0)).subarray(0, 7);
  const blob = bytesToBase64(rsaEncryptPkcs1(rsa, Buffer.concat([date, Buffer.from(`${account.username},${login.play.flashvars.key},${temp},${account.nickname}`)])));
  const result = await legacy("Login.ashx", { p: blob, site: "" }); assert.match(result, /<Result value="true"/);
  const id = Number(/<Item ID="(\d+)"/.exec(result)?.[1]); assert.ok(id > 0);
  if (/NickName=""/.test(result)) assert.match(await legacy("VisualizeRegister.ashx", { Name: account.username, Pass: temp, NickName: account.nickname, Sex: String(account.sex) }), /<Result value="true"/);
  const c = transport === "tcp" ? await FakeClient.tcp(9200) : await FakeClient.ws("ws://127.0.0.1:9300/ws", "http://127.0.0.1:5173");
  clients.push(c); c.login(account.username, temp, rsa); await c.code(95);
  c.out(16, p => p.writeInt(1)); await c.code(94, 9);
  if (receipt.fixture) assert.equal(id, receipt.fixture.characterId, "character ID changed after reconnect");
  return { c, id, style: style(await c.code(67)) };
}
async function disconnect(c: FakeClient, expectedStyle: string) {
  c.close(); await c.waitClosed();
  const row = await poll(() => json<Row>(`/api/admin/players/${receipt.fixture!.characterId}`), row => row.State === 0 && row.Style === expectedStyle, "quit saved style");
  assert.equal(row.Gold, receipt.fixture!.gold); assert.equal(row.Money, receipt.fixture!.money);
  return row;
}
async function ownedItem(): Promise<Row> { return json(`/api/admin/player-items/${receipt.mail!.itemId}`); }
async function move(c: FakeClient, from: number, to: number, equipped: boolean) {
  const mark = c.mark(), expected = `${receipt.template!.id}|${receipt.template!.pic}`;
  c.out(49, p => { p.writeByte(0); p.writeInt(from); p.writeByte(0); p.writeInt(to); p.writeInt(0); p.writeBoolean(false); });
  const slot = await c.waitFor(r => r.code === 64 && inventory(r).some(x => x.bag === 0 && x.item?.ItemID === receipt.mail!.itemId && (equipped ? x.slot === 11 : x.slot >= 31)), 4000, mark);
  const changed = inventory(slot).find(x => x.item?.ItemID === receipt.mail!.itemId)!;
  assert.equal(changed.item!.TemplateID, receipt.template!.id); assert.equal(changed.item!.Pic, receipt.template!.pic);
  const update = await c.waitFor(r => r.code === 67 && style(r).includes(expected) === equipped, 4000, mark);
  return { style: style(update), item: changed.item! };
}
async function cleanup() {
  for (const c of clients) if (!c.closed) c.close();
  if (receipt.fixture && receipt.mail && fixtureAccount && await status(`/api/admin/player-items/${receipt.mail.itemId}`) === 200) {
    const row = await ownedItem(); assert.equal(row.TemplateID, receipt.template!.id); assert.equal(row.UserID, receipt.fixture.characterId);
    if (row.Place === 11) {
      const live = await enter(fixtureAccount, "tcp");
      const changed = await move(live.c, 11, -1, false); await disconnect(live.c, changed.style);
    }
    const current = await ownedItem(); assert.equal(current.TemplateID, receipt.template!.id); assert.equal(current.UserID, receipt.fixture.characterId);
    await json(`/api/admin/player-items/${receipt.mail.itemId}`, "DELETE", undefined, 204);
    assert.equal(await status(`/api/admin/player-items/${receipt.mail.itemId}`), 404);
    receipt.cleanup.push(`removed item ${receipt.mail.itemId}`); save();
  }
  if (receipt.mail && await status(`/api/admin/player-mail/${receipt.mail.id}`) === 200) {
    const mail = await json<Row>(`/api/admin/player-mail/${receipt.mail.id}`);
    assert.equal(mail.ReceiverID, receipt.fixture!.characterId);
    assert.ok(mail.Annex1 === null || mail.Annex1 === String(receipt.mail.itemId), "mail attachment changed externally");
    await json(`/api/admin/player-mail/${receipt.mail.id}`, "DELETE", undefined, 204);
    assert.equal(await status(`/api/admin/player-mail/${receipt.mail.id}`), 404);
    receipt.cleanup.push(`removed mail ${receipt.mail.id}`); save();
  }
  if (receipt.template && await status(`/api/admin/items/${receipt.template.id}`) === 200) {
    assert.equal(rowHash(await json<Row>(`/api/admin/items/${receipt.template.id}`)), receipt.template.hash, "template changed externally; refusing deletion");
    await json(`/api/admin/items/${receipt.template.id}`, "DELETE", undefined, 204);
    await poll(xml, text => !text.includes(`TemplateID="${receipt.template!.id}"`), "XML template rollback");
    receipt.cleanup.push(`removed template ${receipt.template.id}`); save();
  }
  for (const asset of [...receipt.assets].reverse()) {
    assert.ok(asset.key.startsWith(`image/equip/f/suits/${receipt.template!.pic}/`), "unexpected cleanup resource key");
    const prefix = dirname(asset.key).replaceAll("\\", "/");
    const stored = await json<Row[]>(`/api/admin/assets?prefix=${encodeURIComponent(prefix)}`);
    if (!stored.some(row => row.key === asset.key)) continue;
    const response = await request("/resource/" + asset.key); assert.equal(response.headers.get("x-placeholder"), null);
    assert.equal(sha(Buffer.from(await response.arrayBuffer())), asset.sha256, "resource changed externally; refusing deletion");
    await json(`/api/admin/assets/${encodeURIComponent(asset.key)}`, "DELETE", undefined, 204);
    assert.ok(!(await json<Row[]>(`/api/admin/assets?prefix=${encodeURIComponent(prefix)}`)).some(row => row.key === asset.key));
    const removed = await request("/resource/" + asset.key); assert.equal(removed.headers.get("x-placeholder"), "1"); await removed.arrayBuffer();
    receipt.cleanup.push(`removed upload ${asset.key}`); save();
  }
  if (receipt.source) {
    assert.equal(rowHash(await json<Row>(`/api/admin/items/${receipt.source.id}`)), receipt.source.hash);
    assert.equal((await list("items")).total, receipt.source.itemCount);
    assert.equal(sha(await xml()), receipt.source.xmlHash);
  }
  if (receipt.fixture) {
    const character = await json<Row>(`/api/admin/players/${receipt.fixture.characterId}`);
    assert.equal(character.Style, receipt.fixture.baselineStyle); assert.equal(character.State, 0);
    assert.equal(character.Gold, receipt.fixture.gold); assert.equal(character.Money, receipt.fixture.money);
  }
  receipt.phase = "rolled-back"; receipt.ok = true; save();
}

try {
  const accounts: (Account & { admin?: boolean })[] = JSON.parse(readFileSync(resolve(runtime, "credentials/smoke-accounts.json"), "utf8"));
  const gm = accounts[2]!; assert.equal(gm.admin, true);
  const auth = await json<Auth>("/api/auth/login", "POST", { username: gm.username, password: gm.password });
  assert.equal(auth.user.role, "admin"); token = auth.token;
  if (rollback) {
    fixtureAccount = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.equal(fixtureAccount!.username, receipt.fixture!.username);
    await cleanup(); check("exact fixture item/mail/template/upload rollback; original hashes/count/XML and baseline style restored");
  } else {
    const source = await json<Row>("/api/admin/items/13102");
    receipt.originalCheck = await json<WardrobeCheckResult>("/api/admin/items/wardrobe-check", "POST", source);
    assert.equal(receipt.originalCheck.state, "ok"); assert.equal(receipt.originalCheck.renderingAccepted, false);
    receipt.checks815 = await json<WardrobeCheckResult>("/api/admin/items/wardrobe-check", "POST", { CategoryID: 13, Pic: "suits815", NeedSex: 0, Property8: 1 });
    assert.equal(receipt.checks815.state, "incompatible"); assert.equal(receipt.checks815.renderingAccepted, false);
    assert.ok(receipt.checks815.assets.filter(x => ["game", "game1"].includes(x.kind)).every(x => x.state === "incompatible"));
    receipt.source = { id: Number(source.TemplateID), hash: rowHash(source), itemCount: (await list("items")).total, xmlHash: sha(await xml()) };
    check("live HTTP: 815 incompatible; source 13102/suits2 static grid accepted (not visual acceptance)");
    if (apply) {
      const tag = randomBytes(4).toString("hex"), pic = `ww_suit_${tag}`;
      let id = 1399700; while (await status(`/api/admin/items/${id}`) !== 404) { id++; assert.ok(id < 1399800, "isolated template ID range exhausted"); }
      const planned = { ...source, TemplateID: id, Pic: pic, Name: `本地套装验证${tag}`, Description: "Isolated local wardrobe fixture", Remark: `ww_${tag}` };
      receipt.template = { id, pic, hash: rowHash(planned) };
      assert.equal((await json<Row[]>(`/api/admin/assets?prefix=${encodeURIComponent(`image/equip/f/suits/${pic}`)}`)).length, 0);
      for (const asset of receipt.originalCheck.assets) {
        const response = await request("/resource/" + asset.path); assert.equal(response.status, 200); assert.equal(response.headers.get("x-placeholder"), null);
        const body = Buffer.from(await response.arrayBuffer()); assert.equal(sha(body), asset.sha256);
        const key = asset.path.replace("/suits/suits2/", `/suits/${pic}/`);
        const before = await request("/resource/" + key); assert.equal(before.headers.get("x-placeholder"), "1"); await before.arrayBuffer();
        receipt.assets.push({ key, source: asset.path, sha256: sha(body), bytes: body.length }); save();
        const fd = new FormData(); fd.append("folder", dirname(key).replaceAll("\\", "/")); fd.append("file", new Blob([body], { type: "image/png" }), basename(key));
        const uploaded = await request("/api/admin/assets", { method: "POST", body: fd }); assert.equal(uploaded.status, 201); assert.equal((await uploaded.json()).key, key);
      }
      const created = await json<Row>("/api/admin/items", "POST", planned, 201); assert.equal(rowHash(created), receipt.template.hash);
      await json("/api/admin/items", "POST", planned, 409);
      await poll(xml, text => text.includes(`TemplateID="${id}"`) && text.includes(`Pic="${pic}"`), "generated XML contains new suit");
      receipt.copiedCheck = await json<WardrobeCheckResult>("/api/admin/items/wardrobe-check", "POST", planned); assert.equal(receipt.copiedCheck.state, "ok");
      for (const asset of receipt.copiedCheck.assets) assert.equal(asset.sha256, receipt.assets.find(x => x.key === asset.path)?.sha256);
      await json("/api/admin/events/reload", "POST", {}); // Existing authenticated endpoint waits for the game cache reload.
      check("4 byte-identical isolated overlay uploads + new template + 409 conflict + XML + real game template reload");
      fixtureAccount = { username: `ww_${tag}`, password: randomBytes(18).toString("hex"), nickname: `Ward${tag}`, sex: false };
      mkdirSync(dirname(credentialsPath), { recursive: true }); writeFileSync(credentialsPath, JSON.stringify(fixtureAccount, null, 2) + "\n", { mode: 0o600 });
      await json<Auth>("/api/auth/register", "POST", { username: fixtureAccount.username, password: fixtureAccount.password }, 201);
      let live = await enter(fixtureAccount, "tcp");
      const baseline = await json<Row>(`/api/admin/players/${live.id}`);
      receipt.fixture = { username: fixtureAccount.username, characterId: live.id, nickname: fixtureAccount.nickname, credentialsPath, baselineStyle: live.style, gold: Number(baseline.Gold), money: Number(baseline.Money) }; save();
      const beforeMail = new Set((await list("player-mail", String(live.id))).items.filter(m => m.ReceiverID === live.id).map(m => m.ID));
      await json(`/api/admin/players/${live.id}/give-item`, "POST", { templateId: id, count: 1, validDays: 0 });
      const mail = await poll(async () => (await list("player-mail", String(live.id))).items.find(m => m.ReceiverID === live.id && !beforeMail.has(m.ID) && Number(m.Annex1) > 0), m => !!m, "targeted GM mail");
      receipt.mail = { id: Number(mail!.ID), itemId: Number(mail!.Annex1) }; save();
      const mark = live.c.mark(); live.c.out(113, p => { p.writeInt(receipt.mail!.id); p.writeByte(1); });
      const taken = await live.c.code(113, undefined, mark); assert.equal(taken.pkt.readInt(), receipt.mail.id); assert.equal(taken.pkt.readInt(), 1); assert.equal(taken.pkt.readInt(), 1);
      const received = await ownedItem(); assert.equal(received.UserID, live.id); assert.equal(received.TemplateID, id); assert.ok(Number(received.Place) >= 31);
      const repeatMark = live.c.mark(); live.c.out(113, p => { p.writeInt(receipt.mail!.id); p.writeByte(1); });
      const repeat = await live.c.code(113, undefined, repeatMark); repeat.pkt.readInt(); assert.equal(repeat.pkt.readInt(), 0);
      assert.equal((await list("player-items", String(id))).items.filter(x => x.UserID === live.id && x.TemplateID === id).length, 1);
      const equipped = await move(live.c, Number(received.Place), 11, true); receipt.snapshots.push({ stage: "equipped", ...equipped });
      await disconnect(live.c, equipped.style); assert.equal((await ownedItem()).Place, 11);
      live = await enter(fixtureAccount, "ws"); assert.equal(live.style, equipped.style); assert.equal((await ownedItem()).Place, 11);
      receipt.snapshots.push({ stage: "equipped-ws-relogin", style: live.style, item: await ownedItem() });
      const unequipped = await move(live.c, 11, -1, false); assert.equal(unequipped.style, receipt.fixture.baselineStyle);
      await disconnect(live.c, unequipped.style);
      live = await enter(fixtureAccount, "tcp"); assert.equal(live.style, receipt.fixture.baselineStyle); const off = await ownedItem(); assert.ok(Number(off.Place) >= 31);
      receipt.snapshots.push({ stage: "unequipped-tcp-relogin", style: live.style, item: off });
      const final = await move(live.c, Number(off.Place), 11, true); await disconnect(live.c, final.style);
      receipt.snapshots.push({ stage: "held-equipped-offline", style: final.style, item: await ownedItem() });
      receipt.protocolAccepted = true;
      receipt.phase = hold ? "awaiting-visual" : "cleanup";
      check("normal REST/RSA login → targeted mail claim once → packet49 equip/Style → WS relogin retains → unequip → TCP relogin retains → re-equip saved offline");
      if (hold) { receipt.ok = true; check("isolated equipped fixture held for controller visual check; rollback intentionally pending"); }
      else await cleanup();
    } else { receipt.ok = true; receipt.phase = "preflight"; }
  }
} catch (error) {
  receipt.error = (error as Error).message; receipt.ok = false; process.exitCode = 1;
  if (apply && token && receipt.template) {
    try { await cleanup(); receipt.ok = false; } catch (cleanupError) { receipt.cleanup.push(`cleanup failed: ${(cleanupError as Error).message}`); }
  }
} finally {
  for (const c of clients) if (!c.closed) c.close();
  save(); console.log(JSON.stringify({ ok: receipt.ok, phase: receipt.phase, protocolAccepted: receipt.protocolAccepted, renderingAccepted: false, error: receipt.error, reportPath }, null, 2));
}
