import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import { activityAction, activitySnapshot } from "../activities/service.js";
import { ActivityError } from "../activities/types.js";
import { requireUser, userOf } from "./auth.js";

const characterId = z.number().int().positive().max(2147483647);
const action = z.object({
  type: z.string().min(1).max(64), index: z.number().int().nonnegative().optional(),
  choice: z.string().max(64).optional(), tier: z.number().int().nonnegative().optional(),
  count: z.number().int().positive().max(1000).optional(), marked: z.boolean().optional(),
  items: z.array(z.object({ index: z.number().int().min(0).max(3), count: z.number().int().min(1).max(60) }).strict()).min(1).max(4).optional(),
  mode: z.enum(["normal", "advanced"]).optional(),
  selection: z.array(z.number().int().min(1).max(14)).max(4).optional(),
  poolVersion: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  funding: z.literal("tickets").optional(),
  cardId: z.string().uuid().optional(), recipientName: z.string().min(1).max(64).optional(),
}).strict();
const command = z.object({ characterId, requestId: z.string().uuid().transform((s) => s.toLowerCase()), action }).strict();

function failure(reply: FastifyReply, err: unknown) {
  if (err instanceof ActivityError) return reply.code(err.statusCode).send({ message: err.message });
  // DB errors can include SQL parameters containing server-private boards. Do not return them.
  return reply.code(500).send({ message: "活动操作暂时失败，请使用同一请求编号重试。" });
}

export async function activityRoutes(f: FastifyInstance, ctx: AppCtx): Promise<void> {
  f.get("/api/account/activities", { preHandler: requireUser(ctx) }, async (req, reply) => {
    const query = z.object({ characterId: z.coerce.number().pipe(characterId) }).strict().safeParse(req.query);
    if (!query.success) return reply.code(400).send({ message: "请指定有效的角色编号。" });
    try { return await activitySnapshot(ctx, userOf(req), query.data.characterId); } catch (err) { return failure(reply, err); }
  });
  f.post("/api/account/activities/:activityId/action", { preHandler: requireUser(ctx) }, async (req, reply) => {
    const body = command.safeParse(req.body);
    const params = z.object({ activityId: z.string().min(1).max(32) }).safeParse(req.params);
    if (!body.success || !params.success || body.data.action.items !== undefined && params.data.activityId !== "moonlight-native"
      || body.data.action.mode !== undefined && !["treasure", "treasure-native"].includes(params.data.activityId)
      || body.data.action.funding !== undefined && !["treasure", "treasure-native"].includes(params.data.activityId)
      || (body.data.action.cardId !== undefined || body.data.action.recipientName !== undefined) && params.data.activityId !== "first-recharge-native") return reply.code(400).send({ message: "活动操作参数或请求编号无效。" });
    try { return await activityAction(ctx, userOf(req), body.data.characterId, params.data.activityId, body.data.requestId, body.data.action); } catch (err) { return failure(reply, err); }
  });
}
