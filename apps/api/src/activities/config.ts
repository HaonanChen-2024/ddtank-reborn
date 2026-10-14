/** Explicit local rules. Reference client proves mechanics, not server prices/probabilities. */
export const ACTIVITY_TITLES: Record<string, string> = {
  treasure: "迷宫寻宝", mines: "弹弹扫雷", gypsy: "吉普赛商人", pair: "欧皇秘宝",
  exchange: "兑换活动", wardrobe: "魔法衣橱", moon: "月光宝盒", sign: "签到",
  "points-gift": "活动积分礼", wheel: "啵咕大转盘", carnival: "节日狂欢", ddplay: "弹弹乐",
  "first-gift": "新手任务礼", luxury: "至尊豪礼", devil: "恶魔宝藏", christmas: "快乐圣诞", cave: "矿洞寻宝",
};
export const PRIZES = [
  { templateId: 11019, name: "强化石1级", count: 1, weight: 55 },
  { templateId: 11001, name: "朱雀石1级", count: 1, weight: 25 },
  { templateId: 11021, name: "强化石2级", count: 1, weight: 15 },
  { templateId: 11002, name: "朱雀石2级", count: 1, weight: 5 },
] as const;
export const LOCAL_RULES = {
  maxDailyActions: 500, bagCapacity: 30, maxBoardRounds: 3,
  treasureCost: 30, moonCost: 20, caveCost: 15, caveAdvancedCost: 35,
  caveDailyFree: 3, cavePity: 10, moonPity: 10,
  pointsGift: [100, 300, 600], luxuryGift: [200, 500, 1000],
  shop: [{ templateId: 11019, count: 3, price: 15 }, { templateId: 11001, count: 3, price: 20 }, { templateId: 11021, count: 1, price: 25 }, { templateId: 11002, count: 1, price: 30 }],
} as const;
