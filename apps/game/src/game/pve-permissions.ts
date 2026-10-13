/** GamePlayer.InitPvePermission / LoadPvePermission / SetPvePermission (GamePlayer.cs:2825,3297,5009). */
export function loadPvePermission(
  permission: string | null,
  grade: number,
  dungeons: Iterable<{ ID: number; LevelLimits: number | null }>,
): string | null {
  const chars = (permission || "1".repeat(50)).split("");
  let result = permission;
  for (const dungeon of dungeons) {
    // The original table reader requires an int; a missing threshold cannot grant access.
    if (dungeon.LevelLimits == null || grade <= dungeon.LevelLimits || dungeon.ID <= 0 || dungeon.ID > chars.length) continue;
    // Original Easy-first copies; all other copies initially grant Normal.
    const easy = dungeon.ID === 1 || dungeon.ID === 2 || dungeon.ID === 7 || dungeon.ID === 12 || dungeon.ID === 13;
    if (chars[dungeon.ID - 1] !== "1") continue;
    chars[dungeon.ID - 1] = easy ? "1" : "3";
    // The original serializes only after a qualifying SetPvePermission succeeds,
    // including Easy '1' -> '1'. Preserve null/empty when no copy qualifies.
    result = chars.join("");
  }
  return result;
}

/** Whole Dungeon completion: PVEGame.Stop (:2104), GamePlayer.SetPvePermission (:5009).
 * Called only for PVE_STOPPED; never for a per-mission result or an ordinary exit. */
export function unlockDungeonPvePermission(
  permission: string | null,
  dungeon: { ID: number; Type: number },
  result: { roomType: number; isWin: boolean; hasNextMission: boolean; hardLevel: number },
): string | null {
  // eRoomType.Dungeon = 4; a resolved non-Dungeon table row cannot grant a Dungeon permission.
  if (result.roomType !== 4 || dungeon.Type !== 4 || result.isWin !== true || result.hasNextMission !== false) return permission;
  const { ID } = dungeon;
  const { hardLevel } = result;
  // Terror's next level is Epic, which the original SetPvePermission explicitly rejects.
  if (!permission || !Number.isInteger(ID) || ID <= 0 || ID > permission.length ||
      !Number.isInteger(hardLevel) || hardLevel < 0 || hardLevel > 2) return permission;
  const levels = "137F";
  // Advance exactly one adjacent tier; retain higher/unknown values and every other copy unchanged.
  if (permission[ID - 1] !== levels[hardLevel]) return permission;
  return permission.slice(0, ID - 1) + levels[hardLevel + 1] + permission.slice(ID);
}
