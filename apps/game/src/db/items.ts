/**
 * Item persistence — SP_Users_BagByType (load), SP_Users_Items_Add (insert, returns ItemID), SP_Users_Items_Update.
 * PlayerInventory.SaveToDatabase writes only dirty items (+ the removed list) — same here.
 */
import { and, eq } from "drizzle-orm";
import { player, type Database } from "@ddt/db";
import { ItemInfo, type GoodsRow, type ItemTemplate } from "../game/item.js";

const G = player.Sys_Users_Goods;

/** All live items of a user grouped by BagType (one query instead of one SP_Users_BagByType per bag). */
export async function loadUserItems(db: Database, userId: number, findTemplate: (id: number) => ItemTemplate | undefined,
  findGoldTemplate?: (id: number) => ItemTemplate | undefined): Promise<Map<number, ItemInfo[]>> {
  const rows = (await db.select().from(G).where(and(eq(G.UserID, userId), eq(G.IsExist, true)))) as GoodsRow[];
  const out = new Map<number, ItemInfo[]>();
  for (const r of rows) {
    const t = findTemplate(r.TemplateID);
    if (!t) continue; // ItemInfo without template is skipped by the C# (Template == null)
    const list = out.get(r.BagType) ?? [];
    list.push(ItemInfo.fromRow(r, t, t.CategoryID === 7 ? findGoldTemplate?.(r.TemplateID) ?? null : null));
    out.set(r.BagType, list);
  }
  for (const l of out.values()) l.sort((a, b) => a.Place - b.Place);
  return out;
}

/** PlayerBussiness.GetUserEuqip: EquipBag places < 31 of an offline player. */
export async function loadEquippedItems(db: Database, userId: number, findTemplate: (id: number) => ItemTemplate | undefined,
  findGoldTemplate?: (id: number) => ItemTemplate | undefined): Promise<ItemInfo[]> {
  const all = await loadUserItems(db, userId, findTemplate, findGoldTemplate);
  return (all.get(0) ?? []).filter((i) => i.Place >= 0 && i.Place < 31);
}

/** AddGoods / UpdateGoods. Inserts set item.ItemID. */
export async function saveItem(db: Database, item: ItemInfo): Promise<void> {
  const { ItemID: _id, ...row } = item.toRow();
  if (item.ItemID > 0) await db.update(G).set(row).where(eq(G.ItemID, item.ItemID));
  else item.ItemID = (await db.insert(G).values(row).returning({ ItemID: G.ItemID }))[0]!.ItemID;
  item.isDirty = false;
}
