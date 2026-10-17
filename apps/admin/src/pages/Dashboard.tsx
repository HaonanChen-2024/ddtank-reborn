import { useQuery } from "@tanstack/react-query";
import { Button, Card, PageHeader, PowerGauge, Skeleton, StatusDot } from "@ddtank/ui";
import { statsQuery } from "@/lib/api";
import { TimeSeriesChart } from "@/components/TimeSeriesChart";
import { useI18n } from "@/i18n";

function uptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}天 ${h}小时` : `${h}小时 ${m}分钟`;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-2 font-display text-4xl leading-none">{value}</p>
      {sub && <p className="mt-2 text-sm text-muted">{sub}</p>}
    </Card>
  );
}

export function DashboardPage() {
  const { t, locale } = useI18n();
  const { data, isLoading, error, refetch } = useQuery(statsQuery);

  if (error) {
    return (
      <div>
        <PageHeader title={t("dash.title")} description={t("dash.lead")} />
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <p className="text-coral">{t("crud.loadError")}</p>
          <Button variant="secondary" onClick={() => void refetch()}>
            {t("crud.retry")}
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t("dash.title")} description={t("dash.lead")} />
      {isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card className="p-5 sm:col-span-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t("dash.online")}</p>
                <span className="flex items-center gap-2 text-xs text-muted">
                  <StatusDot online /> {t("dash.uptime")}: <span className="font-mono text-ink">{uptime(data.uptimeSec)}</span>
                </span>
              </div>
              <p className="mt-2 font-display text-6xl leading-none text-sun">{data.onlinePlayers.toLocaleString(locale)}</p>
              <PowerGauge
                className="mt-4"
                value={data.onlinePlayers / Math.max(1, data.capacity)}
                label={t("dash.capacity")}
                readout={`${data.onlinePlayers} / ${data.capacity}`}
              />
            </Card>
            <Kpi label={t("dash.rooms")} value={data.rooms.toLocaleString(locale)} />
            <Kpi
              label={t("dash.matches")}
              value={data.matchesInProgress.toLocaleString(locale)}
              sub={t("dash.matchesToday", { n: data.matchesToday.toLocaleString(locale) })}
            />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <TimeSeriesChart
                title={t("dash.cpu")}
                data={data.cpu}
                max={100}
                unit="%"
                color="var(--color-chart-1)"
                locale={locale}
                caption={t("dash.chartHint", { n: data.cpu.length })}
              />
            </Card>
            <Card className="p-5">
              <TimeSeriesChart
                title={`${t("dash.mem")} (MB)`}
                data={data.mem}
                max={data.memTotalMb}
                unit=" MB"
                color="var(--color-chart-2)"
                locale={locale}
                caption={t("dash.chartHint", { n: data.mem.length })}
              />
            </Card>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label={t("dash.registered")} value={data.registeredToday.toLocaleString(locale)} />
          </div>
        </>
      )}
    </div>
  );
}
