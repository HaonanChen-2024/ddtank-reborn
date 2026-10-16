import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Card, PageHeader, Switch, Tabs, TabsContent, TabsList, TabsTrigger, cn } from "@ddtank/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { listQuery, useResourceMutations } from "@/crud/api";
import { ResourcePage } from "@/crud/ResourcePage";
import { events } from "@/resources/content";
import { dailyAward, eventAwards, eventCodes, onlineBoxes, scheduledEvents, timeBoxes } from "@/resources/event-systems";
import { api } from "@/lib/api";
import { useI18n } from "@/i18n";

/** Row of game."Active". */
interface EventRow {
  ActiveID: number;
  Title: string;
  Type: number;
  StartDate: string;
  EndDate: string;
  IsShow: boolean;
}

// Calendar chip color per Active.Type (identity only; the title is always shown).
const TYPE_COLORS = ["var(--color-sun)", "var(--color-mint)", "var(--color-sky)", "var(--color-grape)", "var(--color-coral)"];
const colorOf = (e: EventRow) => TYPE_COLORS[Math.abs(Number(e.Type) || 0) % TYPE_COLORS.length];

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function Calendar() {
  const { t, locale } = useI18n();
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const { data } = useQuery(listQuery(events, { page: 1, pageSize: 500, sort: "StartDate" }));
  const { update } = useResourceMutations(events);
  const rows = (data?.items ?? []) as unknown as EventRow[];

  const monthStart = cursor;
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59);
  // Grid starts on Sunday of the first week.
  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay());
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });

  const inMonth = rows.filter((e) => new Date(e.StartDate) <= monthEnd && new Date(e.EndDate) >= monthStart);
  const byDay = useMemo(() => {
    const m = new Map<string, EventRow[]>();
    for (const e of rows) {
      const s = startOfDay(new Date(e.StartDate));
      const end = startOfDay(new Date(e.EndDate));
      for (let d = new Date(s); d <= end; d.setDate(d.getDate() + 1)) {
        const k = dayKey(d);
        m.set(k, [...(m.get(k) ?? []), e]);
      }
    }
    return m;
  }, [rows]);

  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const monthFmtRaw = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" });
  const monthFmt = { format: (d: Date) => { const s = monthFmtRaw.format(d); return s.charAt(0).toUpperCase() + s.slice(1); } };
  const rangeFmt = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short" });
  const todayKey = dayKey(new Date());
  const shift = (n: number) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + n, 1));

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="font-display text-2xl">{monthFmt.format(cursor)}</h2>
          <div className="ml-auto flex gap-1">
            <Button size="icon" variant="secondary" aria-label="上个月" onClick={() => shift(-1)}>
              <ChevronLeft />
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
              {t("events.today")}
            </Button>
            <Button size="icon" variant="secondary" aria-label="下个月" onClick={() => shift(1)}>
              <ChevronRight />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-xs">
          {days.slice(0, 7).map((d) => (
            <div key={d.getDay()} className="px-2 py-1 font-semibold uppercase tracking-wider text-muted">
              {weekday.format(d)}
            </div>
          ))}
          {days.map((d) => {
            const k = dayKey(d);
            const list = byDay.get(k) ?? [];
            const outside = d.getMonth() !== cursor.getMonth();
            return (
              <div
                key={k}
                className={cn(
                  "min-h-24 rounded-xl border border-line/60 bg-night-deep/40 p-1.5",
                  outside && "opacity-40",
                  k === todayKey && "border-sun",
                )}
              >
                <div className={cn("mb-1 text-right font-mono", k === todayKey ? "text-sun" : "text-muted")}>{d.getDate()}</div>
                <div className="flex flex-col gap-0.5">
                  {list.slice(0, 3).map((e) => (
                    <span
                      key={e.ActiveID}
                      title={e.Title}
                      className={cn("truncate rounded-md px-1.5 py-0.5 font-semibold text-night-deep", !e.IsShow && "line-through opacity-50")}
                      style={{ background: colorOf(e) }}
                    >
                      {e.Title}
                    </span>
                  ))}
                  {list.length > 3 && <span className="px-1 text-muted">+{list.length - 3}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 font-display text-lg">{monthFmt.format(cursor)}</h2>
        <ul className="flex flex-col gap-2">
          {inMonth.length === 0 && <li className="text-sm text-muted">{t("crud.empty")}</li>}
          {inMonth.map((e) => {
            return (
              <li key={e.ActiveID} className="flex items-center gap-3 rounded-xl border border-line/60 p-3">
                <span className="size-3 shrink-0 rounded-full" style={{ background: colorOf(e) }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{e.Title}</p>
                  <p className="text-xs text-muted">
                    {rangeFmt.format(new Date(e.StartDate))} – {rangeFmt.format(new Date(e.EndDate))}
                  </p>
                </div>
                <Switch
                  checked={e.IsShow}
                  aria-label={e.Title}
                  onCheckedChange={(IsShow) =>
                    update.mutate({ id: e.ActiveID, body: { IsShow } }, { onError: () => toast.error(t("common.error")) })
                  }
                />
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

interface SchedStatus {
  now: string;
  open: { id: number; kind: string; title: string; start: string; end: string }[];
  next: { id: number; kind: string; title: string; next: string | null }[];
  rates: { exp: number; gold: number };
  worldBoss: { name: string; blood: number; maxBlood: number; players: number; ranking: { nick: string; damage: number }[] } | null;
  eliteStatus: number;
  leagueOpen: boolean;
  log: string[];
}

const KIND_LABEL: Record<string, string> = {
  worldboss: "世界首领",
  league: "联赛",
  elite: "精英赛",
  weekly_reset: "每周重置",
  double_exp: "双倍经验",
  double_gold: "双倍金币",
};

const fmtUtc = (s: string | null) => (s ? new Date(s).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");

/** Live scheduler state from apps/game (GET /events on the internal channel) + start/stop now. */
function SchedulerPanel() {
  const qc = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ["events", "status"],
    queryFn: () => api.get<SchedStatus>("/api/admin/events/status"),
    refetchInterval: 10_000,
  });
  const [minutes, setMinutes] = useState(30);
  const act = async (path: string, body: Record<string, unknown>) => {
    try {
      await api.post(path, body);
      toast.success("操作已完成");
      await qc.invalidateQueries({ queryKey: ["events", "status"] });
    } catch {
      toast.error("游戏服务暂不可用");
    }
  };
  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-lg">服务器活动调度</h2>
        {data && (
          <span className="text-sm text-muted">
            经验 ×{data.rates.exp} · 金币 ×{data.rates.gold} · 精英赛 {data.eliteStatus || "已关闭"} · 联赛 {data.leagueOpen ? "已开放" : "已关闭"}
          </span>
        )}
        {error && <span className="text-sm text-coral">游戏服务暂不可用</span>}
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => act("/api/admin/events/reload", {})}>
          重新加载到游戏
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="mb-1 text-sm font-semibold">当前开放</p>
          <ul className="flex flex-col gap-1 text-sm">
            {(data?.open ?? []).length === 0 && <li className="text-muted">暂无</li>}
            {data?.open.map((w) => (
              <li key={`${w.kind}${w.start}`} className="flex items-center gap-2">
                <span className="font-semibold">{KIND_LABEL[w.kind] ?? w.kind}</span>
                <span className="text-muted">截止 {fmtUtc(w.end)}</span>
                <Button size="sm" variant="ghost" onClick={() => act("/api/admin/events/stop", { kind: w.kind })}>
                  结束
                </Button>
              </li>
            ))}
          </ul>
          {data?.worldBoss && (
            <p className="mt-2 text-sm">
              {data.worldBoss.name}: {data.worldBoss.blood.toLocaleString()} / {data.worldBoss.maxBlood.toLocaleString()} 生命值 · 房间内 {data.worldBoss.players} 人
              {data.worldBoss.ranking.length > 0 && ` · 第 1 名 ${data.worldBoss.ranking[0]!.nick} (${data.worldBoss.ranking[0]!.damage})`}
            </p>
          )}
        </div>
        <div>
          <p className="mb-1 text-sm font-semibold">即将开放</p>
          <ul className="flex flex-col gap-1 text-sm">
            {data?.next.map((n) => (
              <li key={n.id}>
                <span className="font-semibold">{n.title || KIND_LABEL[n.kind] || n.kind}</span> <span className="text-muted">{fmtUtc(n.next)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-sm">立即开放，持续</span>
        <input
          type="number"
          min={1}
          max={1440}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value) || 30)}
          className="w-20 rounded-lg border border-line bg-transparent px-2 py-1 text-sm"
          aria-label="分钟"
        />
        <span className="text-sm">分钟：</span>
        {Object.entries(KIND_LABEL).map(([k, l]) => (
          <Button key={k} size="sm" variant="outline" onClick={() => act("/api/admin/events/start", { kind: k, minutes })}>
            {l}
          </Button>
        ))}
      </div>
      {data && data.log.length > 0 && <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-black/20 p-2 text-xs">{data.log.join("\n")}</pre>}
    </Card>
  );
}

/** Activation codes (player."Active_Number") for an Active with HasKey 1/4. */
function CodesPanel() {
  const [activeId, setActiveId] = useState(0);
  const [count, setCount] = useState(10);
  const [codes, setCodes] = useState<string[]>([]);
  const gen = async () => {
    try {
      const r = await api.post<{ codes: string[] }>(`/api/admin/events/${activeId}/codes`, { count });
      setCodes(r.codes);
      toast.success(`${r.codes.length} 个兑换码`);
    } catch {
      toast.error("生成兑换码失败");
    }
  };
  return (
    <Card className="mb-4 flex flex-wrap items-center gap-2 p-4">
      <span className="text-sm">生成活动兑换码（ActiveID，HasKey 为 1 或 4）</span>
      <input type="number" value={activeId} onChange={(e) => setActiveId(Number(e.target.value))} className="w-24 rounded-lg border border-line bg-transparent px-2 py-1 text-sm" aria-label="ActiveID" />
      <input type="number" value={count} min={1} max={1000} onChange={(e) => setCount(Number(e.target.value))} className="w-20 rounded-lg border border-line bg-transparent px-2 py-1 text-sm" aria-label="数量" />
      <Button size="sm" onClick={gen} disabled={!activeId}>
        生成
      </Button>
      {codes.length > 0 && <textarea readOnly className="mt-2 h-24 w-full rounded-lg border border-line bg-transparent p-2 font-mono text-xs" value={codes.join("\n")} />}
    </Card>
  );
}

export function EventsPage() {
  const { t } = useI18n();
  return (
    <div>
      <PageHeader title={t("events.title")} description={t("events.lead")} />
      <Tabs defaultValue="calendar">
        <TabsList>
          <TabsTrigger value="calendar">{t("events.calendar")}</TabsTrigger>
          <TabsTrigger value="table">{t("events.table")}</TabsTrigger>
          <TabsTrigger value="scheduled">定时活动</TabsTrigger>
          <TabsTrigger value="awards">活动奖励</TabsTrigger>
          <TabsTrigger value="codes">兑换码</TabsTrigger>
          <TabsTrigger value="daily">签到奖励</TabsTrigger>
          <TabsTrigger value="online-boxes">在线宝箱</TabsTrigger>
          <TabsTrigger value="boxes">等级/贵宾与旧数据</TabsTrigger>
        </TabsList>
        <TabsContent value="calendar">
          <Calendar />
        </TabsContent>
        <TabsContent value="table">
          <ResourcePage def={events} embedded />
        </TabsContent>
        <TabsContent value="scheduled">
          <SchedulerPanel />
          <ResourcePage def={scheduledEvents} embedded />
        </TabsContent>
        <TabsContent value="awards">
          <ResourcePage def={eventAwards} embedded />
        </TabsContent>
        <TabsContent value="codes">
          <CodesPanel />
          <ResourcePage def={eventCodes} embedded />
        </TabsContent>
        <TabsContent value="daily">
          <ResourcePage def={dailyAward} embedded />
        </TabsContent>
        <TabsContent value="online-boxes">
          <p className="mb-4 text-sm text-muted">
            在线宝箱只读展示 User_Box 的 Type 0 配置。原客户端固定四档等待时间为 15/40/60/75 分钟，不能只改服务端配置；每领取一档后重新计时。
            客户端还固定了 20 级限制，与当前服务端种子的 60 级上限不同，需要客户端单独验收。
          </p>
          <ResourcePage def={onlineBoxes} embedded />
        </TabsContent>
        <TabsContent value="boxes">
          <p className="mb-4 text-sm text-muted">
            此处编辑等级礼包（类型1）和贵宾礼包（类型2）。旧类型0数据保留兼容，修改它不会影响当前在线宝箱。
          </p>
          <ResourcePage def={timeBoxes} embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}
