/**
 * pt-BR (or other) overlay for `game` schema text columns. See scripts/export-texts.ts,
 * scripts/import-translations.ts and docs/ROADMAP.md "Localização PT-BR" for how rows get in here.
 *
 * Usage at a template-load call site (apps/game/src/db/*, apps/api/src/templates/*):
 *
 *   const rows = await db.select().from(game.Game_Map);
 *   const overlay = await loadTranslations(db, "Game_Map", cfg.DEFAULT_LANG);
 *   return rows.map((r) => applyTranslations(r, "ID", overlay));
 *
 * `applyTranslations` only overwrites columns that have a translation row; everything else (stats, ids,
 * pics, flags) passes through untouched. Falls back silently to the original `game` schema value — a
 * missing overlay row is normal (either the table hasn't been translated yet, or DEFAULT_LANG is the
 * source language), never an error.
 */
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { Translations } from "./schema/app.js";

export type TranslationOverlay = Map<string, Record<string, string>>;

const PVE_TEXT_COLUMNS: Record<string, readonly string[]> = {
  Pve_Info: ["Name", "Description"],
  Mission_Info: ["Name", "Title", "Description", "Success", "Failure"],
  NPC_Info: ["Name"],
};
type PveTextOverride = { table: string; id: number; text: Record<string, string> };

const TEMPLATE_TEXT_COLUMNS: Record<string, readonly string[]> = {
  Shop_Goods: ["Name", "Description", "Remark"],
  Quest: ["Title", "Detail", "Objective"],
  Quest_Condiction: ["CondictionTitle"],
};
type TemplateTextOverride = { table: string; rowId: string; text: Record<string, string> };

/** Local item/quest display text only. Conditions use the complete QuestID:CondictionID address. */
export function parseTemplateTextOverrides(text: string): TemplateTextOverride[] {
  const value: unknown = JSON.parse(text);
  const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!object(value) || Object.keys(value).sort().join(",") !== "entries,schemaVersion" ||
      value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new Error("TEMPLATE_TEXT_OVERRIDES_FILE must contain only schemaVersion:1 and entries");
  }
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "rowId,table,text" ||
        typeof entry.table !== "string" || !Object.hasOwn(TEMPLATE_TEXT_COLUMNS, entry.table) ||
        typeof entry.rowId !== "string" || !object(entry.text) || Object.keys(entry.text).length === 0) {
      throw new Error("Invalid TEMPLATE_TEXT_OVERRIDES_FILE entry");
    }
    const ids = entry.rowId.split(":");
    if (ids.length !== (entry.table === "Quest_Condiction" ? 2 : 1) ||
        ids.some(id => !/^[1-9]\d*$/.test(id) || Number(id) > 2147483647)) {
      throw new Error(`Invalid TEMPLATE_TEXT_OVERRIDES_FILE rowId: ${entry.table}:${entry.rowId}`);
    }
    const key = `${entry.table}:${entry.rowId}`;
    if (seen.has(key)) throw new Error(`Duplicate TEMPLATE_TEXT_OVERRIDES_FILE entry: ${key}`);
    seen.add(key);
    for (const [column, displayText] of Object.entries(entry.text)) {
      if (!TEMPLATE_TEXT_COLUMNS[entry.table]!.includes(column) || typeof displayText !== "string" || !displayText.trim()) {
        throw new Error(`Invalid TEMPLATE_TEXT_OVERRIDES_FILE display column: ${key}.${column}`);
      }
    }
  }
  return value.entries as TemplateTextOverride[];
}

/** Optional local PvE display text; separate from the Shop_Goods-only name contract. */
export function parsePveTextOverrides(text: string): PveTextOverride[] {
  const value: unknown = JSON.parse(text);
  const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!object(value) || Object.keys(value).sort().join(",") !== "entries,schemaVersion" ||
      value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new Error("PVE_TEXT_OVERRIDES_FILE must contain only schemaVersion:1 and entries");
  }
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "id,table,text" ||
        typeof entry.table !== "string" || !Object.hasOwn(PVE_TEXT_COLUMNS, entry.table) ||
        typeof entry.id !== "number" || !Number.isInteger(entry.id) || entry.id < 1 || entry.id > 2147483647 ||
        !object(entry.text) || Object.keys(entry.text).length === 0) {
      throw new Error("Invalid PVE_TEXT_OVERRIDES_FILE entry");
    }
    const key = `${entry.table}:${entry.id}`;
    if (seen.has(key)) throw new Error(`Duplicate PVE_TEXT_OVERRIDES_FILE entry: ${key}`);
    seen.add(key);
    for (const [column, displayText] of Object.entries(entry.text)) {
      if (!PVE_TEXT_COLUMNS[entry.table]!.includes(column) || typeof displayText !== "string" || !displayText.trim()) {
        throw new Error(`Invalid PVE_TEXT_OVERRIDES_FILE display column: ${key}.${column}`);
      }
    }
  }
  return value.entries as PveTextOverride[];
}

/** Optional local display names, shared by API and Game. Never contains gameplay columns or writes SQL. */
export function parseItemNameOverrides(text: string): Record<string, string> {
  const value: unknown = JSON.parse(text);
  const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!object(value) || Object.keys(value).sort().join(",") !== "names,schemaVersion,table" ||
      value.schemaVersion !== 1 || value.table !== "Shop_Goods" || !object(value.names)) {
    throw new Error("ITEM_NAME_OVERRIDES_FILE must contain only schemaVersion:1, table:Shop_Goods and names");
  }
  for (const [id, name] of Object.entries(value.names)) {
    if (!/^[1-9]\d*$/.test(id) || Number(id) > 2147483647 || typeof name !== "string" || !name.trim()) {
      throw new Error(`Invalid ITEM_NAME_OVERRIDES_FILE name entry: ${id}`);
    }
  }
  return value.names as Record<string, string>;
}

/** Loads every (column -> text) translation for one `game` table + lang into memory (small per-table: tens to low thousands of rows, fine to cache in the caller for the process lifetime). */
export async function loadTranslations(db: Database, table: string, lang: string): Promise<TranslationOverlay> {
  const rows = await db
    .select({ column: Translations.column, rowId: Translations.rowId, text: Translations.text })
    .from(Translations)
    .where(and(eq(Translations.table, table), eq(Translations.lang, lang)));
  const overlay: TranslationOverlay = new Map();
  for (const r of rows) {
    let byCol = overlay.get(r.rowId);
    if (!byCol) overlay.set(r.rowId, (byCol = {}));
    byCol[r.column] = r.text;
  }
  // Explicit local override wins over the language-specific DB Name; other columns keep their old overlay.
  const file = table === "Shop_Goods" ? process.env.ITEM_NAME_OVERRIDES_FILE : undefined;
  if (file) {
    const names = parseItemNameOverrides(await readFile(file, "utf8"));
    for (const [id, Name] of Object.entries(names)) overlay.set(id, { ...overlay.get(id), Name });
  }
  const pveFile = Object.hasOwn(PVE_TEXT_COLUMNS, table) ? process.env.PVE_TEXT_OVERRIDES_FILE : undefined;
  if (pveFile) {
    for (const entry of parsePveTextOverrides(await readFile(pveFile, "utf8"))) {
      if (entry.table === table) {
        const id = String(entry.id);
        overlay.set(id, { ...overlay.get(id), ...entry.text });
      }
    }
  }
  const templateFile = Object.hasOwn(TEMPLATE_TEXT_COLUMNS, table) ? process.env.TEMPLATE_TEXT_OVERRIDES_FILE : undefined;
  if (templateFile) {
    for (const entry of parseTemplateTextOverrides(await readFile(templateFile, "utf8"))) {
      if (entry.table === table) overlay.set(entry.rowId, { ...overlay.get(entry.rowId), ...entry.text });
    }
  }
  return overlay;
}

/** Returns a shallow-copied row, addressed by one column or an explicit ordered composite key. */
export function applyTranslations<T extends Record<string, unknown>>(row: T, pkCol: keyof T | readonly (keyof T)[], overlay: TranslationOverlay): T {
  const rowId = typeof pkCol === "object" ? pkCol.map(column => String(row[column])).join(":") : String(row[pkCol]);
  const byCol = overlay.get(rowId);
  if (!byCol) return row;
  return { ...row, ...byCol };
}
