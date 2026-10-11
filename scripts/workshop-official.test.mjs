import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireCatalogBatch, acquireOfficial, assetReferences, categories, compareCatalog, matchTargets, parseTargetsCsv, planCatalog, selectCatalogBatch } from "./workshop-official.mjs";

const item = (overrides = {}) => ({ goodId: "1", templateId: 6099, name: "灰调大衣", category: "clothes", categoryId: 5, needSex: 1, attack: 5, defence: 5, agility: 5, luck: 5, quality: 4, property1: 0, property2: 0, property3: 0, property4: 0, property5: 0, property6: 0, property7: 60, property8: 123, pic: "/image/equip/m/cloth/cloth664/1/show.png", previewPic: "/image/equip/m/cloth/cloth664/icon_1.png", ...overrides });

function imageBytes() {
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12); bytes.writeUInt32BE(250, 16); bytes.writeUInt32BE(312, 20);
  return bytes;
}

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

test("whole catalog inventory preserves installed, name-conflict, resource-duplicate and unsupported rows", () => {
  const records = [item(), item({ goodId: "2", templateId: 6100, name: "共享图片" }), item({ goodId: "3", templateId: 6101, name: "重名" }), item({ goodId: "4", templateId: 6102, name: "重名" }), item({ goodId: "5", templateId: 6103, name: "未知图层", property8: 9 })];
  const inventory = planCatalog(records, { templates: [{ officialId: 6099, id: 5999100, installed: true }] });
  assert.equal(inventory.records, records.length);
  assert.equal(inventory.entries[0].status, "installed-ledger-reported"); assert.equal(inventory.entries[0].localTemplateId, 5999100);
  assert.equal(inventory.entries[1].status, "duplicate-resource"); assert.equal(inventory.entries[1].duplicateResourceOf, "1");
  assert.equal(inventory.entries[2].status, "duplicate-resource"); assert.equal(inventory.entries[2].exactNameCount, 2); assert.equal(inventory.entries[2].nameConflict, true); assert.equal(inventory.entries[2].importerCompatible, true);
  assert.match(inventory.entries[4].reasons.join(";"), /layers 1, 2, 3/);
  assert.ok(inventory.entries.every(entry => !entry.gameAssetsImported && !entry.renderingAccepted));
  assert.equal(selectCatalogBatch(inventory).selected.length, 0);
  assert.equal(planCatalog([item()], { templates: [{ officialId: 6099, id: 5999100, installed: false }] }).entries[0].status, "unacquired");
});

test("same-name appearances can be selected by exact official IDs without guessing a name match", () => {
  const first = item({ name: "重名" }), second = item({ goodId: "2", templateId: 6100, name: "重名", pic: "/image/equip/m/cloth/cloth665/1/show.png", previewPic: "/image/equip/m/cloth/cloth665/icon_1.png" });
  const inventory = planCatalog([first, second]);
  assert.equal(selectCatalogBatch(inventory).selected.length, 2);
  assert.ok(inventory.entries.every(entry => entry.status === "unacquired" && entry.nameConflict && entry.exactNameCount === 2));
});

test("bounded selection is deterministic and balanced across categories and sexes", () => {
  const entries = categories.flatMap(category => [1, 2].flatMap(needSex => Array.from({ length: 3 }, (_, i) => ({ category, needSex, status: "unacquired", goodId: `${category}-${needSex}-${i}` }))));
  const first = selectCatalogBatch({ entries }, { batchSize: 12 }), next = selectCatalogBatch({ entries }, { offset: 12, batchSize: 12 });
  assert.equal(first.selected.length, 12); assert.equal(new Set(first.selected.map(entry => entry.category)).size, 6);
  assert.ok(first.selected.every(entry => entry.goodId.endsWith("-0"))); assert.ok(next.selected.every(entry => entry.goodId.endsWith("-1")));
  assert.equal(first.nextOffset, 12); assert.equal(next.nextOffset, 24); assert.equal(next.eligible, 36);
  for (const options of [{ batchSize: 201 }, { batchSize: 0 }, { offset: -1 }, { offset: 0.5 }]) assert.throws(() => selectCatalogBatch({ entries }, options));
});

test("local template resource identity skips known appearance paths without claiming runtime installation", () => {
  const local = [{ TemplateID: 5101, CategoryID: 5, NeedSex: 1, Pic: "cloth664" }];
  const inventory = planCatalog([item()], null, local);
  assert.equal(inventory.entries[0].status, "local-template-reported");
  assert.deepEqual(inventory.entries[0].localTemplateMatches, [5101]);
  assert.equal(inventory.entries[0].installedLedgerReported, false); assert.equal(selectCatalogBatch(inventory).selected.length, 0);
  assert.equal(planCatalog([item()], null, [{ ...local[0], NeedSex: 2 }]).entries[0].status, "unacquired");
});

test("all mode writes a full inventory but performs no HTTP unless explicitly downloading", async t => {
  const output = await fixture(t);
  const report = await acquireCatalogBatch({ output, records: [item()], request: () => { throw new Error("unexpected network"); } });
  assert.equal(report.records, 1); assert.equal(report.assets.length, 0); assert.equal(report.completeHeaderSets, 0);
  assert.deepEqual(JSON.parse(await readFile(join(output, "catalog.json"))), [item()]);
  assert.equal(JSON.parse(await readFile(join(output, "inventory.json"))).entries[0].status, "unacquired");
  await assert.rejects(acquireCatalogBatch({ output, records: [item()] }), /EEXIST/);
});

test("partial batches retain HTTP errors, resume verified successes in a new directory, and remain unaccepted", async t => {
  const output = await fixture(t), png = imageBytes();
  let calls = 0;
  const report = await acquireCatalogBatch({ output, records: [item()], download: true, delayMs: 0, request: async (_url, path) => {
    calls++; await writeFile(path, calls === 3 ? "missing" : png, { flag: "wx" });
    return { status: calls === 3 ? 404 : 200, contentType: calls === 3 ? "text/html" : "image/png" };
  } });
  assert.equal(calls, 7); assert.equal(report.assets.length, 6); assert.equal(report.assetErrors.length, 1);
  assert.equal(report.outcomes[0].status, "missing-assets"); assert.equal(report.completeHeaderSets, 0);
  assert.equal(report.requests[2].status, 404); assert.match(report.requests[2].error, /404/);
  const resumedOutput = await fixture(t), originalManifest = await readFile(join(output, "manifest.json")); let resumedCalls = 0;
  const resumed = await acquireCatalogBatch({ output: resumedOutput, records: [item()], download: true, resume: output, delayMs: 0, request: async (_url, path) => {
    resumedCalls++; await writeFile(path, png, { flag: "wx" }); return { status: 200, contentType: "image/png" };
  } });
  assert.equal(resumedCalls, 1); assert.equal(resumed.assets.length, 7); assert.equal(resumed.assets.filter(asset => asset.reusedFrom).length, 6);
  assert.equal(resumed.completeHeaderSets, 1); assert.equal(resumed.outcomes[0].status, "complete-png-headers");
  assert.equal(resumed.completeGameAssetsAcquired, 0); assert.equal(resumed.renderingAccepted, false); assert.equal(resumed.gameAssetsImported, false);
  assert.deepEqual(await readFile(join(output, "manifest.json")), originalManifest);
  assert.ok(resumed.assets.every(asset => asset.pngHeaderVerified && !asset.decoded && asset.localTemplateId === null));
  assert.equal(resumed.targets[0].status, "matched"); assert.equal(resumed.targets[0].officialTemplateId, 6099);
});

test("resume rejects changed or escaping files instead of trusting stale download receipts", async t => {
  const prior = await fixture(t), png = imageBytes();
  const initial = await acquireCatalogBatch({ output: prior, records: [item()], download: true, delayMs: 0, request: async (_url, path) => {
    await writeFile(path, png, { flag: "wx" }); return { status: 200, contentType: "image/png" };
  } });
  await writeFile(join(prior, initial.assets[0].path), "changed");
  const output = await fixture(t);
  const report = await acquireCatalogBatch({ output, records: [item()], download: true, resume: prior, delayMs: 0, request: () => { throw new Error("unexpected request for changed owned file"); } });
  assert.equal(report.assets.length, 6); assert.equal(report.assetErrors.length, 1); assert.match(report.assetErrors[0].error, /hash\/size changed/);
  const receipt = { ...initial.assets[0], path: "../outside.png" };
  await writeFile(join(prior, "acquired.jsonl"), JSON.stringify(receipt) + "\n");
  const escaped = await acquireCatalogBatch({ output: await fixture(t), records: [item()], download: true, resume: prior, delayMs: 0, request: async (_url, path) => {
    await writeFile(path, png, { flag: "wx" }); return { status: 200, contentType: "image/png" };
  } });
  assert.equal(escaped.assetErrors.length, 1); assert.match(escaped.assetErrors[0].error, /escapes its snapshot/);
});

test("partially shared paths download once and keep exact per-template receipts for the importer", async t => {
  const output = await fixture(t), mock = pages([], { bytes: imageBytes() });
  const records = [item({ property8: 1 }), item({ goodId: "2", templateId: 6100, name: "另一配色", property8: 12 })];
  const report = await acquireCatalogBatch({ output, records, download: true, delayMs: 0, request: mock.request });
  assert.equal(report.targets.length, 2); assert.equal(report.assets.length, 8); assert.equal(mock.calls.length, 5);
  assert.equal(report.completeHeaderSets, 2); assert.equal(report.assetErrors.length, 0);
  assert.equal(report.assets.filter(asset => asset.officialTemplateId === 6099).length, 3);
  assert.equal(report.assets.filter(asset => asset.officialTemplateId === 6100).length, 5);
});
