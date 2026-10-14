package {
    import flash.display.Loader;
    import flash.display.Sprite;
    import flash.events.Event;
    import flash.events.IOErrorEvent;
    import flash.events.SecurityErrorEvent;
    import flash.events.TimerEvent;
    import flash.external.ExternalInterface;
    import flash.net.URLRequest;
    import flash.system.ApplicationDomain;
    import flash.system.LoaderContext;
    import flash.utils.Timer;

    /** A single original-client-domain owner. init registers callbacks only. */
    public final class WorkshopNativeWardrobeBridge extends Sprite {
        private static var _registered:Boolean = false;
        private static var _loader:Loader;
        private static var _module:Object;
        private static var _timer:Timer;
        private static var _phase:String = "registered";
        private static var _notice:String = "请从活动菜单打开魔法衣橱。";
        private static var _expected:int = 0;
        private static var _actual:int = 0;
        private static var _wantOpen:Boolean = false;
        private static var _errors:Array = [];

        public function WorkshopNativeWardrobeBridge() { super(); }

        public static function init():void {
            if (_registered || !ExternalInterface.available) return;
            ExternalInterface.addCallback("workshopOpenWardrobe", openWardrobe);
            ExternalInterface.addCallback("workshopStatusWardrobe", statusWardrobe);
            ExternalInterface.addCallback("workshopCloseWardrobe", closeWardrobe);
            _registered = true;
        }

        private static function clientClass(name:String):Class {
            var domain:ApplicationDomain = ApplicationDomain.currentDomain;
            if (!domain.hasDefinition(name)) throw new Error("当前客户端缺少类：" + name);
            return domain.getDefinition(name) as Class;
        }

        private static function verifyRole(expectedCharacterId:Number):void {
            if (!isFinite(expectedCharacterId) || expectedCharacterId <= 0 || expectedCharacterId != int(expectedCharacterId)) {
                throw new Error("请先选择当前游戏角色。");
            }
            var State:Class = clientClass("ddt.manager.StateManager");
            if (State["currentStateType"] != "main") throw new Error("请返回游戏大厅后打开魔法衣橱。");
            var Player:Class = clientClass("ddt.manager.PlayerManager");
            var self:Object = Player["Instance"]["Self"];
            _actual = self ? int(self["ID"]) : 0;
            if (_actual <= 0 || _actual != expectedCharacterId) throw new Error("网页角色与游戏内角色不一致，请重新选择当前角色。");
            if (_expected > 0 && _expected != _actual) throw new Error("游戏角色已切换，请重新进入游戏后打开衣橱。");
        }

        /** True means this exact-role request was accepted; status/report carries async outcome. */
        public static function openWardrobe(expectedCharacterId:Number):Boolean {
            try {
                verifyRole(expectedCharacterId);
                if (_phase == "failed") throw new Error("衣橱加载失败，请重新进入游戏后重试。" + _notice);
                _expected = int(expectedCharacterId);
                _wantOpen = true;
                if (_module) {
                    var current:Object = _module["statusNative"]();
                    if (current["ready"] === true) {
                        current = _module["openNative"]();
                        _wantOpen = false;
                        if (current["phase"] == "error") { fail("open", moduleError(current)); return false; }
                        _phase = String(current["phase"]);
                        _notice = String(current["catalogNotice"] || "魔法衣橱已打开。");
                        report();
                    }
                    return true;
                }
                if (_loader) return true; // One pending loader, never a duplicate definition import.
                var Path:Class = clientClass("ddt.manager.PathManager");
                var base:String = String(Path["FLASHSITE"]);
                if (!base || base == "null") throw new Error("当前客户端的 Flash 资源路径未就绪。");
                if (base.charAt(base.length - 1) != "/") base += "/";
                if (base.toLowerCase().lastIndexOf("/flash/") != base.length - 7) throw new Error("当前 Flash 资源根不是正常 /flash/ 路径。");
                base += "workshop-native/wardrobe/";
                var Display:Class = clientClass("com.pickgliss.loader.DisplayLoader");
                var domain:ApplicationDomain = Display["Context"]["applicationDomain"] as ApplicationDomain;
                if (!domain || !domain.hasDefinition("ddt.manager.PlayerManager")) throw new Error("当前游戏共享加载域未就绪。");
                var context:LoaderContext = new LoaderContext(false, domain);
                context.allowCodeImport = true;
                _loader = new Loader();
                _loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, onIoError);
                _loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR, onSecurityError);
                _loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(event:Event):void {
                    if (_phase == "failed") return;
                    try {
                        verifyRole(_expected);
                        _module = _loader.content;
                        _module["startNative"]({ baseUrl: base, expectedUserId: _expected, autoOpen: false });
                        pollModule(null);
                    } catch (error:Error) { fail("bootstrap", error.message); }
                });
                _phase = "loading-bootstrap";
                _notice = "正在加载原版魔法衣橱，请稍候。";
                _timer = new Timer(200, 300);
                _timer.addEventListener(TimerEvent.TIMER, pollModule);
                _timer.addEventListener(TimerEvent.TIMER_COMPLETE, onTimeout);
                _timer.start();
                try { _loader.load(new URLRequest(base + "WorkshopNativeWardrobeBootstrap.swf"), context); }
                catch (loadError:Error) { fail("bootstrap-load", loadError.message); return false; }
                report();
                return true;
            } catch (error:Error) {
                // Rejected role/state requests do not discard an existing ready module.
                _notice = error.message;
                report();
                return false;
            }
            return false;
        }

        private static function pollModule(event:TimerEvent):void {
            if (!_module) return;
            try {
                var current:Object = _module["statusNative"]();
                if (current["phase"] == "error") { fail("module", moduleError(current)); return; }
                _phase = String(current["phase"]);
                if (current["ready"] !== true) return;
                _timer.stop();
                if (_wantOpen) {
                    verifyRole(_expected);
                    current = _module["openNative"]();
                    _wantOpen = false;
                    if (current["phase"] == "error") { fail("open", moduleError(current)); return; }
                }
                _phase = String(current["phase"]);
                _notice = String(current["catalogNotice"] || "魔法衣橱已就绪。");
                report();
            } catch (error:Error) { fail("module", error.message); }
        }

        public static function closeWardrobe():void {
            _wantOpen = false;
            if (_module) {
                try { var current:Object = _module["closeNative"](); if (_phase != "failed") _phase = String(current["phase"]); }
                catch (error:Error) { fail("close", error.message); return; }
            }
            report();
        }

        public static function statusWardrobe():Object {
            var current:Object = null;
            if (_module) {
                try { current = _module["statusNative"](); }
                catch (error:Error) { current = { phase: "error", errors: [{ message: error.message }] }; }
            }
            return { phase: _phase == "failed" ? "failed" : current ? current["phase"] : _phase,
                ready: Boolean(current && current["ready"] === true && _phase != "failed"),
                visible: Boolean(current && current["visible"] === true),
                registered: _registered, actualUserId: _actual, expectedUserId: _expected,
                notice: _notice, errors: _errors.concat(current && current["errors"] ? current["errors"] : []),
                originalSetCount: current ? current["originalSetCount"] : 0,
                readySetCount: current ? current["readySetCount"] : 0,
                missingSets: current ? current["missingSets"] : [], viewState: current ? current["viewState"] : null };
        }

        private static function fail(at:String, message:String):void {
            if (_timer) _timer.stop();
            _wantOpen = false;
            _phase = "failed";
            _notice = "魔法衣橱加载失败，请重新进入游戏后重试：" + message;
            _errors.push({ at: at, message: message });
            report();
        }
        private static function moduleError(current:Object):String {
            var errors:Array = current["errors"] as Array;
            return errors && errors.length ? String(errors[errors.length - 1]["message"]) : "原衣橱窗口未能打开";
        }
        private static function onIoError(event:IOErrorEvent):void { fail("bootstrap-io", event.text); }
        private static function onSecurityError(event:SecurityErrorEvent):void { fail("bootstrap-security", event.text); }
        private static function onTimeout(event:TimerEvent):void { fail("module-timeout", "资源加载超时"); }
        private static function report():void {
            if (ExternalInterface.available) {
                try { ExternalInterface.call("workshopWardrobeReport", statusWardrobe()); }
                catch (ignored:Error) { trace("[native-wardrobe] report callback unavailable"); }
            }
        }
    }
}
