import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/GameFrame", () => ({ GameFrame: () => null }));
vi.mock("@/components/AimTablePanel", () => ({ AimSidePanel: () => null }));
vi.mock("@/components/ActivityCenter", () => ({ ActivityCenter: () => <div>HTML-ACTIVITY-HUB</div> }));
vi.mock("@/lib/api", () => ({ aimTablesQuery: { queryKey: ["aim"], queryFn: () => null }, configQuery: { queryKey: ["config"], queryFn: () => null } }));
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import { bindNativeActivityEntry, PlayPage } from "./Play";
afterEach(() => vi.unstubAllGlobals());

describe("hall and play-page native menu entry", () => {
  it("delegates the exact hall character and consumes a handled click", () => {
    vi.stubGlobal("window", {}); const show = vi.fn(() => true), unavailable = vi.fn();
    const unbind = bindNativeActivityEntry(show, unavailable);
    expect(window.workshopOpenActivities?.(40)).toBe(true); expect(show).toHaveBeenCalledExactlyOnceWith(40);
    expect(unavailable).not.toHaveBeenCalled(); unbind(); expect(window.workshopOpenActivities).toBeUndefined();
  });
  it("reports missing AS installation while consuming the old hall click instead of falling back", () => {
    vi.stubGlobal("window", {}); const unavailable = vi.fn(); bindNativeActivityEntry(() => false, unavailable);
    expect(window.workshopOpenActivities?.(40)).toBe(true); expect(unavailable).toHaveBeenCalledExactlyOnceWith(40);
  });
  it("rejects invalid roles without navigation", () => {
    vi.stubGlobal("window", {}); const show = vi.fn(() => true), unavailable = vi.fn(); bindNativeActivityEntry(show, unavailable);
    for (const id of [0, -1, NaN, Infinity, 1.1]) expect(window.workshopOpenActivities?.(id)).toBe(false);
    expect(show).not.toHaveBeenCalled(); expect(unavailable).not.toHaveBeenCalled();
  });
  it("does not remove a newer player's hall delegate", () => {
    vi.stubGlobal("window", {}); const old = bindNativeActivityEntry(() => true, () => {});
    const next = bindNativeActivityEntry(() => true, () => {}), callback = window.workshopOpenActivities;
    old(); expect(window.workshopOpenActivities).toBe(callback); next();
  });
  it("exposes activity tasks before the help menu without mounting the HTML hub by default", () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><PlayPage /></QueryClientProvider>);
    const toolbar = html.split("<details")[0]!;
    expect(toolbar).toContain("活动中心"); expect(toolbar).toContain(">活动任务</button>");
    expect(toolbar).toContain("领取活动积分或恢复未确认操作");
    expect(html).toContain("恢复未确认操作（活动任务）"); expect(html).not.toContain("维护工具");
    expect(html).not.toContain("HTML-ACTIVITY-HUB"); client.clear();
  });
});
