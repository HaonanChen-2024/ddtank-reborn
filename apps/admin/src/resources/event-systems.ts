import { CalendarClock, Gift, KeyRound, Ticket, Timer } from "lucide-react";
import { defineResource } from "@/crud/types";

// Tables behind the event systems driven by apps/game (handlers/events.ts). Every write here makes apps/api POST
// /reload-templates on the game internal channel, so the game picks the change up without a restart.

const KINDS = [
  { value: "worldboss", label: "Boss mundial", tone: "coral" as const },
  { value: "league", label: "Liga (Chiến thần)", tone: "grape" as const },
  { value: "elite", label: "Campeonato de elite", tone: "sky" as const },
  { value: "weekly_reset", label: "Reset semanal", tone: "neutral" as const },
  { value: "double_exp", label: "EXP em dobro", tone: "mint" as const },
  { value: "double_gold", label: "Ouro em dobro", tone: "sun" as const },
  { value: "chickenbox", label: "Rương Vua Gà (chicken box)", tone: "sun" as const },
  { value: "luckystar", label: "Lucky Star", tone: "grape" as const },
  { value: "labyrinth", label: "Mê cung (labyrinth)", tone: "coral" as const },
];

export const scheduledEvents = defineResource({
  name: "scheduled-events",
  table: 'app."ScheduledEvents"',
  label: { "pt-BR": "Eventos agendados", en: "Scheduled events" },
  singular: { "pt-BR": "agendamento", en: "schedule" },
  icon: CalendarClock,
  group: "content",
  hidden: true,
  idField: "id",
  titleField: "title",
  defaultSort: "id",
  fields: [
    { name: "id", label: "ID", type: "number", list: true, form: false },
    { name: "kind", label: "Tipo", type: "select", required: true, options: KINDS, list: true },
    { name: "title", label: "Título", type: "text", list: true, span: 2 },
    { name: "enabled", label: "Ativo", type: "boolean", default: true, list: true, inlineToggle: true },
    { name: "weekdays", label: "Dias (0=dom … 6=sáb)", type: "text", default: "0,1,2,3,4,5,6", list: true, pattern: /^[0-6](,[0-6])*$/, patternMessage: "Ex.: 0,6" },
    { name: "startTime", label: "Início (UTC, HH:MM)", type: "text", default: "20:00", list: true, pattern: /^\d{2}:\d{2}$/, patternMessage: "HH:MM" },
    { name: "durationMin", label: "Duração (min)", type: "number", min: 1, max: 10080, default: 60, list: true },
    { name: "startDate", label: "Válido a partir de", type: "datetime" },
    { name: "endDate", label: "Válido até", type: "datetime" },
    { name: "params", label: "Parâmetros (JSON)", type: "json", span: 2, hint: 'worldboss: {"bossHp":20000000,"name":"Rồng","rankAwards":[{"rank":1,"giftToken":500}]} · double_*: {"rate":2} · league: {"maxCount":10} · chickenbox: {"pool":[{"templateId":11107,"count":500,"weight":10}],"openCardPrice":[100,200,300,500,800],"eagleEyePrice":[50,100,150,250,400],"flushPrice":500} · luckystar: {"pool":[...]} · labyrinth: {"priceBig":5000,"priceSmall":1000,"cleanOutGiftToken":100,"pricePerMin":10} — "enabled":false closes the feature without deleting the row.' },
  ],
});

export const eventAwards = defineResource({
  name: "event-awards",
  table: 'game."Active_Award"',
  label: { "pt-BR": "Prêmios de evento", en: "Event rewards" },
  singular: { "pt-BR": "prêmio", en: "reward" },
  icon: Gift,
  group: "content",
  hidden: true,
  idField: "ID",
  defaultSort: "ActiveID",
  fields: [
    { name: "ID", label: "ID", type: "number", list: true, form: false },
    { name: "ActiveID", label: "ActiveID", type: "number", required: true, list: true, sortable: true },
    { name: "ItemID", label: "Item (TemplateID)", type: "number", required: true, list: true },
    { name: "Count", label: "Quantidade", type: "number", min: 1, default: 1, list: true },
    { name: "ValidDate", label: "Validade (dias, 0 = permanente)", type: "number", min: 0, default: 0, list: true },
    { name: "Gold", label: "Ouro", type: "number", min: 0, default: 0 },
    { name: "Money", label: "Xu", type: "number", min: 0, default: 0 },
    { name: "Sex", label: "Sexo", type: "select", default: 0, options: [{ value: 0, label: "Todos" }, { value: 1, label: "Masculino" }, { value: 2, label: "Feminino" }], list: true },
    { name: "Mark", label: "Mark (lote de código)", type: "number", default: 0 },
    { name: "StrengthenLevel", label: "Fortalecimento", type: "number", default: 0 },
    { name: "AttackCompose", label: "Comp. ataque", type: "number", default: 0 },
    { name: "DefendCompose", label: "Comp. defesa", type: "number", default: 0 },
    { name: "LuckCompose", label: "Comp. sorte", type: "number", default: 0 },
    { name: "AgilityCompose", label: "Comp. agilidade", type: "number", default: 0 },
  ],
});

export const dailyAward = defineResource({
  name: "daily-award",
  table: 'game."Daily_Award"',
  label: { "pt-BR": "Presença diária", en: "Daily sign-in" },
  singular: { "pt-BR": "prêmio", en: "reward" },
  icon: Ticket,
  group: "content",
  hidden: true,
  idField: "ID",
  defaultSort: "AwardDays",
  fields: [
    { name: "ID", label: "ID", type: "number", required: true, list: true, form: "create" },
    { name: "Type", label: "Tipo", type: "select", required: true, list: true, options: [{ value: 0, label: "Login diário (buff)" }, { value: 1, label: "Presença: item" }, { value: 7, label: "Presença: lễ kim" }, { value: 6, label: "Outro (6)" }, { value: 2, label: "Outro (2)" }] },
    { name: "AwardDays", label: "Dias de presença (tier)", type: "number", min: 0, default: 0, list: true, sortable: true },
    { name: "TemplateID", label: "Item (TemplateID; -1100 = lễ kim)", type: "number", required: true, list: true },
    { name: "Count", label: "Quantidade", type: "number", min: 0, default: 1, list: true },
    { name: "ValidDate", label: "Validade (dias; tipo 0: minutos do buff)", type: "number", min: 0, default: 0 },
    { name: "IsBinds", label: "Vinculado", type: "boolean", default: true },
    { name: "Sex", label: "Sexo (0 todos)", type: "number", default: 0 },
    { name: "GetWay", label: "GetWay", type: "number", default: 0 },
    { name: "CountRemark", label: "Texto", type: "text" },
  ],
});

export const eventCodes = defineResource({
  name: "event-codes",
  table: 'player."Active_Number"',
  label: { "pt-BR": "Códigos de evento", en: "Event codes" },
  singular: { "pt-BR": "código", en: "code" },
  icon: KeyRound,
  group: "content",
  hidden: true,
  idField: "AwardID",
  defaultSort: "ActiveID",
  fields: [
    { name: "AwardID", label: "Código", type: "text", required: true, list: true, form: "create" },
    { name: "ActiveID", label: "ActiveID", type: "number", required: true, list: true, sortable: true },
    { name: "PullDown", label: "Usado", type: "boolean", list: true },
    { name: "UserID", label: "UserID", type: "number", default: 0, list: true },
    { name: "Mark", label: "Mark", type: "number", default: 0 },
    { name: "GetDate", label: "Data", type: "datetime", list: true, form: false },
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
  singular: { "pt-BR": "caixa", en: "box" },
  description: "LoadUserBox 继续提供等级和 VIP 礼包；其中旧 Type 0 数据保留兼容，但游戏在线宝箱已不再读取。",
  icon: Timer,
  group: "content",
  hidden: true,
  idField: "ID",
  defaultSort: "ID",
  fields: [
    { name: "ID", label: "ID", type: "number", required: true, list: true, form: "create" },
    { name: "Type", label: "类型", type: "select", list: true, options: [{ value: 0, label: "旧在线数据（游戏不读取）" }, { value: 1, label: "等级礼包" }, { value: 2, label: "VIP 每日礼包" }] },
    { name: "Level", label: "Nível (máx. / alvo / VIP)", type: "number", list: true },
    { name: "Condition", label: "Condição (min online / sexo)", type: "number", list: true },
    { name: "TemplateID", label: "Caixa (TemplateID)", type: "number", list: true },
  ],
});
