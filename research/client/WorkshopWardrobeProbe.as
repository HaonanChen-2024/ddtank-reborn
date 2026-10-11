package {
  import flash.display.DisplayObject;
  import flash.display.DisplayObjectContainer;
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.TimerEvent;
  import flash.external.ExternalInterface;
  import flash.net.URLRequest;
  import flash.net.URLVariables;
  import flash.system.ApplicationDomain;
  import flash.system.LoaderContext;
  import flash.text.TextField;
  import flash.utils.getQualifiedClassName;
  import flash.utils.Timer;

  /** Isolated integration probe; wardrobe mode moves only its exact held suit and restores it. */
  [SWF(width="1000", height="600", frameRate="25", backgroundColor="#161822")]
  public class WorkshopWardrobeProbe extends Sprite {
    private var client:Loader = new Loader();
    private var timer:Timer = new Timer(1000);
    private var domains:Array = [];
    private var ticks:int = 0;
    private var step:int = 0;
    private var openedAt:int = 0;
    private var previous:String = "";
    private var originalStyle:String = "";
    private var itemID:int = 0;
    private var originalHide:int = 0;
    private var changedAt:int = 0;
    private var tip:Object;
    private var mixed:Boolean = false;
    private var expectedUserID:int = 0;
    private var expectedItemID:int = 0;
    private var expectedTemplateID:int = 0;
    private var expectedPic:String = "";

    public function WorkshopWardrobeProbe() {
      if (stage) start(); else addEventListener(Event.ADDED_TO_STAGE, start);
    }
    private function report(value:Object):void {
      if (ExternalInterface.available) ExternalInterface.call("workshop_probe_report", value);
    }
    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      mixed = loaderInfo.parameters.probeAction == "wardrobe";
      expectedUserID = int(loaderInfo.parameters.probeUserId);
      expectedItemID = int(loaderInfo.parameters.probeItemId);
      expectedTemplateID = int(loaderInfo.parameters.probeTemplateId);
      expectedPic = String(loaderInfo.parameters.probePic || "");
      if (expectedUserID <= 0 || expectedItemID <= 0 || expectedTemplateID <= 0 || !expectedPic) {
        report({phase:"wardrobe-probe-error", text:"exact fixture identity parameters required", inventoryWrites:false}); return;
      }
      domains.push(ApplicationDomain.currentDomain);
      var vars:URLVariables = new URLVariables();
      for each (var key:String in ["user", "key", "config"]) vars[key] = loaderInfo.parameters[key];
      var request:URLRequest = new URLRequest(String(loaderInfo.parameters.probeClient) + "?" + vars.toString());
      client.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
        domains.push(client.contentLoaderInfo.applicationDomain);
        report({phase:"wardrobe-client-loaded", inventoryWrites:false});
      });
      client.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void {
        report({phase:"wardrobe-load-error", text:e.text}); timer.stop();
      });
      addChild(client);
      client.load(request, new LoaderContext(false, ApplicationDomain.currentDomain));
      timer.addEventListener(TimerEvent.TIMER, tick); timer.start();
    }
    private function definition(name:String):Object {
      for each (var domain:ApplicationDomain in domains) {
        if (domain.hasDefinition(name)) return domain.getDefinition(name);
        if (domain.hasDefinition("com.pickgliss.loader.DisplayLoader")) {
          var loader:Object = domain.getDefinition("com.pickgliss.loader.DisplayLoader");
          var ui:ApplicationDomain = loader.Context.applicationDomain;
          if (ui && ui.hasDefinition(name)) return ui.getDefinition(name);
        }
      }
      return null;
    }
    private function dismissOptionalStorage(container:DisplayObjectContainer):void {
      for (var i:int = container.numChildren - 1; i >= 0; i--) {
        // Frame.dispose can also remove its sibling modal background from this layer.
        if (i >= container.numChildren) continue;
        var child:DisplayObject = container.getChildAt(i);
        if (getQualifiedClassName(child) == "hall::SaveFileWidow") {
          Object(child).dispose();
          report({phase:"optional-storage-popup-disposed", publicMethod:"hall.SaveFileWidow.dispose", cachePermissionChanged:false});
        } else if (child is DisplayObjectContainer) dismissOptionalStorage(child as DisplayObjectContainer);
      }
    }
    private function visibleEvidence(container:DisplayObjectContainer, texts:Array, components:Array, visible:Boolean = true):void {
      for (var i:int = 0; i < container.numChildren; i++) {
        var child:DisplayObject = container.getChildAt(i);
        var shown:Boolean = visible && child.visible && child.alpha > 0;
        var type:String = getQualifiedClassName(child);
        if (shown && (type.indexOf("BagAndGiftFrame") >= 0 || type.indexOf("PlayerInfoView") >= 0 || type.indexOf("RoomCharacter") >= 0 || type.indexOf("GoodTip") >= 0)) {
          components.push({type:type, width:child.width, height:child.height});
        }
        if (shown && child is TextField && TextField(child).text && texts.length < 120) {
          var field:TextField = child as TextField;
          texts.push({text:field.text, font:field.defaultTextFormat.font, embedFonts:field.embedFonts, width:field.width, textWidth:field.textWidth});
        }
        if (child is DisplayObjectContainer) visibleEvidence(child as DisplayObjectContainer, texts, components, shown);
      }
    }
    private function roomCharacter(container:DisplayObjectContainer):Object {
      for (var i:int = 0; i < container.numChildren; i++) {
        var child:DisplayObject = container.getChildAt(i);
        if (child.visible && getQualifiedClassName(child) == "ddt.view.character::RoomCharacter") return child;
        if (child.visible && child is DisplayObjectContainer) {
          var found:Object = roomCharacter(child as DisplayObjectContainer);
          if (found) return found;
        }
      }
      return null;
    }
    private function appearance(self:Object):Object {
      return {style:self.Style, hide:self.Hide, hatHidden:self.getHatHide(), glassHidden:self.getGlassHide(),
        suitHidden:self.getSuitesHide(), showSuits:self.getShowSuits(), hairType:self.getHairType(), suitsType:self.getSuitsType()};
    }
    private function ownSuit(self:Object):Object {
      for each (var item:Object in self.Bag.findItems(13, false)) if (exactSuit(self, item)) return item;
      return null;
    }
    private function exactSuit(self:Object, item:Object):Boolean {
      return self.ID == expectedUserID && item && item.ItemID == expectedItemID &&
        item.TemplateID == expectedTemplateID && item.Pic == expectedPic && item.Count == 1;
    }
    private function tick(event:TimerEvent):void {
      ticks++;
      try {
        var states:Object = definition("ddt.manager.StateManager");
        if (!states) { if (ticks % 5 == 0) report({phase:"wardrobe-waiting-domain", tick:ticks}); return; }
        var state:String = String(states.currentStateType);
        if (state != previous) { report({phase:"wardrobe-state", state:state, tick:ticks}); previous = state; }
        if (state != "main") return;
        var layers:Object = definition("com.pickgliss.ui.LayerManager");
        if (layers) dismissOptionalStorage(layers.Instance.getLayerByType(layers.GAME_TOP_LAYER) as DisplayObjectContainer);
        var players:Object = definition("ddt.manager.PlayerManager");
        var bags:Object = definition("bagAndInfo.BagAndInfoManager");
        if (!players || !bags) throw new Error("original public player/bag manager unavailable");
        var self:Object = players.Instance.Self;
        if (self.ID != expectedUserID) throw new Error("player differs from exact private fixture; refusing inventory action");
        if (step == 0) {
          var equipped:Object = self.Bag.getItemAt(11);
          if (!exactSuit(self, equipped) || equipped.Place != 11) throw new Error("expected exact isolated held suit absent; refusing any inventory action");
          itemID = equipped.ItemID; originalStyle = self.Style; originalHide = self.Hide;
          step = 1; openedAt = ticks;
          bags.Instance.showBagAndInfo(0);
          report({phase:"original-bag-requested", playerID:self.ID, itemID:itemID, templateID:equipped.TemplateID, name:equipped.Name, pic:equipped.Pic, count:equipped.Count, place:equipped.Place, style:originalStyle, inventoryWrites:false});
        } else if (step == 1 && bags.Instance.isShown && ticks - openedAt >= 3) {
          var tipClass:Class = definition("ddt.view.tips.GoodTip") as Class;
          if (!tipClass) throw new Error("original GoodTip unavailable after BAG module load");
          tip = new tipClass();
          tip.showTip(self.Bag.getItemAt(11));
          tip.x = 720; tip.y = 55; stage.addChild(tip as DisplayObject);
          step = 2;
          report({phase:"original-inventory-tooltip-shown", name:self.Bag.getItemAt(11).Name, publicMethod:"GoodTip.showTip", inventoryWrites:false});
        } else if (step == 2 && ticks - openedAt >= 10) {
          var texts:Array = [], components:Array = [];
          visibleEvidence(stage, texts, components);
          var held:Object = self.Bag.getItemAt(11);
          if (!exactSuit(self, held) || held.Place != 11 || self.Style != originalStyle) throw new Error("held client inventory/style changed during readonly probe");
          report({phase:"original-inventory-observed", itemID:itemID, templateID:held.TemplateID, place:held.Place, name:held.Name, style:self.Style, gold:self.Gold, money:self.Money, components:components, texts:texts, inventoryWrites:false, mixedPartsAccepted:false, scope:"original-public-bag-and-tooltip-visible; screenshot must be inspected separately"});
          if (!mixed) { step = 8; timer.stop(); }
          else {
            if (tip.parent) tip.parent.removeChild(tip as DisplayObject);
            var sockets:Object = definition("ddt.manager.SocketManager");
            if (!sockets) throw new Error("original public socket manager unavailable");
            // Same public call as PlayerInfoView's unequip handler; no hand-built server messages.
            sockets.Instance.out.sendMoveGoods(0, 11, 0, -1, 1);
            changedAt = ticks; step = 3;
            report({phase:"original-public-unequip-requested", itemID:itemID, publicMethod:"SocketManager.out.sendMoveGoods", appearance:appearance(self)});
          }
        } else if (step == 3) {
          var off:Object = ownSuit(self);
          var character:Object = roomCharacter(stage);
          if (off && off.Place >= 31 && !self.Bag.getItemAt(11) && self.Style.indexOf(expectedTemplateID + "|" + expectedPic) < 0 &&
              character && character.completed && ticks - changedAt >= 8) {
            if (self.Hide != originalHide) throw new Error("original Hide changed externally");
            var mixedTexts:Array = [], mixedComponents:Array = [];
            visibleEvidence(stage, mixedTexts, mixedComponents);
            report({phase:"original-mixed-observed", itemID:itemID, place:off.Place, appearance:appearance(self),
              characterCompleted:character.completed, components:mixedComponents, texts:mixedTexts, inventoryWrites:true,
              scope:"original inventory after public unequip; passive screenshot required; restoring next"});
            changedAt = ticks; step = 4;
          } else if (ticks - changedAt > 25) throw new Error("public unequip or original mixed character completion timed out");
        } else if (step == 4 && ticks - changedAt >= 8) {
          off = ownSuit(self);
          if (!exactSuit(self, off) || off.Place < 31 || self.Bag.getItemAt(11))
            throw new Error("refusing equip: exact owned suit or empty slot contract changed");
          sockets = definition("ddt.manager.SocketManager");
          sockets.Instance.out.sendMoveGoods(0, off.Place, 0, 11, 1);
          changedAt = ticks; step = 5;
          report({phase:"original-public-reequip-requested", itemID:itemID, from:off.Place, publicMethod:"SocketManager.out.sendMoveGoods"});
        } else if (step == 5) {
          held = self.Bag.getItemAt(11); character = roomCharacter(stage);
          if (exactSuit(self, held) && held.Place == 11 && self.Style == originalStyle && self.Hide == originalHide &&
              character && character.completed && ticks - changedAt >= 8) {
            report({phase:"original-mixed-restored", itemID:itemID, place:held.Place, appearance:appearance(self),
              characterCompleted:character.completed, gold:self.Gold, money:self.Money, inventoryWrites:true,
              scope:"public unequip and equip server responses plus original RoomCharacter; no new parts or hide changes"});
            step = 8; timer.stop();
          } else if (ticks - changedAt > 25) throw new Error("public re-equip or original character completion timed out");
        }
      } catch (error:Error) {
        report({phase:"wardrobe-probe-error", text:error.message, tick:ticks, inventoryWrites:mixed && step >= 3,
          recovery:"controller must read exact fixture state and restore or roll back normally"}); timer.stop();
      }
    }
  }
}
