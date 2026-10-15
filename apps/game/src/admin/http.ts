/**
 * Internal admin/control channel on 127.0.0.1:9400 (replaces the Center WCF service used by GameAdmin/Tank.Request):
 *   GET  /status            {online, players, rooms, capacity}   (apps/api public status proxy)
 *   GET  /stats             detailed counters                     (apps/api admin)
 *   POST /broadcast {msg, type?}       system notice to everyone (center SYS_NOTICE 10 -> 3 SYS_MESSAGE)
 *   POST /kick {userId | nick, msg?}   KITOFF_USER
 *   POST /reload-templates             reload item/shop/map caches + event templates + app."ScheduledEvents"
 *   GET  /events                       scheduler status (open windows, next starts, x2 rates, world boss ranking)
 *   POST /events/start {kind, minutes} force-open a scheduled system now (admin "start now")
 *   POST /events/stop {kind}           close the open window of that kind until its next start
 *   POST /mail-notice {userId}         117 MAIL_RESPONSE to an online player (apps/api mailed something)
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "../util/log.js";

export interface AdminApi {
  status(): Record<string, unknown>;
  stats(): Record<string, unknown>;
  broadcast(msg: string, type: number): number;
  kick(target: { userId?: number; nick?: string }, msg: string): Promise<boolean>;
  reloadTemplates(): Promise<Record<string, number>>;
  events(): Record<string, unknown>;
  eventsForce(kind: string, minutes: number): Promise<Record<string, unknown>>;
  eventsStop(kind: string): Promise<Record<string, unknown>>;
  mailNotice(userId: number): boolean;
  activityExchangeRead?(body: unknown): Promise<unknown>;
  activityExchangeAction?(body: unknown): Promise<unknown>;
}

function readJson(req: http.IncomingMessage, max = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        rej(new Error("payload too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        rej(e);
      }
    });
    req.on("error", rej);
  });
}

export function startAdmin(host: string, port: number, token: string | undefined, api: AdminApi, log: Logger): Promise<http.Server> {
  const srv = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (token && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/status") return send(200, api.status());
      if (req.method === "GET" && url.pathname === "/stats") return send(200, api.stats());
      if (req.method === "POST" && url.pathname === "/broadcast") {
        const b = await readJson(req);
        if (typeof b.msg !== "string" || !b.msg) return send(400, { error: "msg required" });
        return send(200, { sent: api.broadcast(b.msg.slice(0, 1000), typeof b.type === "number" ? b.type : 3) });
      }
      if (req.method === "POST" && url.pathname === "/kick") {
        const b = await readJson(req);
        const ok = await api.kick({ userId: typeof b.userId === "number" ? b.userId : undefined, nick: typeof b.nick === "string" ? b.nick : undefined }, typeof b.msg === "string" ? b.msg : "Kick");
        return send(ok ? 200 : 404, { kicked: ok });
      }
      if (req.method === "POST" && url.pathname === "/reload-templates") return send(200, await api.reloadTemplates());
      if (req.method === "GET" && url.pathname === "/events") return send(200, api.events());
      if (req.method === "POST" && url.pathname === "/events/start") {
        const b = await readJson(req);
        if (typeof b.kind !== "string" || !b.kind) return send(400, { error: "kind required" });
        return send(200, await api.eventsForce(b.kind, Math.max(1, Math.min(1440, Number(b.minutes) || 30))));
      }
      if (req.method === "POST" && url.pathname === "/events/stop") {
        const b = await readJson(req);
        if (typeof b.kind !== "string" || !b.kind) return send(400, { error: "kind required" });
        return send(200, await api.eventsStop(b.kind));
      }
      if (req.method === "POST" && url.pathname === "/mail-notice") {
        const b = await readJson(req);
        return send(200, { sent: api.mailNotice(Number(b.userId)) });
      }
      if (req.method === "POST" && url.pathname === "/activity-exchange/read") {
        if (!api.activityExchangeRead) return send(503, { error: "activity exchange unavailable" });
        return send(200, await api.activityExchangeRead(await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/activity-exchange/action") {
        if (!api.activityExchangeAction) return send(503, { error: "activity exchange unavailable" });
        return send(200, await api.activityExchangeAction(await readJson(req)));
      }
      send(404, { error: "not found" });
    } catch (err) {
      log.error("admin request failed", err);
      send(500, { error: (err as Error).message });
    }
  });
  return new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(port, host, () => {
      log.info(`admin channel on http://${host}:${(srv.address() as AddressInfo).port}`);
      res(srv);
    });
  });
}
