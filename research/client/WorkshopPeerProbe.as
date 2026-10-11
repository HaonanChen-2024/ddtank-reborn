package {
  import flash.display.Sprite;
  import flash.display.Loader;
  import flash.display.DisplayObjectContainer;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.TimerEvent;
  import flash.external.ExternalInterface;
  import flash.net.URLRequest;
  import flash.net.URLVariables;
  import flash.system.ApplicationDomain;
  import flash.system.LoaderContext;
  import flash.utils.Timer;
  import flash.utils.getQualifiedClassName;

  /** Two-client test entry: original public client APIs, no synthetic keyboard/mouse events. */
  [SWF(width="1000", height="600", frameRate="25", backgroundColor="#161822")]
  public class WorkshopPeerProbe extends Sprite {
    private var client:Loader = new Loader();
    private var timer:Timer = new Timer(1000);
    private var domains:Array = [];
    private var hooked:Boolean = false;
    private var rawHooked:Boolean = false;
    private var peer:String;
    private var watchedPeer:int;
    private var rawCounts:Object = {};
    private var questIDs:Object = {};
    private var views:Array = [];
    public function WorkshopPeerProbe() {
      if (stage) start(); else addEventListener(Event.ADDED_TO_STAGE, start);
    }
    private function report(value:Object):void {
      value.peer = peer;
      if (ExternalInterface.available) ExternalInterface.call("workshop_peer_report", value);
    }
    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      peer = String(loaderInfo.parameters.peer);
      domains.push(ApplicationDomain.currentDomain);
      if (ExternalInterface.available) ExternalInterface.addCallback("workshopPeerCommand", command);
      var vars:URLVariables = new URLVariables();
      for each (var key:String in ["user", "key", "config"]) vars[key] = loaderInfo.parameters[key];
      client.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
        domains.push(client.contentLoaderInfo.applicationDomain); report({phase:"client-loaded"});
      });
      client.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void { report({phase:"load-error", text:e.text}); });
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
    private function command(value:Object):void {
      try {
        var states:Object = definition("ddt.manager.StateManager");
        var out:Object = definition("ddt.manager.GameInSocketOut");
        var socket:Object = definition("ddt.manager.SocketManager");
        if (!states || !out || !socket) throw new Error("original public APIs not loaded");
        switch (String(value.action)) {
          case "state": states.setState(String(value.state)); break;
          case "observe-peer": watchedPeer = int(value.peerId); break;
          case "challenge":
            var people:Object = definition("ddt.manager.PlayerManager");
            var tips:Object = definition("ddt.manager.PlayerTipManager");
            var tip:Object = definition("ddt.view.tips.PlayerTip");
            var target:Object = people.Instance.findPlayer(int(value.peerId));
            if (people.Instance.Self.Grade < 12 || target.Grade < 4 || target.ID == people.Instance.Self.ID || states.currentStateType != "roomlist") throw new Error("original Freedom challenge preconditions not met");
            tips.instance.playerInfo = target;
            tips.instance.dispatchEvent(new Event(tip.CHALLENGE)); break;
          case "join": socket.Instance.out.sendGameLogin(1, -1, int(value.room), "", false); break;
          case "setup": out.sendGameRoomSetUp(1007, 1, false, "", "WorkshopPeers", 2, 0, 0, false, 0); break;
          case "ready": out.sendPlayerState(1); break;
          case "start": out.sendGameStart(); break;
          case "load":
            var game:Object = definition("game.GameManager");
            if (!game || !game.Instance.Current || game.Instance.Current.mapIndex != 1007) throw new Error("actual GAME_LOAD model not ready");
            states.setState("roomLoading", game.Instance.Current); break;
          case "fire":
            out.sendGameCMDDirection(int(value.direction)); out.sendShootTag(true, 2);
            out.sendGameCMDShoot(int(value.x), int(value.y), int(value.force), int(value.angle)); break;
          case "skip": out.sendGameSkipNext(1); break;
          case "exit": out.sendGamePlayerExit(); socket.Instance.out.sendSceneLogin(1); states.setState("main"); break;
          default: throw new Error("unknown bounded peer command");
        }
        report({phase:"command", action:value.action, turn:value.turn});
      } catch (error:Error) { report({phase:"command-error", action:value.action, text:error.message}); }
    }
    private function packet(event:Object):void {
      var pkg:Object = event.pkg;
      var position:uint = pkg.position;
      try {
        var bytes:Array = []; pkg.position = 0;
        while (pkg.position < pkg.length) bytes.push(pkg.readUnsignedByte());
        report({phase:"packet", event:event.type, bytes:bytes});
      } finally { pkg.position = position; }
    }
    private function rawPacket(event:Object):void {
      var pkg:Object = event.data;
      var code:int = pkg.code;
      if ([18, 19, 69, 176, 178, 181].indexOf(code) < 0) return;
      rawCounts[code] = int(rawCounts[code]) + 1;
      var position:uint = pkg.position;
      try {
        var value:Object = {phase:"raw-in", code:code, clientId:pkg.clientId, length:pkg.length, occurrence:rawCounts[code]};
        pkg.position = 20;
        if (code == 18) value.grade = pkg.readInt();
        if (code == 178) {
          var count:int = pkg.readInt();
          value.questCount = count; value.quests = [];
          var task:Object = definition("ddt.manager.TaskManager");
          if (count < 0 || count > 10000) throw new Error("bounded QUEST_UPDATE count invalid");
          for (var i:int = 0; i < count; i++) {
            var id:int = pkg.readInt(); questIDs[id] = true;
            var q:Object = task ? task.getQuestByID(id) : null;
            value.quests.push({id:id, definitionPresent:q != null, dataPresent:q != null && q.data != null});
            pkg.position += 33; // bool, four i32, seven-byte date, two i32, bool.
          }
        }
        if (int(rawCounts[code]) <= 200) report(value);
      } catch (error:Error) { report({phase:"raw-inspection-error", code:code, text:error.message}); }
      finally { pkg.position = position; }
    }
    private function dismissOptionalStorage(container:DisplayObjectContainer):void {
      for (var i:int = container.numChildren - 1; i >= 0; i--) {
        // Frame.dispose may also remove its sibling modal background during traversal.
        if (i >= container.numChildren) continue;
        var child:Object = container.getChildAt(i);
        var qualified:String = getQualifiedClassName(child);
        if (child.visible && child.width > 0 && child.height > 0 && (qualified == "hall::HallStateView" || qualified == "game.view::GameView" || qualified.indexOf("::RoomListView") >= 0 || qualified.indexOf("::ChallengeRoomView") >= 0 || qualified.indexOf("::RoomLoadingView") >= 0)) views.push(qualified);
        if (qualified == "hall::SaveFileWidow") {
          child.dispose();
          report({phase:"optional-storage-dismissed", scope:"original public dispose only; cache permission unchanged"});
        } else if (child is DisplayObjectContainer) dismissOptionalStorage(child as DisplayObjectContainer);
      }
    }
    private function tick(event:TimerEvent):void {
      try {
        var states:Object = definition("ddt.manager.StateManager");
        if (!states) return;
        views = [];
        dismissOptionalStorage(stage);
        var sockets:Object = definition("ddt.manager.SocketManager");
        var events:Object = definition("ddt.events.CrazyTankSocketEvent");
        if (!hooked && sockets && events) {
          for each (var name:String in ["GAME_ROOM_CREATE", "GAME_ROOM_LOGIN", "GAME_CREATE", "GAME_LOAD", "GAME_START", "PLAYER_CHANGE", "PLAYER_SHOOT", "GAME_OVER", "GAME_TAKE_OUT"])
            sockets.Instance.addEventListener(events[name], packet, false, 100);
          hooked = true; report({phase:"event-hooks-ready"});
        }
        var socketEvent:Object = definition("road7th.comm.SocketEvent");
        if (!rawHooked && sockets && socketEvent) {
          sockets.Instance.socket.addEventListener(socketEvent.DATA, rawPacket, false, 100);
          rawHooked = true; report({phase:"raw-hooks-ready", scope:"original incoming DATA, selected codes, position restored"});
        }
        var rooms:Object = definition("room.RoomManager");
        var players:Object = definition("ddt.manager.PlayerManager");
        var games:Object = definition("game.GameManager");
        var value:Object = {phase:"state", state:String(states.currentStateType), width:client.width, height:client.height};
        value.originalViews = views; value.roomListRendered = views.indexOf("roomList.pvpRoomList::RoomListView") >= 0;
        value.mainRendered = views.indexOf("hall::HallStateView") >= 0; value.rawHooksReady = rawHooked;
        value.fightingRendered = views.indexOf("game.view::GameView") >= 0;
        value.rawCounts = rawCounts;
        value.inGameSteps = [];
        for (var step:int = 1; step <= 8; step++) value.inGameSteps.push(states["getInGame_Step_" + step]);
        if (states.nextState) value.nextState = states.nextState.getType();
        if (players) { value.userId = players.Instance.Self.ID; value.weapon = players.Instance.Self.WeaponID; value.grade = players.Instance.Self.Grade; value.gp = players.Instance.Self.GP; value.zone = players.Instance.Self.ZoneID; }
        if (players && watchedPeer) { var target:Object = players.Instance.findPlayer(watchedPeer); value.targetId = target.ID; value.targetGrade = target.Grade; value.targetZone = target.ZoneID; value.targetName = target.NickName; }
        var tasks:Object = definition("ddt.manager.TaskManager");
        if (tasks) {
          var questCount:int = 0;
          for each (var quest:Object in tasks.allQuests) questCount++;
          value.questDefinitionCount = questCount; value.observedQuestData = [];
          for (var questID:String in questIDs) {
            var info:Object = tasks.getQuestByID(int(questID));
            if (value.observedQuestData.length < 64) value.observedQuestData.push({id:int(questID), definitionPresent:info != null, dataPresent:info != null && info.data != null});
          }
        }
        if (rooms && rooms.Instance.current) {
          value.roomId = rooms.Instance.current.ID;
          value.map = rooms.Instance.current.mapId;
          value.roomType = rooms.Instance.current.type;
          value.timeType = rooms.Instance.current.timeType;
          value.players = rooms.Instance.current.players.list.length;
          if (rooms.Instance.current.selfRoomPlayer) value.ready = rooms.Instance.current.selfRoomPlayer.isReady;
        }
        if (games && games.Instance.Current) {
          value.gameMap = games.Instance.Current.mapIndex;
          value.gameRoomType = games.Instance.Current.roomType;
          if (games.Instance.Current.selfGamePlayer) value.livingId = games.Instance.Current.selfGamePlayer.LivingID;
        }
        report(value);
      } catch (error:Error) { report({phase:"probe-error", text:error.message}); }
    }
  }
}
