import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workshop-language.mjs"));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t) {
  const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, "ddtank-language-"));
  t.after(() => { assert.ok(resolve(root).startsWith(parent + sep)); rmSync(root, { recursive: true, force: true }); });
  const repo = join(root, "source/repo"), runtime = join(root, "runtime");
  const put = (file, text) => { const path = join(repo, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  put("scripts/workshop-language.mjs", script);
  const source = "\uFEFF# source comment\r\nNPC.Line:Original {0:N0}<br/>\r\nUntouched:Kept\r\nNPC.Line:Last {0:N0}<br/>\r\n";
  put("data/i18n/pt-BR/server-language.txt", source);
  put("research/i18n/zh-CN-server-overrides.json", JSON.stringify({ "NPC.Line": "中文 {0:N0}<br/>" }));
  put("apps/api/assets/flash/ui/vietnam/language.txt", "\uFEFF## client\r\nClient.Line:Old {0}\r\n");
  put("research/i18n/zh-CN-overrides.json", JSON.stringify({ "Client.Line": "客户端 {0}" }));
  const run = (...args) => spawnSync(process.execPath, [join(repo, "scripts/workshop-language.mjs"), ...args], { encoding: "utf8", windowsHide: true });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  return { root, repo, runtime, put, source, run, ok };
}

test("server verification is read-only and includes duplicate rows and format placeholders", t => {
  const f = fixture(t), result = JSON.parse(f.ok("verify", "--server"));
  assert.equal(result.keys, 1); assert.equal(result.translatedRows, 2); assert.equal(result.installed, false);
  assert.equal(Object.hasOwn(result, "addedKeys"), false);
  assert.equal(existsSync(f.runtime), false);
  assert.equal(readFileSync(join(f.repo, "data/i18n/pt-BR/server-language.txt"), "utf8"), f.source);
});

test("the online-box Chinese keys install over the real server dictionary without changing other lines", t => {
  const f = fixture(t);
  // Git checkouts may use LF; the deployment fixture must match the original AS3 parser's CRLF contract.
  const source = readFileSync(join(repoRoot, "data/i18n/pt-BR/server-language.txt"), "utf8").replace(/\r?\n/g, "\r\n");
  const overridesText = readFileSync(join(repoRoot, "research/i18n/zh-CN-server-overrides.json"), "utf8");
  const overrides = JSON.parse(overridesText);
  const keys = ["success", "todayOver", "title", "mail", "fail"].map(key => `UserGetTimeBoxHandler.${key}`).concat("GoodsPresentHandler.AnnexRemark");
  for (const key of keys) assert.equal(typeof overrides[key], "string");
  f.put("data/i18n/pt-BR/server-language.txt", source);
  f.put("research/i18n/zh-CN-server-overrides.json", overridesText);
  const additionsFile = join(repoRoot, "research/i18n/zh-CN-server-additions.json");
  const additionsText = existsSync(additionsFile) ? readFileSync(additionsFile, "utf8") : null;
  if (additionsText !== null) f.put("research/i18n/zh-CN-server-additions.json", additionsText);
  f.ok("verify", "--server"); f.ok("install", "--server");
  let expected = source.split("\r\n").map(line => {
    const colon = line.indexOf(":"), key = line.slice(0, colon);
    return colon >= 0 && Object.hasOwn(overrides, key) ? `${key}:${overrides[key]}` : line;
  }).join("\r\n");
  const additions = additionsText === null ? [] : Object.entries(JSON.parse(additionsText));
  if (additions.length) expected += (expected.endsWith("\r\n") ? "" : "\r\n") + additions.map(([key, value]) => `${key}:${value}\r\n`).join("");
  assert.equal(readFileSync(join(f.runtime, "server-language.txt"), "utf8"), expected);
  assert.equal(readFileSync(join(f.repo, "data/i18n/pt-BR/server-language.txt"), "utf8"), source);
});

test("client and server installations use independent targets, journals and rollback", t => {
  const f = fixture(t); f.ok("install");
  const client = join(f.runtime, "client-overlay/ui/vietnam/language.txt"), journal = join(f.runtime, "client-overlay-language.json");
  const oldClient = readFileSync(client), oldJournal = readFileSync(journal);
  f.ok("install", "--server");
  const server = join(f.runtime, "server-language.txt"), bytes = readFileSync(server, "utf8");
  assert.equal(bytes, f.source.replaceAll(/(?:Original|Last) \{0:N0\}/g, "中文 {0:N0}"));
  assert.equal(JSON.parse(f.ok("install", "--server")).unchanged, true);
  f.ok("rollback", "--server");
  assert.equal(existsSync(server), false); assert.equal(existsSync(join(f.runtime, "server-language.json")), false);
  assert.deepEqual(readFileSync(client), oldClient); assert.deepEqual(readFileSync(journal), oldJournal);
});

test("server update backs up and restores the prior deployment without changing the shipped source", t => {
  const f = fixture(t); f.ok("install", "--server");
  const server = join(f.runtime, "server-language.txt"), previous = readFileSync(server);
  f.put("research/i18n/zh-CN-server-overrides.json", JSON.stringify({ "NPC.Line": "新中文 {0:N0}<br/>" }));
  f.ok("install", "--server");
  const journal = JSON.parse(readFileSync(join(f.runtime, "server-language.json"), "utf8"));
  assert.ok(journal.backup.includes("server-language-backups")); assert.deepEqual(readFileSync(journal.backup), previous);
  f.ok("rollback", "--server"); assert.deepEqual(readFileSync(server), previous);
  // Restored owned content must remain updatable; retaining the bytes alone loses the old ownership receipt.
  f.ok("install", "--server"); assert.ok(readFileSync(server, "utf8").includes("新中文"));
  assert.equal(readFileSync(join(f.repo, "data/i18n/pt-BR/server-language.txt"), "utf8"), f.source);
});

test("custom server edits are preserved by install and rollback", t => {
  const f = fixture(t); f.ok("install", "--server");
  const server = join(f.runtime, "server-language.txt"); writeFileSync(server, "custom user content");
  for (const action of ["install", "rollback"]) assert.notEqual(f.run(action, "--server").status, 0);
  assert.equal(readFileSync(server, "utf8"), "custom user content");
});

test("invalid server key or formatted placeholder fails before any deployment write", t => {
  const f = fixture(t);
  for (const overrides of [{ "NPC.Line": "中文 {0}" }, { "Missing.Key": "中文" }, { "NPC.Line": "跨行\n{0:N0}" }]) {
    f.put("research/i18n/zh-CN-server-overrides.json", JSON.stringify(overrides));
    assert.notEqual(f.run("install", "--server").status, 0); assert.equal(existsSync(f.runtime), false);
  }
});

test("optional server additions append exact formatted rows and retain owned update/rollback", t => {
  const f = fixture(t), additions = { "Workshop.Events.Daily.Success": "已领取 {0:N0}<br/>", "Workshop.Events.VIP.Title": "VIP礼包：{0}" };
  f.ok("install", "--server");
  const target = join(f.runtime, "server-language.txt"), journalFile = join(f.runtime, "server-language.json");
  const previous = readFileSync(target), previousJournal = JSON.parse(readFileSync(journalFile, "utf8"));
  const additionsText = JSON.stringify(additions);
  f.put("research/i18n/zh-CN-server-additions.json", additionsText);
  const checked = JSON.parse(f.ok("verify", "--server"));
  assert.equal(checked.addedKeys, 2); assert.equal(checked.keys, 3); assert.equal(checked.translatedRows, 4);
  assert.deepEqual(readFileSync(target), previous); assert.deepEqual(JSON.parse(readFileSync(journalFile, "utf8")), previousJournal);
  const installed = JSON.parse(f.ok("install", "--server")), expected = previous.toString("utf8") + "Workshop.Events.Daily.Success:已领取 {0:N0}<br/>\r\nWorkshop.Events.VIP.Title:VIP礼包：{0}\r\n";
  assert.equal(installed.sha256, checked.sha256); assert.equal(readFileSync(target, "utf8"), expected);
  const journal = JSON.parse(readFileSync(journalFile, "utf8"));
  assert.deepEqual(readFileSync(journal.backup), previous); assert.deepEqual(journal.previousJournal, previousJournal);
  assert.equal(JSON.parse(f.ok("install", "--server")).unchanged, true);
  assert.deepEqual(JSON.parse(readFileSync(journalFile, "utf8")), journal);
  f.ok("rollback", "--server");
  assert.deepEqual(readFileSync(target), previous); assert.deepEqual(JSON.parse(readFileSync(journalFile, "utf8")), previousJournal);
  assert.equal(readFileSync(join(f.repo, "data/i18n/pt-BR/server-language.txt"), "utf8"), f.source);
  assert.equal(readFileSync(join(f.repo, "research/i18n/zh-CN-server-additions.json"), "utf8"), additionsText);
});

test("server additions preserve a missing terminal CRLF and verification writes nothing", t => {
  const f = fixture(t), source = f.source.slice(0, -2);
  f.put("data/i18n/pt-BR/server-language.txt", source);
  f.put("research/i18n/zh-CN-server-additions.json", JSON.stringify({ "Workshop.Events.New": "新文案 {0}" }));
  assert.equal(JSON.parse(f.ok("verify", "--server")).addedKeys, 1); assert.equal(existsSync(f.runtime), false);
  f.ok("install", "--server");
  assert.equal(readFileSync(join(f.runtime, "server-language.txt"), "utf8"), source.replaceAll(/(?:Original|Last) \{0:N0\}/g, "中文 {0:N0}") + "\r\nWorkshop.Events.New:新文案 {0}\r\n");
  assert.equal(readFileSync(join(f.repo, "data/i18n/pt-BR/server-language.txt"), "utf8"), source);
});

test("invalid server additions and legacy override errors preserve every deployed file", t => {
  const f = fixture(t), source = f.source + "Workshop.Events.SourceOnly:Original\r\nWorkshop.Events.Overridden:Original\r\n";
  const overrides = { "NPC.Line": "中文 {0:N0}<br/>", "Workshop.Events.Overridden": "既有覆盖" };
  f.put("data/i18n/pt-BR/server-language.txt", source); f.ok("install", "--server");
  f.put("research/i18n/zh-CN-server-overrides.json", JSON.stringify(overrides)); f.ok("install", "--server");
  const deployed = () => readdirSync(f.runtime, { recursive: true }).sort().filter(name => statSync(join(f.runtime, name)).isFile())
    .map(name => [name, readFileSync(join(f.runtime, name)).toString("base64")]);
  const before = deployed();
  const invalid = [null, [], ["value"], "value", 1,
    { "Other.Events.New": "新文案" }, { "Workshop.Events.": "新文案" }, { "Workshop.Events.Bad:Key": "新文案" },
    { "Workshop.Events.Bad\rKey": "新文案" }, { "Workshop.Events.Bad\nKey": "新文案" }, { "Workshop.Events.Bad\tKey": "新文案" },
    { "Workshop.Events.Bad\r": "新文案" }, { "Workshop.Events.Bad\n": "新文案" }, { "Workshop.Events.Bad\t": "新文案" },
    { "Workshop.Events.New": null }, { "Workshop.Events.New": 1 }, { "Workshop.Events.New": {} },
    { "Workshop.Events.New": "" }, { "Workshop.Events.New": " \t" }, { "Workshop.Events.New": "跨\r行" },
    { "Workshop.Events.New": "跨\n行" }, { "Workshop.Events.New": "制\t表" },
    { "Workshop.Events.SourceOnly": "不能覆盖原键" }, { "Workshop.Events.Overridden": "不能覆盖override" }];
  for (const value of invalid) {
    f.put("research/i18n/zh-CN-server-additions.json", JSON.stringify(value));
    assert.notEqual(f.run("install", "--server").status, 0, JSON.stringify(value)); assert.deepEqual(deployed(), before);
  }
  f.put("research/i18n/zh-CN-server-additions.json", JSON.stringify({ "Workshop.Events.Unknown": "不能补救旧override" }));
  f.put("research/i18n/zh-CN-server-overrides.json", JSON.stringify({ ...overrides, "Workshop.Events.Unknown": "旧未知key" }));
  const unknown = f.run("install", "--server"); assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /translation keys missing/); assert.deepEqual(deployed(), before);
  f.put("research/i18n/zh-CN-server-overrides.json", JSON.stringify({ ...overrides, "NPC.Line": "格式已改变 {0}" }));
  const formatted = f.run("install", "--server"); assert.notEqual(formatted.status, 0); assert.match(formatted.stderr, /placeholder mismatch/); assert.deepEqual(deployed(), before);
});

function scrollFixture(t) {
  const f = fixture(t), source = Buffer.from("\uFEFFOriginal notice\r\n", "utf16le");
  f.put("apps/api/assets/flash/ui/vietnam/movingnotification.txt", source);
  const config = { sourceSha256: createHash("sha256").update(source).digest("hex"), lines: ["中文提示", "下一条提示"] };
  f.put("research/i18n/zh-CN-moving-notifications.json", JSON.stringify(config));
  return { ...f, config, noticeSource: source, target: join(f.runtime, "client-overlay/ui/vietnam/movingnotification.txt"), journal: join(f.runtime, "client-overlay-notifications.json") };
}

test("client and scroll-notice modes never read optional server additions", t => {
  const f = scrollFixture(t);
  f.put("research/i18n/zh-CN-server-additions.json", "{invalid JSON");
  f.ok("verify"); f.ok("verify", "--notifications"); assert.equal(existsSync(f.runtime), false);
  assert.notEqual(f.run("verify", "--server").status, 0); assert.equal(existsSync(f.runtime), false);
  const client = JSON.parse(f.ok("install")), notices = JSON.parse(f.ok("install", "--notifications"));
  assert.equal(Object.hasOwn(client, "addedKeys"), false); assert.equal(Object.hasOwn(notices, "addedKeys"), false);
  assert.equal(existsSync(join(f.runtime, "server-language.txt")), false);
});

test("scroll notices preserve original encoding and cyclic CRLF without touching either dictionary", t => {
  const f = scrollFixture(t);
  assert.equal(JSON.parse(f.ok("verify", "--notifications")).notifications, 2);
  assert.equal(existsSync(f.runtime), false);
  f.ok("install"); f.ok("install", "--server");
  const client = join(f.runtime, "client-overlay-language.json"), server = join(f.runtime, "server-language.json"), oldClient = readFileSync(client), oldServer = readFileSync(server);
  f.ok("install", "--notifications");
  assert.deepEqual(readFileSync(f.target), Buffer.from("\uFEFF中文提示\r\n下一条提示\r\n", "utf16le"));
  assert.equal(JSON.parse(f.ok("install", "--notifications")).unchanged, true);
  f.ok("rollback", "--notifications");
  assert.equal(existsSync(f.target), false); assert.equal(existsSync(f.journal), false);
  assert.deepEqual(readFileSync(client), oldClient); assert.deepEqual(readFileSync(server), oldServer);
  assert.deepEqual(readFileSync(join(f.repo, "apps/api/assets/flash/ui/vietnam/movingnotification.txt")), f.noticeSource);
});

test("scroll notice updates restore prior owned content and reject custom edits", t => {
  const f = scrollFixture(t); f.ok("install", "--notifications");
  const previous = readFileSync(f.target), previousJournal = readFileSync(f.journal);
  f.config.lines = ["更新提示"]; f.put("research/i18n/zh-CN-moving-notifications.json", JSON.stringify(f.config));
  f.ok("install", "--notifications"); f.ok("rollback", "--notifications");
  assert.deepEqual(readFileSync(f.target), previous);
  assert.deepEqual(JSON.parse(readFileSync(f.journal)), JSON.parse(previousJournal));
  f.ok("install", "--notifications"); writeFileSync(f.target, "custom notices");
  for (const command of ["install", "rollback"]) assert.notEqual(f.run(command, "--notifications").status, 0);
  assert.equal(readFileSync(f.target, "utf8"), "custom notices");
});

test("invalid scroll notice inputs and mixed modes fail before writing", t => {
  const f = scrollFixture(t);
  assert.notEqual(f.run("install", "--notifications", "--server").status, 0);
  for (const config of [{ ...f.config, sourceSha256: "bad" }, { ...f.config, lines: [] }, { ...f.config, lines: [""] }, { ...f.config, lines: ["跨\n行"] }, { ...f.config, lines: ["{不配对"] }]) {
    f.put("research/i18n/zh-CN-moving-notifications.json", JSON.stringify(config));
    assert.notEqual(f.run("install", "--notifications").status, 0);
    assert.equal(existsSync(f.runtime), false);
  }
});

test("server rollback preserves deployment when the saved backup was modified", t => {
  const f = fixture(t); f.ok("install", "--server");
  f.put("research/i18n/zh-CN-server-overrides.json", JSON.stringify({ "NPC.Line": "新中文 {0:N0}<br/>" })); f.ok("install", "--server");
  const target = join(f.runtime, "server-language.txt"), before = readFileSync(target);
  const journal = JSON.parse(readFileSync(join(f.runtime, "server-language.json"), "utf8"));
  writeFileSync(journal.backup, "changed backup");
  assert.notEqual(f.run("rollback", "--server").status, 0); assert.deepEqual(readFileSync(target), before);
  assert.equal(readFileSync(journal.backup, "utf8"), "changed backup");
});

test("server rejects a journal with another target or backup directory", t => {
  const f = fixture(t); f.ok("install", "--server");
  const path = join(f.runtime, "server-language.json"), journal = JSON.parse(readFileSync(path, "utf8"));
  const target = join(f.runtime, "server-language.txt"), before = readFileSync(target);
  writeFileSync(path, JSON.stringify({ ...journal, target: join(f.runtime, "other.txt") }));
  assert.notEqual(f.run("install", "--server").status, 0); assert.notEqual(f.run("rollback", "--server").status, 0);
  writeFileSync(path, JSON.stringify({ ...journal, backup: join(f.root, "unrelated.txt") }));
  assert.notEqual(f.run("rollback", "--server").status, 0); assert.deepEqual(readFileSync(target), before);
});

test("server rollback refuses a backup without its matching previous ownership receipt", t => {
  const f = fixture(t); f.ok("install", "--server");
  f.put("research/i18n/zh-CN-server-overrides.json", JSON.stringify({ "NPC.Line": "新中文 {0:N0}<br/>" })); f.ok("install", "--server");
  const path = join(f.runtime, "server-language.json"), journal = JSON.parse(readFileSync(path, "utf8"));
  const target = join(f.runtime, "server-language.txt"), before = readFileSync(target);
  journal.previousJournal.sha256 = "0".repeat(64); writeFileSync(path, JSON.stringify(journal));
  assert.notEqual(f.run("rollback", "--server").status, 0); assert.deepEqual(readFileSync(target), before);
});

test("the 69 bag, card, pet and totem captions preserve real client formatting and install only in an isolated fixture", t => {
  const f = fixture(t);
  const source = readFileSync(join(repoRoot, "apps/api/assets/flash/ui/vietnam/language.txt"), "utf8").replace(/\r?\n/g, "\r\n");
  const overridesText = readFileSync(join(repoRoot, "research/i18n/zh-CN-overrides.json"), "utf8"), overrides = JSON.parse(overridesText);
  const keys = ["tank.BagAndInfo.BankBag.titleText", "tank.view.bagII.GoodsTipPanel.maxGP", "ddt.bagandinfo.bagAndInfo.itemOpenUpTxt",
    "ddt.bagAndInfo.sell.CanNotSell", "tank.hall.ChooseHallView.labyrinth",
    ...["UpGradeFrame.explain0", "UpGradeFrame.explain1", "UpGradeFrame.explain2", "PropResetFrame.attack", "PropResetFrame.defends",
      "PropResetFrame.agility", "PropResetFrame.lucy", "PropResetFrame.damage", "PropResetFrame.guard", "PropResetFrame.explain", "cardProp.unknown",
      "upgradeFrame.ownCardNum", "upgradeFrame.rule", "cardEquip.open3", "cardEquip.open4", "cardEquip.congratulate", "cardEquip.cannotOpen3", "cardEquip.cannotOpen4"].map(key => `ddt.cardSystem.${key}`),
    ...["revertPetAlertMsg", "revertPetCostMsg", "foodAmountTipText", "fight", "unfight", "advancedTxt", "risingStar.tisingStarTxt", "risingStar.maxStarTxt",
      "risingStar.helpTxt1", "risingStar.helpTxt2", "risingStar.helpTxt3", "evolution.helpTxt", "evolution.cannotEvolutionTxt", "advanced.noPropTxt", "openTxt",
      "break.eatNum.NotEnough", "break.stars.NotEnough", "break.samsang.NotEnough", "break.petLevel.NotEnough", "break.shoudnotFight", "break.breakGradeEnough",
      "break.protectedNotEnough", "break.starExpWaste", "break.SucMessage", "break.useProtected", "break.stone", "break.levelFull", "break.BreakLevelFull",
      "break.sureToNotUseProtect", "break.warning", "break.detail", "break.breakCurGradeInfo", "break.fullGrade", "convert", "convertCannotTxt", "convertCannotTxt2",
      "releaseCannotTxt", "releaseTransformTxt", "releaseDirectTxt", "hungerFull", "releasPetsDiscrp", "releaseCanTransTipTxt"].map(key => `ddt.pets.${key}`),
    ...["totemPointTip.possibleValueTxt", "totemChapterTip.titleTxt", "rightViewTotemSignTxt", "rightViewTotemSignTipMsg"].map(key => `ddt.totem.${key}`)];
  assert.equal(keys.length, 69); assert.equal(new Set(keys).size, 69);
  const rows = source.split("\r\n"), parts = line => { const colon = line.indexOf(":"); return [colon, line.slice(0, colon).replace(/^\uFEFF/, ""), line.slice(colon + 1)]; };
  const placeholders = value => [...value.matchAll(/\{\d+(?::[^}]*)?\}/g)].map(match => match[0]).sort();
  const tags = value => value.match(/<[^>]*>/g) ?? [], lineEscapes = value => value.match(/\\+n/g) ?? [];
  for (const key of keys) {
    const matches = rows.map(parts).filter(([colon, candidate]) => colon > 0 && candidate === key);
    assert.ok(matches.length > 0, `real client key missing: ${key}`);
    assert.equal(typeof overrides[key], "string"); assert.match(overrides[key], /[\u3400-\u9fff]/); assert.doesNotMatch(overrides[key], /[\r\n]/);
    for (const [, , original] of matches) {
      assert.deepEqual(placeholders(overrides[key]), placeholders(original), `placeholder changed: ${key}`);
      assert.deepEqual(tags(overrides[key]), tags(original), `HTML changed: ${key}`);
      assert.deepEqual(lineEscapes(overrides[key]), lineEscapes(original), `literal newline changed: ${key}`);
    }
  }
  assert.equal(overrides["tank.view.bagII.GoodsTipPanel.maxGP"], "经验上限");
  assert.equal(overrides["ddt.bagAndInfo.sell.CanNotSell"], "此物品不可出售");
  assert.match(overrides["tank.hall.ChooseHallView.labyrinth"], /30/);
  assert.equal(overrides["ddt.pets.fight"], "出战"); assert.equal(overrides["ddt.pets.unfight"], "召回");
  f.put("apps/api/assets/flash/ui/vietnam/language.txt", source); f.put("research/i18n/zh-CN-overrides.json", overridesText);
  assert.equal(JSON.parse(f.ok("verify")).installed, false); assert.equal(existsSync(f.runtime), false);
  const result = JSON.parse(f.ok("install")), target = join(f.runtime, "client-overlay/ui/vietnam/language.txt"), output = readFileSync(target);
  const expected = rows.map(line => { const [colon, key] = parts(line); return colon > 0 && !line.startsWith("##") && Object.hasOwn(overrides, key) ? line.slice(0, colon + 1) + overrides[key] : line; }).join("\r\n");
  assert.deepEqual(output, Buffer.from(expected)); assert.equal(output.subarray(0, 3).toString("hex"), "efbbbf");
  assert.doesNotMatch(output.toString("utf8"), /(?<!\r)\n/); assert.equal(output.toString("utf8").split("\r\n").length, rows.length);
  assert.equal(result.keys, Object.keys(overrides).length); assert.equal(JSON.parse(f.ok("install")).unchanged, true);
  assert.equal(readFileSync(join(f.repo, "apps/api/assets/flash/ui/vietnam/language.txt"), "utf8"), source);
});
