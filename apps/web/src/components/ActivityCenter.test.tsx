import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ api: { getToken: () => null }, meQuery: { queryKey: ["account", "me"], queryFn: () => null } }));
import { ActivityCenter } from "./ActivityCenter";

function render(id: "pair" | "wardrobe" | "mines" | "ddplay" | "gypsy" | "moon", initialCharacterId = 40) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(["account", "me"], { characters: [{ id: 40, nickname: "测试角色", level: 20 }] });
  client.setQueryData(["account", "activities", 40], {
    characterId: 40, revision: 1, points: 100, earned: 100, day: "2026-10-15", tasks: [], history: [],
    activities: [{ id, title: "本地活动", subtitle: "", rules: [], stats: [], actions: [{ label: "网页玩法", action: { type: "start" } }] }],
  });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><ActivityCenter initialCharacterId={initialCharacterId} onClose={() => {}} /></QueryClientProvider>);
  client.clear();
  return html;
}

describe("ActivityCenter native entry contract", () => {
  it("keeps the web action and offers native 32-card play as an explicit experimental button", () => {
    const html = render("pair");
    expect(html).toContain("网页玩法");
    const button = html.match(/<button[^>]*>试用原版32格翻牌<\/button>/)?.[0];
    expect(button).toBeDefined(); expect(button).not.toContain("disabled");
    expect(html).toContain("原窗口仍在测试，牌局与网页配对独立");
    expect(html).toContain("打开只读取进度");
    expect(html).not.toContain("试用原版衣橱窗口");
  });
  it("disables the native button when the selected account character is not the live game character", () => {
    const html = render("pair", 41);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>试用原版32格翻牌<\/button>/);
    expect(html).toContain("请从这个角色的游戏大厅点击");
  });
  it("retains the wardrobe entry without displaying a pair entry for unrelated activities", () => {
    const html = render("wardrobe");
    expect(html).toContain("试用原版衣橱窗口");
    expect(html).not.toContain("试用原版32格翻牌");
  });
  it("offers the original 70-cell scene without replacing the older independent web save", () => {
    const html = render("mines");
    expect(html).toContain("网页玩法");
    expect(html).toMatch(/<button[^>]*>试用原版70格扫雷<\/button>/);
    expect(html).toContain("70格存档与网页36格独立");
    expect(html).toContain("三档奖励手动领取");
    expect(html).not.toContain("试用原版32格翻牌");
  });
  it("does not permit opening the mines scene for a different live game character", () => {
    expect(render("mines", 41)).toMatch(/<button[^>]*disabled=""[^>]*>试用原版70格扫雷<\/button>/);
  });
  it("offers the original DDPlay without replacing shared progress or introducing a payment", () => {
    const html = render("ddplay");
    expect(html).toContain("网页玩法"); expect(html).toContain("试用原版弹弹乐");
    expect(html).toContain("共用进度及活动积分"); expect(html).toContain("每次转动消耗10积分");
    expect(html).toContain("通过游戏邮件送达"); expect(html).not.toContain("试用原版70格扫雷");
  });
  it("requires the actual game character for the DDPlay trial entry", () => {
    expect(render("ddplay", 41)).toMatch(/<button[^>]*disabled=""[^>]*>试用原版弹弹乐<\/button>/);
  });
  it("offers the original eight-slot merchant and states the shared local shelf rules", () => {
    const html = render("gypsy");
    expect(html).toContain("网页玩法"); expect(html).toContain("试用原版吉普赛商人");
    expect(html).toContain("原窗刷新8件、网页刷新3件"); expect(html).toContain("两边共用货架和售罄状态");
    expect(html).toContain("每天首次刷新免费，此后5积分"); expect(html).toContain("整包购买");
    expect(html).toContain("顶部展示本地普通材料"); expect(html).not.toContain("试用原版弹弹乐");
  });
  it("offers original moonlight with explicit local batch and quantity rules", () => {
    const html = render("moon"); expect(html).toContain("网页玩法"); expect(html).toContain("试用原版月光宝盒");
    expect(html).toContain("1、3、5次"); expect(html).toContain("可勾选材料及数量"); expect(html).toContain("原商城和排行尚未接入");
    expect(html).not.toContain("试用原版吉普赛商人");
  });
  it("requires the actual game character for the moonlight trial entry", () => {
    expect(render("moon", 41)).toMatch(/<button[^>]*disabled=""[^>]*>试用原版月光宝盒<\/button>/);
  });
  it("requires the actual game character for the merchant trial entry", () => {
    expect(render("gypsy", 41)).toMatch(/<button[^>]*disabled=""[^>]*>试用原版吉普赛商人<\/button>/);
  });
});
