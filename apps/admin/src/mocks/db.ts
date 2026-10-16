import type { FieldDef, ResourceDef, Row } from "@/crud/types";
import { resources } from "@/resources";

/** In-memory tables for the dev mock API, one per ResourceDef. */

const DAY = 86_400_000;
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]!;
const int = (a: number, b: number) => Math.floor(a + rand() * (b - a + 1));

const svgIcon = (hue: number, label: string) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(${hue} 70% 55%)"/><text x="32" y="41" font-family="sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#0a0e22">${label}</text></svg>`,
  );

/** Generic row generator from field types — new resources get mock data for free. */
function autoRow(def: ResourceDef, i: number): Row {
  const row: Row = {};
  for (const f of def.fields) row[f.name] = autoValue(f, i, def);
  return row;
}
function autoValue(f: FieldDef, i: number, def: ResourceDef): unknown {
  if ((Array.isArray(def.idField) ? def.idField[0] : def.idField) === f.name && f.type === "number") return i + 1;
  if (f.default !== undefined && rand() < 0.5) return f.default;
  switch (f.type) {
    case "number":
      return int(f.min ?? 0, f.max ?? 1000);
    case "boolean":
      return rand() > 0.3;
    case "select":
      return f.options?.length ? pick(f.options).value : null;
    case "date":
    case "datetime":
      return new Date(Date.now() - int(-10, 60) * DAY).toISOString();
    case "image":
      return svgIcon(int(0, 360), String(i + 1));
    case "tags":
      return [];
    case "json":
      return f.default ?? null;
    case "password":
      return undefined;
    case "color":
      return "#ffc531";
    default:
      return `${typeof f.label === "string" ? f.label : (f.label["zh-CN"] ?? f.label["pt-BR"])} ${i + 1}`;
  }
}

const NICKS = ["Canhoneiro", "VentoNorte", "Bombardino", "LuaDeFogo", "TiroCerto", "Zeca_Bala", "Pólvora", "ArcoÍris", "Trovão", "Mira9000", "Pipoca", "Dona_Granada"];
const ITEM_NAMES: [number, string][] = [
  [7, "基础大炮"], [7, "雷霆火箭筒"], [7, "寒冰长枪"], [7, "宇宙之锤"],
  [1, "海盗帽"], [1, "宇航员头盔"], [5, "飞行员夹克"], [5, "黄金铠甲"],
  [15, "天使之翼"], [15, "蝙蝠之翼"], [11, "生命药水"], [11, "强化石"],
  [10, "传送"], [10, "三连发"], [9, "风之戒"], [14, "红宝石项链"],
];

function seeds(): Record<string, Row[]> {
  const now = Date.now();
  return {
    players: Array.from({ length: 64 }, (_, i) => ({
      UserID: 1000 + i,
      NickName: `${NICKS[i % NICKS.length]}${i >= NICKS.length ? i : ""}`,
      UserName: `conta${i + 1}`,
      State: rand() > 0.6 ? 1 : 0,
      Grade: int(1, 60),
      GP: int(0, 900_000),
      Gold: int(0, 2_000_000),
      Money: int(0, 50_000),
      GiftToken: int(0, 5_000),
      Medal: int(0, 500),
      Offer: int(0, 20_000),
      FightPower: int(500, 30_000),
      ForbidDate: i % 17 === 5 ? new Date(now + 2 * DAY).toISOString() : null,
      ForbidReason: i % 17 === 5 ? "使用非法程序" : "",
      LastDate: new Date(now - int(0, 30) * DAY).toISOString(),
    })),
    items: ITEM_NAMES.map(([cat, name], i) => ({
      TemplateID: 7000 + i * 10,
      Name: name,
      Pic: `e${String(i + 1).padStart(2, "0")}`,
      CategoryID: cat,
      Quality: int(1, 5),
      NeedSex: 0,
      Price: int(1, 50) * 100,
      Description: "",
      Remark: "",
      NeedLevel: int(1, 40),
      Level: 1,
      Attack: cat === 7 ? int(50, 400) : 0,
      Defence: cat === 5 || cat === 1 ? int(20, 200) : 0,
      Agility: int(0, 60),
      Luck: int(0, 60),
      MaxCount: cat === 11 ? 99 : 1,
      SuitId: 0,
      Hole: "",
      Data: "",
      CanEquip: cat !== 11 && cat !== 10,
      CanUse: cat === 11,
      CanDrop: true,
      CanDelete: true,
      CanStrengthen: cat === 7,
      CanCompose: cat === 7,
      BindType: 0,
      FusionType: 0,
      RefineryLevel: 0,
      Script: "",
    })),
    bots: ["Robô Rabugento", "Capitão Pólvora", "Sargento Vento", "Dama do Canhão", "Professor Parábola", "Tia Bomba"].map((nickname, i) => ({
      id: i + 1,
      nickname,
      sex: i % 2 ? "f" : "m",
      level: 5 + i * 9,
      difficulty: (["easy", "normal", "hard", "expert"] as const)[i % 4],
      weaponTemplateId: 7000 + (i % 4) * 10,
      equips: ["7040", "7060"],
      guild: i % 3 ? "Liga dos Bots" : "",
      enabled: i !== 4,
    })),
    texts: [
      ["ddt.game.start", "ddt.game", "Começar", "Start"],
      ["ddt.game.ready", "ddt.game", "Pronto", "Ready"],
      ["ddt.game.wind", "ddt.game", "Vento", "Wind"],
      ["ddt.room.create", "ddt.room", "Criar sala", "Create room"],
      ["ddt.room.quickJoin", "ddt.room", "Entrada rápida", "Quick join"],
      ["ddt.shop.buy", "ddt.shop", "Comprar", "Buy"],
      ["ddt.shop.notEnoughMoney", "ddt.shop", "Cupons insuficientes", "Not enough coupons"],
      ["ddt.bag.title", "ddt.bag", "Mochila", "Bag"],
      ["ddt.guild.title", "ddt.guild", "Guilda", "Guild"],
      ["ddt.pve.hero", "ddt.pve", "Herói", "Hero"],
    ].map(([key, group, ptBR, en]) => ({ key, group, ptBR, en })),
    news: [
      { id: 3, title: "活动：强风周", category: "event", summary: "风力超过 3 的对局可额外获得宝箱。", publishedAt: new Date(now - 3 * DAY).toISOString(), published: true },
      { id: 2, title: "新副本：蚂蚁之巢", category: "update", summary: "20 级起可进入的四人副本。", publishedAt: new Date(now - 11 * DAY).toISOString(), published: true },
      { id: 1, title: "维护公告", category: "maintenance", summary: "周四 04:00 至 06:00。", publishedAt: new Date(now - 16 * DAY).toISOString(), published: true },
    ].map((n) => ({ cover: "", body: "", ...n })),
    events: [
      ["周末双倍经验", -2, 3],
      ["金币雨", 5, 2],
      ["抛物线锦标赛", 12, 1],
      ["蚂蚁副本掉落", -12, 7],
      ["本月每日登录", 0, 28],
    ].map(([Title, start, len], i) => ({
      ActiveID: i + 1,
      Title,
      Type: i % 4,
      ActiveType: 0,
      IconID: 0,
      StartDate: new Date(now + Number(start) * DAY).toISOString(),
      EndDate: new Date(now + (Number(start) + Number(len)) * DAY).toISOString(),
      Description: "",
      Content: "",
      AwardContent: "",
      ActionTimeContent: "",
      HasKey: 0,
      IsOnly: 0,
      IsAdvance: false,
      IsShow: i !== 2,
    })),
    dungeons: [
      ["蚂蚁之巢", 20], ["鸡王城堡", 30], ["寒冰堡垒", 40], ["失落神殿", 50],
    ].map(([Name, lvl], i) => ({
      ID: 1 + i,
      Name,
      Type: 0,
      LevelLimits: lvl,
      Ordering: i,
      Pic: "",
      Description: "",
      AdviceTips: "",
      BossFightNeedMoney: "",
      LastFloor: "",
      SimpleTemplateIds: `${1100 + i * 10}`,
      SimpleGameScript: `GameServerScript.AI.Game.Pve${i + 1}Simple`,
      NormalTemplateIds: `${1101 + i * 10}`,
      NormalGameScript: `GameServerScript.AI.Game.Pve${i + 1}Normal`,
      HardTemplateIds: `${1102 + i * 10}`,
      HardGameScript: `GameServerScript.AI.Game.Pve${i + 1}Hard`,
      TerrorTemplateIds: `${1103 + i * 10}`,
      TerrorGameScript: `GameServerScript.AI.Game.Pve${i + 1}Terror`,
    })),
    logs: Array.from({ length: 120 }, (_, i) => ({
      id: i + 1,
      at: new Date(now - i * 7 * 60_000).toISOString(),
      level: i % 13 === 0 ? "error" : i % 5 === 0 ? "warn" : "info",
      category: pick(["auth", "shop", "admin", "game", "mail"]),
      actor: pick(["sistema", "admin", ...NICKS]),
      message: pick(["登录成功", "商城购买", "配置已修改", "房间已创建", "邮件已发送", "TCP 连接失败"]),
    })),
    "admin-users": [
      { id: 1, username: "admin", email: "admin@example.com", role: "admin", active: true, lastLoginAt: new Date(now).toISOString() },
      { id: 2, username: "gm", email: "gm@example.com", role: "gm", active: true, lastLoginAt: new Date(now - DAY).toISOString() },
    ],
    "mail-broadcasts": [],
  };
}

export const tables = new Map<string, Row[]>();
{
  const s = seeds();
  for (const def of resources) {
    tables.set(def.name, s[def.name] ?? Array.from({ length: 25 }, (_, i) => autoRow(def, i)));
  }
  const items = tables.get("items")!;
  tables.set(
    "shop",
    items.slice(0, 12).map((it, i) => ({
      ID: i + 1,
      ShopID: 1 + (i % 4),
      GroupID: 0,
      TemplateID: it.TemplateID,
      BuyType: i % 3 ? 0 : 1,
      AUnit: int(1, 50) * 100,
      BUnit: 0,
      CUnit: 0,
      Beat: 1,
      Label: 0,
      Sort: i,
      LimitCount: -1,
      LimitGrade: 0,
      StartDate: new Date(Date.now() - 30 * DAY).toISOString(),
      EndDate: new Date(Date.now() + 365 * DAY).toISOString(),
      IsContinue: true,
      IsBind: false,
      IsVouch: i < 3,
      IsCheap: i % 4 === 0,
      CanBuy: i % 5 !== 0,
    })),
  );
}

export const nextId = (rows: Row[], idField: string | string[]) =>
  rows.reduce((m, r) => Math.max(m, Number(r[Array.isArray(idField) ? idField[0]! : idField]) || 0), 0) + 1;
