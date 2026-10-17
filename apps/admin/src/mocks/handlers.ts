import { delay, http, HttpResponse } from "msw";
import { resourceByName } from "@/resources";
import { idFields, rowId, type Row } from "@/crud/types";
import type { AdminStats, AdminUser } from "@/lib/api";
import type { Asset } from "@/pages/Assets";
import { nextId, tables } from "./db";

// Dev-only fake admin API (VITE_USE_MOCKS=true). Login: admin/admin (role admin) or gm/gm (denied).

const accounts: Record<string, { password: string; user: AdminUser }> = {
  admin: { password: "admin", user: { id: 1, username: "admin", email: "admin@example.com", role: "admin" } },
  gm: { password: "gm", user: { id: 2, username: "gm", email: "gm@example.com", role: "gm" } },
};
const authed = (req: Request) => {
  const name = (req.headers.get("Authorization") ?? "").replace(/^Bearer mock-/, "");
  return accounts[name]?.user ?? null;
};
const unauthorized = () => HttpResponse.json({ message: "请先登录" }, { status: 401 });

let serverConfig: Row = {
  publicHost: "jogo.exemplo.com",
  publicIps: ["203.0.113.10"],
  tcpPort: 9200,
  wsUrl: "wss://jogo.exemplo.com/ws/game",
  policyPort: 843,
  resourceUrl: "https://cdn.exemplo.com/resource/",
  requestUrl: "https://api.exemplo.com/",
  flashUrl: "https://cdn.exemplo.com/flash/",
  expRate: 2,
  goldRate: 1,
  dropRate: 1.5,
  offerRate: 1,
  maxPlayers: 1000,
  maintenance: false,
  maintenanceMessage: "",
  motd: "周末双倍经验！",
};

const assets: Asset[] = [];

async function fileToDataUrl(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${file.type || "application/octet-stream"};base64,${btoa(bin)}`;
}

const cpuSeries: { t: string; v: number }[] = [];
const memSeries: { t: string; v: number }[] = [];
function tickSeries() {
  const now = Date.now();
  if (!cpuSeries.length) {
    for (let i = 30; i > 0; i--) {
      cpuSeries.push({ t: new Date(now - i * 60_000).toISOString(), v: 25 + Math.random() * 30 });
      memSeries.push({ t: new Date(now - i * 60_000).toISOString(), v: 900 + Math.random() * 300 });
    }
  }
  const lastC = cpuSeries[cpuSeries.length - 1]!.v;
  const lastM = memSeries[memSeries.length - 1]!.v;
  cpuSeries.push({ t: new Date(now).toISOString(), v: Math.max(3, Math.min(97, lastC + (Math.random() - 0.5) * 12)) });
  memSeries.push({ t: new Date(now).toISOString(), v: Math.max(600, Math.min(2000, lastM + (Math.random() - 0.5) * 60)) });
  if (cpuSeries.length > 30) cpuSeries.shift();
  if (memSeries.length > 30) memSeries.shift();
}

function matches(row: Row, q: string) {
  const needle = q.toLowerCase();
  return Object.values(row).some((v) => (typeof v === "string" || typeof v === "number") && String(v).toLowerCase().includes(needle));
}
function compare(a: unknown, b: unknown) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""), "pt-BR", { numeric: true });
}

export const handlers = [
  // ---- auth ----
  http.post("/api/auth/login", async ({ request }) => {
    await delay(250);
    const { username, password } = (await request.json()) as { username: string; password: string };
    const acc = accounts[username];
    if (!acc || acc.password !== password) return HttpResponse.json({ message: "用户名或密码错误" }, { status: 401 });
    return HttpResponse.json({ token: `mock-${username}`, user: acc.user });
  }),
  http.get("/api/auth/me", ({ request }) => {
    const u = authed(request);
    return u ? HttpResponse.json({ user: u }) : unauthorized();
  }),

  // ---- specific admin endpoints (must come before the generic resource handlers) ----
  http.get("/api/admin/stats", ({ request }) => {
    if (!authed(request)) return unauthorized();
    tickSeries();
    const players = tables.get("players") ?? [];
    const body: AdminStats = {
      onlinePlayers: 300 + Math.floor(Math.random() * 40),
      capacity: Number(serverConfig.maxPlayers) || 1000,
      rooms: 40 + Math.floor(Math.random() * 10),
      matchesInProgress: 18 + Math.floor(Math.random() * 6),
      matchesToday: 1284,
      registeredToday: 37 + (players.length % 5),
      uptimeSec: Math.floor(performance.now() / 1000) + 3 * 86400,
      cpu: [...cpuSeries],
      mem: [...memSeries],
      memTotalMb: 2048,
    };
    return HttpResponse.json(body);
  }),

  http.get("/api/admin/server-config", ({ request }) => (authed(request) ? HttpResponse.json(serverConfig) : unauthorized())),
  http.put("/api/admin/server-config", async ({ request }) => {
    if (!authed(request)) return unauthorized();
    serverConfig = { ...serverConfig, ...((await request.json()) as Row) };
    return HttpResponse.json(serverConfig);
  }),

  http.post("/api/admin/uploads", async ({ request }) => {
    if (!authed(request)) return unauthorized();
    const fd = await request.formData();
    const file = fd.get("file");
    if (!(file instanceof File)) return HttpResponse.json({ message: "请选择文件" }, { status: 400 });
    const folder = String(fd.get("folder") ?? "uploads");
    const url = await fileToDataUrl(file);
    const key = `${folder}/${Date.now()}-${file.name}`;
    assets.push({ key, name: file.name, url, size: file.size, contentType: file.type, updatedAt: new Date().toISOString() });
    return HttpResponse.json({ url, key }, { status: 201 });
  }),

  http.get("/api/admin/assets", ({ request }) => {
    if (!authed(request)) return unauthorized();
    const prefix = new URL(request.url).searchParams.get("prefix") ?? "";
    return HttpResponse.json(assets.filter((a) => a.key.startsWith(prefix + "/")));
  }),
  http.post("/api/admin/assets", async ({ request }) => {
    if (!authed(request)) return unauthorized();
    const fd = await request.formData();
    const file = fd.get("file");
    if (!(file instanceof File)) return HttpResponse.json({ message: "请选择文件" }, { status: 400 });
    const folder = String(fd.get("folder") ?? "uploads");
    const asset: Asset = {
      key: `${folder}/${file.name}`,
      name: file.name,
      url: await fileToDataUrl(file),
      size: file.size,
      contentType: file.type || "application/octet-stream",
      updatedAt: new Date().toISOString(),
    };
    const i = assets.findIndex((a) => a.key === asset.key);
    if (i >= 0) assets[i] = asset;
    else assets.push(asset);
    return HttpResponse.json(asset, { status: 201 });
  }),
  http.delete("/api/admin/assets/:key", ({ request, params }) => {
    if (!authed(request)) return unauthorized();
    const key = decodeURIComponent(String(params.key));
    const i = assets.findIndex((a) => a.key === key);
    if (i >= 0) assets.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post("/api/admin/mail/broadcast", async ({ request }) => {
    const u = authed(request);
    if (!u) return unauthorized();
    await delay(400);
    const body = (await request.json()) as Row;
    const players = tables.get("players")!;
    const recipients =
      body.target === "online"
        ? players.filter((p) => p.State === 1).length
        : body.target === "list"
          ? ((body.nicknames as string[]) ?? []).length
          : body.target === "level"
            ? players.filter((p) => Number(p.Grade) >= Number(body.levelMin ?? 1) && Number(p.Grade) <= Number(body.levelMax ?? 100)).length
            : players.length;
    const hist = tables.get("mail-broadcasts")!;
    hist.unshift({ id: nextId(hist, "id"), sentAt: new Date().toISOString(), subject: body.subject, target: body.target, recipients, sentBy: u.username });
    return HttpResponse.json({ recipients });
  }),

  http.post("/api/admin/players/:id/:action", async ({ request, params }) => {
    if (!authed(request)) return unauthorized();
    const p = tables.get("players")!.find((r) => String(r.UserID) === params.id);
    if (!p) return HttpResponse.json({ message: "未找到该玩家" }, { status: 404 });
    if (params.action === "ban") {
      const { reason, hours } = (await request.json()) as { reason: string; hours: number | null };
      p.ForbidDate = new Date(Date.now() + (hours ? hours * 3600_000 : 100 * 365 * 86400_000)).toISOString();
      p.ForbidReason = reason;
    } else if (params.action === "unban") {
      p.ForbidDate = null;
      p.ForbidReason = "";
    }
    else if (params.action !== "give-item") return HttpResponse.json({ message: "未知操作" }, { status: 404 });
    return HttpResponse.json({ ok: true });
  }),

  // ---- generic CRUD for every ResourceDef ----
  http.get("/api/admin/:resource", async ({ request, params }) => {
    if (!authed(request)) return unauthorized();
    const def = resourceByName.get(String(params.resource));
    if (!def) return HttpResponse.json({ message: "未知资源" }, { status: 404 });
    await delay(150);
    const sp = new URL(request.url).searchParams;
    const q = sp.get("q") ?? "";
    const page = Math.max(1, Number(sp.get("page") ?? 1));
    const pageSize = Math.min(500, Math.max(1, Number(sp.get("pageSize") ?? 20)));
    const sort = sp.get("sort");
    let rows = tables.get(def.name) ?? [];
    if (q) rows = rows.filter((r) => matches(r, q));
    if (sort) {
      const desc = sort.startsWith("-");
      const field = desc ? sort.slice(1) : sort;
      rows = [...rows].sort((a, b) => compare(a[field], b[field]) * (desc ? -1 : 1));
    }
    const items = rows.slice((page - 1) * pageSize, page * pageSize).map((r) => {
      const copy = { ...r };
      for (const f of def.fields) if (f.type === "password") delete copy[f.name];
      return copy;
    });
    return HttpResponse.json({ items, total: rows.length, page, pageSize });
  }),

  http.get("/api/admin/:resource/:id", ({ request, params }) => {
    if (!authed(request)) return unauthorized();
    const def = resourceByName.get(String(params.resource));
    const row = def && tables.get(def.name)?.find((r) => rowId(def, r) === params.id);
    if (!row) return HttpResponse.json({ message: "未找到记录" }, { status: 404 });
    return HttpResponse.json(row);
  }),

  http.post("/api/admin/:resource", async ({ request, params }) => {
    if (!authed(request)) return unauthorized();
    const def = resourceByName.get(String(params.resource));
    if (!def) return HttpResponse.json({ message: "未知资源" }, { status: 404 });
    const rows = tables.get(def.name)!;
    const body = (await request.json()) as Row;
    const keys = idFields(def);
    if (keys.length === 1 && (body[keys[0]!] === undefined || body[keys[0]!] === null)) body[keys[0]!] = nextId(rows, def.idField);
    if (rows.some((r) => rowId(def, r) === rowId(def, body)))
      return HttpResponse.json({ message: `${keys.join(" + ")} 已存在` }, { status: 409 });
    rows.unshift(body);
    return HttpResponse.json(body, { status: 201 });
  }),

  http.patch("/api/admin/:resource/:id", async ({ request, params }) => {
    if (!authed(request)) return unauthorized();
    const def = resourceByName.get(String(params.resource));
    const row = def && tables.get(def.name)?.find((r) => rowId(def, r) === params.id);
    if (!row) return HttpResponse.json({ message: "未找到记录" }, { status: 404 });
    Object.assign(row, (await request.json()) as Row);
    return HttpResponse.json(row);
  }),

  http.delete("/api/admin/:resource/:id", ({ request, params }) => {
    if (!authed(request)) return unauthorized();
    const def = resourceByName.get(String(params.resource));
    const rows = def && tables.get(def.name);
    if (!rows) return HttpResponse.json({ message: "未找到记录" }, { status: 404 });
    const i = rows.findIndex((r) => rowId(def!, r) === params.id);
    if (i >= 0) rows.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),
];
