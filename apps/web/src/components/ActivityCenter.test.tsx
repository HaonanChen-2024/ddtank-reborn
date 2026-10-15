import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ api: { getToken: () => null }, meQuery: { queryKey: ["account", "me"], queryFn: () => null } }));
import { ActivityCenter } from "./ActivityCenter";

function render(id: "pair" | "wardrobe" | "mines" | "ddplay" | "gypsy" | "moon" | "treasure" | "wheel" | "carnival" | "first-gift" | "points-gift", initialCharacterId = 40) {
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
  it("offers the original four-page charge activity with explicit local rules", () => {
    const html = render("points-gift"); expect(html).toContain("试用原版充值大赠送"); expect(html).toContain("网页玩法");
    expect(html).toContain("本地四页"); expect(html).toContain("共用领取记录"); expect(html).toContain("不接真实付款");
    expect(html).toContain("不补算历史"); expect(html).not.toContain("试用原版首充大礼");
  });
  it("requires the live game character for the charge entry", () => {
    expect(render("points-gift", 41)).toMatch(/<button[^>]*disabled=""[^>]*>试用原版充值大赠送<\/button>/);
  });
  it("offers the original first-recharge with local tasks and one canonical first claim", () => {
    const html = render("first-gift"); expect(html).toContain("试用原版首充大礼"); expect(html).toContain("网页玩法");
    expect(html).toContain("任务解锁三档"); expect(html).toContain("活动积分"); expect(html).toContain("共用领取记录");
    expect(html).toContain("赠送一次"); expect(html).toContain("无真实付款"); expect(html).not.toContain("试用原版节日狂欢");
  });
  it("requires the live game character for the first-recharge entry", () => {
    expect(render("first-gift", 41)).toMatch(/<button[^>]*disabled=""[^>]*>试用原版首充大礼<\/button>/);
  });
  it("offers the original carnival with finite committed batches and no second animation award", () => {
    const html = render("carnival"); expect(html).toContain("网页玩法"); expect(html).toContain("试用原版节日狂欢");
    expect(html).toContain("分别存档"); expect(html).toContain("打开只读取"); expect(html).toContain("最多5次");
    expect(html).toContain("停止或关闭不会撤销已提交奖励"); expect(html).toContain("动画不再次发奖");
    expect(html).toContain("7种本地配方"); expect(html).toContain("大奖直播原资源、全服奖池和排行尚未接入");
    expect(html).not.toContain("试用原版啵咕大转盘");
  });
  it("requires the actual game character for the carnival trial entry", () => {
    expect(render("carnival", 41)).toMatch(/<button[^>]*disabled=""[^>]*>试用原版节日狂欢<\/button>/);
  });
  it("offers the original seven-level wheel with an honest separate-save contract", () => {
    const html = render("wheel"); expect(html).toContain("网页玩法"); expect(html).toContain("试用原版啵咕大转盘");
    expect(html).toContain("分别存档"); expect(html).toContain("打开只读取"); expect(html).toContain("本地追加成功率60%");
    expect(html).toContain("明确选择芯片或材料"); expect(html).toContain("原商城、付款和排行尚未接入");
    expect(html).not.toContain("试用原版迷宫寻宝");
  });
  it("requires the actual game character for the wheel trial entry", () => {
    expect(render("wheel", 41)).toMatch(/<button[^>]*disabled=""[^>]*>试用原版啵咕大转盘<\/button>/);
  });
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
  it("offers original treasure with a finite local batch and shared bag rules", () => {
    const html = render("treasure"); expect(html).toContain("网页玩法"); expect(html).toContain("试用原版迷宫寻宝");
    expect(html).toContain("30积分"); expect(html).toContain("60积分"); expect(html).toContain("5次有限批次");
    expect(html).toContain("共用30格临时包"); expect(html).toContain("单格取出"); expect(html).toContain("全服排行尚未接入");
    expect(html).not.toContain("试用原版月光宝盒");
  });
  it("requires the actual game character for the treasure trial entry", () => {
    expect(render("treasure", 41)).toMatch(/<button[^>]*disabled=""[^>]*>试用原版迷宫寻宝<\/button>/);
  });
});
