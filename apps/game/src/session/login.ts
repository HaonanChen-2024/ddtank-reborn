/**
 * LOGIN (code 1): UserLoginHandler.cs + center ALLOW_USER_LOGIN round trip + GamePlayer.Login/LoadFromDatabase,
 * and logout (GamePlayer.Quit, GamePlayer.cs:3780).
 */
import { updateAwardApp } from "../handlers/academy.js";
import { hotSpringOnQuit } from "../handlers/hotspring.js";
import { initFightLabPermission } from "../game/fightlab.js";
import { loadPvePermission } from "../game/pve-permissions.js";
import { eventsOnLogin, eventsOnQuit, eventsRuntime, worldBossOpen } from "../handlers/events.js";
import { loadUserCardBag, loadUserPets, loadEatPets } from "../db/pets-cards.js";
import { validateGameLogin } from "@ddt/auth";
import { consortiaOnLogin } from "../handlers/consortia.js";
import { findCharacterByUserName, loadMatchInfo, loadPlayerInfo, setOnlineState } from "../db/characters.js";
import { loadUserItems } from "../db/items.js";
import { loadFriends, loadProgress } from "../db/social.js";
import { GamePlayer } from "../game/player.js";
import { QuestInventory } from "../game/quests.js";
import { BagType } from "../game/item.js";
import { checkVipExpire } from "../game/vip.js";
import * as Out from "../packets/out.js";
import { unixSeconds } from "../util/time.js";
import { withWorldBossAdmission } from "../game/world-boss.js";
import { christmasSnowfieldOwner } from "../game/activity-christmas-snowfield.js";
import { labyrinthCombatOwner } from "../game/labyrinth-combat.js";
import type { GameClient } from "./client.js";
import type { ServerContext, TicketValidator } from "./context.js";
import type { DbHandle } from "@ddt/db";

/** Default validator: packages/auth validateGameLogin (app."LoginSessions", GameKey = Login.ashx tempPwd). */
export function dbTicketValidator(db: DbHandle, allowAny = false): TicketValidator {
  return {
    async validate(user, pass) {
      if (allowAny) return true;
      return (await validateGameLogin(db, user, pass)) != null;
    },
  };
}

function kick(client: GameClient, msg: string): void {
  client.send(Out.kitoff(msg));
  client.disconnect(`kick: ${msg}`);
}

export async function handleLogin(ctx: ServerContext, client: GameClient): Promise<void> {
  const login = client.pendingLogin;
  client.pendingLogin = null;
  const t = (k: string) => ctx.lang.t(k);
  const user = login?.payload?.user;
  const pass = login?.payload?.password;
  if (!user || pass == null) return kick(client, t("UserLoginHandler.LoginError"));
  const key = user.toLowerCase();
  if (ctx.world.loggingIn.has(key)) return kick(client, t("UserLoginHandler.LoginError"));
  ctx.world.loggingIn.add(key);
  try {
    if (!(await ctx.tickets.validate(user, pass))) return kick(client, t("UserLoginHandler.OverTime"));
    const ch = await findCharacterByUserName(ctx.db.db, user);
    // isFirst (no character / nickname chosen yet) -> "Register"; the API creates it in Login.ashx/VisualizeRegister.
    if (!ch || !ch.NickName) return kick(client, t("UserLoginHandler.Register"));
    if (!ch.IsExist || ch.ForbidDate.getTime() > ctx.now().getTime()) return kick(client, t("UserLoginHandler.Forbid"));
    if (client.closed) return;
    // Single session (LoginMgr.Add / center TryLoginPlayer): the older connection is kicked with "LoginNext".
    // The new session only loads after the old one stopped handling packets and saved (no stale-DB item dupe).
    const old = ctx.world.get(ch.UserID);
    if (old) {
      old.sink.send(Out.kitoff(t("Game.Server.LoginNext")));
      old.sink.disconnect("logged in elsewhere");
      await Promise.race([old.sink.idle?.(), new Promise((r) => setTimeout(r, 5000))]);
      await quitPlayer(ctx, old);
    }
    if (client.closed) return;
    const player = await withWorldBossAdmission(ctx.world, ch.UserID, () => loadPlayer(ctx, client, ch.UserID));
    if (!player) return kick(client, t("UserLoginHandler.Forbid"));
    if (client.closed) {
      await quitPlayer(ctx, player);
      return;
    }
    ctx.log.info(`login ${user} (${player.id}) from ${client.remoteAddress} via ${client.transport.kind}`);
    // The final login packet must follow initialization and admission release.
    // A client may immediately reconnect after receiving it.
    ctx.world.loggingIn.delete(key);
    player.send(Out.necklace(player.info));
  } catch (err) {
    ctx.log.error("login failed", err);
    kick(client, t("UserLoginHandler.ServerError"));
  } finally {
    ctx.world.loggingIn.delete(key);
  }
}

/** GamePlayer.LoadFromDatabase (GamePlayer.cs:2937) + Login (GamePlayer.cs:3324): loads and sends the login burst. */
async function loadPlayer(ctx: ServerContext, client: GameClient, userId: number): Promise<GamePlayer | null> {
  const db = ctx.db.db;
  const info = await loadPlayerInfo(db, userId);
  if (!info) return null;
  const [match, items, friends, progress] = await Promise.all([
    loadMatchInfo(db, userId),
    loadUserItems(db, userId, ctx.templates.findItem),
    loadFriends(db, userId),
    loadProgress(db, userId),
  ]);
  const p = new GamePlayer(client, info, match, ctx.zoneId, ctx.zoneName, (g) => ctx.templates.levels.get(g) ?? 0);
  if (!ctx.world.add(p)) return null; // WorldMgr.AddPlayer
  client.player = p; // before the burst: the client may answer while we are still sending
  await setOnlineState(db, userId, 1);
  p.friends = friends;
  p.quests = progress.quests.filter((q) => ctx.templates.quests.has(q.QuestID));
  p.gradeForGp = (gp) => ctx.templates.gradeForGp(gp);
  p.lang = (k, ...a) => ctx.lang.t(k, ...(a as never[]));
  p.questInv = new QuestInventory(p, ctx.templates, info.QuestSite ?? new Uint8Array(0));
  p.questInv.load(progress.quests);
  p.achievements = progress.achievements;
  p.records = progress.records;
  p.buffs = progress.buffs;
  p.extra = progress.extra;
  const now = ctx.now();
  p.timeCheckHack = unixSeconds(now);
  info.State = 1;
  // GamePlayer.LoadFromDatabase: initialize/refresh PVE permissions before the login burst.
  info.PvePermission = loadPvePermission(info.PvePermission, info.Grade, ctx.templates.pveInfos.values());
  // GamePlayer.LoadFromDatabase (GamePlayer.cs:3004): empty fight-lab permission -> "1" + 49 x "0"
  if (!info.FightLabPermission) info.FightLabPermission = initFightLabPermission();
  p.onGradeUp = (old) => { if (p.info.masterID) void updateAwardApp(ctx, p, old).catch((e) => ctx.log.warn(`academy award: ${e}`)); };

  // --- LoadFromDatabase
  p.send(Out.inventorySlots(p.id, p.fightBag, [0, 1, 2])); // GamePlayer.cs:2960
  // UpdateItemForUser (GamePlayer.cs:5310): bags in the original order; empty bags send nothing.
  for (const [bag, type] of [
    [p.equipBag, BagType.EquipBag],
    [p.propBag, BagType.PropBag],
    [p.consortiaBag, BagType.Consortia],
    [p.bankBag, BagType.BankBag],
    [p.storeBag, BagType.Store],
  ] as const) bag.loadItems(items.get(type) ?? []);
  // CardBag (equipped cards) and the equipped pet only feed the stats (no card/pet modules yet); farm/avatar: TODO.
  p.statTables = ctx.templates.stats;
  // CardInventory / PetInventory.LoadFromDatabase (GamePlayer.LoadFromDatabase); their CommitChanges sends 216 / 68 below
  const [cardRows, petRows, eatPets] = await Promise.all([loadUserCardBag(db, userId), loadUserPets(db, userId), loadEatPets(db, userId)]);
  p.cardBag.load(cardRows);
  p.petBag.load(petRows);
  p.petBag.eat = eatPets;
  p.cards = p.cardBag.equipped();
  p.pet = p.petBag.equipped();
  p.recalcStats(); // FightPower/attributes are part of the login packet
  // QuestInventory.LoadFromDatabase -> 178. Sent even when empty: the client's TaskManager only answers with
  // QUEST_ADD (176) for the quests it can accept once its quest data is initialised.
  p.questInv.sendAll();
  // achievement records (228, snapshot types merged in), daily counters, world boss / league / elite state
  await eventsOnLogin(ctx, p).catch((e) => ctx.log.warn(`events login: ${e}`));
  if (p.achievements.length) p.send(Out.achievementData(p.id, p.achievements));

  // --- Login (GamePlayer.cs:3330-3406)
  if (info.BoxGetDate.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)) {
    info.AlreadyGetBox = 0;
    info.BoxProgression = 0;
  }
  p.send(Out.loginSuccess(p.view(), p.extra, now));
  p.send(Out.publicPlayer(info, match));
  p.send(Out.weaklessGuild(info));
  p.send(Out.dateTime(now));
  p.send(Out.dailyAward(info.LastAward, now));
  p.showPP = true; // m_playerProp.ViewCurrent() is a no-op the first time, then m_showPP = true
  p.send(Out.userRanks(p.id));
  checkVipExpire(info, now); // GamePlayer.ChecVipkExpireDay
  p.send(Out.openVip(info));
  // after SendOpenVIP the original refreshes the pet bag (PetBag.UpdateEatPets); card bag 216 from CardInventory.LoadFromDatabase
  p.flushCards(true);
  p.flushPets(true);
  p.updatePlayerProperties();
  p.send(Out.enthrallLight());
  p.send(Out.avatarCollect());
  p.playerState = 1; // ePlayerState.Manual
  await consortiaOnLogin(ctx, p).catch((e) => ctx.log.warn(`consortia login: ${e}`)); // guild buffers + 129/26
  p.send(Out.bufferList(p.id, p.buffs));
  p.send(Out.achievementData(p.id, p.achievements));
  // first-recharge gift is a free claim here (no real payments): FIRST_RECHARGE_FREE=false restores the original check
  p.send(Out.firstRecharge(!!info.IsRecharged || process.env.FIRST_RECHARGE_FREE !== "false", !!info.IsGetAward));
  const ev = eventsRuntime(ctx);
  p.send(ev.boss.window ? worldBossOpen(ev, p) : Out.openWorldBoss());
  if (!ev.leagueOpen) p.send(Out.leagueNotice(p.id, match.restCount, 0, 2));
  p.send(Out.guildMemberWeek(p.id));
  // WorldMgr.OnPlayerOnline: friends see the online state (160/165).
  // ChangePlayerState also notifies the members of the same guild (online list of the guild screen)
  for (const f of ctx.world.all()) if (f !== p && (f.friends.has(p.id) || (info.ConsortiaID !== 0 && f.info.ConsortiaID === info.ConsortiaID))) f.send(Out.friendState(p.id, 1, info.typeVIP, info.VIPLevel));
  return p;
}

/** GamePlayer.Quit: leave room/lobby, State = 0, save, WorldMgr.RemovePlayer. Idempotent: concurrent callers share one quit. */
export function quitPlayer(ctx: ServerContext, p: GamePlayer): Promise<void> {
  if (p.quitting) return p.quitting;
  const work = p.quitting = doQuit(ctx, p);
  // A failed durable settlement must be retryable; keep the player online until
  // it succeeds instead of permanently caching one rejected quit promise.
  void work.catch(() => { if (p.quitting === work) p.quitting = null; });
  return work;
}

async function doQuit(ctx: ServerContext, p: GamePlayer): Promise<void> {
  // Seal actual outcome producers and drain their detached ledger before any old-profile final save.
  await labyrinthCombatOwner(ctx).beforeQuit(p);
  await christmasSnowfieldOwner(ctx).beforeQuit(p);
  p.isActive = false;
  const leavingGame = p.currentRoom?.game;
  try {
    if (p.currentRoom) {
      const r = p.currentRoom;
      r.removePlayer(p);
      if (r.IsEmpty) r.stop();
      ctx.rooms.sendUpdateRoom();
    } else ctx.rooms.waitingRemove(p);
  } catch (err) {
    ctx.log.error("quit: room cleanup failed", err);
  }
  p.info.State = 0;
  eventsOnQuit(ctx, p);
  // A world-boss award may briefly queue remove/automatic card rewards for
  // another member of the same fight. Those writes must precede this final save.
  await leavingGame?.waitWorldBossSettlement?.();
  await hotSpringOnQuit(ctx, p).catch(() => {});
  try {
    await p.saveIntoDatabase(ctx.db.db);
  } catch (err) {
    ctx.log.error(`save on quit failed for ${p.id}`, err);
  } finally {
    ctx.world.remove(p);
  }
  for (const f of ctx.world.all()) if (f.friends.has(p.id) || (p.info.ConsortiaID !== 0 && f.info.ConsortiaID === p.info.ConsortiaID)) f.send(Out.friendState(p.id, 0, p.info.typeVIP, p.info.VIPLevel));
}
