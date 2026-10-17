// Bounded, read-only checks for the selected local startup inputs. No service or DB calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export const workshopPathKeys = ["FLASH_DIR", "FLASH_OVERLAY_DIR", "RESOURCE_DIR", "RUFFLE_DIR", "RSA_PRIVATE_KEY_FILE", "UPLOAD_DIR", "REQUEST_SNAPSHOT_DIR",
  "FIGHT_WEAPON_EXTENSION", "LANGUAGE_FILE", "ITEM_NAME_OVERRIDES_FILE", "PVE_TEXT_OVERRIDES_FILE", "TEMPLATE_TEXT_OVERRIDES_FILE", "TEMPLATE_TEXT_SUPPLEMENT_FILE",
  "WORKSHOP_WEAPON_VISUAL_UPGRADE", "WORKSHOP_LIVE_PROFILE"];
const publicPathKeys = workshopPathKeys.filter(key => key !== "RSA_PRIVATE_KEY_FILE" && key !== "WORKSHOP_LIVE_PROFILE");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const within = (root, target) => { const rel = relative(root, target); return rel && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel); };
export function resolveLivePath(repo, value) {
  assert.ok(typeof value === "string" && value.length > 0 && !isAbsolute(value) && !/^[a-z][a-z0-9+.-]*:/i.test(value), "live paths must be repository-relative");
  const target = resolve(repo, value);
  assert.ok([resolve(repo), resolve(repo, "../../runtime")].some(root => within(root, target)), "live path escapes repository/runtime roots");
  return target;
}
export function normalizeWorkshopPaths(settings, repo) {
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, workshopPathKeys.includes(key) && value ? resolve(repo, value) : value]));
}
function readPin(repo, pin) {
  assert.deepEqual(Object.keys(pin).sort(), ["path", "sha256", "bytes"].sort());
  assert.match(pin.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes >= 0);
  const path = resolveLivePath(repo, pin.path), actual = realpathSync(path);
  assert.ok([repo, resolve(repo, "../../runtime")].some(root => within(realpathSync(root), actual)), "live input resolves outside repository/runtime roots");
  const bytes = readFileSync(path);
  assert.equal(bytes.length, pin.bytes, `live input size changed: ${pin.path}`);
  assert.equal(sha(bytes), pin.sha256, `live input hash changed: ${pin.path}`);
  return bytes;
}
export function verifyWorkshopLive(profilePath, settings, repo) {
  const profileBytes = readFileSync(profilePath), profile = JSON.parse(profileBytes);
  assert.deepEqual(Object.keys(profile).sort(), ["schemaVersion", "pathBase", "envPaths", "inputs"].sort());
  assert.equal(profile.schemaVersion, 1); assert.equal(profile.pathBase, "repo");
  assert.ok(profile.envPaths && typeof profile.envPaths === "object" && !Array.isArray(profile.envPaths));
  for (const [key, value] of Object.entries(profile.envPaths)) {
    assert.ok(publicPathKeys.includes(key), "live profile contains an unsupported setting");
    assert.ok(settings[key], `live setting missing: ${key}`);
    assert.equal(resolve(repo, settings[key]), resolveLivePath(repo, value), `live setting differs: ${key}`);
  }
  const manifestBytes = readPin(repo, profile.inputs), manifest = JSON.parse(manifestBytes);
  assert.deepEqual(Object.keys(manifest).sort(), ["schemaVersion", "pathBase", "files"].sort());
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.pathBase, "repo");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  const seen = new Set(); let bytes = profileBytes.length + manifestBytes.length;
  for (const pin of manifest.files) {
    const key = resolveLivePath(repo, pin.path).toLowerCase();
    assert.ok(!seen.has(key), "duplicate live input"); seen.add(key); bytes += readPin(repo, pin).length;
  }
  for (const [key, value] of Object.entries(profile.envPaths)) if (!key.endsWith("_DIR")) {
    assert.ok(seen.has(resolveLivePath(repo, value).toLowerCase()), `live setting is not pinned: ${key}`);
  }
  return { files: manifest.files.length, inputBytes: manifest.files.reduce((sum, pin) => sum + pin.bytes, 0), filesRead: manifest.files.length + 2, bytesRead: bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."), args = process.argv.slice(2);
  assert.ok(args.length <= 1, "usage: node scripts/workshop-live.mjs [profile.json]");
  const settings = normalizeWorkshopPaths(parseEnv(readFileSync(resolve(repo, ".env.workshop"), "utf8")), repo);
  const selected = args[0] || settings.WORKSHOP_LIVE_PROFILE;
  assert.ok(selected, "WORKSHOP_LIVE_PROFILE is not configured");
  console.log(JSON.stringify(verifyWorkshopLive(resolve(repo, selected), settings, repo)));
}
