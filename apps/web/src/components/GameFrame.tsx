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
import { attachNativePurrHost, type NativePurrPlayer } from "@/lib/native-purr-host";
import { attachNativeCarnivalHost, type NativeCarnivalPlayer } from "@/lib/native-carnival-host";
import { attachNativeFirstRechargeHost, type NativeFirstRechargePlayer } from "@/lib/native-first-recharge-host";
import { attachNativeChargeHost, type NativeChargePlayer } from "@/lib/native-charge-host";
import { attachNativeForthrightHost, type NativeForthrightPlayer } from "@/lib/native-forthright-host";
import { attachNativeExchangeHost, type NativeExchangePlayer } from "@/lib/native-exchange-host";
import { attachNativeDevilHost, type NativeDevilPlayer } from "@/lib/native-devil-host";
import { attachNativeCaveLootHost, type NativeCaveLootPlayer } from "@/lib/native-caveloot-host";
import { attachNativeChristmasHost, type NativeChristmasPlayer } from "@/lib/native-christmas-host";
import { useI18n } from "@/i18n";

// Shared loading (60s) precedes module loading (60s); leave room for status polling.
const NATIVE_ACTIVITY_OPEN_TIMEOUT_MS = 125_000;

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
export interface NativeActivityMenuPlayer {
  workshopOpenActivityMenu?: (characterId: number, token: string) => boolean;
  workshopStatusActivityMenu?: () => { version?: number; open?: boolean; actualUserId?: number; characterId?: number; token?: string; pending?: boolean; message?: string };
  workshopCloseActivityMenu?: (token: string) => boolean;
  workshopActivityMenuResult?: (characterId: number, token: string, kind: string, opened: boolean, message: string) => boolean;
}
export const NATIVE_ACTIVITY_MENU_KINDS = ["wardrobe", "pair", "mines", "ddplay", "gypsy", "moonlight", "treasure", "purr", "carnival", "first-recharge", "charge", "forthright", "exchange", "devil", "caveloot", "christmas"] as const;
type NativeActivityMenuKind = typeof NATIVE_ACTIVITY_MENU_KINDS[number];
/** Menu selection only opens an existing AS window. Its host continues to own all economic requests. */
export function createNativeActivityMenu(options: {
  player: NativeActivityMenuPlayer; isCurrent: () => boolean;
  openers: Record<NativeActivityMenuKind, (characterId: number, signal?: AbortSignal) => Promise<boolean>>;
  sign: () => boolean; activation: () => boolean; notice: (message: string) => void;
}) {
  let cancelled = false, owner: { characterId: number; token: string; request?: AbortController } | null = null;
  const live = () => !cancelled && options.isCurrent();
  const matches = (id: number, token: string) => {
    if (!live() || !owner || owner.characterId !== id || owner.token !== token) return false;
    try {
      const status = options.player.workshopStatusActivityMenu?.();
      return status?.version === 1 && status.open === true && status.characterId === id && status.actualUserId === id && status.token === token;
    } catch { return false; }
  };
  const close = () => {
    const previous = owner; owner = null;
    previous?.request?.abort();
    if (previous) { try { options.player.workshopCloseActivityMenu?.(previous.token); } catch { /* A removed player cannot reopen the menu. */ } }
  };
  return {
    open(characterId?: number): boolean {
      if (!live()) return false;
      const player = options.player;
      if (!player.workshopOpenActivityMenu || !player.workshopStatusActivityMenu || !player.workshopCloseActivityMenu || !player.workshopActivityMenuResult) {
        options.notice("原生活动菜单尚未安装，请更新客户端资源后重新进入游戏。"); return false;
      }
      try {
        const status = player.workshopStatusActivityMenu(), id = characterId ?? status.actualUserId;
        if (!Number.isSafeInteger(id) || !id || id < 1 || status.actualUserId !== id) {
          options.notice("请先进入游戏大厅，再打开活动。"); return false;
        }
        if (owner?.request) return false;
        if (owner && matches(owner.characterId, owner.token)) return true;
        close();
        const token = crypto.randomUUID(); owner = { characterId: id, token };
        if (player.workshopOpenActivityMenu(id, token) !== true || !matches(id, token)) {
          const message = player.workshopStatusActivityMenu()?.message;
          close(); options.notice(message || "原生活动菜单未能打开，请返回游戏大厅后重试。"); return false;
        }
        options.notice(""); return true;
      } catch {
        close(); options.notice("原生活动菜单未能打开，请返回游戏大厅后重试。"); return false;
      }
    },
    select(id: number, token: string, kind: string): boolean {
      if (!matches(id, token) || !owner || owner.request || ![...NATIVE_ACTIVITY_MENU_KINDS, "sign", "activation"].includes(kind as NativeActivityMenuKind)) return false;
      const selection = owner, request = new AbortController(); selection.request = request;
      // Return the synchronous EI acknowledgement before calling back into AVM2 or loading a module.
      queueMicrotask(() => {
        if (!matches(id, token) || owner !== selection || request.signal.aborted) return;
        void (async () => {
          let opened = false;
          try {
            opened = kind === "sign" ? options.sign() : kind === "activation" ? options.activation()
              : await options.openers[kind as NativeActivityMenuKind](id, request.signal);
          } catch { /* Keep the menu and report a readable error, without a web fallback. */ }
          if (!live() || owner !== selection || request.signal.aborted || !matches(id, token)) return;
          selection.request = undefined;
          try {
            const accepted = options.player.workshopActivityMenuResult?.(id, token, kind, opened,
              opened ? "" : "活动窗口未能打开。请留在大厅后重试；尚未提交任何活动操作。");
            if (opened && accepted === true) owner = null; // Do not abort the successfully opened activity.
          } catch { options.notice("活动菜单回执未确认，请关闭菜单后重试。"); }
        })();
      });
      return true;
    },
    closed(id: number, token: string) {
      if (!owner || owner.characterId !== id || owner.token !== token) return;
      const previous = owner; owner = null; previous.request?.abort();
    },
    cancel() { close(); cancelled = true; },
  };
}
interface RufflePlayerElement extends HTMLElement, NativeActivityMenuPlayer, NativePairPlayer, NativeMinesPlayer, NativeDDPlayPlayer, NativeGypsyPlayer, NativeMoonlightPlayer, NativeTreasurePlayer, NativePurrPlayer, NativeCarnivalPlayer, NativeFirstRechargePlayer, NativeChargePlayer, NativeForthrightPlayer, NativeExchangePlayer, NativeDevilPlayer, NativeCaveLootPlayer, NativeChristmasPlayer {
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
  workshopOpenPurr?: (characterId: number, generation: string) => boolean;
  workshopStatusPurr?: () => NativePairStatus;
  workshopClosePurr?: () => unknown;
  workshopOpenCarnival?: (characterId: number, generation: string) => boolean;
  workshopStatusCarnival?: () => NativePairStatus;
  workshopCloseCarnival?: () => unknown;
  workshopOpenFirstRecharge?: (characterId: number, generation: string) => boolean;
  workshopOpenCharge?: (characterId: number, generation: string) => boolean;
  workshopOpenForthright?: (characterId: number, generation: string) => boolean;
  workshopOpenExchange?: (characterId: number, generation: string) => boolean;
  workshopOpenDevil?: (characterId: number, generation: string) => boolean;
  workshopOpenCaveLoot?: (characterId: number, generation: string) => boolean;
  workshopOpenChristmas?: (characterId: number, generation: string) => boolean;
  workshopStatusFirstRecharge?: () => NativePairStatus;
  workshopStatusCharge?: () => NativePairStatus;
  workshopStatusForthright?: () => NativePairStatus;
  workshopStatusExchange?: () => NativePairStatus;
  workshopStatusDevil?: () => NativePairStatus;
  workshopStatusCaveLoot?: () => NativePairStatus;
  workshopStatusChristmas?: () => NativePairStatus;
  workshopCloseFirstRecharge?: () => unknown;
  workshopCloseCharge?: () => unknown;
  workshopCloseForthright?: () => unknown;
  workshopCloseExchange?: () => unknown;
  workshopCloseDevil?: () => unknown;
  workshopCloseCaveLoot?: () => unknown;
  workshopCloseChristmas?: () => unknown;
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
    workshopShowActivityMenu?: (characterId?: number) => boolean;
    workshopSelectNativeActivity?: (characterId: number, token: string, kind: string) => boolean;
    workshopActivityMenuClosed?: (characterId: number, token: string) => void;
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
  const [menuNotice, setMenuNotice] = useState("");

  // Stable key so a new object with the same values doesn't remount the player.
  const configKey = JSON.stringify({ rufflePath, swfUrl, flashvars, socketProxy, base });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let player: RufflePlayerElement | null = null;
    let activityMenu: ReturnType<typeof createNativeActivityMenu> | null = null;
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
    let purrRequest: { cancel: () => void } | null = null;
    let purrHost: ReturnType<typeof attachNativePurrHost> | null = null;
    let purrCharacterId = 0;
    let purrGeneration = "";
    const detachPurr = () => {
      purrRequest?.cancel();
      purrHost?.cancel();
      purrHost = null;
      purrCharacterId = 0;
      purrGeneration = "";
    };
    let carnivalRequest: { cancel: () => void } | null = null;
    let carnivalHost: ReturnType<typeof attachNativeCarnivalHost> | null = null;
    let carnivalCharacterId = 0;
    let carnivalGeneration = "";
    const detachCarnival = () => {
      carnivalRequest?.cancel();
      carnivalHost?.cancel();
      carnivalHost = null;
      carnivalCharacterId = 0;
      carnivalGeneration = "";
    };
    let firstRechargeRequest: { cancel: () => void } | null = null;
    let firstRechargeHost: ReturnType<typeof attachNativeFirstRechargeHost> | null = null;
    let firstRechargeCharacterId = 0;
    let firstRechargeGeneration = "";
    const detachFirstRecharge = () => {
      firstRechargeRequest?.cancel();
      firstRechargeHost?.cancel();
      firstRechargeHost = null;
      firstRechargeCharacterId = 0;
      firstRechargeGeneration = "";
    };
    let chargeRequest: { cancel: () => void } | null = null;
    let chargeHost: ReturnType<typeof attachNativeChargeHost> | null = null;
    let chargeCharacterId = 0;
    let chargeGeneration = "";
    const detachCharge = () => {
      chargeRequest?.cancel();
      chargeHost?.cancel();
      chargeHost = null;
      chargeCharacterId = 0;
      chargeGeneration = "";
    };
    let forthrightRequest: { cancel: () => void } | null = null;
    let forthrightHost: ReturnType<typeof attachNativeForthrightHost> | null = null;
    let forthrightCharacterId = 0;
    let forthrightGeneration = "";
    const detachForthright = () => {
      forthrightRequest?.cancel();
      forthrightHost?.cancel();
      forthrightHost = null;
      forthrightCharacterId = 0;
      forthrightGeneration = "";
    };
    let exchangeRequest: { cancel: () => void } | null = null;
    let exchangeHost: ReturnType<typeof attachNativeExchangeHost> | null = null;
    let exchangeCharacterId = 0;
    let exchangeGeneration = "";
    const detachExchange = () => {
      exchangeRequest?.cancel();
      exchangeHost?.cancel();
      exchangeHost = null;
      exchangeCharacterId = 0;
      exchangeGeneration = "";
    };
    let devilRequest: { cancel: () => void } | null = null;
    let devilHost: ReturnType<typeof attachNativeDevilHost> | null = null;
    let devilCharacterId = 0;
    let devilGeneration = "";
    const detachDevil = () => {
      devilRequest?.cancel();
      devilHost?.cancel();
      devilHost = null;
      devilCharacterId = 0;
      devilGeneration = "";
    };
    let cavelootRequest: { cancel: () => void } | null = null;
    let cavelootHost: ReturnType<typeof attachNativeCaveLootHost> | null = null;
    let cavelootCharacterId = 0;
    let cavelootGeneration = "";
    const detachCaveLoot = () => {
      cavelootRequest?.cancel();
      cavelootHost?.cancel();
      cavelootHost = null;
      cavelootCharacterId = 0;
      cavelootGeneration = "";
    };
    let christmasRequest: { cancel: () => void } | null = null;
    let christmasHost: ReturnType<typeof attachNativeChristmasHost> | null = null;
    let christmasCharacterId = 0;
    let christmasGeneration = "";
    const detachChristmas = () => {
      christmasRequest?.cancel();
      christmasHost?.cancel();
      christmasHost = null;
      christmasCharacterId = 0;
      christmasGeneration = "";
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
          activityMenu?.cancel();
          wardrobeRequest?.cancel();
          detachPair();
          detachMines();

          detachDDPlay();
          detachGypsy();
      detachMoonlight();
      detachTreasure();
          detachPurr();
          detachCarnival();
          detachFirstRecharge();
          detachCharge();
          detachForthright();
          detachExchange();
          detachDevil();
          detachCaveLoot();
      detachChristmas();
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
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
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
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
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
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
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
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
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
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
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
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
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
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
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
        window.workshopShowPurr = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenPurr || !owner.workshopStatusPurr || !owner.workshopClosePurr) return false;
          try {
            const initial = owner.workshopStatusPurr();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (purrHost && purrCharacterId !== characterId) return false;
            if (!purrHost) {
              purrCharacterId = characterId;
              purrGeneration = crypto.randomUUID();
              const generation = purrGeneration;
              purrHost = attachNativePurrHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || purrCharacterId !== characterId || purrGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusPurr?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          purrRequest?.cancel();
          const request = { cancel: () => {
            if (purrRequest !== request) return;
            purrRequest = null;
            try { owner.workshopClosePurr?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          purrRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenPurr(characterId, purrGeneration) !== true) return false;
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
            while (purrRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusPurr();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === purrGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (purrRequest === request) purrRequest = null;
          }
        };
        window.workshopShowCarnival = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenCarnival || !owner.workshopStatusCarnival || !owner.workshopCloseCarnival) return false;
          try {
            const initial = owner.workshopStatusCarnival();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (carnivalHost && carnivalCharacterId !== characterId) return false;
            if (!carnivalHost) {
              carnivalCharacterId = characterId;
              carnivalGeneration = crypto.randomUUID();
              const generation = carnivalGeneration;
              carnivalHost = attachNativeCarnivalHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || carnivalCharacterId !== characterId || carnivalGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusCarnival?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          carnivalRequest?.cancel();
          const request = { cancel: () => {
            if (carnivalRequest !== request) return;
            carnivalRequest = null;
            try { owner.workshopCloseCarnival?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          carnivalRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenCarnival(characterId, carnivalGeneration) !== true) return false;
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
            while (carnivalRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusCarnival();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === carnivalGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (carnivalRequest === request) carnivalRequest = null;
          }
        };
        window.workshopShowFirstRecharge = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenFirstRecharge || !owner.workshopStatusFirstRecharge || !owner.workshopCloseFirstRecharge) return false;
          try {
            const initial = owner.workshopStatusFirstRecharge();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (firstRechargeHost && firstRechargeCharacterId !== characterId) return false;
            if (!firstRechargeHost) {
              firstRechargeCharacterId = characterId;
              firstRechargeGeneration = crypto.randomUUID();
              const generation = firstRechargeGeneration;
              firstRechargeHost = attachNativeFirstRechargeHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || firstRechargeCharacterId !== characterId || firstRechargeGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusFirstRecharge?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          firstRechargeRequest?.cancel();
          const request = { cancel: () => {
            if (firstRechargeRequest !== request) return;
            firstRechargeRequest = null;
            try { owner.workshopCloseFirstRecharge?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          firstRechargeRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenFirstRecharge(characterId, firstRechargeGeneration) !== true) return false;
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
            while (firstRechargeRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusFirstRecharge();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === firstRechargeGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (firstRechargeRequest === request) firstRechargeRequest = null;
          }
        };
        window.workshopShowCharge = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenCharge || !owner.workshopStatusCharge || !owner.workshopCloseCharge) return false;
          try {
            const initial = owner.workshopStatusCharge();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (chargeHost && chargeCharacterId !== characterId) return false;
            if (!chargeHost) {
              chargeCharacterId = characterId;
              chargeGeneration = crypto.randomUUID();
              const generation = chargeGeneration;
              chargeHost = attachNativeChargeHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || chargeCharacterId !== characterId || chargeGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusCharge?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          chargeRequest?.cancel();
          const request = { cancel: () => {
            if (chargeRequest !== request) return;
            chargeRequest = null;
            try { owner.workshopCloseCharge?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          chargeRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenCharge(characterId, chargeGeneration) !== true) return false;
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
            while (chargeRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusCharge();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === chargeGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (chargeRequest === request) chargeRequest = null;
          }
        };
        window.workshopShowForthright = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenForthright || !owner.workshopStatusForthright || !owner.workshopCloseForthright) return false;
          try {
            const initial = owner.workshopStatusForthright();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (forthrightHost && forthrightCharacterId !== characterId) return false;
            if (!forthrightHost) {
              forthrightCharacterId = characterId;
              forthrightGeneration = crypto.randomUUID();
              const generation = forthrightGeneration;
              forthrightHost = attachNativeForthrightHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || forthrightCharacterId !== characterId || forthrightGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusForthright?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          forthrightRequest?.cancel();
          const request = { cancel: () => {
            if (forthrightRequest !== request) return;
            forthrightRequest = null;
            try { owner.workshopCloseForthright?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          forthrightRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenForthright(characterId, forthrightGeneration) !== true) return false;
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
            while (forthrightRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusForthright();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === forthrightGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (forthrightRequest === request) forthrightRequest = null;
          }
        };
        window.workshopShowExchange = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenExchange || !owner.workshopStatusExchange || !owner.workshopCloseExchange) return false;
          try {
            const initial = owner.workshopStatusExchange();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (exchangeHost && exchangeCharacterId !== characterId) return false;
            if (!exchangeHost) {
              exchangeCharacterId = characterId;
              exchangeGeneration = crypto.randomUUID();
              const generation = exchangeGeneration;
              exchangeHost = attachNativeExchangeHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || exchangeCharacterId !== characterId || exchangeGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusExchange?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          exchangeRequest?.cancel();
          const request = { cancel: () => {
            if (exchangeRequest !== request) return;
            exchangeRequest = null;
            try { owner.workshopCloseExchange?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          exchangeRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenExchange(characterId, exchangeGeneration) !== true) return false;
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
            while (exchangeRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusExchange();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === exchangeGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (exchangeRequest === request) exchangeRequest = null;
          }
        };
        window.workshopShowDevil = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenDevil || !owner.workshopStatusDevil || !owner.workshopCloseDevil) return false;
          try {
            const initial = owner.workshopStatusDevil();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (devilHost && devilCharacterId !== characterId) return false;
            if (!devilHost) {
              devilCharacterId = characterId;
              devilGeneration = crypto.randomUUID();
              const generation = devilGeneration;
              devilHost = attachNativeDevilHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || devilCharacterId !== characterId || devilGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusDevil?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          devilRequest?.cancel();
          const request = { cancel: () => {
            if (devilRequest !== request) return;
            devilRequest = null;
            try { owner.workshopCloseDevil?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          devilRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenDevil(characterId, devilGeneration) !== true) return false;
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
            while (devilRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusDevil();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === devilGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (devilRequest === request) devilRequest = null;
          }
        };
        window.workshopShowCaveLoot = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenCaveLoot || !owner.workshopStatusCaveLoot || !owner.workshopCloseCaveLoot) return false;
          try {
            const initial = owner.workshopStatusCaveLoot();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (cavelootHost && cavelootCharacterId !== characterId) return false;
            if (!cavelootHost) {
              cavelootCharacterId = characterId;
              cavelootGeneration = crypto.randomUUID();
              const generation = cavelootGeneration;
              cavelootHost = attachNativeCaveLootHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || cavelootCharacterId !== characterId || cavelootGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusCaveLoot?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          cavelootRequest?.cancel();
          const request = { cancel: () => {
            if (cavelootRequest !== request) return;
            cavelootRequest = null;
            try { owner.workshopCloseCaveLoot?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          cavelootRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenCaveLoot(characterId, cavelootGeneration) !== true) return false;
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
            while (cavelootRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusCaveLoot();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === cavelootGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (cavelootRequest === request) cavelootRequest = null;
          }
        };
        window.workshopShowChristmas = async (characterId, signal) => {
          const owner = player;
          if (cancelled || signal?.aborted || !Number.isSafeInteger(characterId) || characterId <= 0
            || !owner?.workshopOpenChristmas || !owner.workshopStatusChristmas || !owner.workshopCloseChristmas) return false;
          try {
            const initial = owner.workshopStatusChristmas();
            if (initial.actualUserId !== characterId || initial.phase === "failed"
              || initial.phase === "error" || initial.errors?.length) return false;
            // A loaded AS module binds its generation until the game player is recreated.
            if (christmasHost && christmasCharacterId !== characterId) return false;
            if (!christmasHost) {
              christmasCharacterId = characterId;
              christmasGeneration = crypto.randomUUID();
              const generation = christmasGeneration;
              christmasHost = attachNativeChristmasHost({ player: owner, characterId, generation,
                isCurrent: () => {
                  if (cancelled || player !== owner || christmasCharacterId !== characterId || christmasGeneration !== generation) return false;
                  try {
                    const state = owner.workshopStatusChristmas?.();
                    return state?.actualUserId === characterId && state.expectedUserId === characterId
                      && state.generation === generation && state.phase !== "failed" && state.phase !== "error";
                  } catch { return false; }
                },
                onSnapshot: (snapshot) => queryClient.setQueryData<ActivityResponse>(["account", "activities", characterId], old =>
                  old && old.revision > snapshot.revision ? old : snapshot),
              });
            }
          } catch { return false; }
          christmasRequest?.cancel();
          const request = { cancel: () => {
            if (christmasRequest !== request) return;
            christmasRequest = null;
            try { owner.workshopCloseChristmas?.(); } catch { /* Preserve an unresolved POST on the surviving host. */ }
          } };
          christmasRequest = request;
          signal?.addEventListener("abort", request.cancel, { once: true });
          let opened = false;
          try {
            if (owner.workshopOpenChristmas(characterId, christmasGeneration) !== true) return false;
            const deadline = Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS;
            while (christmasRequest === request && !cancelled && !signal?.aborted && player === owner && Date.now() < deadline) {
              const state = owner.workshopStatusChristmas();
              if (state?.errors?.length || state?.phase === "failed" || state?.phase === "error") return false;
              if (state?.open && state.actualUserId === characterId && state.expectedUserId === characterId
                && state.generation === christmasGeneration) { opened = true; return true; }
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            return false;
          } catch { return false; }
          finally {
            signal?.removeEventListener("abort", request.cancel);
            if (!opened) request.cancel();
            else if (christmasRequest === request) christmasRequest = null;
          }
        };
        setPhase("swf");

        const menuOwner = player;
        activityMenu = createNativeActivityMenu({ player: menuOwner, isCurrent: () => !cancelled && player === menuOwner,
          openers: {
            wardrobe: window.workshopShowWardrobe, pair: window.workshopShowPair, mines: window.workshopShowMines,
            ddplay: window.workshopShowDDPlay, gypsy: window.workshopShowGypsy, moonlight: window.workshopShowMoonlight,
            treasure: window.workshopShowTreasure, purr: window.workshopShowPurr, carnival: window.workshopShowCarnival,
            "first-recharge": window.workshopShowFirstRecharge, charge: window.workshopShowCharge, forthright: window.workshopShowForthright,
            exchange: window.workshopShowExchange, devil: window.workshopShowDevil, caveloot: window.workshopShowCaveLoot, christmas: window.workshopShowChristmas,
          }, sign: window.workshopShowSign, activation: window.workshopShowActivation,
          notice: text => { if (!cancelled && player === menuOwner) setMenuNotice(text); },
        });
        window.workshopShowActivityMenu = characterId => activityMenu?.open(characterId) ?? false;
        window.workshopSelectNativeActivity = (characterId, token, kind) => activityMenu?.select(characterId, token, kind) ?? false;
        window.workshopActivityMenuClosed = (characterId, token) => activityMenu?.closed(characterId, token);
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
        activityMenu?.cancel();
        const err = e instanceof Error ? e : new Error(String(e));
        detachPair();
        detachMines();

        detachDDPlay();
        detachGypsy();
      detachMoonlight();
      detachTreasure();
      detachPurr();
      detachCarnival();
      detachFirstRecharge();
      detachCharge();
      detachForthright();
      detachExchange();
      detachDevil();
      detachCaveLoot();
      detachChristmas();
        console.error("客户端加载失败：", err);
        setError("请检查游戏资源与服务连接，然后重试。");
        setPhase("error");
        onError?.(err);
      }
    })();

    return () => {
      cancelled = true;
      activityMenu?.cancel();
      wardrobeRequest?.cancel();
      detachPair();
      detachMines();

      detachDDPlay();
      detachGypsy();
      detachMoonlight();
      detachTreasure();
      detachPurr();
      detachCarnival();
      detachFirstRecharge();
      detachCharge();
      detachForthright();
      detachExchange();
      detachDevil();
      detachCaveLoot();
      detachChristmas();
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
      delete window.workshopShowPurr;
      delete window.workshopShowCarnival;
      delete window.workshopShowFirstRecharge;
      delete window.workshopShowCharge;
      delete window.workshopShowForthright;
      delete window.workshopShowExchange;
      delete window.workshopShowDevil;
      delete window.workshopShowCaveLoot;
      delete window.workshopShowChristmas;
      delete window.workshopShowActivityMenu;
      delete window.workshopSelectNativeActivity;
      delete window.workshopActivityMenuClosed;
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
      {menuNotice && phase === "ready" && <p role="alert" className="absolute inset-x-4 bottom-4 z-10 rounded-lg border border-line bg-night px-4 py-2 text-center text-sm text-ink">{menuNotice}</p>}

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
              <p className="title-plate text-4xl text-sun">弹弹堂</p>
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
