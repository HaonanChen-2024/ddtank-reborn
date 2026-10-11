import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireOfficial, assetReferences, categories, compareCatalog, matchTargets, parseTargetsCsv } from "./workshop-official.mjs";

const item = (overrides = {}) => ({ goodId: "1", templateId: 6099, name: "灰调大衣", category: "clothes", categoryId: 5, needSex: 1, property8: 123, pic: "/image/equip/m/cloth/cloth664/1/show.png", previewPic: "/image/equip/m/cloth/cloth664/icon_1.png", ...overrides });

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "ddtank-official-"));
  // This exact test-created directory is the only recursive cleanup target.
  t.after(() => rm(parent, { recursive: true, force: true }));
  return join(parent, "snapshot");
}

function pages(records, image = null) {
  const calls = [];
  const request = async (url, path) => {
    calls.push(url);
    const address = new URL(url), category = address.searchParams.get("category");
    if (category) {
      assert.equal(address.searchParams.get("pageSize"), "120");
      assert.deepEqual(address.searchParams.getAll("sourceTypeList[]"), ["0", "1"]);
      const selected = records.filter(record => record.category === category);
      await writeFile(path, JSON.stringify({ code: 200, data: { current: 1, total: selected.length, pages: selected.length ? 1 : 0, records: selected } }), { flag: "wx" });
      return { status: 200, contentType: "application/json;charset=UTF-8" };
    }
    assert.ok(image, "catalog-only acquisition must not request any images");
    await writeFile(path, image.bytes, { flag: "wx" });
    return { status: image.status ?? 200, contentType: image.contentType ?? "image/png" };
  };
  return { request, calls };
}

test("a catalog snapshot records all six published categories, diffs, and exact target status without images", async t => {
  const output = await fixture(t), current = [item(), item({ goodId: "2", templateId: 6000, name: "重名" }), item({ goodId: "3", templateId: 6001, name: "重名" })];
  const prior = [item({ name: "旧名字" }), item({ goodId: "4", templateId: 6002, name: "已移出" })], mock = pages(current);
  const report = await acquireOfficial({ output, previous: prior, targets: [{ targetId: "ok", name: "灰调大衣" }, { targetId: "duplicate", name: "重名" }, { targetId: "missing", name: "未找到" }], request: mock.request });
  assert.equal(mock.calls.length, 6);
  assert.deepEqual(report.categories.map(category => category.category), categories);
  assert.deepEqual(report.difference, { added: 2, changed: 1, removed: 1 });
  assert.deepEqual(report.targets.map(target => target.status), ["matched", "ambiguous", "missing"]);
  assert.equal(report.targets[0].officialTemplateId, 6099);
  assert.equal(report.targets[0].localTemplateId, null);
  assert.equal(report.assets.length, 0); assert.equal(report.gameAssetsImported, false);
  assert.deepEqual(JSON.parse(await readFile(join(output, "catalog.json"), "utf8")), current);
  const manifest = await readFile(join(output, "manifest.json"));
  await assert.rejects(acquireOfficial({ output, request: mock.request }), /EEXIST/);
  assert.deepEqual(await readFile(join(output, "manifest.json")), manifest);
  assert.equal(mock.calls.length, 6, "existing snapshots cause no new HTTP requests");
});

test("pagination conflicts and duplicate IDs fail with a retained diagnostic snapshot", async t => {
  const output = await fixture(t), mock = pages([item({ category: "hat" }), item({ category: "hat" })]);
  await assert.rejects(acquireOfficial({ output, request: mock.request }), /Duplicate goodId/);
  assert.match(await readFile(join(output, "failed.json"), "utf8"), /Duplicate goodId/);
  const output2 = await fixture(t);
  let page = 0;
  const changing = async (_url, path) => {
    page++;
    await writeFile(path, JSON.stringify({ code: 200, data: { current: page, total: page === 1 ? 121 : 120, pages: page === 1 ? 2 : 1, records: page === 1 ? [] : [] } }), { flag: "wx" });
    return { status: 200, contentType: "application/json" };
  };
  await assert.rejects(acquireOfficial({ output: output2, request: changing }), /changed during pagination/);
  assert.equal(page, 2);
});

test("asset references use API paths and verified layers, preserving official IDs and hair casing", () => {
  const references = assetReferences(item());
  assert.equal(references.length, 7);
  assert.equal(references.filter(reference => reference.kind === "game").length, 3);
  assert.ok(references.every(reference => reference.resourcePath.startsWith("image/equip/m/cloth/cloth664/")));
  const hair = item({ category: "hair", categoryId: 3, pic: "/image/equip/f/hair/hair232/1/b/show.png", previewPic: "/image/equip/f/hair/hair232/icon_1.png", needSex: 2, property8: 12 });
  assert.equal(assetReferences(hair).length, 9);
  assert.ok(assetReferences(hair).some(reference => reference.resourcePath.endsWith("/2/a/game.png") && reference.clientPath.endsWith("/2/A/game.png")));
  for (const bad of [item({ pic: "/image/equip/m/cloth/../1/show.png" }), item({ previewPic: "https://other.invalid/icon.png" }), item({ property8: 112 }), item({ needSex: 2 })]) assert.throws(() => assetReferences(bad));
  assert.throws(() => compareCatalog([], [item(), item()]), /Duplicate goodId/);
  assert.equal(matchTargets([{ targetId: "case", name: "灰调大衣 " }], [item()])[0].status, "missing");
});

test("explicit target download skips ambiguous names and preserves non-200 responses without accepting them as game assets", async t => {
  const output = await fixture(t), current = [item(), item({ goodId: "2", templateId: 6000, name: "重名" }), item({ goodId: "3", templateId: 6001, name: "重名" })];
  const mock = pages(current, { status: 404, bytes: Buffer.from("missing"), contentType: "text/html" });
  const report = await acquireOfficial({ output, targets: [{ targetId: "one", name: "灰调大衣" }, { targetId: "two", name: "重名" }], downloadTargets: true, request: mock.request });
  assert.equal(mock.calls.length, 6 + 7);
  assert.equal(report.assets.length, 0); assert.equal(report.assetErrors.length, 7);
  assert.equal(report.completeGameAssetsAcquired, 0); assert.equal(report.renderingAccepted, false);
  assert.equal(report.requests.filter(request => request.status === 404).length, 7);
  assert.equal(await readFile(join(output, report.requests.at(-1).path), "utf8"), "missing");
});

test("downloaded PNG headers are marked separately from full decoding and game acceptance", async t => {
  const output = await fixture(t), png = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png); png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(250, 16); png.writeUInt32BE(312, 20);
  const mock = pages([item()], { bytes: png });
  const report = await acquireOfficial({ output, targets: [{ targetId: "one", name: "灰调大衣" }], downloadTargets: true, request: mock.request });
  assert.equal(report.assets.length, 7); assert.equal(report.assetErrors.length, 0);
  assert.ok(report.assets.every(asset => asset.pngHeaderVerified && !asset.decoded && !asset.renderingAccepted && asset.localTemplateId === null));
  assert.deepEqual(await readFile(join(output, report.assets[0].path)), png);
});

test("target CSV accepts Chinese columns, BOM, quoted commas, and escaped quotes", () => {
  assert.deepEqual(parseTargetsCsv('\uFEFF目标ID,名称,备注\r\nx,"衣服,帽子","say ""hi"""\r\n'), [{ targetId: "x", name: "衣服,帽子" }]);
  for (const bad of ['名称\n衣服', '目标ID,名称\nx,衣服\nx,帽子', '目标ID,名称\nx,"unfinished']) assert.throws(() => parseTargetsCsv(bad));
});
