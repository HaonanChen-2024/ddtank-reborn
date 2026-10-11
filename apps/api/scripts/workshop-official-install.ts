/** Bounded wardrobe import using existing authenticated admin endpoints.
 * Defaults to a saved dry-run. --apply uploads into unique overlay paths and creates
 * category-compatible local IDs; --exercise uses isolated player accounts and real
 * RSA/TCP/WS sessions. Originals and previous templates are never overwritten.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { inflateSync } from "node:zlib";
import { buildLoginPayload, bytesToBase64, GSPacket, parseDotNetRsaXml, rsaEncryptPkcs1, type RsaPrivateKey } from "@ddt/protocol";
import { FakeClient, type Received } from "../../game/test/helpers.js";
import type { WardrobeCheckResult } from "../src/lib/wardrobe.js";
import { assertEquippedStyleFits, createAppearancePic } from "./workshop-appearance-identity.js";

type Row = Record<string, any>;
type Account = { username: string; password: string; nickname: string; sex: boolean };
type Asset = { key: string; source: string; sha256: string; bytes: number; uploaded?: boolean };
type Entry = { id: number; officialId?: number; referenceId?: number; name: string; pic: string; categoryId: number; needSex: number; sourceId: number; sourceHash: string; row: Row; assets: Asset[]; installed?: boolean; check?: WardrobeCheckResult; protocolAccepted?: boolean; itemId?: number; mailId?: number };
type Fixture = { characterId: number; credentialsPath: string; baselineStyle: string; gold: number; money: number; style: string };
type Receipt = { version: 1; batchId: string; phase: string; createdAt: string; templates: Entry[]; fixtures: Partial<Record<"m" | "f", Fixture>>; snapshots: Row[]; renderingAccepted: boolean; backup: string; error?: string };
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtime = resolve(repo, "../../runtime"), project = resolve(runtime, "..");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("node --import tsx apps/api/scripts/workshop-official-install.ts --backup=<backup.dump.json> [--acquisition=<official manifest.json> | --reference-acquisition=<visual-only manifest.json>] [--journal=<new-runtime-file>] [--apply --exercise] [--only=<localID,...>]\nWithout an acquisition, uses the legacy verified catalog/map/incoming files; --catalog/--targets/--assets can override them for a new batch. Reference catalogs allow only visual metadata and inherit local category/sex baseline stats. Existing journals resume only; never reuse a journal for new source files. Dry-run is the default. Templates and uploads are retained; rendering must be accepted separately.");
  process.exit(0);
}
const option = (key: string, fallback: string) => resolve(args.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback);
const receiptPath = option("journal", resolve(runtime, "content-research/official-install.json"));
assert.ok(receiptPath.startsWith(runtime + sep), "journal must remain in private runtime");
const catalogPath = option("catalog", resolve(runtime, "official-resource-reverse/diy-catalog.json"));
const targetsPath = option("targets", resolve(project, "wardrobe/官方DIY物品映射.csv"));
const referencePath = args.find(a => a.startsWith("--reference-acquisition="))?.slice("--reference-acquisition=".length);
assert.ok(!referencePath || !args.some(a => a.startsWith("--acquisition=")), "choose one acquisition source");
const acquisitionPath = referencePath ?? args.find(a => a.startsWith("--acquisition="))?.slice(14);
if (acquisitionPath) assert.ok(!args.some(a => /^--(catalog|targets|assets)=/.test(a)), "acquisition manifest supplies its own catalog, targets and assets");
const acquisition = acquisitionPath ? JSON.parse(readFileSync(resolve(acquisitionPath), "utf8")) : null;
if (acquisition) assert.equal(acquisition.source, referencePath ? "http://yj.rzkj.top:521/" : "https://diy-ddt.wan.com/");
const assetsRoot = acquisitionPath ? resolve(dirname(resolve(acquisitionPath)), "assets") : option("assets", resolve(project, "assets/incoming/official-diy-20261011"));
assert.ok(assetsRoot.startsWith(project + sep), "source assets must remain in this project");
const apply = args.includes("--apply"), exercise = args.includes("--exercise");
assert.ok(!exercise || apply, "--exercise requires --apply");
assert.ok(args.every(a => ["--apply", "--exercise"].includes(a) || /^--(journal|catalog|targets|assets|backup|only|acquisition|reference-acquisition)=.+$/.test(a)), "unknown option");
const only = args.find(a => a.startsWith("--only="))?.slice(7).split(",").map(Number);
const base = "http://127.0.0.1:8080";
process.env.TZ = "UTC";
const env = parseEnv(readFileSync(resolve(repo, ".env.workshop"), "utf8"));
const rsa = parseDotNetRsaXml(readFileSync(resolve(repo, env.RSA_PRIVATE_KEY_FILE!), "utf8")) as RsaPrivateKey;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hash = (row: Row) => sha(JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))));
let token = "";
const clients: FakeClient[] = [];
let receipt: Receipt | undefined;
function save() { mkdirSync(dirname(receiptPath), { recursive: true }); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n"); }
async function request(path: string, init: RequestInit = {}) { return fetch(base + path, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers }, signal: AbortSignal.timeout(20000) }); }
async function json<T = Row>(path: string, method = "GET", body?: unknown, expected = 200): Promise<T> {
  const r = await request(path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  assert.equal(r.status, expected, `${method} ${path} status`); return expected === 204 ? undefined as T : r.json() as Promise<T>;
}
async function absent(path: string) { const r = await request(path); await r.arrayBuffer(); assert.equal(r.status, 404, `collision: ${path}`); }
async function nextId(category: number, start: number) {
  for (let id = start; id < category * 1000000 + 1000000; id++) {
    const r = await request(`/api/admin/items/${id}`); await r.arrayBuffer();
    if (r.status === 404) return id; assert.equal(r.status, 200, "could not check local ID allocation");
  }
  throw new Error("compatible local ID range exhausted");
}
async function poll<T>(read: () => Promise<T>, accepts: (x: T) => boolean, label: string): Promise<T> {
  for (let n = 0; n < 80; n++) { const x = await read(); if (accepts(x)) return x; await new Promise(r => setTimeout(r, 250)); }
  throw new Error("timed out: " + label);
}
async function xml() { const r = await request("/request/templatealllist.xml"); assert.equal(r.status, 200); const b = Buffer.from(await r.arrayBuffer()); return (b[0] === 0x78 ? inflateSync(b) : b).toString("utf8"); }
function packet(r: Received) { return GSPacket.wrap(r.pkt.buffer.slice(), r.pkt.length); }
function style(r: Received) { const p = packet(r); for (let n = 0; n < 13; n++) p.readInt(); return p.readString(); }
function inventory(r: Received): Row[] {
  const p = packet(r), bag = p.readInt(), count = p.readInt(), rows: Row[] = [];
  assert.ok(count >= 0 && count <= 127);
  for (let n = 0; n < count; n++) {
    const slot = p.readInt(); if (!p.readBoolean()) continue;
    const row: Row = { bag, slot, UserID: p.readInt(), ItemID: p.readInt(), Count: p.readInt(), Place: p.readInt(), TemplateID: p.readInt() };
    for (let k = 0; k < 6; k++) p.readInt();
    p.readBoolean(); p.readBoolean(); p.offset += 7; p.readInt(); p.readString(); p.readString(); p.readBoolean();
    for (let k = 0; k < 6; k++) p.readInt();
    row.Pic = p.readString(); p.readInt(); p.offset += 7; p.readInt(); p.readByte(); p.readInt(); p.readByte(); p.readInt();
    if (p.readBoolean()) { p.readInt(); p.offset += 7; }
    p.readString(); p.readString(); p.offset += 7; rows.push(row);
  }
  return rows;
}
async function legacy(path: string, params: Record<string, string>) {
  const r = await request("/request/" + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) }); assert.equal(r.status, 200); return r.text();
}
async function enter(account: Account, transport: "tcp" | "ws") {
  const login = await json("/api/auth/login", "POST", { username: account.username, password: account.password }); assert.equal(login.user.role, "player");
  const temp = randomBytes(12).toString("hex"), date = buildLoginPayload(`${account.username},${login.play.flashvars.key},${temp}`, account.nickname, new Array(8).fill(0)).subarray(0, 7);
  const blob = bytesToBase64(rsaEncryptPkcs1(rsa, Buffer.concat([date, Buffer.from(`${account.username},${login.play.flashvars.key},${temp},${account.nickname}`)])));
  const result = await legacy("Login.ashx", { p: blob, site: "" }); assert.match(result, /<Result value="true"/);
  const id = Number(/<Item ID="(\d+)"/.exec(result)?.[1]); assert.ok(id > 0);
  if (/NickName=""/.test(result)) assert.match(await legacy("VisualizeRegister.ashx", { Name: account.username, Pass: temp, NickName: account.nickname, Sex: String(account.sex) }), /<Result value="true"/);
  const c = transport === "tcp" ? await FakeClient.tcp(9200) : await FakeClient.ws("ws://127.0.0.1:9300/ws", "http://127.0.0.1:5173"); clients.push(c);
  c.login(account.username, temp, rsa); await c.code(95); c.out(16, p => p.writeInt(1)); await c.code(94, 9);
  return { c, id, style: style(await c.code(67)) };
}
async function quit(c: FakeClient, fixture: Fixture, expected: string) {
  c.close(); await c.waitClosed();
  const row = await poll(() => json(`/api/admin/players/${fixture.characterId}`), row => row.State === 0 && row.Style === expected, "quit/save");
  assert.equal(row.Gold, fixture.gold); assert.equal(row.Money, fixture.money); fixture.style = expected; save();
}
async function move(live: Awaited<ReturnType<typeof enter>>, entry: Entry, from: number, to: number, equipped: boolean) {
  if (equipped) assertEquippedStyleFits(live.style, to, entry.id, entry.pic);
  const mark = live.c.mark(); live.c.out(49, p => { p.writeByte(0); p.writeInt(from); p.writeByte(0); p.writeInt(to); p.writeInt(0); p.writeBoolean(false); });
  const inventoryUpdate = await live.c.waitFor(r => r.code === 64 && inventory(r).some(x => x.bag === 0 && x.ItemID === entry.itemId && (equipped ? x.slot === to : x.slot >= 31)), 4000, mark);
  const row = inventory(inventoryUpdate).find(x => x.ItemID === entry.itemId)!; assert.equal(row.UserID, live.id); assert.equal(row.TemplateID, entry.id); assert.equal(row.Pic, entry.pic);
  const changed = await live.c.waitFor(r => r.code === 67 && style(r).includes(`${entry.id}|${entry.pic}`) === equipped, 4000, mark);
  return style(changed);
}
async function prepare(): Promise<Receipt> {
  // The map is deliberately a narrow CSV with known columns; richer future targets
  // must first be resolved by workshop-official (which detects duplicate names).
  if (acquisition) assert.equal(acquisition.assetErrors.length, 0, "acquisition contains failed assets");
  const identityKey = referencePath ? "sourceTemplateId" : "officialTemplateId";
  const ids = acquisition ? [...new Set<number>(acquisition.targets.filter((x: Row) => x.status === "matched").map((x: Row) => x[identityKey]))] : readFileSync(targetsPath, "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/).slice(1).map(line => Number(line.split(",")[2]));
  assert.ok(ids.length > 0 && ids.length <= 200 && ids.every(Number.isSafeInteger) && new Set(ids).size === ids.length, "invalid official map");
  const catalog: Row[] = JSON.parse(readFileSync(acquisitionPath ? resolve(dirname(resolve(acquisitionPath)), "catalog.json") : catalogPath, "utf8"));
  const plan: Entry[] = [], allocated: Record<number, number> = {}, batchId = randomBytes(4).toString("hex");
  for (const officialId of ids) {
    const matches = catalog.filter(x => x.templateId === officialId); assert.equal(matches.length, 1, "ambiguous official ID"); const item = matches[0]!;
    assert.ok([1, 2, 3, 4, 5, 6].includes(item.categoryId) && [1, 2].includes(item.needSex));
    // Exact source IDs, rather than display names, identify newer catalog entries.
    if (referencePath) assert.ok(Object.keys(item).every(key => ["templateId", "name", "categoryId", "needSex", "pic", "previewPic", "property8", "description"].includes(key)), "reference catalog must contain visual metadata only");
    const folder = ({ 1: "head", 2: "glass", 3: "hair", 4: "eff", 5: "cloth", 6: "face" } as Record<number, string>)[item.categoryId]!, sex = item.needSex === 1 ? "m" : "f";
    const match = new RegExp(`^/image/equip/${sex}/${folder}/([A-Za-z0-9_]+)/1/${item.categoryId === 3 ? "[ab]/" : ""}show\\.png$`).exec(item.pic); assert.ok(match, "invalid official resource path");
    assert.equal(item.previewPic, `/image/equip/${sex}/${folder}/${match[1]}/icon_1.png`);
    const layers = String(item.property8); assert.match(layers, /^[123]{1,3}$/); assert.equal(new Set(layers).size, layers.length);
    const sourceId = item.categoryId * 1000 + item.needSex * 100 + 1, source = await json(`/api/admin/items/${sourceId}`);
    assert.equal(source.CategoryID, item.categoryId); assert.equal(source.NeedSex, item.needSex); assert.equal(source.CanEquip, true);
    const id = await nextId(item.categoryId, allocated[item.categoryId] ?? item.categoryId * 1000000 + 999100); allocated[item.categoryId] = id + 1;
    // Style is a legacy varchar(200) containing all equipped IDs and Pic names.
    // Keep source identity in the receipt, not in every serialized appearance path.
    const pic = createAppearancePic(id, referencePath ? "reference" : "official");
    const row: Row = { ...source, TemplateID: id, Pic: pic, Name: item.name, Description: item.description, Remark: `${referencePath ? "Reference visual" : "Official DIY"} ${officialId}; local rules from ${sourceId}` };
    if (referencePath) row.Property8 = Number(layers);
    else for (const key of ["Attack", "Defence", "Agility", "Luck", "Quality", ...Array.from({ length: 8 }, (_, i) => `Property${i + 1}`)]) { const value = item[key[0]!.toLowerCase() + key.slice(1)]; assert.ok(Number.isSafeInteger(value), `invalid ${key}`); row[key] = value; }
    const refs = ["icon_1.png"]; for (const layer of layers) for (const variant of item.categoryId === 3 ? ["a/", "b/"] : [""]) for (const kind of ["show", "game"]) refs.push(`${layer}/${variant}${kind}.png`);
    const assets: Asset[] = [];
    for (const suffix of refs) {
      const key = `image/equip/${sex}/${folder}/${pic}/${suffix}`, sourcePath = resolve(assetsRoot, `image/equip/${sex}/${folder}/${match[1]}/${suffix}`), bytes = readFileSync(sourcePath);
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      if (acquisition) {
        const proof = acquisition.assets.filter((x: Row) => x[identityKey] === officialId && x.resourcePath === `image/equip/${sex}/${folder}/${match[1]}/${suffix}`);
        assert.equal(proof.length, 1, "acquisition is missing an exact asset receipt"); assert.equal(sha(bytes), proof[0].sha256, "acquisition asset hash changed");
      }
      const r = await request("/resource/" + key); assert.equal(r.headers.get("x-placeholder"), "1", "resource path collision"); await r.arrayBuffer();
      assets.push({ key, source: sourcePath, sha256: sha(bytes), bytes: bytes.length });
    }
    plan.push({ id, ...(referencePath ? { referenceId: officialId } : { officialId }), name: item.name, categoryId: item.categoryId, needSex: item.needSex, pic, sourceId, sourceHash: hash(source), row, assets });
  }
  const backup = option("backup", ""); assert.ok(existsSync(backup) && backup.endsWith(".dump.json"), "supply --backup=<current project backup.dump.json>");
  const backupData = JSON.parse(readFileSync(backup, "utf8")), session = JSON.parse(readFileSync(resolve(runtime, "workshop-session.json"), "utf8"));
  assert.equal(backupData.sourceDatabase, session.databaseName); assert.equal(sha(readFileSync(resolve(dirname(backup), backupData.dump))), backupData.sha256);
  return { version: 1, batchId, phase: "prepared", createdAt: new Date().toISOString(), templates: plan, fixtures: {}, snapshots: [], renderingAccepted: false, backup };
}
async function main() {
  const gm = (JSON.parse(readFileSync(resolve(runtime, "credentials/smoke-accounts.json"), "utf8")) as (Account & { admin?: boolean })[]).findLast(x => x.admin === true)!; assert.ok(gm);
  const auth = await json("/api/auth/login", "POST", { username: gm.username, password: gm.password }); assert.equal(auth.user.role, "admin"); token = auth.token;
  if (existsSync(receiptPath)) assert.ok(!args.some(a => /^--(catalog|targets|assets|backup|acquisition|reference-acquisition)=/.test(a)), "existing journal is for resume only; use --journal=<new-private-file> for a new source batch");
  receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : await prepare(); assert.equal(receipt!.version, 1);
  receipt!.batchId ??= sha(receipt!.createdAt).slice(0, 8); save();
  const selected = receipt!.templates.filter(e => !only || only.includes(e.id)); assert.ok(selected.length > 0); if (only) assert.equal(selected.length, only.length);
  if (!apply) { console.log(JSON.stringify({ phase: receipt!.phase, templates: selected.map(e => ({ id: e.id, officialId: e.officialId, referenceId: e.referenceId, name: e.name })), assets: selected.reduce((n, e) => n + e.assets.length, 0), receiptPath })); return; }
  for (const entry of selected) {
    assert.equal(hash(await json(`/api/admin/items/${entry.sourceId}`)), entry.sourceHash, "source template changed");
    for (const asset of entry.assets) {
      const bytes = readFileSync(asset.source); assert.equal(sha(bytes), asset.sha256, "source asset changed");
      if (!asset.uploaded) {
        const r = await request("/resource/" + asset.key); assert.equal(r.headers.get("x-placeholder"), "1", "unowned path appeared; inspect journal before continuing"); await r.arrayBuffer();
        const form = new FormData(); form.append("folder", dirname(asset.key).replaceAll("\\", "/")); form.append("file", new Blob([bytes], { type: "image/png" }), basename(asset.key));
        const uploaded = await request("/api/admin/assets", { method: "POST", body: form }); assert.equal(uploaded.status, 201); assert.equal((await uploaded.json()).key, asset.key); asset.uploaded = true; save();
      }
      const r = await request("/resource/" + asset.key); assert.equal(r.status, 200); assert.equal(r.headers.get("x-placeholder"), null); assert.equal(sha(Buffer.from(await r.arrayBuffer())), asset.sha256);
    }
    entry.check = await json<WardrobeCheckResult>("/api/admin/items/wardrobe-check", "POST", entry.row); assert.equal(entry.check.state, "ok"); assert.equal(entry.check.renderingAccepted, false);
    assert.equal(entry.check.assets.length, entry.assets.length); for (const a of entry.check.assets) assert.equal(a.sha256, entry.assets.find(x => x.key === a.path)?.sha256); save();
    if (!entry.installed) { await absent(`/api/admin/items/${entry.id}`); const created = await json("/api/admin/items", "POST", entry.row, 201); assert.equal(hash(created), hash(entry.row)); entry.installed = true; save(); }
    assert.equal(hash(await json(`/api/admin/items/${entry.id}`)), hash(entry.row), "installed template changed");
    console.log(`installed ${entry.name}: local ${entry.id}, ${entry.referenceId ? "reference " + entry.referenceId : "official " + entry.officialId}, ${entry.assets.length} original PNGs`);
  }
  await poll(xml, text => selected.every(e => text.includes(`TemplateID="${e.id}"`) && text.includes(`Pic="${e.pic}"`)), "generated template XML");
  await json("/api/admin/events/reload", "POST", {}); receipt!.phase = "installed"; save();
  if (exercise) for (const sex of ["m", "f"] as const) {
    const entries = selected.filter(e => e.needSex === (sex === "m" ? 1 : 2)); if (!entries.length) continue;
    const credentialsPath = receipt!.fixtures[sex]?.credentialsPath ?? resolve(runtime, `credentials/official-fixture-${receipt!.batchId}-${sex}.json`); let account: Account;
    if (!receipt!.fixtures[sex]) {
      assert.ok(!existsSync(credentialsPath), "unowned fixture credentials already exist"); const tag = randomBytes(4).toString("hex"); account = { username: `official_${sex}_${tag}`, password: randomBytes(18).toString("hex"), nickname: `衣橱${sex}${tag}`, sex: sex === "m" };
      writeFileSync(credentialsPath, JSON.stringify(account, null, 2) + "\n", { mode: 0o600 }); await json("/api/auth/register", "POST", { username: account.username, password: account.password }, 201);
      const live = await enter(account, "tcp"), player = await json(`/api/admin/players/${live.id}`);
      receipt!.fixtures[sex] = { characterId: live.id, credentialsPath, baselineStyle: live.style, gold: player.Gold, money: player.Money, style: live.style }; save(); await quit(live.c, receipt!.fixtures[sex]!, live.style);
    } else account = JSON.parse(readFileSync(credentialsPath, "utf8"));
    const fixture = receipt!.fixtures[sex]!;
    for (const entry of entries) {
      let live = await enter(account!, "tcp"); assert.equal(live.id, fixture.characterId);
      if (!entry.itemId) {
        const mails = async () => (await json<{ items: Row[] }>(`/api/admin/player-mail?pageSize=500&q=${live.id}`)).items.filter(m => m.ReceiverID === live.id);
        const before = new Set((await mails()).map(m => m.ID)); await json(`/api/admin/players/${live.id}/give-item`, "POST", { templateId: entry.id, count: 1, validDays: 0 });
        const mail = await poll(async () => (await mails()).find(m => !before.has(m.ID) && Number(m.Annex1) > 0), m => !!m, "targeted mail"); entry.mailId = Number(mail!.ID); entry.itemId = Number(mail!.Annex1); save();
      }
      const pending = await json(`/api/admin/player-items/${entry.itemId}`);
      if (pending.UserID === 0) {
        const mail = await json(`/api/admin/player-mail/${entry.mailId}`); assert.equal(mail.ReceiverID, live.id); assert.equal(Number(mail.Annex1), entry.itemId); assert.equal(pending.TemplateID, entry.id); assert.equal(pending.Place, -1);
        const mark = live.c.mark(); live.c.out(113, p => { p.writeInt(entry.mailId!); p.writeByte(1); }); const reply = await live.c.code(113, undefined, mark); assert.equal(reply.pkt.readInt(), entry.mailId); assert.equal(reply.pkt.readInt(), 1); assert.equal(reply.pkt.readInt(), 1);
      }
      const owned = await json(`/api/admin/player-items/${entry.itemId}`); assert.equal(owned.UserID, live.id); assert.equal(owned.TemplateID, entry.id);
      let equipped = owned.Place === entry.categoryId - 1 ? live.style : await move(live, entry, owned.Place, entry.categoryId - 1, true); assert.ok(equipped.includes(`${entry.id}|${entry.pic}`));
      await quit(live.c, fixture, equipped); assert.equal((await json(`/api/admin/player-items/${entry.itemId}`)).Place, entry.categoryId - 1);
      live = await enter(account!, "ws"); assert.equal(live.id, fixture.characterId); assert.equal(live.style, equipped);
      const offStyle = await move(live, entry, entry.categoryId - 1, -1, false); await quit(live.c, fixture, offStyle); live = await enter(account!, "tcp"); assert.equal(live.style, offStyle);
      const off = await json(`/api/admin/player-items/${entry.itemId}`); assert.ok(off.Place >= 31); equipped = await move(live, entry, off.Place, entry.categoryId - 1, true); await quit(live.c, fixture, equipped);
      entry.protocolAccepted = true; receipt!.snapshots.push({ name: entry.name, templateId: entry.id, itemId: entry.itemId, characterId: fixture.characterId, stage: "TCP equip; WS relogin; unequip; TCP relogin; final equip saved", style: equipped }); save(); console.log(`protocol accepted ${entry.name}: equip, unequip, TCP/WS persistence, currencies unchanged`);
    }
  }
  receipt!.phase = receipt!.templates.every(e => e.installed && e.protocolAccepted) ? "awaiting-visual" : "partially-installed"; delete receipt!.error; save();
}
main().catch(error => { if (receipt) { receipt.error = error.message; save(); } console.error(error.message); process.exitCode = 1; }).finally(async () => { for (const c of clients) if (!c.closed) { c.close(); await c.waitClosed(); } });
