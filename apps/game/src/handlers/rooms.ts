/**
 * Sala (lobby de partida) — por que existe: jogador cria/entra em sala antes da luta começar.
 *
 * Contrapartida C#: `RoomMgr.cs`, `GameRoom`, `GameRoom/Handle/*.cs` em `vendor/DDTank41/Game.Server/Rooms`.
 * Pacotes: lê `94 GAME_ROOM` (sub `int` + corpo), responde `roomList` / mensagens; `91 GAME_CMD`, `70 GAME_INVITE`, `82 GAME_MISSION_START`, `86 QUEST_ONE_KEY_FINISH(start)`.
 * Exemplo concreto: cliente envia `94` sub `0` com `roomType`, `timeType`, `name`, `password` → sala criada; envia `94` sub `1` com `hall`, `sel`, `roomId`, `password` → entra na sala.
 */
import { GSPacket } from "@ddt/protocol";
import { RoomType } from "../rooms/room.js";
import { roomList } from "../packets/out.js";
import { SubRouter, type HandlerRegistry } from "./registry.js";
import { parseWorldBossSetup } from "./world-boss-setup.js";
import { christmasSnowfieldOwner } from "../game/activity-christmas-snowfield.js";
import { labyrinthCombatOwner } from "../game/labyrinth-combat.js";

/**
 * Registra rotas de sala (`94 GAME_ROOM`) — o que faz no jogo: criar/entrar/sair de sala, trocar time, dar ready, iniciar partida.
 *
 * Contrapartida C#: `RoomMgr.cs`, `GameRoom`, `EnterRoomAction` em `vendor/DDTank41/Game.Server/Rooms`.
 * Formato que lê: `94` + sub `int` (`0` cria, `1` entra, `2` troca setup, `3` expulsa, `5` sai, `6` troca time, `7` inicia, `9` lista, `10` posição, `11/12` pickup, `15` ready).
 * Exemplo concreto: `94` sub `7` com sala cheia e todos com arma → `ctx.rooms.startGame(room)` inicia luta.
 *
 * Como lê esse código (cada variável):
 * - `ctx`: contexto do servidor (contém `rooms`, `world`, `lang`). Vem do `HandlerRegistry`.
 * - `p`: jogador atual (`GamePlayer`). Vem da conexão autenticada; contém `currentRoom`, `hasMainWeapon`, `info`.
 * - `pkt`: pacote `GSPacket` recebido. Vem do cliente Flash; contém sub + corpo binário.
 * - `room`: sala atual (`p.currentRoom`). Vem de `ctx.rooms`; contém `host`, `RoomType`, `IsPlaying`.
 */
export function roomRouter(): SubRouter {
  return new SubRouter("int", "GAME_ROOM")
    // Create.cs: byte roomType, byte timeType, str name, str password. Boss access is checked in the queued action.
    .on(0, "GAME_ROOM_CREATE", (ctx, p, pkt) => {
      const start = pkt.offset;
      // Only type14 gets the narrow length guard; other modes keep their existing contract.
      if (pkt.buffer[start] === 14) {
        let at = start + 2;
        for (let i = 0; i < 2; i++) {
          if (at + 2 > pkt.length) return;
          const n = (pkt.buffer[at]! << 8) | pkt.buffer[at + 1]!;
          at += 2 + n;
          if (at > pkt.length) return;
        }
        if (at !== pkt.length) return;
      }
      const roomType = pkt.readByte();
      const timeType = pkt.readByte();
      const name = pkt.readString();
      const pwd = pkt.readString();
      if (roomType === 40) return p.sendMessage(0, "请通过本地雪场的已确认准入进入。");
      if (!p.hasMainWeapon) return p.sendMessage(1, ctx.lang.t("Game.Server.SceneGames.NoEquip"));
      ctx.rooms.createRoom(p, name, pwd, roomType, timeType);
    })
    // Login.cs: bool isInvite, int hallType, int roomSel; if roomSel == -1: int roomId, str password.
    .on(1, "GAME_ROOM_LOGIN", (ctx, p, pkt) => {
      pkt.readBoolean();
      const hall = pkt.readInt();
      const sel = pkt.readInt();
      let roomId = -1;
      let pwd = "";
      if (sel === -1) {
        roomId = pkt.readInt();
        pwd = pkt.readString();
      }
      ctx.rooms.enterRoom(p, roomId, pwd, hall);
    })
    // SetupChange.cs: int mapId, byte roomType, bool isOpenBoss, str password, str name, byte timeMode, byte hardLevel, int levelLimits, bool isCrosszone.
    .on(2, "GAME_ROOM_SETUP_CHANGE", (ctx, p, pkt) => {
      const room = p.currentRoom;
      if (!room || room.host !== p || room.IsPlaying) return;
      if (room.RoomType === 14 && pkt.dataLeft < 5) return;
      if (pkt.offset + 5 <= pkt.length && pkt.buffer[pkt.offset + 4] === 14) {
        const setup = parseWorldBossSetup(pkt);
        if (!setup) return p.sendMessage(0, "世界 BOSS 房间参数无效。");
        ctx.rooms.setupChange(room, setup);
        return;
      }
      let mapId = pkt.readInt();
      const roomType = pkt.readByte();
      if (roomType === 15 && mapId === 0) mapId = 401; // original SetupChange.cs:29-34
      // GameSocketOut.enterUserGuide (freshman / quest "go" button) writes no isOpenBoss bool (GameSocketOut.as:1400)
      const isOpenBoss = roomType === RoomType.Freshman ? false : pkt.readBoolean();
      const password = pkt.readString();
      const name = pkt.readString();
      const timeMode = pkt.readByte();
      const hardLevel = pkt.readByte();
      const levelLimits = pkt.readInt();
      const isCrosszone = pkt.readBoolean();
      if (room.RoomType === 40 || roomType === 40) {
        if (pkt.dataLeft !== 4) return p.sendMessage(0, "雪场任务尾字段无效。");
        const originalMissionId = pkt.readInt();
        const setup = { mapId, roomType, password, name, timeMode, hardLevel, levelLimits, isCrosszone, isOpenBoss, originalMissionId };
        const permit = christmasSnowfieldOwner(ctx).checkRoom(room, room.getPlayers(), setup);
        if (!permit.ok) return p.sendMessage(0, permit.message);
        ctx.rooms.setupChange(room, setup); return;
      }
      ctx.rooms.setupChange(room, { mapId, roomType, password, name, timeMode, hardLevel, levelLimits, isCrosszone, isOpenBoss });
    }, "partial")
    .on(3, "GAME_ROOM_KICK", (ctx, p, pkt) => {
      if (p.currentRoom && p.currentRoom.host === p) ctx.rooms.kickPlayer(p.currentRoom, pkt.readByte());
    })
    .on(5, "GAME_ROOM_REMOVEPLAYER", async (ctx, p, _pkt, c) => {
      if (p.currentRoom?.RoomType === 40) { await christmasSnowfieldOwner(ctx).leaveChallengeRoom(c, p); return; }
      if (p.currentRoom) ctx.rooms.exitRoom(p.currentRoom, p);
    })
    .on(6, "GAME_TEAM", (ctx, p) => {
      if (p.currentRoom && p.currentRoom.RoomType !== RoomType.Match) ctx.rooms.switchTeam(p);
    })
    // GameStart.cs: host only; every member needs a weapon (captcha / PvE permission / tickets not ported).
    .on(7, "GAME_START", async (ctx, p, _pkt, c) => {
      const room = p.currentRoom;
      if (!room || room.host !== p) return;
      for (const m of room.getPlayers()) {
        if (!m.hasMainWeapon) {
          p.sendMessage(3, ctx.lang.t("Game.Server.SceneGames.NoEquip"));
          room.IsPlaying = false;
          room.sendCancelPickUp();
          return;
        }
      }
      if (room.RoomType === 40) {
        const permit = await christmasSnowfieldOwner(ctx).prepareStart(c, p, room);
        if (!permit.ok || p.currentRoom !== room) { if (!permit.ok) p.sendMessage(0, permit.message); return; }
      }
      if (room.RoomType === 15 && !(await labyrinthCombatOwner(ctx).prepareStart(p, room))) return;
      ctx.rooms.startGame(room);
    }, "partial")
    .on(9, "ROOMLIST_UPDATE", (ctx, p, pkt) => {
      const hall = pkt.readInt();
      const b = pkt.readInt();
      if (hall === 2 && b === -2) {
        pkt.readInt();
        pkt.readInt();
      }
      p.send(roomList(hall === 1 ? ctx.rooms.getAllMatchRooms() : hall === 2 ? ctx.rooms.getAllPveRooms() : []));
    })
    // UpdatePlaces.cs: byte pos, int place, bool isOpened, int placeView.
    .on(10, "GAME_ROOM_UPDATE_PLACE", (ctx, p, pkt) => {
      const room = p.currentRoom;
      if (!room) return;
      const pos = pkt.readByte();
      const place = pkt.readInt();
      const opened = pkt.readBoolean();
      const view = pkt.readInt();
      if (room.host === p) {
        if (room.RoomType !== RoomType.Freedom && pos >= 8) return;
        ctx.rooms.updateRoomPos(room, pos, opened, place, view);
      }
      // Non-host viewer switching (SwitchToView) not ported.
    }, "partial")
    .on(11, "GAME_PICKUP_CANCEL", (ctx, p) => ctx.rooms.cancelPickup(p))
    .on(12, "GAME_PICKUP_STYLE", (ctx, p, pkt) => {
      const style = pkt.readInt();
      const room = p.currentRoom;
      if (!room || room.RoomType !== RoomType.Match || room.host !== p) return;
      room.GameType = style === 1 ? 1 : 0;
      const out = new GSPacket(94);
      out.writeByte(12);
      out.writeByte(room.GameType);
      room.sendToAll(out);
    }, "partial")
    // GamePlayerStateChange.cs: byte state (0 not ready, 1 ready); needs a weapon.
    .on(15, "GAME_PLAYER_STATE_CHANGE", (ctx, p, pkt) => {
      if (!p.hasMainWeapon) return p.sendMessage(0, ctx.lang.t("Game.Server.SceneGames.NoEquip"));
      if (p.currentRoom) ctx.rooms.updatePlayerState(p, pkt.readByte());
    });
}


/**
 * Registra handlers de sala no servidor — o que faz no jogo: liga `94 GAME_ROOM`, `91 GAME_CMD`, `70 GAME_INVITE`, `82 GAME_MISSION_START`, `86` ao `world`.
 *
 * Contrapartida C#: `RoomMgr.cs`, `GameRoom`, `EnterRoomAction` em `vendor/DDTank41/Game.Server/Rooms`; `82` espelha `GameUserStartHandler.cs` (`RoomMgr.StartGameMission` → `game.MissionStart(host)`).
 * Formato que lê/responde: lê `91` (repassa para `game.processData` ou responde sub `98` falso) e `70` (convite com `RoomId`, `MapId`, `Name`, `Password`); responde `91`, `70`, `roomList`.
 * Exemplo concreto: jogador sem partida envia `91` sub `98` → recebe `91` sub `98` falso; anfitrião de sala `FightLab` (`roomType 5`) envia `82` com `flag true` → `game.missionStart()` destrava próximo andar.
 *
 * Como lê esse código (cada variável):
 * - `r`: registro de handlers (`HandlerRegistry`). Vem do bootstrap do servidor; recebe `r.player(código, nome, handler)`.
 * - `rr`: roteador de `94 GAME_ROOM` retornado por `roomRouter()`. Vem de `roomRouter()`; contém `handler` com subs `0..15`.
 * - `game`: partida ativa (`p.currentRoom?.game`). Vem de `p.currentRoom`; contém `processData`, `missionStart`.
 * - `off`: posição original de leitura do pacote (`pkt.offset`). Vem de `pkt`; serve para restaurar leitura após sondar sub `98`.
 * - `room`: sala do anfitrião (`p.currentRoom`). Vem de `p`; contém `RoomId`, `MapId`, `Name`, `Password`.
 * - `target`: jogador convidado (`ctx.world.get(id)`). Vem de `ctx.world`; recebe pacote `70` se estiver online e sem sala.
 * - `flag`: permissão para iniciar missão (`bool`). Vem do pacote `82`; quando `true` chama `missionStart`.
 */
export function registerRooms(r: HandlerRegistry): SubRouter {
  const rr = roomRouter();
  r.player(94, "GAME_ROOM", rr.handler);
  // 91 GAME_CMD (GameDataHandler): forwarded to the fight module; with no game and sub 98 -> fake reply.
  r.player(91, "GAME_CMD", (_ctx, p, pkt) => {
    const game = p.currentRoom?.game;
    if (game) return game.processData(p, pkt);
    const off = pkt.offset;
    if (pkt.readByte() === 98) {
      const out = new GSPacket(91, p.id);
      out.writeByte(98); out.writeBoolean(true); out.writeByte(0); out.writeByte(0); out.writeByte(0); out.writeBoolean(false);
      p.send(out);
    }
    pkt.offset = off;
  });
  // 70 GAME_INVITE (GameInviteHandler): target online and not in a room.
  r.player(70, "GAME_INVITE", (ctx, p, pkt) => {
    const room = p.currentRoom;
    const target = ctx.world.get(pkt.readInt());
    if (!room || !target || target.currentRoom) return;
    const o = new GSPacket(70, p.id);
    o.writeInt(p.id); o.writeInt(room.RoomId); o.writeInt(room.MapId); o.writeByte(room.TimeMode); o.writeByte(room.RoomType);
    o.writeByte(room.HardLevel); o.writeByte(room.LevelLimits); o.writeString(p.info.NickName ?? ""); o.writeBoolean(p.info.typeVIP > 0);
    o.writeInt(p.info.VIPLevel); o.writeString(room.Name); o.writeString(room.Password); o.writeInt(-1); o.writeBoolean(room.isOpenBoss);
    target.send(o);
  });
  // GameUserStartHandler.cs: bool flag; if (flag && currentRoom != null) RoomMgr.StartGameMission(currentRoom) ->
  // game.MissionStart(host) -> every Player.Ready = true + CheckState(0). No host check in the original. This is
  // what the AS3 client's MissionRoomView.startGame() sends INSTEAD of 94/7 GAME_START for FightLab (roomType 5)
  // rooms (BaseRoomView.startGame() sends 94/7; MissionRoomView overrides it to send 82) — without this handler a
  // FightLab mission's PVEGame sits in SessionPrepared/GameOver forever past floor 1.
  r.player(82, "GAME_MISSION_START", (_ctx, p, pkt) => {
    const flag = pkt.readBoolean();
    if (flag && p.currentRoom) return p.currentRoom.game?.missionStart?.();
  });
  // 86 host start shortcut.
  r.player(86, "QUEST_ONE_KEY_FINISH(start)", (ctx, p) => {
    if (p.currentRoom && p.currentRoom.host === p) ctx.rooms.startGame(p.currentRoom);
  });
  return rr;
}
