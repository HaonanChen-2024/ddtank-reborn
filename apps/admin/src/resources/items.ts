import { Sword } from "lucide-react";
import { defineResource, type FieldOption } from "../crud/types";

/**
 * Item templates: game."Shop_Goods" (PK TemplateID) — packages/db/src/schema/game.ts,
 * C#: vendor/DDTank41/SqlDataProvider/Data/ItemTemplateInfo.cs. Column names are kept verbatim.
 * Category labels are best-effort (full list lives in game."Shop_Goods_Categorys").
 */
export const ITEM_CATEGORIES: FieldOption[] = [
  { value: 1, label: { "pt-BR": "Chapéu", "zh-CN": "帽子" } },
  { value: 2, label: { "pt-BR": "Óculos", "zh-CN": "眼镜" } },
  { value: 3, label: { "pt-BR": "Cabelo", "zh-CN": "发型" } },
  { value: 4, label: { "pt-BR": "Olhos", "zh-CN": "脸饰" } },
  { value: 5, label: { "pt-BR": "Roupa", "zh-CN": "服装" } },
  { value: 6, label: { "pt-BR": "Rosto", "zh-CN": "表情" } },
  { value: 7, label: { "pt-BR": "Arma", "zh-CN": "武器" }, tone: "coral" },
  { value: 8, label: { "pt-BR": "Bracelete", "zh-CN": "手镯" } },
  { value: 9, label: { "pt-BR": "Anel", "zh-CN": "戒指" } },
  { value: 10, label: { "pt-BR": "Item de batalha", "zh-CN": "战斗道具" }, tone: "sky" },
  { value: 11, label: { "pt-BR": "Consumível / material", "zh-CN": "消耗品 / 材料" }, tone: "mint" },
  { value: 13, label: { "pt-BR": "Traje", "zh-CN": "套装" } },
  { value: 14, label: { "pt-BR": "Colar", "zh-CN": "项链" } },
  { value: 15, label: { "pt-BR": "Asas", "zh-CN": "翅膀" }, tone: "grape" },
  { value: 16, label: { "pt-BR": "Balão de chat", "zh-CN": "聊天气泡" } },
  { value: 17, label: { "pt-BR": "Arma secundária", "zh-CN": "副手武器" }, tone: "coral" },
];

export const QUALITY: FieldOption[] = [
  { value: 1, label: { "pt-BR": "Comum", "zh-CN": "普通" }, tone: "neutral" },
  { value: 2, label: { "pt-BR": "Incomum", "zh-CN": "优秀" }, tone: "mint" },
  { value: 3, label: { "pt-BR": "Raro", "zh-CN": "精良" }, tone: "sky" },
  { value: 4, label: { "pt-BR": "Épico", "zh-CN": "史诗" }, tone: "grape" },
  { value: 5, label: { "pt-BR": "Lendário", "zh-CN": "传说" }, tone: "sun" },
];

export const items = defineResource({
  name: "items",
  table: 'game."Shop_Goods"',
  label: { "pt-BR": "Itens", en: "Items", "zh-CN": "物品模板" },
  singular: { "pt-BR": "item", en: "item", "zh-CN": "物品" },
  description: { "pt-BR": "Modelos de itens (Shop_Goods): atributos, requisitos e regras.", "zh-CN": "物品模板 (Shop_Goods)：服装与道具的属性、使用条件及规则。" },
  icon: Sword,
  group: "content",
  idField: "TemplateID",
  titleField: "Name",
  defaultSort: "TemplateID",
  searchPlaceholder: { "pt-BR": "Buscar por nome ou TemplateID…", "zh-CN": "按名称或 TemplateID 搜索…" },
  copyLabel: { "pt-BR": "Copiar como novo item", en: "Copy as new item", "zh-CN": "复制为新物品" },
  fields: [
    { name: "TemplateID", label: "TemplateID", type: "number", required: true, list: true, sortable: true, min: 1, form: "create", section: { "pt-BR": "Geral", "zh-CN": "基础信息" } },
    { name: "Name", label: { "pt-BR": "Nome", "zh-CN": "名称" }, type: "text", required: true, maxLength: 50, list: true, sortable: true, section: { "pt-BR": "Geral", "zh-CN": "基础信息" } },
    { name: "CategoryID", label: { "pt-BR": "Categoria", "zh-CN": "类别" }, type: "select", required: true, options: ITEM_CATEGORIES, list: true, sortable: true, section: { "pt-BR": "Geral", "zh-CN": "基础信息" } },
    { name: "Quality", label: { "pt-BR": "Qualidade", "zh-CN": "品质" }, type: "select", required: true, options: QUALITY, list: true, section: { "pt-BR": "Geral", "zh-CN": "基础信息" } },
    { name: "Pic", label: { "pt-BR": "Pic (recurso)", "zh-CN": "素材编号 Pic" }, type: "text", hint: { "pt-BR": "Nome da pasta/arquivo de imagem no CDN do cliente", "zh-CN": "客户端素材目录或图片文件编号，需与实际素材路径一致" }, list: true, section: { "pt-BR": "Geral", "zh-CN": "基础信息" } },
    { name: "NeedSex", label: { "pt-BR": "Sexo", "zh-CN": "性别" }, type: "select", required: true, options: [{ value: 0, label: { "pt-BR": "Ambos", "zh-CN": "不限" } }, { value: 1, label: { "pt-BR": "Masculino", "zh-CN": "男" } }, { value: 2, label: { "pt-BR": "Feminino", "zh-CN": "女" } }], default: 0, section: { "pt-BR": "Geral", "zh-CN": "基础信息" } },
    { name: "Price", label: { "pt-BR": "Preço base", "zh-CN": "基础价格" }, type: "number", min: 0, default: 0, section: { "pt-BR": "Geral", "zh-CN": "基础信息" } },
    { name: "Description", label: { "pt-BR": "Descrição", "zh-CN": "说明" }, type: "textarea", section: { "pt-BR": "Geral", "zh-CN": "基础信息" } },
    { name: "Remark", label: { "pt-BR": "Observação", "zh-CN": "备注" }, type: "text", section: { "pt-BR": "Geral", "zh-CN": "基础信息" } },

    { name: "NeedLevel", label: { "pt-BR": "Nível mínimo", "zh-CN": "最低等级" }, type: "number", required: true, min: 0, max: 100, default: 1, list: true, sortable: true, section: { "pt-BR": "Atributos", "zh-CN": "属性" } },
    { name: "Level", label: { "pt-BR": "Nível do item", "zh-CN": "物品等级" }, type: "number", required: true, min: 0, default: 1, section: { "pt-BR": "Atributos", "zh-CN": "属性" } },
    { name: "Attack", label: { "pt-BR": "Ataque", "zh-CN": "攻击" }, type: "number", required: true, min: 0, default: 0, list: true, sortable: true, section: { "pt-BR": "Atributos", "zh-CN": "属性" } },
    { name: "Defence", label: { "pt-BR": "Defesa", "zh-CN": "防御" }, type: "number", required: true, min: 0, default: 0, list: true, sortable: true, section: { "pt-BR": "Atributos", "zh-CN": "属性" } },
    { name: "Agility", label: { "pt-BR": "Agilidade", "zh-CN": "敏捷" }, type: "number", required: true, min: 0, default: 0, section: { "pt-BR": "Atributos", "zh-CN": "属性" } },
    { name: "Luck", label: { "pt-BR": "Sorte", "zh-CN": "幸运" }, type: "number", required: true, min: 0, default: 0, section: { "pt-BR": "Atributos", "zh-CN": "属性" } },
    { name: "MaxCount", label: { "pt-BR": "Pilha máxima", "zh-CN": "最大堆叠" }, type: "number", required: true, min: 1, default: 1, section: { "pt-BR": "Atributos", "zh-CN": "属性" } },
    { name: "SuitId", label: { "pt-BR": "Conjunto (SuitId)", "zh-CN": "套装编号 (SuitId)" }, type: "number", min: 0, default: 0, section: { "pt-BR": "Atributos", "zh-CN": "属性" } },
    { name: "Hole", label: { "pt-BR": "Buracos (Hole)", "zh-CN": "孔位 (Hole)" }, type: "text", section: { "pt-BR": "Atributos", "zh-CN": "属性" } },
    { name: "Data", label: "Data", type: "text", hint: { "pt-BR": "Parâmetro específico da categoria", "zh-CN": "分类专用参数" }, section: { "pt-BR": "Atributos", "zh-CN": "属性" } },
    ...Array.from({ length: 8 }, (_, i) => ({ name: `Property${i + 1}`, label: `Property${i + 1}`, type: "number" as const, required: true, default: 0, section: { "pt-BR": "Propriedades da categoria", "zh-CN": "分类属性" } })),

    { name: "CanEquip", label: { "pt-BR": "Equipável", "zh-CN": "可装备" }, type: "boolean", section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "CanUse", label: { "pt-BR": "Usável", "zh-CN": "可使用" }, type: "boolean", section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "CanDrop", label: { "pt-BR": "Pode largar", "zh-CN": "可丢弃" }, type: "boolean", section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "CanDelete", label: { "pt-BR": "Pode excluir", "zh-CN": "可删除" }, type: "boolean", default: true, section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "CanStrengthen", label: { "pt-BR": "Pode fortalecer", "zh-CN": "可强化" }, type: "boolean", section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "CanCompose", label: { "pt-BR": "Pode compor", "zh-CN": "可合成" }, type: "boolean", section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "BindType", label: { "pt-BR": "Vínculo (BindType)", "zh-CN": "绑定类型 (BindType)" }, type: "number", required: true, min: 0, default: 0, section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "FusionType", label: "FusionType", type: "number", required: true, min: 0, default: 0, section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "FusionRate", label: "FusionRate", type: "number", required: true, default: 0, section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "FusionNeedRate", label: "FusionNeedRate", type: "number", required: true, default: 0, section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "RefineryLevel", label: "RefineryLevel", type: "number", required: true, min: -1, default: 0, section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "CanRecycle", label: "CanRecycle", type: "number", required: true, default: 0, section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "ReclaimType", label: "ReclaimType", type: "number", required: true, default: 0, section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "ReclaimValue", label: "ReclaimValue", type: "number", required: true, default: 0, section: { "pt-BR": "Regras", "zh-CN": "规则" } },
    { name: "Script", label: "Script", type: "text", hint: { "pt-BR": "Script de efeito (opcional)", "zh-CN": "效果脚本（可选）" }, section: { "pt-BR": "Regras", "zh-CN": "规则" } },
  ],
});
