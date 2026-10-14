import assert from "node:assert/strict";
import { test } from "node:test";
import { readPlayerMail, findPendingItemMail } from "../apps/api/scripts/workshop-mail-read.ts";

const unrelated = Array.from({ length: 500 }, (_, n) => ({ ID: n + 1, ReceiverID: 6, Type: 51, Annex1: null }));
function api(rows, items = {}, mutate = x => x) {
  const calls = [];
  const read = async path => {
    calls.push(path);
    if (path.startsWith("/api/admin/player-items/")) return items[path.split("/").at(-1)];
    const q = new URL(path, "http://test").searchParams, page = Number(q.get("page"));
    assert.equal(q.get("q"), "51"); assert.equal(q.get("sort"), "ID");
    return mutate({ items: rows.slice((page - 1) * 500, page * 500), total: rows.length, page, pageSize: 500 });
  };
  return { read, calls };
}
test("Type=51 matches may occupy page one; the exact recipient is found on page two", async () => {
  const own = { ID: 678, ReceiverID: 51, Type: 51, Annex1: "956" }, a = api([...unrelated, own]);
  assert.deepEqual(await readPlayerMail(a.read, 51), [own]); assert.equal(a.calls.length, 2);
});
test("pending read selects the exact new template, not another new mail or an earlier attachment", async () => {
  const rows = [...unrelated, { ID: 677, ReceiverID: 51, Annex1: "955" }, { ID: 678, ReceiverID: 51, Annex1: "956" }, { ID: 679, ReceiverID: 51, Annex1: "957" }];
  const a = api(rows, { 955: { ItemID: 955, TemplateID: 3999144, UserID: 0 }, 956: { ItemID: 956, TemplateID: 3999144, UserID: 0 }, 957: { ItemID: 957, TemplateID: 3999145, UserID: 0 } });
  assert.deepEqual(await findPendingItemMail(a.read, 51, 3999144, [677]), { mailId: 678, itemId: 956, templateId: 3999144 });
  assert.ok(a.calls.every(path => !path.includes("give-item")));
});
test("a missing pending send stays unresolved without issuing a write", async () => {
  const a = api(unrelated); assert.equal(await findPendingItemMail(a.read, 51, 3999144, []), undefined);
  assert.ok(a.calls.every(path => path.startsWith("/api/admin/player-mail?")));
});
test("multiple new matching attachments are ambiguous", async () => {
  const a = api([{ ID: 678, ReceiverID: 51, Annex1: "956" }, { ID: 679, ReceiverID: 51, Annex1: "957" }], { 956: { ItemID: 956, TemplateID: 3999144, UserID: 0 }, 957: { ItemID: 957, TemplateID: 3999144, UserID: 0 } });
  await assert.rejects(findPendingItemMail(a.read, 51, 3999144, []), /ambiguous/);
});
test("a changing total, truncated page, or duplicate ID refuses incomplete reads", async () => {
  const rows = [...unrelated, { ID: 678, ReceiverID: 51 }];
  await assert.rejects(readPlayerMail(api(rows, {}, p => p.page === 2 ? { ...p, total: 502 } : p).read, 51), /changed during pagination/);
  await assert.rejects(readPlayerMail(api(rows, {}, p => ({ ...p, items: p.items.slice(1) })).read, 51), /incomplete/);
  await assert.rejects(readPlayerMail(api([...unrelated, unrelated[0]]).read, 51), /duplicate/);
});
test("empty lists are complete; an attachment detail must match its mail ID", async () => {
  assert.deepEqual(await readPlayerMail(api([]).read, 51), []);
  const a = api([{ ID: 678, ReceiverID: 51, Annex1: "956" }], { 956: { ItemID: 999, TemplateID: 3999144, UserID: 0 } });
  await assert.rejects(findPendingItemMail(a.read, 51, 3999144, []));
});
