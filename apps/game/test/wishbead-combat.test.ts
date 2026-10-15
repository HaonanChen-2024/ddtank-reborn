import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPackedAssets } from "@ddt/fight/node";
import { GameState } from "@ddt/fight";
import { GSPacket } from "@ddt/protocol";
import { VirtualPlayer } from "../src/bots/bot.js";
import { DdtFightEngine } from "../src/fight/ddt.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch } from "../src/game/player-info.js";
import { emptyStatTables, type GoldEquipRow } from "../src/game/stats.js";

const seed = <T>(name: string): T[] => JSON.parse(gunzipSync(readFileSync(new URL(`../../../packages/db/seed/game/${name}.json.gz`, import.meta.url))).toString());
const templates = new Map(seed<ItemTemplate>("Shop_Goods").map(t => [t.TemplateID, t]));
const golds = seed<GoldEquipRow>("GoldEquipTemplateLoad");
const assets = loadPackedAssets();
const begin = new Date("2026-10-16T08:00:00Z");
const engines: DdtFightEngine[] = [];
afterEach(() => { for (const e of engines.splice(0)) for (const g of e.games.values()) g.stop(); vi.useRealTimers(); });

function player() {
  const base = new VirtualPlayer({ id: 1, nickname: "GoldBridge", sex: true, level: 20, weaponTemplateId: 70062 });
  const p = new GamePlayer({ send() {}, disconnect() {}, remoteAddress: "gold-bridge" },
    { ...base.info, ID: 1, UserID: 1, hp: 1000 }, defaultMatch(1), 1, "test");
  p.statTables = { ...emptyStatTables(id => templates.get(id)), goldEquip: id => golds.find(g => g.OldTemplateId === id) };
  const item = ItemInfo.createFromTemplate(templates.get(70062)!, 1, 0, begin);
  item.StrengthenLevel = 12; item.goldBeginTime = begin; item.goldValidDate = 3; item.isGold = true;
  item.goldTemplate = templates.get(70063)!; p.equipBag.addItemTo(item, 6);
  return { p, item };
}

function fight(p: GamePlayer) {
  const enemy = new VirtualPlayer({ id: 2, nickname: "Control", sex: false, level: 20, weaponTemplateId: 7001 });
  const e = new DdtFightEngine({ assets, manualClock: true, seed: () => 7 }); engines.push(e);
  const handle = e.startPvp({ roomId: 1, roomType: 0, gameType: 0, timeType: 3, mapId: 1001, red: [p], blue: [enemy], onStopped() {} });
  expect(handle).not.toBeNull();
  const game = e.games.get(handle!.id)!.game;
  let now = Date.now();
  for (let i = 0; i < 1000 && game.state !== GameState.Playing; i++) {
    e.tick(now += 40);
    if (game.state === GameState.Loading) for (const member of [p, enemy]) {
      const packet = new GSPacket(91); packet.writeByte(16); packet.writeInt(100);
      handle!.processData(member, GSPacket.parse(packet.encode()));
    }
  }
  expect(game.state).toBe(GameState.Playing);
  return game.players.find(x => x.spec.userId === p.id)!;
}

describe("gold weapon actual combat bridge", () => {
  it("uses the mapped weapon's actual packed projectile configuration and refinery during the valid gold period", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(begin);
    const { p, item } = player(), me = fight(p);
    expect(me.spec.weapon.templateId).toBe(70063); expect(me.spec.weapon.refineryLevel).toBe(3);
    expect(me.mainBallId).toBe(assets.ballConfigs.get(70063)!.common);
    expect(me.spBallId).toBe(assets.ballConfigs.get(70063)!.special);
    expect(me.spec.attack).toBe(488); expect(item.TemplateID).toBe(70062);
  });

  it("refreshes stale online stats before taking the next fight snapshot at the exact expiry", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(begin);
    const { p, item } = player(); expect(p.info.Attack).toBe(488);
    vi.setSystemTime(new Date(begin.getTime() + 3 * 86_400_000));
    const me = fight(p);
    expect(me.spec.weapon.templateId).toBe(70062); expect(me.spec.weapon.refineryLevel).toBe(2);
    expect(me.mainBallId).toBe(assets.ballConfigs.get(70062)!.common);
    expect(me.spec.attack).toBe(390); expect(p.info.Nimbus).toBe(3);
    expect(item.isGold).toBe(false); expect(item.TemplateID).toBe(70062);
  });

  it("has exact packed ball configurations and every referenced ball for all 275 committed weapon mappings", () => {
    const weapons = golds.filter(row => row.OldTemplateId > 0);
    expect(weapons).toHaveLength(275);
    for (const row of weapons) {
      expect(templates.has(row.OldTemplateId), `old ${row.OldTemplateId}`).toBe(true);
      expect(templates.has(row.NewTemplateId), `new ${row.NewTemplateId}`).toBe(true);
      const cfg = assets.ballConfigs.get(row.NewTemplateId);
      expect(cfg, `gold ball config ${row.NewTemplateId}`).toBeDefined();
      for (const ball of [cfg!.common, cfg!.special, cfg!.commonAddWound, cfg!.commonMultiBall]) {
        expect(assets.ball(ball), `gold ${row.NewTemplateId} ball ${ball}`).toBeDefined();
      }
    }
  });
});
