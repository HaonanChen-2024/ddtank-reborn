package {
  import flash.display.Sprite;
  import flash.display.Loader;
  import flash.text.TextField;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.TimerEvent;
  import flash.external.ExternalInterface;
  import flash.net.URLRequest;
  import flash.net.URLVariables;
  import flash.system.ApplicationDomain;
  import flash.system.LoaderContext;
  import flash.utils.Timer;

  /** Internal integration probe: calls original public AS3 APIs; never simulates UI input. */
  [SWF(width="1000", height="600", frameRate="25", backgroundColor="#161822")]
  public class WorkshopProbe extends Sprite {
    private var client:Loader = new Loader();
    private var timer:Timer = new Timer(1000);
    private var domains:Array = [];
    private var action:String;
    private var previous:String = "";
    private var step:int = 0;
    private var ticks:int = 0;
    private var since:int = 0;
    private function showCharacterProbe():void {
      var players:Object = definition("ddt.manager.PlayerManager");
      var factory:Object = definition("ddt.view.character.CharactoryFactory");
      if (!players || !factory) throw new Error("original character factory unavailable");
      var panel:Sprite = new Sprite();
      panel.graphics.beginFill(0xeeeeee); panel.graphics.drawRect(0, 0, 600, 390); panel.graphics.endFill();
      panel.x = 200; panel.y = 100; stage.addChild(panel);
      var label:TextField = new TextField(); label.text = "Original ShowCharacter: stand / win"; label.width = 550; label.height = 30; panel.addChild(label);
      for (var i:int = 0; i < 2; i++) {
        var character:Object = factory.createCharacter(players.Instance.Self, "show", true);
        character.x = 35 + i * 290; character.y = 35;
        panel.addChild(character as Sprite);
        configureCharacter(character, i, players.Instance.Self.Style);
        character.show(true, 1, false);
      }
      report({phase:"show-character-requested", scope:"original-AS3-component-render", style:players.Instance.Self.Style});
    }
    private function configureCharacter(character:Object, pose:int, style:String):void {
      character.addEventListener(Event.COMPLETE, function(e:Event):void {
        character.doAction(pose);
        report({phase:"show-character-complete", pose:pose, style:style, width:character.characterWithWeapon.width, height:character.characterWithWeapon.height});
      });
    }

    public function WorkshopProbe() {
      if (stage) start(); else addEventListener(Event.ADDED_TO_STAGE, start);
    }
    private function report(value:Object):void {
      if (ExternalInterface.available) ExternalInterface.call("workshop_probe_report", value);
    }
    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      action = String(loaderInfo.parameters.probeAction || "observe");
      domains.push(ApplicationDomain.currentDomain);
      var vars:URLVariables = new URLVariables();
      for each (var key:String in ["user", "key", "config"]) vars[key] = loaderInfo.parameters[key];
      var request:URLRequest = new URLRequest(String(loaderInfo.parameters.probeClient) + "?" + vars.toString());
      client.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
        domains.push(client.contentLoaderInfo.applicationDomain);
        report({phase:"client-loaded"});
      });
      client.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void { report({phase:"load-error", text:e.text}); });
      addChild(client);
      client.load(request, new LoaderContext(false, ApplicationDomain.currentDomain));
      timer.addEventListener(TimerEvent.TIMER, tick);
      timer.start();
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
    private function tick(event:TimerEvent):void {
      ticks++;
      try {
        var states:Object = definition("ddt.manager.StateManager");
        if (!states) { if (ticks % 5 == 0) report({phase:"waiting-for-domain", tick:ticks}); return; }
        var state:String = String(states.currentStateType);
        if (state != previous) { report({phase:"state", state:state, tick:ticks}); previous = state; }
        if (action == "shop" && step == 0 && state == "main") {
          step = 1; states.setState("shop"); report({phase:"shop-requested"});
        }
        else if (action == "shop" && step == 1 && state == "shop") {
          step = 2; states.getState("shop").rightView.gotoPage(1, 0, 1, 1);
          report({phase:"shop-equipment-page-requested"});
        }
        if (action == "wardrobe" && step == 0 && state == "main") { step = 1; showCharacterProbe(); }
        if (action == "language" && step == 0 && state == "main") {
          step = 1;
          var language:Object = definition("ddt.manager.LanguageMgr");
          var alerts:Object = definition("com.pickgliss.ui.AlertManager");
          var translated:Array = [];
          for each (var word:String in ["gold", "money", "gift", "ok", "cancel"]) translated.push(language.GetTranslation(word));
          alerts.Instance.simpleAlert(language.GetTranslation("AlertDialog.Info"), translated.join(" / "), language.GetTranslation("ok"), language.GetTranslation("cancel"), true, false, true);
          report({phase:"original-language-alert", translations:translated});
        }
        if (action == "battle") {
          var out:Object = definition("ddt.manager.GameInSocketOut");
          if (step == 0 && state == "main") { step = 1; states.setState("roomlist"); }
          else if (step == 1 && state == "roomlist" && out) { step = 2; out.sendCreateRoom("WorkshopProbe", 0, 2, ""); }
          else if (step == 2 && state == "matchRoom" && out) {
            step = 3; since = ticks;
            out.sendGameRoomSetUp(1007, 0, false, "", "WorkshopProbe", 2, 0, 0, false, 0);
            report({phase:"room-created"});
          }
          else if (step == 3 && ticks - since >= 3 && out) { step = 4; out.sendGameStart(); report({phase:"match-requested"}); }
        }
      } catch (error:Error) {
        report({phase:"probe-error", text:error.message, tick:ticks});
        timer.stop();
      }
    }
  }
}
