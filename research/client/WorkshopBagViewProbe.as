package {
  import flash.display.DisplayObject;
  import flash.display.DisplayObjectContainer;
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.TimerEvent;
  import flash.external.ExternalInterface;
  import flash.geom.Point;
  import flash.geom.Rectangle;
  import flash.net.URLRequest;
  import flash.net.URLVariables;
  import flash.system.ApplicationDomain;
  import flash.system.LoaderContext;
  import flash.text.TextField;
  import flash.utils.getQualifiedClassName;
  import flash.utils.Timer;

  /** Original bag or passive hall view on an exact private fixture; no input or inventory commands. */
  [SWF(width="1000", height="600", frameRate="25", backgroundColor="#161822")]
  public class WorkshopBagViewProbe extends Sprite {
    private var client:Loader = new Loader();
    private var timer:Timer = new Timer(500);
    private var domains:Array = [ApplicationDomain.currentDomain];
    private var expectedUserID:int;
    private var view:String = "bag";
    private var ticks:int = 0;
    private var openedAt:int = 0;
    private var original:String;
    public function WorkshopBagViewProbe() {
      if (stage) start(); else addEventListener(Event.ADDED_TO_STAGE, start);
    }
    private function report(value:Object):void {
      value.inventoryWrites = false; value.simulatedInput = false;
      value.originalClientComponents = true;
      if (ExternalInterface.available) ExternalInterface.call("workshop_probe_report", value);
    }
    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      expectedUserID = int(loaderInfo.parameters.probeUserId);
      if (expectedUserID <= 0) throw new Error("exact private fixture required");
      if (loaderInfo.parameters.probeView) view = String(loaderInfo.parameters.probeView);
      if (view != "bag" && view != "hall") throw new Error("probe view must be bag or hall");
      var vars:URLVariables = new URLVariables();
      for each (var key:String in ["user", "key", "config"]) vars[key] = loaderInfo.parameters[key];
      client.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
        domains.push(client.contentLoaderInfo.applicationDomain);
        report({phase:view + "-client-loaded"});
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
    private function fail(message:String):void {
      report({phase:"official-probe-error", text:message}); timer.stop();
    }
    private function fingerprint(player:Object):String {
      return JSON.stringify({id:player.ID, style:player.Style, colors:player.Colors, hide:player.Hide,
        gold:player.Gold, money:player.Money, grade:player.Grade, gp:player.GP});
    }
    private function dismissOptionalStorage(container:DisplayObjectContainer):void {
      for (var i:int = container.numChildren - 1; i >= 0; --i) {
        if (i >= container.numChildren) continue;
        var child:DisplayObject = container.getChildAt(i);
        if (getQualifiedClassName(child) == "hall::SaveFileWidow") {
          Object(child).dispose(); report({phase:"optional-storage-popup-disposed", cachePermissionChanged:false});
        } else if (child is DisplayObjectContainer) dismissOptionalStorage(child as DisplayObjectContainer);
      }
    }
    private function inspect(container:DisplayObjectContainer, texts:Array, components:Array, checks:Array, visible:Boolean = true):void {
      for (var i:int = 0; i < container.numChildren; ++i) {
        var child:DisplayObject = container.getChildAt(i);
        var shown:Boolean = visible && child.visible && child.alpha > 0;
        var type:String = getQualifiedClassName(child);
        var rect:Rectangle = child.getBounds(stage);
        if (shown && (view == "hall" ? type == "hall::HallStateView" || type == "ddt.view::MainToolBar" || type.indexOf("RoomCharacter") >= 0 :
          type.indexOf("BagAndGiftFrame") >= 0 || type.indexOf("PlayerInfoView") >= 0 || type.indexOf("RoomCharacter") >= 0)) {
          components.push({kind:type, completed:type.indexOf("RoomCharacter") < 0 || Object(child).completed,
            x:rect.x, y:rect.y, width:rect.width, height:rect.height});
        }
        if (shown && type.indexOf("SelectedCheckButton") >= 0) {
          var point:Point = child.localToGlobal(new Point());
          checks.push({type:type, text:buttonText(child as DisplayObjectContainer), x:point.x, y:point.y,
            width:child.width, height:child.height, bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}});
        }
        if (shown && view == "hall" && ((child is Sprite && Sprite(child).buttonMode) ||
          child.name.indexOf("txt_") == 0 || type.indexOf("Button") >= 0)) {
          var hallPoint:Point = child.localToGlobal(new Point());
          checks.push({type:type, name:child.name, text:buttonText(child as DisplayObjectContainer),
            buttonMode:child is Sprite && Sprite(child).buttonMode,
            x:hallPoint.x, y:hallPoint.y, width:child.width, height:child.height,
            bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}});
        }
        if (shown && child is TextField && TextField(child).text && texts.length < 240) {
          var field:TextField = child as TextField;
          texts.push({text:field.text,font:field.defaultTextFormat.font,embedFonts:field.embedFonts,
            x:rect.x,y:rect.y,width:field.width,height:field.height,textWidth:field.textWidth,textHeight:field.textHeight});
        }
        if (child is DisplayObjectContainer) inspect(child as DisplayObjectContainer, texts, components, checks, shown);
      }
    }
    private function buttonText(container:DisplayObjectContainer):String {
      if (!container) return "";
      for (var i:int = 0; i < container.numChildren; ++i) {
        var child:DisplayObject = container.getChildAt(i);
        if (child is TextField && TextField(child).text) return TextField(child).text;
        if (child is DisplayObjectContainer) {
          var nested:String = buttonText(child as DisplayObjectContainer);
          if (nested) return nested;
        }
      }
      return "";
    }
    private function tick(event:TimerEvent):void {
      ++ticks;
      try {
        if (ticks > 240) throw new Error("original " + view + " rendering deadline");
        var states:Object = definition("ddt.manager.StateManager");
        if (!states || String(states.currentStateType) != "main") return;
        var players:Object = definition("ddt.manager.PlayerManager");
        var bags:Object = view == "bag" ? definition("bagAndInfo.BagAndInfoManager") : null;
        if (!players || (view == "bag" && !bags)) throw new Error("original player/" + view + " manager unavailable");
        var self:Object = players.Instance.Self;
        if (self.ID != expectedUserID) throw new Error("player differs from exact private fixture");
        if (!openedAt) {
          var layers:Object = definition("com.pickgliss.ui.LayerManager");
          if (layers) dismissOptionalStorage(layers.Instance.getLayerByType(layers.GAME_TOP_LAYER) as DisplayObjectContainer);
          original = fingerprint(self); openedAt = ticks;
          if (view == "bag") {
            bags.Instance.showBagAndInfo(0);
            report({phase:"original-bag-requested", playerID:self.ID, publicMethod:"BagAndInfoManager.showBagAndInfo"});
          } else report({phase:"original-hall-observed", playerID:self.ID, state:String(states.currentStateType)});
          return;
        }
        if (fingerprint(self) != original) throw new Error("Self changed during passive " + view + " rendering");
        if (ticks - openedAt < 16 || (view == "bag" && !bags.Instance.isShown)) return;
        layers = definition("com.pickgliss.ui.LayerManager");
        if (layers) dismissOptionalStorage(layers.Instance.getLayerByType(layers.GAME_TOP_LAYER) as DisplayObjectContainer);
        var texts:Array = [], components:Array = [], checks:Array = [];
        inspect(stage, texts, components, checks);
        var complete:Boolean = view == "bag" && components.length >= 3 && checks.length >= 4;
        if (view == "hall") {
          for each (var hall:Object in components) {
            if (hall.kind == "hall::HallStateView" && hall.width > 0 && hall.height > 0) complete = true;
          }
        }
        for each (var component:Object in components) if (!component.completed) complete = false;
        if (!complete) return;
        var features:Object = {grade:self.Grade, gp:self.GP};
        var guides:Object = definition("trainer.controller.WeakGuildManager");
        var steps:Object = definition("trainer.data.Step");
        if (view == "bag" && guides && steps) {
          features.arenaGuideOpen = guides.Instance.checkOpen(steps.GAME_ROOM_OPEN, 2);
          features.dungeonGuideOpen = guides.Instance.checkOpen(steps.DUNGEON_OPEN, 8);
        }
        // Avoid the original insufficient-level popup when the read-only fixture is below its unchanged gate.
        if (view == "bag") features.dungeonAllowed = self.Grade >= 8 && players.Instance.checkEnterDungeon;
        report({phase:"official-frame-ready", job:0, templateID:0, dye:false, hair:0,
          components:components, texts:texts, checks:checks, features:features, selfUnchanged:true,
          scope:view == "hall" ? "original passive main hall and measured controls; visual review required; no input or gameplay acceptance" :
            "original complete bag view and measured controls; visual review required; no input or gameplay acceptance"});
        report({phase:"official-render-complete", jobs:1, selfUnchanged:true}); timer.stop();
      } catch (error:Error) { fail(error.message); }
    }
  }
}
