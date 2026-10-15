import type { ChristmasNativeView } from "./christmas-native.js";
import type { SnowfieldView } from "./christmas-snowfield.js";
/** Local reference activities. Never expose RootState, board layouts, or RNG seeds through HTTP. */
import type { PairNativeEffect, PairNativeView } from "./pair-native.js";
import type { MinesNativeEffect, MinesNativeView } from "./mines-native.js";
import type { DDPlayNativeEffect, DDPlayNativeView } from "./ddplay-native.js";
import type { GypsyNativeEffect, GypsyNativeView } from "./gypsy-native.js";
import type { MoonlightNativeEffect, MoonlightNativeView } from "./moonlight-native.js";
import type { TreasureNativeEffect, TreasureNativeView } from "./treasure-native.js";
import type { WheelNativeEffect, WheelNativeView } from "./wheel-native.js";
import type { CarnivalNativeEffect, CarnivalNativeView } from "./carnival-native.js";
import type { FirstRechargeNativeEffect, FirstRechargeNativeView } from "./first-recharge-native.js";
import type { ChargeNativeEffect, ChargeNativeView } from "./charge-native.js";
import type { ForthrightNativeEffect, ForthrightNativeView, PrivateGroup } from "./forthright-native.js";
import type { ExchangeNativeView } from "./exchange-native.js";
import type { DevilProjection, DevilEffect } from "./devil-native.js";
import type { CaveProjection, CaveEffect } from "./caveloot-native.js";

export interface ActivityAction { type: string; index?: number; choice?: string; tier?: number; count?: number; marked?: boolean; items?: { index: number; count: number }[]; mode?: "normal" | "advanced"; cardId?: string; recipientName?: string }
export interface ActivityReward { templateId: number; count: number; validDays?: number }
export interface ActivityWallet { points: number; earned: number; revision: number }
export interface ActivityContext {
  now: Date;
  /** Authenticated character, provided by the server; never an action field. */
  characterId?: number;
  /** Server-only request identity and private canonical groups; never action fields. */
  requestId?: string;
  forthrightGroups?: PrivateGroup[];
  forthrightInspectCode?: string;
  /** Committed EventClaims sign/day keys, not a client-provided completion flag. */
  signDays: string[];
  ownedTemplateIds: number[];
  wardrobeItems?: { templateId: number; name: string; category: number; icon?: string }[];
}
export interface ActivityState {
  version: 1;
  day: string;
  daily: Record<string, number>;
  games: Record<string, unknown>;
  completed: Record<string, number>;
  claims: string[];
  history: string[];
}
export interface ActivityButton { label: string; action: ActivityAction; disabled?: boolean; help?: string }
export interface ActivityCell { label: string; detail?: string; tone?: "hidden" | "success" | "danger" | "gold"; action?: ActivityAction; image?: string }
export interface ActivityView {
  id: string; title: string; subtitle: string; rules: string[];
  stats: { label: string; value: string | number }[];
  actions: ActivityButton[];
  cells?: ActivityCell[]; columns?: number;
}
export interface ActivityTask { id: string; title: string; current: number; target: number; points: number; claimed: boolean }
export interface ActivitySnapshot {
  points: number; earned: number; revision: number; day: string;
  activities: ActivityView[]; tasks: ActivityTask[]; history: string[];
  /** Additive native-window projection; the existing 17 activity views remain compatible. */
  nativePair: PairNativeView;
  nativeMines: MinesNativeView;
  nativeDDPlay: DDPlayNativeView;
  nativeGypsy: GypsyNativeView;
  nativeMoonlight: MoonlightNativeView;
  nativeTreasure: TreasureNativeView;
  nativeWheel: WheelNativeView;
  nativeCarnival: CarnivalNativeView;
  nativeFirstRecharge: FirstRechargeNativeView;
  nativeCharge: ChargeNativeView;
  nativeForthright: ForthrightNativeView;
  /** Loaded only outside activity transactions from the authoritative game inventory owner. */
  nativeExchange?: ExchangeNativeView;
  /** Game authoritative, additive and omitted from ordinary old POST responses. */
  nativeChristmas?: ChristmasNativeView;
  nativeChristmasSnowfield?: SnowfieldView;
  nativeDevil: DevilProjection;
  nativeCaveLoot: CaveProjection;
}
export interface ActivityTransition {
  state: ActivityState; pointsDelta: number; earnedDelta: number;
  rewards: ActivityReward[]; message: string;
  /** Already revealed results only. Omitted for other games and never stored in replay receipts. */
  nativePairEffects?: PairNativeEffect[];
  nativeMinesEffects?: MinesNativeEffect[];
  nativeDDPlayEffects?: DDPlayNativeEffect[];
  nativeGypsyEffects?: GypsyNativeEffect[];
  nativeMoonlightEffects?: MoonlightNativeEffect[];
  nativeTreasureEffects?: TreasureNativeEffect[];
  nativeWheelEffects?: WheelNativeEffect[];
  nativeCarnivalEffects?: CarnivalNativeEffect[];
  nativeFirstRechargeEffects?: FirstRechargeNativeEffect[];
  nativeChargeEffects?: ChargeNativeEffect[];
  nativeForthrightEffects?: ForthrightNativeEffect[];
  nativeForthrightNotification?: string;
  nativeDevilEffects?: DevilEffect[];
  nativeCaveLootEffects?: CaveEffect[];
}
export class ActivityError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); this.name = "ActivityError"; }
}
