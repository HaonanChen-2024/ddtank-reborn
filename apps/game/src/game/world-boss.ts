import type { World } from "../session/context.js";

/** Serialize offline award commit against the login snapshot for this user.
 * Never hold this admission gate while awaiting an existing client's queue or
 * quit: an online result is returned to the caller before it takes those locks. */
const admission = new WeakMap<World, Map<number, Promise<void>>>();
export async function withWorldBossAdmission<T>(world: World, id: number, work: () => Promise<T>): Promise<T> {
  let users = admission.get(world);
  if (!users) admission.set(world, (users = new Map()));
  const result = (users.get(id) ?? Promise.resolve()).then(work);
  const tail = result.then(() => {}, () => {}); users.set(id, tail);
  try { return await result; } finally { if (users.get(id) === tail) users.delete(id); }
}

/** Server-owned identity captured when a world-boss fight starts, never from a packet. */
export interface WorldBossAttempt {
  windowKey: string;
  fightId: number;
}

export interface WorldBossRank { id: number; nick: string; damage: number }

/** Entering the lobby is not participation damage. Keep ties stable across retries. */
export function worldBossRanks(rank: Map<number, { nick: string; damage: number }>): WorldBossRank[] {
  return [...rank].filter(([, r]) => Number.isSafeInteger(r.damage) && r.damage > 0)
    .map(([id, r]) => ({ id, nick: r.nick, damage: r.damage }))
    .sort((a, b) => b.damage - a.damage || a.id - b.id);
}
