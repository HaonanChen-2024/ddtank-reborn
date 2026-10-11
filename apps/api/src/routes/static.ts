/**
 * Static trees for the client: /flash/ (FLASHSITE: compiled client, generated config.xml), /resource/ (SITE: resource
 * pack with the uploads overlay + typed placeholders for misses), /ruffle/, /uploads/, crossdomain.xml.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppCtx } from "../context.js";
import { CiTree, EMPTY_SWF, mimeOf, placeholder } from "../lib/resources.js";
import { crc32, inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { aliasBombSwf } from "../lib/bomb-alias.js";

export const CROSSDOMAIN = `<?xml version="1.0"?>
<!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">
<cross-domain-policy>
  <site-control permitted-cross-domain-policies="all"/>
  <allow-access-from domain="*" to-ports="*" secure="false"/>
  <allow-http-request-headers-from domain="*" headers="*" secure="false"/>
</cross-domain-policy>
`;

/** config.xml with every URL pointed at this deployment (template: FLASH_DIR/config.xml, research/client/01-client-map.md §3). */
export function buildConfigXml(ctx: AppCtx, template: string): string {
  const b = ctx.cfg.PUBLIC_URL;
  const set: Record<string, string> = {
    FLASHSITE: `${b}/flash/`,
    BACKUP_FLASHSITE: `${b}/flash/`,
    USE_MD5: "true",
    SITE: `${b}/resource/`,
    FIRSTPAGE: `${ctx.cfg.SITE_URL}/`,
    REGISTER: `${ctx.cfg.SITE_URL}/register`,
    REQUEST_PATH: `${b}/request/`,
    LOGIN_PATH: `${ctx.cfg.SITE_URL}/login`,
    FILL_PATH: `${ctx.cfg.SITE_URL}/account`,
    WEEKLYSITE: `${b}/flash/`,
    COUNT_PATH: "",
    STATISTIC: "false",
    OFFICIAL_SITE: `${ctx.cfg.SITE_URL}/`,
    USER_GUILD_ENABLE: String(ctx.cfg.USER_GUIDE_ENABLE),
  };
  let x = template;
  for (const [k, v] of Object.entries(set)) x = x.replace(new RegExp(`(<${k}\\s+value=")[^"]*(")`, "i"), `$1${v}$2`);
  x = x.replace(/<POLICY_FILES>[\s\S]*?<\/POLICY_FILES>/i, `<POLICY_FILES>\n<file value="${b}/crossdomain.xml"/>\n</POLICY_FILES>`);
  x = x.replace(/(<(?:STATISTICS|EXTERNAL_INTERFACE_360)\b[^>]*enable=")[^"]*(")/gi, "$1false$2");
  return x;
}

/** 60 files of the mobile resource pack carry a 5-byte `writeUTF("^_^")` prefix (00 03 5E 5F 5E) before the real
 *  CWS/PNG bytes; the Flash client's loaders choke on it (ModuleLoader.decry EOF → room loading stuck at 91 %). */
const MOBILE_PREFIX = Buffer.from([0x00, 0x03, 0x5e, 0x5f, 0x5e]);
const prefixCache = new Map<string, { mtime: number; body: Buffer | null }>();
function strippedBody(file: string, mtime: number): Buffer | null {
  const c = prefixCache.get(file);
  if (c && c.mtime === mtime) return c.body;
  let body: Buffer | null = null;
  if (/\.(swf|png|jpe?g)$/i.test(file)) {
    const b = readFileSync(file);
    if (b.length > 5 && b.subarray(0, 5).equals(MOBILE_PREFIX)) {
      // the bytes after the prefix are still scrambled (mobile client cipher): serve them only when they really are a
      // valid SWF/PNG, else an empty CWS movie so the loader completes instead of stalling the room loading.
      const rest = b.subarray(5);
      let ok = false;
      try {
        if (rest.subarray(0, 3).toString("latin1") === "CWS") ok = inflateSync(rest.subarray(8)).length + 8 === rest.readUInt32LE(4);
      } catch {
        ok = false;
      }
      body = ok ? rest : /\.swf$/i.test(file) ? EMPTY_SWF : rest;
    }
    const png = body ?? b;
    // a PNG with wrong chunk CRCs is a scrambled mobile-pack file (its IHDR is garbage too): Ruffle rejects it and the
    // ball/crater never completes → serve a 1x1 PNG instead (the server owns the physics; only the hole graphic is lost)
    if (/\.png$/i.test(file) && png[0] === 0x89 && png[1] === 0x50 && badPngCrc(png)) body = placeholder(file)?.body ?? body;
  }
  if (prefixCache.size > 5000) prefixCache.clear();
  prefixCache.set(file, { mtime, body });
  return body;
}

/** Some PNGs of the pack (e.g. image/bomb/crater/870/*.png) have wrong chunk CRCs: Flash accepted them, Ruffle's decoder
 *  rejects them (InvalidPng CrcMismatch) → the ball never completes and the room loading stalls. Detected here. */
function badPngCrc(b: Buffer): boolean {
  let o = 8;
  while (o + 12 <= b.length) {
    const len = b.readUInt32BE(o);
    if (o + 12 + len > b.length) return true;
    if ((crc32(b.subarray(o + 4, o + 8 + len)) >>> 0) !== b.readUInt32BE(o + 8 + len)) return true;
    // Real donor files sometimes append non-image bytes. PNG decoding ends at a valid IEND.
    if (b.toString("ascii", o + 4, o + 8) === "IEND") return len !== 0;
    o += 12 + len;
  }
  return true;
}

function sendFile(req: FastifyRequest, reply: FastifyReply, file: string) {
  const st = statSync(file);
  const stripped = strippedBody(file, st.mtimeMs);
  if (stripped) {
    const etag = `"${stripped.length.toString(16)}-${st.mtimeMs.toString(16)}-s"`;
    reply.header("ETag", etag).header("Cache-Control", "public, max-age=300").header("Access-Control-Allow-Origin", "*");
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    reply.type(mimeOf(file)).header("Content-Length", stripped.length);
    return req.method === "HEAD" ? reply.send() : reply.send(stripped);
  }
  const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
  reply.header("ETag", etag).header("Cache-Control", "public, max-age=300").header("Access-Control-Allow-Origin", "*");
  if (req.headers["if-none-match"] === etag) return reply.code(304).send();
  reply.type(mimeOf(file)).header("Content-Length", st.size);
  if (req.method === "HEAD") return reply.send();
  return reply.send(createReadStream(file));
}

const relOf = (req: FastifyRequest, prefix: RegExp) => {
  let p = new URL(req.url, "http://x").pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  return p.replace(prefix, "");
};

export async function staticRoutes(f: FastifyInstance, ctx: AppCtx) {
  const flash = new CiTree(ctx.cfg.FLASH_DIR);
  const deploymentFlash = new CiTree(ctx.cfg.FLASH_OVERLAY_DIR);
  // apps/api/assets/flash: patched copies of client files (vendor stays read-only), e.g. ui/vietnam/xml/coreI.xml
  const flashFix = new CiTree(fileURLToPath(new URL("../../assets/flash", import.meta.url)));
  const ruffle = new CiTree(ctx.cfg.RUFFLE_DIR);
  ctx.log.info(`static: flash ${flash.size} files (${ctx.cfg.FLASH_DIR}), resource ${ctx.resources.trees.map((t) => t.size).join("+")} files`);

  const cfgTemplate = () => {
    const f = deploymentFlash.resolve("config.xml") ?? flash.resolve("config.xml");
    return f && existsSync(f) ? readFileSync(f, "utf8") : "<root><config><REQUEST_PATH value=\"\"/></config></root>";
  };

  f.get("/crossdomain.xml", (_req, reply) => reply.type("text/xml").send(CROSSDOMAIN));

  f.route({
    method: ["GET", "HEAD"],
    url: "/flash/*",
    handler: (req, reply) => {
      const rel = relOf(req, /^\/flash\//i);
      const low = rel.toLowerCase();
      if (low === "config.xml") return reply.type("text/xml; charset=utf-8").header("Cache-Control", "no-cache").send(buildConfigXml(ctx, cfgTemplate()));
      if (low === "crossdomain.xml") return reply.type("text/xml").send(CROSSDOMAIN);
      const file = deploymentFlash.resolve(rel) ?? flashFix.resolve(rel) ?? flash.resolve(rel);
      if (!file) return reply.code(404).send("not found");
      return sendFile(req, reply, file);
    },
  });

  f.route({
    method: ["GET", "HEAD"],
    url: "/resource/*",
    handler: (req, reply) => {
      const rel = relOf(req, /^\/resource\//i);
      if (rel.toLowerCase() === "crossdomain.xml") return reply.type("text/xml").send(CROSSDOMAIN);
      const file = ctx.resources.resolve(rel);
      if (file && !(/\.swf$/i.test(rel) && strippedBody(file, statSync(file).mtimeMs) === EMPTY_SWF && aliasBombSwf(ctx.resources, rel))) return sendFile(req, reply, file);
      const alias = aliasBombSwf(ctx.resources, rel);
      if (alias) return reply.type("application/x-shockwave-flash").header("X-Alias", "1").header("Cache-Control", "public, max-age=300").header("Access-Control-Allow-Origin", "*").send(alias);
      ctx.resources.miss(rel);
      const ph = placeholder(rel);
      if (!ph) return reply.code(404).send("not found");
      return reply.type(ph.type).header("X-Placeholder", "1").header("Access-Control-Allow-Origin", "*").send(ph.body);
    },
  });

  f.route({
    method: ["GET", "HEAD"],
    url: "/ruffle/*",
    handler: (req, reply) => {
      const file = ruffle.resolve(relOf(req, /^\/ruffle\//i));
      return file ? sendFile(req, reply, file) : reply.code(404).send("not found");
    },
  });

  if (ctx.storage.kind === "local") {
    f.route({
      method: ["GET", "HEAD"],
      url: "/uploads/*",
      handler: (req, reply) => {
        const file = ctx.resources.trees[0]?.resolve(relOf(req, /^\/uploads\//i));
        return file ? sendFile(req, reply, file) : reply.code(404).send("not found");
      },
    });
  }
}
