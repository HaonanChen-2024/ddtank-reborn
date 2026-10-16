import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Font names, format values, comments, filter syntax and action triggers are not prose.
const technical = new Map([
  [
    "Tank.auctionHouse.view.BaseStripView.Font",
    "Arial Unicode MS"
  ],
  [
    "tank.view.scenechatII.SceneChatIIController.sys",
    ""
  ],
  [
    "tank.view.scenechatII.SceneChatIIController.sys0",
    "["
  ],
  [
    "tank.view.scenechatII.SceneChatIIController.say4",
    "[{0}"
  ],
  [
    "tank.view.common.BuggleView.news",
    "y                                                                                                                                                                                                      "
  ],
  [
    "tank.view.common.BuggleView.news2",
    "                                                                                                                                                                                                              "
  ],
  [
    "#2.10versio",
    "#2.10version"
  ],
  [
    "#2.20versio",
    "#2.20version"
  ],
  [
    "#2.30versio",
    "#2.30version"
  ],
  [
    "2.35versio",
    "2.35version"
  ],
  [
    "2.40versio",
    "2.40version"
  ],
  [
    "2.4.5versio",
    "2.4.5version"
  ],
  [
    "ddt.cardSystem.cardsTipPanel.typeDetail",
    "{0} ({1})"
  ],
  [
    "ddt.cardSystem.PropResetFrame.prop",
    "({0})"
  ],
  [
    "tank.calendar.activity.time",
    "{0}～{1}\t"
  ],
  [
    "tank.view.caddy.cardCartonDontClose",
    ""
  ],
  [
    "ddt.view.academyCommon.academyIcon.AcademyIconTip.1",
    "1\t"
  ],
  [
    "ddt.view.academyCommon.academyIcon.AcademyIconTip.2",
    "2\t"
  ],
  [
    "ddt.view.academyCommon.academyIcon.AcademyIconTip.3",
    "3\t"
  ],
  [
    "journal.view.JournalItem.contentTxtNum",
    "<FONT SIZE='14' FACE='Tahoma' COLOR='#993300'><B>{0}.</B></FONT>\t"
  ],
  [
    "journal.view.JournalItem.contentTxtContent",
    "<FONT SIZE='14' FACE='Tahoma' COLOR='#FF0000'><B>{0}</B></FONT>\t"
  ],
  [
    "#Iconos sala",
    "#Tema sala"
  ],
  [
    "room.roomPlayerActionKey.SAD",
    "buáá|snif|snifsnif|buu\t"
  ],
  [
    "room.roomPlayerActionKey.SARROWFUL",
    "buáábuáá|buáá|snifsnif\t"
  ],
  [
    "#3.6VIP Óptimo",
    "#3.6VIP Optimización"
  ],
  [
    "tank.vip.rechargeAlertContent3Param",
    "25%"
  ],
  [
    "tank.vip.rechargeAlertContent5Param",
    "1"
  ],
  [
    "tank.vip.rechargeAlertContent6Param",
    "8.8"
  ],
  [
    "tank.vip.rechargeAlertContent8Param1",
    "3"
  ],
  [
    "tank.vip.rechargeAlertContent8Param3",
    "15"
  ],
  [
    "firstrecharge.mainframe.contentTxtScale",
    "{0}%"
  ],
  [
    "ddt.labyrinth.LabyrinthFrame.helpFrame",
    ""
  ],
  [
    "tank.view.bagII.GoodsTipPanel.setPurpleHtmlTxt",
    "<FONT COLOR='FF9933'>{0}</FONT><FONT COLOR='E82EFE'>{1}</FONT><FONT COLOR='FF9933'>{2}</FONT>"
  ],
  [
    "tank.view.emailII.WritingView.NOGoods",
    ""
  ],
  [
    "ddt.gemstone.upview.txt1",
    ""
  ],
  [
    "ddt.gemstone.upview.txt2",
    ""
  ],
  [
    "ddt.totem.totemChapterTip.numListTxt",
    "1,2,3,4,5"
  ],
  [
    "zangNoFilterWords",
    "<,>,\\[,\\]"
  ],
  [
    "catchBeast.view.challengeNum",
    "({0})"
  ],
  [
    "happyRecharge.exchangeView.numTxt",
    "{0}/{1}"
  ],
  [
    "newChickenBox1.timePlayTxt",
    " {0}"
  ],
  [
    "ddt.luckStar.fullDate",
    "{0}-{1}-{2}"
  ]
]);
const parts = line => { const colon = line.indexOf(":"); return [colon, line.slice(0, colon).replace(/^\uFEFF/, "")]; };
const placeholders = value => (value.match(/\{\d+(?::[^}]*)?\}/g) ?? []).sort();
const html = /<\/?(?:font|b|u|i|a|br|p|textformat)(?:\s[^>]*?)?\/?>/gi;
function visible(value, key) {
  let text = value.replace(html, "").replace(/\\+[nr]/g, "").replace(/&(?:lt|gt|amp|quot|apos);/g, "");
  // Preserve brand names, shortcut keys and source-embedded identifiers.
  text = text.replace(/DDTank Reborn|DDTank|NEWGUN|Gunny|DDTV|ZingMe|MSN|QQ|GN|http/g, "")
    .replace(/[（(\[][A-Z][）)\]]/g, "").replace(/Enter/g, "").replace(/\b[A-C]\.|\b[a-d]\)/g, "");
  if (key === "store.view.transfer.HoleLabel") text = text.replace("store.view.transfer.EmptyItem:", "");
  if (/DisbandConsortiaFrame.sure$/.test(key)) text = text.replace("Disband", "");
  if (/ExitConsortiaFrame.quit$/.test(key)) text = text.replace("Quit", "");
  if (/^(ddt.exitPrompt.btInfoText|socialContact.microcobol.infoText)/.test(key)) text = text.replace(/r/g, "");
  if (key === "journal.view.JournalItem.content2") text = text.replace("XX", "");
  if (key === "church.weddingRoom.frame.AddWeddingRoomFrame.frameInfo") text = text.replace("XXXX", "").replace("<cr", "").replace("cr>", "");
  if (key === "tank.store.embedCell.Hole") text = text.replace("S{0}", "{0}");
  if (key === "petAndHorse.risingStar.toLinkTxtValue") text = text.replace("<a href='event", "");
  return text;
}

test("all client prose has Chinese coverage while source technical values remain intact", () => {
  const source = readFileSync(join(repo, "apps/api/assets/flash/ui/vietnam/language.txt"));
  const overrides = JSON.parse(readFileSync(join(repo, "research/i18n/zh-CN-overrides.json"), "utf8"));
  const rows = source.toString("utf8").split("\r\n"), seen = new Set();
  for (const line of rows) {
    const [colon, key] = parts(line);
    if (colon <= 0 || line.startsWith("##")) continue;
    seen.add(key);
    const original = line.slice(colon + 1);
    if (technical.has(key)) {
      assert.equal(original, technical.get(key), key + " technical source changed; review classification");
      assert.equal(Object.hasOwn(overrides, key), false, key + " technical value should pass through");
      continue;
    }
    assert.equal(typeof overrides[key], "string", key + " missing Chinese coverage");
    assert.doesNotMatch(overrides[key], /[\r\n]/, key + " real newline");
    assert.deepEqual(placeholders(overrides[key]), placeholders(original), key + " placeholder multiset");
    if (key.startsWith("room.roomPlayerActionKey.")) continue;
    const text = visible(overrides[key], key);
    assert.doesNotMatch(text, /\p{Script=Latin}/u, key + " untranslated visible text");
    if (/[\p{Script=Latin}\u3400-\u9fff]/u.test(visible(original, key))) assert.match(text, /[\u3400-\u9fff]/, key + " prose");
  }
  for (const key of Object.keys(overrides)) assert.ok(seen.has(key), key + " orphan override");
  assert.equal(overrides["tank.game.ToolStripView.itemTemplateInfo.Name2"], "怒气技2 [R]");
  assert.equal(overrides["tank.view.common.bossFight"], "首领战");
  assert.equal(overrides["ddt.petsBag.readme"], "宠物指南");
  assert.match(overrides["store.view.transfer.HoleLabel"], /store\.view\.transfer\.EmptyItem:/);
  assert.equal(Object.hasOwn(overrides, "store.view.transfer.EmptyItem"), false, "do not invent a key from the malformed merged source row");
});

test("the full client overlay preserves BOM, rows, CRLF and original source in an isolated install", t => {
  const root = mkdtempSync(join(tmpdir(), "workshop-client-cn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const isolated = join(root, "source/ddtank-reborn"), runtime = join(root, "runtime");
  const put = (path, bytes) => { const full = join(isolated, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, bytes); };
  const script = "scripts/workshop-language.mjs", sourcePath = "apps/api/assets/flash/ui/vietnam/language.txt", configPath = "research/i18n/zh-CN-overrides.json";
  const source = readFileSync(join(repo, sourcePath)), config = readFileSync(join(repo, configPath));
  put(script, readFileSync(join(repo, script))); put(sourcePath, source); put(configPath, config);
  const run = command => { const result = spawnSync(process.execPath, [join(isolated, script), command], { cwd: isolated, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  assert.equal(run("verify").installed, false); assert.equal(existsSync(runtime), false);
  const result = run("install"), output = readFileSync(join(runtime, "client-overlay/ui/vietnam/language.txt"));
  const overrides = JSON.parse(config), rows = source.toString("utf8").split("\r\n");
  const expected = rows.map(line => { const [colon, key] = parts(line); return colon > 0 && !line.startsWith("##") && Object.hasOwn(overrides, key) ? line.slice(0, colon + 1) + overrides[key] : line; }).join("\r\n");
  assert.deepEqual(output, Buffer.from(expected)); assert.equal(output.subarray(0, 3).toString("hex"), "efbbbf");
  assert.doesNotMatch(output.toString("utf8"), /(?<!\r)\n/); assert.equal(output.toString("utf8").split("\r\n").length, rows.length);
  assert.equal(result.keys, Object.keys(overrides).length); assert.equal(run("install").unchanged, true);
  assert.deepEqual(readFileSync(join(isolated, sourcePath)), source);
});
