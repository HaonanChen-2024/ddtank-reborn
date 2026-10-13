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
