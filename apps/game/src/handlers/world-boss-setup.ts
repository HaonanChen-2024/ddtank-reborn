import type { GSPacket } from "@ddt/protocol";

export interface WorldBossSetup {
  mapId: number; roomType: number; password: string; name: string; timeMode: number;
  hardLevel: number; levelLimits: number; isCrosszone: boolean; isOpenBoss: boolean;
}

/** Same-client writers: enterUserGuide (A), sendGameRoomSetUp with final param10:int (B),
 * plus the existing TS form without that final int (C). Never read the 8192-byte zero padding. */
export function parseWorldBossSetup(pkt: GSPacket): WorldBossSetup | null {
  const bytes = pkt.buffer.subarray(pkt.offset, pkt.length);
  const results: WorldBossSetup[] = [];
  for (const [hasBoss, hasTail] of [[false, false], [true, true], [true, false]]) {
    let pos = 0;
    const need = (n: number) => { if (pos + n > bytes.length) throw new Error("truncated setup"); };
    const byte = () => { need(1); return bytes[pos++]!; };
    const bool = () => { const n = byte(); if (n > 1) throw new Error("invalid boolean"); return n === 1; };
    const int = () => { need(4); const n = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getInt32(0); pos += 4; return n; };
    const utf = () => { const n = (byte() << 8) | byte(); need(n); const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(pos, pos + n)).replaceAll("\0", ""); pos += n; return value; };
    try {
      const mapId = int(), roomType = byte(), isOpenBoss = hasBoss ? bool() : false;
      const password = utf(), name = utf(), timeMode = byte(), hardLevel = byte(), levelLimits = int(), isCrosszone = bool();
      if (hasTail) int(); // Known original param10, not used to authorize a boss fight.
      if (roomType !== 14 || pos !== bytes.length) continue;
      results.push({ mapId, roomType, isOpenBoss, password, name, timeMode, hardLevel, levelLimits, isCrosszone });
    } catch { /* A known layout must fit in its entirety before any room mutation. */ }
  }
  if (results.length !== 1) return null;
  pkt.offset = pkt.length;
  return results[0]!;
}
