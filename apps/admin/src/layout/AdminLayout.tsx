import { useState } from "react";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, LocaleToggle, cn } from "@ddtank/ui";
import { CalendarDays, FolderOpen, Gauge, LogOut, Mail, Menu, Settings2, X, type LucideIcon } from "lucide-react";
import { api, meQuery } from "@/lib/api";
import { resources } from "@/resources";
import type { NavGroup } from "@/crud/types";
import { useI18n, useText, type TKey, type Text } from "@/i18n";

interface NavItem {
  to: string;
  label: Text | { key: TKey };
  icon: LucideIcon;
  group: NavGroup;
  order: number;
}

const GROUPS: NavGroup[] = ["overview", "server", "players", "content", "site", "system"];

// Custom pages; resources are appended from the registry. `order` sorts inside a group.
const CUSTOM: NavItem[] = [
  { to: "/", label: { key: "nav.dashboard" }, icon: Gauge, group: "overview", order: 0 },
  { to: "/config", label: { key: "nav.config" }, icon: Settings2, group: "server", order: 0 },
  { to: "/assets", label: { key: "nav.assets" }, icon: FolderOpen, group: "server", order: 20 },
  { to: "/mail", label: { key: "nav.mail" }, icon: Mail, group: "players", order: 5 },
  { to: "/events", label: { key: "nav.events" }, icon: CalendarDays, group: "content", order: 45 },
];

const NAV: NavItem[] = [
  ...CUSTOM,
  ...resources
    .filter((r) => !r.hidden)
    .map((r, i) => ({ to: `/${r.name}`, label: r.label, icon: r.icon, group: r.group, order: 10 + i * 10 })),
].sort((a, b) => a.order - b.order);

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const text = useText();
  const label = (l: NavItem["label"]) => (typeof l === "object" && "key" in l ? t(l.key) : text(l));
  return (
    <nav className="flex flex-col gap-5 px-3 py-4" aria-label={t("nav.menu")}>
      {GROUPS.map((g) => {
        const items = NAV.filter((n) => n.group === g);
        if (!items.length) return null;
        return (
          <div key={g}>
            <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted/70">{t(`nav.group.${g}` as TKey)}</p>
            <ul className="flex flex-col gap-0.5">
              {items.map((n) => {
                const Icon = n.icon;
                return (
                  <li key={n.to}>
                    <Link
                      to={n.to}
                      onClick={onNavigate}
                      activeOptions={{ exact: n.to === "/" }}
                      className={cn(
                        "flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted transition-colors hover:bg-panel-2 hover:text-ink",
                        "data-[status=active]:bg-sun data-[status=active]:font-semibold data-[status=active]:text-night-deep data-[status=active]:shadow-toy-sm",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      {label(n.label)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function Brand() {
  const { t } = useI18n();
  return (
    <Link to="/" className="flex items-center gap-2 px-5 py-4">
      <svg viewBox="0 0 64 64" className="size-8" aria-hidden>
        <rect width="64" height="64" rx="16" className="fill-panel-2" />
        <path d="M8 52 Q 32 4 56 44" className="stroke-sun" strokeWidth="4" strokeLinecap="round" strokeDasharray="1 8" fill="none" />
        <circle cx="54" cy="46" r="7" className="fill-coral" />
        <rect x="6" y="46" width="16" height="10" rx="3" className="fill-mint" />
      </svg>
      <span className="title-plate text-xl">
        {t("app.name")}
      </span>
    </Link>
  );
}

export function AdminLayout() {
  const { t, locale, setLocale } = useI18n();
  const { data: me } = useQuery(meQuery);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const logout = () => {
    api.setToken(null);
    qc.setQueryData(meQuery.queryKey, null);
    void navigate({ to: "/login" });
  };

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-night-deep lg:flex">
        <Brand />
        <Sidebar />
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-night-deep/80" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 overflow-y-auto border-r border-line bg-night-deep animate-pop">
            <div className="flex items-center justify-between pr-3">
              <Brand />
              <Button variant="ghost" size="icon" aria-label={t("nav.closeMenu")} onClick={() => setOpen(false)}>
                <X />
              </Button>
            </div>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-night/85 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t("nav.openMenu")} onClick={() => setOpen(true)}>
            <Menu />
          </Button>
          <div className="ml-auto flex items-center gap-3">
            <LocaleToggle locale={locale} onChange={setLocale} />
            {me && (
              <span className="hidden text-sm text-muted sm:inline">
                {me.username} · <span className="text-sun">{me.role}</span>
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOut /> {t("nav.logout")}
            </Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
