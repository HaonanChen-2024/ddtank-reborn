#!/usr/bin/env node
// Give verified installed appearances to one local character through existing GM mail.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readPlayerMail, findPendingItemMail } from "../apps/api/scripts/workshop-mail-read.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(repo, "../../runtime");
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("node scripts/workshop-official-deliver.mjs --user=<local character ID> [--journal=<private verified install.json>]\nSends one permanent bound item per verified template via GM mail; records exact mail/item IDs and never retries an unknown send blindly. No price or balance changes."); process.exit(0); }
assert.ok(args.every(a => /^--(user|journal)=.+$/.test(a)));
const userId = Number(args.find(a => a.startsWith("--user="))?.slice(7));
assert.ok(Number.isSafeInteger(userId) && userId > 0, "requires one exact local character ID");
const journalPath = resolve(args.find(a => a.startsWith("--journal="))?.slice(10) ?? join(runtime, "content-research/official-install.json"));
assert.ok(journalPath.startsWith(runtime + sep), "install journal must stay in private runtime");
const installed = JSON.parse(readFileSync(journalPath, "utf8"));
assert.equal(installed.renderingAccepted, true, "review original component screenshots before delivery");
assert.ok(installed.templates.length > 0 && installed.templates.length <= 200);
assert.ok(installed.templates.every(e => e.installed && e.protocolAccepted), "unverified install batch");
const session = JSON.parse(readFileSync(join(runtime, "workshop-session.json"), "utf8"));
assert.equal(session.publicHost ?? "127.0.0.1", "127.0.0.1");
const proof = createHash("sha256").update(JSON.stringify(installed.templates.map(e => ({ id: e.id, pic: e.pic, category: e.categoryId, name: e.name })))).digest("hex");
const receiptPath = journalPath + `.deliver-${userId}.json`;
let receipt, token;
const save = () => { mkdirSync(dirname(receiptPath), { recursive: true }); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n"); };
async function json(path, method = "GET", body) {
  const r = await fetch("http://127.0.0.1:8080" + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  assert.equal(r.status, 200, `${method} ${path} status`); return r.json();
}
async function mails() {
  return readPlayerMail(json, userId);
}
async function findPending() {
  const match = await findPendingItemMail(json, userId, receipt.pending.templateId, receipt.pending.before);
  assert.ok(match, "send outcome is unknown; inspect exact pending ledger, never resend blindly"); return match;
}
async function main() {
  const gm = JSON.parse(readFileSync(join(runtime, "credentials/smoke-accounts.json"), "utf8")).findLast(a => a.admin === true); assert.ok(gm);
  const auth = await json("/api/auth/login", "POST", { username: gm.username, password: gm.password }); assert.equal(auth.user.role, "admin"); token = auth.token;
  const before = await json(`/api/admin/players/${userId}`);
  receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : { userId, nickname: before.NickName, planSha256: proof, started: new Date().toISOString(), baseline: { gold: before.Gold, money: before.Money, style: before.Style }, deliveries: [] };
  assert.equal(receipt.userId, userId); assert.equal(receipt.planSha256, proof, "delivery belongs to another install batch");
  if (receipt.ok === true && !receipt.pending && receipt.deliveries.length === installed.templates.length) {
    assert.equal(new Set(receipt.deliveries.map(d => d.templateId)).size, installed.templates.length);
    assert.ok(installed.templates.every(e => receipt.deliveries.some(d => d.templateId === e.id && Number.isSafeInteger(d.mailId) && d.mailId > 0 && Number.isSafeInteger(d.itemId) && d.itemId > 0)));
    console.log(JSON.stringify({ userId, nickname: before.NickName, sent: 0, alreadyDelivered: receipt.deliveries.length, receiptPath }));
    return;
  }
  assert.equal(before.State, 0, "use an offline local character for exact no-balance-change readback");
  assert.equal(before.Style, receipt.baseline.style); assert.equal(before.Gold, receipt.baseline.gold); assert.equal(before.Money, receipt.baseline.money);
  save();
  for (const entry of installed.templates) {
    const row = await json(`/api/admin/items/${entry.id}`); assert.equal(row.Pic, entry.pic); assert.equal(row.CategoryID, entry.categoryId); assert.equal(row.Name, entry.name);
    if (receipt.deliveries.some(d => d.templateId === entry.id)) continue;
    if (receipt.pending) assert.equal(receipt.pending.templateId, entry.id, "resolve earlier pending delivery first");
    else {
      receipt.pending = { templateId: entry.id, before: (await mails()).map(m => m.ID) }; save();
      await json(`/api/admin/players/${userId}/give-item`, "POST", { templateId: entry.id, count: 1, validDays: 0 });
    }
    const delivery = await findPending(), item = await json(`/api/admin/player-items/${delivery.itemId}`);
    assert.equal(item.Count, 1); assert.equal(item.ValidDate, 0); assert.equal(item.IsBinds, true);
    receipt.deliveries.push({ ...delivery, name: entry.name, needSex: entry.needSex }); delete receipt.pending; save();
  }
  const after = await json(`/api/admin/players/${userId}`);
  assert.equal(after.State, 0); assert.equal(after.Style, receipt.baseline.style); assert.equal(after.Gold, receipt.baseline.gold); assert.equal(after.Money, receipt.baseline.money);
  receipt.ended = new Date().toISOString(); receipt.ok = true; delete receipt.error; save();
  console.log(JSON.stringify({ userId, nickname: receipt.nickname, sent: receipt.deliveries.length, permanent: true, currenciesUnchanged: true, receiptPath }));
}
main().catch(error => { if (receipt) { receipt.ok = false; receipt.error = error.message; save(); } console.error(error.message); process.exitCode = 1; });
