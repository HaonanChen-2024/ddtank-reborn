import { z } from "zod";
import { idFields, type FieldDef, type ResourceDef, type Row } from "./types";

type Tr = (key: "field.required" | "field.min" | "field.max" | "field.maxLength" | "field.int" | "field.number" | "field.json" | "field.option" | "field.invalid", vars?: Record<string, string | number>) => string;
type TextFn = (x: FieldDef["patternMessage"]) => string;

export type FormMode = "create" | "edit";

/** Preserve the template's other columns while requiring a new primary key. */
export function copyForCreate(def: ResourceDef, row: Row): Row {
  const copy = { ...row };
  for (const key of idFields(def)) delete copy[key];
  return copy;
}

export function fieldInForm(f: FieldDef, mode: FormMode): boolean {
  if (f.form === undefined || f.form === true) return true;
  if (f.form === false) return false;
  return f.form === mode;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (typeof v === "number" && Number.isNaN(v));

function fieldSchema(f: FieldDef, mode: FormMode, t: Tr, text: TextFn): z.ZodType {
  const req = f.required && !f.readOnly;
  switch (f.type) {
    case "number": {
      let n = z.number({ error: t("field.number") });
      if (f.int !== false) n = n.int(t("field.int"));
      if (f.min !== undefined) n = n.min(f.min, t("field.min", { min: f.min }));
      if (f.max !== undefined) n = n.max(f.max, t("field.max", { max: f.max }));
      return z.preprocess(
        (v) => (isEmpty(v) ? null : typeof v === "string" ? Number(v) : v),
        req ? n.nullable().refine((v) => v !== null, t("field.required")) : n.nullable(),
      );
    }
    case "boolean":
      return z.boolean({ error: t("field.invalid") });
    case "select": {
      const values = (f.options ?? []).map((o) => o.value);
      return z.preprocess(
        (v) => {
          if (isEmpty(v)) return null;
          const hit = values.find((x) => String(x) === String(v));
          return hit === undefined ? v : hit;
        },
        z
          .any()
          .refine((v) => (v === null ? !req : values.includes(v as never)), { message: req ? t("field.required") : t("field.option") }),
      );
    }
    case "tags": {
      const arr = z.array(z.string({ error: t("field.invalid") }), { error: t("field.invalid") });
      return req ? arr.min(1, t("field.required")) : arr;
    }
    case "json":
      return z.string({ error: t("field.invalid") }).refine(
        (s) => {
          if (!s.trim()) return !req;
          try {
            JSON.parse(s);
            return true;
          } catch {
            return false;
          }
        },
        { message: t("field.json") },
      );
    case "password": {
      // On edit, blank means "keep current password".
      const s = z.string({ error: t("field.invalid") });
      if (mode === "edit" || !req) return s;
      return s.min(1, t("field.required"));
    }
    default: {
      let s = z.string({ error: t("field.invalid") });
      if (f.maxLength) s = s.max(f.maxLength, t("field.maxLength", { max: f.maxLength }));
      if (f.pattern) {
        const p = f.pattern;
        return z.preprocess(
          (v) => (v == null ? "" : v),
          req
            ? s.min(1, t("field.required")).regex(p, text(f.patternMessage) || t("field.invalid"))
            : s.refine((v) => v === "" || p.test(v), text(f.patternMessage) || t("field.invalid")),
        );
      }
      return z.preprocess((v) => (v == null ? "" : v), req ? s.min(1, t("field.required")) : s);
    }
  }
}

/** Build a zod object schema from field definitions. */
export function buildSchema(fields: FieldDef[], mode: FormMode, t: Tr, text: TextFn) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    if (!fieldInForm(f, mode) || f.readOnly) continue;
    shape[f.name] = fieldSchema(f, mode, t, text);
  }
  return z.object(shape);
}

const pad = (n: number) => String(n).padStart(2, "0");
function toLocalInput(v: unknown, withTime: boolean): string {
  if (!v) return "";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

export function defaultFor(f: FieldDef): unknown {
  if (f.default !== undefined) return f.default;
  switch (f.type) {
    case "boolean":
      return false;
    case "tags":
      return [];
    case "number":
      return null;
    case "select":
      return f.required ? (f.options?.[0]?.value ?? null) : null;
    default:
      return "";
  }
}

/** API row -> form values (dates to input format, json to text...). */
export function toFormValues(fields: FieldDef[], row: Row | undefined, mode: FormMode): Row {
  const out: Row = {};
  for (const f of fields) {
    if (!fieldInForm(f, mode)) continue;
    const v = row?.[f.name];
    if (v === undefined || (mode === "create" && row === undefined)) {
      out[f.name] = f.type === "json" ? (f.default !== undefined ? JSON.stringify(f.default, null, 2) : "") : defaultFor(f);
      continue;
    }
    switch (f.type) {
      case "json":
        out[f.name] = v === null || v === undefined ? "" : JSON.stringify(v, null, 2);
        break;
      case "date":
        out[f.name] = toLocalInput(v, false);
        break;
      case "datetime":
        out[f.name] = toLocalInput(v, true);
        break;
      case "password":
        out[f.name] = "";
        break;
      case "tags":
        out[f.name] = Array.isArray(v) ? v.map(String) : [];
        break;
      default:
        out[f.name] = v ?? defaultFor(f);
    }
  }
  return out;
}

/** Parsed form values -> API payload. */
export function fromFormValues(fields: FieldDef[], values: Row, mode: FormMode): Row {
  const out: Row = {};
  for (const f of fields) {
    if (!fieldInForm(f, mode) || f.readOnly || !(f.name in values)) continue;
    const v = values[f.name];
    switch (f.type) {
      case "json":
        out[f.name] = typeof v === "string" && v.trim() ? JSON.parse(v) : null;
        break;
      case "datetime":
        out[f.name] = v ? new Date(String(v)).toISOString() : null;
        break;
      case "password":
        if (v) out[f.name] = v;
        break;
      default:
        out[f.name] = v;
    }
  }
  return out;
}
