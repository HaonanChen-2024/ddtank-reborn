import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, Spinner } from "@ddtank/ui";
import { ArrowLeft, Maximize } from "lucide-react";
import { GameFrame } from "@/components/GameFrame";
import { AimSidePanel } from "@/components/AimTablePanel";
import { aimTablesQuery, configQuery } from "@/lib/api";
import { useI18n } from "@/i18n";
import "./play.css";

/** Unscaled "design" size of .play-stage (apps/web/src/pages/play.css) — kept in sync by hand (no layout
 *  measurement round-trip needed before the first paint). */
const STAGE_W = 1932;
const STAGE_H = 836;
/** Breathing room so the composition never touches the viewport edges. */
const STAGE_MARGIN = 24;

/** Scales `.play-stage` to fit the viewport via CSS transform (GPU compositing — crisp at any factor, unlike
 *  resizing the 1000x600 game canvas itself, which the frame never does: GameFrame always renders at its real
 *  1000x600 CSS size). Snapped to the nearest 0.01 so the composition's hairline borders don't shimmer between
 *  renders while the window is actively being resized. */
function useStageScale(availRef: React.RefObject<HTMLElement | null>): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = availRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth - STAGE_MARGIN * 2;
      const h = el.clientHeight - STAGE_MARGIN * 2;
      const s = Math.min(1, w / STAGE_W, h / STAGE_H);
      setScale(Math.max(0.2, Math.round(s * 100) / 100));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    window.addEventListener("resize", compute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", compute);
    };
  }, [availRef]);
  return scale;
}

function LogoSlot() {
  const [broken, setBroken] = useState(false);
  return (
    <div className="play-logo-slot">
      {!broken ? (
        <img src="/play/logo.webp" alt="DDReborn" onError={() => setBroken(true)} />
      ) : (
        <span className="play-logo-fallback">DDReborn</span>
      )}
    </div>
  );
}

function Ruler() {
  const ticks = Array.from({ length: 11 }, (_, i) => i); // 0..10, 100px apart over the 1000px game width
  return (
    <div className="play-ruler" aria-hidden="true">
      {ticks.map((n) => (
        <div className="play-ruler-tick" key={n}>
          <span>{n}</span>
        </div>
      ))}
    </div>
  );
}

/** Full-page game page: parchment/gold "DD Clássico" composition (background, logo, ornamental frame, angle/force
 *  reference tables, distance ruler) hosting the real Ruffle client in an exact 1000x600 hole. Auth/config fetch
 *  and the fullscreen button are unchanged from before the redesign. */
export function PlayPage() {
  const { t } = useI18n();
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const { data, error, isLoading, refetch } = useQuery({ ...configQuery, staleTime: 0 });
  const aim = useQuery(aimTablesQuery);
  const scale = useStageScale(viewportRef);

  const fullscreen = () => {
    void fullscreenRef.current?.requestFullscreen?.();
  };

  const distances = aim.data?.distances ?? [];
  const rows = aim.data?.rows ?? [];
  const half = Math.ceil(rows.length / 2);
  const leftRows = rows.slice(0, half);
  const rightRows = rows.slice(half);

  return (
    <div ref={fullscreenRef} className="fixed inset-0 z-50 flex flex-col bg-night-deep">
      <div className="relative z-10 flex h-10 shrink-0 items-center gap-1 border-b border-line/60 bg-night px-2 sm:gap-2">
        <Button variant="ghost" size="sm" className="shrink-0 px-2 sm:px-3" asChild>
          <Link to="/" aria-label={t("play.back")} title={t("play.back")}>
            <ArrowLeft /> <span className="hidden sm:inline">{t("play.back")}</span>
          </Link>
        </Button>
        <span className="hidden min-w-0 truncate font-display text-muted sm:block">{data?.serverName}</span>
        <details className="ml-auto shrink-0">
          <summary className="cursor-pointer rounded-lg px-2 py-1 font-display text-sm text-ink hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-sun">
            {t("play.soloHelp")}
          </summary>
          <div className="absolute right-2 top-full mt-2 max-h-[calc(100dvh-3rem)] w-[calc(100%-1rem)] max-w-sm overflow-y-auto rounded-xl border border-line bg-night p-4 text-sm leading-relaxed text-ink shadow-lg">
            <ol className="list-decimal space-y-2 pl-4">
              <li>{t("play.soloHelp.experience")}</li>
              <li>{t("play.soloHelp.arena")}</li>
              <li>{t("play.soloHelp.quickJoin")}</li>
            </ol>
          </div>
        </details>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2 sm:px-3"
          onClick={fullscreen}
          aria-label={t("play.fullscreen")}
          title={t("play.fullscreen")}
        >
          <Maximize /> <span className="hidden sm:inline">{t("play.fullscreen")}</span>
        </Button>
      </div>

      <div className="play-page-bg relative flex-1">
        {isLoading && (
          <div className="absolute inset-0 grid place-items-center">
            <Spinner className="size-10" />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="flex flex-col items-center gap-4">
              <p className="title-plate text-3xl text-coral">{t("play.error")}</p>
              <Button onClick={() => void refetch()}>{t("play.retry")}</Button>
            </div>
          </div>
        )}

        {data && (
          <div ref={viewportRef} className="play-stage-viewport">
            <div className="play-stage" style={{ transform: `scale(${scale})` }}>
              <LogoSlot />

              <div className="play-scroll-post left" />

              <AimSidePanel side="left" rows={leftRows} distances={distances} />

              <div className="play-column-gutter left" />

              <div className="play-frame">
                <span className="play-corner tl" />
                <span className="play-corner tr" />
                <span className="play-corner br" />
                <span className="play-corner bl" />
                <div className="play-frame-hole">
                  <GameFrame {...data.game} />
                </div>
              </div>

              <div className="play-column-gutter right" />

              <AimSidePanel side="right" rows={rightRows} distances={distances} />

              <div className="play-scroll-post right" />

              <Ruler />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
