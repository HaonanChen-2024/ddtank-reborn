package {
 import flash.display.Sprite;
 import flash.display.Loader;
 import flash.display.DisplayObject;
 import flash.events.Event;
 import flash.events.MouseEvent;
 import flash.events.KeyboardEvent;
 import flash.events.IOErrorEvent;
 import flash.events.SecurityErrorEvent;
 import flash.events.UncaughtErrorEvent;
 import flash.external.ExternalInterface;
 import flash.net.URLLoader;
 import flash.net.URLLoaderDataFormat;
 import flash.net.URLRequest;
 import flash.system.ApplicationDomain;
 import flash.system.LoaderContext;
 import flash.text.TextField;
 import flash.text.TextFormat;
 import flash.utils.ByteArray;
 import flash.utils.Dictionary;

 /** Original three-reel window; the page owns authentication, HTTP and UUIDs. */
 public final class WorkshopNativeDDPlayBootstrap extends Sprite {
  private static var active:WorkshopNativeDDPlayBootstrap;
  private var domain:ApplicationDomain=ApplicationDomain.currentDomain;
  private var hostContext:LoaderContext;
  private var expectedId:int;
  private var generation:String;
  private var base:String;
  private var phase:String="new";
  private var sequence:int=0;
  private var lastRevision:Number=-1;
  private var pending:Boolean=false;
  private var pendingId:String="";
  private var pendingAction:Object;
  private var animating:Boolean=false;
  private var wantedOpen:Boolean=false;
  private var response:Object;
  private var projection:Object;
  private var sceneRoot:Sprite;
  private var main:Object;
  private var exchange:Object;
  private var confirmation:Sprite;
  private var notice:TextField;
  private var message:String="尚未读取本地弹弹乐。";
  private var loaders:Array=[];
  private var bindings:Dictionary=new Dictionary(true);
  public var enabled:Boolean=true;
  public function WorkshopNativeDDPlayBootstrap(){super();}
  private function cls(name:String):Object {if(!domain.hasDefinition(name))throw new Error("缺少原类："+name);return domain.getDefinition(name);}
  private function manager():Object{return cls("DDPlay.DDPlayManaer").Instance;}
  private function role():void {
   var c:LoaderContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(!c||(hostContext&&c!==hostContext)||!c.applicationDomain.hasDefinition("WorkshopNativeDDPlayBootstrap")||c.applicationDomain.getDefinition("WorkshopNativeDDPlayBootstrap")!==WorkshopNativeDDPlayBootstrap)throw new Error("原弹弹乐共享加载域已改变。");
   if(hostContext)for each(var n:String in ["App","Config","morn.core.components.View"])if(!c.applicationDomain.hasDefinition(n)||c.applicationDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享组件身份已改变。");
   if(cls("ddt.manager.StateManager").currentStateType!=="main"||int(cls("ddt.manager.PlayerManager").Instance.Self.ID)!==expectedId)throw new Error("请返回原角色的大厅。");
  }
  public function startNative(options:Object):void {
   if(active||phase!=="new")throw new Error("原弹弹乐不能重复初始化。");
   if(!options||int(options.expectedUserId)<=0||!options.generation||!options.baseUrl||options.sharedOwnerReady!==true)throw new Error("缺少真实角色、代次或唯一共享 owner。");
   expectedId=int(options.expectedUserId);generation=String(options.generation);base=String(options.baseUrl);if(base.charAt(base.length-1)!=="/")throw new Error("资源路径缺少结尾斜线。");
   role();hostContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(options.sharedContext!==hostContext||!(options.sharedDomain is ApplicationDomain))throw new Error("共享 owner 上下文不一致。");domain=hostContext.applicationDomain;
   for each(var n:String in ["App","Config","morn.core.components.View"])if(!options.sharedDomain.hasDefinition(n)||options.sharedDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享类不一致。");
   if(!ExternalInterface.available)throw new Error("当前页面没有本地弹弹乐桥接。");active=this;phase="loading";
   ExternalInterface.addCallback("workshopDDPlayAcceptSnapshot",acceptSnapshot);ExternalInterface.addCallback("workshopDDPlayRejectRequest",rejectRequest);
   ExternalInterface.addCallback("workshopDDPlayOpenNative",openNative);ExternalInterface.addCallback("workshopDDPlayCloseNative",closeNative);ExternalInterface.addCallback("workshopDDPlayStatusNative",statusNative);
   loadSwf("ddplay-original-library.swf",function():void{loadSwf("ddplay_v3_6_1_u1.swf",loadStyles);});
  }
  private function loadSwf(file:String,next:Function):void {
   if(phase==="failed")return;role();var loader:Loader=new Loader();loaders.push(loader);
   loader.contentLoaderInfo.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();next();}catch(error:Error){fail(error.message);}});
   loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("资源读取失败："+file);});loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("资源访问失败："+file);});
   loader.contentLoaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,function(e:UncaughtErrorEvent):void{fail(String(e.error));});
   var c:LoaderContext=new LoaderContext(false,domain);c.allowCodeImport=true;loader.load(new URLRequest(base+file),c);
  }
  private function loadStyles():void {
   role();var loader:URLLoader=new URLLoader();loaders.push(loader);loader.dataFormat=URLLoaderDataFormat.BINARY;
   loader.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("原弹弹乐样式读取失败。");});loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("原弹弹乐样式访问失败。");});
   loader.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();var b:ByteArray=loader.data as ByteArray;cls("com.pickgliss.ui.ComponentFactory").Instance.setup(new XML(b.readUTFBytes(b.length)));phase="ready";message="已准备原窗口；打开只读取，不转动或兑换。";report();}catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+"ddplay-styles.xml"));
  }
  public function openNative():Object {role();if(phase!=="ready")return statusNative();if(pending&&pendingAction===null){wantedOpen=true;return statusNative();}if(pending||animating){say("已有操作尚未确认，请处理原请求。");return statusNative();}if(sceneRoot)return statusNative();wantedOpen=true;read();return statusNative();}
  private function read():void {
   role();pending=true;pendingId="";pendingAction=null;sequence++;lock();
   try{var result:Object=ExternalInterface.call("workshopDDPlayRead",expectedId,generation,sequence);if(!result||result.accepted!==true){pending=false;throw new Error("页面未接受弹弹乐读取。");}}catch(error:Error){say(error.message);}
  }
  private function request(action:Object):void {
   role();if(pending||animating||!projection)return;
   if(cls("ddt.manager.PlayerManager").Instance.Self.bagLocked){say("请先解除背包锁定。");return;}
   pending=true;pendingId="";pendingAction=action;sequence++;lock();
   try{var result:Object=ExternalInterface.call("workshopDDPlayRequest",expectedId,generation,sequence,action);if(!result||result.accepted!==true||!result.requestId){pending=false;pendingAction=null;throw new Error("页面未接受操作；未提交新的积分请求。");}pendingId=String(result.requestId);}catch(error:Error){say(error.message);}report();
  }
  private function integer(v:*,lo:int,hi:int):Boolean{return typeof v==="number"&&isFinite(v)&&v===Math.floor(v)&&v>=lo&&v<=hi;}
  private function reels(r:*):Boolean {return r is Array&&r.length===3&&integer(r[0],1,3)&&integer(r[1],1,3)&&integer(r[2],1,3);}
  private function validate(p:Object):void {
   if(!p||p.version!==1||p.kind!=="ddplay-native"||!integer(p.spins,0,1000000000)||!integer(p.score,0,2147483647)||p.spinCost!==10||typeof p.canSpin!=="boolean"||typeof p.canExchange!=="boolean")throw new Error("无效的弹弹乐公开投影。");
   if(!p.exchange||p.exchange.cost!==10||p.exchange.maxCount!==10||p.exchange.templateId!==11019||p.exchange.itemCount!==1||!p.localRules||p.localRules.version!==1||typeof p.localRules.description!=="string")throw new Error("本地单项兑换规则不符。");
   if(p.lastResult!==null&&(!p.lastResult||[0,2,3,5,10].indexOf(p.lastResult.multiplier)<0||!reels(p.lastResult.reels)))throw new Error("原转轴结果无效。");
  }
  public function acceptSnapshot(envelope:Object):Object {try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}return statusNative();}
  private function applySnapshot(envelope:Object):Object {
   if(phase==="failed")throw new Error("原弹弹乐已失败，拒绝迟到响应。");role();
   if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");
   var value:Object=envelope.snapshot;if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");
   if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("动作 UUID 不符。");validate(value.nativeDDPlay);
   var action:Object=pendingAction,fresh:Boolean=Boolean(action&&!value.replayed&&value.nativeDDPlayAction&&value.nativeDDPlayAction.requestId===pendingId),effects:Array=fresh?value.nativeDDPlayAction.effects as Array:null,spun:Object=null;
   if(fresh&&action.type==="spin"){if(!effects)throw new Error("转轴响应缺少确认效果。");for each(var effect:Object in effects)if(effect.type==="spun")spun=effect;
    if(!spun||!reels(spun.reels)||[0,2,3,5,10].indexOf(spun.multiplier)<0||spun.cost!==10||spun.spins!==value.nativeDDPlay.spins||spun.score!==value.nativeDDPlay.score||!value.nativeDDPlay.lastResult||spun.multiplier!==value.nativeDDPlay.lastResult.multiplier||spun.reels.join(",")!==value.nativeDDPlay.lastResult.reels.join(","))throw new Error("转轴效果与最终状态不符。");}
   response=value;projection=value.nativeDDPlay;lastRevision=value.revision;pending=false;pendingId="";pendingAction=null;syncManager();
   if(!sceneRoot&&!action&&wantedOpen)constructWindow();
   if(main){if(fresh&&action.type==="spin"){animating=true;main._multiple=spun.multiplier;main.isPlaying=true;lock();main.startLottery(spun.reels[0],spun.reels[1],spun.reels[2]);}else renderStatic();refreshExchange();}
   message=value.message?String(value.message):"已读取本地弹弹乐进度。";lock();report();return statusNative();
  }
  public function rejectRequest(envelope:Object):Object {
   role();if(phase==="failed"||!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)return statusNative();if(pendingAction&&String(envelope.requestId)!==pendingId)return statusNative();
   if(envelope.definitive===true){pending=false;pendingAction=null;pendingId="";if(main)renderStatic();}say(String(envelope.message||"请求结果未知，请从页面重试原请求。"));return statusNative();
  }
  private function syncManager():void {var m:Object=manager();m.isOpen=true;m.DDPlayScore=projection.score;m.DDPlayMoney=projection.spinCost;m.exchangeFold=projection.exchange.cost;}
  private function constructWindow():void {
   role();sceneRoot=new Sprite();sceneRoot.graphics.beginFill(0x000000,0.7);sceneRoot.graphics.drawRect(0,0,1000,600);sceneRoot.graphics.endFill();
   main=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("ddPlay.view.ddPlayView");sceneRoot.addChild(main as DisplayObject);main.x=155;main.y=4;
   // Currency wording is baked into the original art; local cover fields leave that asset intact.
   main.addChild(text(59,432,152,26,"单次 10 活动积分",0x49310c));main.addChild(text(213,432,62,26,"可转次数",0x49310c));main.addChild(text(405,432,47,26,"积分",0x49310c));
   main.addChild(text(210,87,285,24,"相同图案按本地倍率获得活动积分",0x4b1a05));
   for each(var x:int in [218,405,592])main.addChild(text(x,126,53,30,"活动积分",0x442908));
   notice=text(100,551,800,45,"",0x241a10);sceneRoot.addChild(notice);cls("com.pickgliss.toplevel.StageReferance").stage.addChild(sceneRoot);cls("com.pickgliss.toplevel.StageReferance").stage.focus=sceneRoot;
   sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);
   renderStatic();lock();
  }
  private function text(x:Number,y:Number,w:Number,h:Number,label:String,color:uint):TextField {var t:TextField=new TextField();t.defaultTextFormat=new TextFormat("Microsoft YaHei",12,0xffefbe,false,null,null,null,null,"center");t.x=x;t.y=y;t.width=w;t.height=h;t.text=label;t.background=true;t.backgroundColor=color;t.wordWrap=true;t.selectable=false;t.mouseEnabled=false;return t;}
  private function button(label:String,x:int,y:int,fn:Function):Sprite {var b:Sprite=new Sprite();b.x=x;b.y=y;b.graphics.beginFill(0x6b451d);b.graphics.drawRoundRect(0,0,110,30,7);b.graphics.endFill();b.addChild(text(3,4,104,24,label,0x6b451d));b.buttonMode=true;b.addEventListener(MouseEvent.CLICK,function(e:MouseEvent):void{e.stopImmediatePropagation();fn();});return b;}
  private function confirm(action:Object,cost:int):void {if(pending||animating||!sceneRoot)return;clearConfirm();confirmation=new Sprite();confirmation.graphics.beginFill(0x000000,0.65);confirmation.graphics.drawRect(0,0,1000,600);confirmation.graphics.endFill();
   confirmation.addChild(text(285,210,430,85,"确认消耗 "+cost+" 本地活动积分？\n"+(action.type==="spin"?"本次只转动一次；倍率采用本地规则。":"兑换 "+action.count+" 份普通材料，成功后进入邮件。")+"\n不会使用点券、乐币或真实付款。",0x3b2919));
   confirmation.addChild(button("确认",355,309,function():void{clearConfirm();request(action);}));confirmation.addChild(button("取消",535,309,function():void{clearConfirm();lock();}));sceneRoot.addChild(confirmation);lock();}
  private function clearConfirm():void {if(confirmation&&confirmation.parent)confirmation.parent.removeChild(confirmation);confirmation=null;}
  private function renderStatic():void {if(!main)return;main.timer.stop();main.isPlaying=false;main.reSetBogu();var r:Array=projection.lastResult?projection.lastResult.reels as Array:[1,2,3];main._multiple=projection.lastResult?projection.lastResult.multiplier:0;
   for(var i:int=1;i<=3;i++){main["_sixBogu"+i].gotoAndStop(1);main["_sixBogu"+i].y=main._boguTypePoints[r[i-1]].y;}main._scoreTxt.text=String(projection.score);main._coinsTxt.text=String(Math.floor(projection.score/projection.spinCost));main._explameTxt.htmlText="本地10积分／次；倍率0／2／3／5／10，原服数值与概率未导入。";}
  private function lock():void {if(!sceneRoot)return;if(notice)notice.text=message+"\n每份10积分兑换普通材料11019，手动发邮件；自动连抽与原付款通道已关闭。";
   if(main){main.mouseEnabled=main.mouseChildren=!pending&&!animating&&!confirmation;main._upBtn.enable=Boolean(projection.canSpin&&!pending&&!animating);main._exchangeBtn.enable=Boolean(projection.canExchange&&!pending&&!animating);main._selectedTxt.visible=false;main._stopUpBtn.visible=false;}
   if(exchange){exchange.mouseEnabled=exchange.mouseChildren=!pending&&!animating&&!confirmation;exchange._exchangeBtn.enable=Boolean(projection.canExchange&&!pending&&!animating);}
  }
  private function refreshExchange():void {if(!exchange)return;exchange._score=projection.score;exchange._fold=projection.exchange.cost;exchange._currentScore2.text=String(projection.score);exchange._currentScore.text="本地积分";exchange._proportion.htmlText="10积分 = 1份普通材料（邮件）";
   exchange._proportion.x=30;exchange._proportion.width=340;exchange._proportion.height=26;var limit:int=Math.min(projection.exchange.maxCount,Math.floor(projection.score/projection.exchange.cost));exchange._chooseNum.valueLimit="1,"+Math.max(1,limit);if(exchange._chooseNum.currentValue>limit||exchange._chooseNum.currentValue<1)exchange._chooseNum.currentValue=1;}
  private function openExchange():void {if(pending||animating)return;if(exchange){refreshExchange();return;}exchange=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("DDPlay.exchange.frame");sceneRoot.addChild(exchange as DisplayObject);exchange.x=300;exchange.y=165;refreshExchange();lock();}
  private function bind(owner:Object,target:Object,type:String,fn:Function):void {if(!bindings[owner])bindings[owner]=[];target.addEventListener(type,fn);bindings[owner].push([target,type,fn]);}
  private function unbind(owner:Object):void {var rows:Array=bindings[owner] as Array;if(rows)for each(var r:Array in rows)r[0].removeEventListener(r[1],r[2]);delete bindings[owner];}
  private function stopBubble(e:Event):void{e.stopPropagation();}
  private function onKey(e:KeyboardEvent):void {if(e.keyCode===27)closeNative();e.stopPropagation();}
  private function tick(e:Event):void {try{role();}catch(error:Error){fail(error.message);}}
  private function killView(o:Object):void {unbind(o);o.timer.stop();var T:Object=cls("com.greensock.TweenLite");for each(var f:String in ["_sixBogu1","_sixBogu2","_sixBogu3"])if(o[f])T.killTweensOf(o[f]);for each(f in ["tw1","tw2","tw3"])if(o[f]){o[f].kill();o[f]=null;}
   for each(f in ["_bg","_sixBogu1","_sixBogu2","_sixBogu3","_boguMaskSp1","_boguMaskSp2","_boguMaskSp3","_boguMask1","_boguMask2","_boguMask3","_tripleMc","_fivefoldMc","_tenfoldMc","_triple","_fivefold","_tenfold","_lights","_shine1","_shine2","_shine3","_titleLight","_finallyLight","_finallyFireWork","_upBtn","_stopUpBtn","_selectedTxt","_exchangeBtn","_explameTxt","_coinsTxt","_scoreTxt"])if(o[f]){cls("com.pickgliss.utils.ObjectUtils").disposeObject(o[f]);o[f]=null;}}
  private function killExchange(o:Object):void {unbind(o);for each(var f:String in ["_bg","_exchangeBtn","_chooseNum","_exchangeNum","_currentScore","_proportion","_currentScoreBg","_currentScore2"])if(o[f]){cls("com.pickgliss.utils.ObjectUtils").disposeObject(o[f]);o[f]=null;}}
  public function closeNative():Object {
   wantedOpen=false;clearConfirm();var failed:String="";
   if(exchange){var ex:Object=exchange;exchange=null;try{ex.dispose();}catch(exError:Error){unbind(ex);failed=exError.message;}}
   if(main){var view:Object=main;main=null;try{view.dispose();}catch(viewError:Error){unbind(view);failed=viewError.message;}}
   if(sceneRoot){sceneRoot.removeEventListener(Event.ENTER_FRAME,tick);sceneRoot.removeEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.removeEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.removeEventListener(MouseEvent.MOUSE_DOWN,stopBubble);if(sceneRoot.parent)sceneRoot.parent.removeChild(sceneRoot);sceneRoot=null;}notice=null;animating=false;
   if(failed){phase="failed";message="原弹弹乐关闭未完整清理，请重新进入游戏："+failed;}report();return statusNative();
  }
  public function abortNative(reason:String):void {closeNative();fail(reason);}
  private function fail(reason:String):void {if(phase==="failed")return;phase="failed";message=reason;closeNative();report();}
  private function say(value:String):void {message=value;lock();report();}
  private function report():void {try{ExternalInterface.call("workshopDDPlayReport",statusNative());}catch(error:Error){}}
  public function statusNative():Object {return {phase:phase,characterId:expectedId,generation:generation,sequence:sequence,revision:lastRevision,open:sceneRoot!==null,pending:pending,requestId:pendingId,animating:animating,message:message,experimental:true};}
  public static function get Instance():WorkshopNativeDDPlayBootstrap {if(!active)throw new Error("弹弹乐尚未初始化。");return active;}
  public static function getInstance():WorkshopNativeDDPlayBootstrap {return Instance;}
  public function get Self():Object {var self:Object=cls("ddt.manager.PlayerManager").Instance.Self;return {bagLocked:self.bagLocked,PropBag:{getItemCountByTemplateId:function(id:int):int{return active.projection?Math.floor(active.projection.score/active.projection.spinCost):0;}}};}
  public function show(value:String):void {say(value);}
  public function sysChatLinkYellow(value:String):void {say(value);}
  public static function GetTranslation(key:String,...args):String {var labels:Object={"tank.ddPlay.view.explame":"本地10积分／次；倍率0／2／3／5／10，原服数值与概率未导入。","tank.ddPlay.view.getMoney":"本次按本地倍率 "+(args.length?args[0]:"")+" 结算活动积分。","tank.ddPlay.exchangeFrame.title":"本地积分兑换普通材料","tank.ddPlay.exchangeFrame.currentScore":"本地积分","tank.ddPlay.exchangeFrame.proportion":"10积分 = 1份普通材料（邮件）","tank.ddPlay.exchangeFrame.scoreNotEnough":"本地活动积分不足。"};if(labels.hasOwnProperty(key))return String(labels[key]);return active?String(active.cls("ddt.manager.LanguageMgr").GetTranslation.apply(null,[key].concat(args))):key;}
  public static function dispatch(owner:String,name:String,o:Object,args:Array):* {if(!active)throw new Error("原弹弹乐桥未初始化。");return active.handle(owner,name,o,args);}
  private function handle(owner:String,name:String,o:Object,args:Array):* {
   if(owner==="DDPlay/DDPlayManaer"){if(name==="show"){openNative();return;}throw new Error("原 DDPlay 74/75/76/77 通道已禁用："+name);}
   if(owner==="DDPlay/DDPlayView"){
    if(name==="initEvent"){bind(o,o,"response",function(e:Object):void{if(e.responseCode===0||e.responseCode===1)closeNative();});bind(o,o._upBtn,MouseEvent.CLICK,function(e:Event):void{if(projection.canSpin)confirm({type:"spin"},projection.spinCost);});bind(o,o._exchangeBtn,MouseEvent.CLICK,function(e:Event):void{openExchange();});return;}
    if(name==="removeEvent"){unbind(o);return;}if(name==="sendPkg")return;
    if(name==="doUpHonor"){if(projection.canSpin)confirm({type:"spin"},projection.spinCost);return;}
    if(name==="__scoreExchange"){openExchange();return;}if(name==="show")return;
    if(name==="dispose"){killView(o);return;}
    if(name==="animationComplete"){if(o!==main||!sceneRoot)return;animating=false;o.isPlaying=false;main._scoreTxt.text=String(projection.score);main._coinsTxt.text=String(Math.floor(projection.score/projection.spinCost));lock();report();return;}
    if(name==="stopDoUpHonor"){o.timer.stop();return;}if(name==="__checkBoxClick"){say("每次转动需手动确认本地积分。");return;}
    throw new Error("原自动抽奖或 socket 回包已禁用："+name);
   }
   if(owner==="DDPlay/DDPlayExchangeFrame"){
    if(name==="initEvent"){bind(o,o,"response",function(e:Object):void{if(e.responseCode===0||e.responseCode===1){exchange=null;o.dispose();lock();}});bind(o,o._exchangeBtn,MouseEvent.CLICK,function(e:Event):void{handle(owner,"__exchange",o,[]);});return;}
    if(name==="removeEvent"){unbind(o);return;}if(name==="__updateScore"){refreshExchange();return;}if(name==="__numberChange")return;
    if(name==="__exchange"){var count:Number=o._chooseNum.currentValue;if(!integer(count,1,projection.exchange.maxCount)||count*projection.exchange.cost>projection.score){say("兑换数量无效或本地积分不足。");return;}confirm({type:"exchange",count:count},count*projection.exchange.cost);return;}
    if(name==="dispose"){killExchange(o);return;}
    if(name==="__responseHandler"){exchange=null;o.dispose();lock();return;}
   }
   throw new Error("未实现的原弹弹乐适配："+owner+"."+name);
  }
 }
}
