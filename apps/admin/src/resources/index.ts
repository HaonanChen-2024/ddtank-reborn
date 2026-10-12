import type { ResourceDef } from "@/crud/types";
import { items } from "./items";
import { dungeons, events, maps, missions, npcs, questConditions, questGoods, quests, shop, shopShow } from "./content";
import { dailyAward, eventAwards, eventCodes, onlineBoxes, scheduledEvents, timeBoxes } from "./event-systems";
import { bots, players } from "./players";
import { guildApplications, guildDuties, guildEvents, guildLevels, guildMembers, guilds, guildTasks } from "./guilds";
import { adminUsers, edicts, logs, mailBroadcasts, news, texts } from "./system";

/**
 * Registry of every CRUD resource. Adding a game table = add a ResourceDef and list it here;
 * it gets a route (/<name>), a sidebar entry (unless hidden) and dev mock data automatically.
 * REST contract: /api/admin/<name> (GET ?q&page&pageSize&sort=[-]field, POST), /api/admin/<name>/<id> (GET, PATCH, DELETE).
 */
const zhNames: Record<string, [string, string]> = {
  players: ["玩家", "玩家"],
  guilds: ["公会", "公会"],
  "guild-members": ["公会成员", "成员"],
  "guild-duties": ["公会职务", "职务"],
  "guild-applications": ["入会申请", "申请"],
  "guild-events": ["公会记录", "记录"],
  "guild-tasks": ["公会任务", "任务"],
  "guild-levels": ["公会等级", "等级"],
  bots: ["机器人", "机器人"],
  items: ["物品模板", "物品"],
  shop: ["商城条目", "商品"],
  "shop-show": ["商城展示", "展示记录"],
  quests: ["任务", "任务"],
  "quest-conditions": ["任务条件", "条件"],
  "quest-goods": ["任务奖励", "奖励"],
  events: ["活动模板", "活动"],
  "scheduled-events": ["活动计划", "计划"],
  "event-awards": ["活动奖励", "奖励"],
  "event-codes": ["活动兑换码", "兑换码"],
  "daily-award": ["每日签到", "签到奖励"],
  "online-box": ["在线宝箱（只读）", "在线宝箱"],
  "time-box": ["等级/VIP与旧礼包数据", "礼包"],
  dungeons: ["副本", "副本"],
  missions: ["副本关卡", "关卡"],
  npcs: ["NPC 模板", "NPC"],
  maps: ["地图", "地图"],
  texts: ["文本与翻译", "文本"],
  news: ["公告", "公告"],
  edicts: ["游戏通知", "通知"],
  logs: ["日志", "日志"],
  "admin-users": ["管理员账号", "管理员"],
  "mail-broadcasts": ["邮件发送记录", "发送记录"],
};

export const resources: ResourceDef[] = [
  players,
  guilds,
  guildMembers,
  guildDuties,
  guildApplications,
  guildEvents,
  guildTasks,
  guildLevels,
  bots,
  items,
  shop,
  shopShow,
  quests,
  questConditions,
  questGoods,
  events,
  scheduledEvents,
  eventAwards,
  eventCodes,
  dailyAward,
  onlineBoxes,
  timeBoxes,
  dungeons,
  missions,
  npcs,
  maps,
  texts,
  news,
  edicts,
  logs,
  adminUsers,
  mailBroadcasts,
].map((resource) => {
  const names = zhNames[resource.name];
  if (!names) return resource;
  return {
    ...resource,
    label: { ...(typeof resource.label === "string" ? { "pt-BR": resource.label } : resource.label), "zh-CN": names[0] },
    singular: { ...(typeof resource.singular === "string" ? { "pt-BR": resource.singular } : resource.singular), "zh-CN": names[1] },
  };
});

export const resourceByName = new Map(resources.map((r) => [r.name, r]));
export { guildApplications, guildDuties, guildEvents, guildLevels, guildMembers, guilds, guildTasks };
export { adminUsers, bots, dungeons, edicts, events, items, logs, mailBroadcasts, maps, missions, news, npcs, players, questConditions, questGoods, quests, shop, shopShow, texts };
