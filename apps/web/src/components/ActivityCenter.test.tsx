import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ api: { getToken: () => null }, meQuery: { queryKey: ["account", "me"], queryFn: () => null } }));
import { ActivityCenter } from "./ActivityCenter";

function render(id: "pair" | "wardrobe", initialCharacterId = 40) {
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
});
