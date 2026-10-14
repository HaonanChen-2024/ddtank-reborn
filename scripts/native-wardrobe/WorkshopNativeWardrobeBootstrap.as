package {
    import flash.display.DisplayObject;
    import flash.display.DisplayObjectContainer;
    import flash.display.Loader;
    import flash.display.Sprite;
    import flash.display.Stage;
    import flash.events.Event;
    import flash.events.IOErrorEvent;
    import flash.events.SecurityErrorEvent;
    import flash.events.UncaughtErrorEvent;
    import flash.external.ExternalInterface;
    import flash.geom.Rectangle;
    import flash.net.URLLoader;
    import flash.net.URLLoaderDataFormat;
    import flash.net.URLRequest;
    import flash.system.ApplicationDomain;
    import flash.system.LoaderContext;
    import flash.text.TextField;
    import flash.text.TextFormat;
    import flash.utils.ByteArray;
    import flash.utils.getTimer;
    import flash.utils.getQualifiedClassName;

    /** Loads the original wardrobe into an already authenticated local client.
     * No login, inventory mutation, protocol request or substitute player is implemented here.
     */
    public class WorkshopNativeWardrobeBootstrap extends Sprite {
        private var _domain:ApplicationDomain;
        private var _hostContext:LoaderContext;
        private var _baseUrl:String = "";
        private var _expectedUserId:int = 0;
        private var _actualUserId:int = 0;
        private var _phase:String = "created";
        private var _autoOpen:Boolean = false;
        private var _ready:Boolean = false;
        private var _busy:Boolean = false;
        private var _view:Object;
        private var _stage:Stage;
        private var _loaders:Array = [];
        private var _urlLoader:URLLoader;
        private var _events:Array = [];
        private var _errors:Array = [];
        private var _missingAssets:Array = [];
        private var _layoutKeys:Array = [];
        private var _setCount:int = 0;
        private var _readySetCount:int = 0;
        private var _missingSets:Array = [];
        private var _catalogNotice:String = "";
        private var _startedAt:int = 0;

        public function WorkshopNativeWardrobeBootstrap() {
            _domain = ApplicationDomain.currentDomain;
        }

        public function startNative(options:Object):void {
            if (_busy || _ready) { report("start-ignored", "Already loading or ready."); return; }
            if (_phase != "created") { fail("restart", "Load failed; recreate the isolated wrapper to avoid mixed ApplicationDomain state."); return; }
            try {
                if (!options || !options.baseUrl) throw new Error("startNative requires options.baseUrl.");
                _baseUrl = String(options.baseUrl);
                if (_baseUrl.charAt(_baseUrl.length - 1) != "/") _baseUrl += "/";
                _expectedUserId = int(options.expectedUserId);
                if (_expectedUserId <= 0) throw new Error("expectedUserId must identify the existing local role.");
                if (options.sharedOwnerReady !== true) throw new Error("The unique shared owner must load App/Morn first.");
                var DisplayClass:Class = requireClass("com.pickgliss.loader.DisplayLoader");
                _hostContext = DisplayClass["Context"] as LoaderContext;
                var actualDomain:ApplicationDomain = _hostContext ? _hostContext.applicationDomain : null;
                if (!(options.sharedDomain is ApplicationDomain) || !_hostContext || options.sharedContext !== _hostContext || !actualDomain || !actualDomain.hasDefinition("WorkshopNativeWardrobeBootstrap") || actualDomain.getDefinition("WorkshopNativeWardrobeBootstrap") !== WorkshopNativeWardrobeBootstrap) throw new Error("Native module is not in the actual shared DisplayLoader domain.");
                _domain=actualDomain;
                for each(var sharedName:String in ["App","Config","morn.core.components.View"]) if(!_domain.hasDefinition(sharedName)||!options.sharedDomain.hasDefinition(sharedName)||_domain.getDefinition(sharedName)!==options.sharedDomain.getDefinition(sharedName))throw new Error("Shared classes differ from the unique owner.");
                requireClass("App"); requireClass("Config"); requireClass("morn.core.components.View");
                _autoOpen = options.autoOpen === true;
                _startedAt = getTimer();
                requireCurrentRole();
                _busy = true;
                report("start", "Real local role and shared client classes verified.");
                loadSwf("magicwardrobe-original-library.swf", "loading-library", function():void {
                    requireClass("magicWardrobe.MagicWardrobeManager");
                    requireClass("magicWardrobe.view.MagicWardrobeMainView");
                    requireClass("morn.core.components.View");
                    requireClass("App");
                    loadSwf("shared-art.swf", "loading-shared-art", function():void {
                        loadSwf("magicwardrobe_v3_6_1_u1.swf", "loading-art", loadLayouts);
                    });
                });
            } catch (error:Error) { fail("start", error); }
        }

        private function requireClass(name:String):Class {
            if (!_domain.hasDefinition(name)) throw new Error("Missing class in current ApplicationDomain: " + name);
            var value:Class = _domain.getDefinition(name) as Class;
            if (!value) throw new Error("Definition is not a Class: " + name);
            return value;
        }

        private function requireCurrentRole():Object {
            var displayClass:Class = requireClass("com.pickgliss.loader.DisplayLoader");
            if (displayClass["Context"] !== _hostContext) throw new Error("Shared LoaderContext changed.");
            var current:ApplicationDomain=_hostContext.applicationDomain;
            for each(var name:String in ["WorkshopNativeWardrobeBootstrap","App","Config","morn.core.components.View"]) if(!current||!current.hasDefinition(name)||current.getDefinition(name)!==_domain.getDefinition(name))throw new Error("Shared class identity changed.");
            var stateManager:Class = requireClass("ddt.manager.StateManager");
            if (stateManager["currentStateType"] != "main") throw new Error("请返回游戏大厅后打开魔法衣橱。");
            var manager:Class = requireClass("ddt.manager.PlayerManager");
            var self:Object = manager["Instance"]["Self"];
            if (!self) throw new Error("Current client has no real PlayerManager.Instance.Self.");
            _actualUserId = int(self["ID"]);
            if (_actualUserId != _expectedUserId) throw new Error("Current Self.ID " + _actualUserId + " does not match expectedUserId " + _expectedUserId + ".");
            if (!self["Bag"]) throw new Error("Current real inventory Self.Bag is not ready.");
            if (!self["getBag"](51)) throw new Error("Current real bank inventory Self.getBag(51) is not ready.");
            requireClass("ddt.manager.ItemManager");
            requireClass("bagAndInfo.cell.BagCell");
            requireClass("ddt.view.character.CharactoryFactory");
            requireClass("com.pickgliss.ui.LayerManager");
            var stageOwner:Class = requireClass("com.pickgliss.toplevel.StageReferance");
            _stage = stageOwner["stage"] as Stage;
            if (!_stage) _stage = stage;
            if (!_stage) throw new Error("Current client StageReferance.stage is not available.");
            return self;
        }

        private function loadSwf(file:String, phase:String, next:Function):void {
            if (_phase == "error") return;
            requireCurrentRole();
            _phase = phase;
            var loader:Loader = new Loader();
            _loaders.push(loader); // Keep shared-domain library and art definitions alive.
            var context:LoaderContext = new LoaderContext(false, _domain);
            context.allowCodeImport = true;
            loader.contentLoaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, onUncaught);
            loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, onIoError);
            loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR, onSecurityError);
            loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(event:Event):void {
                if (_phase == "error") return;
                try {
                    requireCurrentRole();
                    report("loaded", file);
                    next();
                } catch (error:Error) { fail(phase, error); }
            });
            report("loading", file);
            loader.load(new URLRequest(_baseUrl + file), context);
        }

        private function loadBytes(file:String, phase:String, next:Function):void {
            if (_phase == "error") return;
            requireCurrentRole();
            _phase = phase;
            var loader:URLLoader = new URLLoader();
            _urlLoader = loader;
            loader.dataFormat = URLLoaderDataFormat.BINARY;
            loader.addEventListener(IOErrorEvent.IO_ERROR, onIoError);
            loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR, onSecurityError);
            loader.addEventListener(Event.COMPLETE, function(event:Event):void {
                if (_phase == "error") return;
                try {
                    requireCurrentRole();
                    report("loaded", file);
                    next(loader.data as ByteArray);
                } catch (error:Error) { fail(phase, error); }
            });
            report("loading", file);
            loader.load(new URLRequest(_baseUrl + file));
        }

        private function loadLayouts():void {
            loadBytes("magicwardrobe_v3_6_1_u1.ui", "loading-layouts", function(bytes:ByteArray):void {
                bytes.uncompress();
                bytes.position = 0;
                var layouts:Object = bytes.readObject();
                if (bytes.bytesAvailable != 0) throw new Error("Unread bytes after original Morn layout object.");
                var ViewClass:Class = requireClass("morn.core.components.View");
                var required:Array = ["view/MagicMain.xml", "view/MagicNeedEquip.xml", "view/PlayerItem.xml"];
                for each (var key:String in required) {
                    if (!(layouts[key] is XML)) throw new Error("Original Morn layout missing or not XML: " + key);
                    ViewClass["uiMap"][key] = layouts[key];
                    _layoutKeys.push(key);
                }
                var AppClass:Class = requireClass("App");
                // Deliberately do not call App.init, which changes the host's stage settings.
                AppClass["stage"] = _stage;
                AppClass["asset"]["setDomain"](_domain);
                // SelectPageEx has no skin property, so the XML's png.comp.blank is ignored by original View.setCompValue.
                var assets:Array = ["asset.magicWardrobe.mainBg", "asset.magicWardrobe.shineMovie", "asset.magicWardrobe.starMovie", "asset.ui.btn_close9", "asset.magicWardrobe.selected", "asset.magicWardrobe.unSelected"];
                _missingAssets = [];
                for each (var asset:String in assets) if (!_domain.hasDefinition(asset)) _missingAssets.push(asset);
                report("layouts-ready", "Original 3 XML layouts registered; App.stage and asset domain set.");
                loadCatalog();
            });
        }

        private function loadCatalog():void {
            loadBytes("MagicClothList.decoded.xml", "loading-catalog", function(bytes:ByteArray):void {
                bytes.position = 0;
                var xml:XML = new XML(bytes.readUTFBytes(bytes.length));
                if (String(xml.@value) != "true") throw new Error("Original MagicClothList root value is not true.");
                _setCount = xml..Item.length();
                if (_setCount <= 0) throw new Error("Original MagicClothList has no Item records.");
                if (xml.Item.length() != _setCount) throw new Error("Unexpected nested catalog Item records.");
                // Filter whole sets against the actual current client catalog. Keep the original
                // XML and every accepted Item intact, including its original needArr inputs.
                var filtered:XML = xml.copy();
                delete filtered.Item;
                var ItemClass:Class = requireClass("ddt.manager.ItemManager");
                var itemManager:Object = ItemClass["Instance"];
                var fields:Array = ["HeadID", "GlassID", "HairID", "EffID", "ClothID", "FaceID", "SuitsID", "WingID"];
                _readySetCount = 0;
                _missingSets = [];
                for each (var item:XML in xml.Item) {
                    var missing:Array = [];
                    for each (var field:String in fields) {
                        var templateId:int = int(item.attribute(field));
                        if (templateId > 0 && !itemManager["getTemplateById"](templateId)) missing.push(templateId);
                    }
                    if (missing.length > 0) {
                        _missingSets.push({ setId: int(item.@ID), name: String(item.@Name), missingTemplateIds: missing });
                    } else {
                        filtered.appendChild(item.copy());
                        _readySetCount++;
                    }
                }
                _catalogNotice = "已显示" + _readySetCount + "/" + _setCount + "套，" + _missingSets.length + "套部件尚未安装";
                report("catalog-filtered", _catalogNotice);
                if (_readySetCount == 0) throw new Error("No complete original wardrobe sets are installed in the current client.");
                var ManagerClass:Class = requireClass("magicWardrobe.MagicWardrobeManager");
                var AnalyzerClass:Class = requireClass("magicWardrobe.data.MagicWardrobeListAnalyer");
                var manager:Object = ManagerClass["instance"];
                var completed:Boolean = false;
                var analyzer:Object = new AnalyzerClass(function(done:Object):void {
                    manager["loadXmlComplete"](done);
                    completed = true;
                });
                analyzer["analyze"](filtered.toXMLString());
                if (!completed) throw new Error("Original MagicWardrobeListAnalyer did not complete.");
                _busy = false;
                _ready = true;
                _phase = "ready";
                report("ready", "Original catalog analyzed; waiting for explicit openNative.");
                if (_autoOpen) openNative();
            });
        }

        public function openNative():Object {
            try {
                if (_phase == "error") return statusNative();
                if (!_ready) throw new Error("Original wardrobe is not ready; phase=" + _phase);
                requireCurrentRole();
                if (_view && _view["parent"]) { _phase = "open"; return statusNative(); }
                if (_missingAssets.length > 0) {
                    // The wrapper may load original shared assets after the initial ready report.
                    var stillMissing:Array = [];
                    for each (var name:String in _missingAssets) if (!_domain.hasDefinition(name)) stillMissing.push(name);
                    _missingAssets = stillMissing;
                    if (_missingAssets.length > 0) throw new Error("Missing original shared art definitions: " + _missingAssets.join(", "));
                }
                _phase = "opening";
                var MainClass:Class = requireClass("magicWardrobe.view.MagicWardrobeMainView");
                var LayerClass:Class = requireClass("com.pickgliss.ui.LayerManager");
                _view = new MainClass();
                var notice:TextField = new TextField();
                notice.name = "workshopNativeWardrobeCatalogNotice";
                notice.defaultTextFormat = new TextFormat("宋体", 12, 0xFFEAB6);
                notice.x = 410;
                notice.y = 89;
                notice.width = 340;
                notice.height = 22;
                notice.selectable = false;
                notice.mouseEnabled = false;
                notice.background = true;
                notice.backgroundColor = 0x3B2514;
                notice.text = _catalogNotice;
                _view["addChild"](notice);
                LayerClass["Instance"]["addToLayer"](_view, 3, true, 1);
                if (!(_view as DisplayObject) || !DisplayObject(_view).parent) throw new Error("Original view was not attached to the host LayerManager.");
                _phase = "open";
                report("open", "Original MagicWardrobeMainView attached; inventory is read from current Self.");
            } catch (error:Error) { fail("open", error); }
            return statusNative();
        }

        public function closeNative():Object {
            _autoOpen = false;
            try {
                // Its own close button already calls dispose; do not dispose that instance twice.
                if (_view && _view["parent"]) _view["dispose"]();
                _view = null;
                _phase = _ready ? "closed" : _phase;
                report("close", "Original view disposed; shared definitions kept for reopen.");
            } catch (error:Error) { fail("close", error); }
            return statusNative();
        }

        public function abortNative(reason:String):void {
            _autoOpen = false;
            closeNative();
            fail("owner-abort", reason);
        }

        public function statusNative():Object {
            if (_phase == "open" && (!_view || !_view["parent"])) _phase = "closed";
            return { phase: _phase, ready: _ready, busy: _busy, expectedUserId: _expectedUserId, actualUserId: _actualUserId,
                visible: Boolean(_view && _view["parent"]), elapsedMs: _startedAt > 0 ? getTimer() - _startedAt : 0,
                originalLayoutKeys: _layoutKeys.concat(), originalSetCount: _setCount, readySetCount: _readySetCount,
                missingSets: _missingSets.concat(), catalogNotice: _catalogNotice, missingAssetDefinitions: _missingAssets.concat(),
                viewState: readViewState(), events: _events.concat(), errors: _errors.concat() };
        }

        private function boundsOf(display:DisplayObject, relativeTo:DisplayObject):Object {
            var rect:Rectangle = display.getBounds(relativeTo);
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }

        private function readViewState():Object {
            if (!_view || !_view["parent"]) return null;
            try {
                var display:DisplayObjectContainer = _view as DisplayObjectContainer;
                var tabIndex:int = int(_view["bigSelectGrop"]["selectedIndex"]);
                var pageIndex:int = int(_view["pageSelecte"]["curIndex"]);
                var totalPages:int = int(_view["pageSelecte"]["totle"]);
                var ManagerClass:Class = requireClass("magicWardrobe.MagicWardrobeManager");
                var category:Object = ManagerClass["instance"]["model"]["playerInfoDic"][tabIndex + 1];
                var previews:Array = [];
                // Match the original changeItem public-model index; private _info is never read.
                for (var slot:int = 0; slot < 3; slot++) {
                    var item:Object = display.getChildByName("item" + slot);
                    var index:int = pageIndex * 3 + slot;
                    var info:Object = category && index >= 0 && index < category.length ? category[index] : null;
                    var shown:Boolean = Boolean(item && item["visible"]);
                    var preview:Object = { slot: slot, visible: shown, identitySource: "original public model at tab/page/slot" };
                    if (shown && info) {
                        var need:Array = [];
                        for each (var template:* in info["needArr"]) need.push(int(template));
                        var displayName:String = String(item["nickName"]["text"]);
                        var progressShown:Boolean = Boolean(item["progreesBox"]["visible"]);
                        var currentText:String = String(item["progressCurTxt"]["text"]);
                        var totalText:String = String(item["progressTotleTxt"]["text"]);
                        preview.setId = int(info["ID"]);
                        preview.name = displayName;
                        preview.modelName = String(info["Name"]);
                        preview.displayNameMatchesModel = displayName == String(info["Name"]);
                        preview.needArr = need;
                        preview.progress = { visible: progressShown, complete: Boolean(item["completeTxt"]["visible"]),
                            currentText: currentText, totalText: totalText,
                            current: progressShown ? Number(currentText) : null, total: progressShown ? Number(totalText) : null };
                        preview.bounds = boundsOf(item as DisplayObject, display);
                    }
                    previews.push(preview);
                }
                var children:Array = [];
                // Only immediate window children, capped explicitly; no recursive stage traversal.
                for (var i:int = 0; i < Math.min(display.numChildren, 32); i++) {
                    var child:DisplayObject = display.getChildAt(i);
                    children.push({ index: i, name: child.name, className: getQualifiedClassName(child),
                        visible: child.visible, bounds: boundsOf(child, display) });
                }
                return { className: getQualifiedClassName(display), tabIndex: tabIndex, categoryType: tabIndex + 1,
                    pageIndex: pageIndex, currentPage: pageIndex + 1, totalPages: totalPages,
                    categorySetCount: category ? category.length : 0, previews: previews,
                    boundsOnStage: boundsOf(display, _stage), children: children,
                    totalImmediateChildren: display.numChildren, childBoundsTruncated: display.numChildren > 32 };
            } catch (error:Error) {
                // A diagnostic read must never alter the original activity or enter a failure loop.
                return { readError: error.toString() };
            }
            return null;
        }

        private function onIoError(event:IOErrorEvent):void { fail(_phase, event.text); }
        private function onSecurityError(event:SecurityErrorEvent):void { fail(_phase, event.text); }
        private function onUncaught(event:UncaughtErrorEvent):void { fail(_phase, event.error); }

        private function fail(at:String, error:*):void {
            if (_phase == "error") return;
            var message:String = error is Error ? Error(error).name + ": " + Error(error).message : String(error);
            var stack:String = error is Error ? Error(error).getStackTrace() : null;
            _errors.push({ at: at, phase: _phase, message: message, stack: stack });
            _phase = "error";
            _busy = false;
            _ready = false;
            _autoOpen = false;
            report("error", message);
        }

        private function report(kind:String, message:String):void {
            var entry:Object = { kind: kind, phase: _phase, message: message, ms: getTimer() };
            _events.push(entry);
            if (_events.length > 60) _events.shift();
            trace("[native-wardrobe] " + kind + " " + _phase + " " + message);
            if (ExternalInterface.available) {
                try { ExternalInterface.call("workshopWardrobeReport", statusNative()); }
                catch (ignored:Error) { trace("[native-wardrobe] Report callback unavailable: " + ignored.message); }
            }
        }
    }
}
