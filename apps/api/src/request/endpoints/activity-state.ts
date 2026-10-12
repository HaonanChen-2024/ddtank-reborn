/** Authenticated post-login Calendar snapshot; never part of the shared ActiveList template cache. */
import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { q, q1 } from "../../lib/db.js";
import { result, XEl } from "../../lib/flash-xml.js";
import { item, spec, type Row } from "../../lib/spec.js";
import { SPECS } from "../../templates/defs.js";
import { define, xml, type ReqCtx } from "../types.js";
import { DailyLogList } from "./social.js";

async function calendarOwner({ app, p }: ReqCtx): Promise<number | null> {
  const raw = p("selfid") ?? "", digest = p("key") ?? "";
  if (!/^[1-9]\d*$/.test(raw) || !/^[a-fA-F0-9]{32}$/.test(digest)) return null;
  const userId = Number(raw);
  if (!Number.isSafeInteger(userId) || userId > 2147483647) return null;
  // RequestVairableCreater.creatWidthKey sends MD5(Account.Password), not the web ticket or raw GameKey.
  // Bind both the selected character and its account name; a selfid alone is never authority.
  const session = await q1<{ GameKey: string }>(app.h, sql`SELECT s."GameKey"
    FROM app."LoginSessions" s JOIN player."Sys_Users_Detail" u
      ON u."UserID" = s."UserID" AND lower(u."UserName") = s."UserName"
    WHERE s."UserID" = ${userId} AND s."Count" > 0 AND s."GameKey" IS NOT NULL
      AND s."GameKeyExpiresAt" > ${new Date()} LIMIT 1`);
  if (!session?.GameKey) return null;
  const expected = createHash("md5").update(session.GameKey, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(digest, "hex")) ? userId : null;
}

export const UserCalendar = define("/UserCalendar.ashx", async (ctx) => {
  const userId = await calendarOwner(ctx);
  if (userId === null) return xml(result(false, "游戏会话无效，请重新登录。"), true);
  return ctx.app.h.db.transaction(async (tx) => {
    const scoped: ReqCtx = { ...ctx, app: { ...ctx.app, h: { ...ctx.app.h, db: tx } } };
    // DailyLogList normalizes a stored calendar. Use the same owner lock as game signIn so its UPDATE cannot
    // overwrite a sign-in committed between the old handler's SELECT and UPDATE.
    await q(scoped.app.h, sql`SELECT "UserID" FROM player."Sys_Users_Detail" WHERE "UserID" = ${userId} FOR UPDATE`);
    // A fresh per-request value using the exact public field spec/order. No cached XML is changed.
    const rows = await q<Row>(scoped.app.h, sql`SELECT a.*, EXISTS (
      SELECT 1 FROM app."EventClaims" c
      WHERE c."UserID" = ${userId} AND c."Kind" = 'active' AND c."Key" = a."ActiveID"::text
    ) AS "Attended" FROM game."Active" a ORDER BY a."ActiveID" DESC`);
    const fields = spec(SPECS.active);
    const activities = rows.map((row) => {
      const entry = item("Item", fields, row);
      // Other modes have different code/grant/repetition rules; leave their original unknown state alone.
      if (Number(row.HasKey) === 3) entry.attr("isAttend", row.Attended === true);
      return entry;
    });
    // Keep the existing sign-in date and counters, including its monthly normalization, after identity validation.
    const daily = await DailyLogList.handle(scoped);
    if (daily.kind !== "xml" || !(daily.xml instanceof XEl) || !daily.xml.attrs.some(([k, v]) => k === "value" && v === "true")) return daily;
    daily.xml.attr("UserID", userId).add(...activities);
    return daily;
  });
}, "Local authenticated Calendar snapshot; original CalendarSignAnalyze + ActiveEventsAnalyzer contracts");
