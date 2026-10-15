import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
  const context = vm.createContext({ assert, createHash, randomUUID, ...path, Buffer, process: { pid: 777 }, fs, ...fs,
    Date: class extends Date { static now() { return 12345; } }, // Failed installs may retry within the same millisecond.
    patchSwfBuffer: bytes => bytes.includes(Buffer.from("|Chinese")) ? { out: bytes, totalChanged: 0 }
      : { out: append(bytes, "|Chinese"), totalChanged: 1 },
    buildActivityEntry: bytes => ({ output: append(bytes, "|activities"), proof: {} }),
    buildNativeWardrobeEntry: (bytes, tag) => ({ output: append(bytes, "|native:" + digest(tag)), proof: {} }),
  });
  vm.runInContext(installerSource, context, { filename: "workshop-literals.mjs (memory-fs)" });
  return {
    run: (command, candidate) => context.runLiteralOverlay({ command, repoRoot, runtimeRoot,
      ...(candidate || command === "install" ? { nativeWardrobeManifest: candidate ?? manifestPath } : {}) }),
    upgradedBuild(withMines = false, withDDPlay = false, withGypsy = false, withMoonlight = false, withTreasure = false, withPurr = false, withCarnival = false, withFirstRecharge = false, withCharge = false, withForthright = false, withExchange = false, withDevil = false, withCaveLoot = false) {
      assert.ok(!withDDPlay || withMines);
      assert.ok(!withGypsy || withDDPlay);
      assert.ok(!withMoonlight || withGypsy);
      assert.ok(!withTreasure || withMoonlight);
      assert.ok(!withPurr || withTreasure);
      assert.ok(!withCarnival || withPurr);
      assert.ok(!withFirstRecharge || withCarnival);
      assert.ok(!withCharge || withFirstRecharge);
      assert.ok(!withForthright || withCharge);
      assert.ok(!withExchange || withForthright);
      assert.ok(!withDevil || withExchange);
      assert.ok(!withCaveLoot || withDevil);
      const root = path.resolve("memory-only-native-test/upgraded" + (withMines ? "-mines" : "") + (withDDPlay ? "-ddplay" : "") + (withGypsy ? "-gypsy" : "") + (withMoonlight ? "-moonlight" : "") + (withTreasure ? "-treasure" : "") + (withPurr ? "-purr" : "") + (withCarnival ? "-carnival" : "") + (withFirstRecharge ? "-first-recharge" : "") + (withCharge ? "-charge" : "") + (withForthright ? "-forthright" : "") + (withExchange ? "-exchange" : "") + (withDevil ? "-devil" : "") + (withCaveLoot ? "-caveloot" : "")),
        tag = Buffer.from(withCaveLoot ? "new caveloot bridge" : withDevil ? "new devil bridge" : withExchange ? "new exchange bridge" : withForthright ? "new forthright bridge" : withCharge ? "new charge bridge" : withFirstRecharge ? "new first recharge bridge" : withCarnival ? "new carnival bridge" : withPurr ? "new purr bridge" : withTreasure ? "new treasure bridge" : withMoonlight ? "new moonlight bridge" : withGypsy ? "new gypsy bridge" : withDDPlay ? "new ddplay bridge" : withMines ? "new mines bridge" : "new shared bridge");
      const tagPath = path.join(root, "bridge.bin"); put(tagPath, tag);
      const nextAssets = [...assetNames.map(file => ["wardrobe", file]), ["shared", "native-shared-library.swf"],
        ...["WorkshopNativePairBootstrap.swf", "pair-original-library.swf", "pairbox_v3_6_1_u1.swf", "pairbox_v3_6_1_u1.ui",
          ...[88, 94, 188, 105, 93, 57, 56].map(id => `pair-shared-art-${id}.swf`)].map(file => ["pair", file])]
        .concat(withMines ? ["WorkshopNativeMinesBootstrap.swf", "mines-original-library.swf", "boguadventure_v3_6_1_u1.swf",
          "boguadventure_v3_6_1_u1.ui", "bogu-styles.xml", "bogu-player-game.png"].map(file => ["mines", file]) : [])
        .concat(withDDPlay ? ["WorkshopNativeDDPlayBootstrap.swf", "ddplay-original-library.swf", "ddplay_v3_6_1_u1.swf",
          "ddplay-styles.xml"].map(file => ["ddplay", file]) : [])
        .concat(withGypsy ? ["WorkshopNativeGypsyBootstrap.swf", "gypsy-original-library.swf", "gypsyshop_v3_6_1_u1.swf",
          "gypsy-styles.xml"].map(file => ["gypsy", file]) : [])
        .concat(withMoonlight ? ["WorkshopNativeMoonlightBootstrap.swf", "moonlight-original-library.swf", "moonlighttreasure_v3_6_1_u1.swf",
          "moonlighttreasure_v3_6_1_u1.ui"].map(file => ["moonlight", file]) : [])
        .concat(withTreasure ? ["WorkshopNativeTreasureBootstrap.swf", "treasure-original-library.swf", "treasurehunting_v3_6_1_u1.swf",
          "treasurehunting_v3_6_1_u1.ui", "treasure-styles.xml"].map(file => ["treasure", file]) : [])
        .concat(withPurr ? ["WorkshopNativePurrBootstrap.swf", "purr-original-library.swf", "purrturntable_v3_6_1_u1.swf", "purrturntable_v3_6_1_u1.ui"].map(file => ["purr", file]) : [])
        .concat(withCarnival ? ["WorkshopNativeCarnivalBootstrap.swf", "carnival-original-library.swf", "carnival_v3_6_1_u1.swf", "carnival_v3_6_1_u1.ui"].map(file => ["carnival", file]) : [])
        .concat(withFirstRecharge ? ["WorkshopNativeFirstRechargeBootstrap.swf", "first-recharge-original-library.swf", "firstrecharge_v3_6_1_u1.swf", "firstrecharge_v3_6_1_u1.ui"].map(file => ["first-recharge", file]) : [])
        .concat(withCharge ? ["WorkshopNativeChargeBootstrap.swf", "charge-original-library.swf", "chargeactivity_v3_6_1_u1.swf", "chargeactivity_v3_6_1_u1.ui"].map(file => ["charge", file]) : [])
        .concat(withForthright ? ["WorkshopNativeForthrightBootstrap.swf", "forthright-original-library.swf", "forthrightactive_v3_6_1_u1.swf", "forthrightactive_v3_6_1_u1.ui"].map(file => ["forthright", file]) : [])
        .concat(withExchange ? ["WorkshopNativeExchangeBootstrap.swf", "exchange-original-library.swf", "exchange-original-art.swf", "exchange-styles.xml"].map(file => ["exchange", file]) : [])
        .concat(withDevil ? ["WorkshopNativeDevilBootstrap.swf", "devil-original-library.swf", "devilturn_v3_6_1_u1.swf", "devilturn.ui"].map(file => ["devil", file]) : [])
        .concat(withCaveLoot ? ["WorkshopNativeCaveLootBootstrap.swf", "caveloot-original-library.swf", "caveloot.swf", "caveloot.ui"].map(file => ["caveloot", file]) : [])
        .map(([module, file]) => {
          const bytes = Buffer.from(`upgraded resource:${module}/${file}`), source = path.join(root, module, file);
          put(source, bytes);
          return { file, path: source, urlPath: `/flash/workshop-native/${module}/${file}`, bytes: bytes.length, sha256: digest(bytes) };
        });
      const nextPath = path.join(root, "manifest.json");
      put(nextPath, JSON.stringify({ module: "workshop-native-activities", version: 1,
        ...(withMines ? { variant: withCaveLoot ? "wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr-carnival-first-recharge-charge-forthright-exchange-devil-caveloot" : withDevil ? "wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr-carnival-first-recharge-charge-forthright-exchange-devil" : withExchange ? "wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr-carnival-first-recharge-charge-forthright-exchange" : withForthright ? "wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr-carnival-first-recharge-charge-forthright" : withCharge ? "wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr-carnival-first-recharge-charge" : withFirstRecharge ? "wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr-carnival-first-recharge" : withCarnival ? "wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr-carnival" : withPurr ? "wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr" : withTreasure ? "wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure" : withMoonlight ? "wardrobe-pair-mines-ddplay-gypsy-moonlight" : withGypsy ? "wardrobe-pair-mines-ddplay-gypsy" : withDDPlay ? "wardrobe-pair-mines-ddplay" : "wardrobe-pair-mines" } : {}),
        bridge: { tagPath, tagSha256: digest(tag) }, assets: nextAssets }));
      return nextPath;
    },
    corePath: name => path.join(overlay, name),
    nativePath: name => path.join(overlay, "workshop-native/wardrobe", name),
    minesPath: name => path.join(overlay, "workshop-native/mines", name),
    ddplayPath: name => path.join(overlay, "workshop-native/ddplay", name),
    gypsyPath: name => path.join(overlay, "workshop-native/gypsy", name),
    moonlightPath: name => path.join(overlay, "workshop-native/moonlight", name),
    purrPath: name => path.join(overlay, "workshop-native/purr", name),
    carnivalPath: name => path.join(overlay, "workshop-native/carnival", name),
    firstRechargePath: name => path.join(overlay, "workshop-native/first-recharge", name),
    chargePath: name => path.join(overlay, "workshop-native/charge", name),
    forthrightPath: name => path.join(overlay, "workshop-native/forthright", name),
    exchangePath: name => path.join(overlay, "workshop-native/exchange", name),
    devilPath: name => path.join(overlay, "workshop-native/devil", name),
    cavelootPath: name => path.join(overlay, "workshop-native/caveloot", name),
    treasurePath: name => path.join(overlay, "workshop-native/treasure", name),
    sharedPath: path.join(overlay, "workshop-native/shared/native-shared-library.swf"),
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

test("explicit native upgrade verifies the old bridge then preserves the new package on later commands", () => {
  const f = fixture(); f.run("install");
  const before = f.snapshot(), candidate = f.upgradedBuild();
  assert.equal(f.run("verify", candidate).pendingTransition, true);
  assert.equal(f.run("verify", candidate).nativeWardrobeInstalled, false);
  assert.deepEqual(f.snapshot(), before, "dry upgrade changed files");
  assert.equal(f.run("install", candidate).unchanged, false);
  assert.equal(f.run("install", candidate).unchanged, true);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.fs.existsSync(f.sharedPath), true);
  assert.equal(JSON.parse(f.fs.readFileSync(f.ledger, "utf8")).nativeWardrobe.manifestPath, candidate);
});

test("partial owned native replacement during upgrade restores old resources and ledger", () => {
  const f = fixture(); f.run("install");
  const before = f.snapshot(), candidate = f.upgradedBuild();
  f.arm("write", f.nativePath("WorkshopNativeWardrobeBootstrap.swf") + ".workshop-777");
  assert.throws(() => f.run("install", candidate), /ENOSPC/);
  assert.equal(f.failureCount, 1); assert.equal(f.openHandles, 0);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.run("install", candidate).nativeWardrobeInstalled, true);
});

test("core or ledger upgrade failure restores changed and newly added native assets", () => {
  for (const ledgerFault of [false, true]) {
    const f = fixture(); f.run("install");
    const before = f.snapshot(), candidate = f.upgradedBuild();
    f.arm("write", (ledgerFault ? f.ledger : f.corePath("2.png")) + ".workshop-777");
    assert.throws(() => f.run("install", candidate), /ENOSPC/);
    assert.equal(f.failureCount, 1); assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before, "failed upgrade left old ledger with new assets");
    assert.equal(f.run("install", candidate).unchanged, false);
  }
});

test("upgrade refuses foreign changes in an old resource or new destination before writes", () => {
  for (const oldTarget of [false, true]) {
    const f = fixture(); f.run("install");
    const candidate = f.upgradedBuild();
    f.put(oldTarget ? f.nativePath("WorkshopNativeWardrobeBootstrap.swf") : f.sharedPath, "foreign bytes");
    const before = f.snapshot();
    assert.throws(() => f.run("install", candidate), /changed native activity asset preserved|existing native asset preserved/);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("old six and eighteen resources upgrade to the fixed twenty-four resource mines variant", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install");
  f.run("install", f.upgradedBuild());
  const mines = f.upgradedBuild(true);
  assert.equal(f.run("verify", mines).nativeWardrobeInstalled, false);
  assert.equal(f.run("install", mines).nativeWardrobe.assets.length, 24);
  assert.equal(f.run("install", mines).unchanged, true);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.fs.existsSync(f.minesPath("bogu-player-game.png")), true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("partial mines resource writes restore the previous eighteen-resource install for an exact retry", () => {
  const f = fixture();
  f.run("install"); f.run("install", f.upgradedBuild());
  const before = f.snapshot(), mines = f.upgradedBuild(true);
  f.arm("write", f.minesPath("WorkshopNativeMinesBootstrap.swf"));
  assert.throws(() => f.run("install", mines), /ENOSPC/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.openHandles, 0);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.run("install", mines).nativeWardrobe.assets.length, 24);
});

test("interrupted mines rollback compensates the full owned package before retry", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install", f.upgradedBuild(true));
  const installed = f.snapshot();
  f.arm("unlink", f.minesPath("bogu-player-game.png"));
  assert.throws(() => f.run("rollback"), /EPERM/);
  assert.deepEqual(f.snapshot(), installed);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("unknown native variants and foreign mines destinations are refused without replacing owned files", () => {
  for (const reason of ["variant", "foreign"]) {
    const f = fixture(); f.run("install");
    const mines = f.upgradedBuild(true);
    if (reason === "variant") {
      const manifest = JSON.parse(f.fs.readFileSync(mines, "utf8"));
      manifest.variant = "unknown";
      f.put(mines, JSON.stringify(manifest));
    } else f.put(f.minesPath("bogu-styles.xml"), "user owned");
    const before = f.snapshot();
    assert.throws(() => f.run("install", mines), /unknown native activity variant|existing native asset preserved/);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("six, eighteen and twenty-four asset installs upgrade to fixed twenty-eight asset DDPlay", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install"); f.run("install", f.upgradedBuild()); f.run("install", f.upgradedBuild(true));
  const ddplay = f.upgradedBuild(true, true);
  assert.equal(f.run("verify", ddplay).nativeWardrobeInstalled, false);
  assert.equal(f.run("install", ddplay).nativeWardrobe.assets.length, 28);
  assert.equal(f.run("install", ddplay).unchanged, true);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.fs.existsSync(f.ddplayPath("ddplay-styles.xml")), true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("partial DDPlay writes restore the owned twenty-four asset package before exact retry", () => {
  for (const file of ["WorkshopNativeDDPlayBootstrap.swf", "ddplay-styles.xml"]) {
    const f = fixture(); f.run("install", f.upgradedBuild(true));
    const before = f.snapshot(), ddplay = f.upgradedBuild(true, true);
    f.arm("write", f.ddplayPath(file));
    assert.throws(() => f.run("install", ddplay), /ENOSPC/);
    assert.equal(f.failureCount, 1); assert.equal(f.openHandles, 0); assert.deepEqual(f.snapshot(), before);
    assert.equal(f.run("verify").unchanged, true);
    assert.equal(f.run("install", ddplay).nativeWardrobe.assets.length, 28);
  }
});

test("DDPlay rollback failure compensates the full twenty-eight asset receipt", () => {
  const f = fixture(), original = f.snapshot(); f.run("install", f.upgradedBuild(true, true));
  const installed = f.snapshot(); f.arm("unlink", f.ddplayPath("ddplay_v3_6_1_u1.swf"));
  assert.throws(() => f.run("rollback"), /EPERM/);
  assert.deepEqual(f.snapshot(), installed); assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.run("rollback").rolledBack, true); assert.deepEqual(f.snapshot(), original);
});

test("unknown or shortened DDPlay manifests and foreign destinations are refused before mutation", () => {
  for (const reason of ["variant", "paths", "foreign"]) {
    const f = fixture(); f.run("install", f.upgradedBuild(true));
    const ddplay = f.upgradedBuild(true, true), manifest = JSON.parse(f.fs.readFileSync(ddplay, "utf8"));
    if (reason === "variant") manifest.variant = "wardrobe-pair-mines-ddplay-extra";
    if (reason === "paths") manifest.assets.pop();
    if (reason === "foreign") f.put(f.ddplayPath("ddplay-styles.xml"), "user owned");
    else f.put(ddplay, JSON.stringify(manifest));
    const before = f.snapshot(); assert.throws(() => f.run("install", ddplay));
    assert.deepEqual(f.snapshot(), before);
  }
});

test("old6 through the previous variants upgrades to exact thirty-two assets and rolls back", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install"); f.run("install", f.upgradedBuild()); f.run("install", f.upgradedBuild(true));
  f.run("install", f.upgradedBuild(true, true));
  const gypsy = f.upgradedBuild(true, true, true);
  assert.equal(f.run("verify", gypsy).nativeWardrobeInstalled, false);
  assert.equal(f.run("install", gypsy).nativeWardrobe.assets.length, 32);
  assert.equal(f.run("install", gypsy).unchanged, true);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.fs.existsSync(f.gypsyPath("gypsy-styles.xml")), true);
  assert.equal(f.run("rollback").rolledBack, true); assert.deepEqual(f.snapshot(), original);
});

test("partial Gypsy resource writes restore the prior twenty-eight asset receipt and allow retry", () => {
  for (const file of ["WorkshopNativeGypsyBootstrap.swf", "gypsy-styles.xml"]) {
    const f = fixture(); f.run("install", f.upgradedBuild(true, true));
    const before = f.snapshot(), gypsy = f.upgradedBuild(true, true, true);
    f.arm("write", f.gypsyPath(file));
    assert.throws(() => f.run("install", gypsy), /ENOSPC/);
    assert.equal(f.failureCount, 1); assert.equal(f.openHandles, 0); assert.deepEqual(f.snapshot(), before);
    assert.equal(f.run("verify").unchanged, true);
    assert.equal(f.run("install", gypsy).nativeWardrobe.assets.length, 32);
  }
});

test("Gypsy rollback failure compensates the full thirty-two asset receipt", () => {
  const f = fixture(), original = f.snapshot(); f.run("install", f.upgradedBuild(true, true, true));
  const installed = f.snapshot(); f.arm("unlink", f.gypsyPath("gypsyshop_v3_6_1_u1.swf"));
  assert.throws(() => f.run("rollback"), /EPERM/);
  assert.deepEqual(f.snapshot(), installed); assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.run("rollback").rolledBack, true); assert.deepEqual(f.snapshot(), original);
});

test("unknown or shortened Gypsy manifests and foreign destinations are refused before mutation", () => {
  for (const reason of ["variant", "paths", "foreign"]) {
    const f = fixture(); f.run("install", f.upgradedBuild(true, true));
    const gypsy = f.upgradedBuild(true, true, true), manifest = JSON.parse(f.fs.readFileSync(gypsy, "utf8"));
    if (reason === "variant") manifest.variant = "wardrobe-pair-mines-ddplay-gypsy-extra";
    if (reason === "paths") manifest.assets.pop();
    if (reason === "foreign") f.put(f.gypsyPath("gypsy-styles.xml"), "user owned");
    else f.put(gypsy, JSON.stringify(manifest));
    const before = f.snapshot(); assert.throws(() => f.run("install", gypsy));
    assert.deepEqual(f.snapshot(), before);
  }
});

test("old6 through the previous variants upgrades to exact thirty-six assets and rolls back", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install"); f.run("install", f.upgradedBuild()); f.run("install", f.upgradedBuild(true));
  f.run("install", f.upgradedBuild(true, true, true));
  const moonlight = f.upgradedBuild(true, true, true, true);
  assert.equal(f.run("verify", moonlight).nativeWardrobeInstalled, false);
  assert.equal(f.run("install", moonlight).nativeWardrobe.assets.length, 36);
  assert.equal(f.run("install", moonlight).unchanged, true);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.fs.existsSync(f.moonlightPath("moonlighttreasure_v3_6_1_u1.ui")), true);
  assert.equal(f.run("rollback").rolledBack, true); assert.deepEqual(f.snapshot(), original);
});

test("partial Moonlight resource writes restore the prior thirty-two asset receipt and allow retry", () => {
  for (const file of ["WorkshopNativeMoonlightBootstrap.swf", "moonlighttreasure_v3_6_1_u1.ui"]) {
    const f = fixture(); f.run("install", f.upgradedBuild(true, true, true));
    const before = f.snapshot(), moonlight = f.upgradedBuild(true, true, true, true);
    f.arm("write", f.moonlightPath(file));
    assert.throws(() => f.run("install", moonlight), /ENOSPC/);
    assert.equal(f.failureCount, 1); assert.equal(f.openHandles, 0); assert.deepEqual(f.snapshot(), before);
    assert.equal(f.run("verify").unchanged, true);
    assert.equal(f.run("install", moonlight).nativeWardrobe.assets.length, 36);
  }
});

test("Moonlight rollback failure compensates the full thirty-six asset receipt", () => {
  const f = fixture(), original = f.snapshot(); f.run("install", f.upgradedBuild(true, true, true, true));
  const installed = f.snapshot(); f.arm("unlink", f.moonlightPath("moonlighttreasure_v3_6_1_u1.swf"));
  assert.throws(() => f.run("rollback"), /EPERM/);
  assert.deepEqual(f.snapshot(), installed); assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.run("rollback").rolledBack, true); assert.deepEqual(f.snapshot(), original);
});

test("unknown or shortened Moonlight manifests and foreign destinations are refused before mutation", () => {
  for (const reason of ["variant", "paths", "foreign"]) {
    const f = fixture(); f.run("install", f.upgradedBuild(true, true, true));
    const moonlight = f.upgradedBuild(true, true, true, true), manifest = JSON.parse(f.fs.readFileSync(moonlight, "utf8"));
    if (reason === "variant") manifest.variant = "wardrobe-pair-mines-ddplay-moonlight-extra";
    if (reason === "paths") manifest.assets.pop();
    if (reason === "foreign") f.put(f.moonlightPath("moonlighttreasure_v3_6_1_u1.ui"), "user owned");
    else f.put(moonlight, JSON.stringify(manifest));
    const before = f.snapshot(); assert.throws(() => f.run("install", moonlight));
    assert.deepEqual(f.snapshot(), before);
  }
});

test("old6 through previous variants upgrades to exact forty-one assets and fully rolls back", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install"); f.run("install", f.upgradedBuild()); f.run("install", f.upgradedBuild(true));
  f.run("install", f.upgradedBuild(true, true, true)); f.run("install", f.upgradedBuild(true, true, true, true));
  const treasure = f.upgradedBuild(true, true, true, true, true);
  assert.equal(f.run("verify", treasure).nativeWardrobeInstalled, false);
  assert.equal(f.run("install", treasure).nativeWardrobe.assets.length, 41);
  assert.equal(f.run("install", treasure).unchanged, true); assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.fs.existsSync(f.treasurePath("treasure-styles.xml")), true);
  assert.equal(f.run("rollback").rolledBack, true); assert.deepEqual(f.snapshot(), original);
});
test("partial Treasure writes restore the thirty-six asset baseline before exact retry", () => {
  for (const file of ["WorkshopNativeTreasureBootstrap.swf", "treasure-styles.xml"]) {
    const f = fixture(); f.run("install", f.upgradedBuild(true, true, true, true));
    const before = f.snapshot(), treasure = f.upgradedBuild(true, true, true, true, true);
    f.arm("write", f.treasurePath(file)); assert.throws(() => f.run("install", treasure), /ENOSPC/);
    assert.equal(f.failureCount, 1); assert.equal(f.openHandles, 0); assert.deepEqual(f.snapshot(), before);
    assert.equal(f.run("verify").unchanged, true); assert.equal(f.run("install", treasure).nativeWardrobe.assets.length, 41);
  }
});
test("Treasure rollback failure compensates every owned asset and supports full retry", () => {
  const f = fixture(), original = f.snapshot(); f.run("install", f.upgradedBuild(true, true, true, true, true));
  const installed = f.snapshot(); f.arm("unlink", f.treasurePath("treasurehunting_v3_6_1_u1.swf"));
  assert.throws(() => f.run("rollback"), /EPERM/); assert.deepEqual(f.snapshot(), installed);
  assert.equal(f.run("verify").unchanged, true); assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});
test("unknown or short Treasure manifests and foreign destinations fail without mutation", () => {
  for (const reason of ["variant", "paths", "foreign"]) {
    const f = fixture(); f.run("install", f.upgradedBuild(true, true, true, true));
    const treasure = f.upgradedBuild(true, true, true, true, true), manifest = JSON.parse(f.fs.readFileSync(treasure, "utf8"));
    if (reason === "variant") manifest.variant = "wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-extra";
    if (reason === "paths") manifest.assets.pop();
    if (reason === "foreign") f.put(f.treasurePath("treasure-styles.xml"), "user owned");
    else f.put(treasure, JSON.stringify(manifest));
    const before = f.snapshot(); assert.throws(() => f.run("install", treasure)); assert.deepEqual(f.snapshot(), before);
  }
});

test("all previous variants upgrade to exact forty-five resources and fully roll back", () => {
 const f=fixture(),original=f.snapshot();f.run("install");f.run("install",f.upgradedBuild());f.run("install",f.upgradedBuild(true));f.run("install",f.upgradedBuild(true,true,true));f.run("install",f.upgradedBuild(true,true,true,true));f.run("install",f.upgradedBuild(true,true,true,true,true));
 const purr=f.upgradedBuild(true,true,true,true,true,true);assert.equal(f.run("verify",purr).nativeWardrobeInstalled,false);
 assert.equal(f.run("install",purr).nativeWardrobe.assets.length,45);assert.equal(f.run("install",purr).unchanged,true);assert.equal(f.run("verify").unchanged,true);
 assert.equal(f.fs.existsSync(f.purrPath("purrturntable_v3_6_1_u1.ui")),true);assert.equal(f.run("rollback").rolledBack,true);assert.deepEqual(f.snapshot(),original);
});
test("partial Purr writes restore the forty-one resource baseline before retry", () => {
 for(const file of ["WorkshopNativePurrBootstrap.swf","purrturntable_v3_6_1_u1.ui"]){
  const f=fixture();f.run("install",f.upgradedBuild(true,true,true,true,true));const before=f.snapshot(),purr=f.upgradedBuild(true,true,true,true,true,true);
  f.arm("write",f.purrPath(file));assert.throws(()=>f.run("install",purr),/ENOSPC/);assert.equal(f.failureCount,1);assert.equal(f.openHandles,0);assert.deepEqual(f.snapshot(),before);
  assert.equal(f.run("verify").unchanged,true);assert.equal(f.run("install",purr).nativeWardrobe.assets.length,45);
 }
});
test("Purr rollback failure compensates forty-five resources and supports retry", () => {
 const f=fixture(),original=f.snapshot();f.run("install",f.upgradedBuild(true,true,true,true,true,true));const installed=f.snapshot();
 f.arm("unlink",f.purrPath("purrturntable_v3_6_1_u1.swf"));assert.throws(()=>f.run("rollback"),/EPERM/);assert.deepEqual(f.snapshot(),installed);
 assert.equal(f.run("verify").unchanged,true);assert.equal(f.run("rollback").rolledBack,true);assert.deepEqual(f.snapshot(),original);
});
test("unknown or short Purr manifests and foreign destinations fail before mutation", () => {
 for(const reason of ["variant","paths","foreign"]){
  const f=fixture();f.run("install",f.upgradedBuild(true,true,true,true,true));const purr=f.upgradedBuild(true,true,true,true,true,true),manifest=JSON.parse(f.fs.readFileSync(purr,"utf8"));
  if(reason==="variant")manifest.variant="wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr-extra";if(reason==="paths")manifest.assets.pop();
  if(reason==="foreign")f.put(f.purrPath("purrturntable_v3_6_1_u1.ui"),"user owned");else f.put(purr,JSON.stringify(manifest));
  const before=f.snapshot();assert.throws(()=>f.run("install",purr));assert.deepEqual(f.snapshot(),before);
 }
});

test("all previous variants upgrade to exact forty-nine resources and fully roll back", () => {
 const f=fixture(),original=f.snapshot();f.run("install");for(let n=0;n<=6;n++)f.run("install",f.upgradedBuild(...Array(n).fill(true)));
 const carnival=f.upgradedBuild(true,true,true,true,true,true,true);assert.equal(f.run("verify",carnival).nativeWardrobeInstalled,false);
 assert.equal(f.run("install",carnival).nativeWardrobe.assets.length,49);assert.equal(f.run("install",carnival).unchanged,true);assert.equal(f.run("verify").unchanged,true);
 assert.equal(f.fs.existsSync(f.carnivalPath("carnival_v3_6_1_u1.ui")),true);assert.equal(f.run("rollback").rolledBack,true);assert.deepEqual(f.snapshot(),original);
});
test("partial Carnival writes restore the forty-five resource baseline before retry", () => {
 for(const file of ["WorkshopNativeCarnivalBootstrap.swf","carnival_v3_6_1_u1.ui"]){
  const f=fixture();f.run("install",f.upgradedBuild(true,true,true,true,true,true));const before=f.snapshot(),carnival=f.upgradedBuild(true,true,true,true,true,true,true);
  f.arm("write",f.carnivalPath(file));assert.throws(()=>f.run("install",carnival),/ENOSPC/);assert.equal(f.failureCount,1);assert.equal(f.openHandles,0);assert.deepEqual(f.snapshot(),before);
  assert.equal(f.run("verify").unchanged,true);assert.equal(f.run("install",carnival).nativeWardrobe.assets.length,49);
 }
});
test("Carnival rollback failure compensates forty-nine resources and supports retry", () => {
 const f=fixture(),original=f.snapshot();f.run("install",f.upgradedBuild(true,true,true,true,true,true,true));const installed=f.snapshot();
 f.arm("unlink",f.carnivalPath("carnival_v3_6_1_u1.swf"));assert.throws(()=>f.run("rollback"),/EPERM/);assert.deepEqual(f.snapshot(),installed);
 assert.equal(f.run("verify").unchanged,true);assert.equal(f.run("rollback").rolledBack,true);assert.deepEqual(f.snapshot(),original);
});
test("unknown or short Carnival manifests and foreign destinations fail before mutation", () => {
 for(const reason of ["variant","paths","foreign"]){
  const f=fixture();f.run("install",f.upgradedBuild(true,true,true,true,true,true));const carnival=f.upgradedBuild(true,true,true,true,true,true,true),manifest=JSON.parse(f.fs.readFileSync(carnival,"utf8"));
  if(reason==="variant")manifest.variant="wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr-carnival-extra";if(reason==="paths")manifest.assets.pop();
  if(reason==="foreign")f.put(f.carnivalPath("carnival_v3_6_1_u1.ui"),"user owned");else f.put(carnival,JSON.stringify(manifest));
  const before=f.snapshot();assert.throws(()=>f.run("install",carnival));assert.deepEqual(f.snapshot(),before);
 }
});

test("all previous variants upgrade to exact fifty-three resources and fully roll back", () => {
  const f = fixture(), original = f.snapshot();
  assert.equal(f.run("install").nativeWardrobe.assets.length, 6);
  const previousCounts = [18, 24, 28, 32, 36, 41, 45, 49];
  for (let n = 0; n < previousCounts.length; n++)
    assert.equal(f.run("install", f.upgradedBuild(...Array(n).fill(true))).nativeWardrobe.assets.length, previousCounts[n]);
  const firstRecharge = f.upgradedBuild(...Array(8).fill(true)), before = f.snapshot();
  const dry = f.run("verify", firstRecharge);
  assert.equal(dry.nativeWardrobeInstalled, false);
  assert.equal(dry.pendingTransition, true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.run("install", firstRecharge).nativeWardrobe.assets.length, 53);
  assert.equal(f.run("install", firstRecharge).unchanged, true);
  assert.equal(f.run("verify").unchanged, true);
  for (const file of ["WorkshopNativeFirstRechargeBootstrap.swf", "first-recharge-original-library.swf", "firstrecharge_v3_6_1_u1.swf", "firstrecharge_v3_6_1_u1.ui"])
    assert.equal(f.fs.existsSync(f.firstRechargePath(file)), true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("partial First Recharge writes restore the forty-nine resource baseline before retry", () => {
  for (const file of ["WorkshopNativeFirstRechargeBootstrap.swf", "first-recharge-original-library.swf", "firstrecharge_v3_6_1_u1.swf", "firstrecharge_v3_6_1_u1.ui"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(7).fill(true)));
    const before = f.snapshot(), firstRecharge = f.upgradedBuild(...Array(8).fill(true));
    f.arm("write", f.firstRechargePath(file));
    assert.throws(() => f.run("install", firstRecharge), /ENOSPC/);
    assert.equal(f.failureCount, 1);
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.run("verify").unchanged, true);
    assert.equal(f.run("install", firstRecharge).nativeWardrobe.assets.length, 53);
  }
});

test("First Recharge rollback failure compensates fifty-three resources and supports retry", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install", f.upgradedBuild(...Array(8).fill(true)));
  const installed = f.snapshot();
  f.arm("unlink", f.firstRechargePath("firstrecharge_v3_6_1_u1.swf"));
  assert.throws(() => f.run("rollback"), /EPERM/);
  assert.equal(f.failureCount, 1);
  assert.equal(f.openHandles, 0);
  assert.deepEqual(f.snapshot(), installed);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("unknown or incomplete First Recharge manifests, wrong URLs and foreign files fail before mutation", () => {
  for (const reason of ["variant", "paths", "url", "foreign"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(7).fill(true)));
    const firstRecharge = f.upgradedBuild(...Array(8).fill(true));
    const manifest = JSON.parse(f.fs.readFileSync(firstRecharge, "utf8"));
    if (reason === "variant") manifest.variant += "-extra";
    if (reason === "paths") manifest.assets.pop();
    if (reason === "url") manifest.assets.at(-1).urlPath = "/flash/workshop-native/firstrecharge/firstrecharge_v3_6_1_u1.ui";
    if (reason === "foreign") f.put(f.firstRechargePath("firstrecharge_v3_6_1_u1.ui"), "user owned");
    else f.put(firstRecharge, JSON.stringify(manifest));
    const before = f.snapshot();
    assert.throws(() => f.run("install", firstRecharge));
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("all previous variants upgrade to exact fifty-seven Charge resources and fully roll back", () => {
  const f = fixture(), original = f.snapshot();
  assert.equal(f.run("install").nativeWardrobe.assets.length, 6);
  const previousCounts = [18, 24, 28, 32, 36, 41, 45, 49, 53];
  for (let n = 0; n < previousCounts.length; n++)
    assert.equal(f.run("install", f.upgradedBuild(...Array(n).fill(true))).nativeWardrobe.assets.length, previousCounts[n]);
  const charge = f.upgradedBuild(...Array(9).fill(true)), before = f.snapshot();
  const dry = f.run("verify", charge);
  assert.equal(dry.nativeWardrobeInstalled, false);
  assert.equal(dry.pendingTransition, true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.run("install", charge).nativeWardrobe.assets.length, 57);
  assert.equal(f.run("install", charge).unchanged, true);
  assert.equal(f.run("verify").unchanged, true);
  for (const file of ["WorkshopNativeChargeBootstrap.swf", "charge-original-library.swf", "chargeactivity_v3_6_1_u1.swf", "chargeactivity_v3_6_1_u1.ui"])
    assert.equal(f.fs.existsSync(f.chargePath(file)), true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("partial Charge activity writes restore the fifty-three resource baseline before retry", () => {
  for (const file of ["WorkshopNativeChargeBootstrap.swf", "charge-original-library.swf", "chargeactivity_v3_6_1_u1.swf", "chargeactivity_v3_6_1_u1.ui"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(8).fill(true)));
    const before = f.snapshot(), charge = f.upgradedBuild(...Array(9).fill(true));
    f.arm("write", f.chargePath(file));
    assert.throws(() => f.run("install", charge), /ENOSPC/);
    assert.equal(f.failureCount, 1);
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.run("verify").unchanged, true);
    assert.equal(f.run("install", charge).nativeWardrobe.assets.length, 57);
  }
});

test("Charge activity rollback failure compensates fifty-seven resources and supports retry", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install", f.upgradedBuild(...Array(9).fill(true)));
  const installed = f.snapshot();
  f.arm("unlink", f.chargePath("chargeactivity_v3_6_1_u1.swf"));
  assert.throws(() => f.run("rollback"), /EPERM/);
  assert.equal(f.failureCount, 1);
  assert.equal(f.openHandles, 0);
  assert.deepEqual(f.snapshot(), installed);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("unknown or incomplete Charge activity manifests, wrong URLs and foreign files fail before mutation", () => {
  for (const reason of ["variant", "paths", "url", "foreign"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(8).fill(true)));
    const charge = f.upgradedBuild(...Array(9).fill(true));
    const manifest = JSON.parse(f.fs.readFileSync(charge, "utf8"));
    if (reason === "variant") manifest.variant += "-extra";
    if (reason === "paths") manifest.assets.pop();
    if (reason === "url") manifest.assets.at(-1).urlPath = "/flash/workshop-native/charge-activity/chargeactivity_v3_6_1_u1.ui";
    if (reason === "foreign") f.put(f.chargePath("chargeactivity_v3_6_1_u1.ui"), "user owned");
    else f.put(charge, JSON.stringify(manifest));
    const before = f.snapshot();
    assert.throws(() => f.run("install", charge));
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("all previous variants upgrade to exact sixty-one Forthright resources and fully roll back", () => {
  const f = fixture(), original = f.snapshot();
  assert.equal(f.run("install").nativeWardrobe.assets.length, 6);
  const previousCounts = [18, 24, 28, 32, 36, 41, 45, 49, 53, 57];
  for (let n = 0; n < previousCounts.length; n++)
    assert.equal(f.run("install", f.upgradedBuild(...Array(n).fill(true))).nativeWardrobe.assets.length, previousCounts[n]);
  const forthright = f.upgradedBuild(...Array(10).fill(true)), before = f.snapshot();
  const dry = f.run("verify", forthright);
  assert.equal(dry.nativeWardrobeInstalled, false);
  assert.equal(dry.pendingTransition, true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.run("install", forthright).nativeWardrobe.assets.length, 61);
  assert.equal(f.run("install", forthright).unchanged, true);
  assert.equal(f.run("verify").unchanged, true);
  for (const file of ["WorkshopNativeForthrightBootstrap.swf", "forthright-original-library.swf", "forthrightactive_v3_6_1_u1.swf", "forthrightactive_v3_6_1_u1.ui"])
    assert.equal(f.fs.existsSync(f.forthrightPath(file)), true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("partial Forthright activity writes restore the fifty-seven resource baseline before retry", () => {
  for (const file of ["WorkshopNativeForthrightBootstrap.swf", "forthright-original-library.swf", "forthrightactive_v3_6_1_u1.swf", "forthrightactive_v3_6_1_u1.ui"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(9).fill(true)));
    const before = f.snapshot(), forthright = f.upgradedBuild(...Array(10).fill(true));
    f.arm("write", f.forthrightPath(file));
    assert.throws(() => f.run("install", forthright), /ENOSPC/);
    assert.equal(f.failureCount, 1);
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.run("verify").unchanged, true);
    assert.equal(f.run("install", forthright).nativeWardrobe.assets.length, 61);
  }
});

test("Forthright activity rollback failure compensates sixty-one resources and supports retry", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install", f.upgradedBuild(...Array(10).fill(true)));
  const installed = f.snapshot();
  f.arm("unlink", f.forthrightPath("forthrightactive_v3_6_1_u1.swf"));
  assert.throws(() => f.run("rollback"), /EPERM/);
  assert.equal(f.failureCount, 1);
  assert.equal(f.openHandles, 0);
  assert.deepEqual(f.snapshot(), installed);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("unknown or incomplete Forthright activity manifests, wrong URLs and foreign files fail before mutation", () => {
  for (const reason of ["variant", "paths", "url", "foreign"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(9).fill(true)));
    const forthright = f.upgradedBuild(...Array(10).fill(true));
    const manifest = JSON.parse(f.fs.readFileSync(forthright, "utf8"));
    if (reason === "variant") manifest.variant += "-extra";
    if (reason === "paths") manifest.assets.pop();
    if (reason === "url") manifest.assets.at(-1).urlPath = "/flash/workshop-native/forthright-extra/forthrightactive_v3_6_1_u1.ui";
    if (reason === "foreign") f.put(f.forthrightPath("forthrightactive_v3_6_1_u1.ui"), "user owned");
    else f.put(forthright, JSON.stringify(manifest));
    const before = f.snapshot();
    assert.throws(() => f.run("install", forthright));
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("all previous variants upgrade to exact sixty-five Exchange resources and fully roll back", () => {
  const f = fixture(), original = f.snapshot();
  assert.equal(f.run("install").nativeWardrobe.assets.length, 6);
  const previousCounts = [18, 24, 28, 32, 36, 41, 45, 49, 53, 57, 61];
  for (let n = 0; n < previousCounts.length; n++)
    assert.equal(f.run("install", f.upgradedBuild(...Array(n).fill(true))).nativeWardrobe.assets.length, previousCounts[n]);
  const exchange = f.upgradedBuild(...Array(11).fill(true)), before = f.snapshot();
  const dry = f.run("verify", exchange);
  assert.equal(dry.nativeWardrobeInstalled, false);
  assert.equal(dry.pendingTransition, true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.run("install", exchange).nativeWardrobe.assets.length, 65);
  assert.equal(f.run("install", exchange).unchanged, true);
  assert.equal(f.run("verify").unchanged, true);
  for (const file of ["WorkshopNativeExchangeBootstrap.swf", "exchange-original-library.swf", "exchange-original-art.swf", "exchange-styles.xml"])
    assert.equal(f.fs.existsSync(f.exchangePath(file)), true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("partial Exchange activity writes restore the sixty-one resource baseline before retry", () => {
  for (const file of ["WorkshopNativeExchangeBootstrap.swf", "exchange-original-library.swf", "exchange-original-art.swf", "exchange-styles.xml"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(10).fill(true)));
    const before = f.snapshot(), exchange = f.upgradedBuild(...Array(11).fill(true));
    f.arm("write", f.exchangePath(file));
    assert.throws(() => f.run("install", exchange), /ENOSPC/);
    assert.equal(f.failureCount, 1);
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.run("verify").unchanged, true);
    assert.equal(f.run("install", exchange).nativeWardrobe.assets.length, 65);
  }
});

test("Exchange activity rollback failure compensates sixty-five resources and supports retry", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install", f.upgradedBuild(...Array(11).fill(true)));
  const installed = f.snapshot();
  f.arm("unlink", f.exchangePath("exchange-original-art.swf"));
  assert.throws(() => f.run("rollback"), /EPERM/);
  assert.equal(f.failureCount, 1);
  assert.equal(f.openHandles, 0);
  assert.deepEqual(f.snapshot(), installed);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("unknown or incomplete Exchange activity manifests, wrong URLs and foreign files fail before mutation", () => {
  for (const reason of ["variant", "paths", "url", "foreign"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(10).fill(true)));
    const exchange = f.upgradedBuild(...Array(11).fill(true));
    const manifest = JSON.parse(f.fs.readFileSync(exchange, "utf8"));
    if (reason === "variant") manifest.variant += "-extra";
    if (reason === "paths") manifest.assets.pop();
    if (reason === "url") manifest.assets.at(-1).urlPath = "/flash/workshop-native/exchange-extra/exchange-styles.xml";
    if (reason === "foreign") f.put(f.exchangePath("exchange-styles.xml"), "user owned");
    else f.put(exchange, JSON.stringify(manifest));
    const before = f.snapshot();
    assert.throws(() => f.run("install", exchange));
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("all previous variants upgrade to exact sixty-nine Devil resources and fully roll back", () => {
  const f = fixture(), original = f.snapshot();
  assert.equal(f.run("install").nativeWardrobe.assets.length, 6);
  const previousCounts = [18, 24, 28, 32, 36, 41, 45, 49, 53, 57, 61, 65];
  for (let n = 0; n < previousCounts.length; n++)
    assert.equal(f.run("install", f.upgradedBuild(...Array(n).fill(true))).nativeWardrobe.assets.length, previousCounts[n]);
  const devil = f.upgradedBuild(...Array(12).fill(true)), before = f.snapshot();
  const dry = f.run("verify", devil);
  assert.equal(dry.nativeWardrobeInstalled, false);
  assert.equal(dry.pendingTransition, true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.run("install", devil).nativeWardrobe.assets.length, 69);
  assert.equal(f.run("install", devil).unchanged, true);
  assert.equal(f.run("verify").unchanged, true);
  for (const file of ["WorkshopNativeDevilBootstrap.swf", "devil-original-library.swf", "devilturn_v3_6_1_u1.swf", "devilturn.ui"])
    assert.equal(f.fs.existsSync(f.devilPath(file)), true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("partial Devil activity writes restore the sixty-five resource baseline before retry", () => {
  for (const file of ["WorkshopNativeDevilBootstrap.swf", "devil-original-library.swf", "devilturn_v3_6_1_u1.swf", "devilturn.ui"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(11).fill(true)));
    const before = f.snapshot(), devil = f.upgradedBuild(...Array(12).fill(true));
    f.arm("write", f.devilPath(file));
    assert.throws(() => f.run("install", devil), /ENOSPC/);
    assert.equal(f.failureCount, 1);
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.run("verify").unchanged, true);
    assert.equal(f.run("install", devil).nativeWardrobe.assets.length, 69);
  }
});

test("Devil activity rollback failure compensates sixty-nine resources and supports retry", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install", f.upgradedBuild(...Array(12).fill(true)));
  const installed = f.snapshot();
  f.arm("unlink", f.devilPath("devilturn_v3_6_1_u1.swf"));
  assert.throws(() => f.run("rollback"), /EPERM/);
  assert.equal(f.failureCount, 1);
  assert.equal(f.openHandles, 0);
  assert.deepEqual(f.snapshot(), installed);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("unknown or incomplete Devil activity manifests, wrong URLs and foreign files fail before mutation", () => {
  for (const reason of ["variant", "paths", "url", "foreign"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(11).fill(true)));
    const devil = f.upgradedBuild(...Array(12).fill(true));
    const manifest = JSON.parse(f.fs.readFileSync(devil, "utf8"));
    if (reason === "variant") manifest.variant += "-extra";
    if (reason === "paths") manifest.assets.pop();
    if (reason === "url") manifest.assets.at(-1).urlPath = "/flash/workshop-native/devil-extra/devilturn.ui";
    if (reason === "foreign") f.put(f.devilPath("devilturn.ui"), "user owned");
    else f.put(devil, JSON.stringify(manifest));
    const before = f.snapshot();
    assert.throws(() => f.run("install", devil));
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("all previous variants upgrade to exact seventy-three CaveLoot resources and fully roll back", () => {
  const f = fixture(), original = f.snapshot();
  assert.equal(f.run("install").nativeWardrobe.assets.length, 6);
  const previousCounts = [18, 24, 28, 32, 36, 41, 45, 49, 53, 57, 61, 65, 69];
  for (let n = 0; n < previousCounts.length; n++)
    assert.equal(f.run("install", f.upgradedBuild(...Array(n).fill(true))).nativeWardrobe.assets.length, previousCounts[n]);
  const caveloot = f.upgradedBuild(...Array(13).fill(true)), before = f.snapshot();
  const dry = f.run("verify", caveloot);
  assert.equal(dry.nativeWardrobeInstalled, false);
  assert.equal(dry.pendingTransition, true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.run("install", caveloot).nativeWardrobe.assets.length, 73);
  assert.equal(f.run("install", caveloot).unchanged, true);
  assert.equal(f.run("verify").unchanged, true);
  for (const file of ["WorkshopNativeCaveLootBootstrap.swf", "caveloot-original-library.swf", "caveloot.swf", "caveloot.ui"])
    assert.equal(f.fs.existsSync(f.cavelootPath(file)), true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("partial CaveLoot activity writes restore the sixty-nine resource baseline before retry", () => {
  for (const file of ["WorkshopNativeCaveLootBootstrap.swf", "caveloot-original-library.swf", "caveloot.swf", "caveloot.ui"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(12).fill(true)));
    const before = f.snapshot(), caveloot = f.upgradedBuild(...Array(13).fill(true));
    f.arm("write", f.cavelootPath(file));
    assert.throws(() => f.run("install", caveloot), /ENOSPC/);
    assert.equal(f.failureCount, 1);
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.run("verify").unchanged, true);
    assert.equal(f.run("install", caveloot).nativeWardrobe.assets.length, 73);
  }
});

test("CaveLoot activity rollback failure compensates seventy-three resources and supports retry", () => {
  const f = fixture(), original = f.snapshot();
  f.run("install", f.upgradedBuild(...Array(13).fill(true)));
  const installed = f.snapshot();
  f.arm("unlink", f.cavelootPath("caveloot.swf"));
  assert.throws(() => f.run("rollback"), /EPERM/);
  assert.equal(f.failureCount, 1);
  assert.equal(f.openHandles, 0);
  assert.deepEqual(f.snapshot(), installed);
  assert.equal(f.run("verify").unchanged, true);
  assert.equal(f.run("rollback").rolledBack, true);
  assert.deepEqual(f.snapshot(), original);
});

test("unknown or incomplete CaveLoot activity manifests, wrong URLs and foreign files fail before mutation", () => {
  for (const reason of ["variant", "paths", "url", "foreign"]) {
    const f = fixture();
    f.run("install", f.upgradedBuild(...Array(12).fill(true)));
    const caveloot = f.upgradedBuild(...Array(13).fill(true));
    const manifest = JSON.parse(f.fs.readFileSync(caveloot, "utf8"));
    if (reason === "variant") manifest.variant += "-extra";
    if (reason === "paths") manifest.assets.pop();
    if (reason === "url") manifest.assets.at(-1).urlPath = "/flash/workshop-native/caveloot-extra/caveloot.ui";
    if (reason === "foreign") f.put(f.cavelootPath("caveloot.ui"), "user owned");
    else f.put(caveloot, JSON.stringify(manifest));
    const before = f.snapshot();
    assert.throws(() => f.run("install", caveloot));
    assert.equal(f.openHandles, 0);
    assert.deepEqual(f.snapshot(), before);
  }
});
