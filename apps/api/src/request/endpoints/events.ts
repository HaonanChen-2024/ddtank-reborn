/**
 * ActivePullDown.ashx (Tank.Request/ActivePullDown.ashx.cs + Project_Player34 SP_Active_PullDown): claim the rewards of
 * a game."Active" row from the activity list (calendar window). `activeKey` = RSA(code) with the login key.
 * HasKey: 1 activation code (player."Active_Number", one per account when IsOnly=1), 2 per-user grant
 * (AwardID "<id>-2-<uid>" created by the admin), 3 every account once, 4 shared code. Rewards (game."Active_Award",
 * Sex 0/1/2 and Mark) are mailed; apps/game gets POST /mail-notice so the client reloads the mailbox.
 * Idempotent: codes are taken with a conditional UPDATE, HasKey 3 with app."EventClaims" (same table as apps/game).
 */
import { base64ToBytes, rsaDecryptPkcs1 } from "@ddt/protocol";
import { sql } from "drizzle-orm";
import { q, q1 } from "../../lib/db.js";
import { result } from "../../lib/flash-xml.js";
import { sendMail } from "../../routes/admin.js";
import { gameInternalPost } from "../../routes/public.js";
import { define, xml } from "../types.js";
import type { AppCtx } from "../../context.js";

// PlayerBussiness.PullDown messages (ActiveBussiness.Msg0..Msg10)
const MSG: Record<number, string> = {
  0: "Recebido com sucesso, os itens foram enviados ao seu correio.",
  1: "Erro desconhecido.",
  2: "O usuário não existe.",
  3: "Falha ao receber o item.",
  4: "Este código não existe, verifique novamente.",
  5: "Este código já foi resgatado e não pode ser usado de novo.",
  6: "Você já recebeu esta recompensa",
  7: "O evento ainda não começou.",
  8: "O evento já terminou.",
  10: "Você não tem permissão para receber esta recompensa.",
};

interface ActiveRow { ActiveID: number; Title: string; HasKey: number; IsOnly: number; StartDate: Date; EndDate: Date | null }
interface AwardRow {
  ItemID: number; Count: number; ValidDate: number; Gold: number; Money: number; MaxCount: number | null;
  StrengthenLevel: number; AttackCompose: number; DefendCompose: number; LuckCompose: number; AgilityCompose: number;
}
class InvalidReward extends Error {}

export async function pullDown(app: AppCtx, activeId: number, code: string, userId: number, now = new Date()): Promise<number> {
  let outcome: number;
  try {
    outcome = await app.h.db.transaction(async (tx) => {
      const txApp: AppCtx = { ...app, h: { ...app.h, db: tx } };
      const h = txApp.h;
      const a = await q1<ActiveRow>(h, sql`SELECT "ActiveID","Title","HasKey","IsOnly","StartDate","EndDate" FROM game."Active" WHERE "ActiveID" = ${activeId}`);
      if (!a) return 1;
      const start = new Date(a.StartDate), end = a.EndDate === null ? new Date(NaN) : new Date(a.EndDate);
      if (![start, end, now].every((d) => Number.isFinite(d.getTime())) || start > end) return 3;
      if (now < start) return 7;
      if (now > end) return 8;
      // Serialize one-account code checks too: distinct HasKey 1 codes must not race past IsOnly.
      const u = await q1<{ NickName: string; Sex: boolean }>(h, sql`SELECT "NickName","Sex" FROM player."Sys_Users_Detail" WHERE "UserID" = ${userId} FOR UPDATE`);
      if (!u?.NickName) return 2;
      let mark = 0;
      const take = async (awardId: string) => {
        const r = await q1<{ Mark: number }>(h, sql`UPDATE player."Active_Number" SET "PullDown" = true, "UserID" = ${userId}, "GetDate" = ${now}
          WHERE "ActiveID" = ${activeId} AND "AwardID" = ${awardId} AND "PullDown" = false RETURNING "Mark"`);
        return r;
      };
      switch (Number(a.HasKey)) {
        case 1:
        case 4: {
          if (!code) return 4;
          const n = await q1<{ PullDown: boolean }>(h, sql`SELECT "PullDown" FROM player."Active_Number" WHERE "ActiveID" = ${activeId} AND "AwardID" = ${code}`);
          if (!n) return 4;
          if (n.PullDown) return 5;
          if (Number(a.HasKey) === 1 && Number(a.IsOnly) === 1) {
            const dup = await q1(h, sql`SELECT 1 FROM player."Active_Number" WHERE "ActiveID" = ${activeId} AND "UserID" = ${userId} AND "PullDown" = true`);
            if (dup) return 6;
          }
          const r = await take(code);
          if (!r) return 5;
          mark = Number(r.Mark ?? 0);
          break;
        }
        case 2: {
          const r = await take(`${activeId}-2-${userId}`);
          if (!r) {
            const n = await q1(h, sql`SELECT 1 FROM player."Active_Number" WHERE "ActiveID" = ${activeId} AND "AwardID" = ${`${activeId}-2-${userId}`}`);
            return n ? 6 : 10;
          }
          mark = Number(r.Mark ?? 0);
          break;
        }
        case 3: {
          const r = await q(h, sql`INSERT INTO app."EventClaims" ("UserID","Kind","Key") VALUES (${userId}, 'active', ${String(activeId)}) ON CONFLICT DO NOTHING RETURNING "UserID"`);
          if (!r.length) return 6;
          break;
        }
        default:
          return 1;
      }
      const sex = u.Sex ? 1 : 2;
      const awards = await q<AwardRow>(h, sql`SELECT a."ItemID",a."Count",a."ValidDate",a."Gold",a."Money",
        a."StrengthenLevel",a."AttackCompose",a."DefendCompose",a."LuckCompose",a."AgilityCompose",g."MaxCount"
        FROM game."Active_Award" a LEFT JOIN game."Shop_Goods" g ON g."TemplateID" = a."ItemID"
        WHERE a."ActiveID" = ${activeId} AND (a."Sex" = ${sex} OR a."Sex" = 0) AND a."Mark" = ${mark} ORDER BY a."ID"`);
      const unsignedInt = (n: number) => Number.isInteger(n) && n >= 0 && n <= 2147483647;
      if (!awards.length || awards.some((x) =>
        !Number.isInteger(x.ItemID) || ![x.Count, x.ValidDate, x.Gold, x.Money].every(unsignedInt) ||
        (x.ItemID !== 0 && (!unsignedInt(x.MaxCount ?? 0) || x.MaxCount === null || x.MaxCount < 1)) ||
        (x.ItemID > 0 && x.Count < 1) ||
        (x.ItemID < 0 && (x.Count !== 0 || x.ValidDate !== 0)) ||
        [x.StrengthenLevel, x.AttackCompose, x.DefendCompose, x.LuckCompose, x.AgilityCompose].some((n) => n !== 0)
      )) throw new InvalidReward("Activity reward cannot be delivered without changing its definition");
      // Preserve SP_Active_PullDown's MaxCount split; sendMail itself only accepts five ordinary attachments.
      const items = awards.filter((x) => x.ItemID > 0);
      const gold = awards.reduce((s, x) => s + x.Gold, 0);
      const money = awards.reduce((s, x) => s + x.Money, 0);
      if (![gold, money].every(unsignedInt) || (!items.length && gold === 0 && money === 0)) throw new InvalidReward("Activity currency total or empty delivery is invalid");
      let attachments: { templateId: number; count: number; validDays: number }[] = [];
      let firstMail = true;
      const sendBatch = async () => {
        await sendMail(txApp, userId, u.NickName, a.Title || "Evento", `Prêmio do evento ${a.Title}`, { items: attachments, gold: firstMail ? gold : 0, money: firstMail ? money : 0 });
        attachments = [];
        firstMail = false;
      };
      for (const item of items) {
        for (let remaining = item.Count; remaining > 0;) {
          const count = Math.min(remaining, item.MaxCount!);
          attachments.push({ templateId: item.ItemID, count, validDays: item.ValidDate });
          remaining -= count;
          if (attachments.length === 5) await sendBatch();
        }
      }
      if (attachments.length || firstMail) await sendBatch();
      return 0;
    });
  } catch (e) {
    if (e instanceof InvalidReward) return 3;
    throw e;
  }
  if (outcome === 0) await gameInternalPost(app, "/mail-notice", { userId });
  return outcome;
}

export const ActivePullDown = define("/ActivePullDown.ashx", async ({ app, int, p }) => {
  let value = false;
  let message = "ActivePullDownHandler.Fail";
  try {
    const raw = p("activeKey") ?? "";
    let code = "";
    if (raw && app.rsa) {
      try {
        code = new TextDecoder().decode(rsaDecryptPkcs1(app.rsa, base64ToBytes(raw))).trim();
      } catch {
        code = "";
      }
    }
    const r = await pullDown(app, int("activeID"), code, int("selfid"));
    message = MSG[r] ?? MSG[1]!;
    // the original answered value=true whenever the proc ran, so the client marked the activity "attended" even
    // after "code does not exist": here only a successful claim sets it
    value = r === 0;
  } catch {
    /* Fail like the original catch */
  }
  return xml(result(value, message));
}, "Tank.Request/ActivePullDown.ashx.cs");
