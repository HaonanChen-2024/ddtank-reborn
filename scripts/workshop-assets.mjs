#!/usr/bin/env node
// Restore only launch-critical public LFS assets into a verified staging directory.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = resolve(repo, "..", "..", "runtime", "lfs-stage");
const prefixes = ["apps/api/assets/flash/", "apps/client-harness/public/ruffle/"];
const args = process.argv.slice(2);
const sourceRef = args.find((arg) => arg.startsWith("--ref="))?.slice(6) ?? "b7f43b3528984da3fee5a52158f1ef6104f23136";
const selectedName = args.find((arg) => arg.startsWith("--file="))?.slice(7);
const verifyOnly = args.includes("--verify-only");
if (!/^[a-f0-9]{40}$/i.test(sourceRef)) throw new Error("--ref requires the upstream 40-character commit SHA");
for (const arg of args) {
  if (!arg.startsWith("--ref=") && !arg.startsWith("--file=") && arg !== "--verify-only") throw new Error(`unknown option: ${arg}`);
}
const manifest = JSON.parse(execFileSync("git", ["lfs", "ls-files", "--json"], { cwd: repo, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }));
const files = manifest.files.filter((file) => prefixes.some((prefix) => file.name.startsWith(prefix)) && (!selectedName || file.name === selectedName));
if (!files.length) throw new Error("no matching launch-critical LFS files");
for (const file of files) {
  const destination = resolve(stage, file.name);
  const rel = relative(stage, destination);
  if (rel.startsWith(`..${sep}`) || rel === ".." || file.name.split(/[\\/]/).some((segment) => segment === "..")) throw new Error(`unsafe asset path: ${file.name}`);
  if (file.oid_type !== "sha256" || !/^[a-f0-9]{64}$/i.test(file.oid) || !Number.isSafeInteger(file.size) || file.size < 1) throw new Error(`invalid LFS metadata: ${file.name}`);
}

async function verified(file) {
  const destination = join(stage, file.name);
  if (!existsSync(destination) || (await stat(destination)).size !== file.size) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(destination)) hash.update(chunk);
  return hash.digest("hex") === file.oid;
}

async function download(file) {
  const destination = join(stage, file.name);
  const partial = `${destination}.partial-${process.pid}`;
  await mkdir(dirname(destination), { recursive: true });
  const url = `https://media.githubusercontent.com/media/thurdev/ddtank-reborn/${sourceRef}/${file.name.split("/").map(encodeURIComponent).join("/")}`;
  try {
    // Large WASM files can stream slowly from the public CDN even after headers arrive.
    const response = await fetch(url, { signal: AbortSignal.timeout(file.size >= 10 * 1024 * 1024 ? 900_000 : 300_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const inspect = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > file.size) return callback(new Error("LFS size exceeded"));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), inspect, createWriteStream(partial, { flags: "wx" }));
    if (bytes !== file.size || hash.digest("hex") !== file.oid) throw new Error("LFS size/SHA256 mismatch");
    await rename(partial, destination);
  } finally { await rm(partial, { force: true }); }
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
  while (next < files.length) {
    const file = files[next++];
    try {
      const alreadyVerified = await verified(file);
      if (!alreadyVerified) {
        if (verifyOnly) throw new Error("stage missing or hash differs");
        await download(file);
      }
      results.push({ name: file.name, size: file.size, sha256: file.oid, status: alreadyVerified ? "already-verified" : "downloaded-verified" });
    } catch (error) {
      results.push({ name: file.name, status: "failed", error: error.message });
      console.error(`failed: ${file.name} (${error.message})`);
    }
  }
}));
const summary = {
  sourceRef,
  targetCount: files.length,
  downloaded: results.filter((file) => file.status === "downloaded-verified").length,
  alreadyVerified: results.filter((file) => file.status === "already-verified").length,
  failed: results.filter((file) => file.status === "failed").length,
};
await mkdir(stage, { recursive: true });
await writeFile(join(stage, selectedName ? "single-file-report.json" : "asset-report.json"), JSON.stringify({ ...summary, checkedAt: new Date().toISOString(), stage, files: results }, null, 2));
console.log(JSON.stringify(summary));
if (summary.failed) process.exitCode = 1;
