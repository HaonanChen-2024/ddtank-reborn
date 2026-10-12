/**
 * Environment configuration (zod). Mirrors the relevant keys of Road.Service App.config / GameServerConfig
 * (docs/spec/server/00-architecture.md §7) plus the new transports (WS, policy 843, admin channel).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : /^(1|true|yes|on)$/i.test(v)));
const int = (def: number) => z.coerce.number().int().default(def);
const num = (def: number) => z.coerce.number().default(def);

export const ConfigSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  /** postgres://… (Neon pooled) | pglite:<dir> | pglite:memory | unset = packages/db/.data/pglite. */
  DATABASE_URL: z.string().optional(),
  /** Optional additive weapon pack. Requires matching DB/XML and original client resources; read only at startup. */
  FIGHT_WEAPON_EXTENSION: z.string().min(1).optional(),

  /** Row of player."Server_List" (Name/Room/Total/ZoneId/ZoneName are read from it, like GameServer.Start). */
  SERVER_ID: int(4),
  SERVER_NAME: z.string().optional(),
  /** Host/IP the Flash client connects to (Server_List.IP / app."Servers".host; Ruffle socketProxy host). */
  PUBLIC_HOST: z.string().default("127.0.0.1"),
  /** Bind address for TCP/WS/policy listeners. */
  BIND_HOST: z.string().default("0.0.0.0"),
  /** Real TCP game port. ServerList.ashx advertises GAME_PORT - 69 and the client adds 69 (ServerListAnalyzer.as:44). */
  GAME_PORT: int(9200),
  WS_ENABLED: bool(true),
  WS_PORT: int(9300),
  WS_PATH: z.string().default("/ws"),
  /** Comma list of allowed Origin headers for the WebSocket endpoint ("*" or empty = any). */
  WS_ALLOWED_ORIGINS: z.string().default("*"),
  /** Max size of one WebSocket message (bytes). */
  WS_MAX_PAYLOAD: int(64 * 1024),
  /** Public WS URL advertised in app."Servers".wsUrl (default ws://PUBLIC_HOST:WS_PORT/WS_PATH). */
  WS_PUBLIC_URL: z.string().optional(),
  POLICY_ENABLED: bool(true),
  POLICY_PORT: int(843),

  /** RSA private key: path to a .NET <RSAKeyValue> XML file (any file containing one, e.g. Web.config) or a PEM. */
  RSA_PRIVATE_KEY_FILE: z.string().optional(),
  /** Inline alternative to RSA_PRIVATE_KEY_FILE (XML or PEM). */
  RSA_PRIVATE_KEY: z.string().optional(),
  /** Dev only (same as apps/api): fall back to the public pair in vendor/DDTank41/Tank.Request/Web.config. */
  RSA_USE_VENDOR_KEY: bool(true),

  ADMIN_ENABLED: bool(true),
  ADMIN_HOST: z.string().default("127.0.0.1"),
  ADMIN_PORT: int(9400),
  /** Optional bearer token required by the admin channel (header Authorization: Bearer <token>). */
  ADMIN_TOKEN: z.string().optional(),

  /** GameServerConfig.DBAutosaveInterval (minutes; shipped 10). */
  SAVE_INTERVAL_MIN: num(10),
  /** GameServerConfig.PingCheckInterval (minutes; shipped 3). */
  PING_INTERVAL_MIN: num(3),
  /** Speed-hack heartbeat (baoltfunction.cs): client interval in minutes and tolerance seconds. */
  SPEED_CHECK_ENABLED: bool(true),
  SPEED_CHECK_INTERVAL_MIN: num(5),
  SPEED_CHECK_TOLERANCE_SEC: num(15),
  SPEED_CHECK_BAN_MIN: num(20),
  /** GamePlayer.SaveIntoDatabase: no heartbeat for this many minutes -> 1 h ban. */
  SPEED_CHECK_MISSING_MIN: num(90),
  SPEED_CHECK_MISSING_BAN_MIN: num(60),

  /** Rates (multipliers) applied by systems that award exp/gold/offer/drops. */
  RATE_EXP: num(1),
  RATE_GOLD: num(1),
  RATE_OFFER: num(1),
  RATE_DROP: num(1),

  /** Max rooms (Server_List.Room overrides when present). */
  MAX_ROOMS: int(200),
  MAX_CONNECTIONS: int(8000),
  MAX_CONNECTIONS_PER_IP: int(20),
  /** Token bucket per connection: sustained packets/s and burst; exceeding disconnects. */
  PACKET_RATE_PER_SEC: num(60),
  PACKET_RATE_BURST: num(200),
  /** Close connections that have not logged in after this many seconds. */
  LOGIN_TIMEOUT_SEC: num(60),
  /** Lobby chat cooldown (SceneChatHandler.cs:240, 30 s). */
  /** Seconds a lone Match room waits in the auto-match queue before it is paired with bots (app."Bots"); 0 = never. */
  BOT_FALLBACK_SEC: num(25),
  CHAT_COOLDOWN_SEC: num(3), // original SceneChatHandler: 30 s (felt like "chat is broken")

  /** PT-BR is the default; set LANGUAGE_FILE=<repo>/apps/game/data/Language-vn.txt to use the original VN source. */
  LANGUAGE_FILE: z.string().default(resolve(APP_ROOT, "..", "..", "data", "i18n", "pt-BR", "server-language.txt")),
  /** app."Translations" overlay lang applied to `game` schema text at template-load time (Templates.load). */
  DEFAULT_LANG: z.string().default("pt-BR"),
  /** Dev only: accept any socket LOGIN password (the ticket is not checked). Refused when NODE_ENV=production. */
  DEV_ALLOW_ANY_TICKET: bool(false),
  /** Write heartbeat/online count to app."Servers" (shared with apps/api ServerList.ashx). */
  SERVER_HEARTBEAT: bool(true),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cfg = ConfigSchema.parse(env);
  if (cfg.NODE_ENV === "production" && cfg.DEV_ALLOW_ANY_TICKET) {
    throw new Error("DEV_ALLOW_ANY_TICKET must not be enabled in production");
  }
  return cfg;
}

/** Test helper: defaults + overrides, no process.env. */
export function testConfig(over: Partial<Record<keyof Config, string>> = {}): Config {
  return ConfigSchema.parse({ NODE_ENV: "test", LOG_LEVEL: "silent", ...over });
}

/** Reads the RSA key material (XML or PEM text) from config. */
export const REPO_ROOT = resolve(APP_ROOT, "..", "..");

/** RSA key text: env > file > (dev) vendor Web.config "privateKey" (identical to apps/api/src/config.ts). */
export function readRsaKeyText(cfg: Config): string | null {
  if (cfg.RSA_PRIVATE_KEY && cfg.RSA_PRIVATE_KEY.trim()) return cfg.RSA_PRIVATE_KEY;
  if (cfg.RSA_PRIVATE_KEY_FILE) return readFileSync(resolve(cfg.RSA_PRIVATE_KEY_FILE), "utf8");
  if (cfg.RSA_USE_VENDOR_KEY && cfg.NODE_ENV !== "production") {
    const wc = resolve(REPO_ROOT, "vendor", "DDTank41", "Tank.Request", "Web.config");
    if (existsSync(wc)) {
      const m = /key="privateKey"\s+value="([^"]+)"/.exec(readFileSync(wc, "utf8"));
      if (m) return m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    }
  }
  return null;
}
