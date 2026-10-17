import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, LocaleToggle } from "@ddtank/ui";
import { Play } from "lucide-react";
import { api, meQuery } from "@/lib/api";
import { useI18n } from "@/i18n";

export function Logo() {
  return (
    <Link to="/" className="group flex items-center gap-2" aria-label="弹弹堂">
      <svg viewBox="0 0 64 64" className="size-9" aria-hidden>
        <rect width="64" height="64" rx="16" className="fill-panel-2" />
        <path d="M8 52 Q 32 4 56 44" className="stroke-sun" strokeWidth="4" strokeLinecap="round" strokeDasharray="1 8" fill="none" />
        <circle cx="54" cy="46" r="7" className="fill-coral transition-transform group-hover:-translate-y-1" />
        <rect x="6" y="46" width="16" height="10" rx="3" className="fill-mint" />
      </svg>
      <span className="title-plate text-2xl text-ink">弹弹堂</span>
    </Link>
  );
}

const navLink =
  "rounded-lg px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-ink data-[status=active]:text-sun";

export function SiteLayout() {
  const { t, locale, setLocale } = useI18n();
  const { data: me } = useQuery(meQuery);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const logout = () => {
    api.setToken(null);
    qc.setQueryData(meQuery.queryKey, null);
    void navigate({ to: "/" });
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line/60 bg-night/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <Logo />
          <nav className="ml-2 hidden items-center gap-1 md:flex">
            <Link to="/" className={navLink} activeOptions={{ exact: true }}>
              {t("nav.home")}
            </Link>
            <Link to="/ranking" className={navLink}>
              {t("nav.ranking")}
            </Link>
            {me && (
              <Link to="/account" className={navLink}>
                {t("nav.account")}
              </Link>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <LocaleToggle locale={locale} onChange={setLocale} />
            {me ? (
              <Button variant="ghost" size="sm" onClick={logout}>
                {t("nav.logout")}
              </Button>
            ) : (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/login">{t("nav.login")}</Link>
              </Button>
            )}
            <Button size="sm" asChild>
              <Link to="/play">
                <Play /> {t("nav.play")}
              </Link>
            </Button>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
          <Link to="/" className={navLink} activeOptions={{ exact: true }}>
            {t("nav.home")}
          </Link>
          <Link to="/ranking" className={navLink}>
            {t("nav.ranking")}
          </Link>
          {me && (
            <Link to="/account" className={navLink}>
              {t("nav.account")}
            </Link>
          )}
        </nav>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-line/60 py-8 text-center text-xs text-muted">
        <p>{t("footer.note")}</p>
      </footer>
    </div>
  );
}
