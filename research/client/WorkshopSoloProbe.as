package {
  import flash.display.DisplayObject;
  import flash.display.DisplayObjectContainer;
  import flash.display.BitmapData;
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
  import flash.utils.Dictionary;
  import flash.utils.Timer;

  /** Exact private ID 11 only. Battle actions require the explicit private battle mode. */
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
    private var battleMode:Boolean = false;
    private var battleGame:Object;
    private var battleSelf:Object;
    private var battleView:Object;
    private var battlePlayers:Array = [];
    private var bloodBefore:Dictionary = new Dictionary(true);
    private var bombRecords:Dictionary = new Dictionary();
    private var usedHitActions:Dictionary = new Dictionary(true);
    private var firedTurns:Object = {};
    private var aimCheckedTurns:Object = {};
    private var qualifiedTurn:String = "";
    private var qualifiedTicks:int = 0;
    private var shootingGate:Object;
    private var gameOverSeen:Boolean = false;
    private var expSeen:Boolean = false;
    private var expComplete:Boolean = false;
    private var cardsSeen:Boolean = false;
    private var cardsComplete:Boolean = false;
    private var selfTakeOutSeen:Boolean = false;
    private var battleResult:Object;
    private var selfShootCount:int = 0;
    private var ownBombCount:int = 0;
    private var ownBombRemoved:int = 0;
    private var damageCount:int = 0;
    private var ownHitCount:int = 0;
    private var ownOtherPlayerHitCount:int = 0;
    private var returnTicks:int = 0;
    private var aimAttempt:int = 0;
    private var completedShots:int = 0;
    private var activeShot:Object;
    private var lastAimBlock:String = "";
    private var predictionJob:Object;
    private var predictionSequence:int = 0;
    private var usedAims:Object = {};
    private const PUBLIC_SHOOT_REQUEST_LIMIT:int = 16;

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
      clearPrediction();
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
      battleMode = String(loaderInfo.parameters.probeBattle) == "true";
      if (seconds < 60 || seconds > (battleMode ? 720 : 360)) { fail("invalid bounded observation deadline"); return; }
      deadline = seconds * 1000;
      if (!ExternalInterface.available) { fail("original public API bridge unavailable"); return; }
      ExternalInterface.addCallback("workshopSoloCommand", command);
      stage.addEventListener(Event.ADDED, added, true);
      if (battleMode) stage.addEventListener(Event.REMOVED, removed, true);
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
      var names:Array = ["GAME_ROOM_CREATE", "GAME_ROOM_LOGIN", "GAME_PLAYER_ENTER", "GAME_PLAYER_STATE_CHANGE", "GAME_ROOM_SETUP_CHANGE", "GAME_CREATE", "GAME_LOAD", "LOAD", "GAME_START", "GAME_MISSION_INFO", "PLAYER_CHANGE", "GAME_OVER"];
      if (battleMode) names.push("GAME_TAKE_OUT");
      for each (var name:String in names)
        sockets.Instance.addEventListener(events[name], packet, false, 100);
      games.Instance.addEventListener(games.START_LOAD, startLoad, false, 100);
      hooked = true; report({phase:"solo-hooks-ready", packetInspection:"event name and length only; package position untouched"}); return true;
    }
    private function packet(event:Object):void {
      var events:Object = definition("ddt.events.CrazyTankSocketEvent");
      for each (var name:String in ["GAME_ROOM_CREATE", "GAME_ROOM_LOGIN", "GAME_PLAYER_ENTER", "GAME_PLAYER_STATE_CHANGE", "GAME_ROOM_SETUP_CHANGE", "GAME_CREATE", "GAME_LOAD", "LOAD", "GAME_START", "GAME_MISSION_INFO", "PLAYER_CHANGE", "GAME_OVER", "GAME_TAKE_OUT"]) {
        if (event.type == events[name]) {
          counts[name] = int(counts[name]) + 1;
          if (battleMode && sent.start && name == "GAME_OVER") gameOverSeen = true;
          // extend1 is the original packet header LivingID; never consume its payload.
          if (battleMode && gameOverSeen && name == "GAME_TAKE_OUT" && battleSelf && event.pkg && event.pkg.extend1 == battleSelf.LivingID) selfTakeOutSeen = true;
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
      if (battleMode && bound && sent.start && event.target is DisplayObject) {
        var kind:String = getQualifiedClassName(event.target), object:Object = event.target;
        if (kind == "game.objects::SimpleBomb") observeBomb(object);
        else if (kind == "game.view.experience::ExpView") {
          var events:Object = definition("ddt.events.GameEvent");
          if (!events) { fail("original settlement event API unavailable"); return; }
          object.addEventListener(events.EXPSHOWED, settlementEvent, false, 100);
        } else if (kind == "game.view.card::SmallCardsView") object.addEventListener(Event.COMPLETE, settlementEvent, false, 100);
      }
      if (!bound || loadingAdded || !(event.target is DisplayObject)) return;
      if (getQualifiedClassName(event.target) == "roomLoading.view::RoomLoadingView") {
        loadingAdded = true; report({phase:"solo-room-loading-added", originalClass:"roomLoading.view::RoomLoadingView"});
      }
    }
    private function removed(event:Event):void {
      var object:Object = event.target, record:Object = bombRecords[object];
      if (!record) return;
      if (record.own) ++ownBombRemoved;
      report({phase:"solo-projectile-removed", bomb:record, originalRemovalEvent:true});
      delete bombRecords[object];
    }
    private function observeBomb(object:Object):void {
      try {
        observationContext = "battle:SimpleBomb public info/owner";
        if (bombRecords[object]) return;
        if (!object.info || !object.owner) throw new Error("original SimpleBomb info or owner unavailable");
        var games:Object = definition("game.GameManager"), originalSelf:Object = battleSelf ? battleSelf : games && games.Instance.Current ? games.Instance.Current.selfGamePlayer : null;
        var record:Object = {bombId:object.info.Id, ownerLivingId:object.owner.LivingID,
          own:originalSelf != null && originalSelf.playerInfo.ID == FIXTURE_ID && object.owner == originalSelf};
        bombRecords[object] = record;
        if (record.own) ++ownBombCount;
        report({phase:"solo-projectile-added", bomb:record, originalAdditionEvent:true});
      } catch (error:Error) { fail(error.message, error); }
    }
    private function settlementEvent(event:Event):void {
      if (getQualifiedClassName(event.currentTarget) == "game.view.experience::ExpView") expComplete = true;
      else if (getQualifiedClassName(event.currentTarget) == "game.view.card::SmallCardsView") cardsComplete = true;
      report({phase:"solo-settlement-event", originalType:event.type, originalClass:getQualifiedClassName(event.currentTarget)});
    }
    private function livingEvent(event:Event):void {
      try {
        observationContext = "battle:original Living event target";
        var events:Object = definition("ddt.events.LivingEvent"), living:Object = event.currentTarget;
        if (event.type == events.SHOOT && living == battleSelf) {
          ++selfShootCount;
          report({phase:"solo-self-shoot-event", livingId:living.LivingID, occurrence:selfShootCount});
        } else if (event.type == events.BLOOD_CHANGED) observeBlood(living, "original BLOOD_CHANGED target; payload untouched");
      } catch (error:Error) { fail(error.message, error); }
    }
    private function observeBlood(living:Object, source:String):void {
      var after:Number = Number(living.blood);
      if (!isFinite(after)) throw new Error("original public blood is not readable");
      if (bloodBefore[living] !== undefined && Number(bloodBefore[living]) != after) {
        var before:Number = Number(bloodBefore[living]), ownHits:Array = [], types:Object = definition("game.objects.ActionType");
        // SimpleBomb.moveTo appends UsedActions before BombAction.execute updates blood.
        // Attribute only an executed Self-owned KILL_PLAYER action with matching target/final HP.
        if (after < before && types) {
          for (var bomb:Object in bombRecords) if (bombRecords[bomb].own && bomb.info) {
            for each (var action:Object in bomb.info.UsedActions) {
              if (!usedHitActions[action] && action.type == types.KILL_PLAYER && action.param1 == living.LivingID && action.param4 == after && action.param2 > 0) {
                usedHitActions[action] = true;
                ownHits.push({bombId:bombRecords[bomb].bombId, targetLivingId:action.param1, damage:action.param2, finalBlood:action.param4});
              }
            }
          }
        }
        if (after < before) ++damageCount;
        if (ownHits.length > 0) { ++ownHitCount; if (living != battleSelf) ++ownOtherPlayerHitCount; }
        report({phase:"solo-blood-change", livingId:living.LivingID, before:before, after:after, source:source,
          damageObserved:after < before, ownHitObserved:ownHits.length > 0, ownHitActions:ownHits,
          attribution:ownHits.length > 0 ? "executed Self-owned original BombAction and actual public blood change" : "unattributed blood change"});
      }
      bloodBefore[living] = after;
    }
    private function inspect(container:DisplayObjectContainer, views:Array, components:Array, shown:Boolean = true):void {
      for (var i:int = 0; i < container.numChildren; i++) {
        var child:DisplayObject = container.getChildAt(i), visible:Boolean = shown && child.visible && child.alpha > 0;
        var kind:String = getQualifiedClassName(child);
        if (battleMode && visible && kind == "game.view::GameView") battleView = child;
        if (visible && child.width > 0 && child.height > 0 && components.length < 120 &&
          (kind.indexOf("GameView") >= 0 || kind.indexOf("RoomLoadingView") >= 0 || kind.indexOf("RoomListView") >= 0 ||
           kind.indexOf("MatchRoomView") >= 0 || kind.indexOf("HallStateView") >= 0 || kind.indexOf("GameLocalPlayer") >= 0 ||
           kind.indexOf("GamePlayer") >= 0 || kind.indexOf("MapView") >= 0 || kind.indexOf("GameMap") >= 0 ||
           kind.indexOf("RoomCharacter") >= 0 || kind.indexOf("GameCharacter") >= 0 || kind.indexOf("SaveFileWidow") >= 0 ||
           (battleMode && (kind == "game.view.experience::ExpView" || kind == "game.view.card::SmallCardsView")))) {
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
      if (battleMode) battleView = null;
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
        if (battleMode && resourcesObserved && !battleGame && game.selfGamePlayer) {
          battleGame = game; battleSelf = game.selfGamePlayer;
          if (!battleSelf.playerInfo || battleSelf.playerInfo.ID != FIXTURE_ID) throw new Error("original game Self is not the exact private fixture");
        }
        value.game = {roomType:game.roomType, timeType:game.timeType, mapIndex:game.mapIndex, containsSelf:false, mapInfoPresent:maps && maps.getMapInfo(game.mapIndex) != null,
          mapCompleted:game.loaderMap ? game.loaderMap.completed : false, resourcesObserved:resourcesObserved, players:[], neededMovies:[], neededPetSkillResource:[]};
        for each (rp in game.roomPlayers) {
          if (rp.isViewer) continue;
          if (rp.playerInfo.ID > 0 && rp.playerInfo.ID != FIXTURE_ID) throw new Error("natural game includes a non-fixture human player");
          if (rp.playerInfo.ID == FIXTURE_ID) value.game.containsSelf = true;
          var living:Object = game.findLivingByPlayerID(rp.playerInfo.ID, rp.playerInfo.ZoneID);
          if (battleMode && battleGame == game && living) watchLiving(living);
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
      if (battleMode) value.battle = battleSummary();
      return value;
    }
    private function watchLiving(living:Object):void {
      if (bloodBefore[living] === undefined) {
        var events:Object = definition("ddt.events.LivingEvent");
        if (!events) throw new Error("original Living event API unavailable");
        battlePlayers.push(living);
        observeBlood(living, "original public blood initial snapshot");
        living.addEventListener(events.SHOOT, livingEvent, false, 100);
        living.addEventListener(events.BLOOD_CHANGED, livingEvent, false, 100);
      } else observeBlood(living, "original public blood snapshot");
    }
    private function battleSummary():Object {
      var activeOwn:int = 0;
      for (var bomb:Object in bombRecords) if (bombRecords[bomb].own && bomb.parent) ++activeOwn;
      return {enabled:true, firedTurns:firedTurns, selfShootEvents:selfShootCount, ownProjectilesAdded:ownBombCount,
        ownProjectilesRemoved:ownBombRemoved, activeOwnProjectiles:activeOwn, damageChanges:damageCount, ownHitChanges:ownHitCount, ownOtherPlayerHitChanges:ownOtherPlayerHitCount,
        gameOverObserved:gameOverSeen, expVisible:expSeen, expCompleted:expComplete, smallCardsVisible:cardsSeen,
        smallCardsCompleted:cardsComplete, selfTakeOutEventObserved:selfTakeOutSeen, result:battleResult,
        shootingGate:gameOverSeen ? null : shootingGate, aimStrategy:"bounded original EulerVector prediction over private full current terrain; original direction preserved",
        aimCandidatesConsumed:aimAttempt, aimCandidateLimit:PUBLIC_SHOOT_REQUEST_LIMIT,
        publicShootRequestLimit:PUBLIC_SHOOT_REQUEST_LIMIT, requestBudgetUnit:"original public shooting request; original local multishot count preserved",
        requestedShots:firedTurnCount(), completedShotObservations:completedShots, activeShot:activeShot, lastAimBlock:lastAimBlock,
        persistenceAccepted:false, visualAccepted:false};
    }
    private function firedTurnCount():int {
      var total:int = 0;
      for (var turn:String in firedTurns) if (firedTurns[turn] === true) ++total;
      return total;
    }
    private function readableNumber(owner:Object, field:String):Number {
      if (!owner || typeof owner[field] != "number" || !isFinite(Number(owner[field])))
        throw new Error("original public numeric field is unavailable: " + field);
      return Number(owner[field]);
    }
    private function originalPlayerObject(map:Object, living:Object):Object {
      var layer:DisplayObjectContainer = map.livngLayer as DisplayObjectContainer;
      if (!layer) throw new Error("original Map.livngLayer unavailable");
      for (var i:int = 0; i < layer.numChildren; ++i) {
        var object:Object = layer.getChildAt(i), kind:String = getQualifiedClassName(object);
        if ((kind == "game.objects::GameLocalPlayer" || kind == "game.objects::GamePlayer") && object.player == living && object.map == map) return object;
      }
      throw new Error("original GamePlayer display owner unavailable for living " + living.LivingID);
    }
    private function pointSnapshot(point:Object):Object {
      return {x:readableNumber(point, "x"), y:readableNumber(point, "y")};
    }
    private function livingAimSnapshot(map:Object, living:Object):Object {
      var object:Object = originalPlayerObject(map, living), rect:Rectangle = object.getCollideRect() as Rectangle;
      if (!rect || !isFinite(rect.x) || !isFinite(rect.y) || !isFinite(rect.width) || !isFinite(rect.height) || rect.width <= 0 || rect.height <= 0)
        throw new Error("original PhysicalObj.getCollideRect unavailable");
      if (typeof living.isLiving != "boolean") throw new Error("original Living.isLiving unavailable");
      return {livingId:living.LivingID, pos:pointSnapshot(living.pos), direction:readableNumber(living, "direction"),
        playerAngle:readableNumber(living, "playerAngle"), team:readableNumber(living, "team"), isLiving:living.isLiving,
        displayPos:{x:readableNumber(object, "x"), y:readableNumber(object, "y")},
        collideRect:{x:rect.x, y:rect.y, width:rect.width, height:rect.height}, collisionSource:"original public getCollideRect clone"};
    }
    private function terrainSnapshot(ground:Object, points:Array):Object {
      if (ground == null) return {present:false};
      var bitmap:Object = ground.bitmapData;
      var width:Number = readableNumber(bitmap, "width"), height:Number = readableNumber(bitmap, "height");
      if (width <= 0 || height <= 0 || int(width) != width || int(height) != height) throw new Error("original current terrain dimensions unavailable");
      var grid:Array = [], samples:Array = [];
      // Bounded live alpha observations, never a full terrain snapshot or an aim-solver input.
      for (var row:int = 0; row < 8; ++row) for (var col:int = 0; col < 16; ++col) {
        var x:int = int((width - 1) * col / 15), y:int = int((height - 1) * row / 7);
        var alpha:Number = ground.GetAlpha(x, y);
        if (!isFinite(alpha) || alpha < 0 || alpha > 255) throw new Error("original Tile.GetAlpha unavailable");
        grid.push(alpha);
      }
      for each (var point:Object in points) {
        x = int(point.x); y = int(point.y);
        var inside:Boolean = x >= 0 && x < width && y >= 0 && y < height;
        samples.push({x:x, y:y, inside:inside, alpha:inside ? ground.GetAlpha(x, y) : null});
      }
      return {present:true, width:width, height:height, gridColumns:16, gridRows:8, alpha:grid, points:samples,
        source:"current original Ground.GetAlpha; alpha <= 150 is empty", fullTerrain:false, solverInput:false};
    }
    private function aimSnapshot(map:Object):Object {
      observationContext = "battle:original public position, muzzle, weapon, wind and current terrain";
      var local:Object = battleSelf, playerObject:Object = originalPlayerObject(map, local);
      if (getQualifiedClassName(playerObject) != "game.objects::GameLocalPlayer" || playerObject.localPlayer != local)
        throw new Error("original GameLocalPlayer does not own exact fixture Self");
      if (typeof local.isLockAngle != "boolean" || typeof map.mapChanged != "boolean") throw new Error("original angle lock or mapChanged unavailable");
      var selfState:Object = livingAimSnapshot(map, local), targets:Array = [], target:Object;
      for each (var living:Object in battlePlayers) {
        if (living == local || !living.playerInfo || living.playerInfo.ID >= 0) continue;
        if (typeof living.isLiving != "boolean") throw new Error("original bot Living.isLiving unavailable");
        if (!living.isLiving) continue;
        var candidate:Object = livingAimSnapshot(map, living);
        if (candidate.isLiving && candidate.team != selfState.team) {
          targets.push(candidate);
          if (!target || Math.abs(candidate.pos.x - selfState.pos.x) < Math.abs(target.pos.x - selfState.pos.x)) target = candidate;
        }
      }
      var currentBomb:Number = readableNumber(local, "currentBomb"), weapon:Object = local.currentWeapInfo;
      if (!weapon) throw new Error("original currentWeapInfo unavailable");
      var min:Number = currentBomb == 3 ? 0 : readableNumber(weapon, "armMinAngle");
      var max:Number = currentBomb == 3 ? 90 : readableNumber(weapon, "armMaxAngle");
      var playerClass:Object = definition("game.model.Player"), limit:Number = Math.min(readableNumber(playerClass, "FORCE_MAX"), readableNumber(local, "maxForce"), 2000);
      if (min > max || limit <= 0) throw new Error("original legal gun-angle/force range unavailable");
      var balls:Object = definition("ddt.manager.BallManager"), ball:Object = balls ? balls.findBall(currentBomb) : null;
      if (!ball || readableNumber(ball, "ID") != currentBomb) throw new Error("original currentBomb template unavailable");
      var muzzle:Object = pointSnapshot(playerObject.shootPoint()), points:Array = [muzzle, selfState.pos];
      for each (candidate in targets) points.push(candidate.pos);
      return {self:selfState, targets:targets, target:target, muzzle:muzzle, isLockAngle:local.isLockAngle,
        gunAngle:readableNumber(local, "gunAngle"), worldAngle:local.calcBombAngle(), currentBomb:currentBomb,
        legalGunAngle:{min:min, max:max, source:currentBomb == 3 ? "original currentBomb 3 rule" : "original currentWeapInfo"}, maxForce:limit,
        ball:{id:currentBomb, mass:readableNumber(ball, "Mass"), weight:readableNumber(ball, "Weight"), wind:readableNumber(ball, "Wind"), dragIndex:readableNumber(ball, "DragIndex")},
        physics:{mapIndex:battleGame.mapIndex, wind:readableNumber(map, "wind"), windRate:readableNumber(map, "windRate"), gravity:readableNumber(map, "gravity"), airResistance:readableNumber(map, "airResistance"), mapChanged:map.mapChanged},
        terrain:{ground:terrainSnapshot(map.ground, points), stone:terrainSnapshot(map.stone, points)}};
    }
    private function clearPrediction():void {
      if (!predictionJob) return;
      // These are private clones only; never dispose either original Ground bitmapData.
      if (predictionJob.ground) BitmapData(predictionJob.ground).dispose();
      if (predictionJob.stone) BitmapData(predictionJob.stone).dispose();
      predictionJob = null;
    }
    private function aimStage(stage:String, boundary:String):void {
      observationContext = "prediction:" + stage + ":" + boundary;
      if (!predictionJob) return;
      var key:String = stage + ":" + boundary;
      if (predictionJob.stageEvidence[key]) return;
      predictionJob.stageEvidence[key] = true;
      // Each private job emits at most ten boundaries; never per Euler step or terrain pixel.
      report({phase:"solo-aim-stage", stage:stage, boundary:boundary, job:predictionJob.sequence, attempt:predictionJob.evaluations});
    }
    private function aimKey(state:Object):String {
      var t:Object = state.target, p:Object = state.physics, b:Object = state.ball;
      return [state.currentBomb, state.gunAngle, state.maxForce, state.legalGunAngle.min, state.legalGunAngle.max,
        state.self.pos.x, state.self.pos.y, state.self.direction, state.self.playerAngle, state.muzzle.x, state.muzzle.y,
        t.livingId, t.displayPos.x, t.displayPos.y, t.collideRect.x, t.collideRect.y, t.collideRect.width, t.collideRect.height,
        p.mapIndex, p.wind, p.windRate, p.gravity, p.airResistance, b.mass, b.weight, b.wind, b.dragIndex].join("|");
    }
    private function cloneTerrain(ground:Object):BitmapData {
      if (ground == null) return null;
      var original:BitmapData = ground.bitmapData as BitmapData;
      if (!original) throw new Error("original full current terrain bitmapData unavailable");
      return original.clone();
    }
    private function terrainUnchanged(ground:Object, copy:BitmapData, stage:String):Boolean {
      aimStage(stage, "before");
      if (ground == null || copy == null) { aimStage(stage, "after"); return ground == null && copy == null; }
      var original:BitmapData = ground.bitmapData as BitmapData;
      if (!original) throw new Error("original current terrain disappeared during prediction");
      var difference:Object = original.compare(copy);
      if (difference is BitmapData) {
        observationContext = "prediction:" + stage + ":difference-dispose";
        BitmapData(difference).dispose(); aimStage(stage, "after"); return false;
      }
      aimStage(stage, "after");
      return difference === 0;
    }
    private function alphaEmpty(bitmap:BitmapData, rect:Rectangle):Boolean {
      if (!bitmap) return true;
      // Original Map delegates to Ground.IsRectangeEmptyQuick, including native intersection/edge behavior.
      var clipped:Rectangle = bitmap.rect.intersection(rect);
      return (bitmap.getPixel32(int(clipped.right), int(clipped.bottom)) >>> 24) <= 150 &&
        (bitmap.getPixel32(int(clipped.left), int(clipped.bottom)) >>> 24) <= 150 &&
        (bitmap.getPixel32(int(clipped.right), int(clipped.top)) >>> 24) <= 150 &&
        (bitmap.getPixel32(int(clipped.left), int(clipped.top)) >>> 24) <= 150;
    }
    private function predictShot(job:Object, gun:Number, force:int):Object {
      var state:Object = job.state, target:Object = state.target;
      var world:Number = state.self.direction > 0 ? state.self.playerAngle - gun : state.self.playerAngle + gun - 180;
      var angle:int = int(world), px:Number = int(state.muzzle.x), py:Number = int(state.muzzle.y);
      var euler:Object = definition("phy.math.EulerVector");
      if (!euler) throw new Error("original pure EulerVector unavailable");
      var vx:Object = new euler(px, int(force * Math.cos(angle * Math.PI / 180)), 0);
      var vy:Object = new euler(py, int(force * Math.sin(angle * Math.PI / 180)), 0);
      var mass:Number = state.ball.mass, drag:Number = state.physics.airResistance * state.ball.dragIndex;
      if (mass <= 0) throw new Error("original positive ball mass unavailable");
      var wind:Number = state.physics.wind * state.ball.wind * state.physics.windRate;
      var gravity:Number = state.physics.gravity * state.ball.weight * mass;
      var body:Rectangle = new Rectangle(target.displayPos.x + target.collideRect.x, target.displayPos.y + target.collideRect.y, target.collideRect.width, target.collideRect.height);
      // Verified SimpleBomb.initMovie collision rectangle; private geometry only, no bomb is constructed.
      var bomb:Rectangle = new Rectangle(-3, -3, 6, 6);
      var best:Number = Number.POSITIVE_INFINITY, cross:Object = null, checks:int = 0;
      for (var step:int = 0; step < 400; ++step) {
        vx.ComputeOneEulerStep(mass, drag, wind, 0.04);
        vy.ComputeOneEulerStep(mass, drag, gravity, 0.04);
        var nx:Number = vx.x0, ny:Number = vy.x0;
        if (!isFinite(nx) || !isFinite(ny)) throw new Error("original pure EulerVector prediction is not finite");
        if ((nx - px) * (nx - px) + (ny - py) * (ny - py) < 9) continue;
        var count:int = Math.max(Math.abs(int(nx) - int(px)), Math.abs(int(ny) - int(py)));
        for (var n:int = count; n > 0; n -= 3) {
          var ratio:Number = n / count, x:Number = nx + (px - nx) * ratio, y:Number = ny + (py - ny) * ratio;
          if (++checks > 5000) return {score:best, predictedHit:false, cross:cross, outcome:"bounded sweep budget exhausted", checks:checks};
          bomb.x = x - 3; bomb.y = y - 3;
          var dx:Number = Math.max(0, body.left - bomb.right, bomb.left - body.right), dy:Number = Math.max(0, body.top - bomb.bottom, bomb.top - body.bottom);
          best = Math.min(best, dx * dx + dy * dy);
          if (bomb.intersects(body)) return {score:0, predictedHit:true, cross:y - target.displayPos.y, outcome:"predicted target rectangle intersection", checks:checks, point:{x:x, y:y}};
          if (cross == null && (x - target.displayPos.x) * (target.displayPos.x - int(state.muzzle.x)) >= 0) cross = y - target.displayPos.y;
          if (!alphaEmpty(job.ground, bomb) || !alphaEmpty(job.stone, bomb)) return {score:best, predictedHit:false, cross:cross, outcome:"current full terrain alpha collision", checks:checks, point:{x:x, y:y}};
          if (x < job.bound.x || x > job.bound.width || y > job.bound.height) return {score:best, predictedHit:false, cross:cross, outcome:"original map bound exit", checks:checks, point:{x:x, y:y}};
        }
        px = nx; py = ny;
      }
      return {score:best, predictedHit:false, cross:cross, outcome:"bounded Euler lifetime exhausted", checks:checks};
    }
    private function nextAim(state:Object, map:Object):Object {
      if (state.isLockAngle || !state.target || aimAttempt >= PUBLIC_SHOOT_REQUEST_LIMIT) {
        clearPrediction();
        return {blocked:state.isLockAngle ? "original angle controller is locked" : !state.target ? "no living original bot target" : "at most 16 public shooting requests exhausted; original multishot rule and direction preserved"};
      }
      if (state.targets.length != 1) { clearPrediction(); return {blocked:"pure predictor requires the observed single bot target"}; }
      var dx:Number = state.target.displayPos.x - int(state.muzzle.x);
      if (dx == 0) { clearPrediction(); return {blocked:"target and actual muzzle share x; no horizontal facing assumption"}; }
      var key:String = aimKey(state);
      if (predictionJob && (predictionJob.turn != qualifiedTurn || predictionJob.map != map || predictionJob.key != key)) clearPrediction();
      if (!predictionJob) {
        var angles:Array = [];
        for (var a:int = 0; a < 6; ++a) {
          var gun:Number = state.legalGunAngle.min + (state.legalGunAngle.max - state.legalGunAngle.min) * a / 5;
          var world:Number = state.self.direction > 0 ? state.self.playerAngle - gun : state.self.playerAngle + gun - 180;
          var horizontal:Number = Math.cos(int(world) * Math.PI / 180);
          if (Math.abs(horizontal) > 0.000001 && horizontal * dx > 0) angles.push(gun);
        }
        if (angles.length == 0) return {blocked:"all actual legal network angles face away from target; no direction change invoked"};
        var bound:Rectangle = map.bound as Rectangle;
        if (!bound || !isFinite(bound.width) || !isFinite(bound.height) || bound.width <= 0 || bound.height <= 0) throw new Error("original map bound unavailable");
        predictionJob = {sequence:++predictionSequence, stageEvidence:{}, turn:qualifiedTurn, map:map, key:key, state:state, angles:angles, angleIndex:0, iterations:0, evaluations:0,
          low:1, high:int(state.maxForce), best:null, bound:bound.clone(), ground:null, stone:null};
        aimStage("ground-clone", "before"); predictionJob.ground = cloneTerrain(map.ground); aimStage("ground-clone", "after");
        aimStage("stone-clone", "before"); predictionJob.stone = cloneTerrain(map.stone); aimStage("stone-clone", "after");
        if (!predictionJob.ground && !predictionJob.stone) throw new Error("no original full current terrain exists");
      }
      var job:Object = predictionJob;
      // At most two bounded pure trajectories per existing Timer callback; no stage/frame events or execution-limit changes.
      for (var work:int = 0; work < 2 && job.angleIndex < job.angles.length; ++work) {
        gun = job.angles[job.angleIndex];
        var force:int = int((job.low + job.high) / 2);
        observationContext = "prediction:EulerVector-trajectory";
        if (job.evaluations == 0) aimStage("first-euler-prediction", "before");
        var trial:Object = predictShot(job, gun, force);
        ++job.evaluations; ++job.iterations;
        if (job.evaluations == 1) aimStage("first-euler-prediction", "after");
        var candidateKey:String = key + "|" + gun + "|" + force;
        if (!usedAims[candidateKey] && isFinite(trial.score) && (!job.best || (trial.predictedHit && !job.best.prediction.predictedHit) || trial.score < job.best.prediction.score))
          job.best = {gunAngle:gun, force:force, worldAngle:state.self.direction > 0 ? state.self.playerAngle - gun : state.self.playerAngle + gun - 180,
            key:candidateKey, prediction:trial};
        if (trial.predictedHit && !usedAims[candidateKey]) break;
        if (trial.cross == null || trial.cross > 0) job.low = force + 1; else job.high = force - 1;
        if (job.iterations >= 10 || job.low > job.high) { ++job.angleIndex; job.iterations = 0; job.low = 1; job.high = int(state.maxForce); }
      }
      if ((!job.best || !job.best.prediction.predictedHit) && job.angleIndex < job.angles.length) return {pending:true};
      if (!terrainUnchanged(map.ground, job.ground, "ground-compare") || !terrainUnchanged(map.stone, job.stone, "stone-compare")) {
        clearPrediction(); report({phase:"solo-aim-prediction-discarded", reason:"full original current terrain changed; old prediction rejected"}); return {pending:true};
      }
      var result:Object = job.best;
      if (result) {
        result.index = aimAttempt++; usedAims[result.key] = true;
        result.prediction.evaluations = job.evaluations;
        result.prediction.integrator = "original pure EulerVector.ComputeOneEulerStep; dt 0.04; original integer wire muzzle/angle/velocity";
        result.prediction.terrain = "private full current Ground/stone clones; complete bitmap compare unchanged before request; never packed terrain or alpha summary";
        result.prediction.predictionOnly = true; result.prediction.damageAccepted = false;
      }
      clearPrediction();
      return result ? result : {blocked:"bounded pure prediction found no unused legal trajectory"};
    }
    private function closeShot(context:String):void {
      if (!activeShot) return;
      var added:int = ownBombCount - activeShot.bombsBefore, removed:int = ownBombRemoved - activeShot.removedBefore;
      if (added <= 0 || added != removed || selfShootCount <= activeShot.shootsBefore) return;
      var ownHit:Boolean = ownOtherPlayerHitCount > activeShot.ownHitsBefore, damage:Boolean = damageCount > activeShot.damageBefore;
      report({phase:"solo-shot-observation", turn:activeShot.turn, candidateIndex:activeShot.candidateIndex, context:context,
        ownProjectilesAdded:added, ownProjectilesRemoved:removed, anyDamageObserved:damage, ownOtherPlayerHitObserved:ownHit,
        outcome:ownHit ? "observed Self-owned hit and actual other-player blood decrease" : "no Self-owned other-player hit observed; miss or unproven hit"});
      ++completedShots; activeShot = null;
    }
    private function settlementResult():Object {
      var players:Array = [];
      for each (var living:Object in battlePlayers) {
        if (!living.expObj) return null; // GAME_OVER parsing belongs to the original action.
        var result:Object = {livingId:living.LivingID, userId:living.playerInfo.ID, isWin:living.isWin, exp:{}};
        if (typeof result.isWin != "boolean") throw new Error("original isWin is not readable");
        for each (var key:String in ["CurrentGP", "CurrentLevel", "GainGP", "GainOffer", "GetCardCount"]) {
          if (typeof living[key] != "number" || !isFinite(Number(living[key]))) throw new Error("original settlement field unavailable: " + key);
          result[key] = living[key];
        }
        for each (key in ["killGP", "hertGP", "fightGP", "gainGP", "gainOffer", "canTakeOut"]) {
          if (typeof living.expObj[key] != "number" || !isFinite(Number(living.expObj[key]))) throw new Error("original expObj field unavailable: " + key);
          result.exp[key] = living.expObj[key];
        }
        players.push(result);
      }
      if (players.length < 2 || !battleSelf || typeof battleGame.GainRiches != "number") throw new Error("original settlement players or GainRiches unavailable");
      return {players:players, GainRiches:battleGame.GainRiches, selfGetCardCount:battleSelf.GetCardCount,
        cardBranch:battleSelf.GetCardCount > 0 ? "original automatic free card" : "original no-card completion"};
    }
    private function battleStage(phase:String, value:Object, captureId:String = null):void {
      var expectedView:String = phase == "solo-exp-visible" ? "game.view.experience::ExpView" : phase == "solo-small-cards-visible" ? "game.view.card::SmallCardsView" :
        value.state == "fighting" ? "game.view::GameView" : value.state == "matchRoom" ? "room.view.roomView::MatchRoomView" :
        value.state == "roomlist" ? "roomList.pvpRoomList::RoomListView" : "hall::HallStateView";
      report({phase:phase, captureId:captureId ? captureId : phase, captureReady:!value.nextState,
        captureState:value.state, captureView:expectedView, snapshot:value});
    }
    private function battleTick(value:Object):void {
      observationContext = "battle:original public model and natural settlement";
      var states:Object = definition("ddt.manager.StateManager");
      if (!states || !battleSelf || !battleGame) throw new Error("original battle model is unavailable");
      if (gameOverSeen) clearPrediction();
      if (gameOverSeen && !battleResult) battleResult = settlementResult();
      if (gameOverSeen && battleResult) closeShot("original GAME_OVER settlement parsed");
      value.battle = battleSummary();
      var fighting:Boolean = value.state == "fighting" && !value.nextState && battleView != null;
      if (fighting) {
        if (selfShootCount > 0 && !ready["solo-self-shoot-observed"]) { ready["solo-self-shoot-observed"] = true; battleStage("solo-self-shoot-observed", value); }
        var ownVisible:Boolean = false;
        for (var bomb:Object in bombRecords) if (bombRecords[bomb].own && bomb.parent) ownVisible = true;
        if (ownVisible && !ready["solo-projectile-visible"]) { ready["solo-projectile-visible"] = true; battleStage("solo-projectile-visible", value); }
        if (ownBombRemoved > 0 && !ready["solo-projectile-finished"]) { ready["solo-projectile-finished"] = true; battleStage("solo-projectile-finished", value); }
        if (damageCount > 0 && !ready["solo-damage-observed"]) { ready["solo-damage-observed"] = true; battleStage("solo-damage-observed", value); }
        if (ownHitCount > 0 && !ready["solo-own-hit-observed"]) { ready["solo-own-hit-observed"] = true; battleStage("solo-own-hit-observed", value); }
        if (value.views.indexOf("game.view.experience::ExpView") >= 0 && !expSeen) { expSeen = true; battleStage("solo-exp-visible", value); }
        if (value.views.indexOf("game.view.card::SmallCardsView") >= 0 && !cardsSeen) { cardsSeen = true; battleStage("solo-small-cards-visible", value); }
      }
      // A received GAME_OVER permanently closes the firing branch, even while its action is queued.
      if (!gameOverSeen && fighting) {
        var map:Object = battleView.map, local:Object = battleSelf;
        if (!map || map.game != battleGame) throw new Error("original GameView.map differs from the observed game");
        shootingGate = {selfLivingId:local.LivingID, currentLivingId:battleGame.currentLiving ? battleGame.currentLiving.LivingID : null,
          mapCurrentPlayerLivingId:map.currentPlayer ? map.currentPlayer.LivingID : null, currentTurn:map.currentTurn,
          shootEnabled:local.shootEnabled, shootType:local.shootType, shootCount:local.shootCount,
          selfMoving:local.isMoving, mapMoving:map.hasSomethingMoving(), selfActionCount:local.actionCount,
          currentPlayerActionCount:map.currentPlayer ? map.currentPlayer.actionCount : null, mapActionCount:map.actionCount};
        for each (var flag:String in ["shootEnabled", "selfMoving", "mapMoving"])
          if (typeof shootingGate[flag] != "boolean") throw new Error("original shooting gate is not readable: " + flag);
        for each (var field:String in ["currentTurn", "shootType", "shootCount", "selfActionCount", "mapActionCount"])
          if (typeof shootingGate[field] != "number" || !isFinite(Number(shootingGate[field]))) throw new Error("original shooting gate is not readable: " + field);
        value.battle.shootingGate = shootingGate;
        var eligible:Boolean = counts.PLAYER_CHANGE > 0 && battleGame.currentLiving == local && map.currentPlayer == local &&
          local.playerInfo.ID == FIXTURE_ID && shootingGate.shootEnabled && shootingGate.shootType == 0 && shootingGate.shootCount > 0 &&
          !shootingGate.selfMoving && !shootingGate.mapMoving && shootingGate.selfActionCount == 0 && shootingGate.currentPlayerActionCount === 0 && shootingGate.mapActionCount == 0;
        if (eligible) {
          var turnNumber:Number = Number(map.currentTurn);
          if (!isFinite(turnNumber) || int(turnNumber) != turnNumber) throw new Error("original currentTurn is not readable");
          var turn:String = String(turnNumber);
          if (!firedTurns[turn] && !aimCheckedTurns[turn]) {
            if (qualifiedTurn != turn) { qualifiedTurn = turn; qualifiedTicks = 0; battleStage("solo-self-turn-ready", value, "solo-self-turn-ready-" + turn); }
            if (++qualifiedTicks >= 4) {
              closeShot("next original qualified and stationary Self turn");
              if (activeShot) return; // Wait for the previous original SHOOT and all own removals; never replace an unfinished observation.
              var aimState:Object = aimSnapshot(map), aim:Object = nextAim(aimState, map);
              if (aim.pending) return;
              aimCheckedTurns[turn] = true;
              value.battle.aim = aimState;
              if (aim.blocked) {
                if (lastAimBlock != aim.blocked) {
                  lastAimBlock = aim.blocked;
                  report({phase:"solo-aim-blocked", reason:aim.blocked, turn:turnNumber, snapshot:value,
                    captureReady:true, captureState:value.state, captureView:"game.view::GameView", publicDirectionChangeInvoked:false});
                }
                return;
              }
              lastAimBlock = "";
              aimState.prediction = aim.prediction;
              var force:Number = aim.force, beforeAngle:Number = aimState.gunAngle;
              if (!isFinite(force) || force <= 0 || force > 2000 || force > Number(local.maxForce)) throw new Error("original bounded force is unavailable");
              observationContext = "battle:original unlocked manuallySetGunAngle with legal readback";
              var changed:Boolean = local.manuallySetGunAngle(aim.gunAngle);
              var angle:Number = readableNumber(local, "gunAngle"), worldAngle:Number = local.calcBombAngle();
              if (angle != aim.gunAngle || !isFinite(worldAngle) || Math.abs(worldAngle - aim.worldAngle) > 0.000001 || local.direction != aimState.self.direction)
                throw new Error("original public aim readback differs; no shot sent");
              aimState.appliedGunAngle = angle; aimState.appliedWorldAngle = worldAngle;
              var predictedMuzzle:Object = aimState.muzzle;
              aimState.muzzle = pointSnapshot(originalPlayerObject(map, local).shootPoint());
              if (int(aimState.muzzle.x) != int(predictedMuzzle.x) || int(aimState.muzzle.y) != int(predictedMuzzle.y))
                throw new Error("actual original integer wire muzzle changed after public aim; no shot sent");
              var aimDx:Number = aimState.target.pos.x - aimState.muzzle.x;
              if (Math.cos(worldAngle * Math.PI / 180) * aimDx <= 0) throw new Error("actual aimed muzzle still faces away from target; no shot sent");
              if (!ready["solo-aim-ready"]) { ready["solo-aim-ready"] = true; battleStage("solo-aim-ready", value); }
              firedTurns[turn] = true;
              activeShot = {turn:turnNumber, candidateIndex:aim.index, gunAngle:angle, worldAngle:worldAngle, force:force,
                muzzle:aimState.muzzle, target:aimState.target, bombsBefore:ownBombCount, removedBefore:ownBombRemoved,
                shootsBefore:selfShootCount, damageBefore:damageCount, ownHitsBefore:ownOtherPlayerHitCount};
              report({phase:"solo-shoot-requested", turn:turnNumber, force:force, originalGunAngle:angle,
                beforeGunAngle:beforeAngle, worldAngle:worldAngle, candidateIndex:aim.index, publicAimChanged:changed, aim:aimState,
                owner:"LocalPlayer.manuallySetGunAngle then Player.beginShoot then LocalPlayer.sendShootAction",
                publicDirectionChangeInvoked:false, directShootPacket:false});
              local.beginShoot();
              if (gameOverSeen) throw new Error("GAME_OVER closed firing after beginShoot");
              local.sendShootAction(force);
              if (Number(local.gunAngle) != angle || local.direction != aimState.self.direction) throw new Error("original gun angle or direction changed during the public shooting call");
            }
          }
        } else { qualifiedTurn = ""; qualifiedTicks = 0; clearPrediction(); }
        return;
      }
      qualifiedTurn = ""; qualifiedTicks = 0;
      if (!gameOverSeen || value.nextState) { returnTicks = 0; return; }
      if (value.state == "matchRoom" && !sent.returnList && value.views.indexOf("room.view.roomView::MatchRoomView") >= 0) {
        if (!battleResult || !expSeen || !expComplete || !cardsSeen || !cardsComplete || (battleResult.selfGetCardCount > 0 && !selfTakeOutSeen))
          throw new Error("natural matchRoom return lacks the original settlement/card branch evidence");
        if (++returnTicks == 1) battleStage("solo-return-match-room", value);
        if (returnTicks >= 4) {
          if (states.getState("matchRoom").getBackType() != "roomlist") throw new Error("original matchRoom back consumer differs");
          sent.returnList = true; returnTicks = 0; states.back();
        }
      } else if (value.state == "roomlist" && sent.returnList && !sent.returnMain && value.views.indexOf("roomList.pvpRoomList::RoomListView") >= 0) {
        if (++returnTicks == 1) battleStage("solo-return-roomlist", value);
        if (returnTicks >= 4) {
          if (states.getState("roomlist").getBackType() != "main") throw new Error("original roomlist back consumer differs");
          sent.returnMain = true; returnTicks = 0; states.back();
        }
      } else if (value.state == "main" && sent.returnMain && value.views.indexOf("hall::HallStateView") >= 0) {
        // Wait for repeated natural HallStateView observations before requesting the passive image.
        if (++returnTicks == 8) battleStage("solo-return-main", value);
        if (returnTicks >= 16) {
          // closeShot above only closes on real SHOOT and matching natural projectile additions/removals.
          var requests:int = firedTurnCount();
          var chain:Boolean = requests > 0 && completedShots > 0 && completedShots == requests && activeShot == null &&
            selfShootCount > 0 && ownBombCount > 0 && ownBombCount == ownBombRemoved && gameOverSeen && battleResult != null && expSeen && expComplete && cardsSeen && cardsComplete;
          report({phase:"solo-battle-complete", scope:"original public API battle/settlement/return; UI input, visual and persistence acceptance excluded",
            publicApiBattleLifecycleObserved:chain, fullBattleAccepted:chain && damageCount > 0 && ownOtherPlayerHitCount > 0,
            visualAccepted:false, persistenceAccepted:false, snapshot:value}); timer.stop();
        }
      } else returnTicks = 0;
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
          if (!battleMode) { report({phase:"solo-complete", scope:"original ordinary arena public API path, natural loading and original components; visual review required", fullBattleAccepted:false, visualAccepted:false, snapshot:value}); timer.stop(); }
        }
        if (battleMode && ready["solo-fighting-ready"]) battleTick(value);
      } catch (error:Error) { fail(error.message, error); }
    }
  }
}
