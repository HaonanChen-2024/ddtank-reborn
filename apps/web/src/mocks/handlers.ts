import { http, HttpResponse, delay } from "msw";
import type { AuthResponse, Me, NewsItem, PublicConfig, RankingRow, RankingType, ServerStatus, User } from "@/lib/api";

// Dev-only fake API (VITE_USE_MOCKS=true). Shapes mirror the contract in src/lib/api.ts.

const users = new Map<string, { user: User; password: string }>([
  ["jogador", { user: { id: 1, username: "jogador", email: "jogador@example.com", role: "player" }, password: "123456" }],
]);
const tokenFor = (u: User) => `mock-${u.username}`;
const userFromAuth = (req: Request): User | null => {
  const h = req.headers.get("Authorization") ?? "";
  const name = h.replace(/^Bearer mock-/, "");
  return users.get(name)?.user ?? null;
};

const NICKS = ["Canhoneiro", "VentoNorte", "Bombardino", "LuaDeFogo", "TiroCerto", "Zeca_Bala", "Pólvora", "ArcoÍris", "Trovão", "Mira9000"];
const GUILDS = ["Artilharia BR", "Os Pombos", null, "Ventania", "Clube do Ângulo"];

export const handlers = [
  http.get("/api/public/config", ({ request }) => {
    const u = userFromAuth(request);
    const body: PublicConfig = {
      serverName: "DDTank Reborn · S1",
      launcherUrl: "/downloads/DDTankLauncher-Setup.exe",
      game: {
        rufflePath: "/ruffle/ruffle.js",
        swfUrl: "/client/Loading.swf",
        flashvars: { user: u?.username ?? "", key: "mock-session-key", config: "/client/config.xml" },
        socketProxy: [{ host: "127.0.0.1", port: 9200, proxyUrl: "ws://localhost:8080/ws/game" }],
      },
    };
    return HttpResponse.json(body);
  }),

  http.get("/api/public/status", async () => {
    await delay(250);
    const body: ServerStatus = {
      online: true,
      maintenance: false,
      players: 312 + Math.floor(Math.random() * 20),
      capacity: 1000,
      rooms: 47,
      version: "4.1.0",
      motd: "周末双倍经验！",
    };
    return HttpResponse.json(body);
  }),

  http.get("/api/public/news", async () => {
    await delay(300);
    const body: NewsItem[] = [
      {
        id: 3,
        title: "活动：强风周",
        summary: "风力超过 3 的对局可额外获得宝箱，持续至周日。",
        category: "event",
        publishedAt: "2026-09-28T12:00:00Z",
      },
      {
        id: 2,
        title: "新副本：蚂蚁之巢",
        summary: "20 级起可进入的四人副本，英雄模式包含首领战。",
        category: "update",
        publishedAt: "2026-09-20T15:00:00Z",
      },
      {
        id: 1,
        title: "维护公告",
        summary: "周四 04:00 至 06:00 更新战斗服务器。",
        category: "maintenance",
        publishedAt: "2026-09-15T09:00:00Z",
      },
    ];
    return HttpResponse.json(body);
  }),

  http.get("/api/public/ranking", async ({ request }) => {
    await delay(200);
    const type = (new URL(request.url).searchParams.get("type") ?? "level") as RankingType;
    const mult = { level: 1, gp: 4100, offer: 37, fight: 520 }[type] ?? 1;
    const body: RankingRow[] = Array.from({ length: 20 }, (_, i) => {
      const level = 60 - Math.floor(i * 1.7);
      return {
        rank: i + 1,
        nickname: `${NICKS[i % NICKS.length]}${i >= NICKS.length ? i : ""}`,
        guild: GUILDS[i % GUILDS.length] ?? null,
        level,
        value: type === "level" ? level : Math.round((2000 - i * 73) * mult),
      };
    });
    return HttpResponse.json(body);
  }),

  http.post("/api/auth/login", async ({ request }) => {
    await delay(300);
    const { username, password } = (await request.json()) as { username: string; password: string };
    const rec = users.get(username);
    if (!rec || rec.password !== password) return HttpResponse.json({ message: "用户名或密码错误" }, { status: 401 });
    return HttpResponse.json<AuthResponse>({ token: tokenFor(rec.user), user: rec.user });
  }),

  http.post("/api/auth/register", async ({ request }) => {
    await delay(300);
    const { username, email, password } = (await request.json()) as { username: string; email: string; password: string };
    if (users.has(username)) return HttpResponse.json({ message: "用户名已存在" }, { status: 409 });
    const user: User = { id: users.size + 1, username, email, role: "player" };
    users.set(username, { user, password });
    return HttpResponse.json<AuthResponse>({ token: tokenFor(user), user }, { status: 201 });
  }),

  http.get("/api/account/me", ({ request }) => {
    const u = userFromAuth(request);
    if (!u) return HttpResponse.json({ message: "请先登录" }, { status: 401 });
    const body: Me = {
      user: u,
      characters:
        u.username === "jogador"
          ? [{ id: 10, nickname: "Canhoneiro", level: 34, gold: 152_300, money: 4_800, sex: "m", guild: "Artilharia BR" }]
          : [],
    };
    return HttpResponse.json(body);
  }),

  http.post("/api/account/password", async ({ request }) => {
    const u = userFromAuth(request);
    if (!u) return HttpResponse.json({ message: "请先登录" }, { status: 401 });
    const { currentPassword, newPassword } = (await request.json()) as { currentPassword: string; newPassword: string };
    const rec = users.get(u.username)!;
    if (rec.password !== currentPassword) return HttpResponse.json({ message: "当前密码错误" }, { status: 400 });
    rec.password = newPassword;
    return new HttpResponse(null, { status: 204 });
  }),
];
