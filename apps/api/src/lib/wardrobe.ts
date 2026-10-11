/** Read-only Category 13 checks. AS3 reference: DDTank41 commit 7fcb5529,
 * PathManager.solveGoodsPath, BaseLayer/GameLayer and Character.createFrames.
 * File/grid checks do not prove pixel decoding, animation alignment or actual wearing. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { z } from "zod";
import type { ResourceIndex } from "./resources.js";
import { safeKey } from "./storage.js";

const draftSchema = z.object({
  CategoryID: z.coerce.number().int().refine((n) => n === 13, "CategoryID 13 only"),
  Pic: z.string().min(1).max(200).refine((s) => s === s.trim() && safeKey(s) === s && !s.includes("/") && s !== "." && s !== "..", "Pic must be one resource folder name"),
  NeedSex: z.coerce.number().int().min(0).max(2),
  Property8: z.coerce.number().int().min(1).max(999_999_999).refine((n) => !String(n).includes("0"), "Property8 must contain layer digits 1..9"),
});

export type WardrobeAssetState = "ok" | "missing" | "placeholder" | "invalid" | "incompatible";
export interface WardrobeFrames {
  owner: "ShowCharacter" | "RoomCharacter" | "GameCharacter";
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
  state: "ok" | "incompatible";
}
export interface WardrobeAsset {
  kind: "icon" | "show" | "game" | "game1";
  layer: number;
  path: string;
  url: string;
  state: WardrobeAssetState;
  width?: number;
  height?: number;
  bytes?: number;
  sha256?: string;
  warnings: ("icon-size" | "show-padding" | "pixel-decode-unchecked")[];
  frames: WardrobeFrames[];
}
export interface WardrobeCheckResult {
  draft: z.infer<typeof draftSchema>;
  pathSex: "m" | "f";
  state: "ok" | "incomplete" | "incompatible";
  readOnly: true;
  renderingAccepted: false;
  validationScope: "png-header-chunk-crc-and-frame-grid";
  assets: WardrobeAsset[];
}

/** Header/chunk/CRC validation only. Intentionally does not claim to decode IDAT pixels. */
function pngSize(b: Buffer): { width: number; height: number } | undefined {
  if (b.length < 33 || !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || b.readUInt32BE(8) !== 13 || b.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  if (!width || !height || b[26] !== 0 || b[27] !== 0 || (b[28] !== 0 && b[28] !== 1)) return undefined;
  let pos = 8, idat = false, ended = false;
  while (pos + 12 <= b.length) {
    const size = b.readUInt32BE(pos);
    if (size > b.length - pos - 12) return undefined;
    const type = b.toString("ascii", pos + 4, pos + 8);
    if ((crc32(b.subarray(pos + 4, pos + 8 + size)) >>> 0) !== b.readUInt32BE(pos + 8 + size)) return undefined;
    if (type === "IDAT") idat = true;
    pos += 12 + size;
    // PNG decoders stop at a valid IEND; real donor files may have non-image trailing bytes.
    // CRCs are still checked through IEND, while the asset hash retains the entire original file.
    if (type === "IEND") { ended = size === 0; break; }
  }
  return idat && ended ? { width, height } : undefined;
}

function frameChecks(kind: WardrobeAsset["kind"], width: number, height: number): WardrobeFrames[] {
  if (kind === "icon") return [];
  // Known legacy show sheets are 312px high; copyPixels leaves the final 30px transparent.
  // Show consumes the first 2 frames, Room consumes 4; a 500px sheet is insufficient for Room.
  if (kind === "show") return (["ShowCharacter", "RoomCharacter"] as const).map((owner) => ({
    owner, columns: owner === "ShowCharacter" ? 2 : 4, rows: 1, frameWidth: 250, frameHeight: 342,
    state: (height === 312 || height === 342) && (owner === "ShowCharacter" ? width === 500 || width === 1000 : width === 1000) ? "ok" : "incompatible",
  }));
  // Unknown oversized sheets may still contain misaligned frames; only the verified standard is accepted here.
  return [{ owner: "GameCharacter", columns: 13, rows: 3, frameWidth: 114, frameHeight: 95, state: width === 1482 && height === 285 ? "ok" : "incompatible" }];
}

export function checkWardrobe(resources: ResourceIndex, body: unknown, publicUrl: string): WardrobeCheckResult {
  const draft = draftSchema.parse(body);
  // The original layers use template.NeedSex == 1, not the player's Sex. Neutral (0) uses f too.
  const pathSex = draft.NeedSex === 1 ? "m" : "f";
  const root = `image/equip/${pathSex}/suits/${draft.Pic}`;
  const layers = [...new Set([...String(draft.Property8)].map(Number))];
  const wanted = [{ kind: "icon" as const, layer: 1, path: `${root}/icon_1.png` }, ...layers.flatMap((layer) => (["show", "game", "game1"] as const).map((kind) => ({ kind, layer, path: `${root}/${layer}/${kind}.png` })))];
  const assets = wanted.map(({ kind, layer, path }): WardrobeAsset => {
    const asset: WardrobeAsset = { kind, layer, path, url: publicUrl.replace(/\/+$/, "") + "/resource/" + path.split("/").map(encodeURIComponent).join("/"), state: "missing", warnings: [], frames: [] };
    const file = resources.resolve(path);
    if (!file) return asset;
    let data: Buffer;
    try { data = readFileSync(file); } catch { return asset; }
    asset.bytes = data.length;
    asset.sha256 = createHash("sha256").update(data).digest("hex");
    const size = pngSize(data);
    if (!size) { asset.state = "invalid"; return asset; }
    Object.assign(asset, size);
    if (size.width === 1 && size.height === 1) { asset.state = "placeholder"; return asset; }
    asset.frames = frameChecks(kind, size.width, size.height);
    asset.state = asset.frames.some((frame) => frame.state === "incompatible") ? "incompatible" : "ok";
    if (kind === "icon" && (size.width !== 78 || size.height !== 78)) asset.warnings.push("icon-size");
    if (kind === "show" && size.height === 312) asset.warnings.push("show-padding");
    asset.warnings.push("pixel-decode-unchecked");
    return asset;
  });
  return { draft, pathSex, state: assets.some((asset) => ["missing", "placeholder", "invalid"].includes(asset.state)) ? "incomplete" : assets.some((asset) => asset.state === "incompatible") ? "incompatible" : "ok", readOnly: true, renderingAccepted: false, validationScope: "png-header-chunk-crc-and-frame-grid", assets };
}
