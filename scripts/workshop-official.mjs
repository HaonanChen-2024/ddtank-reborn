#!/usr/bin/env node
// Public DIY catalog snapshots and explicitly selected assets; never imports into the game.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
    console.log("node scripts/workshop-official.mjs [--previous=<catalog.json>] [--targets=<目标时装.csv>] [--download-targets] [--out=<new-directory>]\nDefault: fresh six-category catalog + diff, no image download. Asset download only follows unambiguous explicit targets. PowerShell 7 (pwsh) is required. Raw files stay outside Git; headers are checked, full PNG decoding and game acceptance are separate.");
    return;
  }
  const options = {};
  for (const arg of args) {
    const match = /^--(previous|targets|out)=(.+)$/.exec(arg);
    if (match && !options[match[1]]) options[match[1]] = match[2];
    else if (arg === "--download-targets" && !options.downloadTargets) options.downloadTargets = true;
    else throw new Error("Unknown or duplicate option: " + arg);
  }
  const output = resolve(options.out ?? join(project, "runtime", "official-diy", new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8)));
  const relation = relative(repo, output);
  if (relation === "" || (relation !== ".." && !relation.startsWith(".." + sep) && !isAbsolute(relation))) throw new Error("Raw official resources must stay outside the source repository");
  const previous = options.previous ? JSON.parse(await readFile(resolve(options.previous), "utf8")) : [];
  const targets = options.targets ? parseTargetsCsv(await readFile(resolve(options.targets), "utf8")) : [];
  const report = await acquireOfficial({ output, previous, targets, downloadTargets: Boolean(options.downloadTargets) });
  console.log(JSON.stringify({ output, records: report.records, difference: report.difference, matched: report.targets.filter(target => target.status === "matched").length, ambiguous: report.targets.filter(target => target.status === "ambiguous").length, assets: report.assets.length, assetErrors: report.assetErrors.length, gameAssetsImported: false }));
  if (report.assetErrors.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
