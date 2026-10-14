import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, PowerGauge, cn } from "@ddtank/ui";
import type { GameConfig } from "@/lib/api";
import type { ActivityResponse } from "@/lib/activities";
import { attachNativePairHost, type NativePairPlayer } from "@/lib/native-pair-host";
import { attachNativeMinesHost, type NativeMinesPlayer } from "@/lib/native-mines-host";
import { attachNativeDDPlayHost, type NativeDDPlayPlayer } from "@/lib/native-ddplay-host";
import { attachNativeGypsyHost, type NativeGypsyPlayer } from "@/lib/native-gypsy-host";
import { attachNativeMoonlightHost, type NativeMoonlightPlayer } from "@/lib/native-moonlight-host";
import { attachNativeTreasureHost, type NativeTreasurePlayer } from "@/lib/native-treasure-host";
import { useI18n } from "@/i18n";

/* Minimal typings for the bits of the Ruffle JS API we use. */
interface RuffleLoadOptions {
  url: string;
  parameters?: Record<string, string>;
  socketProxy?: GameConfig["socketProxy"];
  base?: string;
  [key: string]: unknown;
}
interface NativePairStatus {
  phase?: string; visible?: boolean; open?: boolean; actualUserId?: number;
  expectedUserId?: number; generation?: string; errors?: unknown[];
}
interface RufflePlayerElement extends HTMLElement, NativePairPlayer, NativeMinesPlayer, NativeDDPlayPlayer, NativeGypsyPlayer, NativeMoonlightPlayer, NativeTreasurePlayer {
  load?: (opts: RuffleLoadOptions) => Promise<void>;
  ruffle?: () => { load: (opts: RuffleLoadOptions) => Promise<void>; callExternalInterface?: (name: string, ...args: unknown[]) => unknown };
  workshopOpenActivation?: () => unknown;
  workshopOpenSign?: () => unknown;
  workshopOpenWardrobe?: (characterId: number) => boolean;
  workshopStatusWardrobe?: () => { phase?: string; visible?: boolean; actualUserId?: number; errors?: unknown[] };
  workshopCloseWardrobe?: () => unknown;
  workshopOpenPair?: (characterId: number, generation: string) => boolean;
  workshopStatusPair?: () => NativePairStatus;
  workshopClosePair?: () => unknown;
  workshopOpenMines?: (characterId: number, generation: string) => boolean;
  workshopStatusMines?: () => NativePairStatus;
  workshopCloseMines?: () => unknown;
  workshopOpenDDPlay?: (characterId: number, generation: string) => boolean;
  workshopStatusDDPlay?: () => NativePairStatus;
  workshopCloseDDPlay?: () => unknown;
  workshopOpenGypsy?: (characterId: number, generation: string) => boolean;
  workshopStatusGypsy?: () => NativePairStatus;
  workshopCloseGypsy?: () => unknown;
  workshopOpenMoonlight?: (characterId: number, generation: string) => boolean;
  workshopStatusMoonlight?: () => NativePairStatus;
  workshopCloseMoonlight?: () => unknown;
  workshopOpenTreasure?: (characterId: number, generation: string) => boolean;
  workshopStatusTreasure?: () => NativePairStatus;
  workshopCloseTreasure?: () => unknown;
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
  const queryClient = useQueryClient();
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
    let pairRequest: { cancel: () => void } | null = null;
    let pairHost: ReturnType<typeof attachNativePairHost> | null = null;
    let pairCharacterId = 0;
    let pairGeneration = "";
    let minesRequest: { cancel: () => void } | null = null;
    let minesHost: ReturnType<typeof attachNativeMinesHost> | null = null;
    let minesCharacterId = 0;
    let minesGeneration = "";
    const detachMines = () => {
      minesRequest?.cancel();
      minesHost?.cancel();
      minesHost = null;
      minesCharacterId = 0;
      minesGeneration = "";
    };
    let ddplayRequest: { cancel: () => void } | null = null;
    let ddplayHost: ReturnType<typeof attachNativeDDPlayHost> | null = null;
    let ddplayCharacterId = 0;
    let ddplayGeneration = "";
    const detachDDPlay = () => {
      ddplayRequest?.cancel();
      ddplayHost?.cancel();
      ddplayHost = null;
      ddplayCharacterId = 0;
      ddplayGeneration = "";
    };
    let gypsyRequest: { cancel: () => void } | null = null;
    let gypsyHost: ReturnType<typeof attachNativeGypsyHost> | null = null;
    let gypsyCharacterId = 0;
    let gypsyGeneration = "";
    const detachGypsy = () => {
      gypsyRequest?.cancel();
      gypsyHost?.cancel();
      gypsyHost = null;
      gypsyCharacterId = 0;
      gypsyGeneration = "";
    };
    let moonlightRequest: { cancel: () => void } | null = null;
    let moonlightHost: ReturnType<typeof attachNativeMoonlightHost> | null = null;
    let moonlightCharacterId = 0;
    let moonlightGeneration = "";
    const detachMoonlight = () => {
      moonlightRequest?.cancel();
      moonlightHost?.cancel();
      moonlightHost = null;
      moonlightCharacterId = 0;
      moonlightGeneration = "";
    };
    let treasureRequest: { cancel: () => void } | null = null;
    let treasureHost: ReturnType<typeof attachNativeTreasureHost> | null = null;
    let treasureCharacterId = 0;
    let treasureGeneration = "";
    const detachTreasure = () => {
      treasureRequest?.cancel();
      treasureHost?.cancel();
      treasureHost = null;
      treasureCharacterId = 0;
      treasureGeneration = "";
    };
    const detachPair = () => {
      pairRequest?.cancel();
      pairHost?.cancel();
      pairHost = null;
      pairCharacterId = 0;
      pairGeneration = "";
    };
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
          detachPair();
          detachMines();

          detachDDPlay();
          detachGypsy();
      detachMoonlight();
      detachTreasure();
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
        window.workshopShowPair = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenPair || !owner.workshopStatusPair || !owner.workshopClosePair) return false;
          try {
            const initial = owner.workshopStatusPair();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (pairHost && pairCharacterId !== characterId) return false;
            if (!pairHost) {
              pairCharacterId = characterId;
              pairGeneration = crypto.randomUUID();
              const generation = pairGeneration;
              pairHost = attachNativePairHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || pairCharacterId !== characterId || pairGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusPair?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          pairRequest?.cancel();
          const request = { cancel: () => {
            if (pairRequest !== request) return;
            pairRequest = null;
            try { owner.workshopClosePair?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          pairRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenPair(characterId, pairGeneration) !== true) return false;
            const deadline = Date.now() + 60_000;
            while (pairRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusPair();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === pairGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (pairRequest === request) pairRequest = null;
          }
        };
        window.workshopShowMines = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenMines || !owner.workshopStatusMines || !owner.workshopCloseMines) return false;
          try {
            const initial = owner.workshopStatusMines();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (minesHost && minesCharacterId !== characterId) return false;
            if (!minesHost) {
              minesCharacterId = characterId;
              minesGeneration = crypto.randomUUID();
              const generation = minesGeneration;
              minesHost = attachNativeMinesHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || minesCharacterId !== characterId || minesGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusMines?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          minesRequest?.cancel();
          const request = { cancel: () => {
            if (minesRequest !== request) return;
            minesRequest = null;
            try { owner.workshopCloseMines?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          minesRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenMines(characterId, minesGeneration) !== true) return false;
            const deadline = Date.now() + 60_000;
            while (minesRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusMines();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === minesGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (minesRequest === request) minesRequest = null;
          }
        };
        window.workshopShowDDPlay = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenDDPlay || !owner.workshopStatusDDPlay || !owner.workshopCloseDDPlay) return false;
          try {
            const initial = owner.workshopStatusDDPlay();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (ddplayHost && ddplayCharacterId !== characterId) return false;
            if (!ddplayHost) {
              ddplayCharacterId = characterId;
              ddplayGeneration = crypto.randomUUID();
              const generation = ddplayGeneration;
              ddplayHost = attachNativeDDPlayHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || ddplayCharacterId !== characterId || ddplayGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusDDPlay?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          ddplayRequest?.cancel();
          const request = { cancel: () => {
            if (ddplayRequest !== request) return;
            ddplayRequest = null;
            try { owner.workshopCloseDDPlay?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          ddplayRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenDDPlay(characterId, ddplayGeneration) !== true) return false;
            const deadline = Date.now() + 60_000;
            while (ddplayRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusDDPlay();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === ddplayGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (ddplayRequest === request) ddplayRequest = null;
          }
        };
        window.workshopShowGypsy = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenGypsy || !owner.workshopStatusGypsy || !owner.workshopCloseGypsy) return false;
          try {
            const initial = owner.workshopStatusGypsy();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (gypsyHost && gypsyCharacterId !== characterId) return false;
            if (!gypsyHost) {
              gypsyCharacterId = characterId;
              gypsyGeneration = crypto.randomUUID();
              const generation = gypsyGeneration;
              gypsyHost = attachNativeGypsyHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || gypsyCharacterId !== characterId || gypsyGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusGypsy?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          gypsyRequest?.cancel();
          const request = { cancel: () => {
            if (gypsyRequest !== request) return;
            gypsyRequest = null;
            try { owner.workshopCloseGypsy?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          gypsyRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenGypsy(characterId, gypsyGeneration) !== true) return false;
            const deadline = Date.now() + 60_000;
            while (gypsyRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusGypsy();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === gypsyGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (gypsyRequest === request) gypsyRequest = null;
          }
        };
        window.workshopShowMoonlight = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenMoonlight || !owner.workshopStatusMoonlight || !owner.workshopCloseMoonlight) return false;
          try {
            const initial = owner.workshopStatusMoonlight();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (moonlightHost && moonlightCharacterId !== characterId) return false;
            if (!moonlightHost) {
              moonlightCharacterId = characterId;
              moonlightGeneration = crypto.randomUUID();
              const generation = moonlightGeneration;
              moonlightHost = attachNativeMoonlightHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || moonlightCharacterId !== characterId || moonlightGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusMoonlight?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          moonlightRequest?.cancel();
          const request = { cancel: () => {
            if (moonlightRequest !== request) return;
            moonlightRequest = null;
            try { owner.workshopCloseMoonlight?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          moonlightRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenMoonlight(characterId, moonlightGeneration) !== true) return false;
            const deadline = Date.now() + 60_000;
            while (moonlightRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusMoonlight();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === moonlightGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (moonlightRequest === request) moonlightRequest = null;
          }
        };
        window.workshopShowTreasure = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenTreasure || !owner.workshopStatusTreasure || !owner.workshopCloseTreasure) return false;
          try {
            const initial = owner.workshopStatusTreasure();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (treasureHost && treasureCharacterId !== characterId) return false;
            if (!treasureHost) {
              treasureCharacterId = characterId;
              treasureGeneration = crypto.randomUUID();
              const generation = treasureGeneration;
              treasureHost = attachNativeTreasureHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || treasureCharacterId !== characterId || treasureGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusTreasure?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          treasureRequest?.cancel();
          const request = { cancel: () => {
            if (treasureRequest !== request) return;
            treasureRequest = null;
            try { owner.workshopCloseTreasure?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          treasureRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenTreasure(characterId, treasureGeneration) !== true) return false;
            const deadline = Date.now() + 60_000;
            while (treasureRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusTreasure();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === treasureGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (treasureRequest === request) treasureRequest = null;
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
        detachPair();
        detachMines();

        detachDDPlay();
        detachGypsy();
      detachMoonlight();
      detachTreasure();
        setError(err.message);
        setPhase("error");
        onError?.(err);
      }
    })();

    return () => {
      cancelled = true;
      wardrobeRequest?.cancel();
      detachPair();
      detachMines();

      detachDDPlay();
      detachGypsy();
      detachMoonlight();
      detachTreasure();
      player?.remove();
      delete window.game_interruption;
      delete window.workshopShowActivation;
      delete window.workshopShowSign;
      delete window.workshopShowWardrobe;
      delete window.workshopShowPair;
      delete window.workshopShowMines;
      delete window.workshopShowDDPlay;
      delete window.workshopShowGypsy;
      delete window.workshopShowMoonlight;
      delete window.workshopShowTreasure;
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
