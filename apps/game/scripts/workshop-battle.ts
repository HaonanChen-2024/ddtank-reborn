/** Real local-stack bot battles. Run with Node 24 + --import tsx; --validate never connects or writes. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createDb, findAccount, player, type DbHandle } from "@ddt/db";
import { ActionType, solveAim, vane, type FightAssets, type GameMap } from "@ddt/fight";
import { loadPackedAssets } from "@ddt/fight/node";
import { buildLoginPayload, bytesToBase64, parseDotNetRsaXml, rsaEncryptPkcs1, type PacketOut, type RsaPrivateKey } from "@ddt/protocol";
import { GameLogic } from "@ddt/protocol/codes";
import { and, asc, eq } from "drizzle-orm";
// Only the real encrypted TCP/WS transports are reused. No memory server, fake clock, or sharedDb is instantiated.
import { FakeClient, type Received } from "../test/helpers.js";

const C = GameLogic.eTankCmdType;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtime = resolve(repo, "../../runtime");
const reportFile = resolve(process.env.WORKSHOP_BATTLE_REPORT_FILE ?? resolve(runtime, "runtime-research/workshop-battle.json"));
const credentialFile = resolve(process.env.WORKSHOP_BATTLE_CREDENTIAL_FILE ?? resolve(runtime, "credentials/battle-account.json"));
const base = process.env.WORKSHOP_BATTLE_API_URL ?? "http://127.0.0.1:8080";
const tcpPort = Number(process.env.WORKSHOP_BATTLE_TCP_PORT ?? 9200);
const wsUrl = process.env.WORKSHOP_BATTLE_WS_URL ?? "ws://127.0.0.1:9300/ws";
const origin = process.env.WORKSHOP_BATTLE_ORIGIN ?? "http://127.0.0.1:5173";
const bounds = { x: -15, y: -20, width: 30, height: 30 };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
type Account = { username: string; password: string; nickname: string; sex: boolean };
type Living = { id: number; userId: number; nickname: string; team: number; weapon: number; ball: number; x: number; y: number; blood: number; maxBlood: number; direction: number; isLiving: boolean; energy: number };
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
type Balances = { money: number; medal: number; score: number; gold: number; giftToken: number; honor: number; gp: number };
type Battle = {
  number: number; transport: string; began: string; ended?: string; roomId?: number; mapId?: number;
  participants?: { userId: number; livingId: number; team: number; nickname: string; weapon: number }[];
  loadingAcknowledged: boolean; fallbackWaitMs?: number; turns: number;
  move?: { turn: number; beforeX: number; requestedX: number; beforeY: number; confirmedX?: number; confirmedY?: number };
  shots: { shooter: number; ball: number; x: number; y: number; force?: number; angle?: number; predictedMiss?: number }[];
  damage: { shooter: number; target: number; value: number; blood: number }[];
  result?: { livingId: number; win: boolean; grade: number; gp: number; gpGained: number; hits: number; canTakeOut: number }[];
  card?: { auto: boolean; index: number; template: number; count: number };
  cardBalancesBefore?: Balances; cardBalancesAfter?: Balances;
  persisted?: { before: Snapshot; after: Snapshot };
  returnedToLobby: boolean;
};
const receipt: { started: string; ended?: string; protocolOnly: boolean; ok: boolean; checks: string[]; username?: string; userId?: number; before?: Snapshot; after?: Snapshot; battles: Battle[]; error?: string; cleanup?: string } = {
  started: new Date().toISOString(), protocolOnly: true, ok: false, checks: [], battles: [],
};
function checkpoint() {
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify(receipt, null, 2));
}
function windFromTurn(positive: boolean, one: number, three: number) {
  return ((positive ? 1 : -1) * ((one === 10 ? 0 : one) * 10 + (three === 10 ? 0 : three)) / 10) || 0;
}
function packet(r: Received) { r.pkt.offset = 20; r.pkt.readByte(); return r.pkt; }
function balances(c: FakeClient, userId: number): Balances {
  const r = c.received.findLast(x => x.code === 38 && x.clientId === userId);
  assert.ok(r, "UPDATE_PRIVATE_INFO received"); r.pkt.offset = 20;
  const money = r.pkt.readInt(), medal = r.pkt.readInt(), score = r.pkt.readInt(), gold = r.pkt.readInt(), giftToken = r.pkt.readInt();
  r.pkt.readInt(); r.pkt.readInt(); r.pkt.readInt(); const honor = r.pkt.readInt();
  const publicInfo = c.received.findLast(x => x.code === 67 && x.clientId === userId); assert.ok(publicInfo);
  publicInfo.pkt.offset = 20;
  return { money, medal, score, gold, giftToken, honor, gp: publicInfo.pkt.readInt() };
}
function game(c: FakeClient, sub: number, fill: (p: PacketOut) => void = () => {}) {
  c.out(91, p => { p.writeByte(sub); fill(p); });
}
function room(c: FakeClient, sub: number, fill: (p: PacketOut) => void = () => {}) {
  c.out(94, p => { p.writeInt(sub); fill(p); });
}
async function json(path: string, body?: unknown, expected = 200) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, expected, `${path} status`);
  return response.json();
}
async function legacy(path: string, body: Record<string, string>) {
  const response = await fetch(base + "/request/" + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, path);
  return response.text();
}
async function snapshot(h: DbHandle, id: number) {
  const [user] = await h.db.select({ id: player.Sys_Users_Detail.UserID, grade: player.Sys_Users_Detail.Grade, gp: player.Sys_Users_Detail.GP, total: player.Sys_Users_Detail.Total, win: player.Sys_Users_Detail.Win, gold: player.Sys_Users_Detail.Gold, money: player.Sys_Users_Detail.Money, giftToken: player.Sys_Users_Detail.GiftToken }).from(player.Sys_Users_Detail).where(eq(player.Sys_Users_Detail.UserID, id));
  assert.ok(user, "dedicated character exists");
  const items = await h.db.select({ id: player.Sys_Users_Goods.ItemID, template: player.Sys_Users_Goods.TemplateID, bag: player.Sys_Users_Goods.BagType, place: player.Sys_Users_Goods.Place, count: player.Sys_Users_Goods.Count }).from(player.Sys_Users_Goods).where(and(eq(player.Sys_Users_Goods.UserID, id), eq(player.Sys_Users_Goods.IsExist, true))).orderBy(asc(player.Sys_Users_Goods.ItemID));
  return { user, items };
}
/** The lobby portion is variable length: consume it exactly before team/living id (SendCreateGame). */
function created(r: Received, assets: FightAssets): Living[] {
  const p = packet(r);
  assert.equal(p.readInt(), 0, "Match room"); p.readInt(); p.readInt();
  const result: Living[] = [];
  const count = p.readInt(); assert.equal(count, 2, "solo Match fallback must be 1v1");
  for (let i = 0; i < count; i++) {
    p.readInt(); p.readString(); const userId = p.readInt(); const nickname = p.readString(); p.readBoolean();
    p.readByte(); p.readInt(); p.readBoolean(); p.readInt(); p.readString(); p.readString(); p.readString(); p.readInt(); p.readInt();
    const weapon = p.readInt();
    if (weapon > 0) { p.readInt(); p.readString(); p.readDateTimeParts(); }
    p.readInt(); p.readInt(); p.readBoolean(); p.readInt(); p.readString();
    for (let j = 0; j < 8; j++) p.readInt();
    p.readString(); p.readInt(); p.readString(); p.readInt(); p.readBoolean(); p.readInt();
    if (p.readBoolean()) { p.readInt(); p.readString(); }
    for (let j = 0; j < 6; j++) p.readInt();
    const team = p.readInt(), id = p.readInt(), maxBlood = p.readInt();
    const pets = p.readInt();
    for (let j = 0; j < pets; j++) {
      p.readInt(); p.readInt(); p.readInt(); p.readString(); p.readInt(); p.readInt();
      const skills = p.readInt(); for (let k = 0; k < skills; k++) { p.readInt(); p.readInt(); }
    }
    const ball = assets.ballConfigs.get(weapon)?.common;
    assert.ok(ball !== undefined && assets.ball(ball), `ball config for weapon ${weapon}`);
    result.push({ id, userId, nickname, team, weapon, ball, maxBlood, blood: maxBlood, x: 0, y: 0, direction: 1, isLiving: true, energy: 0 });
  }
  assert.equal(p.offset, p.length, "GAME_CREATE layout fully consumed");
  return result;
}
function started(r: Received, livings: Living[]) {
  const p = packet(r), count = p.readInt();
  assert.equal(count, livings.length);
  for (let i = 0; i < count; i++) {
    const id = p.readInt(), l = livings.find(x => x.id === id); assert.ok(l);
    l.x = p.readInt(); l.y = p.readInt(); l.direction = p.readInt(); l.blood = p.readInt(); l.maxBlood = p.readInt();
    assert.equal(p.readInt(), l.team); p.readInt(); p.readInt(); p.readInt();
    const buffs = p.readInt(); for (let j = 0; j < buffs; j++) { p.readInt(); p.readInt(); }
    p.readInt(); p.readBoolean(); p.readBoolean(); p.readBoolean(); p.readBoolean(); p.readInt();
  }
  p.readDateTimeParts(); assert.equal(p.offset, p.length, "START_GAME layout");
}
function turn(r: Received, livings: Living[], map: GameMap) {
  const p = packet(r), positive = p.readBoolean(), one = p.readByte(); p.readByte(); const three = p.readByte();
  map.wind = windFromTurn(positive, one, three); p.readBoolean(); p.readInt();
  const boxes = p.readInt(); for (let i = 0; i < boxes; i++) for (let j = 0; j < 4; j++) p.readInt();
  const count = p.readInt();
  for (let i = 0; i < count; i++) {
    const id = p.readInt(), l = livings.find(x => x.id === id); assert.ok(l);
    l.isLiving = p.readBoolean(); l.x = p.readInt(); l.y = p.readInt(); l.blood = p.readInt(); p.readBoolean(); l.energy = p.readInt();
    for (let j = 0; j < 6; j++) p.readInt();
  }
  const index = p.readInt(); assert.equal(p.offset, p.length, "TURN layout"); return index;
}
function fired(r: Received, livings: Living[], map: GameMap, assets: FightAssets, b: Battle) {
  const p = packet(r); map.wind = p.readInt() / 10; p.readBoolean(); p.readByte(); p.readByte(); p.readByte();
  const bombs = p.readInt();
  for (let i = 0; i < bombs; i++) {
    p.readInt(); p.readInt(); const dig = p.readBoolean(); p.readInt(); const x = p.readInt(), y = p.readInt(); p.readInt(); p.readInt();
    const ball = p.readInt(); p.readString(); p.readInt(); p.readInt();
    b.shots.push({ shooter: r.p1, ball, x, y });
    const count = p.readInt();
    for (let j = 0; j < count; j++) {
      p.readInt(); const type = p.readInt(), a = p.readInt(), z = p.readInt(), c = p.readInt(), d = p.readInt();
      if (type === ActionType.BOMB && dig && c === 1) map.dig(a, z, assets.shape(ball));
      const l = livings.find(v => v.id === a);
      if (l && type === ActionType.START_MOVE) { l.x = z; l.y = c; l.isLiving = d === 1; }
      if (l && type === ActionType.KILL_PLAYER) {
        l.blood = d; l.isLiving = d > 0; b.damage.push({ shooter: r.p1, target: a, value: z, blood: d });
      }
      if (l && type === ActionType.CURE) l.blood = d;
    }
  }
  const pet = p.readInt(); for (let i = 0; i < pet; i++) for (let j = 0; j < 4; j++) p.readInt();
  p.readInt(); assert.equal(p.offset, p.length, "FIRE layout");
}
async function login(account: Account, rsa: RsaPrivateKey, transport: "tcp" | "ws", register = false) {
  if (register) await json("/api/auth/register", { username: account.username, password: account.password }, 201);
  const auth = await json("/api/auth/login", { username: account.username, password: account.password });
  const temp = randomBytes(12).toString("hex");
  const date = buildLoginPayload(`${account.username},${auth.play.flashvars.key},${temp}`, account.nickname, new Array(8).fill(0)).subarray(0, 7);
  const blob = bytesToBase64(rsaEncryptPkcs1(rsa, Buffer.concat([date, Buffer.from(`${account.username},${auth.play.flashvars.key},${temp},${account.nickname}`)])));
  const xml = await legacy("Login.ashx", { p: blob, site: "" }); assert.match(xml, /<Result value="true"/);
  const id = Number(/<Item ID="(\d+)"/.exec(xml)?.[1]); assert.ok(id > 0);
  if (/NickName=""/.test(xml)) {
    assert.match(await legacy("VisualizeRegister.ashx", { Name: account.username, Pass: temp, NickName: account.nickname, Sex: String(account.sex) }), /<Result value="true"/);
  }
  const c = transport === "tcp" ? await FakeClient.tcp(tcpPort) : await FakeClient.ws(wsUrl, origin);
  try { c.login(account.username, temp, rsa); await c.code(95); c.out(16, p => p.writeInt(1)); await c.code(94, 9); }
  catch (e) { c.close(); throw e; }
  return { c, id };
}
async function battle(c: FakeClient, id: number, assets: FightAssets, n: number, transport: string, deadline: number) {
  const b: Battle = { number: n, transport, began: new Date().toISOString(), loadingAcknowledged: false, turns: 0, shots: [], damage: [], returnedToLobby: false };
  receipt.battles.push(b); checkpoint();
  let mark = c.mark(); room(c, 0, p => { p.writeByte(0); p.writeByte(2); p.writeUTF(`WorkshopBattle${n}`); p.writeUTF(""); });
  const cr = await c.code(94, 0, mark); b.roomId = packet(cr).readInt();
  mark = c.mark(); const queueStarted = Date.now(); room(c, 7);
  let cursor = mark, livings: Living[] = [], map: GameMap | undefined, me: Living | undefined;
  const seen = new Set<number>(), expires = Math.min(Date.now() + 8 * 60_000, deadline);
  while (!b.result) {
    assert.ok(Date.now() < expires, `battle ${n}: real-clock battle or overall time limit reached`);
    assert.ok(!c.closed, `battle ${n}: transport closed`);
    while (cursor < c.received.length && !b.result) {
      const r = c.received[cursor++]; if (r.code !== 91) continue;
      if (r.sub === C.GAME_CREATE) {
        livings = created(r, assets); me = livings.find(x => x.userId === id); assert.ok(me);
        assert.ok(livings.some(x => x.userId < 0), "actual fallback bot, never another human");
        b.fallbackWaitMs = Date.now() - queueStarted;
        b.participants = livings.map(x => ({ userId: x.userId, livingId: x.id, team: x.team, nickname: x.nickname, weapon: x.weapon }));
      } else if (r.sub === C.GAME_LOAD) {
        const p = packet(r); p.readInt(); b.mapId = p.readInt(); map = assets.createMap(b.mapId);
        if (process.env.WORKSHOP_BATTLE_EXPECT_MAP) assert.equal(b.mapId, Number(process.env.WORKSHOP_BATTLE_EXPECT_MAP), "isolated fixture map received from actual server");
        game(c, C.LOAD, p => p.writeInt(100)); b.loadingAcknowledged = true;
      } else if (r.sub === C.START_GAME) started(r, livings);
      else if (r.sub === C.TURN) {
        assert.ok(map && me); const index = turn(r, livings, map); b.turns++;
        if (b.move && !b.move.confirmedX && index > b.move.turn && me.x === b.move.requestedX) {
          b.move.confirmedX = me.x; b.move.confirmedY = me.y;
        }
        if (r.p1 !== me.id || !me.isLiving || seen.has(index)) continue;
        seen.add(index);
        if (!b.move) {
          const dx = Math.min(5, me.energy), x = me.x + (me.x < map.bound.width / 2 ? dx : -dx);
          assert.ok(dx > 0); b.move = { turn: index, beforeX: me.x, requestedX: x, beforeY: me.y };
          game(c, C.MOVESTART, p => { p.writeBoolean(false); p.writeByte(0); p.writeInt(x); p.writeInt(me!.y); p.writeByte(x > me!.x ? 1 : 0); p.writeBoolean(true); p.writeShort(index); });
          // Normal MOVESTART excludes its sender. SKIP and the next TURN give authoritative confirmation.
          await sleep(250); game(c, C.SKIPNEXT, p => p.writeByte(1)); checkpoint(); continue;
        }
        const foe = livings.find(x => x.team !== me!.team && x.isLiving); assert.ok(foe);
        const ball = assets.ball(me.ball); assert.ok(ball);
        const sol = solveAim({ map, ball, from: { ...me, bound: bounds }, target: { x: foe.x, y: foe.y - 10 }, bodies: livings.filter(x => x.id !== me!.id && x.isLiving).map(x => ({ ...x, bound: bounds })) });
        if (!sol) { game(c, C.SKIPNEXT, p => p.writeByte(1)); continue; }
        game(c, C.DIRECTION, p => p.writeInt(sol.direction));
        game(c, C.FIRE_TAG, p => { p.writeBoolean(true); p.writeByte(2); });
        game(c, C.FIRE, p => { p.writeInt(sol.muzzle.x); p.writeInt(sol.muzzle.y); p.writeInt(sol.force); p.writeInt(sol.angle); });
        b.shots.push({ shooter: me.id, ball: me.ball, x: sol.muzzle.x, y: sol.muzzle.y, force: sol.force, angle: sol.angle, predictedMiss: sol.miss });
      } else if (r.sub === C.FIRE) { assert.ok(map); fired(r, livings, map, assets, b); checkpoint(); }
      else if (r.sub === C.HEALTH) {
        const p = packet(r); p.readByte(); const l = livings.find(x => x.id === r.p1); if (l) { l.blood = p.readInt(); l.isLiving = l.blood > 0; }
      } else if (r.sub === C.CHANGE_BALL) {
        const p = packet(r); p.readBoolean(); const ball = p.readInt(); const l = livings.find(x => x.id === r.p1); if (l) l.ball = ball;
      } else if (r.sub === C.GAME_OVER) {
        const p = packet(r), count = p.readInt(); b.result = [];
        for (let i = 0; i < count; i++) {
          const livingId = p.readInt(), win = p.readBoolean(), fields = Array.from({ length: 26 }, () => p.readInt());
          b.result.push({ livingId, win, grade: fields[0], gp: fields[1], gpGained: fields[3], hits: fields[4], canTakeOut: fields[25] });
        }
        p.readInt(); assert.equal(p.offset, p.length, "GAME_OVER layout");
      }
    }
    if (!b.result) await sleep(75);
  }
  assert.ok(me && b.loadingAcknowledged);
  assert.ok(b.move?.confirmedX !== undefined, "movement confirmed by subsequent server TURN");
  assert.ok(b.shots.some(x => x.shooter === me!.id && x.force === undefined), "human FIRE received from server");
  assert.ok(b.shots.some(x => x.shooter !== me!.id && x.force === undefined), "bot FIRE received from server");
  assert.ok(b.damage.some(x => x.shooter === me!.id && x.target !== me!.id && x.value > 0), "human dealt real damage");
  const result = b.result.find(x => x.livingId === me!.id); assert.ok(result && result.gpGained > 0 && result.canTakeOut > 0);
  b.cardBalancesBefore = balances(c, id);
  mark = c.mark(); game(c, C.BOSS_TAKE_CARD, p => p.writeByte(100));
  const card = packet(await c.code(91, C.TAKE_CARD, mark));
  b.card = { auto: card.readBoolean(), index: card.readByte(), template: card.readInt(), count: card.readInt() }; card.readBoolean();
  b.cardBalancesAfter = balances(c, id); checkpoint();
  if (process.env.WORKSHOP_BATTLE_EXPECT_CARD) assert.equal(b.card.template, Number(process.env.WORKSHOP_BATTLE_EXPECT_CARD), "isolated fixture card received from actual server");
  assert.ok(b.card.auto && b.card.index >= 0 && b.card.index < 9);
  assert.ok(b.card.count > 0, "nonempty free card reward");
  const currency: Partial<Record<number, keyof Balances>> = { [-100]: "gold", [-200]: "money", [-300]: "giftToken", [-1100]: "giftToken", [-800]: "honor", 11107: "gp" };
  const key = currency[b.card.template];
  if (key) assert.equal(b.cardBalancesAfter[key] - b.cardBalancesBefore[key], b.card.count, `card ${b.card.template} must credit ${key}, not merely display a card face`);
  else assert.ok(b.card.template > 0, `unknown special card currency ${b.card.template}`);
  // Real 20 second card window; never tick the server clock or stop its processes.
  await sleep(21_000); mark = c.mark(); room(c, 5); await c.code(94, 5, mark);
  mark = c.mark(); c.out(16, p => p.writeInt(1)); await c.code(94, 9, mark);
  b.returnedToLobby = true; b.ended = new Date().toISOString(); checkpoint();
  console.log(JSON.stringify({ battle: n, transport, map: b.mapId, fallbackWaitMs: b.fallbackWaitMs, turns: b.turns, gpGained: result.gpGained, win: result.win, damageEvents: b.damage.length, card: b.card, returnedToLobby: true }));
}
async function main() {
  process.env.TZ = "UTC";
  const assets = loadPackedAssets();
  // A narrow self-check protects the unusual Flash wind digit representation (10 means zero).
  for (let wind = -40; wind <= 40; wind++) assert.equal(windFromTurn(wind > 0, vane(wind, 1), vane(wind, 3)), wind / 10);
  assert.ok(assets.ball(assets.ballConfigs.get(7008)!.common));
  if (process.argv.includes("--validate")) { console.log("battle script: packed assets + Flash wind codec self-check passed; no connection or writes"); return; }
  const env = parseEnv(readFileSync(resolve(repo, ".env.workshop"), "utf8"));
  assert.notEqual(env.DEV_ALLOW_ANY_TICKET, "true");
  const rsa = parseDotNetRsaXml(readFileSync(env.RSA_PRIVATE_KEY_FILE!, "utf8")) as RsaPrivateKey;
  mkdirSync(dirname(credentialFile), { recursive: true });
  const already = existsSync(credentialFile);
  const suffix = randomBytes(4).toString("hex");
  const account: Account = already ? JSON.parse(readFileSync(credentialFile, "utf8")) : { username: `battle_${suffix}`, password: randomBytes(16).toString("hex"), nickname: `B${suffix}`, sex: true };
  if (!already) writeFileSync(credentialFile, JSON.stringify(account, null, 2));
  receipt.username = account.username;
  const h = await createDb(process.env.WORKSHOP_BATTLE_DATABASE_URL ?? `postgres://postgres:${encodeURIComponent(env.PG_PASSWORD!)}@127.0.0.1:55432/ddtank`, { max: 1 });
  let c: FakeClient | undefined;
  const deadline = Date.now() + 20 * 60_000;
  const watchdog = setTimeout(() => { receipt.error = "overall 21 minute timeout"; receipt.cleanup = "watchdog closed only this script's client; server processes untouched"; c?.close(); checkpoint(); process.exit(1); }, 21 * 60_000);
  try {
    assert.deepEqual(await json("/healthz"), { ok: true });
    let entered = await login(account, rsa, "tcp", !await findAccount(h, account.username)); c = entered.c; receipt.userId = entered.id;
    receipt.before = await snapshot(h, entered.id);
    assert.ok(receipt.before.items.some(x => x.bag === 0 && x.place === 6), "registration provided main weapon");
    receipt.checks.push("REST → RSA Flash ticket → real encrypted TCP → lobby; fresh dedicated character equipped by VisualizeRegister"); checkpoint();
    const requireCurrency = process.argv.includes("--require-currency");
    for (let n = 1; n <= (requireCurrency ? 30 : 2); n++) {
      // Do not open a fresh room when fewer than 90 seconds remain in this bounded live run.
      if (n > 1 && Date.now() + 90_000 > deadline) break;
      const before = receipt.after ?? receipt.before;
      await battle(c, entered.id, assets, n, n === 1 ? "tcp" : "ws", deadline);
      c.close(); await c.waitClosed(); c = undefined; await sleep(1500);
      receipt.after = await snapshot(h, entered.id);
      receipt.battles.at(-1)!.persisted = { before, after: receipt.after }; checkpoint();
      assert.equal(receipt.after.user.total, receipt.before.user.total + n, "completed Match Total persisted");
      assert.ok(receipt.after.user.gp > receipt.before.user.gp, "earned GP persisted");
      for (const b of receipt.battles) {
        const card = b.card!; if (card.template > 0 && card.template !== 11107 && card.count > 0) {
          const before: number = receipt.before.items.filter(x => x.template === card.template).reduce((s, x) => s + x.count, 0);
          const expected = receipt.battles.filter(x => x.card?.template === card.template).reduce((s, x) => s + x.card!.count, 0);
          const after: number = receipt.after.items.filter(x => x.template === card.template).reduce((s, x) => s + x.count, 0);
          assert.ok(after >= before + expected, `free card ${card.template} persisted in bag`);
        }
      }
      const last = receipt.battles.at(-1)!;
      if (last.card!.template === -100) assert.equal(receipt.after.user.gold, last.cardBalancesAfter!.gold, "gold reward persisted");
      if (last.card!.template === -200) assert.equal(receipt.after.user.money, last.cardBalancesAfter!.money, "money reward persisted");
      if (last.card!.template === -300 || last.card!.template === -1100) assert.equal(receipt.after.user.giftToken, last.cardBalancesAfter!.giftToken, "gift token reward persisted");
      entered = await login(account, rsa, "ws"); c = entered.c;
      assert.equal(entered.id, receipt.userId, "identity survived disconnect and fresh WS ticket");
      assert.deepEqual(await snapshot(h, entered.id), receipt.after, "database state remains stable after reconnect"); checkpoint();
      if (n >= 2 && receipt.battles.some(x => x.card && [-100, -200, -300, -1100].includes(x.card.template))) break;
    }
    if (requireCurrency) assert.ok(receipt.battles.some(x => x.card && [-100, -200, -300, -1100].includes(x.card.template)), "no currency card within 30 actual battles / 20 minutes; currency delivery is not accepted");
    receipt.checks.push(`${receipt.battles.length} real-clock bot battles, movement, human/bot FIRE, human damage, GAME_OVER, free card, return to lobby`);
    receipt.checks.push("GP / Match Total / card inventory persisted after disconnect and real WS reconnect");
    receipt.ok = true;
  } catch (error) { receipt.error = (error as Error).message; process.exitCode = 1; }
  finally {
    clearTimeout(watchdog); c?.close(); await h.close(); receipt.ended = new Date().toISOString();
    receipt.cleanup = "all script-owned TCP/WS clients closed; no server process stopped; disconnect releases the dedicated character's room";
    checkpoint(); console.log(JSON.stringify({ ok: receipt.ok, userId: receipt.userId, battles: receipt.battles.length, error: receipt.error, report: reportFile }));
  }
}
await main();
