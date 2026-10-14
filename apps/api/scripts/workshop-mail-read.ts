import assert from "node:assert/strict";

type Row = Record<string, any>;
type Read = (path: string) => Promise<unknown>;

/** Generic q searches every column: q=51 also matches system-mail Type=51. */
export async function readPlayerMail(read: Read, userId: number): Promise<Row[]> {
  assert.ok(Number.isSafeInteger(userId) && userId > 0);
  const rows: Row[] = [], ids = new Set<number>();
  let total: number | undefined;
  for (let page = 1; ; page++) {
    const list = await read(`/api/admin/player-mail?pageSize=500&q=${userId}&page=${page}&sort=ID`) as { items: Row[]; total: number; page: number; pageSize: number };
    assert.ok(Array.isArray(list.items) && Number.isSafeInteger(list.total) && list.total >= 0, "invalid mail page");
    assert.equal(list.page, page); assert.equal(list.pageSize, 500);
    total ??= list.total;
    assert.equal(list.total, total, "mail list changed during pagination; inspect before continuing");
    assert.equal(list.items.length, Math.min(500, total - (page - 1) * 500), "mail page is incomplete");
    for (const mail of list.items) {
      assert.ok(Number.isSafeInteger(mail.ID) && mail.ID > 0 && !ids.has(mail.ID), "duplicate or invalid mail ID"); ids.add(mail.ID);
      if (mail.ReceiverID === userId) rows.push(mail);
    }
    if (page * 500 >= total) return rows;
  }
}

/** Reconcile a saved send attempt by recipient and attachment, never by page position. */
export async function findPendingItemMail(read: Read, userId: number, templateId: number, before: number[]) {
  const matches: { mailId: number; itemId: number; templateId: number }[] = [];
  for (const mail of await readPlayerMail(read, userId)) {
    if (before.includes(mail.ID) || !Number.isSafeInteger(Number(mail.Annex1)) || Number(mail.Annex1) <= 0) continue;
    const item = await read(`/api/admin/player-items/${mail.Annex1}`) as Row;
    assert.equal(item.ItemID, Number(mail.Annex1));
    if (item.TemplateID === templateId && item.UserID === 0) matches.push({ mailId: mail.ID, itemId: item.ItemID, templateId: item.TemplateID });
  }
  assert.ok(matches.length <= 1, "send outcome is ambiguous; inspect exact pending ledger, never resend blindly");
  return matches[0];
}
