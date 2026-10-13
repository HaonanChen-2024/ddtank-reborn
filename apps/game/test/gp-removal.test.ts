import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, game, migrateDb, player, seedDatabase, type DbHandle } from "@ddt/db";
import type { GSPacket } from "@ddt/protocol";
import { loadPlayerInfo } from "../src/db/characters.js";
import { Templates } from "../src/db/templates.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { testConfig } from "../src/config.js";
import { DdtFightEngine } from "../src/fight/ddt.js";
import { GameServer } from "../src/server.js";
import { testKey } from "./helpers.js";

// Isolated in-memory persistence and shipped LevelInfo; no workshop DB or login.
// The flee integration boots only its own GameServer on an ephemeral loopback port.
let h: DbHandle, seq = 0;
const templates = new Templates();
const bloodByGrade = new Map<number, number>();
beforeAll(async () => {
  h = await createDb("pglite:memory");
  await migrateDb(h);
  await seedDatabase(h, { only: ["LevelInfo"] });
  const levels = await h.db.select().from(game.LevelInfo);
  templates.levelGp = levels.map((l) => ({ grade: l.Grade, gp: l.GP })).sort((a, b) => a.grade - b.grade);
  for (const l of levels) bloodByGrade.set(l.Grade, l.Blood);
});
afterAll(async () => { await h.close(); });
const floor = (grade: number) => templates.levelGp.find((l) => l.grade === grade)!.gp;

async function fixture(grade: number, gp: number) {
  const [row] = await h.db.insert(player.Sys_Users_Detail).values({ UserName: `gp${++seq}`, NickName: `gp${seq}`, IsFirst: 1, Grade: grade, GP: gp, Gold: 321, Offer: 17 }).returning();
  const info = (await loadPlayerInfo(h.db, row!.UserID))!, sent: GSPacket[] = [];
  const p = new GamePlayer({ send: (pkt) => sent.push(pkt), disconnect: () => {}, remoteAddress: "test" }, info, defaultMatch(info.ID), 1, "test", (g) => bloodByGrade.get(g) ?? 0);
  p.gradeForGp = (value) => templates.gradeForGp(value);
  p.recalcStats();
  return { p, sent };
}
function publicGp(sent: GSPacket[]) {
  const packet = sent.find((p) => p.code === 67)!;
  packet.offset = 20;
  return packet.readInt();
}

describe("original GP removal and level retention", () => {
  it("cancels the whole cross-level penalty rather than clipping to the level floor", async () => {
    const grade = 8, gp = floor(grade) + 1, penalty = grade * 12, { p, sent } = await fixture(grade, gp);
    expect(p.removeGP(penalty)).toBe(penalty);
    expect(p.info.GP).toBe(gp);
    expect(p.info.GP).not.toBe(floor(grade));
    expect(p.info.Grade).toBe(grade);
    expect(p.info.Offer).toBe(17);
    expect(sent.map((pkt) => pkt.code)).toEqual([38, 67]);
    expect(publicGp(sent)).toBe(gp);
    await p.saveIntoDatabase(h.db);
    expect(await loadPlayerInfo(h.db, p.id)).toMatchObject({ GP: gp, Grade: grade, Gold: 321, Offer: 17 });
  });

  it("deducts normally within a level and persists the property packet's GP", async () => {
    const grade = 8, penalty = grade * 12, gp = floor(grade) + penalty + 10, { p, sent } = await fixture(grade, gp);
    expect(p.removeGP(penalty)).toBe(penalty);
    expect(p.info).toMatchObject({ GP: gp - penalty, Grade: grade, Gold: 321, Offer: 17 });
    expect(publicGp(sent)).toBe(gp - penalty);
    await p.saveIntoDatabase(h.db);
    expect(await loadPlayerInfo(h.db, p.id)).toMatchObject({ GP: gp - penalty, Grade: grade, Gold: 321, Offer: 17 });
  });

  it("allows a deduction that lands exactly on the level threshold", async () => {
    const grade = 5, penalty = grade * 12, { p } = await fixture(grade, floor(grade) + penalty);
    expect(p.removeGP(penalty)).toBe(penalty);
    expect(p.info.GP).toBe(floor(grade));
    expect(p.info.Grade).toBe(grade);
  });

  it("keeps at least one GP at level one, matching the original lower bound", async () => {
    const { p, sent } = await fixture(1, 5);
    expect(p.removeGP(12)).toBe(12);
    expect(p.info).toMatchObject({ GP: 1, Grade: 1 });
    expect(publicGp(sent)).toBe(1);
    await p.saveIntoDatabase(h.db);
    expect(await loadPlayerInfo(h.db, p.id)).toMatchObject({ GP: 1, Grade: 1 });
  });

  it.each([0, -1, NaN, Infinity])("does not change or publish GP for invalid removal %s", async (amount) => {
    const { p, sent } = await fixture(8, floor(8) + 1), before = structuredClone(p.info);
    expect(p.removeGP(amount)).toBe(0);
    expect(p.info).toEqual(before);
    expect(sent).toEqual([]);
  });

  it("uses the injected level owner rather than hardcoded thresholds", async () => {
    const { p, sent } = await fixture(3, 102);
    p.gradeForGp = (gp) => gp >= 100 ? 3 : gp >= 30 ? 2 : 1;
    expect(p.removeGP(9)).toBe(9);
    expect(p.info).toMatchObject({ GP: 102, Grade: 3 });
    expect(publicGp(sent)).toBe(102);
  });

  it("recomputes grade and outgoing HP together without restoring old missing GP or giving downgrade rewards", async () => {
    const grade = 8, gp = floor(grade) - 1, { p, sent } = await fixture(grade, gp);
    const onGradeUp = vi.fn();
    p.onGradeUp = onGradeUp;
    expect(p.info.hp).toBe(1300);
    expect(p.removeGP(grade * 12)).toBe(grade * 12);
    expect(p.info.GP).toBe(gp);
    expect(p.info.Grade).toBe(templates.gradeForGp(gp));
    expect(publicGp(sent)).toBe(gp);
    expect(p.info.hp).toBe(1200);
    expect(sent.map((pkt) => pkt.code)).toEqual([38, 67]);
    sent[1]!.offset = 20 + 11 * 4;
    expect(sent[1]!.readInt()).toBe(1200);
    expect(onGradeUp).not.toHaveBeenCalled();
    await p.saveIntoDatabase(h.db);
    expect(await loadPlayerInfo(h.db, p.id)).toMatchObject({ GP: gp, Grade: templates.gradeForGp(gp) });
  });

  it("retains the original minimum-then-refund arithmetic and refreshes a resulting grade increase", async () => {
    const { p, sent } = await fixture(2, floor(2)), onGradeUp = vi.fn();
    p.onGradeUp = onGradeUp;
    expect(p.removeGP(10000)).toBe(10000);
    expect(p.info).toMatchObject({ GP: 10001, Grade: 8, hp: 1300 });
    expect(onGradeUp).toHaveBeenCalledExactlyOnceWith(2);
    expect(publicGp(sent)).toBe(10001);
    expect(sent.map((pkt) => pkt.code)).toEqual([38, 67]);
  });

  it("the production flee callback cancels cross-level GP but independently deducts Offer and sends the notice last", async () => {
    vi.stubEnv("FIGHT_ENGINE", "ddt");
    const server = new GameServer(testConfig({ GAME_PORT: "0", BIND_HOST: "127.0.0.1", WS_ENABLED: "false", POLICY_ENABLED: "false", ADMIN_ENABLED: "false", SERVER_HEARTBEAT: "false", BOT_FALLBACK_SEC: "0", LANGUAGE_FILE: "" }), { db: h, rsaKey: testKey() });
    try {
      await server.start(); // No opts.fight override: this must use server.ts's production callback.
      expect(server.ctx.fight).toBeInstanceOf(DdtFightEngine);
      const fight = server.ctx.fight as DdtFightEngine;
      expect(fight.o.onPlayerFlee).toBeTypeOf("function");
      server.ctx.lang.set("AbstractPacketLib.SendGamePlayerLeave.Msg6", "GP={0};Offer={1}");
      const { p, sent } = await fixture(8, 9772);
      fight.o.onPlayerFlee!(p, { roomType: 0, gameType: 0 });
      expect(p.info).toMatchObject({ GP: 9772, Grade: 8, Offer: 12, Gold: 321, hp: 1300 });
      expect(sent.map((pkt) => pkt.code)).toEqual([38, 67, 38, 67, 3]);
      const publicUpdates = sent.filter((pkt) => pkt.code === 67).map((pkt) => {
        pkt.offset = 20;
        return { gp: pkt.readInt(), offer: pkt.readInt() };
      });
      expect(publicUpdates).toEqual([{ gp: 9772, offer: 17 }, { gp: 9772, offer: 12 }]);
      const notice = sent[4]!;
      notice.offset = 20;
      expect(notice.readInt()).toBe(3);
      expect(notice.readString()).toBe("GP=96;Offer=5");
      await p.saveIntoDatabase(h.db);
      expect(await loadPlayerInfo(h.db, p.id)).toMatchObject({ GP: 9772, Grade: 8, Offer: 12, Gold: 321 });
    } finally {
      await server.stop();
      vi.unstubAllEnvs();
    }
  });
});
