package {
  import flash.display.DisplayObject;
  import flash.display.DisplayObjectContainer;
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.TimerEvent;
  import flash.external.ExternalInterface;
  import flash.geom.Rectangle;
  import flash.net.URLRequest;
  import flash.net.URLVariables;
  import flash.system.ApplicationDomain;
  import flash.system.LoaderContext;
  import flash.utils.getQualifiedClassName;
  import flash.utils.getTimer;
  import flash.utils.Timer;

  /** Exact private ID 11 only. Original public senders; after start, observation only. */
  [SWF(width="1000", height="600", frameRate="25", backgroundColor="#161822")]
  public class WorkshopSoloProbe extends Sprite {
    private const FIXTURE_ID:int = 11;
    private const ROOM_NAME:String = "WorkshopSolo-11";
    private var client:Loader = new Loader();
    private var timer:Timer = new Timer(250);
    private var domains:Array = [ApplicationDomain.currentDomain];
    private var counts:Object = {};
    private var ready:Object = {};
    private var sent:Object = {};
    private var hooked:Boolean = false;
    private var bound:Boolean = false;
    private var loadingAdded:Boolean = false;
    private var loadingVisible:Boolean = false;
    private var setupBefore:int = 0;
    private var deadline:int = 240000;
    private var startedAt:int;
    private var ticks:int = 0;
    private var fightingTicks:int = 0;
    private var lastState:String = "";
    private var lastProgress:int = -1;
    private var progressPlayer:Object;
    private var progressEvent:String;
    private var naturalProgressMax:int = -1;
    private var observationContext:String = "begin";

    public function WorkshopSoloProbe() {
      if (stage) begin(); else addEventListener(Event.ADDED_TO_STAGE, begin);
    }
    private function report(value:Object):void {
      value.elapsedMs = getTimer() - startedAt;
      value.simulatedInput = false;
      value.forcedLoading = false;
      if (ExternalInterface.available) ExternalInterface.call("workshop_solo_report", value);
    }
    private function fail(text:String, error:Error = null):void {
      report({phase:"solo-probe-error", text:text, context:observationContext,
        stack:error ? error.getStackTrace() : null, eventCounts:counts, commands:sent}); timer.stop();
    }
    private function begin(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, begin);
      startedAt = getTimer();
      if (int(loaderInfo.parameters.probeUserId) != FIXTURE_ID || int(loaderInfo.parameters.probeUserId) == 6) {
        fail("only the exact private fixture ID 11 is allowed"); return;
      }
      var seconds:int = int(loaderInfo.parameters.probeSeconds);
      if (seconds < 60 || seconds > 360) { fail("invalid bounded observation deadline"); return; }
      deadline = seconds * 1000;
      if (!ExternalInterface.available) { fail("original public API bridge unavailable"); return; }
      ExternalInterface.addCallback("workshopSoloCommand", command);
      stage.addEventListener(Event.ADDED, added, true);
      var vars:URLVariables = new URLVariables();
      for each (var key:String in ["user", "key", "config"]) vars[key] = loaderInfo.parameters[key];
      client.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
        domains.push(client.contentLoaderInfo.applicationDomain); report({phase:"solo-client-loaded"});
      });
      client.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void { fail(e.text); });
      addChild(client);
      client.load(new URLRequest(String(loaderInfo.parameters.probeClient) + "?" + vars.toString()), new LoaderContext(false, ApplicationDomain.currentDomain));
      timer.addEventListener(TimerEvent.TIMER, tick); timer.start();
    }
    private function definition(name:String):Object {
      for each (var domain:ApplicationDomain in domains) {
        if (domain.hasDefinition(name)) return domain.getDefinition(name);
        if (domain.hasDefinition("com.pickgliss.loader.DisplayLoader")) {
          var display:Object = domain.getDefinition("com.pickgliss.loader.DisplayLoader");
          var ui:ApplicationDomain = display.Context.applicationDomain;
          if (ui && ui.hasDefinition(name)) return ui.getDefinition(name);
        }
      }
      return null;
    }
    private function self():Object {
      var players:Object = definition("ddt.manager.PlayerManager");
      if (!players || !players.Instance.Self || players.Instance.Self.ID != FIXTURE_ID || players.Instance.Self.ID == 6)
        throw new Error("Self differs from the exact private fixture ID 11");
      return players.Instance.Self;
    }
    private function qualification():Object {
      var player:Object = self(), guides:Object = definition("trainer.controller.WeakGuildManager"), steps:Object = definition("trainer.data.Step");
      if (!guides || !steps) throw new Error("original arena qualification APIs unavailable");
      var weapon:Object = player.Bag.getItemAt(6);
      var result:Object = {userId:player.ID, grade:player.Grade, gp:player.GP,
        arenaGuideOpen:guides.Instance.checkOpen(steps.GAME_ROOM_OPEN, 2), weaponPresent:weapon != null,
        weaponTemplateId:weapon ? weapon.TemplateID : 0, originalTimeOverrideWouldApply:player.Grade < 5};
      if (!result.arenaGuideOpen || !result.weaponPresent || result.originalTimeOverrideWouldApply)
        throw new Error("original arena gate, weapon, or unchanged time=3 qualification failed");
      return result;
    }
    private function randomMap():Object {
      var maps:Object = definition("ddt.manager.MapManager");
      if (!maps) throw new Error("original MapManager unavailable");
      // Ordinary competition uses its original random entry, not a challenge-only fixed map.
      for each (var info:Object in maps.getListByType(maps.PVP_COMPECTI_MAP)) {
        if (info.ID == 0 && info.isOpen && info.canSelect) return {id:0, isOpen:true, canSelect:true};
      }
      throw new Error("original ordinary competition random map is not selectable");
    }
    private function hostRoom(requireHost:Boolean = true):Object {
      var rooms:Object = definition("room.RoomManager"), room:Object = rooms ? rooms.Instance.current : null;
      if (!room || room.ID <= 0 || room.type != 0 || !room.selfRoomPlayer || room.selfRoomPlayer.playerInfo.ID != FIXTURE_ID)
        throw new Error("natural ordinary room model or exact Self membership is not ready");
      if (room.selfRoomPlayer.isViewer || (requireHost && !room.selfRoomPlayer.isHost)) throw new Error("private fixture must be the non-viewer host");
      if (room.players.list.length != 1) throw new Error("room has another participant before the private solo start");
      return room;
    }
    private function command(value:Object):void {
      try {
        observationContext = "command:" + String(value.action);
        self();
        if (!hooked || sent.start) throw new Error("commands are unavailable before hooks or after start");
        var action:String = String(value.action), states:Object = definition("ddt.manager.StateManager"), out:Object = definition("ddt.manager.GameInSocketOut");
        if (!states || !out || states.nextState) throw new Error("original state transition is not settled");
        if (sent[action]) throw new Error("duplicate bounded command");
        var q:Object = qualification(), room:Object;
        switch (action) {
          case "enter":
            if (states.currentStateType != "main" || !ready["solo-main-ready"]) throw new Error("original hall is not ready");
            sent.enter = true; report({phase:"solo-command", action:action, owner:"StateManager.setState", state:"roomlist", qualification:q});
            states.setState("roomlist"); break;
          case "create":
            if (!sent.enter || states.currentStateType != "roomlist" || !ready["solo-roomlist-ready"]) throw new Error("original arena list is not ready");
            randomMap(); sent.create = true;
            report({phase:"solo-command", action:action, owner:"GameInSocketOut.sendCreateRoom", roomType:0, timeType:3});
            out.sendCreateRoom(ROOM_NAME, 0, 3, ""); break;
          case "setup":
            if (!sent.create || states.currentStateType != "matchRoom" || !ready["solo-room-created-ready"]) throw new Error("natural room entry is not ready");
            room = hostRoom(); randomMap(); setupBefore = int(counts.GAME_ROOM_SETUP_CHANGE); sent.setup = true;
            report({phase:"solo-command", action:action, owner:"GameInSocketOut.sendGameRoomSetUp", roomId:room.ID, mapId:0, roomType:0, timeType:3, openBoss:false, hardLevel:0, crossZone:false});
            out.sendGameRoomSetUp(0, 0, false, "", ROOM_NAME, 3, 0, 0, false, 0); break;
          case "start":
            if (!sent.setup || states.currentStateType != "matchRoom" || !ready["solo-room-setup-ready"] || int(counts.GAME_ROOM_SETUP_CHANGE) <= setupBefore)
              throw new Error("normal room setup acknowledgement is not ready");
            room = hostRoom();
            if (room.mapId != 0 || room.timeType != 3 || !room.isAllReady()) throw new Error("original map/time/allReady checks failed");
            sent.start = true; report({phase:"solo-command", action:action, owner:"GameInSocketOut.sendGameStart", roomId:room.ID, allReady:true, host:true, viewer:false, qualification:q});
            out.sendGameStart(); break;
          default: throw new Error("unknown bounded solo command");
        }
      } catch (error:Error) { fail(error.message, error); }
    }
    private function hook():Boolean {
      var sockets:Object = definition("ddt.manager.SocketManager"), events:Object = definition("ddt.events.CrazyTankSocketEvent"), games:Object = definition("game.GameManager");
      if (!sockets || !events || !games) return false;
      for each (var name:String in ["GAME_ROOM_CREATE", "GAME_ROOM_LOGIN", "GAME_PLAYER_ENTER", "GAME_PLAYER_STATE_CHANGE", "GAME_ROOM_SETUP_CHANGE", "GAME_CREATE", "GAME_LOAD", "LOAD", "GAME_START", "GAME_MISSION_INFO", "PLAYER_CHANGE", "GAME_OVER"])
        sockets.Instance.addEventListener(events[name], packet, false, 100);
      games.Instance.addEventListener(games.START_LOAD, startLoad, false, 100);
      hooked = true; report({phase:"solo-hooks-ready", packetInspection:"event name and length only; package position untouched"}); return true;
    }
    private function packet(event:Object):void {
      var events:Object = definition("ddt.events.CrazyTankSocketEvent");
      for each (var name:String in ["GAME_ROOM_CREATE", "GAME_ROOM_LOGIN", "GAME_PLAYER_ENTER", "GAME_PLAYER_STATE_CHANGE", "GAME_ROOM_SETUP_CHANGE", "GAME_CREATE", "GAME_LOAD", "LOAD", "GAME_START", "GAME_MISSION_INFO", "PLAYER_CHANGE", "GAME_OVER"]) {
        if (event.type == events[name]) {
          counts[name] = int(counts[name]) + 1;
          report({phase:"solo-server-event", event:name, originalType:event.type, occurrence:counts[name], packetLength:event.pkg ? event.pkg.length : 0}); return;
        }
      }
    }
    private function startLoad(event:Event):void {
      counts.START_LOAD = int(counts.START_LOAD) + 1;
      // Priority 100 precedes BaseRoomState's original loading owner. Resource getters
      // are unsafe here; record the event without observing or initializing them.
      report({phase:"solo-start-load", event:"START_LOAD", originalType:event.type});
    }
    private function watchProgress(room:Object):void {
      var events:Object = definition("room.events.RoomPlayerEvent");
      if (!events || !room.selfRoomPlayer || progressPlayer == room.selfRoomPlayer) return;
      if (progressPlayer) progressPlayer.removeEventListener(progressEvent, progress);
      progressPlayer = room.selfRoomPlayer; progressEvent = events.PROGRESS_CHANGE;
      progressPlayer.addEventListener(progressEvent, progress, false, 100);
    }
    private function progress(event:Event):void {
      if (!sent.start || !counts.START_LOAD) return;
      try {
        observationContext = "progress:RoomManager.current.selfRoomPlayer";
        var percent:int = int(Object(event.currentTarget).progress);
        if (percent < 0 || percent > 100) throw new Error("original loading progress is outside 0..100");
        naturalProgressMax = Math.max(naturalProgressMax, percent);
        report({phase:"solo-loading-progress", source:"RoomManager.current.selfRoomPlayer.PROGRESS_CHANGE", progress:percent, maximumObserved:naturalProgressMax});
      } catch (error:Error) { fail(error.message, error); }
    }
    private function added(event:Event):void {
      if (!bound || loadingAdded || !(event.target is DisplayObject)) return;
      if (getQualifiedClassName(event.target) == "roomLoading.view::RoomLoadingView") {
        loadingAdded = true; report({phase:"solo-room-loading-added", originalClass:"roomLoading.view::RoomLoadingView"});
      }
    }
    private function inspect(container:DisplayObjectContainer, views:Array, components:Array, shown:Boolean = true):void {
      for (var i:int = 0; i < container.numChildren; i++) {
        var child:DisplayObject = container.getChildAt(i), visible:Boolean = shown && child.visible && child.alpha > 0;
        var kind:String = getQualifiedClassName(child);
        if (visible && child.width > 0 && child.height > 0 && components.length < 120 &&
          (kind.indexOf("GameView") >= 0 || kind.indexOf("RoomLoadingView") >= 0 || kind.indexOf("RoomListView") >= 0 ||
           kind.indexOf("MatchRoomView") >= 0 || kind.indexOf("HallStateView") >= 0 || kind.indexOf("GameLocalPlayer") >= 0 ||
           kind.indexOf("GamePlayer") >= 0 || kind.indexOf("MapView") >= 0 || kind.indexOf("GameMap") >= 0 ||
           kind.indexOf("RoomCharacter") >= 0 || kind.indexOf("GameCharacter") >= 0 || kind.indexOf("SaveFileWidow") >= 0)) {
          var rect:Rectangle = child.getBounds(stage);
          if (rect.width > 0 && rect.height > 0) { views.push(kind); components.push({kind:kind, x:rect.x, y:rect.y, width:rect.width, height:rect.height}); }
        }
        if (child is DisplayObjectContainer) inspect(child as DisplayObjectContainer, views, components, visible);
      }
    }
    private function snapshot():Object {
      observationContext = "snapshot:original state and display tree";
      var states:Object = definition("ddt.manager.StateManager"), player:Object = self(), rooms:Object = definition("room.RoomManager"), games:Object = definition("game.GameManager");
      var value:Object = {userId:player.ID, grade:player.Grade, gp:player.GP, state:states ? String(states.currentStateType) : "", nextState:states && states.nextState ? states.nextState.getType() : null,
        views:[], components:[], eventCounts:counts, commands:sent, loadingViewAddedEventObserved:loadingAdded};
      inspect(stage, value.views, value.components);
      value.loadingViewObservedInDisplayTree = loadingVisible || value.views.indexOf("roomLoading.view::RoomLoadingView") >= 0;
      var room:Object = rooms ? rooms.Instance.current : null;
      if (room) {
        watchProgress(room);
        value.room = {id:room.ID, type:room.type, mapId:room.mapId, timeType:room.timeType, allReady:room.isAllReady(), players:[]};
        for each (var rp:Object in room.players.list) value.room.players.push({userId:rp.playerInfo.ID, host:rp.isHost, viewer:rp.isViewer, ready:rp.isReady, progress:rp.progress});
        value.selfProgress = room.selfRoomPlayer ? room.selfRoomPlayer.progress : null;
      }
      value.naturalProgressMax = naturalProgressMax;
      var game:Object = games ? games.Instance.Current : null;
      if (game) {
        var bombs:Object = definition("ddt.manager.LoadBombManager"), modules:Object = definition("com.pickgliss.loader.ModuleLoader"), maps:Object = definition("ddt.manager.MapManager");
        // Observe completion getters only after the original owner reports 100.
        // Before then, null means unobserved; it never satisfies the acceptance gate.
        var resourcesObserved:Boolean = value.loadingViewObservedInDisplayTree && naturalProgressMax == 100 && game.loaderMap != null;
        value.game = {roomType:game.roomType, timeType:game.timeType, mapIndex:game.mapIndex, containsSelf:false, mapInfoPresent:maps && maps.getMapInfo(game.mapIndex) != null,
          mapCompleted:game.loaderMap ? game.loaderMap.completed : false, resourcesObserved:resourcesObserved, players:[], neededMovies:[], neededPetSkillResource:[]};
        for each (rp in game.roomPlayers) {
          if (rp.isViewer) continue;
          if (rp.playerInfo.ID > 0 && rp.playerInfo.ID != FIXTURE_ID) throw new Error("natural game includes a non-fixture human player");
          if (rp.playerInfo.ID == FIXTURE_ID) value.game.containsSelf = true;
          var living:Object = game.findLivingByPlayerID(rp.playerInfo.ID, rp.playerInfo.ZoneID);
          var weapon:Object = null, bombComplete:Object = null;
          if (resourcesObserved) {
            observationContext = "snapshot:currentWeapInfo for player " + rp.playerInfo.ID;
            weapon = rp.currentWeapInfo;
            observationContext = "snapshot:getLoadBombComplete for player " + rp.playerInfo.ID;
            bombComplete = bombs && weapon ? bombs.Instance.getLoadBombComplete(weapon) : false;
          }
          value.game.players.push({userId:rp.playerInfo.ID, livingId:living ? living.LivingID : -1, weapon:weapon ? weapon.TemplateID : 0,
            characterCompleted:resourcesObserved && living && living.character ? living.character.completed : null,
            movieCompleted:resourcesObserved && living && living.movie ? living.movie.completed : null, bombCompleted:bombComplete});
        }
        observationContext = "snapshot:neededMovies";
        for each (var movie:Object in game.neededMovies) value.game.neededMovies.push({type:movie.type, path:movie.path, classPath:movie.classPath,
          requiredByOriginalLoader:movie.type == 1 || movie.type == 2,
          completed:!resourcesObserved ? null : movie.type == 2 ? modules && modules.hasDefinition(movie.classPath) : movie.type == 1 ? bombs && bombs.Instance.getLivingBombComplete(movie.bombId) : null});
        observationContext = "snapshot:neededPetSkillResource";
        for each (var skill:Object in game.neededPetSkillResource) value.game.neededPetSkillResource.push({pic:skill.pic, effect:skill.effect,
          completed:!resourcesObserved ? null : skill.effect ? modules && modules.hasDefinition(skill.effectClassLink) : true});
      }
      return value;
    }
    private function announce(phase:String, value:Object):void {
      if (ready[phase]) return;
      ready[phase] = true; report({phase:phase, snapshot:value});
    }
    private function tick(event:TimerEvent):void {
      try {
        ++ticks;
        if (getTimer() - startedAt > deadline) throw new Error("natural ordinary arena observation deadline; no loading assistance is permitted");
        var states:Object = definition("ddt.manager.StateManager"), players:Object = definition("ddt.manager.PlayerManager");
        if (!states || !players || !players.Instance.Self) return;
        if (!bound) {
          if (String(states.currentStateType) != "main" || states.nextState) return;
          self(); bound = true;
        }
        self();
        if (!hooked && !hook()) return;
        var value:Object = snapshot();
        if (ticks % 4 == 0 || value.state != lastState || (value.selfProgress != null && int(value.selfProgress) != lastProgress)) {
          report({phase:"solo-observation", snapshot:value}); lastState = value.state;
          if (value.selfProgress != null) lastProgress = int(value.selfProgress);
        }
        if (!sent.enter && value.state == "main" && !value.nextState && value.views.indexOf("hall::HallStateView") >= 0) {
          value.qualification = qualification(); randomMap(); announce("solo-main-ready", value);
        } else if (sent.enter && !sent.create && value.state == "roomlist" && !value.nextState && value.views.indexOf("roomList.pvpRoomList::RoomListView") >= 0) {
          announce("solo-roomlist-ready", value);
        } else if (sent.create && !sent.setup && value.state == "matchRoom" && !value.nextState && int(counts.GAME_ROOM_CREATE) > 0) {
          // CREATE enters matchRoom before the separate original playerState packet assigns the host.
          var enteredRoom:Object = hostRoom(false);
          if (enteredRoom.selfRoomPlayer.isHost && int(counts.GAME_PLAYER_STATE_CHANGE) > 0) announce("solo-room-created-ready", value);
        } else if (sent.setup && !sent.start && value.state == "matchRoom" && !value.nextState && int(counts.GAME_ROOM_SETUP_CHANGE) > setupBefore) {
          var room:Object = hostRoom();
          if (room.mapId == 0 && room.timeType == 3 && room.isAllReady()) announce("solo-room-setup-ready", value);
        }
        if (!sent.start) return;
        // No sender or StateManager mutation exists beyond the original start request.
        if (!loadingVisible && value.views.indexOf("roomLoading.view::RoomLoadingView") >= 0) {
          loadingVisible = true; announce("solo-room-loading-visible", value);
        }
        var complete:Boolean = value.state == "fighting" && !value.nextState && value.views.indexOf("game.view::GameView") >= 0 && value.game && value.game.resourcesObserved && value.game.roomType == 0 && value.game.timeType == 3 && value.game.containsSelf && value.game.mapCompleted && value.game.mapInfoPresent && value.game.players.length >= 2;
        if (complete) {
          for each (var item:Object in value.game.players) if (!item.characterCompleted || !item.movieCompleted || !item.bombCompleted) complete = false;
          for each (item in value.game.neededMovies) if (item.requiredByOriginalLoader && item.completed !== true) complete = false;
          for each (item in value.game.neededPetSkillResource) if (!item.completed) complete = false;
        }
        if (complete) ++fightingTicks; else fightingTicks = 0;
        if (fightingTicks >= 8) {
          if (!loadingVisible || !counts.GAME_CREATE || !counts.GAME_LOAD || !counts.START_LOAD || !counts.GAME_START || naturalProgressMax != 100)
            throw new Error("fighting appeared without the required observed natural loading chain");
          announce("solo-fighting-ready", value);
          report({phase:"solo-complete", scope:"original ordinary arena public API path, natural loading and original components; visual review required", fullBattleAccepted:false, visualAccepted:false, snapshot:value}); timer.stop();
        }
      } catch (error:Error) { fail(error.message, error); }
    }
  }
}
