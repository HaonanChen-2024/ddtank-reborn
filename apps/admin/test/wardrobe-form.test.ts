import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SchemaForm } from "../src/crud/SchemaForm";
import { WardrobeCheck, wardrobeDraft } from "../src/crud/WardrobeCheck";
import { copyForCreate } from "../src/crud/schema";
import type { Row } from "../src/crud/types";
import { items } from "../src/resources/items";

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
});
