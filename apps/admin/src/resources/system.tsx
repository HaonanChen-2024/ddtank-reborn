import { Languages, Mail, Megaphone, Newspaper, ScrollText, UserCog } from "lucide-react";
import { defineResource } from "@/crud/types";

export const texts = defineResource({
  name: "texts",
  label: { "pt-BR": "Textos e traduções", en: "Texts & translations", "zh-CN": "文本与翻译" },
  singular: { "pt-BR": "texto", en: "text", "zh-CN": "文本" },
  description: "客户端语言文本（language.txt），按键名编辑翻译。",
  icon: Languages,
  group: "server",
  idField: "key",
  titleField: "key",
  defaultSort: "key",
  pageSize: 50,
  searchPlaceholder: "按键名或文本搜索…",
  fields: [
    { name: "key", label: "键名", type: "text", required: true, list: true, sortable: true, form: "create", span: 2, render: (v) => <code className="font-mono text-xs text-sky">{String(v)}</code> },
    { name: "group", label: "分组", type: "text", list: true, sortable: true, hint: "模块前缀（例如 ddt.game）" },
    { name: "ptBR", label: "葡萄牙语（巴西）", type: "textarea", required: true, list: true },
    { name: "en", label: "英语", type: "textarea", list: true },
  ],
});

export const news = defineResource({
  name: "news",
  label: { "pt-BR": "Notícias", en: "News", "zh-CN": "公告" },
  singular: { "pt-BR": "notícia", en: "news post", "zh-CN": "公告" },
  description: "显示在网站首页的公告。",
  icon: Newspaper,
  group: "site",
  idField: "id",
  titleField: "title",
  defaultSort: "-publishedAt",
  fields: [
    { name: "id", label: "ID", type: "number", form: false },
    { name: "cover", label: "封面", type: "image", uploadFolder: "images/news" },
    { name: "title", label: "标题", type: "text", required: true, maxLength: 120, list: true, sortable: true, span: 2 },
    {
      name: "category",
      label: "分类",
      type: "select",
      required: true,
      list: true,
      options: [
        { value: "news", label: "公告", tone: "mint" },
        { value: "update", label: "更新", tone: "sky" },
        { value: "event", label: "活动", tone: "sun" },
        { value: "maintenance", label: "维护", tone: "coral" },
      ],
    },
    { name: "publishedAt", label: "发布时间", type: "datetime", required: true, list: true, sortable: true },
    { name: "summary", label: "摘要", type: "textarea", required: true, maxLength: 280 },
    { name: "body", label: "正文（Markdown）", type: "textarea" },
    { name: "published", label: "已发布", type: "boolean", default: true, list: true, inlineToggle: true },
  ],
});

export const edicts = defineResource({
  name: "edicts",
  table: 'game."Edictum_List"',
  label: { "pt-BR": "Avisos do jogo", en: "In-game notices", "zh-CN": "游戏通知" },
  singular: { "pt-BR": "aviso", en: "notice", "zh-CN": "通知" },
  description: "客户端内显示的通知（Edictum_List）。",
  icon: Megaphone,
  group: "site",
  idField: "ID",
  titleField: "Title",
  defaultSort: "-BeginDate",
  fields: [
    { name: "ID", label: "ID", type: "number", list: true, sortable: true, required: true, form: "create" },
    { name: "Title", label: "标题", type: "text", required: true, list: true, sortable: true, span: 2 },
    { name: "BeginDate", label: "开始日期", type: "datetime", required: true, list: true, sortable: true },
    { name: "BeginTime", label: "开始时间", type: "datetime", required: true },
    { name: "EndDate", label: "结束日期", type: "datetime", required: true, list: true },
    { name: "EndTime", label: "结束时间", type: "datetime", required: true },
    { name: "Text", label: "文本", type: "textarea", required: true },
    { name: "IsExist", label: "启用", type: "boolean", default: true, list: true, inlineToggle: true },
  ],
});

export const logs = defineResource({
  name: "logs",
  label: { "pt-BR": "Logs", en: "Logs", "zh-CN": "日志" },
  singular: { "pt-BR": "log", en: "log", "zh-CN": "日志" },
  description: "管理操作、交易与服务器事件记录。",
  icon: ScrollText,
  group: "overview",
  idField: "id",
  titleField: "id",
  defaultSort: "-at",
  pageSize: 50,
  capabilities: { create: false, update: false, delete: false },
  fields: [
    { name: "at", label: "时间", type: "datetime", list: true, sortable: true },
    {
      name: "level",
      label: "等级",
      type: "select",
      list: true,
      sortable: true,
      options: [
        { value: "info", label: "信息", tone: "sky" },
        { value: "warn", label: "通知", tone: "sun" },
        { value: "error", label: "错误", tone: "coral" },
      ],
    },
    { name: "category", label: "分类", type: "text", list: true, sortable: true },
    { name: "actor", label: "操作人", type: "text", list: true },
    { name: "message", label: "内容", type: "text", list: true },
  ],
});

export const adminUsers = defineResource({
  name: "admin-users",
  label: { "pt-BR": "Administradores", en: "Admin users", "zh-CN": "管理员账号" },
  singular: { "pt-BR": "administrador", en: "admin user", "zh-CN": "管理员" },
  description: "可进入管理后台的账号。",
  icon: UserCog,
  group: "system",
  idField: "id",
  titleField: "username",
  defaultSort: "username",
  fields: [
    { name: "id", label: "ID", type: "number", list: true, form: false },
    { name: "username", label: "用户名", type: "text", required: true, pattern: /^[a-z0-9_.]{3,32}$/, patternMessage: "3 至 32 个小写字母、数字、下划线或句点", list: true, sortable: true },
    { name: "email", label: "邮箱", type: "text", required: true, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, patternMessage: "邮箱格式不正确", list: true },
    {
      name: "role",
      label: "角色权限",
      type: "select",
      required: true,
      list: true,
      options: [
        { value: "admin", label: "管理员", tone: "sun" },
        { value: "gm", label: "游戏管理员", tone: "sky" },
      ],
      hint: "仅 admin 角色可以进入此后台。",
    },
    { name: "password", label: "密码", type: "password", required: true },
    { name: "active", label: "启用", type: "boolean", default: true, list: true, inlineToggle: true },
    { name: "lastLoginAt", label: "最后登录时间", type: "datetime", list: true, readOnly: true, form: "edit" },
  ],
});

export const mailBroadcasts = defineResource({
  name: "mail-broadcasts",
  label: { "pt-BR": "Envios de correio", en: "Mail sends", "zh-CN": "邮件发送记录" },
  singular: { "pt-BR": "envio", en: "send", "zh-CN": "发送记录" },
  icon: Mail,
  group: "players",
  hidden: true,
  idField: "id",
  titleField: "subject",
  defaultSort: "-sentAt",
  capabilities: { create: false, update: false, delete: false },
  fields: [
    { name: "sentAt", label: "发送时间", type: "datetime", list: true, sortable: true },
    { name: "subject", label: "主题", type: "text", list: true },
    { name: "target", label: "发送目标", type: "text", list: true },
    { name: "recipients", label: "收件人", type: "number", list: true },
    { name: "sentBy", label: "操作人", type: "text", list: true },
  ],
});
