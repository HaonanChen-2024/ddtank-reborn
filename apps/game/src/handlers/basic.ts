/** Session & lobby infrastructure handlers (01-packet-handlers §1, §2). */
import { GSPacket } from "@ddt/protocol";
import { forbidPlayer } from "../db/characters.js";
import * as Out from "../packets/out.js";
import { handleLogin } from "../session/login.js";
import type { ServerContext } from "../session/context.js";
import type { GamePlayer } from "../game/player.js";
import { unixSeconds } from "../util/time.js";
import type { HandlerRegistry } from "./registry.js";

/** baoltfunction.CheckSpeedHack (Packets/Client/baoltfunction.cs:28). */
export async function checkSpeedHack(ctx: ServerContext, p: GamePlayer): Promise<void> {
  const cfg = ctx.cfg;
  const now = unixSeconds(ctx.now());
  if (cfg.SPEED_CHECK_ENABLED && now - p.timeCheckHack < cfg.SPEED_CHECK_INTERVAL_MIN * 60 - cfg.SPEED_CHECK_TOLERANCE_SEC) {
    ctx.log.warn(`speed hack detected: ${p.info.UserName}`);
    p.sendMessage(0, `因使用时间加速器，你已被封禁${cfg.SPEED_CHECK_BAN_MIN}分钟！`);
    await p.saveIntoDatabase(ctx.db.db);
    await forbidPlayer(ctx.db.db, p.id, new Date(ctx.now().getTime() + cfg.SPEED_CHECK_BAN_MIN * 60_000), true, "Hack speed");
    p.sink.disconnect("speed hack");
    return;
  }
  p.timeCheckHack = now;
  const pkt = new GSPacket(300);
  pkt.writeInt(0);
  p.send(pkt);
}

/** GamePlayer.SaveIntoDatabase watchdog: no 300 heartbeat for SPEED_CHECK_MISSING_MIN -> ban (GamePlayer.cs:4491). */
export async function checkMissingHeartbeat(ctx: ServerContext, p: GamePlayer): Promise<boolean> {
  const cfg = ctx.cfg;
  if (!cfg.SPEED_CHECK_ENABLED) return false;
  if (unixSeconds(ctx.now()) - p.timeCheckHack > cfg.SPEED_CHECK_MISSING_MIN * 60 - 10) {
    await forbidPlayer(ctx.db.db, p.id, new Date(ctx.now().getTime() + cfg.SPEED_CHECK_MISSING_BAN_MIN * 60_000), true, "绕过速度检测");
    p.sink.disconnect("missing speed heartbeat");
    return true;
  }
  return false;
}

export function registerBasic(r: HandlerRegistry): void {
  r.register({ code: 1, name: "LOGIN", preLogin: true, status: "implemented", handle: (ctx, c) => handleLogin(ctx, c) });
  // 4 PING: PingTimeCallBackHandler — PingTime = now - PingStart.
  r.register({
    code: 4, name: "PING", preLogin: true, status: "implemented",
    handle: (_ctx, c) => {
      if (c.player) c.player.pingTime = Date.now() - c.player.pingStart;
    },
  });
  // 5 SYS_DATE: SyncSystemDateHandler — echoes the server time.
  r.player(5, "SYS_DATE", (ctx, p) => p.send(Out.dateTime(ctx.now())));
  // 8 CLIENT_LOG: logged only.
  r.player(8, "CLIENT_LOG", (ctx, p, pkt) => ctx.log.debug(`client log ${p.id}: ${pkt.readString().slice(0, 500)}`));
  // 172 SAVE_DB: client-triggered save (throttled to once per 30 s; the C# had no throttle).
  const lastSave = new WeakMap<GamePlayer, number>();
  r.player(172, "SAVE_DB", async (ctx, p) => {
    const t = Date.now();
    if (t - (lastSave.get(p) ?? 0) < 30_000) return;
    lastSave.set(p, t);
    await p.saveIntoDatabase(ctx.db.db);
  });
  // 300 speed-hack heartbeat (client CheckSpeedManager.as, every 5 min).
  r.player(300, "BAOLTFUNCTION", async (ctx, p, pkt) => {
    if (pkt.readInt() === 0) await checkSpeedHack(ctx, p);
  });
  // 225 ENTHRALL_SWITCH echo.
  r.player(225, "ENTHRALL_SWITCH", (_ctx, p) => p.send(new GSPacket(225)));
  // 16 SCENE_LOGIN: UserEnterSceneHandler (hall 1 -> Manual, 2 -> Away), enter the waiting room.
  r.player(16, "SCENE_LOGIN", (ctx, p, pkt) => {
    const hall = pkt.readInt();
    if (hall === 1) p.playerState = 1;
    else if (hall === 2) p.playerState = 2;
    p.updateProperties();
    ctx.rooms.enterWaitingRoom(p);
  });
  // 21 SCENE_REMOVE_USER: UserLeaveSceneHandler.
  r.player(21, "SCENE_REMOVE_USER", (ctx, p) => {
    p.playerState = 1;
    ctx.rooms.exitWaitingRoom(p);
  });
  // 69 SCENE_USERS_LIST: SceneUsersListHandler (page, pageSize; wraps modulo).
  r.player(69, "SCENE_USERS_LIST", (ctx, p, pkt) => {
    const page = pkt.readByte();
    const size = pkt.readByte();
    const all = ctx.world.allNoGame();
    const n = all.length;
    const count = Math.min(n, size);
    const out = new GSPacket(69, p.id);
    out.writeByte(count);
    for (let i = page * size; i < page * size + count; i++) {
      const c = all[i % n]!.info;
      out.writeInt(c.ID); out.writeString(c.NickName ?? ""); out.writeByte(c.typeVIP); out.writeInt(c.VIPLevel); out.writeBoolean(c.Sex);
      out.writeInt(c.Grade); out.writeInt(c.ConsortiaID); out.writeString(c.ConsortiaName ?? ""); out.writeInt(c.Offer); out.writeInt(c.Win);
      out.writeInt(c.Total); out.writeInt(c.Escape); out.writeInt(c.Repute); out.writeInt(c.FightPower);
    }
    p.send(out);
  });
  // Obsolete no-ops in the original (01 §1).
  for (const [code, name] of [[35, "AC_ACTION"], [64, "OPTION_UPDATE"], [24, "SCENE_CHANNEL_CHANGE"], [161, "USER_LUCKYNUM"], [206, "CHANGE_COLOR_OVER_DUE"], [245, "CADDY_GET_AWARDS"], [279, "SHOW_HIDE_TITLE"], [30, "LOTTERY_GET_ITEM"], [213, "USE_LOG"]] as const) {
    r.player(code, name, () => {});
  }
}
