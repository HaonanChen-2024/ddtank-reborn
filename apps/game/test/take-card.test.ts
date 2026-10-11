import { describe, expect, it } from "vitest";
import { takeCardDrop } from "../src/server.js";
import { Templates } from "../src/db/templates.js";
import { GamePlayer } from "../src/game/player.js";
import { defaultMatch, defaultTexp, type PlayerInfo } from "../src/game/player-info.js";
import { ItemInfo, type ItemTemplate } from "../src/game/item.js";
import { VirtualPlayer } from "../src/bots/bot.js";

const empty = { templateId: 0, count: 0 };
function fixture(templateId: number, count: number) {
  const t = { TemplateID: templateId, Name: "Card reward", CategoryID: 11, MaxCount: 4, BindType: 1, Pic: "card" } as ItemTemplate;
  const templates = new Templates();
  templates.items.set(templateId, t);
  templates.dropConditions.push({ CondictionType: 1, Para1: ",0,", Para2: ",0,", DropID: 900 } as never);
  templates.dropItems.set(900, [{ ItemId: templateId, Random: 100, BeginData: count, EndData: count, IsBind: true, ValueDate: 7 } as never]);
  const p = new GamePlayer({ send: () => {}, disconnect: () => {}, remoteAddress: "local-test" }, {
    ID: 7, UserID: 7, Gold: 10, Money: 20, MoneyLock: 5, GiftToken: 30, GP: 1, Grade: 1, Style: "", Colors: "", Skin: "", Honor: "", Texp: defaultTexp(7, new Date()),
  } as PlayerInfo, defaultMatch(7), 1, "Local");
  return { templates, p, t };
}

describe("PvP free card reward delivery", () => {
  it.each([[-100, "Gold"], [-200, "Money"], [-300, "GiftToken"]] as const)("credits battle currency %i to %s without a pseudo-item", (id, key) => {
    const { templates, p } = fixture(id, 15000);
    const before = p.info[key];
    expect(takeCardDrop(templates, p, 0)).toEqual({ templateId: id, count: 15000 });
    expect(p.info[key] - before).toBe(15000);
    expect(p.equipBag.getItems()).toHaveLength(0);
    expect(p.propBag.getItems()).toHaveLength(0);
    expect(p.tempBag.getItems()).toHaveLength(0);
    expect(p.info.MoneyLock).toBe(5);
  });

  it("places actual item rewards into the persistent bag with MaxCount, bind and expiry", () => {
    const { templates, p } = fixture(11036, 6);
    expect(takeCardDrop(templates, p, 0)).toEqual({ templateId: 11036, count: 6 });
    expect(p.propBag.getItems().map(x => ({ template: x.TemplateID, count: x.Count, bind: x.IsBinds, days: x.ValidDate, user: x.UserID }))).toEqual([
      { template: 11036, count: 4, bind: true, days: 7, user: 7 },
      { template: 11036, count: 2, bind: true, days: 7, user: 7 },
    ]);
  });

  it("keeps the existing temporary bag fallback when the persistent bag is full", () => {
    const { templates, p } = fixture(11036, 4);
    p.propBag.capacity = 0;
    expect(takeCardDrop(templates, p, 0)).toEqual({ templateId: 11036, count: 4 });
    expect(p.tempBag.getItemCount(11036)).toBe(4);
    expect(p.propBag.getItemCount(11036)).toBe(0);
  });

  it("does not display a successful card for missing drops, unknown templates or completely full bags", () => {
    const { templates, p } = fixture(11036, 4);
    expect(takeCardDrop(templates, p, 1)).toEqual(empty);
    templates.items.delete(11036);
    expect(takeCardDrop(templates, p, 0)).toEqual(empty);
    templates.items.set(11036, { TemplateID: 11036, Name: "Card reward", CategoryID: 11, MaxCount: 4 } as ItemTemplate);
    const filler = { TemplateID: 11037, CategoryID: 11, MaxCount: 4 } as ItemTemplate;
    for (const bag of [p.propBag, p.tempBag]) for (let i = 0; i < bag.capacity; i++) bag.addItemTo(ItemInfo.createFromTemplate(filler, 4, 101), i);
    expect(takeCardDrop(templates, p, 0)).toEqual(empty);
    expect(p.propBag.getItemCount(11036) + p.tempBag.getItemCount(11036)).toBe(0);
    expect(p.info.Gold).toBe(10);
  });

  it("does not grant rewards to a bot", () => {
    const { templates } = fixture(-100, 15000);
    const bot = new VirtualPlayer({ id: 1, nickname: "Bot", sex: true, level: 1, weaponTemplateId: 7001 });
    expect(takeCardDrop(templates, bot, 0)).toEqual(empty);
  });
});
