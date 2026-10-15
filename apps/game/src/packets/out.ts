/**
 * Server -> client packet builders: port of Game.Server/Packets/Packets/AbstractPacketLib.cs (line refs per builder)
 * and Game.Logic BaseGame.SendCreateGame / SendStartLoading. Builders only BUILD; callers send.
 */
import { PacketOut, compressPacket } from "@ddt/protocol";
import type { ItemInfo } from "../game/item.js";
import type { PlayerInventory } from "../game/inventory.js";
import type { PlayerInfo, MatchRow } from "../game/player-info.js";
import type { AchievementDataRow, BuffRow, ExtraRow, QuestDataRow, RecordRow } from "../db/social.js";
import { MIN_DATE, wireDate, addDays } from "../util/time.js";

export function wd(p: PacketOut, d: Date | null | undefined): void {
  p.writeDateTime(wireDate(d), true);
}

/** What the builders need to know about a player (GamePlayer or a bot). */
export interface PlayerView {
  id: number;
  info: PlayerInfo;
  match: MatchRow;
  zoneId: number;
  zoneName: string;
  roomIndex: number;
  roomTeam: number;
  inRoom: boolean;
  pingTime: number;
  weaponTemplateId: number;
  secondWeaponTemplateId: number;
  medal: number;
}

/** 2 KIT_USER (SendKitoff, :896). */
export function kitoff(msg: string): PacketOut {
  const p = new PacketOut(2);
  p.writeString(msg);
  return p;
}

/** 3 SYS_MESSAGE (SendMessage, :925). */
export function message(type: number, msg: string): PacketOut {
  const p = new PacketOut(3);
  p.writeInt(type);
  p.writeString(msg);
  return p;
}

/** 1 LOGIN success (SendLoginSuccess, :763). */
export function loginSuccess(v: PlayerView, extra: ExtraRow | null, now = new Date()): PacketOut {
  const c = v.info;
  const p = new PacketOut(1, c.ID);
  p.writeByte(0);
  p.writeInt(v.zoneId);
  p.writeInt(c.Attack); p.writeInt(c.Defence); p.writeInt(c.Agility); p.writeInt(c.Luck);
  p.writeInt(c.GP); p.writeInt(c.Repute); p.writeInt(c.Gold); p.writeInt(c.Money + c.MoneyLock);
  p.writeInt(v.medal); p.writeInt(0); p.writeInt(c.Hide); p.writeInt(c.FightPower);
  p.writeInt(c.apprenticeshipState); p.writeInt(c.masterID); p.writeString(c.masterOrApprentices ?? "");
  p.writeInt(c.graduatesCount); p.writeString(c.honourOfMaster ?? ""); wd(p, c.freezesDate);
  p.writeByte(c.typeVIP); p.writeInt(c.VIPLevel); p.writeInt(c.VIPExp); wd(p, c.VIPExpireDay); wd(p, c.LastDate);
  p.writeInt(c.VIPNextLevelDaysNeeded); wd(p, now); p.writeBoolean(c.CanTakeVipReward); p.writeInt(c.OptionOnOff);
  p.writeInt(c.AchievementPoint); p.writeString(c.Honor); p.writeInt(c.honorId); p.writeInt(c.OnlineTime);
  p.writeBoolean(c.Sex); p.writeString(`${c.Style}&${c.Colors}`); p.writeString(c.Skin);
  p.writeInt(c.ConsortiaID); p.writeString(c.ConsortiaName); p.writeInt(c.badgeID); p.writeInt(c.DutyLevel);
  p.writeString(c.DutyName); p.writeInt(c.Right); p.writeString(c.ChairmanName); p.writeInt(c.ConsortiaHonor);
  p.writeInt(c.ConsortiaRiches); p.writeBoolean(c.HasBagPassword); p.writeString(c.PasswordQuest1);
  p.writeString(c.PasswordQuest2); p.writeInt(c.FailedPasswordAttemptCount); p.writeString(c.UserName ?? "");
  p.writeInt(c.Nimbus); p.writeString(c.PvePermission ?? ""); p.writeString(c.FightLabPermission ?? "");
  p.writeInt(99999); p.writeInt(c.BoxProgression); p.writeInt(c.GetBoxLevel); p.writeInt(c.AlreadyGetBox);
  wd(p, extra?.LastTimeHotSpring ?? now); wd(p, c.ShopFinallyGottenTime); p.writeInt(c.RichesRob + c.RichesOffer);
  const m = v.match;
  p.writeInt(m.dailyScore); p.writeInt(m.dailyWinCount); p.writeInt(m.dailyGameCount); p.writeBoolean(m.DailyLeagueFirst);
  p.writeInt(m.DailyLeagueLastScore); p.writeInt(m.weeklyScore); p.writeInt(m.weeklyGameCount); p.writeInt(m.weeklyRanking);
  const t = c.Texp;
  p.writeInt(t.spdTexpExp); p.writeInt(t.attTexpExp); p.writeInt(t.defTexpExp); p.writeInt(t.hpTexpExp); p.writeInt(t.lukTexpExp);
  p.writeInt(t.texpTaskCount); p.writeInt(t.texpCount); wd(p, t.texpTaskDate);
  p.writeBoolean(false); p.writeInt(c.badLuckNumber); p.writeInt(0); wd(p, now); p.writeInt(0);
  p.writeInt(c.accumulativeLoginDays); p.writeInt(c.accumulativeAwardDays); p.writeInt(c.totemId); p.writeInt(c.necklaceExp);
  p.writeInt(0);
  return p;
}

/** 38 UPDATE_PRIVATE_INFO (SendUpdatePrivateInfo, :939; IsOpenPetScore=false). */
export function privateInfo(c: PlayerInfo, medal: number): PacketOut {
  const p = new PacketOut(38, c.ID);
  p.writeInt(c.Money + c.MoneyLock); p.writeInt(medal); p.writeInt(c.Score); p.writeInt(c.Gold); p.writeInt(c.GiftToken);
  p.writeInt(c.damageScores); p.writeInt(c.petScore); p.writeInt(c.hardCurrency); p.writeInt(c.myHonor); // AbstractPacketLib.SendUpdatePrivateInfo order
  return p;
}

/** 67 UPDATE_PLAYER_INFO (SendUpdatePublicPlayer, :958). */
export function publicPlayer(c: PlayerInfo, m: MatchRow): PacketOut {
  const p = new PacketOut(67, c.ID);
  for (const x of [c.GP, c.Offer, c.RichesOffer, c.RichesRob, c.Win, c.Total, c.Escape, c.Attack, c.Defence, c.Agility, c.Luck, c.hp, c.Hide]) p.writeInt(x);
  p.writeString(c.Style); p.writeString(c.Colors); p.writeString(c.Skin); p.writeBoolean(c.IsShowConsortia);
  p.writeInt(c.ConsortiaID); p.writeString(c.ConsortiaName); p.writeInt(c.badgeID); p.writeInt(0); p.writeInt(0);
  p.writeInt(c.Nimbus); p.writeString(c.PvePermission ?? ""); p.writeString(c.FightLabPermission ?? ""); p.writeInt(c.FightPower);
  p.writeInt(c.apprenticeshipState); p.writeInt(c.masterID); p.writeString(c.masterOrApprentices ?? ""); p.writeInt(c.graduatesCount);
  p.writeString(c.honourOfMaster ?? ""); p.writeInt(c.AchievementPoint); p.writeString(c.Honor); wd(p, c.LastSpaDate);
  p.writeInt(c.charmGP); p.writeInt(0); wd(p, c.ShopFinallyGottenTime); p.writeInt(c.RichesRob + c.RichesOffer);
  p.writeInt(m.addDayPrestge); p.writeInt(m.dailyWinCount); p.writeInt(m.dailyGameCount); p.writeInt(m.totalPrestige); p.writeInt(m.weeklyGameCount);
  const t = c.Texp;
  p.writeInt(t.spdTexpExp); p.writeInt(t.attTexpExp); p.writeInt(t.defTexpExp); p.writeInt(t.hpTexpExp); p.writeInt(t.lukTexpExp);
  p.writeInt(t.texpTaskCount); p.writeInt(t.texpCount); wd(p, t.texpTaskDate);
  p.writeInt(0); p.writeInt(c.evolutionGrade); p.writeInt(c.evolutionExp);
  return p;
}

/** 4 PING (SendPingTime, :1019). */
export function pingTime(antiAddiction: number): PacketOut {
  const p = new PacketOut(4);
  p.writeInt(antiAddiction);
  return p;
}

/** 5 SYS_DATE (SendDateTime, :1143). */
export function dateTime(now = new Date()): PacketOut {
  const p = new PacketOut(5);
  wd(p, now);
  return p;
}

/** 13 DAILY_AWARD (SendDailyAward, :1150). */
export function dailyAward(lastAward: Date, now = new Date()): PacketOut {
  const p = new PacketOut(13);
  p.writeBoolean(lastAward.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10));
  p.writeInt(0);
  return p;
}

/** 15 weakless guild progress (SendWeaklessGuildProgress, :2069). */
export function weaklessGuild(c: PlayerInfo): PacketOut {
  const p = new PacketOut(15, c.ID);
  p.writeInt(c.weaklessGuildProgress.length);
  for (const b of c.weaklessGuildProgress) p.writeByte(b);
  return p;
}

/** 34 USER_RANK list (AbstractPacketLib.SendUserRanks :2088): int count, each {int NewTitleID, str Name, date
 *  BeginDate, date EndDate (Validate 0 -> BeginDate+1y, else BeginDate+Validate days)}. */
export function userRanks(id: number, ranks: { NewTitleID: number; Name: string | null; BeginDate: Date; Validate: number }[] = []): PacketOut {
  const p = new PacketOut(34, id);
  p.writeInt(ranks.length);
  for (const r of ranks) {
    p.writeInt(r.NewTitleID); p.writeString(r.Name ?? "");
    wd(p, r.BeginDate);
    wd(p, r.Validate > 0 ? new Date(r.BeginDate.getTime() + r.Validate * 86_400_000) : new Date(r.BeginDate.getTime() + 365 * 86_400_000));
  }
  return p;
}

/** 92 VIP (SendOpenVIP, :2140). */
export function openVip(c: PlayerInfo): PacketOut {
  const p = new PacketOut(92, c.ID);
  p.writeByte(c.typeVIP); p.writeInt(c.VIPLevel); p.writeInt(c.VIPExp); wd(p, c.VIPExpireDay); wd(p, c.LastDate);
  p.writeInt(c.VIPNextLevelDaysNeeded); p.writeBoolean(c.CanTakeVipReward);
  return p;
}

/** 167 player property breakdown (SendUpdatePlayerProperty, :2110) — texp/card/suit/bead sources all 0 for now. */
export function playerProperty(id: number): PacketOut {
  const p = new PacketOut(167, id);
  p.writeInt(id);
  for (let i = 0; i < 4 * 4; i++) p.writeInt(0);
  for (let i = 0; i < 6; i++) p.writeInt(0);
  return p;
}

/** 64 GRID_GOODS (SendUpdateInventorySlot, :1538). */
export function inventorySlots(ownerId: number, bag: PlayerInventory, slots: number[], now = new Date()): PacketOut {
  const p = new PacketOut(64, ownerId);
  p.writeInt(bag.bagType);
  p.writeInt(slots.length);
  for (const s of slots) {
    p.writeInt(s);
    const it = bag.getItemAt(s);
    if (!it) {
      p.writeBoolean(false);
      continue;
    }
    p.writeBoolean(true);
    p.writeInt(it.UserID); p.writeInt(it.ItemID); p.writeInt(it.Count); p.writeInt(it.Place); p.writeInt(it.displayTemplateId(now));
    p.writeInt(it.AttackCompose); p.writeInt(it.DefendCompose); p.writeInt(it.AgilityCompose); p.writeInt(it.LuckCompose);
    p.writeInt(it.StrengthenLevel); p.writeInt(it.StrengthenExp); p.writeBoolean(it.IsBinds); p.writeBoolean(it.IsJudge);
    wd(p, it.BeginDate); p.writeInt(it.ValidDate); p.writeString(it.Color ?? ""); p.writeString(it.Skin ?? ""); p.writeBoolean(it.IsUsed);
    for (const h of [it.Hole1, it.Hole2, it.Hole3, it.Hole4, it.Hole5, it.Hole6]) p.writeInt(h);
    const display = it.effectiveTemplate(now);
    p.writeString(display.Pic ?? ""); p.writeInt(display.RefineryLevel); wd(p, addDays(now, 5)); p.writeInt(it.StrengthenTimes);
    p.writeByte(it.Hole5Level); p.writeInt(it.Hole5Exp); p.writeByte(it.Hole6Level); p.writeInt(it.Hole6Exp);
    const gold = it.isValidGoldItem(now);
    p.writeBoolean(gold);
    if (gold) {
      p.writeInt(it.goldValidDate);
      wd(p, it.goldBeginTime);
    }
    // C# writes latentEnergyCurStr twice (sic).
    p.writeString(it.latentEnergyCurStr); p.writeString(it.latentEnergyCurStr); wd(p, it.latentEnergyEndTime);
  }
  return p;
}

/** 178 quest list (SendUpdateQuests, :1672). */
export function updateQuests(id: number, states: Uint8Array, quests: QuestDataRow[]): PacketOut {
  const p = new PacketOut(178, id);
  p.writeInt(quests.length);
  for (const q of quests) {
    p.writeInt(q.QuestID); p.writeBoolean(q.IsComplete);
    p.writeInt(q.Condition1); p.writeInt(q.Condition2); p.writeInt(q.Condition3); p.writeInt(q.Condition4);
    const d = wireDate(q.CompletedDate);
    wd(p, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
    p.writeInt(q.RepeatFinish); p.writeInt(q.RandDobule); p.writeBoolean(q.IsExist);
  }
  p.write(states);
  return p;
}

/** 228 init achievements + 229 records (SendInitAchievements, :734). */
export function achievementRecords(code: 228 | 229, id: number, recs: RecordRow[]): PacketOut {
  const p = new PacketOut(code, id);
  p.writeInt(recs.length);
  for (const r of recs) {
    p.writeInt(r.RecordID);
    p.writeInt(r.Total);
  }
  return p;
}

/** 231 achievement data (SendUpdateAchievementData, :638). */
export function achievementData(id: number, rows: AchievementDataRow[]): PacketOut {
  const p = new PacketOut(231, id);
  p.writeInt(rows.length);
  for (const r of rows) {
    p.writeInt(r.AchievementID);
    p.writeInt(r.CompletedDate.getUTCFullYear()); p.writeInt(r.CompletedDate.getUTCMonth() + 1); p.writeInt(r.CompletedDate.getUTCDate());
  }
  return p;
}

/** 186 buff list (SendBufferList, :1723). Pay buffs (ValidDate in minutes) are sent in days. */
export function bufferList(playerId: number, buffs: BuffRow[]): PacketOut {
  const p = new PacketOut(186, playerId);
  p.writeInt(buffs.length);
  for (const b of buffs) {
    p.writeInt(b.Type); p.writeBoolean(b.IsExist); wd(p, b.BeginDate); p.writeInt(b.ValidDate);
    p.writeInt(b.Value); p.writeInt(b.ValidCount); p.writeInt(b.TemplateID);
  }
  return p;
}

/** 227 ENTHRALL_LIGHT (SendEnthrallLight, :413). */
export function enthrallLight(): PacketOut {
  const p = new PacketOut(227);
  p.writeBoolean(false); p.writeInt(0); p.writeBoolean(false); p.writeBoolean(false);
  return p;
}

/** 402/5 avatar collection (SendAvatarCollect, :2552) — empty collection. */
export function avatarCollect(): PacketOut {
  const p = new PacketOut(402);
  p.writeByte(5);
  p.writeInt(0);
  return p;
}

/** 259 FIRSTRECHARGE (SendUpdateFirstRecharge, :465). */
export function firstRecharge(isRecharged: boolean, isGetAward: boolean): PacketOut {
  const p = new PacketOut(259);
  p.writeBoolean(isRecharged); p.writeBoolean(isGetAward);
  return p;
}

/** 102/0 world boss OPEN (SendOpenWorldBoss, :2593) with BaseWorldBossRoom defaults (boss closed). */
export function openWorldBoss(): PacketOut {
  const p = new PacketOut(102);
  p.writeByte(0); p.writeString("0"); p.writeInt(0); p.writeString("Fera Divina"); p.writeString("boss");
  p.writeInt(0); p.writeInt(0); p.writeInt(0); p.writeInt(1); p.writeInt(0); p.writeInt(0);
  wd(p, MIN_DATE); wd(p, MIN_DATE); p.writeInt(0); p.writeBoolean(true); p.writeBoolean(true);
  p.writeInt(0); p.writeInt(0); p.writeInt(0); p.writeInt(0);
  p.writeInt(1); p.writeInt(1); p.writeString("Aumentar Dano"); p.writeInt(30); p.writeString("Dano base aumenta em 200."); p.writeInt(-1);
  p.writeBoolean(true); p.writeBoolean(false);
  return p;
}

/** 42 LEAGUE_START_NOTICE (SendLeagueNotice, :2283). */
export function leagueNotice(id: number, restCount: number, maxCount: number, type: number): PacketOut {
  const p = new PacketOut(42, id);
  p.writeByte(type);
  p.writeInt(restCount);
  if (type === 1) p.writeInt(maxCount);
  return p;
}

/** 145 guild member week open/close (SendGuildMemberWeekOpenClose, :2647). */
export function guildMemberWeek(userId: number): PacketOut {
  const p = new PacketOut(145, userId);
  p.writeByte(0); p.writeBoolean(false); p.writeString("2022-05-29 06:10:50.170"); p.writeString("2023-05-12 00:42:54.000");
  return p;
}

/** 95 NECKLACE_STRENGTH (SendNecklaceStrength, :2675). */
export function necklace(c: PlayerInfo): PacketOut {
  const p = new PacketOut(95, c.ID);
  p.writeInt(c.necklaceExp); p.writeInt(c.necklaceExpAdd);
  return p;
}

// ---------------------------------------------------------------------------------------------- scene / rooms

/** 18 SCENE_ADD_USER (SendSceneAddPlayer, :1196). */
export function sceneAddPlayer(c: PlayerInfo): PacketOut {
  const p = new PacketOut(18, c.ID);
  p.writeInt(c.Grade); p.writeBoolean(c.Sex); p.writeString(c.NickName ?? ""); p.writeByte(c.typeVIP); p.writeInt(c.VIPLevel);
  p.writeString(c.ConsortiaName); p.writeInt(c.Offer); p.writeInt(c.Win); p.writeInt(c.Total); p.writeInt(c.Escape);
  p.writeInt(c.ConsortiaID); p.writeInt(c.Repute); p.writeBoolean(c.IsMarried);
  if (c.IsMarried) {
    p.writeInt(c.SpouseID);
    p.writeString(c.SpouseName ?? "");
  }
  p.writeString(c.UserName ?? ""); p.writeInt(c.FightPower); p.writeInt(c.apprenticeshipState);
  return p;
}

/** 21 SCENE_REMOVE_USER (SendSceneRemovePlayer, :1224). */
export function sceneRemovePlayer(id: number): PacketOut {
  return new PacketOut(21, id);
}

export interface RoomView {
  RoomId: number; RoomType: number; HardLevel: number; TimeMode: number; PlayerCount: number; viewerCnt: number;
  maxViewerCnt: number; PlacesCount: number; Password: string; MapId: number; IsPlaying: boolean; Name: string;
  GameType: number; LevelLimits: number; isCrosszone: boolean; isWithinLeageTime: boolean; isOpenBoss: boolean; Pic: string;
}

/** 94/9 room list (SendUpdateRoomList, :1166) — at most 9 rooms per page. */
export function roomList(rooms: RoomView[]): PacketOut {
  const p = new PacketOut(94);
  p.writeByte(9);
  p.writeInt(rooms.length);
  const n = Math.min(rooms.length, 9);
  p.writeInt(n);
  for (let i = 0; i < n; i++) {
    const r = rooms[i]!;
    p.writeInt(r.RoomId); p.writeByte(r.RoomType); p.writeByte(r.TimeMode); p.writeByte(r.PlayerCount); p.writeByte(r.viewerCnt);
    p.writeByte(r.maxViewerCnt); p.writeByte(r.PlacesCount); p.writeBoolean(!!r.Password); p.writeInt(r.MapId); p.writeBoolean(r.IsPlaying);
    p.writeString(r.Name); p.writeByte(r.GameType); p.writeByte(r.HardLevel); p.writeInt(r.LevelLimits); p.writeBoolean(r.isOpenBoss);
  }
  return p;
}

/** 94/0 room create (SendRoomCreate, :1366). */
export function roomCreate(r: RoomView): PacketOut {
  const p = new PacketOut(94);
  p.writeByte(0); p.writeInt(r.RoomId); p.writeByte(r.RoomType); p.writeByte(r.HardLevel); p.writeByte(r.TimeMode);
  p.writeByte(r.PlayerCount); p.writeByte(r.viewerCnt); p.writeByte(r.PlacesCount); p.writeBoolean(!!r.Password);
  p.writeInt(r.MapId); p.writeBoolean(r.IsPlaying); p.writeString(r.Name); p.writeByte(r.GameType); p.writeInt(r.LevelLimits);
  p.writeBoolean(r.isCrosszone); p.writeBoolean(r.isWithinLeageTime); p.writeBoolean(r.isOpenBoss); p.writeString(r.Pic);
  return p;
}

/** 94/1 (SendRoomLoginResult, :1395). */
export function roomLoginResult(ok: boolean): PacketOut {
  const p = new PacketOut(94);
  p.writeByte(1);
  p.writeBoolean(ok);
  return p;
}

/** 94/2 (SendGameRoomSetupChange, :1468). */
export function roomSetupChange(r: RoomView): PacketOut {
  const p = new PacketOut(94);
  p.writeByte(2); p.writeBoolean(r.isOpenBoss);
  if (r.isOpenBoss) p.writeString(r.Pic);
  p.writeInt(r.MapId); p.writeByte(r.RoomType); p.writeString(r.Password ?? ""); p.writeString(r.Name ?? "Gunny1");
  p.writeByte(r.TimeMode); p.writeByte(r.HardLevel); p.writeInt(r.LevelLimits); p.writeBoolean(r.isCrosszone);
  return p;
}

/** 94/4 (SendRoomPlayerAdd, :1231). Pets not ported: pet count 0. */
export function roomPlayerAdd(v: PlayerView): PacketOut {
  const c = v.info;
  const p = new PacketOut(94, v.id);
  p.writeByte(4); p.writeBoolean(v.inRoom); p.writeByte(v.roomIndex); p.writeByte(v.roomTeam); p.writeBoolean(false);
  p.writeInt(c.Grade); p.writeInt(c.Offer); p.writeInt(c.Hide); p.writeInt(c.Repute); p.writeInt(Math.trunc(v.pingTime / 1000 / 10));
  p.writeInt(v.zoneId); p.writeInt(c.ID); p.writeString(c.NickName ?? ""); p.writeByte(c.typeVIP); p.writeInt(c.VIPLevel);
  p.writeBoolean(c.Sex); p.writeString(c.Style); p.writeString(c.Colors); p.writeString(c.Skin);
  p.writeInt(v.weaponTemplateId); p.writeInt(v.secondWeaponTemplateId);
  p.writeInt(c.ConsortiaID); p.writeString(c.ConsortiaName); p.writeInt(c.badgeID); p.writeInt(c.Win); p.writeInt(c.Total);
  p.writeInt(c.Escape); p.writeInt(c.ConsortiaLevel); p.writeInt(c.ConsortiaRepute); p.writeBoolean(c.IsMarried);
  if (c.IsMarried) {
    p.writeInt(c.SpouseID);
    p.writeString(c.SpouseName ?? "");
  }
  p.writeString(c.UserName ?? ""); p.writeInt(c.Nimbus); p.writeInt(c.FightPower); p.writeInt(c.apprenticeshipState);
  p.writeInt(c.masterID); p.writeString(c.masterOrApprentices ?? ""); p.writeInt(c.graduatesCount); p.writeString(c.honourOfMaster ?? "");
  p.writeBoolean(v.match.DailyLeagueFirst); p.writeInt(v.match.DailyLeagueLastScore);
  p.writeInt(0);
  return p;
}

/** 94/5 (SendRoomPlayerRemove, :1321). */
export function roomPlayerRemove(id: number, zoneId: number): PacketOut {
  const p = new PacketOut(94, id, id);
  p.writeByte(5);
  p.writeInt(zoneId);
  return p;
}

/** 94/6 (SendRoomPlayerChangedTeam, :1356). */
export function roomChangedTeam(id: number, team: number, index: number): PacketOut {
  const p = new PacketOut(94, id);
  p.writeByte(6); p.writeByte(team); p.writeByte(index);
  return p;
}

/** 94/15 (SendRoomUpdatePlayerStates, :1332). */
export function roomPlayerStates(states: number[]): PacketOut {
  const p = new PacketOut(94);
  p.writeByte(15);
  for (const s of states) p.writeByte(s);
  return p;
}

/** 94/10 (SendRoomUpdatePlacesStates, :1344). */
export function roomPlacesStates(states: number[]): PacketOut {
  const p = new PacketOut(94);
  p.writeByte(10);
  for (const s of states) p.writeInt(s);
  return p;
}

/** 94/13 pair-up start, 94/11 cancel (:1404, :1426), 94/12 room type (:1417). */
export function roomByte(sub: number, extra?: number): PacketOut {
  const p = new PacketOut(94);
  p.writeByte(sub);
  if (extra !== undefined) p.writeByte(extra);
  return p;
}

// ---------------------------------------------------------------------------------------------- social

/** 160/160 (SendAddFriend, :502). */
export function addFriend(u: PlayerInfo, relation: number, state: boolean): PacketOut {
  const p = new PacketOut(160, u.ID);
  p.writeByte(160); p.writeBoolean(state);
  if (state) {
    p.writeInt(u.ID); p.writeString(u.NickName ?? ""); p.writeByte(u.typeVIP); p.writeInt(u.VIPLevel); p.writeBoolean(u.Sex);
    p.writeString(u.Style); p.writeString(u.Colors); p.writeString(u.Skin); p.writeInt(u.State === 1 ? 1 : 0); p.writeInt(u.Grade);
    p.writeInt(u.Hide); p.writeString(u.ConsortiaName); p.writeInt(u.Total); p.writeInt(u.Escape); p.writeInt(u.Win); p.writeInt(u.Offer);
    p.writeInt(u.Repute); p.writeInt(relation); p.writeString(u.UserName ?? ""); p.writeInt(u.Nimbus); p.writeInt(u.FightPower);
    p.writeInt(u.apprenticeshipState); p.writeInt(u.masterID); p.writeString(u.masterOrApprentices ?? ""); p.writeInt(u.graduatesCount);
    p.writeString(u.honourOfMaster ?? ""); p.writeInt(u.AchievementPoint); p.writeString(u.Honor); p.writeBoolean(u.IsMarried);
  }
  return p;
}

/** 160/161 (SendFriendRemove, :543). */
export function friendRemove(friendId: number): PacketOut {
  const p = new PacketOut(160, friendId);
  p.writeByte(161);
  return p;
}

/** 160/165 (SendFriendState, :551). */
export function friendState(playerId: number, state: number, typeVip: number, vipLevel: number): PacketOut {
  const p = new PacketOut(160, playerId);
  p.writeByte(165); p.writeInt(state); p.writeInt(typeVip); p.writeInt(vipLevel); p.writeBoolean(true);
  return p;
}

/** 160/51 (sendOneOnOneTalk, :563). */
export function oneOnOneTalk(receiverId: number, senderNick: string, msg: string, playerId: number, now = new Date()): PacketOut {
  const p = new PacketOut(160, playerId);
  p.writeByte(51); p.writeInt(receiverId); p.writeString(senderNick); wd(p, now); p.writeString(msg); p.writeBoolean(false);
  return p;
}

/** 74 ITEM_EQUIP (SendUserEquip, :1035) — zlib-compressed body. Gem souls not ported (count 0). */
export function userEquip(c: PlayerInfo, items: ItemInfo[], now = new Date()): PacketOut {
  const p = new PacketOut(74, c.ID);
  p.writeInt(c.ID); p.writeString(c.NickName ?? ""); p.writeInt(c.Agility); p.writeInt(c.Attack); p.writeString(c.Colors); p.writeString(c.Skin);
  p.writeInt(c.Defence); p.writeInt(c.GP); p.writeInt(c.Grade); p.writeInt(c.Luck); p.writeInt(c.hp); p.writeInt(c.Hide); p.writeInt(c.Repute);
  p.writeBoolean(c.Sex); p.writeString(c.Style); p.writeInt(c.Offer); p.writeByte(c.typeVIP); p.writeInt(c.VIPLevel); p.writeInt(c.Win);
  p.writeInt(c.Total); p.writeInt(c.Escape); p.writeInt(c.ConsortiaID); p.writeString(c.ConsortiaName); p.writeInt(c.badgeID);
  p.writeInt(c.RichesOffer); p.writeInt(c.RichesRob); p.writeBoolean(c.IsMarried); p.writeInt(c.SpouseID); p.writeString(c.SpouseName ?? "");
  p.writeString(c.DutyName); p.writeInt(c.Nimbus); p.writeInt(c.FightPower); p.writeInt(c.apprenticeshipState); p.writeInt(c.masterID);
  p.writeString(c.masterOrApprentices ?? ""); p.writeInt(c.graduatesCount); p.writeString(c.honourOfMaster ?? ""); p.writeInt(c.AchievementPoint);
  p.writeString(c.Honor); wd(p, addDays(now, -2));
  const t = c.Texp;
  p.writeInt(t.spdTexpExp); p.writeInt(t.attTexpExp); p.writeInt(t.defTexpExp); p.writeInt(t.hpTexpExp); p.writeInt(t.lukTexpExp);
  p.writeBoolean(false); p.writeInt(0); p.writeInt(c.totemId); p.writeInt(c.necklaceExp);
  p.writeInt(items.length);
  for (const it of items) {
    p.writeByte(it.BagType); p.writeInt(it.UserID); p.writeInt(it.ItemID); p.writeInt(it.Count); p.writeInt(it.Place); p.writeInt(it.displayTemplateId(now));
    p.writeInt(it.AttackCompose); p.writeInt(it.DefendCompose); p.writeInt(it.AgilityCompose); p.writeInt(it.LuckCompose); p.writeInt(it.StrengthenLevel);
    p.writeBoolean(it.IsBinds); p.writeBoolean(it.IsJudge); wd(p, it.BeginDate); p.writeInt(it.ValidDate); p.writeString(it.Color ?? "");
    p.writeString(it.Skin ?? ""); p.writeBoolean(it.IsUsed);
    for (const h of [it.Hole1, it.Hole2, it.Hole3, it.Hole4, it.Hole5, it.Hole6]) p.writeInt(h);
    const display = it.effectiveTemplate(now);
    p.writeString(display.Pic ?? ""); p.writeInt(display.RefineryLevel); wd(p, now); p.writeByte(it.Hole5Level); p.writeInt(it.Hole5Exp);
    const gold = it.isValidGoldItem(now);
    p.writeByte(it.Hole6Level); p.writeInt(it.Hole6Exp); p.writeBoolean(gold);
    if (gold) {
      p.writeInt(it.goldValidDate);
      wd(p, it.goldBeginTime);
    }
    p.writeString(it.latentEnergyCurStr); p.writeString(it.latentEnergyNewStr); wd(p, it.latentEnergyEndTime);
  }
  p.writeInt(0);
  compressPacket(p);
  return p;
}

/** 117 MAIL_RESPONSE (SendMailResponse, :1749). */
export function mailResponse(playerId: number, type: number): PacketOut {
  const p = new PacketOut(117);
  p.writeInt(playerId);
  p.writeInt(type);
  return p;
}

// ---------------------------------------------------------------------------------------------- game (fight)

export interface FightPlayerView extends PlayerView {
  team: number;
  livingId: number;
  maxBlood: number;
  weaponRefineryLevel: number;
  weaponName: string;
  /** battle pet (BaseGame.SendCreateGame :2120): place, template, id, name, owner, level, [slot, skillId] */
  pet?: { place: number; templateId: number; id: number; name: string; userId: number; level: number; skillEquip: [number, number][] } | null;
}

/** 91/101 GAME_CREATE (Game.Logic/BaseGame.cs:2037 SendCreateGame). */
export function gameCreate(roomType: number, gameType: number, timeType: number, players: FightPlayerView[]): PacketOut {
  const p = new PacketOut(91);
  p.writeByte(101); p.writeInt(roomType); p.writeInt(gameType); p.writeInt(timeType); p.writeInt(players.length);
  for (const f of players) {
    const c = f.info;
    p.writeInt(f.zoneId); p.writeString(f.zoneName); p.writeInt(c.ID); p.writeString(c.NickName ?? ""); p.writeBoolean(false);
    p.writeByte(c.typeVIP); p.writeInt(c.VIPLevel); p.writeBoolean(c.Sex); p.writeInt(c.Hide); p.writeString(c.Style);
    p.writeString(c.Colors); p.writeString(c.Skin); p.writeInt(c.Grade); p.writeInt(c.Repute);
    if (f.weaponTemplateId <= 0) p.writeInt(0);
    else {
      p.writeInt(f.weaponTemplateId); p.writeInt(f.weaponRefineryLevel); p.writeString(f.weaponName); wd(p, MIN_DATE);
    }
    p.writeInt(f.secondWeaponTemplateId > 0 ? f.secondWeaponTemplateId : 0);
    p.writeInt(c.Nimbus); p.writeBoolean(c.IsShowConsortia); p.writeInt(c.ConsortiaID); p.writeString(c.ConsortiaName);
    p.writeInt(c.badgeID); p.writeInt(c.ConsortiaLevel); p.writeInt(c.ConsortiaRepute); p.writeInt(c.Win); p.writeInt(c.Total);
    p.writeInt(c.FightPower); p.writeInt(c.apprenticeshipState); p.writeInt(c.masterID); p.writeString(c.masterOrApprentices ?? "");
    p.writeInt(c.AchievementPoint); p.writeString(c.Honor); p.writeInt(c.Offer); p.writeBoolean(f.match.DailyLeagueFirst);
    p.writeInt(f.match.DailyLeagueLastScore); p.writeBoolean(c.IsMarried);
    if (c.IsMarried) {
      p.writeInt(c.SpouseID);
      p.writeString(c.SpouseName ?? "");
    }
    for (let i = 0; i < 6; i++) p.writeInt(0);
    p.writeInt(f.team); p.writeInt(f.livingId); p.writeInt(f.maxBlood);
    if (!f.pet) p.writeInt(0);
    else {
      const pt = f.pet;
      p.writeInt(1); p.writeInt(pt.place); p.writeInt(pt.templateId); p.writeInt(pt.id); p.writeString(pt.name); p.writeInt(pt.userId); p.writeInt(pt.level);
      p.writeInt(pt.skillEquip.length);
      for (const [slot, id] of pt.skillEquip) { p.writeInt(slot); p.writeInt(id); }
    }
  }
  return p;
}

/** 91/103 GAME_LOAD (BaseGame.cs:2916 SendStartLoading). */
export function gameLoad(maxTime: number, mapId: number, files: { type: number; path: string; className: string }[], petSkills: { pic: string; effect: string }[] = []): PacketOut {
  const p = new PacketOut(91);
  p.writeByte(103); p.writeInt(maxTime); p.writeInt(mapId); p.writeInt(files.length);
  for (const f of files) {
    p.writeInt(f.type);
    p.writeString(f.path);
    p.writeString(f.className);
  }
  p.writeInt(petSkills.length);
  for (const s of petSkills) {
    p.writeString(s.pic);
    p.writeString(s.effect);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------- pets / cards

/** Pet block of 68/1 (AbstractPacketLib.SendUpdateUserPet :203; client PlayerManager.__updatePet). */
export interface PetView {
  ID: number; TemplateID: number; Name: string; UserID: number; Place?: number; Attack: number; Defence: number; Luck: number; Agility: number; Blood: number;
  Damage: number; Guard: number; AttackGrow: number; DefenceGrow: number; LuckGrow: number; AgilityGrow: number; BloodGrow: number; DamageGrow: number;
  GuardGrow: number; Level: number; GP: number; MaxGP: number; Hunger: number; PetHappyStar: number; MP: number; Skill: string; SkillEquip: string;
  IsEquip: boolean; currentStarExp: number; PetHappyStarReduce?: (v: number) => number;
  petEquips?: { eqType: number; eqTemplateID: number; startTime: Date; ValidDate: number }[];
}
const pairs = (s: string) => (s || "").split("|").map((x) => x.split(",").map(Number)).filter((a) => a.length >= 2 && a.every(Number.isFinite));

/** 68/1 UPDATE_PET: slots of `userId`'s pet bag (null = slot emptied); attributes minus the happiness reduction. */
export function updateUserPet(userId: number, zoneId: number, slots: { place: number; pet: PetView | null }[], eat: { weaponLevel: number; clothesLevel: number; hatLevel: number }): PacketOut {
  const p = new PacketOut(68, userId);
  p.writeByte(1); p.writeInt(userId); p.writeInt(zoneId); p.writeInt(slots.length);
  for (const { place, pet } of slots) {
    p.writeInt(place);
    if (!pet) { p.writeBoolean(false); continue; }
    const r = pet.PetHappyStarReduce ?? (() => 0);
    p.writeBoolean(true); p.writeInt(pet.ID); p.writeInt(pet.TemplateID); p.writeString(pet.Name); p.writeInt(pet.UserID);
    p.writeInt(pet.Attack - r(pet.Attack)); p.writeInt(pet.Defence - r(pet.Defence)); p.writeInt(pet.Luck - r(pet.Luck));
    p.writeInt(pet.Agility - r(pet.Agility)); p.writeInt(pet.Blood - r(pet.Blood)); p.writeInt(pet.Damage); p.writeInt(pet.Guard);
    p.writeInt(pet.AttackGrow); p.writeInt(pet.DefenceGrow); p.writeInt(pet.LuckGrow); p.writeInt(pet.AgilityGrow); p.writeInt(pet.BloodGrow);
    p.writeInt(pet.DamageGrow); p.writeInt(pet.GuardGrow); p.writeInt(pet.Level); p.writeInt(pet.GP); p.writeInt(pet.MaxGP); p.writeInt(pet.Hunger);
    p.writeInt(pet.PetHappyStar); p.writeInt(pet.MP);
    const sk = pairs(pet.Skill);
    p.writeInt(sk.length);
    for (const [id, slot] of sk) { p.writeInt(id!); p.writeInt(slot!); }
    const eq = pairs(pet.SkillEquip);
    p.writeInt(eq.length);
    for (const [id, slot] of eq) { p.writeInt(slot!); p.writeInt(id!); }
    p.writeBoolean(pet.IsEquip);
    const eqs = pet.petEquips ?? [];
    p.writeInt(eqs.length);
    for (const eq of eqs) { p.writeInt(eq.eqType); p.writeInt(eq.eqTemplateID); p.writeDateTime(wireDate(eq.startTime), true); p.writeInt(eq.ValidDate); }
    p.writeInt(pet.currentStarExp);
  }
  p.writeInt(eat.weaponLevel); p.writeInt(eat.clothesLevel); p.writeInt(eat.hatLevel);
  return p;
}

/** 68/5 REFRESH_PET (AbstractPacketLib.SendRefreshPet:2226): the rolled adopt-pet offer; sends nothing when empty
 * (matches the original — an empty array means "no packet", not "empty list"). */
export function refreshPet(pets: PetView[], refreshBtn: boolean): PacketOut | null {
  if (!pets.length) return null;
  const p = new PacketOut(68);
  p.writeByte(5); p.writeBoolean(refreshBtn); p.writeInt(pets.length);
  for (const pet of pets) {
    p.writeInt(pet.Place ?? 0); p.writeInt(pet.TemplateID); p.writeString(pet.Name);
    p.writeInt(pet.Attack); p.writeInt(pet.Defence); p.writeInt(pet.Luck); p.writeInt(pet.Agility); p.writeInt(pet.Blood);
    p.writeInt(pet.Damage); p.writeInt(pet.Guard); p.writeInt(pet.AttackGrow); p.writeInt(pet.DefenceGrow); p.writeInt(pet.LuckGrow);
    p.writeInt(pet.AgilityGrow); p.writeInt(pet.BloodGrow); p.writeInt(pet.DamageGrow); p.writeInt(pet.GuardGrow);
    p.writeInt(pet.Level); p.writeInt(pet.GP); p.writeInt(pet.MaxGP); p.writeInt(pet.Hunger); p.writeInt(pet.MP);
    const sk = pairs(pet.Skill);
    p.writeInt(sk.length);
    for (const [id, slot] of sk) { p.writeInt(id!); p.writeInt(slot!); }
    p.writeInt(10); p.writeInt(10); p.writeInt(100); // val/val2/val3 (unused UI constants, hard-coded in the original too)
  }
  return p;
}

/** 68/22 PET_RISINGSTAR reply (PetRisingStar.cs:108). */
export function petRisingStarReply(success: boolean): PacketOut {
  const p = new PacketOut(68);
  p.writeByte(22); p.writeBoolean(success);
  return p;
}

/** 68/23 PET_EVOLUTION reply (PetEvolution.cs:52) — player-wide "evolution" tier, not the pet's own template. */
export function petEvolutionReply(leveledUp: boolean): PacketOut {
  const p = new PacketOut(68);
  p.writeByte(23); p.writeBoolean(leveledUp);
  return p;
}

/** 68/33 EAT_PETS info (AbstractPacketLib.SendEatPetsInfo). */
export function eatPetsInfo(info: { weaponExp: number; weaponLevel: number; clothesExp: number; clothesLevel: number; hatExp: number; hatLevel: number }): PacketOut {
  const p = new PacketOut(68);
  p.writeByte(33); p.writeInt(info.weaponExp); p.writeInt(info.weaponLevel); p.writeInt(info.clothesExp); p.writeInt(info.clothesLevel); p.writeInt(info.hatExp); p.writeInt(info.hatLevel);
  return p;
}

/** 68/2 ADD_PET reply (AddPet.cs:58): hatched template, shows the "got a pet" frame. */
export function petAdded(templateId: number): PacketOut {
  const p = new PacketOut(68);
  p.writeByte(2); p.writeInt(templateId); p.writeBoolean(true);
  return p;
}

export interface CardView {
  CardID: number; UserID: number; Count: number; Place: number; TemplateID: number; Attack: number; Defence: number; Agility: number; Luck: number;
  AttackReset: number; DefenceReset: number; AgilityReset: number; LuckReset: number; Damage: number; Guard: number; Level: number; CardGP: number; isFirstGet: boolean;
}
/** 216 CARDS_DATA (SendUpdateCardData(bag, slots) :1602): Total* = rolled + reset values. */
export function cardData(userId: number, slots: { place: number; card: CardView | null }[]): PacketOut {
  const p = new PacketOut(216, userId);
  p.writeInt(userId); p.writeInt(slots.length);
  for (const { place, card: c } of slots) {
    p.writeInt(place);
    if (!c || c.TemplateID === 0) { p.writeBoolean(false); continue; }
    p.writeBoolean(true); p.writeInt(c.CardID); p.writeInt(c.UserID); p.writeInt(c.Count); p.writeInt(c.Place); p.writeInt(c.TemplateID);
    p.writeInt(c.Attack + c.AttackReset); p.writeInt(c.Defence + c.DefenceReset); p.writeInt(c.Agility + c.AgilityReset); p.writeInt(c.Luck + c.LuckReset);
    p.writeInt(c.Damage); p.writeInt(c.Guard); p.writeInt(c.Level); p.writeInt(c.CardGP); p.writeBoolean(c.isFirstGet);
  }
  return p;
}
