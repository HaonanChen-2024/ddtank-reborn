/**
 * Ferreiro (bancada da Store bag, bag 12): 59 ITEM_STRENGTHEN, 58 ITEM_COMPOSE, 78 ITEM_FUSION (76 preview),
 * 121 ITEM_INLAY, 125 ITEM_EMBED_BACKOUT, 122 CLEAR_STORE_BAG (01 §5, 02 §4).
 * No jogo: bancada onde jogador coloca equipamento + pedras para reforçar, compor, incrustar e fundir.
 * Packets de um mesmo cliente são processados em ordem, e cada handler relê a bancada e valida antes de
 * alterar, então um pacote repetido nunca consome nem cria duas vezes.
 */
import { GSPacket } from "@ddt/protocol";
import type { Database } from "@ddt/db";
import { ItemInfo, BagType, templateBagType, type ItemTemplate } from "../game/item.js";
import type { PlayerInventory } from "../game/inventory.js";
import type { GamePlayer } from "../game/player.js";
import type { Templates } from "../db/templates.js";
import type { ServerContext } from "../session/context.js";
import type { HandlerRegistry } from "./registry.js";
import { mailItems } from "./items.js";
import { getConsortia, getEquipControl } from "../db/consortia.js";
import { saveItem } from "../db/items.js";
import { personalRiches, smithBonusLevel } from "../game/consortia.js";
import { pushRecords } from "./events.js";
import { commitPlayerMutation, PlayerMutationCommittedError } from "../game/player-transaction.js";

/** StrengthenMgr.RateItems (StrengthenMgr.cs:29): rate per strengthen stone level 1..6. */
export const STRENGTHEN_RATE_ITEMS = [0.75, 3.0, 12.0, 48.0, 240.0, 768.0];
/** StrengthenMgr.VIPStrengthenEx. */
export const VIP_STRENGTHEN_EX = 0.3;
/** ItemComposeHandler.composeRate (by stone quality 1..5). */
export const COMPOSE_RATE = [0.8, 0.5, 0.3, 0.1, 0.05];

export interface StrengthenRateInput {
  stoneLevels: number[];
  /** Luck stone Property2 (null = no luck stone). */
  luckP2: number | null;
  needRate: number;
  smithLevel: number;
  vip: boolean;
}

/**
 * Calcula chance de reforço no jogo: soma força das pedras + bônus sorte/guilda/VIP e compara com sorteio 0-9999.
 * Contrapartida C#: `ItemStrengthenHandler.cs:41-112` (`StrengthenMgr.RateItems`, `VIPStrengthenEx`).
 * Pacote: não lê/responde pacote direto; usado por `strengthen` (59 ITEM_STRENGTHEN), que responde `GSPacket(59)`
 * com `[byte resultado, boolean sucesso]` (`0`=sucesso, `1`=falha).
 * Exemplo concreto: pedras nível `[2,2]`, `needRate=100`, sem sorte/guilda/VIP → `(3+3)*100/100=600`, `total=60000`
 * (sempre sucesso pois `60000 > roll` em `0..9999`); sem pedra e `needRate>0` → `total=0` (sempre falha).
 */
export function strengthenChance(i: StrengthenRateInput): number {
  let probability = 0;
  for (const lv of i.stoneLevels) probability += STRENGTHEN_RATE_ITEMS[lv - 1] ?? 0;
  const luck = i.luckP2 == null ? 0 : probability + Math.trunc(i.luckP2 / 100);
  const need = i.needRate;
  const num5 = (probability * 100) / need;
  const num6 = (luck * 100) / need;
  const guild = i.smithLevel > 0 ? num5 * (0.1 * i.smithLevel) : 0;
  const vip = i.vip ? VIP_STRENGTHEN_EX * num5 : 0;
  const total = Math.floor((num5 + num6 + guild + vip) * 100);
  return Number.isFinite(total) ? total : 1_000_000;
}

/** ItemComposeHandler.cs:58-118: success if floor(rate*10)/10 > Random.Next(100). */
export function composeChance(stoneQuality: number, luckP2: number | null, smithLevel = 0): number {
  let p = (COMPOSE_RATE[stoneQuality - 1] ?? 0) * 100;
  if (luckP2 != null) p += (p * luckP2) / 100;
  else p += (p * 1) / 100; // C#: "+1%" when no luck stone
  if (smithLevel > 0) p *= 1 + 0.1 * smithLevel;
  return Math.floor(p * 10) / 10;
}

/** What a fusion roll can produce: the reward template picked + whether it succeeded. */
export interface FusionPick { template: ItemTemplate; result: boolean }

/**
 * Finds which rewards the 4 placed stones can produce.
 *
 * Como funciona (FusionMgr.cs): junta o FusionType das 4 pedras numa chave
 * (ex. tipos [3,3,3,3] → chave "3333"), busca a receita em Item_Fusion e soma
 * FusionRate / FusionNeedRate das pedras. Candidatos: item de recompensa no nível
 * da pedra mais forte +1, no mesmo nível e +2 (só os que existirem no banco).
 * `max` = melhor prêmio (chance boa), `min` = prêmio de consolação.
 *
 * @param placedStones 4 pedras dos slots 1-4 da storeBag (mesmo TemplateID)
 * @param templates acesso às tabelas (Item_Fusion, itens)
 * @returns null se não há receita pra essa combinação
 */
export function fusionCandidates(placedStones: ItemInfo[], templates: Templates): { max?: ItemTemplate; min?: ItemTemplate; rate: number; need: number; isBind: boolean } | null {
  const sortedFusionTypes = placedStones.map((stone) => stone.template.FusionType).sort((a, b) => a - b);
  const recipeKey = sortedFusionTypes.join("");
  const recipe = templates.fusions.get(recipeKey);
  let highestStoneLevel = 0, totalFusionRate = 0, totalNeedRate = 0, anyStoneBound = false;
  for (const stone of placedStones) {
    highestStoneLevel = Math.max(highestStoneLevel, stone.template.Level);
    totalFusionRate += stone.template.FusionRate;
    totalNeedRate += stone.template.FusionNeedRate;
    if (stone.IsBinds) anyStoneBound = true;
  }
  if (!recipe) return null;
  const rewardOptions = [templates.goodsByFusionTypeAndLevel(recipe.Reward, highestStoneLevel + 1), templates.goodsByFusionTypeAndLevel(recipe.Reward, highestStoneLevel), templates.goodsByFusionTypeAndLevel(recipe.Reward, highestStoneLevel + 2)]
    .filter((reward): reward is ItemTemplate => !!reward);
  // rateRatio = força das pedras / exigência do prêmio. <= 1.1: prêmio bom alcançável.
  const rateRatio = (reward: ItemTemplate) => totalFusionRate / reward.FusionNeedRate;
  const bestReward = rewardOptions.filter((reward) => rateRatio(reward) <= 1.1).sort((a, b) => rateRatio(b) - rateRatio(a))[0];
  const consolationReward = rewardOptions.filter((reward) => rateRatio(reward) > 1.1).sort((a, b) => rateRatio(a) - rateRatio(b))[0];
  return { max: bestReward, min: consolationReward, rate: totalFusionRate, need: totalNeedRate, isBind: anyStoneBound };
}

/**
 * Preview da fusão (o que o cliente mostra antes de confirmar).
 * FusionMgr.FusionPreview: template do prêmio -> chance % de sair.
 * Se só há `max`: chance direta. Se há os dois: divide 100% entre eles.
 */
export function fusionPreview(placedStones: ItemInfo[], templates: Templates): { rates: Map<number, number>; isBind: boolean } {
  const candidates = fusionCandidates(placedStones, templates);
  const previewRates = new Map<number, number>();
  if (!candidates) return { rates: previewRates, isBind: placedStones.some((stone) => stone.IsBinds) };
  if (candidates.max && !candidates.min) previewRates.set(candidates.max.TemplateID, (100 * candidates.rate) / candidates.need);
  if (candidates.max && candidates.min) {
    const topRewardChance = candidates.max.Level - candidates.min.Level === 2 ? (100 * candidates.rate * 0.6) / candidates.max.FusionNeedRate : (100 * candidates.rate) / candidates.max.FusionNeedRate;
    previewRates.set(candidates.max.TemplateID, topRewardChance);
    previewRates.set(candidates.min.TemplateID, 100 - topRewardChance);
  }
  if (!candidates.max && candidates.min) previewRates.set(candidates.min.TemplateID, (100 * candidates.rate) / candidates.need);
  return { rates: previewRates, isBind: candidates.isBind };
}

/**
 * Rola a fusão (FusionMgr.Fusion em FusionMgr.cs): sorteia o prêmio e se deu bom.
 * Trava anti-frustração do original: se o prêmio sorteado já está na bancada, falha.
 */
export function fusionRoll(placedStones: ItemInfo[], templates: Templates, rnd = Math.random): FusionPick | null {
  const candidates = fusionCandidates(placedStones, templates);
  if (!candidates) return null;
  let pickedReward: ItemTemplate | undefined;
  let succeeded = false;
  if (candidates.max && !candidates.min) {
    pickedReward = candidates.max;
    if (Math.floor(rnd() * candidates.need) < candidates.rate) succeeded = true;
  }
  if (candidates.max && candidates.min) {
    if ((100 * candidates.rate) / candidates.max.FusionNeedRate > Math.floor(rnd() * 100)) pickedReward = candidates.max;
    else pickedReward = candidates.min;
    succeeded = true;
  }
  if (!candidates.max && candidates.min) {
    pickedReward = candidates.min;
    if (Math.floor(rnd() * candidates.need) < candidates.rate) succeeded = true;
  }
  if (!pickedReward) return null;
  if (succeeded && placedStones.some((stone) => stone.TemplateID === pickedReward!.TemplateID)) succeeded = false;
  return { template: pickedReward, result: succeeded };
}

/**
 * Trava de senha da bolsa no jogo: bloqueia uso da forja enquanto `HasBagPassword && IsLocked`.
 * Contrapartida C#: checagem `HasBagPassword/IsLocked` usada pelos handlers de forja antes de mexer na `StoreBag`.
 * Pacote: não lê nem responde pacote; só envia mensagem `0` com string exata `"Bag.Locked"` e retorna `true`.
 * Exemplo concreto: jogador com senha ativa e bolsa trancada tenta `compose` → recebe `"Bag.Locked"` e nada é consumido.
 */
function bagLocked(ctx: ServerContext, p: GamePlayer): boolean {
  if (p.info.HasBagPassword && p.info.IsLocked) {
    p.sendMessage(0, ctx.lang.t("Bag.Locked"));
    return true;
  }
  return false;
}

/** GamePlayer.isPlayerWarrior: Extra.coupleBossBoxNum == 9 (GM "warrior" accounts always succeed). */
function isWarrior(p: GamePlayer): boolean {
  return (p.extra as { coupleBossBoxNum?: number } | null)?.coupleBossBoxNum === 9;
}

/**
 * Esvazia bancada da forja no jogo: devolve cada item da `storeBag` para `propBag`/`equipBag`, resto vai por correio.
 * Contrapartida C#: `GamePlayer.ClearStoreBag` (`GamePlayer.cs:2205`) + `StoreClearItemHandler` (122 CLEAR_STORE_BAG).
 * Pacote: não lê pacote (122 não tem corpo); sem resposta de pacote, só move itens e envia correio com string exata
 * `"StoreClearItemHandler.Mail"` (ou `"Itens devolvidos pela Forja."` como fallback).
 * Exemplo concreto: bancada com espada + pedra e `propBag` cheia → espada volta para `equipBag`, pedra vai por correio.
 * Como lê esse código (cada variável):
 * - `store`: bancada da forja (`p.storeBag`, bag 12, slots 0-19); origem de todos os itens.
 * - `left`: itens sem espaço nas bolsas; vão por correio via `mailItems`.
 * - `it`: item atual da bancada em `store.getItems()`; contém `template`, `Place`, `BagType`, `Count`.
 * - `toProp`: `true` quando `templateBagType(it.template) === BagType.PropBag`; decide bolsa destino.
 * - `dest`: bolsa destino (`p.propBag` ou `p.equipBag`).
 * - `place`: slot livre no destino (`findFirstEmptySlot()`, equipamento a partir de 31); `-1` = sem espaço.
 */
export async function clearStoreBag(ctx: ServerContext, p: GamePlayer): Promise<void> {
  const store = p.storeBag;
  const left: ItemInfo[] = [];
  store.beginChanges(); p.propBag.beginChanges(); p.equipBag.beginChanges();
  try {
    for (const it of store.getItems()) {
      const toProp = templateBagType(it.template) === BagType.PropBag;
      const dest = toProp ? p.propBag : p.equipBag;
      const place = toProp ? dest.findFirstEmptySlot() : dest.findFirstEmptySlot(31);
      if (place >= 0 && store.takeOutItem(it) && dest.addItemTo(it, place)) continue;
      if (it.BagType !== BagType.Store) store.addItemTo(it, it.Place >= 0 ? it.Place : store.findFirstEmptySlot());
      left.push(it);
    }
  } finally {
    store.commitChanges(); p.propBag.commitChanges(); p.equipBag.commitChanges();
  }
  if (left.length) {
    for (const it of left) store.takeOutItem(it);
    await mailItems(ctx, p, left, "铁匠铺退还道具", 9);
  }
}

/**
 * Bônus de ferreiro da guilda no jogo: +10% por nível na taxa de reforço/composição quando há permissão e riqueza.
 * Contrapartida C#: `ItemStrengthenHandler.cs:88-103` (`Equip_Control` tipo 2, `smithBonusLevel`, `personalRiches`).
 * Pacote: não lê/responde pacote; recebe `useGuild` (byte boolean lido pelo chamador) e retorna nível (0 = sem bônus).
 * Exemplo concreto: `useGuild=true`, guilda com permissão e `SmithLevel=2` → retorna `2` (+20%); sem guilda e negado → mensagem exata `"ItemStrengthenHandler.FailbyPermission"` e nível 0.
 */
async function guildSmith(ctx: ServerContext, p: GamePlayer, useGuild: boolean): Promise<number> {
  if (!useGuild) return 0;
  const th = p.info.ConsortiaID ? await getEquipControl(ctx.db.db, p.info.ConsortiaID, 0, 2) : undefined;
  const sb = smithBonusLevel(true, p.info.ConsortiaID !== 0, p.info.SmithLevel, personalRiches(p.info), th);
  if (sb.denied) p.sendMessage(p.info.ConsortiaID ? 1 : 0, ctx.lang.t(p.info.ConsortiaID ? "ItemStrengthenHandler.FailbyPermission" : "ItemStrengthenHandler.Fail"));
  return sb.level;
}

/**
 * Reforço no jogo: sobe `StrengthenLevel` do equipamento do slot 5 da bancada consumindo pedras dos slots 0-2.
 * Contrapartida C#: `ItemStrengthenHandler.cs` (pacote 59 ITEM_STRENGTHEN).
 * Pacote que lê: `boolean useGuild` (usa bônus de ferreiro da guilda). Resposta `GSPacket(59)`: `[byte resultado, boolean sucesso]` (`0`+`true`=sucesso, `1`+`false`=falha).
 * Exemplo concreto: espada `+3` no slot 5 + 2 pedras nível 2 nos slots 0-1 → consome 1 unidade de cada pedra, sorteia `chance > roll(0-9999)`; sucesso vira `+4`, falha sem pedra divina quebra ou regride item nível 3.
 * Como lê esse código (cada variável):
 * - `useGuild`: `boolean` lido do pacote; `true` = aplica bônus de ferreiro da guilda via `guildSmith`.
 * - `store`: bancada da forja (`p.storeBag`, bag 12); slots 0-2 pedras, 3 divina, 4 sorte, 5 equipamento.
 * - `item`: equipamento em `store.getItemAt(5)`; contém `template.CanStrengthen`, `Count`, `StrengthenLevel`, `IsBinds`.
 * - `stones`: pedras de reforço (`CategoryID===11` e `Property1===2|35`) coletadas dos slots 0-2.
 * - `s`: número do slot varrido em `[0,1,2]`; `st`: item encontrado nesse slot.
 * - `luckIt`: item cru do slot 4; `luck`: pedra da sorte validada (`CategoryID===11`, `Property1===3`) ou `null`.
 * - `godIt`: item cru do slot 3; `god`: pedra divina validada (`CategoryID===11`, `Property1===7`) ou `null` (sem ela, falha quebra/regride).
 * - `needRate`: exigência da tabela `strengthenNeedRate(StrengthenLevel, CategoryID)`; denominador da chance.
 * - `smith`: nível de ferreiro da guilda retornado por `guildSmith` (0 = sem bônus).
 * - `chance`: número de `strengthenChance(...)` comparado com `roll`; sucesso quando `chance > roll`.
 * - `original`: referência ao `item` antes de possível troca de `TemplateID` (arma re-templada vira outra linha).
 * - `isBinds`: `true` quando equipamento, pedras, sorte ou divina têm `IsBinds`; resultado herda amarração.
 * - `out`: `GSPacket(59, p.id)` de resposta com `[byte, boolean]`.
 * - `roll`: sorteio `Math.floor(rnd()*10000)` (conta guerreira `isWarrior` força `0`; a chance ainda deve ser positiva).
 * - `sg`: linha de `findStrengthenGoods/findRealStrengthenGoods` com `GainEquip` (evolução/devolução da arma).
 * - `t`: novo `ItemTemplate` de `sg.GainEquip` usado em `ItemInfo.cloneFromTemplate`.
 */
/** Re-read the real workbench after both the player save lock and SQL owner lock. */
function strengthenInputs(ctx: ServerContext, p: GamePlayer, now: Date) {
  const store = p.storeBag;
  const item = store.getItemAt(5);
  const valid = (it: ItemInfo, slot: number) => it.IsExist && it.UserID === p.id && it.BagType === store.bagType && it.Place === slot &&
    !it.cellLocked && it.isValidItem(now) && Number.isSafeInteger(it.Count) && it.Count > 0 && it.Count <= 2_147_483_647 && ctx.templates.findItem(it.TemplateID) === it.template;
  if (!Number.isFinite(now.getTime()) || !store.saveToDb || !item || !valid(item, 5) || !item.template.CanStrengthen || item.Count !== 1 ||
      !Number.isInteger(item.StrengthenLevel) || item.StrengthenLevel < 0 || !Number.isInteger(item.StrengthenTimes) || item.StrengthenTimes < 0 || item.StrengthenTimes >= 2_147_483_647) return "强化装备状态无效，请保留物品并重试。";
  const stones: ItemInfo[] = [];
  for (const s of [0, 1, 2]) {
    const st = store.getItemAt(s);
    if (st && st.template.CategoryID === 11 && (st.template.Property1 === 2 || st.template.Property1 === 35)) {
      if (!valid(st, s) || !Number.isInteger(st.template.Level) || st.template.Level < 1 || st.template.Level > STRENGTHEN_RATE_ITEMS.length) return "强化石状态无效，请保留物品并重试。";
      stones.push(st);
    }
  }
  const luckIt = store.getItemAt(4);
  const luck = luckIt && luckIt.template.CategoryID === 11 && luckIt.template.Property1 === 3 ? luckIt : null;
  const godIt = store.getItemAt(3);
  const god = godIt && godIt.template.CategoryID === 11 && godIt.template.Property1 === 7 ? godIt : null;
  if (stones.length < 1) return `${ctx.lang.t("ItemStrengthenHandler.Content1")}1${ctx.lang.t("ItemStrengthenHandler.Content2")}`;
  if ((luck && (!valid(luck, 4) || !Number.isInteger(luck.template.Property2))) || (god && !valid(god, 3))) return "强化辅助材料状态无效，请保留物品并重试。";
  const needRate = ctx.templates.strengthenNeedRate(item.StrengthenLevel, item.template.CategoryID);
  if (!ctx.templates.strengthen.has(item.StrengthenLevel + 1)) return ctx.lang.t("ItemStrengthenHandler.Success");
  if (!Number.isFinite(needRate) || needRate <= 0) return "强化需求配置无效，请保留物品并检查配置。";
  return { item, stones, luck, god, needRate };
}

export async function strengthen(ctx: ServerContext, p: GamePlayer, pkt: GSPacket, rnd = Math.random): Promise<void> {
  const reject = (message = "强化保存失败，装备和材料未改变，请稍后重试。") => p.sendMessage(0, message);
  if (pkt.length - pkt.offset !== 1) return reject("强化请求无效。");
  const useGuild = pkt.readBoolean();
  return p.withPersistenceLock(async () => {
    if (!p.isActive || p.quitting || p.currentRoom?.IsPlaying) return reject("当前不能强化，请返回大厅后重试。");
    if (bagLocked(ctx, p)) return;
    const initial = strengthenInputs(ctx, p, ctx.now());
    if (typeof initial === "string") return reject(initial);
    // Original denied guild bonus is a notice, not a rejected strengthening attempt.
    const smith = await guildSmith(ctx, p, useGuild);
    if (!Number.isSafeInteger(smith) || smith < 0) return reject("公会强化配置无效。");
    let message: string | undefined, result: { success: boolean; category: number; level: number } | null = null;
    let notificationError: unknown;
    try {
      result = await commitPlayerMutation(ctx, p, async (_db, staged, now) => {
        if (p.currentRoom?.IsPlaying || (staged.info.HasBagPassword && staged.info.IsLocked)) return null;
        const input = strengthenInputs(ctx, staged, now);
        if (typeof input === "string") { message = input; return null; }
        let { item } = input;
        const { stones, luck, god, needRate } = input, store = staged.storeBag;
        const chance = strengthenChance({ stoneLevels: stones.map(s => s.template.Level), luckP2: luck?.template.Property2 ?? null, needRate, smithLevel: smith, vip: staged.info.typeVIP > 0 });
        const sample = isWarrior(p) ? 0 : rnd();
        if (!Number.isFinite(sample) || sample < 0 || sample >= 1) { message = "强化随机结果无效，请重试。"; return null; }
        const success = chance > Math.floor(sample * 10000), original = item;
        item.StrengthenTimes++;
        item.IsBinds ||= stones.some(s => s.IsBinds) || !!luck?.IsBinds || !!god?.IsBinds;
        // Keep the existing local contract: exactly one unit per USED slot, even in a 9999 stack.
        for (const material of [...stones, luck, god]) if (material && !store.removeCountFromStack(material, 1)) throw new Error("Strengthen material changed");
        if (!store.takeOutItem(item)) throw new Error("Strengthen equipment changed");
        if (success) {
          item.StrengthenLevel++;
          const row = ctx.templates.findStrengthenGoods(item.StrengthenLevel, item.TemplateID);
          if (row && item.template.CategoryID === 7 && row.GainEquip > item.TemplateID) {
            const template = ctx.templates.findItem(row.GainEquip);
            if (!template) throw new Error("Strengthen replacement template missing");
            item = ItemInfo.cloneFromTemplate(template, item);
          }
        } else if (!god) {
          if (item.template.Level === 3) {
            if (item.StrengthenLevel >= 5) item.StrengthenLevel--;
            const row = ctx.templates.findRealStrengthenGoods(item.StrengthenLevel, item.TemplateID);
            if (row && item.template.CategoryID === 7 && row.GainEquip !== item.TemplateID) {
              const template = ctx.templates.findItem(row.GainEquip);
              if (!template) throw new Error("Strengthen replacement template missing");
              item = ItemInfo.cloneFromTemplate(template, item);
            }
          } else { item.Count--; item.IsExist = false; item.RemoveType = 14; item.RemoveDate = now; item.isDirty = true; }
        }
        item.openHole();
        if (item !== original) {
          original.IsExist = false; original.RemoveDate = now; original.isDirty = true;
          // Gold is derived from the NEW base identity; lifetime/base TemplateID remain durable and unchanged in meaning.
          item.goldTemplate = ctx.templates.findGoldTemplate(item.TemplateID) ?? null;
        }
        if (item.IsExist && !store.addItemTo(item, 5)) throw new Error("Strengthen result slot changed");
        return { value: { success, category: item.template.CategoryID, level: item.StrengthenLevel } };
      });
    } catch (error) {
      if (error instanceof PlayerMutationCommittedError) { result = error.value as NonNullable<typeof result>; notificationError = error; }
      else { ctx.log.error("Strengthen transaction failed", error); return reject(); }
    }
    if (!result) return reject(message);
    const committed = result;
    const notify = (work: () => void) => { try { work(); } catch (error) { notificationError ??= error; } };
    if (committed.success) {
      notify(() => p.questInv?.onItemStrengthen(committed.category, committed.level));
      notify(() => pushRecords(p, new Map([[32, 1]])));
    }
    notify(() => { const out = new GSPacket(59, p.id); out.writeByte(committed.success ? 0 : 1); out.writeBoolean(committed.success); p.send(out); });
    notify(() => p.updatePlayerProperties());
    if (notificationError) throw notificationError;
  });
}

/**
 * Composição no jogo: grava atributo (`AttackCompose`/`DefendCompose`/`AgilityCompose`/`LuckCompose`) no equipamento.
 * Contrapartida C#: `ItemComposeHandler.cs` (pacote 58 ITEM_COMPOSE).
 * Pacote que lê: `boolean useGuild`; usa bancada `storeBag` (slot 1 equipamento, slot 2 pedra, slot 0 sorte) e cobra `PRICE_COMPOSE_GOLD` (padrão 1600). Resposta `GSPacket(58)`: `[byte ok]` (`0`=sucesso, `1`=falha).
 * Exemplo concreto: colar no slot 1 + pedra `Property3=1/Property4=50` no slot 2, `prob=42.5 > rand=10` → `AttackCompose=50`, consome pedra + 1600 ouro, responde byte `0`.
 * Como lê esse código (cada variável):
 * - `mustGold`: custo em ouro lido de `cfgInt("PRICE_COMPOSE_GOLD", 1600)`.
 * - `useGuild`: `boolean` do pacote; `true` = tenta bônus de ferreiro da guilda.
 * - `store`: bancada da forja (`p.storeBag`); slots 1 equipamento, 2 pedra, 0 sorte.
 * - `item`: equipamento em `store.getItemAt(1)`; contém `CanCompose` e campos `*Compose`.
 * - `stone`: pedra de composição em `store.getItemAt(2)` (`CategoryID===11`, `Property1===1`); `Property3` = atributo, `Property4` = valor.
 * - `luckIt`: item cru do slot 0; `luck`: pedra da sorte validada (`CategoryID===11`, `Property1===3`) ou `null`.
 * - `isBinds`: amarração resultante (`item.IsBinds || stone.IsBinds || luck.IsBinds`).
 * - `smith`: nível de ferreiro da guilda (`0` sem `useGuild`); multiplica taxa por `(1+0.1*SmithLevel)`.
 * - `th`: controle `Equip_Control` da guilda (`getEquipControl(...,0,2)`); `sb`: resultado `smithBonusLevel` com `denied/level`.
 * - `prob`: chance de `composeChance(Quality, luck.Property2, smith)`; `rand`: sorteio `Math.floor(rnd()*100)`.
 * - `key`: campo alterado (`AttackCompose|DefendCompose|AgilityCompose|LuckCompose`) via `stone.Property3 (1|2|3|4)`.
 * - `ok`: `1`=falha, `0`=sucesso (`prob > rand` grava `item[key]=stone.Property4`).
 * - `out`: `GSPacket(58, p.id)` de resposta com `writeByte(ok)`.
 */
/** Only the selected workbench cells participate; a matching spare stack is not a material. */
function composeInputs(ctx: ServerContext, p: GamePlayer, now: Date) {
  const mustGold = ctx.templates.cfgInt("PRICE_COMPOSE_GOLD", 1600);
  const store = p.storeBag, item = store.getItemAt(1), stone = store.getItemAt(2);
  const valid = (it: ItemInfo, slot: number) => it.IsExist && it.UserID === p.id && it.BagType === store.bagType && it.Place === slot &&
    !it.cellLocked && it.isValidItem(now) && Number.isSafeInteger(it.Count) && it.Count > 0 && it.Count <= 2_147_483_647 && ctx.templates.findItem(it.TemplateID) === it.template;
  if (!Number.isFinite(now.getTime()) || !store.saveToDb || !Number.isSafeInteger(mustGold) || mustGold < 0 || mustGold > 2_147_483_647 ||
      !Number.isSafeInteger(p.info.Gold) || p.info.Gold < 0 || p.info.Gold > 2_147_483_647) return "合成金币配置无效，请保留物品并检查配置。";
  if (p.info.Gold < mustGold) return ctx.lang.t("ItemComposeHandler.NoMoney");
  if (!item || !stone || stone.Count <= 0) return ctx.lang.t("ItemComposeHandler.Msg");
  // Port: the stone must be a compose stone (cat 11, Property1 1); the C# only checked it for items of category >= 10.
  if (!item.template.CanCompose || !(stone.template.CategoryID === 11 && stone.template.Property1 === 1)) return ctx.lang.t("ItemComposeHandler.Fail");
  const luckIt = store.getItemAt(0);
  const luck = luckIt && luckIt.template.CategoryID === 11 && luckIt.template.Property1 === 3 ? luckIt : null;
  if (!valid(item, 1) || item.Count !== 1 || !valid(stone, 2) ||
      !Number.isInteger(stone.template.Quality) || stone.template.Quality < 1 || stone.template.Quality > COMPOSE_RATE.length ||
      !Number.isInteger(stone.template.Property4) || stone.template.Property4 < 0 || stone.template.Property4 > 2_147_483_647 ||
      (luck && (!valid(luck, 0) || !Number.isInteger(luck.template.Property2) || luck.template.Property2 < 0))) return "合成装备或材料状态无效，请保留物品并重试。";
  const key = ({ 1: "AttackCompose", 2: "DefendCompose", 3: "AgilityCompose", 4: "LuckCompose" } as const)[stone.template.Property3 as 1 | 2 | 3 | 4];
  if (!key || !Number.isSafeInteger(item[key]) || item[key] < 0 || !(stone.template.Property4 > item[key])) return ctx.lang.t("ItemComposeHandler.NoLevel");
  return { item, stone, luck, luckP2: luck?.template.Property2 ?? (luckIt ? 0 : null), key, mustGold };
}

export async function compose(ctx: ServerContext, p: GamePlayer, pkt: GSPacket, rnd = Math.random): Promise<void> {
  const reject = (message = "合成保存失败，装备、材料和金币未改变，请稍后重试。", type = 0) => p.sendMessage(type, message);
  const invalid = (message: string) => reject(message, [ctx.lang.t("ItemComposeHandler.NoMoney"), ctx.lang.t("ItemComposeHandler.Msg")].includes(message) ? 1 : 0);
  if (pkt.length - pkt.offset !== 1) return reject("合成请求无效。");
  const useGuild = pkt.readBoolean();
  return p.withPersistenceLock(async () => {
    if (!p.isActive || p.quitting || p.currentRoom?.IsPlaying) return reject("当前不能合成，请返回大厅后重试。");
    if (bagLocked(ctx, p)) return;
    const initial = composeInputs(ctx, p, ctx.now());
    if (typeof initial === "string") return invalid(initial);
    let message: string | undefined, deniedGuild = false, missingGuild = false;
    let result: { success: boolean; stoneId: number } | null = null, notificationError: unknown;
    try {
      result = await commitPlayerMutation(ctx, p, async (db, staged, now) => {
        if (!p.isActive || p.quitting || p.currentRoom?.IsPlaying || (staged.info.HasBagPassword && staged.info.IsLocked)) return null;
        const input = composeInputs(ctx, staged, now);
        if (typeof input === "string") { message = input; return null; }
        const { item, stone, luck, luckP2, key, mustGold } = input, store = staged.storeBag;
        let smith = 0;
        if (useGuild) {
          const guild = await getConsortia(db, staged.info.ConsortiaID);
          if (!guild) missingGuild = true; // C#: missing guild is a notice, not a rejected attempt.
          else {
            const threshold = await getEquipControl(db, staged.info.ConsortiaID, 0, 2);
            const bonus = smithBonusLevel(true, true, guild.SmithLevel, personalRiches(staged.info), threshold);
            if (bonus.denied) { deniedGuild = true; return null; }
            smith = bonus.level;
          }
        }
        if (!Number.isSafeInteger(smith) || smith < 0) { message = "公会合成配置无效。"; return null; }
        const sample = rnd();
        if (!Number.isFinite(sample) || sample < 0 || sample >= 1) { message = "合成随机结果无效，请重试。"; return null; }
        const success = composeChance(stone.template.Quality, luckP2, smith) > Math.floor(sample * 100);
        if (success) item[key] = stone.template.Property4;
        item.IsBinds ||= stone.IsBinds || !!luck?.IsBinds;
        if (!store.removeCountFromStack(stone, 1) || (luck && !store.removeCountFromStack(luck, 1))) throw new Error("Compose material changed");
        store.updateItem(item);
        staged.removeGold(mustGold);
        return { value: { success, stoneId: stone.TemplateID } };
      });
    } catch (error) {
      if (error instanceof PlayerMutationCommittedError) { result = error.value as NonNullable<typeof result>; notificationError = error; }
      else { ctx.log.error("Compose transaction failed", error); return reject(); }
    }
    if (missingGuild) { try { p.sendMessage(0, ctx.lang.t("ItemStrengthenHandler.Fail")); } catch (error) { notificationError ??= error; } }
    if (deniedGuild) return reject(ctx.lang.t("ItemStrengthenHandler.FailbyPermission"), 1);
    if (!result) return message ? invalid(message) : reject();
    const committed = result;
    const notify = (work: () => void) => { try { work(); } catch (error) { notificationError ??= error; } };
    if (committed.success) notify(() => p.questInv?.onItemCompose(committed.stoneId));
    notify(() => { const out = new GSPacket(58, p.id); out.writeByte(committed.success ? 0 : 1); p.send(out); });
    notify(() => p.updatePlayerProperties());
    if (notificationError) throw notificationError;
  });
}

/**
 * Reborn auto-split da fusão — por que existe:
 * o cliente Flash não tem seletor de quantidade: arrastar a pedra joga a pilha
 * INTEIRA num slot só, e a fusão precisa de 1 unidade em cada slot 1-4.
 * Então antes de validar, o servidor espalha 1 unidade por slot vazio a partir
 * de pilhas do mesmo tipo da primeira preenchida. Resto fica no slot de origem.
 * Ex: slot1 com 6 pedras → vira 3/1/1/1 e funde direto. Tipos mistos continuam
 * barrados pela checagem normal abaixo. Usa `moveItem` (mesmo split do arrastar
 * manual, persiste via dirty/commit como qualquer move).
 *
 * Como lê esse código (cada variável):
 * - workbench: a storeBag do jogador (bancada da forja, slots 0-19; fusão usa 1-4).
 *   Vem de `player.storeBag` (GamePlayer.cs: bancada = StoreBag).
 * - pass: nº da volta (0..2). Cada volta preenche 1 slot; faltam no máx 3.
 * - filledSlots: nºs dos slots 1-4 ocupados AGORA. Ex: [1] = só o slot 1 tem pedra.
 * - firstStone: ItemInfo do 1º slot ocupado — dita o tipo permitido nas outras vagas.
 *   ItemInfo = 1 linha de item no banco (Sys_Users_Goods): TemplateID (o quê),
 *   Count (quantas unidades na pilha), Place (slot), IsBinds, ValidDate.
 * - donorStack: pilha com Count > 1 do MESMO TemplateID da firstStone —
 *   é de onde sai 1 unidade. null = nada pra espalhar, sai.
 * - emptySlot: nº do slot vazio que vai receber a unidade. undefined = bancada
 *   cheia, sai.
 * - donorStack.Place: posição atual da pilha doadora (moveItem precisa origem→destino).
 *
 * @param workbench a storeBag (bancada da forja, slots 0-19; fusão usa 1-4)
 */
export function autoSplitFusionSlots(workbench: PlayerInventory): void {
  for (let pass = 0; pass < 3; pass++) {
    const filledSlots = [1, 2, 3, 4].filter((slot) => workbench.getItemAt(slot));
    if (filledSlots.length >= 4) return;
    const firstStone = workbench.getItemAt(filledSlots[0] ?? 1);
    const donorStack = [1, 2, 3, 4]
      .map((slot) => workbench.getItemAt(slot))
      .find((stone) => stone && stone.Count > 1 && (!firstStone || stone.TemplateID === firstStone.TemplateID));
    const emptySlot = [1, 2, 3, 4].find((slot) => !workbench.getItemAt(slot));
    if (!donorStack || emptySlot === undefined) return;
    if (!workbench.moveItem(donorStack.Place, emptySlot, 1)) return;
  }
}

/**
 * Fusão (ItemFusionHandler.cs, pacote 78; preview = pacote 76).
 *
 * Fluxo no jogo: jogador arrasta 4 pedras iguais pros slots 1-4 da bancada
 * (StoreIIFusionBG.as no cliente) e aperta fundir. Cada tentativa consome
 * 1 unidade de cada slot + 400 ouro, e o resultado cai no slot 0
 * (o que estava no 0 volta pra bolsa ou vai pro correio).
 *
 * Pacote que chega: 1 byte `operation` (0 = só mostra preview, 1 = funde).
 * Resposta preview (76): quantidade de prêmios, pra cada um
 * [templateID, dias de validade, chance%] + se amarra (bind).
 * Resposta fusão (78): 1 boolean (deu bom ou não) + mensagem de chat.
 */
export async function fusion(ctx: ServerContext, player: GamePlayer, pkt: GSPacket, rnd = Math.random): Promise<void> {
  const operation = pkt.readByte();
  if (bagLocked(ctx, player)) return;
  const workbench = player.storeBag;
  autoSplitFusionSlots(workbench);
  const placedStones: ItemInfo[] = [];
  for (let slot = 1; slot <= 4; slot++) {
    const stone = workbench.getItemAt(slot);
    if (stone) placedStones.push(stone);
  }
  if (placedStones.length >= 4 && placedStones.some((stone) => stone.TemplateID !== placedStones[0]!.TemplateID)) return player.sendMessage(1, "放入的道具类型不一致！");
  if (placedStones.length !== 4) return player.sendMessage(0, ctx.lang.t("ItemFusionHandler.ItemNotEnough"));
  const sortedExpiries = placedStones.map((stone) => stone.ValidDate).sort((a, b) => a - b);
  // Validade do prêmio: menor das 4 (0 = permanente; se alguma é permanente, usa a 2ª menor).
  const shortestExpiry = placedStones.every((stone) => stone.ValidDate !== 0) ? sortedExpiries[0]! : sortedExpiries[1]!;
  let rewardExpiryDays = shortestExpiry;
  if (operation === 0) {
    const preview = fusionPreview(placedStones, ctx.templates);
    const candidates = fusionCandidates(placedStones, ctx.templates);
    let rewardBound = preview.isBind;
    const anyReward = candidates?.max ?? candidates?.min;
    if (anyReward && (anyReward.CategoryID === 7 || anyReward.CategoryID === 17)) { rewardExpiryDays = 7; rewardBound = true; }
    if (preview.rates.size === 0) return;
    const out = new GSPacket(76, player.id);
    out.writeInt(preview.rates.size);
    for (const [rewardTemplateId, chancePct] of preview.rates) {
      out.writeInt(rewardTemplateId); out.writeInt(rewardExpiryDays); out.writeInt(Math.trunc(chancePct > 100 ? 100 : chancePct >= 0 ? chancePct : 0));
    }
    out.writeBoolean(rewardBound);
    player.send(out);
    return;
  }
  if (player.info.Gold < 400) return player.sendMessage(1, ctx.lang.t("ItemFusionHandler.NoMoney"));
  const rolled = fusionRoll(placedStones, ctx.templates, rnd);
  if (!rolled) return player.sendMessage(0, ctx.lang.t("ItemFusionHandler.NoCondition"));
  let rewardBound = placedStones.some((stone) => stone.IsBinds);
  if (rolled.template.CategoryID === 7 || rolled.template.CategoryID === 17) { rewardExpiryDays = 7; rewardBound = true; }
  const overflowToMail: ItemInfo[] = [];
  workbench.beginChanges();
  try {
    const previousResult = workbench.getItemAt(0);
    if (previousResult) {
      workbench.takeOutItem(previousResult);
      const homeBag = player.getItemInventory(previousResult.template);
      if (!homeBag || !(homeBag.stackItemToAnother(previousResult) || homeBag.addItem(previousResult))) overflowToMail.push(previousResult);
    }
    player.removeGold(400);
    for (const stone of placedStones) workbench.removeCountFromStack(stone, 1);
    if (rolled.result) {
      if (templateBagType(rolled.template) === BagType.EquipBag) rewardExpiryDays = shortestExpiry;
      const reward = ItemInfo.createFromTemplate(rolled.template, 1, 105, ctx.now());
      reward.IsBinds = rewardBound;
      reward.ValidDate = rewardExpiryDays;
      player.questInv?.onItemFusion(rolled.template.FusionType);
      player.sendMessage(0, ctx.lang.t("ItemFusionHandler.Succeed1") + (rolled.template.Name ?? ""));
      if (!workbench.addItemTo(reward, 0)) overflowToMail.push(reward);
    } else player.sendMessage(0, ctx.lang.t("ItemFusionHandler.Failed"));
  } finally {
    workbench.commitChanges();
  }
  if (overflowToMail.length) await mailItems(ctx, player, overflowToMail);
  const done = new GSPacket(78, player.id);
  done.writeBoolean(rolled.result);
  player.send(done);
}

/**
 * Incrustação no jogo: coloca joia (`Property1===31`) num furo cujo tipo (`holeType`) equals `gem.Property2`.
 * Contrapartida C#: `ItemInlayHandle.cs` (pacote 121 ITEM_INLAY).
 * Pacote que lê: `[int itemBag, int itemPlace, int hole(1-6), int gemBag, int gemPlace]`; cobra `InlayGoldPrice` (padrão 2000) mesmo quando furo não combina. Resposta `GSPacket(121)`: `writeByte(1)` na falha, `writeInt(0)` no sucesso.
 * Exemplo concreto: arma com furo 1 do tipo 5 + joia `Property1=31/Property2=5` → `Hole1=TemplateID` da joia, joia consumida, ouro -2000; joia de tipo errado → ouro cobrado mesmo assim, mensagem exata `"GameServer.InlayItem.Msg1"`.
 * Como lê esse código (cada variável):
 * - `itemBag`: id da bolsa do equipamento lido do pacote; `itemPlace`: slot do equipamento nessa bolsa.
 * - `hole`: número do furo (1-6) lido do pacote; fora disso responde `1` + `"ItemInlayHandle.NoPlace"`.
 * - `gemBag`: id da bolsa da joia lido do pacote; `gemPlace`: slot da joia nessa bolsa.
 * - `ib`: inventário do equipamento (`p.getInventory(itemBag)`); `gb`: inventário da joia (`p.getInventory(gemBag)`).
 * - `item`: equipamento em `ib.getItemAt(itemPlace)`; contém campos `Hole1..Hole6` e `holeType(hole)`.
 * - `gem`: joia em `gb.getItemAt(gemPlace)`; válida quando `template.Property1===31`, tipo em `template.Property2`.
 * - `price`: custo `cfgInt("InlayGoldPrice", 2000)`; exige `p.info.Gold > price`, senão `"UserBuyItemHandler.NoMoney"`.
 * - `out`: `GSPacket(121, p.id)` de resposta.
 * - `key`: campo do furo (`Hole${hole}`); `ok`: `holeType(hole)===gem.Property2 && item[key]>=0` (furo aberto).
 * - `back`: joias antigas dos furos 5/6 devolvidas via `propBag` ou correio; `t`: `ItemTemplate` da joia antiga; `old`: nova `ItemInfo` amarrada criada dessa joia.
 */
export async function inlay(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  const itemBag = pkt.readInt(), itemPlace = pkt.readInt(), hole = pkt.readInt(), gemBag = pkt.readInt(), gemPlace = pkt.readInt();
  const ib = p.getInventory(itemBag), gb = p.getInventory(gemBag);
  const item = ib?.getItemAt(itemPlace), gem = gb?.getItemAt(gemPlace);
  if (!ib || !gb || !item || !gem || gem.template.Property1 !== 31) return;
  const price = ctx.templates.cfgInt("InlayGoldPrice", 2000);
  if (!(p.info.Gold > price)) return p.sendMessage(0, ctx.lang.t("UserBuyItemHandler.NoMoney"));
  const out = new GSPacket(121, p.id);
  if (!(hole > 0 && hole < 7)) {
    out.writeByte(1);
    p.sendMessage(0, ctx.lang.t("ItemInlayHandle.NoPlace"));
    return p.send(out);
  }
  p.removeGold(price); // C#: charged even when the hole type does not match
  const key = `Hole${hole}` as "Hole1";
  // Port: the hole must be open (>= 0); the C# trusted the client.
  const ok = item.holeType(hole) === gem.template.Property2 && item[key] >= 0;
  if (ok) {
    const back: ItemInfo[] = [];
    if ((hole === 5 || hole === 6) && item[key] > 0) {
      const t = ctx.templates.findItem(item[key]);
      if (t) {
        const old = ItemInfo.createFromTemplate(t, 1, 102, ctx.now());
        old.IsBinds = true;
        old.ValidDate = 0;
        if (!p.propBag.addTemplate(old, 1)) back.push(old);
      }
    }
    item[key] = gem.TemplateID;
    if (gem.IsBinds) item.IsBinds = true;
    gb.removeCountFromStack(gem, 1);
    ib.updateItem(item);
    if (back.length) await mailItems(ctx, p, back);
    p.questInv?.onItemInsert(); // player.ItemInsert (ItemInsertCondition, type 25)
    out.writeInt(0);
  } else {
    p.sendMessage(0, ctx.lang.t("GameServer.InlayItem.Msg1"));
    out.writeByte(1);
  }
  p.send(out);
  if (ib === p.equipBag && item.Place < 31) p.updatePlayerProperties();
}

/** ItemEmbedBackOutHandler.cs (125): remove a gem from Store[0] for 500 Money; gem returns bound. */
export async function embedBackout(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  const hole = pkt.readInt();
  const templateId = pkt.readInt();
  const must = 500;
  if (bagLocked(ctx, p)) return;
  const warrior = isWarrior(p);
  if (p.info.Money + p.info.MoneyLock < must && !warrior) return p.sendMessage(3, ctx.lang.t("ItemComposeHandler.NoMoney"));
  if (p.propBag.getEmptyCount() <= 0) return p.sendMessage(0, ctx.lang.t("UserChangeItemPlaceHandler.full"));
  const item = p.storeBag.getItemAt(0);
  const goods = ctx.templates.findItem(templateId);
  if (!item || !goods || !(hole >= 1 && hole <= 6)) return;
  const key = `Hole${hole}` as "Hole1";
  const out = new GSPacket(125, p.id);
  if (item[key] > 0 && item[key] === goods.TemplateID) {
    item[key] = 0;
    out.writeInt(0);
    p.beginChanges();
    const gem = ItemInfo.createFromTemplate(goods, 1, 102, ctx.now());
    gem.IsBinds = true;
    gem.ValidDate = 0;
    const mail: ItemInfo[] = [];
    if (!p.propBag.addTemplate(gem, 1)) mail.push(gem);
    p.storeBag.updateItem(item);
    if (!warrior) p.removeMoney(must);
    p.commitChanges();
    if (mail.length) await mailItems(ctx, p, mail);
    await clearStoreBag(ctx, p);
    p.sendMessage(0, ctx.lang.t("OK"));
  } else out.writeInt(1);
  p.send(out);
}

/**
 * OpenFiveSixHoleHandler.cs (217): drill (PropBag item whose own TemplateID is the right tier for the hole's
 * current level) spent on the StoreBag[slot] equip's hole 5 or 6, Property7..8 random exp; a 100 ms cooldown per
 * player (LastOpenHole) matches the throttle, not an anti-cheat.
 */
function holeLevelUpExp(ctx: ServerContext): number[] | null {
  // GameProperties' default applies only when the setting is absent; the real seed's fifth tier is 1200.
  const configured = ctx.templates.serverConfig.get("HoleLevelUpExpList");
  const setting = configured === undefined ? "400|600|700|800|800" : configured;
  if (typeof setting !== "string") return null;
  const values = setting.split("|").map(value => value.trim());
  if (values.length !== 5 || values.some(value => !/^\+?\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 2_147_483_647)) return null;
  return values.map(Number);
}
export async function openFiveSixHole(ctx: ServerContext, p: GamePlayer, pkt: GSPacket, rnd = Math.random): Promise<void> {
  const reject = (message = "开孔请求或物品状态无效，请刷新后重试。") => p.sendMessage(0, message);
  // Parsed packets have zero-filled backing storage: require the actual three-int body, not padded overreads.
  if (pkt.length - pkt.offset !== 12) return reject();
  const slot = pkt.readInt();
  const hole = pkt.readInt(); // 5 or 6
  const drillTemplateId = pkt.readInt();
  const reply = (leveledUp: boolean) => {
    const out = new GSPacket(217, p.id); out.writeByte(0); out.writeBoolean(leveledUp); out.writeInt(hole); p.send(out);
  };
  return p.withPersistenceLock(async () => {
    const now = ctx.now(), time = now.getTime();
    if (!Number.isFinite(time)) return reject();
    if (p.lastOpenHole + 100 > time) return reject("操作过于频繁，请稍后重试。");
    p.lastOpenHole = time;
    if (p.currentRoom?.IsPlaying) return reject("战斗中不能开孔。");
    if (bagLocked(ctx, p)) return;
    const itemBag = p.storeBag, drillBag = p.propBag;
    const item = itemBag.getItemAt(slot), drill = drillBag.getItemByTemplateID(0, drillTemplateId);
    if ((hole !== 5 && hole !== 6) || !item || !drill || item === drill || !itemBag.saveToDb || !drillBag.saveToDb ||
        !item.IsExist || !drill.IsExist || !Number.isSafeInteger(item.Count) || item.Count < 1 || item.Count > 2_147_483_647 || !Number.isSafeInteger(drill.Count) || drill.Count < 1 || drill.Count > 2_147_483_647 ||
        item.UserID !== p.id || drill.UserID !== p.id || item.Place !== slot || item.BagType !== itemBag.bagType ||
        drill.BagType !== drillBag.bagType || drillBag.getItemAt(drill.Place) !== drill || drill.TemplateID !== drillTemplateId ||
        item.cellLocked || drill.cellLocked || ![7, 1, 5].includes(item.template.CategoryID) || !item.isValidItem(now) || !drill.isValidItem(now)) return reject();
    const lvKey = hole === 6 ? "Hole6Level" : "Hole5Level";
    const expKey = hole === 6 ? "Hole6Exp" : "Hole5Exp";
    const holeKey = hole === 6 ? "Hole6" : "Hole5";
    if (!Number.isInteger(item[lvKey]) || item[lvKey] < 0 || item[lvKey] > 4 || !Number.isInteger(item[expKey]) || item[expKey] < 0 || item[expKey] > 2_147_483_647 ||
        !Number.isInteger(item[holeKey]) || item[holeKey] < -2_147_483_648 || item[holeKey] > 2_147_483_647) return reject();
    if (!drill.isDrill(item[lvKey])) { reject("钻头等级与当前宝珠孔等级不匹配。"); return reply(false); }
    const thresholds = holeLevelUpExp(ctx), min = drill.template.Property7, max = drill.template.Property8;
    if (!thresholds || !Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > 2_147_483_647) return reject("开孔经验配置无效，请保留物品并检查配置。");
    let sample: number;
    try { sample = rnd(); } catch (error) {
      ctx.log.error("OpenHole random failed", error);
      return reject("开孔随机结果无效，请重试。");
    }
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) return reject("开孔随机结果无效，请重试。");
    const experience = item[expKey] + Math.floor(min + sample * (max - min)); // C# Random.Next(min,max), upper bound excluded.
    if (!Number.isSafeInteger(experience) || experience > 2_147_483_647) return reject();
    const stagedItem = item.clone(), stagedDrill = drill.clone();
    stagedItem.ItemID = item.ItemID; stagedDrill.ItemID = drill.ItemID;
    stagedItem[expKey] = experience;
    const leveledUp = experience >= thresholds[item[lvKey]]!;
    if (leveledUp) {
      stagedItem[lvKey]++; stagedItem[expKey] = 0;
      if (stagedItem[holeKey] < 0) stagedItem[holeKey] = 0;
    }
    // Original handler computes a local isBinds but never assigns it; keep both actual binding flags unchanged.
    if (stagedDrill.Count > 1) stagedDrill.Count--;
    else {
      stagedDrill.IsExist = false; stagedDrill.Place = -1; stagedDrill.BagType = -1;
      stagedDrill.RemoveType = 0; stagedDrill.RemoveDate = now;
    }
    try {
      await ctx.db.db.transaction(async tx => {
        await saveItem(tx as unknown as Database, stagedItem);
        await saveItem(tx as unknown as Database, stagedDrill);
      });
    } catch (error) {
      ctx.log.error("OpenHole transaction failed", error);
      return reject("开孔保存失败，装备和钻头未改变，请稍后重试。");
    }
    const bags = [itemBag, drillBag]; bags.forEach(bag => bag.beginChanges());
    try {
      item.ItemID = stagedItem.ItemID; drill.ItemID = stagedDrill.ItemID;
      if (!drillBag.removeCountFromStack(drill, 1)) throw new Error("OpenHole inventory changed after commit");
      if (!drill.IsExist) drill.RemoveDate = now;
      item[lvKey] = stagedItem[lvKey]; item[expKey] = stagedItem[expKey]; item[holeKey] = stagedItem[holeKey];
      itemBag.updateItem(item);
    } finally {
      // A disconnected first sink must not leave the second bag's change batch open after SQL already committed.
      const errors: unknown[] = [];
      for (const bag of bags) { try { bag.commitChanges(); } catch (error) { errors.push(error); } }
      if (errors.length) throw errors[0];
    }
    reply(leveledUp);
  });
}

/**
 * ItemTrendHandle.cs (120 ITEM_TREND): converts an owned equip between "trend" (tendency) variants listed in the
 * Item_Refinery reward chain, or buys the training device (item 34101) outright when `num === -1`. The game's
 * `Item_Refinery` table has 0 rows in the source .bak (never configured on this server, in the original too), so
 * this is live code that is currently always a no-op (RefineryMgr.RefineryTrend never finds a match) — same
 * observable behaviour as the original with an empty config.
 */
export async function itemTrend(ctx: ServerContext, p: GamePlayer, pkt: GSPacket): Promise<void> {
  const bagType = pkt.readInt();
  const place = pkt.readInt();
  const bagType2 = pkt.readInt();
  const num = pkt.readInt();
  const operation = pkt.readInt();
  let catalyst: ItemInfo | null = null;
  if (num === -1) {
    pkt.readInt(); pkt.readInt(); // unused ints (gold/display, the original never prices this branch either)
    const tpl = ctx.templates.findItem(34101);
    if (!tpl) return;
    catalyst = ItemInfo.createFromTemplate(tpl, 1, 102, ctx.now());
    const shop = ctx.templates.shopByTemplate(34101).find((s) => s.APrice1 === -1 && s.AValue1 !== 0);
    const money = shop?.AValue1 ?? 0;
    if (!(money <= p.info.Money + p.info.MoneyLock)) return;
    p.removeMoney(money);
    catalyst.ValidDate = shop?.AUnit ?? 0;
  } else {
    catalyst = p.getInventory(bagType2)?.getItemAt(num) ?? null;
  }
  const item = p.getInventory(bagType)?.getItemAt(place);
  if (!catalyst || !item) return;
  const newTemplateId = ctx.templates.refineryTrend(operation, item.TemplateID);
  const newTpl = newTemplateId != null ? ctx.templates.findItem(newTemplateId) : undefined;
  if (newTpl) {
    const res = ItemInfo.createFromTemplate(newTpl, 1, 115, ctx.now());
    const inv = p.getItemInventory(newTpl);
    if (inv?.addItem(res, inv.beginSlot)) {
      inv.updateItem(res);
      p.getInventory(bagType)?.removeItem(item);
      catalyst.Count--;
      if (num !== -1) p.getInventory(bagType2)?.updateItem(catalyst); // num === -1: a virtual, never-stored catalyst
      p.sendMessage(0, ctx.lang.t("ItemTrendHandle.Success"));
    } else {
      p.sendMessage(0, ctx.lang.t("ItemFusionHandler.NoPlace"));
    }
    return;
  }
  p.sendMessage(0, ctx.lang.t("ItemTrendHandle.Fail"));
}

/** WishBeadEquipHandler.cs: six ints, one bead per attempt, result106/int (0 success, 1 roll failed, 5 invalid, 6 already gold). */
export async function wishBead(ctx: ServerContext, p: GamePlayer, pkt: GSPacket, rnd = Math.random): Promise<void> {
  const reply = (result: number) => { const out = new GSPacket(106, p.id); out.writeInt(result); p.send(out); };
  // GSPacket.parse zero-pads its backing buffer: validate the actual body before reading six int32 fields.
  if (pkt.length - pkt.offset !== 24) return reply(5);
  const place = pkt.readInt(), bagType = pkt.readInt(), templateId = pkt.readInt();
  const beadPlace = pkt.readInt(), beadBagType = pkt.readInt(), beadId = pkt.readInt();
  return p.withPersistenceLock(async () => {
    if (p.currentRoom?.IsPlaying) return reply(5);
    if (bagLocked(ctx, p)) return reply(5);
    const itemBag = p.getInventory(bagType), beadBag = p.getInventory(beadBagType);
    const item = itemBag?.getItemAt(place), bead = beadBag?.getItemAt(beadPlace);
    const now = ctx.now();
    if (!itemBag || !beadBag || !itemBag.saveToDb || !beadBag.saveToDb || !item || !bead || item === bead || !item.IsExist || !bead.IsExist || item.Count < 1 || bead.Count < 1 ||
        item.BagType !== itemBag.bagType || bead.BagType !== beadBag.bagType || item.Place !== place || bead.Place !== beadPlace ||
        item.cellLocked || bead.cellLocked || (item.TemplateID !== templateId && item.displayTemplateId(now) !== templateId) ||
        bead.TemplateID !== beadId || !item.isValidItem(now) || !bead.isValidItem(now)) return reply(5);
    const category = item.template.CategoryID;
    if (!((bead.TemplateID === 11560 && category === 7) || (bead.TemplateID === 11561 && category === 5) || (bead.TemplateID === 11562 && category === 1))) return reply(5);
    // The single-argument original GoldEquip lookup is exact; its category fallback belongs to the stats owner.
    const row = ctx.templates.stats.goldEquip(item.TemplateID, category);
    const goldTemplate = category === 7 && row?.OldTemplateId === item.TemplateID ? ctx.templates.findItem(row.NewTemplateId) : null;
    if (category === 7 && (!goldTemplate || goldTemplate.CategoryID !== 7 || goldTemplate.TemplateID <= 0 || goldTemplate.TemplateID === item.TemplateID)) return reply(5);
    const limited = ctx.templates.serverConfig.get("IsWishBeadLimit")?.trim().toLowerCase() === "true";
    if (limited && item.StrengthenLevel > ctx.templates.cfgInt("WishBeadLimitLv", 12)) return reply(5);
    if (item.isValidGoldItem(now)) return reply(6);
    const probability = ctx.zoneId === 1001 ? 50 : ctx.zoneId === 1002 ? 40 : 8;
    const success = probability > Math.floor(rnd() * 1000); // Original denominator1000; WishBeadRate is not used here.
    // saveItem mutates ItemID/dirty state: save detached instances so SQL/COMMIT failure cannot leak inventory changes.
    const stagedItem = item.clone(), stagedBead = bead.clone();
    stagedItem.ItemID = item.ItemID; stagedBead.ItemID = bead.ItemID;
    stagedItem.IsBinds = true;
    if (success) {
      stagedItem.isGold = true; stagedItem.goldBeginTime = now; stagedItem.goldValidDate = 3; stagedItem.goldTemplate = goldTemplate ?? null;
    }
    if (stagedBead.Count > 1) stagedBead.Count--;
    else {
      stagedBead.IsExist = false; stagedBead.Place = -1; stagedBead.BagType = -1;
      stagedBead.RemoveType = 0; stagedBead.RemoveDate = now;
    }
    try {
      await ctx.db.db.transaction(async tx => {
        await saveItem(tx as unknown as Database, stagedItem);
        await saveItem(tx as unknown as Database, stagedBead);
      });
    } catch (error) {
      ctx.log.error("WishBead transaction failed", error);
      return reply(5);
    }
    // Nothing is published before COMMIT; a later sink failure must not roll back an already committed attempt.
    const bags = [...new Set([itemBag, beadBag])];
    bags.forEach(bag => bag.beginChanges());
    try {
      item.ItemID = stagedItem.ItemID; bead.ItemID = stagedBead.ItemID;
      if (!beadBag.removeCountFromStack(bead, 1)) throw new Error("WishBead inventory changed after commit");
      if (!bead.IsExist) bead.RemoveDate = now;
      item.IsBinds = true;
      if (success) {
        item.isGold = true; item.goldBeginTime = now; item.goldValidDate = 3; item.goldTemplate = goldTemplate ?? null;
      }
      itemBag.updateItem(item);
    } finally {
      const errors: unknown[] = [];
      for (const bag of bags) { try { bag.commitChanges(); } catch (error) { errors.push(error); } }
      if (errors.length) throw errors[0];
    }
    reply(success ? 0 : 1);
  });
}

export function registerForge(r: HandlerRegistry): void {
  r.player(59, "ITEM_STRENGTHEN", (ctx, p, pkt) => strengthen(ctx, p, pkt), "partial");
  r.player(58, "ITEM_COMPOSE", (ctx, p, pkt) => compose(ctx, p, pkt), "partial");
  r.player(78, "ITEM_FUSION", (ctx, p, pkt) => fusion(ctx, p, pkt));
  r.player(121, "ITEM_INLAY", (ctx, p, pkt) => inlay(ctx, p, pkt));
  r.player(125, "ITEM_EMBED_BACKOUT", (ctx, p, pkt) => embedBackout(ctx, p, pkt));
  r.player(122, "CLEAR_STORE_BAG", (ctx, p) => clearStoreBag(ctx, p));
  r.player(217, "OPEN_FIVE_SIX_HOLE", (ctx, p, pkt) => openFiveSixHole(ctx, p, pkt));
  r.player(120, "ITEM_TREND", (ctx, p, pkt) => itemTrend(ctx, p, pkt));
  r.player(106, "WISHBEADEQUIP", (ctx, p, pkt) => wishBead(ctx, p, pkt));
  // Confirmed dead in the original vendor/DDTank41 (no [PacketHandler] class anywhere carries these codes — a
  // later-client (6600+) feature set never wired into the 4.1 server): 61 ITEM_TRANSFER, 95 NECKLACE_STRENGTH,
  // 133 LATENT_ENERGY, 138 ITEM_ADVANCE, 209 FIGHT_SPIRIT, 295 STORE_FINE_SUIT, 391 EQUIP_GHOST.
  for (const [code, name] of [[61, "ITEM_TRANSFER"], [95, "NECKLACE_STRENGTH"], [133, "LATENT_ENERGY"],
    [138, "ITEM_ADVANCE"], [209, "FIGHT_SPIRIT"], [295, "STORE_FINE_SUIT"], [391, "EQUIP_GHOST"]] as [number, string][]) {
    r.player(code, name, () => undefined, "stub");
  }
}
