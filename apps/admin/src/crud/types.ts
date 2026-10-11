import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Text } from "@/i18n";

export type Row = Record<string, unknown>;

export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "date"
  | "datetime"
  | "image"
  | "tags"
  | "json"
  | "password"
  | "color";

export type Tone = "sun" | "coral" | "mint" | "sky" | "grape" | "neutral";

export interface FieldOption {
  value: string | number;
  label: Text;
  tone?: Tone;
}

export interface FieldDef {
  name: string;
  label: Text;
  type: FieldType;
  required?: boolean;
  /** number: bounds; text: min length via `min` is not used (use required). */
  min?: number;
  max?: number;
  step?: number;
  /** number: integer only (default true for numbers). */
  int?: boolean;
  maxLength?: number;
  pattern?: RegExp;
  patternMessage?: Text;
  options?: FieldOption[];
  placeholder?: string;
  hint?: Text;
  default?: unknown;
  /** Shown in the form but not editable. */
  readOnly?: boolean;
  /** Where the field appears in the form. Default: both. `false` hides it. */
  form?: boolean | "create" | "edit";
  /** Column in the table. */
  list?: boolean;
  sortable?: boolean;
  /** boolean + list: render a switch in the table that PATCHes immediately. */
  inlineToggle?: boolean;
  /** Grid span in the 2-column form. */
  span?: 1 | 2;
  /** Fieldset title, used to group fields in the form. */
  section?: Text;
  /** image: upload target folder in storage. */
  uploadFolder?: string;
  /** Custom cell renderer. */
  render?: (value: unknown, row: Row) => ReactNode;
}

export interface RowAction {
  id: string;
  label: Text;
  icon?: LucideIcon;
  tone?: "danger" | "primary" | "info" | "success";
  /** POST target, relative to /api/admin/<resource>/<id>/ (e.g. "ban"). */
  path: string;
  /** Extra inputs collected in a dialog before POSTing. */
  fields?: FieldDef[];
  /** Confirmation text when there are no fields. */
  confirm?: Text;
  success?: Text;
  /** Hide the action for some rows. */
  visible?: (row: Row) => boolean;
}

export type NavGroup = "overview" | "server" | "players" | "content" | "site" | "system";

export interface ResourceDef {
  /** URL segment and REST name: /api/admin/<name>. */
  name: string;
  label: Text;
  singular: Text;
  description?: Text;
  icon: LucideIcon;
  group: NavGroup;
  /** Hide from sidebar (e.g. rendered inside a custom page). */
  hidden?: boolean;
  /** Source table in packages/db (e.g. 'game."Shop_Goods"'), for the API to expose it directly. */
  table?: string;
  /** Primary key column(s). Composite keys are joined with "~" in URLs. */
  idField: string | string[];
  /** Field used in dialog titles ("Edit <title>"). */
  titleField?: string;
  fields: FieldDef[];
  defaultSort?: string;
  pageSize?: number;
  searchPlaceholder?: Text;
  /** Enable copying a row into the create form; its primary key is cleared. */
  copyLabel?: Text;
  capabilities?: { create?: boolean; update?: boolean; delete?: boolean };
  rowActions?: RowAction[];
}

export interface ListParams {
  q?: string;
  page: number;
  pageSize: number;
  sort?: string;
}

export interface ListResult<T = Row> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const ID_SEP = "~";

/** URL-safe id of a row (composite keys joined with "~"). */
export function rowId(def: ResourceDef, row: Row): string {
  const keys = Array.isArray(def.idField) ? def.idField : [def.idField];
  return keys.map((k) => String(row[k] ?? "")).join(ID_SEP);
}

export const idFields = (def: ResourceDef): string[] => (Array.isArray(def.idField) ? def.idField : [def.idField]);

export function defineResource(def: ResourceDef): ResourceDef {
  return def;
}

export const caps = (def: ResourceDef) => ({
  create: def.capabilities?.create ?? true,
  update: def.capabilities?.update ?? true,
  delete: def.capabilities?.delete ?? true,
});
