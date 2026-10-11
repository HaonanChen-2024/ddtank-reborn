package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.DisplayObject;
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.TimerEvent;
  import flash.external.ExternalInterface;
  import flash.geom.Matrix;
  import flash.geom.Rectangle;
  import flash.net.URLRequest;
  import flash.net.URLVariables;
  import flash.system.ApplicationDomain;
  import flash.system.LoaderContext;
  import flash.text.TextField;
  import flash.text.TextFormat;
  import flash.utils.Timer;
  import flash.utils.getQualifiedClassName;

  /** Passive original-client renderer. Never sends a game command or modifies Self. */
  [SWF(width="1000", height="600", frameRate="25", backgroundColor="#161822")]
  public class WorkshopOfficialWardrobeProbe extends Sprite {
    private var client:Loader = new Loader();
    private var module:Loader = new Loader();
    private var timer:Timer = new Timer(250);
    private var domains:Array = [ApplicationDomain.currentDomain];
    private var jobs:Array = [];
    private var expectedUserID:int;
    private var self:Object;
    private var original:Object;
    private var panel:Sprite;
    private var members:Array = [];
    private var itemIndex:int = -1;
    private var ticks:int = 0;
    private var startedAt:int = 0;
    private var reportedAt:int = 0;
    private var moduleStarted:Boolean = false;
    private var moduleReady:Boolean = false;
    private var initialized:Boolean = false;
    private var awaitingCapture:Boolean = false;
    private var jobInfo:Object;

    public function WorkshopOfficialWardrobeProbe() {
      if (stage) start(); else addEventListener(Event.ADDED_TO_STAGE, start);
    }
    private function report(value:Object):void {
      value.inventoryWrites = false;
      value.originalClientComponents = true;
      value.offlineImageComposition = false;
      if (ExternalInterface.available) ExternalInterface.call("workshop_probe_report", value);
    }
    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      expectedUserID = int(loaderInfo.parameters.probeUserId);
      var parts:Array = JSON.parse(String(loaderInfo.parameters.probeTemplates)) as Array;
      if (expectedUserID <= 0 || !parts || !parts.length) throw new Error("exact private fixture and templates required");
      for each (var part:Object in parts) {
        if (String(loaderInfo.parameters.probeBaseline) == "true") {
          jobs.push({part:part, dye:false, hair:0, baseline:true}); continue;
        }
        jobs.push({part:part, dye:false, hair:0});
        jobs.push({part:part, dye:true, hair:0});
        if (int(part.categoryId) == 3) {
          jobs.push({part:part, dye:false, hair:1});
          jobs.push({part:part, dye:true, hair:1});
        }
      }
      var vars:URLVariables = new URLVariables();
      for each (var key:String in ["user", "key", "config"]) vars[key] = loaderInfo.parameters[key];
      client.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
        domains.push(client.contentLoaderInfo.applicationDomain);
        report({phase:"official-client-loaded"});
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
    private function fail(text:String):void {
      report({phase:"official-probe-error", text:text, job:itemIndex}); timer.stop();
    }
    private function fingerprint(player:Object):Object {
      return {id:player.ID, style:player.Style, privateStyle:player.getPrivateStyle(), colors:player.Colors,
        hide:player.Hide, sex:player.Sex, gold:player.Gold, money:player.Money};
    }
    private function invariant():void {
      if (JSON.stringify(fingerprint(self)) != JSON.stringify(original)) throw new Error("original Self changed during passive rendering");
    }
    private function label(text:String, x:Number, y:Number, width:Number = 970):void {
      var field:TextField = new TextField(); field.defaultTextFormat = new TextFormat("Noto Sans SC", 13, 0xffffff);
      field.text = text; field.width = width; field.height = 24; field.x = x; field.y = y; panel.addChild(field);
    }
    private function dyeColors(job:Object):String {
      var items:Object = definition("ddt.manager.ItemManager");
      var template:Object = items.Instance.getTemplateById(int(job.part.id));
      if (!template) throw new Error("dye template unavailable");
      var layers:int = String(template.Property8).length;
      if (layers < 1 || layers > 3) throw new Error("unsupported ordinary dye layer count");
      // BaseLayer applies Colors only when its count matches Property8 layers.
      return ["0x5577cc", "0xdd5577", "0x55bb77"].slice(0, layers).join("|");
    }
    private function clonePlayer(job:Object):Object {
      var playerClass:Class = definition("ddt.data.player.PlayerInfo") as Class;
      if (!playerClass) throw new Error("original PlayerInfo unavailable");
      var copy:Object = new playerClass();
      copy.beginChanges();
      copy.ID = self.ID; copy.Sex = self.Sex; copy.Style = self.getPrivateStyle(); copy.Colors = self.Colors;
      copy.Skin = self.Skin; copy.Hide = 111111111; copy.Nimbus = 0;
      copy.commitChanges();
      var sex:int = copy.Sex ? 1 : 2;
      copy.beginChanges();
      // Remove a suit only on the unattached clone, so ordinary component layers are used.
      copy.setPartStyle(13, sex, 13000 + sex * 100 + 1);
      copy.setPartStyle(int(job.part.categoryId), sex, int(job.part.id));
      if (job.dye) copy.setPartColor(int(job.part.categoryId), dyeColors(job));
      copy.commitChanges();
      if (copy.getShowSuits()) throw new Error("clone still selects full suit rendering");
      if (String(copy.Style).split(",").indexOf(job.part.id + "|" + job.part.pic) < 0) throw new Error("clone did not select the exact installed part");
      return copy;
    }
    private function loadCharacter(info:Object, kind:String):Object {
      var factory:Object = definition("ddt.view.character.CharactoryFactory");
      var character:Object = factory.createCharacter(info, kind, true);
      if (!character) throw new Error("original " + kind + " component unavailable");
      members.push({kind:kind, object:character, complete:false});
      var member:Object = members[members.length - 1];
      character.addEventListener(Event.COMPLETE, function(e:Event):void { member.complete = true; });
      // Keep characters off-stage: explicit public drawFrame calls remain stable for capture.
      character.show(true, 1, false);
      return character;
    }
    private function loadLayer(info:Object, kind:String, job:Object):void {
      var items:Object = definition("ddt.manager.ItemManager");
      var template:Object = items.Instance.getTemplateById(int(job.part.id));
      if (!template || int(template.CategoryID) != int(job.part.categoryId) || template.Pic != job.part.pic) throw new Error("exact installed template mapping differs");
      var factory:Object = definition("ddt.view.character.LayerFactory");
      var layer:Object = factory.instance.createLayer(template, info.Sex, job.dye ? dyeColors(job) : "", kind, false, int(job.hair));
      var member:Object = {kind:"layer-" + kind, object:layer, complete:false}; members.push(member);
      layer.load(function(loaded:Object):void { member.complete = true; });
    }
    private function clear():void {
      for each (var member:Object in members) member.object.dispose();
      members = [];
      if (panel && panel.parent) panel.parent.removeChild(panel);
      panel = new Sprite(); panel.graphics.beginFill(0x202635); panel.graphics.drawRect(0, 0, 1000, 600); panel.graphics.endFill(); stage.addChild(panel);
    }
    private function nextJob():void {
      invariant(); clear(); ++itemIndex;
      if (itemIndex >= jobs.length) {
        report({phase:"official-render-complete", jobs:jobs.length, playerID:self.ID, selfUnchanged:true}); timer.stop(); return;
      }
      var job:Object = jobs[itemIndex];
      if (job.baseline && !job.resolved) {
        var itemManager:Object = definition("ddt.manager.ItemManager");
        var oldTemplate:Object = itemManager.Instance.getTemplateById(int(job.part.sourceId));
        if (!oldTemplate || int(oldTemplate.CategoryID) != int(job.part.categoryId)) throw new Error("exact legacy source template unavailable");
        job.part = {id:int(oldTemplate.TemplateID), pic:oldTemplate.Pic, categoryId:int(oldTemplate.CategoryID), name:"Legacy baseline: " + job.part.name, officialId:job.part.officialId};
        job.resolved = true;
      }
      var info:Object = clonePlayer(job); jobInfo = info;
      label(job.part.name + " | " + job.part.id + " | " + (job.dye ? "dyed" : "original") + (int(job.part.categoryId) == 3 ? " | layer hair " + (job.hair == 1 ? "B" : "A") : ""), 10, 5);
      // Legacy LoaderQueue removes shared-loader listeners on completion. Warm and use
      // each original owner sequentially so duplicate cold requests cannot lose callbacks.
      loadLayer(info, "show", job);
      startedAt = ticks; awaitingCapture = false;
      report({phase:"official-render-requested", job:itemIndex, templateID:job.part.id, pic:job.part.pic,
        categoryId:job.part.categoryId, dye:job.dye, hair:job.hair, baseline:job.baseline == true, componentHairType:int(info.getHairType()) == 1 ? "B" : "A", cloneStyle:info.Style, cloneColors:info.Colors});
    }
    private function snapshot(object:DisplayObject, x:Number, y:Number, scale:Number = 1, size:Rectangle = null):Object {
      var bounds:Rectangle = size || object.getBounds(object);
      if (bounds.width <= 0 || bounds.height <= 0) return {nonempty:false};
      var data:BitmapData = new BitmapData(Math.ceil(bounds.width), Math.ceil(bounds.height), true, 0);
      var matrix:Matrix = new Matrix(); matrix.translate(-bounds.x, -bounds.y); data.draw(object, matrix);
      var pixels:Rectangle = data.getColorBoundsRect(0xff000000, 0, false);
      var bitmap:Bitmap = new Bitmap(data, "auto", false); bitmap.x = x; bitmap.y = y; bitmap.scaleX = bitmap.scaleY = scale; panel.addChild(bitmap);
      return {width:data.width, height:data.height, nonempty:pixels.width > 0 && pixels.height > 0,
        alphaBounds:{x:pixels.x, y:pixels.y, width:pixels.width, height:pixels.height}};
    }
    private function capture():void {
      invariant();
      stage.setChildIndex(panel, stage.numChildren - 1);
      var job:Object = jobs[itemIndex], evidence:Array = [], member:Object, character:Object;
      for each (member in members) {
        character = member.object;
        var details:Object = {kind:member.kind, sourceClass:getQualifiedClassName(character), completed:member.complete, frames:[]};
        if (member.kind == "show") {
          var showClass:Object = definition("ddt.view.character.ShowCharacter");
          character.doAction(showClass.STAND); details.frames.push(snapshot(character as DisplayObject, 5, 38));
          details.frames[0].currentFrame = character.currentFrame; details.frames[0].currentAction = String(character.currentAction);
          character.doAction(showClass.WIN); details.frames.push(snapshot(character as DisplayObject, 255, 38, 0.5));
          details.frames[1].currentFrame = character.currentFrame; details.frames[1].currentAction = String(character.currentAction);
          label("Show: stand / win", 10, 380, 280);
        } else if (member.kind == "room") {
          for (var r:int = 0; r < 4; r++) { character.drawFrame(r); details.frames.push(snapshot(character as DisplayObject, 260 + r * 115, 220, Math.min(110 / Math.max(character.width,1), 175 / Math.max(character.height,1)))); }
          label("Room: 0 / 1 / 2 / 3", 260, 380, 480);
        } else if (member.kind == "game") {
          var frames:Array = [0,5,23,34,38];
          for (var i:int = 0; i < frames.length; i++) {
            character.drawFrame(int(frames[i]), 1, true); character.drawFrame(int(frames[i]), 3, false); character.drawFrame(int(frames[i]), 4, false);
            details.frames.push(snapshot(character as DisplayObject, 405 + i * 116, 75, 1, new Rectangle(-62,-83,115,95)));
          }
          label("Game: 0 / 5 / 23 / 34 / 38", 405, 174, 590);
        } else {
          details.allLayerLoadsSucceeded = character.isAllLoadSucceed;
          var layerContent:DisplayObject = character.getContent() as DisplayObject;
          if (member.kind == "layer-icon") details.frames.push(snapshot(layerContent, 920, 320));
          else {
            var maxWidth:Number = member.kind == "layer-show" ? 225 : 1000;
            details.frames.push(snapshot(layerContent, member.kind == "layer-show" ? 765 : 0, member.kind == "layer-show" ? 215 : 408, Math.min(maxWidth / Math.max(layerContent.width, 1), 185 / Math.max(layerContent.height, 1))));
          }
        }
        evidence.push(details);
      }
      report({phase:"official-frame-ready", job:itemIndex, templateID:job.part.id, officialId:job.part.officialId,
        categoryId:job.part.categoryId, name:job.part.name, dye:job.dye, hair:job.hair, baseline:job.baseline == true, componentHairType:int(jobInfo.getHairType()) == 1 ? "B" : "A", components:evidence,
        selfUnchanged:true, gameplayAccepted:false, scope:"original AS3 component and layer render; passive snapshot, not actual battle"});
      awaitingCapture = true; reportedAt = ticks;
    }
    private function tick(event:TimerEvent):void {
      ++ticks;
      try {
        if (!initialized) {
          var states:Object = definition("ddt.manager.StateManager");
          if (!states || String(states.currentStateType) != "main") return;
          var players:Object = definition("ddt.manager.PlayerManager");
          self = players.Instance.Self;
          if (self.ID != expectedUserID) throw new Error("player differs from exact private fixture");
          if (!moduleStarted) {
            moduleStarted = true;
            var classes:Object = definition("com.pickgliss.utils.ClassUtils");
            module.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void { moduleReady = true; report({phase:"official-game-assets-loaded"}); });
            module.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void { fail(e.text); });
            module.load(new URLRequest(String(loaderInfo.parameters.probeGameModule)), new LoaderContext(false, classes.uiSourceDomain));
          }
          if (!moduleReady) return;
          original = fingerprint(self); initialized = true; client.visible = false; nextJob(); return;
        }
        invariant();
        if (awaitingCapture) { if (ticks - reportedAt >= 16) nextJob(); return; }
        var complete:Boolean = members.length > 0;
        for each (var member:Object in members) if (!member.complete) complete = false;
        if (complete) {
          if (members.length == 1) loadLayer(jobInfo, "game", jobs[itemIndex]);
          else if (members.length == 2) loadLayer(jobInfo, "icon", jobs[itemIndex]);
          else if (members.length == 3) loadCharacter(jobInfo, "show");
          else if (members.length == 4) loadCharacter(jobInfo, "room");
          else if (members.length == 5) loadCharacter(jobInfo, "game");
          else capture();
        }
        else if (ticks - startedAt > 240) {
          report({phase:"official-component-timeout", job:itemIndex, templateID:jobs[itemIndex].part.id}); nextJob();
        }
      } catch (error:Error) { fail(error.message); }
    }
  }
}
