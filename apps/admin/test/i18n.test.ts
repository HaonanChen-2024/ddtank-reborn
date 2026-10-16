import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n, LocaleToggle, Spinner } from "@ddtank/ui";
import { translate as adminTranslate } from "../src/i18n";
import { translate as webTranslate } from "../../web/src/i18n";
import { resources } from "../src/resources";
import { SchemaForm } from "../src/crud/SchemaForm";
import { serverConfigFields } from "../src/pages/ServerConfig";
import { useText } from "../src/i18n";

afterEach(() => vi.unstubAllGlobals());

function renderLocale(stored: string | null, chinese = true): string {
  vi.stubGlobal("localStorage", { getItem: () => stored });
  const i18n = createI18n({
    "pt-BR": { greeting: "Olá {name}" },
    en: { greeting: "Hello {name}" },
    ...(chinese ? { "zh-CN": { greeting: "你好 {name}" } } : {}),
  });
  function Probe() {
    const { locale, t } = i18n.useI18n();
    return createElement("span", { lang: locale }, t("greeting", { name: "DDTank" }));
  }
  return renderToStaticMarkup(createElement(i18n.I18nProvider, null, createElement(Probe)));
}

describe("Chinese entry localization", () => {
  it("defaults to Chinese, including an invalid saved preference", () => {
    expect(renderLocale(null)).toBe('<span lang="zh-CN">你好 DDTank</span>');
    expect(renderLocale("invalid")).toBe('<span lang="zh-CN">你好 DDTank</span>');
  });

  it("uses Chinese for old Portuguese/English preferences and keeps legacy dictionaries compatible", () => {
    expect(renderLocale("pt-BR")).toBe('<span lang="zh-CN">你好 DDTank</span>');
    expect(renderLocale("en")).toBe('<span lang="zh-CN">你好 DDTank</span>');
    expect(renderLocale(null, false)).toBe('<span lang="pt-BR">Olá DDTank</span>');
  });

  it("only offers Chinese and labels the shared loading control in Chinese", () => {
    const toggle = renderToStaticMarkup(createElement(LocaleToggle, { locale: "zh-CN", onChange: () => {} }));
    expect(toggle).toContain('aria-label="语言"');
    expect(toggle).toContain(">中文</button>");
    expect(toggle).not.toMatch(/Language|Idioma|>PT<|>EN</);
    expect(renderToStaticMarkup(createElement(Spinner))).toContain('aria-label="加载中"');
  });

  it("interpolates application dictionaries without changing Portuguese/English text", () => {
    expect(webTranslate("zh-CN", "account.level", { level: 12 })).toBe("等级 12");
    expect(webTranslate("en", "account.level", { level: 12 })).toBe("Level 12");
    expect(webTranslate("pt-BR", "account.level", { level: 12 })).toBe("Nível 12");
    expect(adminTranslate("zh-CN", "crud.range", { from: 1, to: 20, total: 30 })).toBe("第 1–20 条，共 30 条");
    expect(adminTranslate("zh-CN", "crud.newTitle", { name: "物品" })).toBe("新建 物品");
  });

  it("provides Chinese names for every registered administration resource", () => {
    for (const resource of resources) {
      expect(typeof resource.label, resource.name).toBe("object");
      expect(typeof resource.singular, resource.name).toBe("object");
      if (typeof resource.label !== "string") expect(resource.label["zh-CN"], resource.name).toBeTruthy();
      if (typeof resource.singular !== "string") expect(resource.singular["zh-CN"], resource.name).toBeTruthy();
    }
  });

  it("renders administration labels, sections, validation hints and row actions in Chinese", () => {
    const players = resources.find(resource => resource.name === "players")!;
    const guilds = resources.find(resource => resource.name === "guilds")!;
    const scheduled = resources.find(resource => resource.name === "scheduled-events")!;
    const form = renderToStaticMarkup(createElement(SchemaForm, {
      fields: [...players.fields, ...serverConfigFields], onSubmit: () => {},
    }));
    for (const label of ["金币", "封禁截止时间", "公网地址", "网络", "维护模式"]) expect(form).toContain(label);
    function Actions() {
      const text = useText();
      return createElement("div", null, [
        text(guilds.description),
        ...players.rowActions!.flatMap(action => [text(action.label), text(action.confirm), text(action.success)]),
        ...scheduled.fields.find(field => field.name === "kind")!.options!.map(option => text(option.label)),
      ].join(" / "));
    }
    const actions = renderToStaticMarkup(createElement(Actions));
    for (const label of ["公会", "发放物品", "解除封禁", "世界首领", "小鸡宝箱", "迷宫"]) expect(actions).toContain(label);
  });
});
