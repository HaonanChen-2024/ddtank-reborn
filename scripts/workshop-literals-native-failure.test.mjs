import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

// Run the actual installer with in-memory I/O. Only module syntax and unrelated
// SWF builders are substituted; no install, rollback, or cleanup logic is copied.
const installerSource = readFileSync(new URL("./workshop-literals.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/^export /gm, "")
  .replace(/^const repo = .*;$/m, 'const repo = "unused-test-default";')
  .replace(/if \(process\.argv\[1\][\s\S]*$/, "");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const assetNames = ["MagicClothList.decoded.xml", "WorkshopNativeWardrobeBootstrap.swf",
  "magicwardrobe-original-library.swf", "magicwardrobe_v3_6_1_u1.swf",
  "magicwardrobe_v3_6_1_u1.ui", "shared-art.swf"];
const coreNames = ["2.png", "3.png", "DDT_Loading.swf"];

function fixture() {
  // These paths are map keys only. No real filesystem writes are exposed to VM.
  const repoRoot = path.resolve("memory-only-native-test/repo");
  const runtimeRoot = path.resolve("memory-only-native-test/runtime");
  const buildRoot = path.resolve("memory-only-native-test/build");
  const overlay = path.join(runtimeRoot, "client-overlay");
  const ledger = path.join(runtimeRoot, "client-overlay-literals.json");
  const manifestPath = path.join(buildRoot, "manifest.json");
  const files = new Map(), handles = new Map();
  let nextInode = 1, nextFd = 100, fault = null;
  const ioError = (code, file) => Object.assign(new Error(`${code}: injected or missing ${file}`), { code });
  const key = file => path.resolve(file);
  const put = (file, bytes) => {
    file = key(file);
    files.set(file, { bytes: Buffer.from(bytes), ino: files.get(file)?.ino ?? nextInode++ });
  };
  const get = file => {
    file = key(file);
    const value = files.get(file);
    if (!value) throw ioError("ENOENT", file);
    return value;
  };
  const trip = (operation, file) => {
    if (!fault || fault.operation !== operation || fault.file !== key(file) || fault.count) return false;
    fault.count++;
    return true;
  };
  const stat = file => ({ size: get(file).bytes.length, ino: get(file).ino, dev: 1,
    isFile: () => true, isDirectory: () => false });
  const fs = {
    existsSync: file => files.has(key(file)),
    mkdirSync: () => {},
    statSync: stat,
    lstatSync: stat,
    fstatSync: fd => stat(handles.get(fd).file),
    openSync(file, flags) {
      file = key(file);
      if (flags.includes("x") && files.has(file)) throw ioError("EEXIST", file);
      if (flags.includes("w")) put(file, Buffer.alloc(0)); else get(file);
      const fd = nextFd++;
      handles.set(fd, { file, position: 0 });
      return fd;
    },
    closeSync(fd) { assert.ok(handles.delete(fd), "unknown in-memory file descriptor"); },
    readFileSync(file, encoding) {
      const bytes = get(typeof file === "number" ? handles.get(file).file : file).bytes;
      return encoding ? bytes.toString(typeof encoding === "string" ? encoding : encoding.encoding) : Buffer.from(bytes);
    },
    writeSync(fd, bytes, offset = 0, length = bytes.length - offset, position = null) {
      const handle = handles.get(fd);
      assert.ok(handle, "unknown in-memory file descriptor");
      const failed = trip("write", handle.file);
      const source = Buffer.from(bytes).subarray(offset, offset + (failed ? Math.min(3, length) : length));
      const start = position ?? handle.position, old = get(handle.file).bytes;
      const next = Buffer.alloc(Math.max(old.length, start + source.length));
      old.copy(next); source.copy(next, start); put(handle.file, next);
      if (position == null) handle.position += source.length;
      if (failed) throw ioError("ENOSPC", handle.file);
      return source.length;
    },
    writeFileSync(file, bytes, options = {}) {
      const ownFd = typeof file !== "number";
      const fd = ownFd ? fs.openSync(file, options.flag ?? "w") : file;
      try { fs.writeSync(fd, Buffer.from(bytes)); }
      finally { if (ownFd) fs.closeSync(fd); }
    },
    unlinkSync(file) {
      file = key(file);
      if (trip("unlink", file)) throw ioError("EPERM", file);
      get(file); files.delete(file);
    },
    renameSync(from, to) {
      from = key(from); to = key(to);
      const value = get(from); files.set(to, value); files.delete(from);
    },
  };
  put(path.join(repoRoot, "research/i18n/zh-CN-literals.json"), JSON.stringify({ original: "中文" }));
  put(path.join(repoRoot, "tools/i18n/abc-strings/translations.json"), JSON.stringify({ original: "portuguese" }));
  for (const name of coreNames) put(path.join(overlay, name), `original:${name}`);
  const bridge = Buffer.from("fixture bridge"), bridgePath = path.join(buildRoot, "bridge.bin");
  put(bridgePath, bridge);
  const assets = assetNames.map(file => {
    const bytes = Buffer.from(`fixture resource:${file}`), source = path.join(buildRoot, file);
    put(source, bytes);
    return { file, path: source, urlPath: `/flash/workshop-native/wardrobe/${file}`, bytes: bytes.length, sha256: digest(bytes) };
  });
  put(manifestPath, JSON.stringify({ module: "workshop-native-wardrobe", version: 1,
    bridge: { tagPath: bridgePath, tagSha256: digest(bridge) }, assets }));
  const append = (bytes, suffix) => Buffer.concat([bytes, Buffer.from(suffix)]);
  const context = vm.createContext({ assert, createHash, ...path, Buffer, process: { pid: 777 }, fs, ...fs,
    patchSwfBuffer: bytes => bytes.includes(Buffer.from("|Chinese")) ? { out: bytes, totalChanged: 0 }
      : { out: append(bytes, "|Chinese"), totalChanged: 1 },
    buildActivityEntry: bytes => ({ output: append(bytes, "|activities"), proof: {} }),
    buildNativeWardrobeEntry: bytes => ({ output: append(bytes, "|native"), proof: {} }),
  });
  vm.runInContext(installerSource, context, { filename: "workshop-literals.mjs (memory-fs)" });
  return {
    run: command => context.runLiteralOverlay({ command, repoRoot, runtimeRoot,
      ...(command === "install" ? { nativeWardrobeManifest: manifestPath } : {}) }),
    corePath: name => path.join(overlay, name),
    nativePath: name => path.join(overlay, "workshop-native/wardrobe", name),
    arm(operation, file) { fault = { operation, file: key(file), count: 0 }; },
    get failureCount() { return fault?.count ?? 0; },
    get openHandles() { return handles.size; },
    snapshot: () => [...files].filter(([file]) => file === ledger || file.startsWith(overlay + path.sep))
      .map(([file, value]) => [file, value.bytes.toString("hex")]).sort(([a], [b]) => a.localeCompare(b)),
    fs, put, ledger,
  };
}

test("partial native resource write is cleaned up and the same installation can retry", () => {
  const f = fixture(), before = f.snapshot();
  f.arm("write", f.nativePath("WorkshopNativeWardrobeBootstrap.swf"));
  assert.throws(() => f.run("install"), /ENOSPC/);
  assert.equal(f.failureCount, 1);
  assert.equal(f.openHandles, 0);
  assert.deepEqual(f.snapshot(), before, "failed installation left an unowned partial native resource");
  assert.equal(f.run("install").nativeWardrobeInstalled, true);
  assert.equal(f.fs.existsSync(f.ledger), true);
  for (const name of assetNames) assert.ok(f.fs.readFileSync(f.nativePath(name)).length > 3);
});

test("native unlink failure compensates rollback and a later rollback restores the complete original", () => {
  const f = fixture(), original = f.snapshot();
  assert.equal(f.run("install").nativeWardrobeInstalled, true);
  const installed = f.snapshot();
  f.arm("unlink", f.nativePath("WorkshopNativeWardrobeBootstrap.swf"));
  assert.throws(() => f.run("rollback"), /EPERM/);
  assert.equal(f.failureCount, 1);
  assert.equal(f.openHandles, 0);
  assert.deepEqual(f.snapshot(), installed, "failed rollback left files disagreeing with its retained ledger");
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("partial replacement temporary file is removed before installation is retried", () => {
  const f = fixture(), before = f.snapshot();
  f.arm("write", f.corePath("2.png") + ".workshop-777");
  assert.throws(() => f.run("install"), /ENOSPC/);
  assert.equal(f.failureCount, 1);
  assert.equal(f.openHandles, 0);
  assert.deepEqual(f.snapshot(), before, "failed replacement left temporary files or native resources");
  assert.equal(f.run("install").nativeWardrobeInstalled, true);
  assert.equal(f.fs.existsSync(f.corePath("2.png") + ".workshop-777"), false);
});

test("an existing native target is preserved when installation is refused", () => {
  const f = fixture();
  f.put(f.nativePath("WorkshopNativeWardrobeBootstrap.swf"), "not owned by this installation");
  const before = f.snapshot();
  assert.throws(() => f.run("install"), /existing native asset preserved|EEXIST/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.openHandles, 0);
});
