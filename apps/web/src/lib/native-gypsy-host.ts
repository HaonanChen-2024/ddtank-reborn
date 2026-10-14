import { ActivityRequestError, type ActivityAction, type ActivityRequest, type ActivityResponse } from "./activities";
import {
  attachNativeActivityHost, nativeObject, retryNativeActivityRequest,
  type NativeActivityAcknowledgement, type NativeActivityEnvelope, type NativeActivityHost,
} from "./native-activity-host";

export type NativeGypsyEnvelope = NativeActivityEnvelope;
export interface NativeGypsyPlayer {
  workshopGypsyAcceptSnapshot?: (envelope: NativeGypsyEnvelope) => unknown;
  workshopGypsyRejectRequest?: (envelope: NativeGypsyEnvelope) => unknown;
}
export interface NativeGypsyCallbackTarget {
  workshopGypsyRead?: (characterId: number, generation: string, sequence: number) => NativeActivityAcknowledgement;
  workshopGypsyRequest?: (characterId: number, generation: string, sequence: number, action: unknown) => NativeActivityAcknowledgement;
  workshopGypsyReport?: (status: unknown) => void;
}
export interface NativeGypsyHostOptions {
  player: NativeGypsyPlayer; characterId: number; generation: string; isCurrent: () => boolean;
  target?: NativeGypsyCallbackTarget;
  onSnapshot?: (snapshot: ActivityResponse) => void;
  onStatus?: (status: Record<string, unknown>) => void;
}
declare global {
  interface Window extends NativeGypsyCallbackTarget {
    workshopShowGypsy?: (characterId: number, signal?: AbortSignal) => Promise<boolean>;
  }
}
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const shelf = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}:[1-9]\d{0,9}$/.test(value) && integer(Number(value.slice(11)), 1, 1_000_000_000);
const recipes = [[11019, 3, 15], [11001, 3, 20], [11021, 1, 25], [11002, 1, 30]] as const;
function nativeAction(value: unknown): ActivityAction | null {
  if (!nativeObject(value) || !Object.hasOwn(value, "type") || !Object.hasOwn(value, "choice")) return null;
  if (value.type === "refresh" && ["free", "points"].includes(value.choice as string)
    && Object.keys(value).every(key => key === "type" || key === "choice")) return { type: "refresh", choice: value.choice as string };
  if (value.type === "buy" && Object.hasOwn(value, "index") && integer(value.index, 0, 7) && shelf(value.choice)
    && Object.keys(value).every(key => key === "type" || key === "index" || key === "choice"))
    return { type: "buy", index: value.index, choice: value.choice };
  return null;
}
function validatePublic(snapshot: ActivityResponse) {
  const p = snapshot.nativeGypsy;
  const fail = () => { throw new ActivityRequestError("原版吉普赛商人公开数据不完整，请重试原操作。", true); };
  if (!nativeObject(p) || p.version !== 1 || p.kind !== "gypsy-native" || p.slots !== 8
    || typeof p.started !== "boolean" || !day(p.day) || p.day !== snapshot.day
    || !integer(p.score, 0, 2_147_483_647) || p.score !== snapshot.points || !integer(p.refreshes, 0, 1_000_000_000)
    || typeof p.freeRefresh !== "boolean" || !integer(p.refreshCost, 0, 5)
    || p.refreshCost !== (p.freeRefresh ? 0 : 5) || typeof p.canRefresh !== "boolean"
    || p.canRefresh && p.score < p.refreshCost || !Array.isArray(p.offers)
    || !Array.isArray(p.previewTemplateIds) || p.previewTemplateIds.length !== 4
    || p.previewTemplateIds.some((id, i) => id !== recipes[i][0])
    || !nativeObject(p.localRules) || p.localRules.version !== 1 || typeof p.localRules.description !== "string"
    || ["state", "games", "seed"].some(key => key in p)) return fail();
  if (!p.started) {
    if (p.offers.length || p.refreshes !== 0 || p.shelfKey !== null || p.shelfDay !== null || !p.freeRefresh) return fail();
    return;
  }
  if (![3, 8].includes(p.offers.length) || !day(p.shelfDay) || p.refreshes < 1
    || p.freeRefresh !== (p.shelfDay !== p.day)
    || p.shelfKey !== p.shelfDay + ":" + p.refreshes || !shelf(p.shelfKey)) return fail();
  for (const [index, offer] of p.offers.entries()) {
    if (!nativeObject(offer) || offer.index !== index || typeof offer.sold !== "boolean" || typeof offer.canBuy !== "boolean"
      || !recipes.some(([id, count, price]) => offer.templateId === id && offer.itemCount === count && offer.price === price)
      || offer.canBuy && (offer.sold || p.score < (offer.price as number))) return fail();
  }
  for (const [id] of recipes) {
    const count = p.offers.filter(offer => offer.templateId === id).length;
    if (p.offers.length === 3 ? count > 1 : count !== 2) return fail();
  }
}
export const retryNativeGypsyRequest = (request: ActivityRequest) =>
  request.activityId === "gypsy-native" ? retryNativeActivityRequest(request) : null;
export function attachNativeGypsyHost(options: NativeGypsyHostOptions): NativeActivityHost {
  const target = options.target ?? window;
  return attachNativeActivityHost({ ...options,
    ready: () => typeof options.player.workshopGypsyAcceptSnapshot === "function" && typeof options.player.workshopGypsyRejectRequest === "function",
    accept: envelope => options.player.workshopGypsyAcceptSnapshot?.(envelope),
    reject: envelope => options.player.workshopGypsyRejectRequest?.(envelope),
    bind: ({ read, request, report }) => {
      target.workshopGypsyRead = read; target.workshopGypsyRequest = request; target.workshopGypsyReport = report;
      return () => {
        if (target.workshopGypsyRead === read) delete target.workshopGypsyRead;
        if (target.workshopGypsyRequest === request) delete target.workshopGypsyRequest;
        if (target.workshopGypsyReport === report) delete target.workshopGypsyReport;
      };
    },
  }, { activityId: "gypsy-native", title: "原版吉普赛商人", effectKey: "nativeGypsyAction", parseAction: nativeAction, validatePublic });
}
