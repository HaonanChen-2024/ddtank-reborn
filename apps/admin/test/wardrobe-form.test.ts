import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SchemaForm } from "../src/crud/SchemaForm";
import { WardrobeCheck, WardrobeResult, wardrobeDraft } from "../src/crud/WardrobeCheck";
import { copyForCreate } from "../src/crud/schema";
import type { Row } from "../src/crud/types";
import { items } from "../src/resources/items";
import type { WardrobeCheckResult } from "../../api/src/lib/wardrobe";

describe("wardrobe check uses the existing unsaved item form", () => {
  it("gets new/copy form appearance fields without a saved template ID", () => {
    const source = { TemplateID: 13100, CategoryID: 13, Pic: "old", NeedSex: 1, Property8: 1, Name: "source" };
    const initial = { ...copyForCreate(items, source), Pic: "my_new_suit", NeedSex: 0, Property8: 123 };
    let payload: ReturnType<typeof wardrobeDraft> | undefined;
    const markup = renderToStaticMarkup(createElement(SchemaForm, {
      fields: items.fields, mode: "create", initial, onSubmit: () => undefined,
      footer: (getValues: () => Row) => { payload = wardrobeDraft(getValues()); return createElement(WardrobeCheck, { getValues }); },
    }));
    expect(payload).toEqual({ CategoryID: 13, Pic: "my_new_suit", NeedSex: 0, Property8: 123 });
    expect(payload).not.toHaveProperty("TemplateID");
    expect(source).toMatchObject({ TemplateID: 13100, Pic: "old", NeedSex: 1, Property8: 1 });
    expect(markup).toContain("检查并预览");
    expect(markup).toContain("不验证像素解码、实际穿戴或动画");
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>检查并预览<\/button>/);
  });

  it("preserves an existing form footer and reads edit mode values", () => {
    const fields = items.fields.filter((field) => ["CategoryID", "Pic", "NeedSex", "Property8"].includes(field.name));
    let payload: ReturnType<typeof wardrobeDraft> | undefined;
    renderToStaticMarkup(createElement(SchemaForm, { fields, mode: "edit", initial: { CategoryID: 13, Pic: "edit_suit", NeedSex: 2, Property8: 2 }, onSubmit: () => undefined, footer: (getValues: () => Row) => { payload = wardrobeDraft(getValues()); return null; } }));
    expect(payload).toEqual({ CategoryID: 13, Pic: "edit_suit", NeedSex: 2, Property8: 2 });
    expect(renderToStaticMarkup(createElement(SchemaForm, { fields: [], onSubmit: () => undefined, footer: createElement("span", null, "existing footer") }))).toContain("existing footer");
  });

  it("reads ordinary clothing from the unsaved form without replacing its appearance fields", () => {
    expect(wardrobeDraft({ CategoryID: "5", Pic: "cloth664", NeedSex: "1", Property8: "123", TemplateID: 6099 })).toEqual({ CategoryID: "5", Pic: "cloth664", NeedSex: "1", Property8: "123" });
  });
});

describe("wardrobe result preview", () => {
  const result: WardrobeCheckResult = {
    draft: { CategoryID: 5, Pic: "cloth664", NeedSex: 1, Property8: 1 },
    pathSex: "m", state: "ok", readOnly: true, renderingAccepted: false,
    validationScope: "png-header-chunk-crc-and-frame-grid",
    assets: [{ kind: "show", layer: 1, path: "image/equip/m/cloth/cloth664/1/show.png", url: "/resource/cloth664/1/show.png", state: "ok", width: 250, height: 312, warnings: ["show-padding", "pixel-decode-unchecked"], frames: [{ owner: "RoomCharacter", columns: 1, rows: 1, frameWidth: 250, frameHeight: 342, state: "ok" }] }],
  };

  it("shows a single-frame clothing grid instead of assuming a second preview frame", () => {
    const markup = renderToStaticMarkup(createElement(WardrobeResult, { result }));
    expect(markup).toContain("所需图层：1");
    expect(markup).toContain("RoomCharacter：1 列 × 1 行，每格 250×342px");
    expect(markup).toContain("width:250px;height:342px");
    expect(markup).not.toContain("width:1000px");
    expect(markup).toContain("预览以342画布补透明底边");
    expect(result.renderingAccepted).toBe(false);
  });

  it("lists each required hair layer once while keeping A/B assets and missing-file status separate", () => {
    const hair = { ...result, draft: { ...result.draft, CategoryID: 3, Pic: "hair795", Property8: 13 }, state: "incomplete" as const, assets: [
      { ...result.assets[0]!, hairType: "a" as const, path: "hair795/1/a/show.png" },
      { ...result.assets[0]!, hairType: "b" as const, path: "hair795/1/b/show.png" },
      { ...result.assets[0]!, layer: 3, hairType: "b" as const, path: "hair795/3/b/show.png", state: "missing" as const, frames: [] },
    ] };
    const markup = renderToStaticMarkup(createElement(WardrobeResult, { result: hair }));
    expect(markup).toContain("所需图层：1, 3");
    expect(markup).toContain("发型 A");
    expect(markup).toContain("发型 B");
    expect(markup).toContain("文件缺失");
    expect(markup).toContain("素材不完整");
  });

  it("keeps the four-frame room preview for Category 13 suits", () => {
    const suit = { ...result, draft: { ...result.draft, CategoryID: 13, Pic: "legacy_suit" }, assets: [{ ...result.assets[0]!, width: 1000, frames: [
      { ...result.assets[0]!.frames[0]!, owner: "ShowCharacter" as const, columns: 2 },
      { ...result.assets[0]!.frames[0]!, columns: 4 },
    ] }] };
    const markup = renderToStaticMarkup(createElement(WardrobeResult, { result: suit }));
    expect(markup).toContain("RoomCharacter：4 列 × 1 行，每格 250×342px");
    expect(markup).toContain("width:1000px;height:342px");
  });
});
