#!/usr/bin/env node
// Public DIY catalog snapshots and explicitly selected assets; never imports into the game.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = resolve(repo, "..", "..");
export const officialOrigin = "https://diy-ddt.wan.com";
export const categories = ["hat", "glasses", "hair", "face", "clothes", "eyes"];
const folders = ["", "head", "glass", "hair", "eff", "cloth", "face"];
const scope = "Six public DIY frontend categories with sourceTypeList=[0,1]; not the entire official game catalog";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const saveJson = (path, value) => writeFile(path, json(value), { flag: "wx" });
const stable = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);

// This inventory is intentionally separate from import/visual acceptance. Repeated
// names are retained and selected by the unique official template ID, never by name.
export function planCatalog(records, installedLedger = null, localTemplates = []) {
  indexed(records);
  if (!Array.isArray(localTemplates)) throw new Error("Local templates must be an array");
  if (installedLedger && (!Array.isArray(installedLedger.templates) || installedLedger.templates.some(entry => !Number.isSafeInteger(entry.officialId)))) throw new Error("Invalid installed wardrobe ledger");
  const installed = new Map((installedLedger?.templates ?? []).filter(entry => entry.installed === true).map(entry => [entry.officialId, entry.id]));
  const names = new Map(), ids = new Map(), paths = new Map();
  for (const record of records) {
    names.set(record.name, (names.get(record.name) ?? 0) + 1);
    ids.set(record.templateId, (ids.get(record.templateId) ?? 0) + 1);
  }
  const entries = records.map(record => {
    const entry = { goodId: String(record.goodId), officialTemplateId: record.templateId, name: record.name, category: record.category, categoryId: record.categoryId, needSex: record.needSex, property8: record.property8, localTemplateId: installed.get(record.templateId) ?? null, installedLedgerReported: installed.has(record.templateId), localTemplateMatches: [], exactNameCount: names.get(record.name), duplicateResourceOf: null, references: [], status: "unacquired", reasons: [], decoded: false, gameAssetsImported: false, renderingAccepted: false };
    try {
      entry.references = assetReferences(record);
      const pic = record.previewPic.split("/").at(-2);
      entry.localTemplateMatches = localTemplates.filter(row => row.CategoryID === record.categoryId && (row.NeedSex === record.needSex || row.NeedSex === 0) && row.Pic === pic).map(row => row.TemplateID);
      if (!/^[123]{1,3}$/.test(String(record.property8))) throw new Error("Current importer supports only Property8 layers 1, 2, 3");
      for (const key of ["attack", "defence", "agility", "luck", "quality", ...Array.from({ length: 8 }, (_, i) => `property${i + 1}`)]) if (!Number.isSafeInteger(record[key])) throw new Error("Current importer requires integer " + key);
    } catch (error) { entry.reasons.push(error.message); }
    if (ids.get(record.templateId) !== 1) entry.reasons.push("Duplicate official template ID");
    entry.nameConflict = entry.exactNameCount !== 1;
    entry.importerCompatible = entry.reasons.length === 0;
    entry.status = entry.installedLedgerReported ? "installed-ledger-reported" : entry.localTemplateMatches.length ? "local-template-reported" : entry.importerCompatible ? "unacquired" : "incompatible-current-importer";
    return entry;
  });
  // Prefer an installed or importable record as a shared-resource representative.
  for (const entry of [...entries].sort((a, b) => Number(b.installedLedgerReported) - Number(a.installedLedgerReported) || Number(b.importerCompatible) - Number(a.importerCompatible))) {
    if (!entry.references.length) continue;
    const key = entry.references.map(reference => reference.resourcePath).sort().join("|");
    if (paths.has(key)) {
      entry.duplicateResourceOf = paths.get(key);
      if (entry.status === "unacquired") entry.status = "duplicate-resource";
    } else paths.set(key, entry.goodId);
  }
  const counts = Object.fromEntries([...new Set(entries.map(entry => entry.status))].map(status => [status, entries.filter(entry => entry.status === status).length]));
  return { scope, records: entries.length, counts, installedStatusBasis: "Supplied ledger/template snapshot only; not live database or local asset existence", entries };
}

export function selectCatalogBatch(inventory, { offset = 0, batchSize = 12 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 200) throw new Error("Batch requires offset >= 0 and batch-size 1-200");
  const groups = categories.flatMap(category => [1, 2].map(sex => inventory.entries.filter(entry => entry.status === "unacquired" && entry.category === category && entry.needSex === sex)));
  const ordered = [];
  for (let index = 0; groups.some(group => index < group.length); index++) for (const group of groups) if (group[index]) ordered.push(group[index]);
  return { offset, batchSize, eligible: ordered.length, nextOffset: Math.min(offset + batchSize, ordered.length), selected: ordered.slice(offset, offset + batchSize) };
}

function confined(root, path) {
  const destination = resolve(root, path), relation = relative(root, destination);
  if (!relation || relation === ".." || relation.startsWith(".." + sep) || isAbsolute(relation)) throw new Error("Asset path escapes its snapshot");
  return destination;
}

// Every retry uses a new output directory. Successful assets are checkpointed
// immediately and can be reused from even an interrupted batch after hash checks.
export async function acquireCatalogBatch({ output, records, installedLedger = null, localTemplates = [], offset = 0, batchSize = 12, download = false, resume = null, delayMs = 150, request = powershellRequest }) {
  const inventory = planCatalog(records, installedLedger, localTemplates), selection = selectCatalogBatch(inventory, { offset, batchSize });
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5000) throw new Error("Invalid acquisition delay");
  const reuse = new Map();
  if (resume) {
    const lines = await readFile(join(resume, "acquired.jsonl"), "utf8");
    // A process interruption may leave only the last append unfinished.
    const complete = lines.endsWith("\n") ? lines : lines.slice(0, lines.lastIndexOf("\n") + 1);
    for (const line of complete.split("\n").filter(Boolean)) {
      const asset = JSON.parse(line);
      if (asset.url !== officialOrigin + "/" + asset.resourcePath || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid resume asset receipt");
      reuse.set(asset.resourcePath, asset);
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  await mkdir(join(output, "responses"));
  await saveJson(join(output, "catalog.json"), records);
  await saveJson(join(output, "inventory.json"), inventory);
  await writeFile(join(output, "acquired.jsonl"), "", { flag: "wx" });
  const assets = [], assetErrors = [], requests = [], outcomes = [], receivedPaths = new Map(), startedAtUtc = new Date().toISOString();
  const targets = selection.selected.map(entry => ({ targetId: `official-${entry.goodId}`, name: entry.name, matchBasis: "official-template-id", exactMatchCount: 1, exactNameCount: entry.exactNameCount, status: "matched", officialTemplateId: entry.officialTemplateId, localTemplateId: null, records: [records.find(record => String(record.goodId) === entry.goodId)], gameAssetsImported: false, renderingAccepted: false }));
  await saveJson(join(output, "targets.json"), targets);
  if (download) for (const [index, entry] of selection.selected.entries()) {
    const target = targets[index];
    for (const reference of entry.references) {
      try {
        let bytes, receipt, reusedFrom = null;
        const existing = receivedPaths.get(reference.resourcePath);
        const previous = reuse.get(reference.resourcePath);
        if (existing) {
          bytes = await readFile(confined(output, existing.path));
          if (sha256(bytes) !== existing.sha256) throw new Error("Acquired asset changed during this batch");
          receipt = existing; reusedFrom = output;
        } else if (previous) {
          bytes = await readFile(confined(resolve(resume), previous.path));
          if (sha256(bytes) !== previous.sha256 || bytes.length !== previous.bytes) throw new Error("Resume asset hash/size changed");
          receipt = { bytes: bytes.length, sha256: previous.sha256 }; reusedFrom = resolve(resume);
        } else {
          if (requests.length && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
          const path = join(output, "responses", `asset-${requests.length}.bin`);
          // Reserve an attempt before requesting: failures never reuse/overwrite a response path.
          const attempt = { url: reference.url, path: relative(output, path), authenticated: false };
          requests.push(attempt);
          try {
            const metadata = await request(reference.url, path);
            const size = (await stat(path)).size;
            if (size < 1 || size > 20 * 1024 * 1024) throw new Error("Response size outside limit");
            bytes = await readFile(path);
            Object.assign(attempt, metadata, { bytes: size, sha256: sha256(bytes) });
            if (metadata.status !== 200) throw new Error("Public source returned HTTP " + metadata.status);
            if (!metadata.contentType?.startsWith("image/png")) throw new Error("Image response is not image/png");
            receipt = attempt;
          } catch (error) { attempt.error = error.message; throw error; }
          finally { await appendFile(join(output, "requests.jsonl"), JSON.stringify(attempt) + "\n"); }
        }
        const header = pngHeader(bytes), destination = confined(output, join("assets", reference.resourcePath));
        await mkdir(dirname(destination), { recursive: true });
        if (!existing) await writeFile(destination, bytes, { flag: "wx" });
        const asset = { targetId: target.targetId, targetName: target.name, officialTemplateId: entry.officialTemplateId, localTemplateId: null, categoryId: entry.categoryId, needSex: entry.needSex, property8: entry.property8, ...reference, path: relative(output, destination), bytes: receipt.bytes, sha256: receipt.sha256, ...header, reusedFrom, gameAssetsImported: false, renderingAccepted: false };
        assets.push(asset);
        receivedPaths.set(reference.resourcePath, asset);
        await appendFile(join(output, "acquired.jsonl"), JSON.stringify(asset) + "\n");
      } catch (error) {
        const failure = { targetId: target.targetId, officialTemplateId: entry.officialTemplateId, url: reference.url, error: error.message };
        assetErrors.push(failure); await appendFile(join(output, "errors.jsonl"), JSON.stringify(failure) + "\n");
      }
    }
    const acquired = assets.filter(asset => asset.targetId === target.targetId).length;
    outcomes.push({ goodId: entry.goodId, officialTemplateId: entry.officialTemplateId, name: entry.name, expected: entry.references.length, acquired, status: acquired === entry.references.length ? "complete-png-headers" : "missing-assets", decoded: false, gameAssetsImported: false, renderingAccepted: false });
  }
  const report = { version: 2, startedAtUtc, checkedAtUtc: new Date().toISOString(), source: officialOrigin + "/", scope, authenticated: false, catalogSha256: sha256(Buffer.from(json(records))), records: records.length, selection: { ...selection, selected: selection.selected.map(entry => entry.goodId) }, inventoryCounts: inventory.counts, targets, assets, assetErrors, requests, outcomes, resume: resume ? resolve(resume) : null, completeHeaderSets: outcomes.filter(entry => entry.status === "complete-png-headers").length, completeGameAssetsAcquired: 0, gameAssetsImported: false, renderingAccepted: false };
  await saveJson(join(output, "manifest.json"), report);
  return report;
}

// Use the same native PowerShell 7 HTTP client that succeeded on this Windows host.
// No login, cookies, UA override, proxy change, or disabled TLS verification.
export async function powershellRequest(url, path) {
  if (new URL(url).origin !== officialOrigin) throw new Error("Only the public official DIY origin is allowed");
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; if(Test-Path -LiteralPath ${literal(path)}){throw 'Response already exists'}; $r=Invoke-WebRequest -Uri ${literal(url)} -TimeoutSec 25 -SkipHttpErrorCheck -OutFile ${literal(path)} -PassThru; [pscustomobject]@{status=[int]$r.StatusCode;contentType=[string]$r.Headers['Content-Type']} | ConvertTo-Json -Compress`;
  const output = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 35_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(output.trim().replace(/^\uFEFF/, ""));
}

export function parseTargetsCsv(text) {
  const rows = [], row = [];
  let field = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || !field) quoted = !quoted;
      else throw new Error("Unexpected CSV quote");
    } else if (!quoted && (c === "," || c === "\n" || c === undefined)) {
      row.push(field.replace(/\r$/, "")); field = "";
      if (c !== ",") { if (row.some(Boolean)) rows.push(row.splice(0)); else row.length = 0; }
    } else if (c === undefined) throw new Error("Unterminated CSV quote");
    else field += c;
  }
  const header = rows.shift() ?? [], id = header.indexOf("目标ID"), name = header.indexOf("名称");
  if (id < 0 || name < 0) throw new Error("Targets CSV requires 目标ID and 名称 columns");
  const targets = rows.map(fields => ({ targetId: fields[id], name: fields[name] }));
  if (targets.some(target => !target.targetId || !target.name) || new Set(targets.map(target => target.targetId)).size !== targets.length) throw new Error("Invalid or duplicate target ID");
  return targets;
}

function indexed(records) {
  if (!Array.isArray(records)) throw new Error("Catalog must be an array");
  const map = new Map();
  for (const record of records) {
    const key = String(record.goodId ?? "");
    if (!key || !categories.includes(record.category) || !Number.isSafeInteger(record.templateId) || record.templateId < 1 || typeof record.name !== "string") throw new Error("Invalid official catalog record");
    if (map.has(key)) throw new Error("Duplicate goodId: " + key);
    map.set(key, record);
  }
  return map;
}

export function compareCatalog(previous, current) {
  const before = indexed(previous), after = indexed(current);
  return {
    added: [...after].filter(([id]) => !before.has(id)).map(([, record]) => record),
    changed: [...after].filter(([id, record]) => before.has(id) && stable(before.get(id)) !== stable(record)).map(([id, record]) => ({ before: before.get(id), after: record })),
    removed: [...before].filter(([id]) => !after.has(id)).map(([, record]) => record),
  };
}

export function matchTargets(targets, records) {
  return targets.map(target => {
    const matches = records.filter(record => record.name === target.name);
    return { ...target, exactMatchCount: matches.length, status: matches.length === 1 ? "matched" : matches.length ? "ambiguous" : "missing", officialTemplateId: matches.length === 1 ? matches[0].templateId : null, localTemplateId: null, records: matches, gameAssetsImported: false, renderingAccepted: false };
  });
}

export function assetReferences(record) {
  const match = /^\/image\/equip\/([mf])\/(head|glass|hair|eff|cloth|face)\/([A-Za-z0-9_]+)\/1\/(?:([ab])\/)?show\.png$/.exec(record.pic);
  if (!match || folders[record.categoryId] !== match[2] || categories[record.categoryId - 1] !== record.category || (record.needSex === 1 ? "m" : record.needSex === 2 ? "f" : null) !== match[1] || (record.categoryId === 3) !== Boolean(match[4])) throw new Error("Catalog path/category/sex is incompatible with verified 4.1 rules");
  const prefix = `/image/equip/${match[1]}/${match[2]}/${match[3]}`;
  if (record.previewPic !== prefix + "/icon_1.png") throw new Error("Unexpected API icon path");
  const layers = String(record.property8);
  if (!/^[1-9]{1,3}$/.test(layers) || new Set(layers).size !== layers.length) throw new Error("Unexpected Property8 layer list");
  const references = new Map();
  const add = (path, kind, derivation) => references.set(path, { url: officialOrigin + path, resourcePath: path.slice(1), clientPath: path.slice(1).replace(/\/([ab])\//g, (_all, variant) => "/" + variant.toUpperCase() + "/"), kind, derivation });
  add(record.pic, "show", "API pic"); add(record.previewPic, "icon", "API previewPic");
  // PathManager.solveGoodsPath + BaseLayer.Property8; existence is verified per HTTP response.
  for (const layer of layers) for (const variant of record.categoryId === 3 ? ["a/", "b/"] : [""]) for (const kind of ["show", "game"]) {
    const path = `${prefix}/${layer}/${variant}${kind}.png`;
    if (!references.has(path)) add(path, kind, "API directory + verified 4.1 Property8/show/game rule");
  }
  return [...references.values()];
}

function pngHeader(bytes) {
  if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("Response does not have a PNG header");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384) throw new Error("Unexpected PNG dimensions");
  return { width, height, pngHeaderVerified: true, decoded: false };
}

export async function acquireOfficial({ output, previous = [], targets = [], downloadTargets = false, request = powershellRequest }) {
  indexed(previous);
  if (downloadTargets && (!targets.length || targets.length > 200)) throw new Error("Asset acquisition requires 1-200 explicit targets");
  // An existing snapshot is never reused, merged, or overwritten.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  await mkdir(join(output, "responses"));
  const receipts = [], records = [], counts = [], assets = [], assetErrors = [];
  const receive = async (url, name, limit) => {
    const path = join(output, "responses", name);
    let metadata;
    try {
      metadata = await request(url, path);
      const size = (await stat(path)).size;
      if (size < 1 || size > limit) throw new Error("Response size outside limit");
      const bytes = await readFile(path);
      const receipt = { url, path: relative(output, path), ...metadata, bytes: size, sha256: sha256(bytes), authenticated: false };
      receipts.push(receipt);
      await appendFile(join(output, "requests.jsonl"), JSON.stringify(receipt) + "\n");
      if (metadata.status !== 200) throw new Error("Public source returned HTTP " + metadata.status);
      return { receipt, bytes, path };
    } catch (error) {
      await appendFile(join(output, "errors.jsonl"), JSON.stringify({ url, path: relative(output, path), error: error.message }) + "\n");
      throw error;
    }
  };
  try {
    for (const category of categories) {
      let pages = 1, total, observed = 0;
      for (let page = 1; page <= pages; page++) {
        const url = `${officialOrigin}/dressup-api/shopGood/pageList?pageNum=${page}&pageSize=120&category=${category}&sourceTypeList%5B%5D=0&sourceTypeList%5B%5D=1`;
        const { bytes, receipt } = await receive(url, `${category}-page${page}.json`, 5 * 1024 * 1024);
        if (!receipt.contentType?.includes("application/json")) throw new Error("Catalog response is not JSON");
        const payload = JSON.parse(bytes.toString("utf8")), data = payload.data;
        if (payload.code !== 200 || data?.current !== page || !Array.isArray(data.records)) throw new Error("Unexpected public API page");
        if (page === 1) {
          total = data.total; pages = data.pages;
          if (!Number.isSafeInteger(total) || total < 0 || total > 4800 || !Number.isSafeInteger(pages) || pages < 0 || pages > 40 || pages !== Math.ceil(total / 120)) throw new Error("Unexpected category pagination");
        } else if (data.total !== total || data.pages !== pages) throw new Error("Catalog changed during pagination: " + category);
        if (data.records.length > 120 || data.records.some(record => record.category !== category)) throw new Error("Unexpected category records");
        records.push(...data.records); observed += data.records.length;
      }
      if (observed !== total) throw new Error("Incomplete category: " + category);
      counts.push({ category, total, pages });
    }
    indexed(records);
    const matches = matchTargets(targets, records), difference = compareCatalog(previous, records);
    await saveJson(join(output, "catalog.json"), records);
    await saveJson(join(output, "difference.json"), difference);
    await saveJson(join(output, "targets.json"), matches);
    if (downloadTargets) for (const target of matches.filter(target => target.status === "matched")) {
      let references;
      try { references = assetReferences(target.records[0]); }
      catch (error) { assetErrors.push({ targetId: target.targetId, error: error.message }); continue; }
      for (const reference of references) {
        try {
          const response = await receive(reference.url, `asset-${receipts.length}.bin`, 20 * 1024 * 1024);
          if (!response.receipt.contentType?.startsWith("image/png")) throw new Error("Image response is not image/png");
          const header = pngHeader(response.bytes), destination = join(output, "assets", reference.resourcePath);
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(response.path, destination, constants.COPYFILE_EXCL);
          assets.push({ targetId: target.targetId, targetName: target.name, officialTemplateId: target.officialTemplateId, localTemplateId: null, categoryId: target.records[0].categoryId, needSex: target.records[0].needSex, property8: target.records[0].property8, ...reference, path: relative(output, destination), bytes: response.receipt.bytes, sha256: response.receipt.sha256, ...header, gameAssetsImported: false, renderingAccepted: false });
        } catch (error) { assetErrors.push({ targetId: target.targetId, url: reference.url, error: error.message }); }
      }
    }
    const report = { checkedAtUtc: new Date().toISOString(), source: officialOrigin + "/", scope, sourceTypeList: [0, 1], authenticated: false, categories: counts, records: records.length, difference: Object.fromEntries(Object.entries(difference).map(([key, value]) => [key, value.length])), targets: matches, assets, assetErrors, requests: receipts, completeGameAssetsAcquired: 0, gameAssetsImported: false, renderingAccepted: false };
    await saveJson(join(output, "manifest.json"), report);
    return report;
  } catch (error) {
    await saveJson(join(output, "failed.json"), { checkedAtUtc: new Date().toISOString(), scope, error: error.message, requests: receipts, gameAssetsImported: false });
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("node scripts/workshop-official.mjs [--previous=<catalog.json>] [--targets=<目标时装.csv>] [--download-targets] [--out=<new-directory>]\nnode scripts/workshop-official.mjs --all --catalog=<catalog.json> [--installed-ledger=<official-install.json>] [--local-templates=<Shop_Goods.json.gz>] [--download-all --batch-size=12 --offset=0] [--resume=<prior-batch-directory>] [--out=<new-directory>]\nDefault: fresh six-category catalog + diff, no image download. --all inventories every record from an explicit snapshot; --download-all acquires only the bounded, balanced category/sex batch (1-200), not the entire game. Keep the same catalog/ledger/templates when advancing offset. Resume uses verified asset checkpoints in a new directory. PowerShell 7 (pwsh) is required for HTTP. Headers are checked; full PNG decoding, import and game acceptance remain separate.");
    return;
  }
  const options = {};
  for (const arg of args) {
    const match = /^--(previous|targets|out|catalog|installed-ledger|local-templates|batch-size|offset|resume)=(.+)$/.exec(arg);
    if (match && !options[match[1]]) options[match[1]] = match[2];
    else if (arg === "--download-targets" && !options.downloadTargets) options.downloadTargets = true;
    else if (arg === "--all" && !options.all) options.all = true;
    else if (arg === "--download-all" && !options.downloadAll) options.downloadAll = true;
    else throw new Error("Unknown or duplicate option: " + arg);
  }
  const output = resolve(options.out ?? join(project, "runtime", "official-diy", new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8)));
  const relation = relative(repo, output);
  if (relation === "" || (relation !== ".." && !relation.startsWith(".." + sep) && !isAbsolute(relation))) throw new Error("Raw official resources must stay outside the source repository");
  if (options.all) {
    if (!options.catalog || options.previous || options.targets || options.downloadTargets) throw new Error("--all requires --catalog and cannot mix legacy target options");
    if (options.resume && !options.downloadAll) throw new Error("--resume requires --download-all");
    const records = JSON.parse(await readFile(resolve(options.catalog), "utf8"));
    const installedLedger = options["installed-ledger"] ? JSON.parse(await readFile(resolve(options["installed-ledger"]), "utf8")) : null;
    let localTemplates = [];
    if (options["local-templates"]) { const bytes = await readFile(resolve(options["local-templates"])); localTemplates = JSON.parse((bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8")); }
    const report = await acquireCatalogBatch({ output, records, installedLedger, localTemplates, download: Boolean(options.downloadAll), offset: options.offset === undefined ? 0 : Number(options.offset), batchSize: options["batch-size"] === undefined ? 12 : Number(options["batch-size"]), resume: options.resume ? resolve(options.resume) : null });
    console.log(JSON.stringify({ output, records: report.records, inventoryCounts: report.inventoryCounts, selection: report.selection, assets: report.assets.length, assetErrors: report.assetErrors.length, completeHeaderSets: report.completeHeaderSets, gameAssetsImported: false }));
    if (report.assetErrors.length) process.exitCode = 1;
    return;
  }
  if (options.catalog || options["installed-ledger"] || options["local-templates"] || options["batch-size"] || options.offset || options.resume || options.downloadAll) throw new Error("Catalog batch options require --all");
  const previous = options.previous ? JSON.parse(await readFile(resolve(options.previous), "utf8")) : [];
  const targets = options.targets ? parseTargetsCsv(await readFile(resolve(options.targets), "utf8")) : [];
  const report = await acquireOfficial({ output, previous, targets, downloadTargets: Boolean(options.downloadTargets) });
  console.log(JSON.stringify({ output, records: report.records, difference: report.difference, matched: report.targets.filter(target => target.status === "matched").length, ambiguous: report.targets.filter(target => target.status === "ambiguous").length, assets: report.assets.length, assetErrors: report.assetErrors.length, gameAssetsImported: false }));
  if (report.assetErrors.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
