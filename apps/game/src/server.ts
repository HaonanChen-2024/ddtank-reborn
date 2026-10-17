import { actNativeChristmas, readNativeChristmas } from "./game/activity-christmas-native.js";
import { christmasSnowfieldOwner } from "./game/activity-christmas-snowfield.js";
import { labyrinthCombatOwner } from "./game/labyrinth-combat.js";
import { labyrinthCleanOutOwner } from "./game/labyrinth-clean-out.js";
/**
 * GameServer (Game.Server/GameServer.cs Start/Stop + Center.Server's online registry): boots caches, listeners,
 * timers (DB autosave, ping, speed-heartbeat watchdog, server heartbeat) and the admin channel.
 */
import type net from "node:net";
import type http from "node:http";
import type { WebSocketServer } from "ws";
import { createDb, type DbHandle } from "@ddt/db";
import { parseDotNetRsaXml, rsaKeyFromPem, type RsaPrivateKey } from "@ddt/protocol";
import { readRsaKeyText, type Config } from "./config.js";
import { Templates, heartbeat, upsertServer } from "./db/templates.js";
import { resetAllOnline } from "./db/characters.js";
import { createRegistry } from "./handlers/index.js";
import type { HandlerRegistry } from "./handlers/registry.js";
import { checkMissingHeartbeat } from "./handlers/basic.js";
import { GameClient, type Transport } from "./session/client.js";
import { World, type ServerContext, type TicketValidator } from "./session/context.js";
import { dbTicketValidator, quitPlayer } from "./session/login.js";
import { consortiaGameOver } from "./handlers/consortia.js";
import { consortiaMgr } from "./game/consortia-mgr.js";
import { RoomMgr } from "./rooms/room-mgr.js";
import { StubFightEngine } from "./fight/stub.js";
import { DdtFightEngine } from "./fight/ddt.js";
import type { FightEngine } from "./fight/types.js";
import type { BotProvider, VirtualPlayer } from "./bots/bot.js";
import { DbBotProvider } from "./bots/provider.js";
import { ItemInfo } from "./game/item.js";
import { grantRewards } from "./game/events.js";
import { fightLabDrop, setFightLabPermission } from "./game/fightlab.js";
import type { GamePlayer, RoomMember } from "./game/player.js";
import { startPolicy, startTcp, startWs, type ConnectionGate } from "./net/transports.js";
import { startAdmin } from "./admin/http.js";
import { eventsRuntime, pushRecords, worldBossDamage, worldBossFightWindow } from "./handlers/events.js";
import { scanExpiredAuctions } from "./handlers/auction.js";
import * as Out from "./packets/out.js";
import { LanguageMgr } from "./util/lang.js";
import { createLogger, type Logger } from "./util/log.js";
import { actNativeExchange, readNativeExchange } from "./game/activity-exchange-native.js";

export interface GameServerOptions {
  /** Pre-opened DB (tests use PGlite memory). Default: createDb(cfg.DATABASE_URL). */
  db?: DbHandle;
  rsaKey?: RsaPrivateKey;
  tickets?: TicketValidator;
  fight?: FightEngine;
  bots?: BotProvider;
  logger?: Logger;
}

export function parseRsaKey(text: string): RsaPrivateKey {
  if (text.includes("BEGIN")) return rsaKeyFromPem(text);
  const m = /<RSAKeyValue>[\s\S]*?<\/RSAKeyValue>/.exec(text);
  const key = parseDotNetRsaXml(m ? m[0] : text) as RsaPrivateKey;
  if (!("d" in key)) throw new Error("RSA key has no private part");
  return key;
}

/**
 * PVPGame.TakeCard drop: DropInventory.CardDrop(roomType) (eDropType.Cards = 1, Para1 = room type, Para2 = "0").
 * The original adds it to the TempBag and moves it to the bags after the game; here it goes straight to its bag.
 */
export function takeCardDrop(templates: Templates, m: RoomMember, roomType: number): { templateId: number; count: number } {
  const dropId = templates.findDropCondition(1, String(roomType), "0");
  const d = dropId ? templates.dropOne(dropId) : null;
  const t = d ? templates.findItem(d.templateId) : undefined;
  if (!d || !t || m.isBot) return { templateId: 0, count: 0 };
  const p = m as GamePlayer;
  // Battle ShopMgr special ids use -300 for gift tokens; the shared activity helper uses -1100 for them.
  const reward = d.templateId === -300 ? { ...d, templateId: -1100 } : d;
  const { overflow } = grantRewards(p, [reward], id => templates.findItem(id), new Date());
  for (const item of overflow) if (!p.tempBag.addTemplate(item, item.Count)) return { templateId: 0, count: 0 };
  return { templateId: d.templateId, count: d.count };
}

/**
 * PaymentTakeCardCommand.cs (GAME_CMD sub 114): pay Money for an extra card flip (437 VIP / 486 non-VIP). The
 * original's Card_Get buff (BuffType 73) free-use fast path isn't ported — bots never have it and the common case
 * is Money, so this always charges Money (same net cost to a player without that rare buff).
 */
export function payTakeCard(m: RoomMember): boolean {
  if (m.isBot) return false;
  const p = m as GamePlayer;
  const cost = (p.info.typeVIP ?? 0) > 0 ? 437 : 486;
  if (p.info.Money + p.info.MoneyLock < cost) { p.sendMessage?.(1, p.lang("UserBuyItemHandler.NoMoney")); return false; }
  p.removeMoney(cost);
  return true;
}

/** PVEGame.TakeCard / SimpleNpc.GetDropItemInfo: special templates are currencies (ShopMgr.FindSpecialItemInfo), the rest
 *  goes to its bag (temp bag when full). */
function giveDropItems(templates: Templates, m: RoomMember, items: { templateId: number; count: number; isBind?: boolean; validDate?: number }[], goldRate = 1, bag: "temp" | "fight" = "temp"): void {
  if (m.isBot) return;
  const p = m as GamePlayer;
  for (const d of items) {
    if (d.templateId === -100) { p.addGold?.(d.count * goldRate); continue; }
    if (d.templateId === -200) { p.info.Money += d.count; p.updateProperties?.(); continue; }
    if (d.templateId === -300) { p.addGiftToken?.(d.count); continue; }
    const t = templates.findItem(d.templateId);
    if (!t) continue;
    const item = ItemInfo.createFromTemplate(t, d.count, 101);
    item.IsBinds = d.isBind ?? true;
    item.ValidDate = d.validDate ?? 0;
    // Player.OpenBox: fight props (category 10) from a battle box go to the FightBag (usable at once, bag 2)
    if (bag === "fight" && t.CategoryID === 10 && p.fightBag?.addTemplate(item, d.count)) continue;
    const inv = p.getItemInventory?.(t);
    if (!inv?.addTemplate(item, d.count)) p.tempBag?.addTemplate(item, d.count);
  }
}

/** GamePlayer.SetFightLabPermission side effects (GamePlayer.cs:3140-3185): items to bag (mail-less: temp bag), GM notice, 67. */
export function applyFightLabWin(templates: Templates, p: GamePlayer, pveId: number, hardLevel: number, missionId: number, t: (k: string, ...a: unknown[]) => string): void {
  if (!p.info) return;
  const r = setFightLabPermission(p.info.FightLabPermission ?? "", pveId, hardLevel);
  p.info.FightLabPermission = r.perm;
  if (r.reward) {
    const items = fightLabDrop(templates, missionId);
    if (items.length) {
      giveDropItems(templates, p, items);
      const names = items.map((d) => t("Game.Server.Quests.FinishQuest.RewardProp", templates.findItem(d.templateId)?.Name ?? String(d.templateId), d.count)).join(" ");
      p.sendMessage?.(0, `训练场奖励：${names}`);
    }
  }
  p.updateProperties?.();
}

export class GameServer {
  ctx!: ServerContext;
  handlers!: HandlerRegistry;
  readonly clients = new Set<GameClient>();
  private perIp = new Map<string, number>();
  tcp: net.Server | null = null;
  ws: WebSocketServer | null = null;
  policy: net.Server | null = null;
  admin: http.Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private ownsDb = false;
  private startedAt = Date.now();

  constructor(readonly cfg: Config, private readonly opts: GameServerOptions = {}) {}

  async start(): Promise<this> {
    const cfg = this.cfg;
    const log = this.opts.logger ?? createLogger(cfg.LOG_LEVEL);
    const db = this.opts.db ?? (await createDb(cfg.DATABASE_URL));
    this.ownsDb = !this.opts.db;
    let rsaKey = this.opts.rsaKey;
    if (!rsaKey) {
      const text = readRsaKeyText(cfg);
      if (!text) throw new Error("No RSA private key: set RSA_PRIVATE_KEY / RSA_PRIVATE_KEY_FILE (or RSA_USE_VENDOR_KEY=true in dev)");
      rsaKey = parseRsaKey(text);
    }
    const templates = await new Templates().load(db.db, cfg.SERVER_ID, cfg.DEFAULT_LANG);
    log.info(`templates: ${templates.items.size} items, ${templates.shop.size} shop goods, ${templates.maps.size} maps`);
    const lang = LanguageMgr.fromFile(cfg.LANGUAGE_FILE);
    const pickMap = (m: number) => templates.pickMap(m, cfg.SERVER_ID);
    const fight =
      this.opts.fight ??
      (process.env.FIGHT_ENGINE === "stub"
        ? new StubFightEngine(pickMap, (m) => log.debug(m))
        : new DdtFightEngine({
            weaponExtensionPath: cfg.FIGHT_WEAPON_EXTENSION,
            pickMap,
            log: (m) => log.warn(m),
            gradeForGp: (gp) => templates.gradeForGp(gp),
            onWorldBossHurt: (m, hurt, attempt) => { if (this.ctx) worldBossDamage(this.ctx, m as GamePlayer, hurt, attempt); },
            worldBossWindow: (pveId) => this.ctx ? worldBossFightWindow(this.ctx, pveId) : null,
            labyrinth: { admit: (setup, id) => this.ctx ? labyrinthCombatOwner(this.ctx).admit(setup, id) : null },
            expRate: () => (this.ctx ? eventsRuntime(this.ctx).scheduler.rate("double_exp") : 1),
            takeCard: (m, roomType) => takeCardDrop(templates, m, roomType),
            payTakeCard: (m) => payTakeCard(m),
            onPlayerGameOver: (m, g) => {
              (m as GamePlayer).questInv?.onGameOver(g);
              pushRecords(m as GamePlayer); // ChangeWin/ChangeTotal/ChangeGrade achievement records (229)
            },
            onGameOver: (g) => void consortiaGameOver(this.ctx!, g).catch((e) => log.warn(`consortia game over: ${e}`)),
            onMissionOver: (m, g) => {
              (m as GamePlayer).questInv?.onMissionOver(g.missionId, g.isWin, g.turnNum);
              // PVEGame.cs:802: a won fight-lab mission unlocks the next level; first clear pays FightLabUserDrop
              if (g.gameType === 8 && g.isWin && g.pveId !== undefined) applyFightLabWin(templates, m as GamePlayer, g.pveId, g.hardLevel ?? 0, g.missionId, (k, ...a) => lang.t(k, ...a));
              if (this.ctx) void consortiaMgr(this.ctx).then((c) => c.onMission(m as GamePlayer, g.missionId, g.isWin));
            },
            worldBossBlood: () => (this.ctx ? eventsRuntime(this.ctx).boss.blood : 0),
            giveItems: (m, items, bag) => giveDropItems(templates, m, items, this.ctx ? eventsRuntime(this.ctx).scheduler.rate("double_gold") : 1, bag),
            // DropInventory.BoxDrop: eDropType.Box = 2, Para1 = room type
            boxDrop: (roomType) => {
              const id = templates.findDropCondition(2, String(roomType), "0");
              const d = id ? templates.dropOne(id) : null;
              return d ? [d] : null;
            },
            petSkill: (id) => templates.pets.skills.get(id),
            cardSets: templates.cardSets,
            onPlayerFlee: (m, g) => {
              // PVPGame.RemovePlayer (PVPGame.cs:647): −grade×12 GP; Match: −5 offer (−15 guild war)
              const p = m as GamePlayer;
              p.removeGP(p.info.Grade * 12);
              const offer = g.roomType === 0 ? (g.gameType === 1 ? 15 : g.gameType === 0 ? 5 : 0) : 0;
              if (offer) {
                p.info.Offer = Math.max(0, p.info.Offer - offer);
                p.updateProperties();
              }
              const gp = p.info.Grade * 12; // PVPGame re-reads the grade after RemoveGP for its notice.
              p.sendMessage?.(3, offer ? lang.t("AbstractPacketLib.SendGamePlayerLeave.Msg6", gp, offer) : lang.t("AbstractPacketLib.SendGamePlayerLeave.Msg4", gp));
            },
            pve: {
              data: { npc: (id) => templates.npcs.get(id) as never, mission: (id) => templates.missions.get(id) as never },
              pveInfo: (id, roomType, levelLimits) => (id !== 0 && id !== 100000 ? templates.pveInfos.get(id) : templates.pveByType(roomType, levelLimits)) as never,
              drop: (kind, id, user) => templates.pveDrop(kind, id, user),
              translate: (key, args) => lang.t(key, ...args),
            },
            botProfile: (b) => ({ difficulty: (b as VirtualPlayer & { difficulty?: number }).difficulty ?? 50 }),
          }));
    let bots = this.opts.bots;
    if (!bots && cfg.BOT_FALLBACK_SEC > 0) bots = await new DbBotProvider().load(db.db).catch((e) => (log.warn(`bots: ${e}`), new DbBotProvider()));
    const zoneId = templates.server?.ZoneId ?? 1;
    const zoneName = templates.server?.ZoneName ?? cfg.SERVER_NAME ?? "DDTank";
    const rooms = new RoomMgr({ maxRooms: templates.server?.Room ?? cfg.MAX_ROOMS, fight, lang: (k, ...a) => lang.t(k, ...a), bots, botFallbackSec: cfg.BOT_FALLBACK_SEC,
      christmasSnowfield: {
        canCreateRoom: p => !!this.ctx && christmasSnowfieldOwner(this.ctx).canCreateRoom(p),
        roomCreated: (p, r) => christmasSnowfieldOwner(this.ctx).roomCreated(p, r),
        checkRoom: (r, p, s, start) => christmasSnowfieldOwner(this.ctx).checkRoom(r, p, s, start),
        fightAccepted: (l, g) => christmasSnowfieldOwner(this.ctx).fightAccepted(l, g),
        fightFinished: (l, id, won) => christmasSnowfieldOwner(this.ctx).fightFinished(l, id, won),
        fightStopped: (l, id) => christmasSnowfieldOwner(this.ctx).fightStopped(l, id),
        startFailed: (l, why) => christmasSnowfieldOwner(this.ctx).startFailed(l, why),
      },
      worldBossAccess: {
        check: (players, pveId) => this.ctx ? eventsRuntime(this.ctx).bossAccess.check(players, pveId) : { error: "世界 BOSS 当前不可挑战。" },
        started: (key, players, id) => eventsRuntime(this.ctx!).bossAccess.started(key, players, id),
        finished: (key, userId, id) => eventsRuntime(this.ctx!).bossAccess.finished(key, userId, id),
      },
    });
    this.ctx = {
      cfg, db, templates, lang, log, rooms, fight, rsaKey, zoneId, zoneName,
      world: new World(),
      tickets: this.opts.tickets ?? dbTicketValidator(db, cfg.DEV_ALLOW_ANY_TICKET),
      now: () => new Date(),
    };
    this.handlers = createRegistry();
    await resetAllOnline(db.db).catch(() => {});
    rooms.start();
    // events / activities: template caches + EventScheduler (app."ScheduledEvents"; world boss, league, elite, weekly reset, x2 windows)
    const events = eventsRuntime(this.ctx);
    await events.reload().catch((e) => log.warn(`events: ${(e as Error).message.split(String.fromCharCode(10))[0]}`));
    const tick = Number(process.env.EVENT_TICK_SEC ?? 30);
    if (tick > 0) events.scheduler.start(tick * 1000);

    const gate: ConnectionGate = {
      accept: (ip) => {
        if (this.clients.size >= cfg.MAX_CONNECTIONS) return false;
        const n = this.perIp.get(ip) ?? 0;
        if (n >= cfg.MAX_CONNECTIONS_PER_IP) return false;
        this.perIp.set(ip, n + 1);
        return true;
      },
      release: (ip) => {
        const n = (this.perIp.get(ip) ?? 1) - 1;
        if (n <= 0) this.perIp.delete(ip);
        else this.perIp.set(ip, n);
      },
      attach: (t) => this.attach(t),
    };
    this.tcp = await startTcp(cfg.BIND_HOST, cfg.GAME_PORT, gate, log);
    if (cfg.WS_ENABLED) {
      const origins = cfg.WS_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
      this.ws = await startWs({ host: cfg.BIND_HOST, port: cfg.WS_PORT, path: cfg.WS_PATH, allowedOrigins: origins, maxPayload: cfg.WS_MAX_PAYLOAD }, gate, log);
    }
    if (cfg.POLICY_ENABLED) this.policy = await startPolicy(cfg.BIND_HOST, cfg.POLICY_PORT, log);
    if (cfg.ADMIN_ENABLED) this.admin = await startAdmin(cfg.ADMIN_HOST, cfg.ADMIN_PORT, cfg.ADMIN_TOKEN, this.adminApi(), log);

    if (cfg.SERVER_HEARTBEAT) {
      const wsUrl = cfg.WS_ENABLED ? cfg.WS_PUBLIC_URL ?? `ws://${cfg.PUBLIC_HOST}:${this.wsPort}${cfg.WS_PATH}` : null;
      await upsertServer(db.db, { id: cfg.SERVER_ID, name: zoneName, host: cfg.PUBLIC_HOST, port: this.tcpPort, wsUrl }).catch((e) => log.warn(`app."Servers" not available (no migration yet?): ${(e as Error).message.split(String.fromCharCode(10))[0]}`));
      this.every(60_000, () => heartbeat(db.db, cfg.SERVER_ID, this.ctx.world.size));
    }
    // m_saveDbTimer (DBAutosaveInterval) + speed heartbeat watchdog (GamePlayer.SaveIntoDatabase).
    this.every(cfg.SAVE_INTERVAL_MIN * 60_000, () => this.saveAll(true));
    this.every(1000, () => labyrinthCleanOutOwner(this.ctx).tick());
    // SP_Auction_Scan equivalent: settle expired listings (buyer win or unsold return) on a timer.
    const auctionScanSec = Number(process.env.AUCTION_SCAN_SEC ?? 300);
    if (auctionScanSec > 0) this.every(auctionScanSec * 1000, () => scanExpiredAuctions(this.ctx));
    // m_pingCheckTimer: SendPingTime to every player.
    this.every(cfg.PING_INTERVAL_MIN * 60_000, () => {
      for (const p of this.ctx.world.all()) {
        p.pingStart = Date.now();
        p.send(Out.pingTime(p.info.AntiAddiction));
      }
    });
    return this;
  }

  get tcpPort(): number {
    return (this.tcp?.address() as net.AddressInfo | null)?.port ?? this.cfg.GAME_PORT;
  }
  get wsPort(): number {
    return (this.ws?.address() as net.AddressInfo | null)?.port ?? this.cfg.WS_PORT;
  }
  get adminPort(): number {
    return (this.admin?.address() as net.AddressInfo | null)?.port ?? this.cfg.ADMIN_PORT;
  }

  private every(ms: number, fn: () => unknown): void {
    if (!(ms > 0)) return;
    const t = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => this.ctx.log.error("timer failed", e));
    }, ms);
    t.unref();
    this.timers.push(t);
  }

  /** Creates the GameClient for a transport (also used by tests with a fake transport). */
  attach(t: Transport): GameClient {
    const c = new GameClient(t, this.ctx, this.handlers);
    this.clients.add(c);
    c.onClosed = () => {
      this.clients.delete(c);
      const p = c.player;
      if (p) void c.idle().then(() => quitPlayer(this.ctx, p)).catch(error => this.ctx.log.error(`quit failed for ${p.id}`, error));
    };
    return c;
  }

  async saveAll(watchdog = false): Promise<void> {
    for (const p of this.ctx.world.all()) {
      try {
        if (watchdog && (await checkMissingHeartbeat(this.ctx, p))) continue;
        await p.saveIntoDatabase(this.ctx.db.db);
      } catch (err) {
        this.ctx.log.error(`autosave failed for ${p.id}`, err);
      }
    }
  }

  private adminApi() {
    return {
      status: () => ({ online: this.ctx.world.size, players: this.ctx.world.size, rooms: this.ctx.rooms.usingRooms().length, capacity: this.ctx.templates.server?.Total ?? this.cfg.MAX_CONNECTIONS }),
      stats: () => ({
        online: this.ctx.world.size,
        connections: this.clients.size,
        rooms: this.ctx.rooms.usingRooms().length,
        playingRooms: this.ctx.rooms.usingRooms().filter((r) => r.IsPlaying).length,
        lobby: this.ctx.rooms.waiting.size,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        memoryMB: Math.round(process.memoryUsage().rss / 1048576),
        serverId: this.cfg.SERVER_ID,
        zone: this.ctx.zoneName,
        fight: this.ctx.fight.name,
      }),
      broadcast: (msg: string, type: number) => {
        const pkt = Out.message(type, msg);
        const all = this.ctx.world.all();
        for (const p of all) p.send(pkt);
        return all.length;
      },
      kick: async (tgt: { userId?: number; nick?: string }, msg: string) => {
        const p = tgt.userId ? this.ctx.world.get(tgt.userId) : tgt.nick ? this.ctx.world.getByNick(tgt.nick) : undefined;
        if (!p) return false;
        p.send(Out.kitoff(msg));
        p.sink.disconnect("admin kick");
        await quitPlayer(this.ctx, p);
        return true;
      },
      reloadTemplates: async () => {
        await this.ctx.templates.load(this.ctx.db.db, this.cfg.SERVER_ID, this.cfg.DEFAULT_LANG);
        const ev = eventsRuntime(this.ctx);
        await ev.reload();
        return { items: this.ctx.templates.items.size, shop: this.ctx.templates.shop.size, maps: this.ctx.templates.maps.size, scheduledEvents: ev.scheduler.events.length, achievements: ev.data.achievements.size };
      },
      events: () => eventsRuntime(this.ctx).status(),
      eventsForce: async (kind: string, minutes: number) => {
        const ev = eventsRuntime(this.ctx);
        ev.scheduler.force(kind, minutes);
        await ev.scheduler.tick();
        return ev.status();
      },
      eventsStop: async (kind: string) => {
        const ev = eventsRuntime(this.ctx);
        ev.scheduler.stop(kind);
        await ev.scheduler.tick();
        return ev.status();
      },
      mailNotice: (userId: number) => {
        const p = this.ctx.world.get(userId);
        if (p) p.send(Out.mailResponse(p.id, 1));
        return !!p;
      },
      activityChristmasRead: (body: unknown) => readNativeChristmas(this.ctx, body, [...this.clients].find(c =>
        !c.closed && c.player && c.player.id === (body as { characterId?: number })?.characterId && this.ctx.world.get(c.player.id) === c.player)),
      activityChristmasAction: (body: unknown) => actNativeChristmas(this.ctx, body, [...this.clients].find(c =>
        !c.closed && c.player && c.player.id === (body as { characterId?: number })?.characterId && this.ctx.world.get(c.player.id) === c.player)),
      activityChristmasSnowfieldRead: (body: unknown) => christmasSnowfieldOwner(this.ctx).read(body, [...this.clients].find(c =>
        !c.closed && c.player && c.player.id === (body as { characterId?: number })?.characterId && this.ctx.world.get(c.player.id) === c.player)),
      activityChristmasSnowfieldAction: (body: unknown) => christmasSnowfieldOwner(this.ctx).command(body, [...this.clients].find(c =>
        !c.closed && c.player && c.player.id === (body as { characterId?: number })?.characterId && this.ctx.world.get(c.player.id) === c.player)),
      activityExchangeRead: (body: unknown) => readNativeExchange(this.ctx, body, [...this.clients].find(c =>
        !c.closed && c.player && c.player.id === (body as { characterId?: number })?.characterId && this.ctx.world.get(c.player.id) === c.player)),
      activityExchangeAction: (body: unknown) => actNativeExchange(this.ctx, body, [...this.clients].find(c =>
        !c.closed && c.player && c.player.id === (body as { characterId?: number })?.characterId && this.ctx.world.get(c.player.id) === c.player)),
    };
  }

  async stop(): Promise<void> {
    if (this.ctx) {
      labyrinthCleanOutOwner(this.ctx).beginShutdown();
      labyrinthCombatOwner(this.ctx).beginShutdown();
      christmasSnowfieldOwner(this.ctx).beginShutdown();
      await labyrinthCleanOutOwner(this.ctx).drain();
      await labyrinthCombatOwner(this.ctx).drain();
      await christmasSnowfieldOwner(this.ctx).drain();
    }
    for (const t of this.timers) clearInterval(t);
    if (this.ctx) eventsRuntime(this.ctx).scheduler.stopTimer();
    this.ctx?.rooms.stop();
    await this.saveAll().catch(() => {});
    for (const c of [...this.clients]) c.disconnect("server stop");
    for (const p of this.ctx?.world.all() ?? []) await quitPlayer(this.ctx, p);
    await Promise.all([
      new Promise((r) => (this.tcp ? this.tcp.close(r) : r(null))),
      new Promise((r) => (this.ws ? this.ws.close(r) : r(null))),
      new Promise((r) => (this.policy ? this.policy.close(r) : r(null))),
      new Promise((r) => (this.admin ? this.admin.close(r) : r(null))),
    ]);
    if (this.ctx) await christmasSnowfieldOwner(this.ctx).drain();
    if (this.ctx) await labyrinthCombatOwner(this.ctx).drain();
    if (this.ctx) await labyrinthCleanOutOwner(this.ctx).drain();
    if (this.ownsDb) await this.ctx.db.close();
  }
}
