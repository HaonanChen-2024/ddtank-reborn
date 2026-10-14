import { useEffect, useRef, useState } from "react";
import { Button, PowerGauge, cn } from "@ddtank/ui";
import type { GameConfig } from "@/lib/api";
import { useI18n } from "@/i18n";

/* Minimal typings for the bits of the Ruffle JS API we use. */
interface RuffleLoadOptions {
  url: string;
  parameters?: Record<string, string>;
  socketProxy?: GameConfig["socketProxy"];
  base?: string;
  [key: string]: unknown;
}
interface RufflePlayerElement extends HTMLElement {
  load?: (opts: RuffleLoadOptions) => Promise<void>;
  ruffle?: () => { load: (opts: RuffleLoadOptions) => Promise<void>; callExternalInterface?: (name: string, ...args: unknown[]) => unknown };
  workshopOpenActivation?: () => unknown;
  workshopOpenSign?: () => unknown;
  workshopOpenWardrobe?: (characterId: number) => boolean;
  workshopStatusWardrobe?: () => { phase?: string; visible?: boolean; actualUserId?: number; errors?: unknown[] };
  workshopCloseWardrobe?: () => unknown;
}
interface RuffleSource {
  createPlayer: () => RufflePlayerElement;
}
interface RuffleGlobal {
  config?: Record<string, unknown>;
  newest?: () => RuffleSource;
}
declare global {
  interface Window {
    RufflePlayer?: RuffleGlobal;
    /** ExternalInterface hook the client calls on kick / socket close (LeavePageManager.forcedToLoginPath). */
    game_interruption?: (loginUrl: string, msg: string) => void;
    workshopOpenActivities?: (characterId: number) => boolean;
    workshopShowActivation?: () => boolean;
    workshopShowSign?: () => boolean;
    workshopShowWardrobe?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
  }
}

const scriptCache = new Map<string, Promise<void>>();

function loadScript(src: string, errorMessage: string): Promise<void> {
  let p = scriptCache.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        scriptCache.delete(src);
        reject(new Error(errorMessage));
      };
      document.head.appendChild(el);
    });
    scriptCache.set(src, p);
  }
  return p;
}

function dirname(url: string): string {
  const i = url.lastIndexOf("/");
  return i >= 0 ? url.slice(0, i + 1) : "./";
}

type Phase = "ruffle" | "swf" | "ready" | "error" | "kicked";

export interface GameFrameProps extends GameConfig {
  className?: string;
  onReady?: () => void;
  onError?: (err: Error) => void;
}

/**
 * Embeds the original DDTank Flash client through Ruffle.
 * Socket connections from the SWF (raw TCP host:port) are tunnelled through the
 * WebSocket URLs in `socketProxy`.
 */
export function GameFrame({ rufflePath, swfUrl, flashvars, socketProxy, base, className, onReady, onError }: GameFrameProps) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("ruffle");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState(0.08);

  // Stable key so a new object with the same values doesn't remount the player.
  const configKey = JSON.stringify({ rufflePath, swfUrl, flashvars, socketProxy, base });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let player: RufflePlayerElement | null = null;
    let wardrobeRequest: { cancel: () => void } | null = null;
    setPhase("ruffle");
    setError(null);

    (async () => {
      try {
        const g: RuffleGlobal = (window.RufflePlayer ??= {});
        g.config = {
          ...g.config,
          publicPath: dirname(rufflePath),
          autoplay: "on",
          unmuteOverlay: "hidden",
          splashScreen: false,
          letterbox: "on",
          contextMenu: "rightClickOnly",
          allowScriptAccess: true,
          openUrlMode: "allow",
          socketProxy,
          // Deployment dictionaries can contain Chinese; keep Latin fallback for untranslated client text.
          // Noto Sans SC (SIL OFL) adds the CJK glyphs the existing Noto Sans subset does not contain.
          fontSources: ["/fonts/NotoSans-Regular.ttf", "/fonts/NotoSans-Bold.ttf", "/fonts/NotoSansSC-Regular.otf", "/fonts/NotoSansSC-Bold.otf"],
          defaultFonts: { sans: ["Noto Sans SC", "Noto Sans"], serif: ["Noto Sans SC", "Noto Sans"], typewriter: ["Noto Sans SC", "Noto Sans"] },
        };
        // Kick (KIT_USER "logged in elsewhere", ban...) or lost socket: the client calls game_interruption.
        // Without this hook the old window stayed on screen looking connected (two "sessions" for one account).
        window.game_interruption = (_loginUrl, msg) => {
          if (cancelled) return;
          setError(String(msg ?? ""));
          setPhase("kicked");
          wardrobeRequest?.cancel();
          player?.remove();
          player = null;
        };
        await loadScript(rufflePath, t("play.scriptError", { src: rufflePath }));
        if (cancelled) return;
        const ruffle = window.RufflePlayer?.newest?.();
        if (!ruffle) throw new Error(t("play.ruffleMissing"));

        player = ruffle.createPlayer();
        player.style.width = "100%";
        player.style.height = "100%";
        player.style.display = "block";
        let readyFired = false;
        const markReady = () => {
          if (cancelled || readyFired) return;
          readyFired = true;
          setPhase("ready");
          onReady?.();
        };
        player.addEventListener("loadedmetadata", markReady);
        host.appendChild(player);
        window.workshopShowActivation = () => {
          if (cancelled || !player) return false;
          try {
            // Ruffle's exposed legacy method exists only after AS3 addCallback has run.
            if (typeof player.workshopOpenActivation !== "function") return false;
            player.workshopOpenActivation();
            return true;
          } catch { return false; }
        };
        window.workshopShowSign = () => {
          if (cancelled || !player || typeof player.workshopOpenSign !== "function") return false;
          try { player.workshopOpenSign(); return true; } catch { return false; }
        };
        window.workshopShowWardrobe = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenWardrobe || !owner.workshopStatusWardrobe || !owner.workshopCloseWardrobe) return false;
          wardrobeRequest?.cancel();
          const request = { cancel: () => {
            if (wardrobeRequest !== request) return;
            wardrobeRequest = null;
            try { owner.workshopCloseWardrobe?.(); } catch { /* The player may already have disconnected. */ }
          } };
          wardrobeRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenWardrobe(characterId) !== true) return false;
            const deadline = Date.now() + 15_000;
            while (wardrobeRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusWardrobe();
              if (state?.errors?.length || state?.phase === "error") return false;
              if (state?.phase === "open" && state.visible && state.actualUserId === characterId) {
                opened = true;
                return true;
              }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (wardrobeRequest === request) wardrobeRequest = null;
          }
        };
        setPhase("swf");

        const opts: RuffleLoadOptions = {
          url: swfUrl,
          parameters: flashvars,
          socketProxy,
          allowScriptAccess: true,
          ...(base ? { base } : {}),
        };
        // Newer Ruffle exposes the API behind player.ruffle(); older builds expose load() directly.
        const target = typeof player.ruffle === "function" ? player.ruffle() : player;
        if (!target.load) throw new Error(t("play.ruffleLoadMissing"));
        await target.load(opts);
        markReady();
      } catch (e) {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err.message);
        setPhase("error");
        onError?.(err);
      }
    })();

    return () => {
      cancelled = true;
      wardrobeRequest?.cancel();
      player?.remove();
      delete window.game_interruption;
      delete window.workshopShowActivation;
      delete window.workshopShowSign;
      delete window.workshopShowWardrobe;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey, attempt]);

  // Fake-but-honest progress sweep while loading (Ruffle exposes no byte progress for the root movie).
  useEffect(() => {
    if (phase === "ready" || phase === "error") return;
    const id = window.setInterval(() => setProgress((p) => Math.min(0.92, p + (0.95 - p) * 0.06)), 200);
    return () => window.clearInterval(id);
  }, [phase]);

  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-night-deep", className)}>
      <div ref={hostRef} className="absolute inset-0" />

      {phase !== "ready" && (
        <div className="absolute inset-0 grid place-items-center bg-night-deep bg-starfield animate-drift p-6">
          {phase === "kicked" ? (
            <div className="flex max-w-md flex-col items-center gap-4 text-center">
              <p className="title-plate text-3xl text-coral">{t("play.disconnected")}</p>
              <p className="text-sm text-muted">{error}</p>
              <Button onClick={() => window.location.reload()}>{t("play.reconnect")}</Button>
            </div>
          ) : phase === "error" ? (
            <div className="flex max-w-md flex-col items-center gap-4 text-center">
              <p className="title-plate text-3xl text-coral">{t("play.error")}</p>
              <p className="font-mono text-sm text-muted">{error}</p>
              <Button onClick={() => setAttempt((a) => a + 1)}>{t("play.retry")}</Button>
            </div>
          ) : (
            <div className="flex w-full max-w-sm flex-col items-center gap-5">
              <p className="title-plate text-4xl text-sun">DDTank</p>
              <PowerGauge
                value={progress}
                size="lg"
                label={phase === "ruffle" ? t("play.loadingRuffle") : t("play.loading")}
                readout={`${Math.round(progress * 100)}%`}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
