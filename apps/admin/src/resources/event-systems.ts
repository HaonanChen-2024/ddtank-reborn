import { CalendarClock, Gift, KeyRound, Ticket, Timer } from "lucide-react";
import { defineResource } from "@/crud/types";

// Tables behind the event systems driven by apps/game (handlers/events.ts). Every write here makes apps/api POST
// /reload-templates on the game internal channel, so the game picks the change up without a restart.

const KINDS = [
  { value: "worldboss", label: "世界首领", tone: "coral" as const },
  { value: "league", label: "战神联赛", tone: "grape" as const },
  { value: "elite", label: "精英赛", tone: "sky" as const },
  { value: "weekly_reset", label: "每周重置", tone: "neutral" as const },
  { value: "double_exp", label: "双倍经验", tone: "mint" as const },
  { value: "double_gold", label: "双倍金币", tone: "sun" as const },
  { value: "chickenbox", label: "小鸡宝箱", tone: "sun" as const },
  { value: "luckystar", label: "幸运星", tone: "grape" as const },
  { value: "labyrinth", label: "迷宫", tone: "coral" as const },
];

export const scheduledEvents = defineResource({
  name: "scheduled-events",
  table: 'app."ScheduledEvents"',
  label: { "pt-BR": "Eventos agendados", en: "Scheduled events", "zh-CN": "活动计划" },
  singular: { "pt-BR": "agendamento", en: "schedule", "zh-CN": "计划" },
  icon: CalendarClock,
  group: "content",
  hidden: true,
  idField: "id",
  titleField: "title",
  defaultSort: "id",
  fields: [
    { name: "id", label: "ID", type: "number", list: true, form: false },
    { name: "kind", label: "类型", type: "select", required: true, options: KINDS, list: true },
    { name: "title", label: "标题", type: "text", list: true, span: 2 },
    { name: "enabled", label: "启用", type: "boolean", default: true, list: true, inlineToggle: true },
    { name: "weekdays", label: "星期（0 为周日，6 为周六）", type: "text", default: "0,1,2,3,4,5,6", list: true, pattern: /^[0-6](,[0-6])*$/, patternMessage: "例如：0,6" },
    { name: "startTime", label: "开始时间（协调世界时，HH:MM）", type: "text", default: "20:00", list: true, pattern: /^\d{2}:\d{2}$/, patternMessage: "HH:MM" },
    { name: "durationMin", label: "时长（分钟）", type: "number", min: 1, max: 10080, default: 60, list: true },
    { name: "startDate", label: "生效时间", type: "datetime" },
    { name: "endDate", label: "失效时间", type: "datetime" },
    { name: "params", label: "参数（JSON）", type: "json", span: 2, hint: 'worldboss: {"bossHp":20000000,"name":"巨龙","rankAwards":[{"rank":1,"giftToken":500}]} · double_*: {"rate":2} · league: {"maxCount":10} · chickenbox: {"pool":[{"templateId":11107,"count":500,"weight":10}],"openCardPrice":[100,200,300,500,800],"eagleEyePrice":[50,100,150,250,400],"flushPrice":500} · luckystar: {"pool":[...]} · labyrinth: {"priceBig":5000,"priceSmall":1000,"cleanOutGiftToken":100,"pricePerMin":10} — "enabled":false 表示关闭功能并保留该记录。' },
  ],
});

export const eventAwards = defineResource({
  name: "event-awards",
  table: 'game."Active_Award"',
  label: { "pt-BR": "Prêmios de evento", en: "Event rewards", "zh-CN": "活动奖励" },
  singular: { "pt-BR": "prêmio", en: "reward", "zh-CN": "奖励" },
  icon: Gift,
  group: "content",
  hidden: true,
  idField: "ID",
  defaultSort: "ActiveID",
  fields: [
    { name: "ID", label: "ID", type: "number", list: true, form: false },
    { name: "ActiveID", label: "ActiveID", type: "number", required: true, list: true, sortable: true },
    { name: "ItemID", label: "物品（TemplateID）", type: "number", required: true, list: true },
    { name: "Count", label: "数量", type: "number", min: 1, default: 1, list: true },
    { name: "ValidDate", label: "有效期（天，0 表示永久）", type: "number", min: 0, default: 0, list: true },
    { name: "Gold", label: "金币", type: "number", min: 0, default: 0 },
    { name: "Money", label: "点券", type: "number", min: 0, default: 0 },
    { name: "Sex", label: "性别", type: "select", default: 0, options: [{ value: 0, label: "全部" }, { value: 1, label: "男" }, { value: 2, label: "女" }], list: true },
    { name: "Mark", label: "兑换码批次（Mark）", type: "number", default: 0 },
    { name: "StrengthenLevel", label: "强化等级", type: "number", default: 0 },
    { name: "AttackCompose", label: "合成攻击", type: "number", default: 0 },
    { name: "DefendCompose", label: "合成防御", type: "number", default: 0 },
    { name: "LuckCompose", label: "合成幸运", type: "number", default: 0 },
    { name: "AgilityCompose", label: "合成敏捷", type: "number", default: 0 },
  ],
});

export const dailyAward = defineResource({
  name: "daily-award",
  table: 'game."Daily_Award"',
  label: { "pt-BR": "Presença diária", en: "Daily sign-in", "zh-CN": "每日签到" },
  singular: { "pt-BR": "prêmio", en: "reward", "zh-CN": "奖励" },
  icon: Ticket,
  group: "content",
  hidden: true,
  idField: "ID",
  defaultSort: "AwardDays",
  fields: [
    { name: "ID", label: "ID", type: "number", required: true, list: true, form: "create" },
    { name: "Type", label: "类型", type: "select", required: true, list: true, options: [{ value: 0, label: "每日登录增益" }, { value: 1, label: "签到：物品" }, { value: 7, label: "签到：绑定点券" }, { value: 6, label: "其他（6）" }, { value: 2, label: "其他（2）" }] },
    { name: "AwardDays", label: "签到天数（档位）", type: "number", min: 0, default: 0, list: true, sortable: true },
    { name: "TemplateID", label: "物品（TemplateID；-1100 为绑定点券）", type: "number", required: true, list: true },
    { name: "Count", label: "数量", type: "number", min: 0, default: 1, list: true },
    { name: "ValidDate", label: "有效期（天；类型 0 为增益分钟数）", type: "number", min: 0, default: 0 },
    { name: "IsBinds", label: "绑定", type: "boolean", default: true },
    { name: "Sex", label: "性别（0 为全部）", type: "number", default: 0 },
    { name: "GetWay", label: "GetWay", type: "number", default: 0 },
    { name: "CountRemark", label: "文本", type: "text" },
  ],
});

export const eventCodes = defineResource({
  name: "event-codes",
  table: 'player."Active_Number"',
  label: { "pt-BR": "Códigos de evento", en: "Event codes", "zh-CN": "活动兑换码" },
  singular: { "pt-BR": "código", en: "code", "zh-CN": "兑换码" },
  icon: KeyRound,
  group: "content",
  hidden: true,
  idField: "AwardID",
  defaultSort: "ActiveID",
  fields: [
    { name: "AwardID", label: "兑换码", type: "text", required: true, list: true, form: "create" },
    { name: "ActiveID", label: "ActiveID", type: "number", required: true, list: true, sortable: true },
    { name: "PullDown", label: "已使用", type: "boolean", list: true },
    { name: "UserID", label: "UserID", type: "number", default: 0, list: true },
    { name: "Mark", label: "Mark", type: "number", default: 0 },
    { name: "GetDate", label: "日期", type: "datetime", list: true, form: false },
  ],
});

export const onlineBoxes = defineResource({
  name: "online-box",
  table: 'game."User_Box"',
  label: { "zh-CN": "在线宝箱（只读）", "pt-BR": "Caixas online (somente leitura)", en: "Online boxes (read only)" },
  singular: { "zh-CN": "在线宝箱", "pt-BR": "caixa", en: "box" },
  description: "在线奖励读取 User_Box 的 Type 0。原客户端固定四档等待时间为 15/40/60/75 分钟，暂不支持管理页修改。",
  icon: Timer,
  group: "content",
  hidden: true,
  idField: "ID",
  defaultSort: "ID",
  capabilities: { create: false, update: false, delete: false },
  fields: [
    { name: "ID", label: "档位 ID", type: "number", list: true, sortable: true },
    { name: "Type", label: "类型", type: "select", list: true, options: [{ value: 0, label: "在线宝箱" }] },
    { name: "Level", label: "服务端等级上限", type: "number", list: true },
    { name: "Condition", label: "本档等待时间（分钟）", type: "number", list: true, sortable: true },
    { name: "TemplateID", label: "奖励箱 TemplateID", type: "number", list: true },
  ],
});

export const timeBoxes = defineResource({
  name: "time-box",
  table: 'game."LoadUserBox"',
  label: { "zh-CN": "等级/VIP与旧礼包数据", "pt-BR": "Caixas de nível/VIP e dados legados", en: "Level / VIP and legacy boxes" },
  singular: { "pt-BR": "caixa", en: "box", "zh-CN": "礼包" },
  description: "LoadUserBox 继续提供等级和 VIP 礼包；其中旧 Type 0 数据保留兼容，但游戏在线宝箱已不再读取。",
  icon: Timer,
  group: "content",
  hidden: true,
  idField: "ID",
  defaultSort: "ID",
  fields: [
    { name: "ID", label: "ID", type: "number", required: true, list: true, form: "create" },
    { name: "Type", label: "类型", type: "select", list: true, options: [{ value: 0, label: "旧在线数据（游戏不读取）" }, { value: 1, label: "等级礼包" }, { value: 2, label: "VIP 每日礼包" }] },
    { name: "Level", label: "等级（上限、目标或贵宾等级）", type: "number", list: true },
    { name: "Condition", label: "条件（在线分钟数或性别）", type: "number", list: true },
    { name: "TemplateID", label: "礼包（TemplateID）", type: "number", list: true },
  ],
});
