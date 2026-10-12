/**
 * The 55 "static template builder" endpoints of Tank.Request (+ files that shipped only as snapshots but have a table).
 * Each def ports `<Name>.ashx.cs` Bulid(): the stored procedure (all are `select * from X [order by]`, see
 * research/db/Project_Game34/schema/procedures/SP_*_All.sql) + the FlashUtils.Create*Info builder
 * (vendor/DDTank41/Road.Flash/Road.Flash/FlashUtils.cs). Files are generated from the DB on boot and on admin
 * changes (TemplateCache) and served at REQUEST_PATH/<file>.xml with the compression the original wrote.
 */
import { sql } from "drizzle-orm";
import { applyTranslations, loadTranslations, type DbHandle } from "@ddt/db";
import { el, fmtDateDefault, result, wallNow, XEl, type XValue } from "../lib/flash-xml.js";
import { all, q } from "../lib/db.js";
import { item, spec, type Row } from "../lib/spec.js";

/**
 * pt-BR DB text overlay (see packages/db/src/translations.ts, docs/BACKLOG.md "Localização PT-BR"). Every
 * `flat()` template whose `table` is listed here gets its rows run through `applyTranslations` before the XML
 * is built — same mechanism apps/game/src/db/templates.ts uses, keyed by each table's actual primary key
 * column (matches `TARGETS` in packages/db/scripts/export-texts.ts). Tables not listed just keep their
 * original `game` schema text (no overlay row ever matches, which is the designed fallback).
 */
const LANG = "pt-BR";
const TRANSLATED_PK: Record<string, string> = {
  Game_Map: "ID",
  NPC_Info: "ID",
  Mission_Info: "Id",
  Mission_Info_Backup: "Id",
  Achievement: "ID",
  Quest: "ID",
  Shop_Goods: "TemplateID",
  Pet_Template_Info: "TemplateID",
  Pet_Skill_Info: "ID",
  Pet_Skill_Element_Info: "ID",
  Rune_Template: "TemplateID",
  Card_Info: "ID",
  Consortia_BuffTemp: "id",
  New_Title: "ID",
  SuitTemplateInfo: "SuitId",
};

/** Applies the pt-BR overlay to `rows` in place when `table` is one of TRANSLATED_PK; a no-op otherwise. */
async function translateRows(h: DbHandle, table: string, rows: Row[]): Promise<Row[]> {
  const pk = TRANSLATED_PK[table];
  if (!pk) return rows;
  const overlay = await loadTranslations(h.db, table, LANG);
  if (!overlay.size) return rows;
  return rows.map((r) => applyTranslations(r, pk, overlay));
}

export interface TemplateFile {
  /** File name without extension, as written by csFunction.CreateCompressXml. */
  name: string;
  compress: boolean;
}

export interface TemplateDef {
  /** Builder endpoint path (admin rebuild URL), e.g. "/BallList.ashx". */
  endpoint?: string;
  files: TemplateFile[];
  /** Tables whose change invalidates this template ("game.Ball"). */
  deps: string[];
  /** Player-data rankings (CelebList) are rebuilt periodically instead of on admin edits. */
  periodic?: boolean;
  build(h: DbHandle): Promise<XEl>;
}

const z = (name: string): TemplateFile => ({ name, compress: true });
const p = (name: string): TemplateFile => ({ name, compress: false });

/** Standard body: try { children; value=true } catch { Fail! } then value/message (+extra) attributes. */
async function wrap(children: () => Promise<XEl[]>, extra: () => [string, XValue][] = () => []): Promise<XEl> {
  try {
    const kids = await children();
    return result(true, "Success!", kids, extra());
  } catch (e) {
    console.error("[templates] build failed:", e);
    return result(false, "Fail!", [], extra());
  }
}

/** Flat list: Result > <elem .../>* from one table. */
function flat(o: {
  endpoint?: string;
  files: TemplateFile[];
  schema?: string;
  table: string;
  order?: string;
  elem?: string;
  attrs: string;
  wrapIn?: string;
  extra?: (rows: Row[]) => [string, XValue][];
}): TemplateDef {
  const schema = o.schema ?? "game";
  return {
    endpoint: o.endpoint,
    files: o.files,
    deps: [`${schema}.${o.table}`],
    async build(h) {
      let rows: Row[] = [];
      const sp = spec(o.attrs);
      return wrap(
        async () => {
          rows = await translateRows(h, o.table, await all(h, schema, o.table, o.order));
          const items = rows.map((r) => item(o.elem ?? "Item", sp, r));
          return o.wrapIn ? [el(o.wrapIn, []).add(...items)] : items;
        },
        () => (o.extra ? o.extra(rows) : []),
      );
    },
  };
}

// ---- FlashUtils specs -------------------------------------------------------------------------------------------

const S = {
  ball: "ID Power Radii FlyingPartical BombPartical Crater AttackResponse IsSpin SpinV SpinVA Amount Wind DragIndex Weight Shake ShootSound BombSound ActionType Mass",
  ballConfig: "TemplateID Common CommonAddWound CommonMultiBall Special",
  active:
    "ActiveID Description Content AwardContent HasKey EndDate:d IsOnly StartDate:d Title Type ActiveType:0 IsAdvance='false' GoodsExchangeTypes GoodsExchangeNum limitType limitValue ActionTimeContent",
  activitySystem: "ActivityType Quality TemplateID ValidDate Count IsBind StrengthLevel AttackCompose DefendCompose AgilityCompose LuckCompose",
  achievement:
    "ID AchievementPoint AchievementType CanHide Detail EndDate:d IsActive IsOther IsShare NeedMaxLevel NeedMinLevel PicID PlaceID PreAchievementID StartDate:d Title",
  achievementCond: "AchievementID CondictionID CondictionType Condiction_Para1 Condiction_Para2",
  achievementReward: "AchievementID RewardValueId RewardCount RewardType RewardPara",
  cardUpdateCondition: "Level Exp MinExp MaxExp UpdateCardCount ResetCardCount ResetMoney",
  cardUpdateInfo: "Id Level Attack Defend Agility Lucky Guard Damage",
  consortiaBuff: "id name descript type level value riches metal pic group",
  consortiaLevel: "Level Count Deduct NeedGold NeedItem Reward ShopRiches SmithRiches StoreRiches BufferRiches Riches",
  dailyAward: "ID Count CountRemark IsBinds Remark Sex TemplateID Type ValidDate GetWay AwardDays",
  fairBattle: "Score=Prestige Name Level",
  strengthen: "StrengthenLevel Rock Rock1 Rock2 Rock3 StoneLevelMin",
  itemBox: "ID TemplateId StrengthenLevel IsBind ItemCount LuckCompose DefendCompose AttackCompose AgilityCompose ItemValid IsTips",
  category: "ID Name Place Remark",
  map: "ID Name Description ForegroundWidth ForegroundHeight BackroundWidht BackroundHeight DeadWidth DeadHeight Weight DragIndex ForePic BackPic DeadPic Pic BackMusic Remark Type",
  petFight: "ID Exp Attack Agility Defence Lucky Blood",
  petMoe: "Level Attack Lucky Agility Blood Defence Guard Exp",
  pve: "ID Name Type LevelLimits SimpleTemplateIds NormalTemplateIds HardTemplateIds TerrorTemplateIds Pic Description Ordering AdviceTips BossFightNeedMoney",
  userBox: "ID Type Level Condition TemplateID",
  loginAward: "ID Count=Type RewardItemID IsSelect IsBind RewardItemValid RewardItemCount StrengthenLevel DefendCompose AgilityCompose LuckCompose",
  mapServer: "ServerID OpenMap IsSpecial",
  newTitle: "ID Order Show Name Pic Att Def Agi Luck Desc",
  npc: "ID Name Level Camp Type Blood MoveMin MoveMax BaseDamage BaseGuard Defence Agility Lucky ModelID ResourcesPath DropRate Experience Delay Immunity Alert Range Preserve Script FireX FireY DropId MagicAttack='0' MagicDefence='0'",
  petSkillElement: "ID Name EffectPic Description Pic",
  petSkill: "ID Name ElementIDs Description BallType NewBallID CostMP Pic Action EffectPic Delay ColdDown GameType Probability",
  petSkillTemplate: "PetTemplateID KindID GetType='1' SkillID SkillBookID MinLevel DeleteSkillIDs",
  petTemplate:
    "TemplateID Name KindID Description Pic RareLevel MP StarLevel GameAssetUrl HighAgility HighAgilityGrow HighAttack HighAttackGrow HighBlood HighBloodGrow HighDamage HighDamageGrow HighDefence HighDefenceGrow HighGuard HighGuardGrow HighLuck HighLuckGrow",
  quest:
    "ID QuestID Title Detail Objective NeedMinLevel NeedMaxLevel PreQuestID NextQuestID IsOther CanRepeat RepeatInterval RepeatMax RewardGP RewardGold RewardGiftToken RewardOffer RewardRiches RewardBuffID RewardBuffDate RewardMoney Rands RandDouble TimeMode StartDate EndDate MapID AutoEquip RewardMedal Rank StarLev NotMustCount",
  questCond: "QuestID CondictionID CondictionTitle CondictionType Para1 Para2 isOpitional",
  questGoods: "QuestID RewardItemID IsSelect RewardItemValid RewardItemCount StrengthenLevel AttackCompose DefendCompose AgilityCompose LuckCompose IsCount IsBind",
  serverConfig: "Name Value",
  shopShow: "Type ShopId",
  shop: "ID ShopID GroupID TemplateID BuyType IsContinue IsBind IsVouch Label Beat AUnit APrice1 AValue1 APrice2 AValue2 APrice3 AValue3 BUnit BPrice1 BValue1 BPrice2 BValue2 BPrice3 BValue3 CUnit CPrice1 CValue1 CPrice2 CValue2 CPrice3 CValue3 IsCheap LimitCount StartDate EndDate",
  suitPart: "ID ContainEquip PartName",
  suitInfo:
    "SuitId SuitName EqipCount1 SkillDescribe1 Skill1 EqipCount2 SkillDescribe2 Skill2 EqipCount3 SkillDescribe3 Skill3 EqipCount4 SkillDescribe4 Skill4 EqipCount5 SkillDescribe5 Skill5",
  itemTemplate:
    "AddTime:D Agility Attack CanCompose CanDelete CanDrop CanEquip CanStrengthen CanUse CategoryID Colors Defence Description Level Luck MaxCount Name NeedLevel NeedSex Pic Data Property1 Property2 Property3 Property4 Property5 Property6 Property7 Property8 Quality Script BindType FusionType FusionRate FusionNeedRate TemplateID RefineryLevel Hole ReclaimValue ReclaimType CanRecycle SuitId",
  totemHonor: "ID Type NeedMoney AddHonor",
  strengthExp: "Level Exp NecklaceStrengthExp NecklaceStrengthPlus",
  rune: "TemplateID NextTemplateID Name BaseLevel MaxLevel Type1 Attribute1 Turn1 Rate1 Type2 Attribute2 Turn2 Rate2 Type3 Attribute3 Turn3 Rate3",
  /** FlashUtils.CreateCelebInfo(PlayerInfo) over V_Sys_Users_Detail. */
  celeb:
    "ID=UserID UserName NickName typeVIP:0 VIPLevel:0 Grade Colors Skin Sex Style ConsortiaName Hide Offer ReputeOffer ConsortiaHonor ConsortiaLevel StoreLevel ShopLevel SmithLevel ConsortiaRepute WinCount=Win TotalCount=Total EscapeCount=Escape Repute AddDayGP AddDayOffer AddWeekGP AddWeekOffer ConsortiaRiches Nimbus GP FightPower AchievementPoint Rank='' AddDayAchievementPoint='0' AddWeekAchievementPoint='0' GiftGp='0' GiftLevel='1' AddDayGiftGp='0' AddWeekGiftGp='0' ApprenticeshipState='0' AddWeekLeagueScore",
  /** FlashUtils.CreateConsortiaInfo over V_Consortia. */
  consortia:
    "ConsortiaID BuildDate:d CelebCount ChairmanID ChairmanName ChairmanTypeVIP='0' ChairmanVIPLevel='0' ConsortiaName CreatorID CreatorName Description Honor IP Level MaxCount Placard Repute Count Riches FightPower DeductDate:d AddDayHonor AddDayRiches AddWeekHonor AddWeekRiches LastDayRiches OpenApply StoreLevel SmithLevel ShopLevel BufferLevel=SkillLevel ConsortiaGiftGp='0' ConsortiaAddDayGiftGp='0' ConsortiaAddWeekGiftGp='0' Port IsVoting='false' VoteRemainDay='3' CharmGP='0' BadgeBuyTime BadgeID ValidDate",
};
export const SPECS = S;

const today = (): [string, XValue][] => [["date", wallNow().toISOString().slice(0, 10)]];

// ---- celeb (rankings) -----------------------------------------------------------------------------------------

/** PlayerBussiness.GetPlayerPage order codes (PlayerBussiness.cs:2072-2110). Fixed strings, never user input. */
export const USER_ORDER: Record<number, string> = {
  0: `"GP" DESC`,
  1: `"Offer" DESC`,
  2: `"AddDayGP" DESC`,
  3: `"AddWeekGP" DESC`,
  4: `"AddDayOffer" DESC`,
  5: `"AddWeekOffer" DESC`,
  6: `"FightPower" DESC`,
  7: `"EliteScore" DESC`,
  8: `"State" DESC, "graduatesCount" DESC, "FightPower" DESC`,
  9: `random()`,
  10: `"State" DESC, "GP" ASC, "FightPower" DESC`,
  // not in GetPlayerPage: Tofflist menus whose builders were missing from DDTank41
  20: `"AchievementPoint" DESC`,
  21: `"AddWeekLeagueScore" DESC`,
  22: `"charmGP" DESC`,
};

/** ConsortiaBussiness.GetConsortiaPage order codes (ConsortiaBussiness.cs:1520-1560). */
export const CONSORTIA_ORDER: Record<number, string> = {
  0: `"ConsortiaName"`,
  1: `"ReputeSort"`,
  2: `"ChairmanName"`,
  3: `"Count" DESC`,
  4: `"Level" DESC`,
  5: `"Honor" DESC`,
  10: `"Riches" DESC`,
  11: `"AddDayRiches" DESC`,
  12: `"AddWeekRiches" DESC`,
  13: `"LastDayHonor" DESC`,
  14: `"AddDayHonor" DESC`,
  15: `"AddWeekHonor" DESC`,
  16: `"Level" DESC, "LastDayRiches" DESC`,
};

export function topUsers(h: DbHandle, order: number, limit = 50, offset = 0): Promise<Row[]> {
  const ord = USER_ORDER[order] ?? USER_ORDER[0]!;
  return q(
    h,
    sql`SELECT * FROM app."V_Sys_Users_Detail" WHERE "IsExist" = true AND "IsFirst" <> 0 ORDER BY ${sql.raw(ord)}, "UserID" LIMIT ${limit} OFFSET ${offset}`,
  );
}

function celebUsers(file: string, order: number, plain?: string): TemplateDef {
  return {
    endpoint: undefined,
    files: plain ? [z(file), p(plain)] : [z(file)],
    deps: [],
    periodic: true,
    build: (h) => wrap(async () => (await topUsers(h, order)).map((r) => item("Item", S.celeb, r)), today),
  };
}

async function consortiaWithChairman(h: DbHandle, rows: Row[]): Promise<XEl[]> {
  const ids = rows.map((r) => Number(r.ChairmanID)).filter((n) => n);
  const chairmen = ids.length
    ? await q(h, sql`SELECT * FROM app."V_Sys_Users_Detail" WHERE "UserID" IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
    : [];
  const byId = new Map(chairmen.map((c) => [Number(c.UserID), c]));
  return rows.map((r) => {
    const node = item("Item", S.consortia, r);
    const ch = byId.get(Number(r.ChairmanID));
    if (ch) node.add(item("Item", S.celeb, ch));
    return node;
  });
}

function celebConsortia(file: string, order: number, plain?: string): TemplateDef {
  return {
    files: plain ? [z(file), p(plain)] : [z(file)],
    deps: [],
    periodic: true,
    async build(h) {
      let total = 0;
      const ord = CONSORTIA_ORDER[order] ?? CONSORTIA_ORDER[0]!;
      return wrap(
        async () => {
          const [c] = await q<{ n: number }>(h, sql`SELECT count(*)::int AS n FROM app."V_Consortia" WHERE "IsExist" = true`);
          total = Number(c?.n ?? 0);
          const rows = await q(h, sql`SELECT * FROM app."V_Consortia" WHERE "IsExist" = true ORDER BY ${sql.raw(ord)} LIMIT 50`);
          return consortiaWithChairman(h, rows);
        },
        () => [["total", total], ...today()],
      );
    },
  };
}

// The root attribute order differs for consortia lists: total, value, message, date (csFunction.BuildCelebConsortia).
function rootFirst(e: XEl, names: string[]): XEl {
  e.attrs.sort((a, b) => {
    const ia = names.indexOf(a[0]);
    const ib = names.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return e;
}

function withRootOrder(d: TemplateDef, names: string[]): TemplateDef {
  return { ...d, build: async (h) => rootFirst(await d.build(h), names) };
}

// ---- definitions ------------------------------------------------------------------------------------------------

export const TEMPLATES: TemplateDef[] = [
  {
    endpoint: "/achievementlist.ashx",
    files: [p("achievementlist_out"), z("achievementlist")],
    deps: ["game.Achievement", "game.AchievementCondition", "game.Achievement_Goods"],
    build: (h) =>
      wrap(async () => {
        const [a, c, g] = await Promise.all([
          translateRows(h, "Achievement", await all(h, "game", "Achievement")),
          all(h, "game", "AchievementCondition"),
          all(h, "game", "Achievement_Goods"),
        ]);
        return a.map((x) => {
          const e = item("Item", S.achievement, x);
          for (const k of c) if (k.AchievementID === x.ID) e.add(item("Item_Condiction", S.achievementCond, k));
          for (const k of g) if (k.AchievementID === x.ID) e.add(item("Item_Reward", S.achievementReward, k));
          return e;
        });
      }),
  },
  flat({ endpoint: "/ActiveList.ashx", files: [z("ActiveList")], table: "Active", order: `"ActiveID" DESC`, attrs: S.active }),
  flat({
    endpoint: "/activitysystemitems.ashx",
    files: [p("activitysystemitems_out"), z("activitysystemitems")],
    table: "Activity_System_Item",
    attrs: S.activitySystem,
  }),
  flat({ endpoint: "/BallList.ashx", files: [z("BallList")], table: "Ball", order: `"ID"`, attrs: S.ball }),
  flat({ endpoint: "/bombconfig.ashx", files: [z("bombconfig")], table: "BallConfig", order: `"TemplateID"`, attrs: S.ballConfig }),
  flat({ endpoint: "/CardUpdateCondition.ashx", files: [z("CardUpdateCondition")], table: "CardUpdateCondition", attrs: S.cardUpdateCondition }),
  flat({ endpoint: "/CardUpdateInfo.ashx", files: [z("CardUpdateInfo")], table: "CardUpdateInfo", attrs: S.cardUpdateInfo }),
  flat({
    endpoint: "/consortiabuffertemp.ashx",
    files: [p("consortiabuffertemp_out"), z("consortiabuffertemp")],
    table: "Consortia_BuffTemp",
    attrs: S.consortiaBuff,
  }),
  // ConsortiaBussiness -> Project_Player34 copy of Consortia_Level
  flat({ endpoint: "/ConsortiaLevelList.ashx", files: [z("ConsortiaLevelList")], schema: "player", table: "Consortia_Level", order: `"Level"`, attrs: S.consortiaLevel }),
  flat({ endpoint: "/DailyAwardList.ashx", files: [z("DailyAwardList")], table: "Daily_Award", attrs: S.dailyAward }),
  {
    // SP_Daily_League_Award_All does not exist in any DB (research/db/00-summary.md): the shipped file is an empty Result.
    endpoint: "/DailyLeagueAwardList.ashx",
    files: [p("dailyleagueaward_out"), z("dailyleagueaward")],
    deps: [],
    build: () => wrap(async () => []),
  },
  flat({
    endpoint: "/DailyLeagueLevelList.ashx",
    files: [p("dailyleaguelevel_out"), z("dailyleaguelevel")],
    elem: "item",
    table: "Fair_Battle_Reward_Temp",
    order: `"Prestige"`,
    attrs: S.fairBattle,
  }),
  {
    endpoint: "/elitematchplayerlist.ashx",
    files: [z("elitematchplayerlist")],
    deps: [],
    periodic: true,
    // csFunction.BuildEliteMatchPlayerList: order 7 (EliteScore), ItemSet value=1 (Grade<=40) / 2, then lastUpdateTime
    build: (h) =>
      wrap(
        async () => {
          const rows = await topUsers(h, 7);
          const s1 = el("ItemSet", [["value", 1]]);
          const s2 = el("ItemSet", [["value", 2]]);
          let r1 = 1;
          let r2 = 1;
          for (const r of rows) {
            const lo = Number(r.Grade) <= 40;
            (lo ? s1 : s2).add(
              el("Item", [
                ["PlayerID", r.UserID as XValue],
                ["PlayerName", r.NickName as XValue],
                ["PlayerScore", r.EliteScore as XValue],
                ["PlayerRank", lo ? r1++ : r2++],
              ]),
            );
          }
          return [s1, s2];
        },
        () => [["lastUpdateTime", fmtDateDefault(wallNow())]],
      ),
  },
  {
    endpoint: "/eventrewarditemlist.ashx",
    files: [p("eventrewarditemlist_out"), z("eventrewarditemlist")],
    deps: ["game.Event_Reward_Info", "game.Event_Reward_Goods"],
    build: (h) =>
      wrap(async () => {
        const infos = await all(h, "game", "Event_Reward_Info", `"ActivityType" ASC, "SubActivityType"`);
        const goods = await all(h, "game", "Event_Reward_Goods", `"ActivityType" ASC, "SubActivityType"`);
        // Dictionary<ActivityType, Dictionary<SubActivityType, info>> (first one wins), insertion ordered like C#.
        const byType = new Map<number, Map<number, { info: Row; goods: Row[] }>>();
        for (const i of infos) {
          const t = Number(i.ActivityType);
          const s = Number(i.SubActivityType);
          let m = byType.get(t);
          if (!m) byType.set(t, (m = new Map()));
          if (!m.has(s)) m.set(s, { info: i, goods: [] });
        }
        for (const g of goods) byType.get(Number(g.ActivityType))?.get(Number(g.SubActivityType))?.goods.push(g);
        const out: XEl[] = [];
        for (const [t, subs] of byType) {
          const at = el("ActivityType", [["value", t]]);
          for (const { info, goods: gs } of subs.values()) {
            const items = el("Items", [
              ["SubActivityType", info.SubActivityType as XValue],
              ["Condition", info.Condition as XValue],
            ]);
            for (const g of gs) items.add(item("Item", "TemplateId StrengthLevel AttackCompose DefendCompose LuckCompose AgilityCompose IsBind ValidDate Count", g));
            at.add(items);
          }
          out.push(at);
        }
        return out;
      }),
  },
  {
    endpoint: "/fightlabdropitemlist.ashx",
    files: [p("fightlabdropitemlist_out"), z("fightlabdropitemlist")],
    deps: ["game.Drop_Item"],
    build: (h) =>
      wrap(async () => {
        const ids = [10000, 10001, 10002, 10010, 10011, 10012, 10020, 10021, 10022, 10030, 10031, 10032, 10040, 10041, 10042];
        const rows = await all(h, "game", "Drop_Item", `"Id"`);
        return rows
          .filter((r) => ids.includes(Number(r.DropId)))
          .map((r) =>
            el("Item", [
              ["ID", String(r.DropId).slice(0, 4)],
              ["Easy", String(r.DropId).slice(4, 5)],
              ["AwardItem", r.ItemId as XValue],
              ["Count", r.BeginData as XValue],
            ]),
          );
      }),
  },
  flat({ endpoint: "/ItemStrengthenList.ashx", files: [z("ItemStrengthenList")], table: "Item_Strengthen", order: `"StrengthenLevel"`, attrs: S.strengthen }),
  flat({ endpoint: "/LoadBoxTemp.ashx", files: [z("LoadBoxTemp")], table: "Shop_Goods_Box", attrs: S.itemBox }),
  flat({ endpoint: "/LoadItemsCategory.ashx", files: [z("LoadItemsCategory")], table: "Shop_Goods_Categorys", order: `"ID"`, attrs: S.category }),
  flat({ endpoint: "/LoadMapsItems.ashx", files: [z("LoadMapsItems")], table: "Game_Map", order: `"ID" DESC`, attrs: S.map }),
  flat({
    endpoint: "/loadpetfightproperty.ashx",
    files: [p("loadpetfightproperty_out"), z("loadpetfightproperty")],
    table: "Pet_Fight_Property",
    attrs: S.petFight,
    wrapIn: "ItemTemplate",
  }),
  flat({
    endpoint: "/loadpetmoeproperty.ashx",
    files: [p("loadpetmoeproperty_out"), z("loadpetmoeproperty")],
    table: "Pet_Moe_Property",
    attrs: S.petMoe,
    wrapIn: "ItemTemplate",
  }),
  flat({ endpoint: "/LoadPVEItems.ashx", files: [z("LoadPVEItems")], table: "Pve_Info", order: `"Type", "Ordering"`, attrs: S.pve }),
  flat({ endpoint: "/LoadUserBox.ashx", files: [z("LoadUserBox")], table: "User_Box", attrs: S.userBox }),
  flat({ endpoint: "/LoginAwardItemTemplate.ashx", files: [z("loginawarditemtemplate")], table: "Login_Award_Item_Template", order: `"ID"`, attrs: S.loginAward }),
  flat({ endpoint: "/MapServerList.ashx", files: [z("MapServerList")], table: "Map_Server", attrs: S.mapServer }),
  flat({
    endpoint: "/newtitle.ashx",
    files: [p("newtitleinfo")],
    table: "New_Title",
    order: `"ID"`,
    attrs: S.newTitle,
    extra: (rows) => [["total", rows.length]],
  }),
  flat({ endpoint: "/NPCInfoList.ashx", files: [z("NPCInfoList")], table: "NPC_Info", order: `"ID"`, attrs: S.npc }),
  flat({ endpoint: "/petskillelementinfo.ashx", files: [p("petskillelementinfo")], elem: "item", table: "Pet_Skill_Element_Info", order: `"ID"`, attrs: S.petSkillElement }),
  flat({ endpoint: "/petskillinfo.ashx", files: [p("petskillinfo")], elem: "item", table: "Pet_Skill_Info", order: `"ID"`, attrs: S.petSkill }),
  flat({ endpoint: "/petskilltemplateinfo.ashx", files: [p("petskilltemplateinfo")], elem: "item", table: "Pet_Skill_Template_Info", attrs: S.petSkillTemplate }),
  flat({ endpoint: "/pettemplateinfo.ashx", files: [p("pettemplateinfo")], elem: "item", table: "Pet_Template_Info", order: `"TemplateID"`, attrs: S.petTemplate }),
  {
    endpoint: "/QuestList.ashx",
    files: [z("QuestList")],
    deps: ["game.Quest", "game.Quest_Condiction", "game.Quest_Goods"],
    build: (h) =>
      wrap(async () => {
        const [qs, cs, gs] = await Promise.all([
          translateRows(h, "Quest", await all(h, "game", "Quest", `"ID"`)),
          all(h, "game", "Quest_Condiction"),
          all(h, "game", "Quest_Goods"),
        ]);
        const cBy = groupBy(cs, "QuestID");
        const gBy = groupBy(gs, "QuestID");
        return qs.map((x) => {
          const e = item("Item", S.quest, x);
          for (const c of cBy.get(Number(x.ID)) ?? []) e.add(item("Item_Condiction", S.questCond, c));
          for (const g of gBy.get(Number(x.ID)) ?? []) e.add(item("Item_Good", S.questGoods, g));
          return e;
        });
      }),
  },
  // ServiceBussiness (Project_Player34) -> player.Server_Config; plain text (client TEXT_LOADER)
  flat({ endpoint: "/serverconfig.ashx", files: [p("ServerConfig")], schema: "player", table: "Server_Config", order: `"ID"`, attrs: S.serverConfig }),
  flat({ endpoint: "/ShopGoodsShowList.ashx", files: [z("ShopGoodsShowList")], table: "ShopGoodsShowList", order: `"TempID"`, attrs: S.shopShow, wrapIn: "Store" }),
  flat({ endpoint: "/ShopItemList.ashx", files: [z("ShopItemList")], table: "Shop", order: `"Sort" DESC, "ID"`, attrs: S.shop, wrapIn: "Store" }),
  flat({ endpoint: "/suitpartequipinfolist.ashx", files: [z("suitpartequipinfolist")], table: "Suit_TemplateID", attrs: S.suitPart }),
  flat({ endpoint: "/suittemplateinfolist.ashx", files: [z("suittemplateinfolist")], table: "SuitTemplateInfo", attrs: S.suitInfo }),
  flat({
    endpoint: "/TemplateAllList.ashx",
    files: [p("TemplateAlllist1"), z("TemplateAlllist")],
    table: "Shop_Goods",
    order: `"TemplateID"`,
    attrs: S.itemTemplate,
    wrapIn: "ItemTemplate",
  }),
  flat({ endpoint: "/totemhonortemplate.ashx", files: [p("totemhonortemplate")], elem: "item", table: "Totem_Honor_Template", order: `"ID"`, attrs: S.totemHonor }),
  flat({ endpoint: "/runetemplatelist.ashx", files: [p("runetemplatelist_out"), z("runetemplatelist")], table: "Rune_Template", order: `"TemplateID"`, elem: "Rune", attrs: S.rune, wrapIn: "RuneTemplate" }),

  // ---- CelebList (csFunction.BuildCelebUsers / BuildCelebConsortia, CelebList/*.ashx.cs) ----
  celebUsers("CelebByGpList", 0, "CelebForUsers"),
  celebUsers("CelebByDayGPList", 2, "CelebForUsersByDay"),
  celebUsers("CelebByWeekGPList", 3, "CelebByWeekGPList_Out"),
  celebUsers("CelebByOfferList", 1, "CelebByOfferList_Out"),
  celebUsers("CelebByDayOfferList", 4, "CelebByDayOfferList_Out"),
  celebUsers("CelebByWeekOfferList", 5, "CelebByWeekOfferList_Out"),
  celebUsers("CelebByDayFightPowerList", 6, "CelebByDayFightPowerList_Out"),
  celebUsers("CelebByAchievementPointList", 20),
  celebUsers("CelebByWeekLeagueScore", 21),
  celebUsers("CelebByGiftGpList", 22),
  withRootOrder(celebConsortia("CelebByConsortiaRiches", 10, "CelebByConsortiaRiches_Out"), ["total", "value", "message", "date"]),
  withRootOrder(celebConsortia("CelebByConsortiaDayRiches", 11, "CelebByConsortiaDayRiches_Out"), ["total", "value", "message", "date"]),
  withRootOrder(celebConsortia("CelebByConsortiaWeekRiches", 12, "CelebByConsortiaWeekRiches_Out"), ["total", "value", "message", "date"]),
  withRootOrder(celebConsortia("CelebByConsortiaHonor", 13, "CelebByConsortiaHonor_Out"), ["total", "value", "message", "date"]),
  withRootOrder(celebConsortia("CelebByConsortiaDayHonor", 14, "CelebByConsortiaDayHonor_Out"), ["total", "value", "message", "date"]),
  withRootOrder(celebConsortia("CelebByConsortiaWeekHonor", 15, "CelebByConsortiaWeekHonor_Out"), ["total", "value", "message", "date"]),
  withRootOrder(celebConsortia("CelebByConsortiaLevel", 16, "CelebForConsortia"), ["total", "value", "message", "date"]),
  {
    // csFunction.BuildCelebConsortiaFightPower: all consortia by FightPower (UpdateConsortiaFightPower)
    files: [z("celebbyconsortiafightpower"), p("celebbyconsortiafightpower_Out")],
    deps: [],
    periodic: true,
    async build(h) {
      let total = 0;
      const r = await wrap(
        async () => {
          const rows = await q(h, sql`SELECT * FROM app."V_Consortia" WHERE "IsExist" = true ORDER BY "FightPower" DESC`);
          total = rows.length;
          return consortiaWithChairman(h, rows);
        },
        () => [["total", total], ...today()],
      );
      return rootFirst(r, ["total", "value", "message", "date"]);
    },
  },
  {
    // CelebList/CelebByDayBestEquip.ashx: SP_Users_BestEquip -> CreateBestEquipInfo. Plain file.
    files: [p("CelebForBestEquip")],
    deps: [],
    periodic: true,
    build: (h) =>
      wrap(async () => {
        const rows = await q(
          h,
          sql`SELECT g."BeginDate" AS "Date", d."GP", d."Grade", s."Name" AS "ItemName", d."NickName", d."Sex", g."StrengthenLevel" AS "Strengthenlevel", d."UserName"
              FROM player."Sys_Users_Goods" g JOIN player."Sys_Users_Detail" d ON d."UserID" = g."UserID" JOIN game."Shop_Goods" s ON s."TemplateID" = g."TemplateID"
              WHERE g."IsExist" = true AND g."StrengthenLevel" >= 9 AND g."BagType" = 0 AND g."Place" < 31
              ORDER BY g."StrengthenLevel" DESC, d."GP" DESC LIMIT 20`,
        );
        return rows.map((r) => item("Item", "Date:d GP Grade ItemName NickName Sex Strengthenlevel Type=UserName", r));
      }),
  },

  // ---- files that shipped only as snapshots in DDTank41 (no builder) but whose table exists: built with the snapshot's attribute names ----
  flat({ files: [z("clothgrouptemplateinfo"), p("clothgrouptemplateinfo_out")], table: "ClothGroupTemplateInfo", order: `"ItemID"`, attrs: "ID TemplateID Sex Description Cost" }),
  flat({ files: [z("clothpropertytemplateinfo"), p("clothpropertytemplateinfo_out")], table: "ClothPropertyTemplateInfo", order: `"ID"`, attrs: "ID Sex Name Attack Defend Agility Luck Blood Damage Guard Cost" }),
  flat({ files: [z("consortiabadgeconfig"), p("consortiabadgeconfig_out")], table: "Consortia_Badge", order: `"BadgeID"`, elem: "item", attrs: "BadgeID BadgeName Cost LimitLevel ValidDate" }),
  flat({ files: [z("exerciseinfolist")], table: "ExerciseInfo", order: `"Grage"`, attrs: "Grage GP ExerciseA ExerciseAG ExerciseD ExerciseH ExerciseL" }),
  flat({ files: [z("fightspirittemplatelist")], table: "Fight_Spirit_Templatelist", order: `"ID"`, elem: "item", attrs: "FightSpiritID FightSpiritIcon Level Exp Attack Defence Agility Lucky Blood" }),
  flat({ files: [z("goldequiptemplateload"), p("goldequiptemplateload_out")], table: "GoldEquipTemplateLoad", order: `"ID"`, elem: "item", attrs: "ID OldTemplateId NewTemplateId CategoryID Strengthen Attack Defence Agility Luck Damage Guard Boold BlessID Pic" }),
  flat({ files: [z("itemstrengthengoodsinfo"), p("itemstrengthengoodsinfo_out")], table: "Item_Strengthen_Goods", order: `"ID"`, attrs: "ID CurrentEquip Level GainEquip OriginalEquip=OrginEquip" }),
  flat({ files: [z("levellist")], table: "LevelInfo", order: `"Grade"`, attrs: "Grade GP Blood" }),
  flat({ files: [z("loadpetstarexp")], table: "Pet_Star_Exp", attrs: "Exp NewID OldID" }),
  flat({ files: [p("loadstrengthexp")], table: "StrengThenExp", order: `"Level"`, elem: "item", attrs: S.strengthExp }),
  flat({ files: [p("petlevelinfo")], table: "Pet_Level", order: `"Level"`, elem: "item", attrs: "GP Level" }),
  flat({ files: [z("petexpitemprice")], table: "Pet_Exp_Item_Price", order: `"ID"`, attrs: "Count Money ItemCount" }),
  flat({ files: [z("SetsBuildTemp")], table: "Sets_Build_Temp", order: `"SetsType", "Level"`, elem: "SetsBuildTemp", attrs: "Level SetsType UseItemTemplate Exp DefenceGrow BloodGrow LuckGrow AgilityGrow MagicDefenceGrow=DamageGrow GuardGrow" }),
  flat({ files: [z("toteminfo")], table: "Totem_Info", order: `"ID"`, elem: "item", attrs: "ID ConsumeExp ConsumeHonor AddAttack AddDefence AddAgility AddLuck AddBlood AddDamage AddGuard Random Page Layers Location Point DiscountMoney" }),
  {
    // petconfiginfo.xml: one <item Name="Value"/> per Pet_Config row (attribute name = config key).
    files: [p("petconfiginfo")],
    deps: ["game.Pet_Config"],
    build: (h) => wrap(async () => (await all(h, "game", "Pet_Config", `"Name"`)).map((r) => el("item", [[String(r.Name), r.Value as XValue]]))),
  },
  {
    // cardbufflist.xml: <Card CardID><Item condition PropertiesDscripID value Description/></Card>
    files: [z("cardbufflist")],
    deps: ["game.Card_Buff"],
    build: (h) =>
      wrap(async () => {
        const rows = await all(h, "game", "Card_Buff", `"CardID", "ID"`);
        return [...groupBy(rows, "CardID")].map(([id, rs]) =>
          el("Card", [["CardID", id]]).add(...rs.map((r) => item("Item", "condition PropertiesDscripID value Description", r))),
        );
      }),
  },
];

function groupBy(rows: Row[], key: string): Map<number, Row[]> {
  const m = new Map<number, Row[]>();
  for (const r of rows) {
    const k = Number(r[key]);
    let a = m.get(k);
    if (!a) m.set(k, (a = []));
    a.push(r);
  }
  return m;
}
