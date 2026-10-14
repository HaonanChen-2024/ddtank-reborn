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

 /** Original 70-cell UI; only the page owns authentication, UUIDs and HTTP requests. */
 public final class WorkshopNativeMinesBootstrap extends Sprite {
  private static var active:WorkshopNativeMinesBootstrap;
  private var domain:ApplicationDomain=ApplicationDomain.currentDomain;
  private var hostContext:LoaderContext;
  private var base:String,expectedId:int,generation:String,phase:String="new";
  private var sequence:int=0,pending:Boolean=false,pendingId:String="",pendingAction:Object;
  private var response:Object,projection:Object,lastRevision:Number=-1;
  private var wantedOpen:Boolean=false,animating:Boolean=false,pendingPath:Array,walkResult:Object;
  private var sceneRoot:Sprite,game:Object,control:Object,startButton:Sprite,notice:TextField,confirmation:Sprite;
  private var modals:Array=[],loaders:Array=[],bindings:Dictionary=new Dictionary(true);
  private var message:String="尚未读取原扫雷存档。";
  public function WorkshopNativeMinesBootstrap(){}
  public static function get instance():WorkshopNativeMinesBootstrap{return active;}
  private function cls(name:String):Object {if(!domain.hasDefinition(name))throw new Error("缺少原扫雷依赖："+name);return domain.getDefinition(name);}
  private function create(name:String,arg:Object=null,hasArg:Boolean=false):Object {var C:Class=cls(name) as Class;return hasArg?new C(arg):new C();}
  private function role():void {
   var c:LoaderContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(!c||(hostContext&&c!==hostContext))throw new Error("扫雷共享加载上下文改变。");
   var d:ApplicationDomain=c.applicationDomain;
   if(!d||!d.hasDefinition("WorkshopNativeMinesBootstrap")||d.getDefinition("WorkshopNativeMinesBootstrap")!==WorkshopNativeMinesBootstrap)throw new Error("扫雷模块不在实际共享域。");
   if(hostContext)for each(var n:String in ["App","Config","morn.core.components.View"])if(!d.hasDefinition(n)||d.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享组件身份改变。");
   if(cls("ddt.manager.StateManager").currentStateType!=="main"||int(cls("ddt.manager.PlayerManager").Instance.Self.ID)!==expectedId)throw new Error("请返回同一真实角色的大厅。");
  }
  public function startNative(options:Object):void {
   if(phase!=="new"||active)throw new Error("扫雷候选不能重复初始化。");
   if(!options||!options.baseUrl||!options.generation||int(options.expectedUserId)<=0||options.sharedOwnerReady!==true)throw new Error("缺少真实角色、代次或共享 owner。");
   expectedId=int(options.expectedUserId);generation=String(options.generation);base=String(options.baseUrl);if(base.charAt(base.length-1)!="/")throw new Error("本地资源路径缺少结尾斜线。");
   role();hostContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(options.sharedContext!==hostContext||!(options.sharedDomain is ApplicationDomain))throw new Error("共享 owner 上下文不一致。");
   domain=hostContext.applicationDomain;
   for each(var n:String in ["App","Config","morn.core.components.View"])if(!domain.hasDefinition(n)||!options.sharedDomain.hasDefinition(n)||domain.getDefinition(n)!==options.sharedDomain.getDefinition(n))throw new Error("共享类不一致。");
   if(!ExternalInterface.available)throw new Error("当前页面没有原扫雷桥接。");
   active=this;phase="loading";
   ExternalInterface.addCallback("workshopMinesAcceptSnapshot",acceptSnapshot);ExternalInterface.addCallback("workshopMinesRejectRequest",rejectRequest);
   ExternalInterface.addCallback("workshopMinesOpenNative",openNative);ExternalInterface.addCallback("workshopMinesCloseNative",closeNative);ExternalInterface.addCallback("workshopMinesStatusNative",statusNative);
   loadSwf("mines-original-library.swf",function():void{loadSwf("boguadventure_v3_6_1_u1.swf",loadStyles);});
  }
  private function loadSwf(file:String,next:Function):void {
   if(phase=="failed")return;role();var loader:Loader=new Loader();loaders.push(loader);
   loader.contentLoaderInfo.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase=="failed")return;try{role();next();}catch(error:Error){fail(error.message);}});
   loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("资源读取失败："+file);});loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("资源访问失败："+file);});
   loader.contentLoaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,function(e:UncaughtErrorEvent):void{fail(String(e.error));});
   var context:LoaderContext=new LoaderContext(false,domain);context.allowCodeImport=true;loader.load(new URLRequest(base+file),context);
  }
  private function bytes(file:String,next:Function):void {
   if(phase=="failed")return;role();var loader:URLLoader=new URLLoader();loaders.push(loader);loader.dataFormat=URLLoaderDataFormat.BINARY;
   loader.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("配置读取失败："+file);});loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("配置访问失败："+file);});
   loader.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase=="failed")return;try{role();next(loader.data as ByteArray);}catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+file));
  }
  private function loadStyles():void {bytes("bogu-styles.xml",function(b:ByteArray):void {var xml:XML=new XML(b.readUTFBytes(b.length));cls("com.pickgliss.ui.ComponentFactory").Instance.setup(xml);loadLayout();});}
  private function loadLayout():void {bytes("boguadventure_v3_6_1_u1.ui",function(b:ByteArray):void {
   b.uncompress();b.position=0;var layouts:Object=b.readObject();if(b.bytesAvailable)throw new Error("原布局含多余数据。");
   var count:int=0;for(var key:String in layouts){if(!(layouts[key] is XML))throw new Error("原布局类型不符。");
    if(key=="BoguAdventureHelpView.xml"){
     var lines:Array=["本地70格：10雷、3条生命，首开安全，每日最多3局。","安全格达到10／30／60格后手动领奖，奖励通过邮件发放。","标记用于记录疑似地雷，再次标记可取消；标记格不能移动。","探雷消耗5活动积分，仅探明附近一颗地雷，不移除地雷。","每局可用15活动积分复活一次；免费重置用完后需确认积分重置。","头顶数字表示周围8格的雷数；重复走安全格不会重复计数。"];
     var i:int=0;for each(var label:XML in layouts[key].Label){label.@text=lines[i++];label.@size=13;label.@width=570;}if(i!=6)throw new Error("原帮助布局不是6条规则。");
    }
    cls("morn.core.components.View").uiMap[key]=layouts[key];count++;
   }if(count!=4)throw new Error("原扫雷布局必须为4份。");cls("App").stage=cls("com.pickgliss.toplevel.StageReferance").stage;cls("App").asset.setDomain(domain);
   phase="ready";message="原扫雷资源已准备；打开只读取存档。";report();
  });}
  public function openNative():Object {
   role();if(phase!=="ready")return statusNative();
   if(pending&&pendingAction==null&&!animating){wantedOpen=true;report();return statusNative();}
   if(pending||animating){say("已有操作尚未确认，请处理原请求。");return statusNative();}
   if(sceneRoot)return statusNative();wantedOpen=true;read();return statusNative();
  }
  private function read():void {role();pending=true;pendingId="";pendingAction=null;sequence++;lock();try{var ok:Object=ExternalInterface.call("workshopMinesRead",expectedId,generation,sequence);if(!ok||ok.accepted!==true){pending=false;throw new Error("页面未接受原扫雷读取。");}}catch(e:Error){say(e.message);}}
  private function request(action:Object):void {
   role();if(pending||animating||!projection)return;if(cls("ddt.manager.PlayerManager").Instance.Self.bagLocked){say("请先解除背包锁定。");return;}
   pending=true;pendingAction=action;pendingId="";sequence++;lock();try{var ok:Object=ExternalInterface.call("workshopMinesRequest",expectedId,generation,sequence,action);if(!ok||ok.accepted!==true||!ok.requestId){pending=false;pendingAction=null;throw new Error("页面未接受操作，没有提交新的积分请求。");}pendingId=String(ok.requestId);}catch(e:Error){say(e.message);}report();
  }
  private function validate(p:Object):void {
   if(!p||p.hasOwnProperty("board")||p.hasOwnProperty("mines")||p.hasOwnProperty("state")||!p.localRules||p.localRules.version!==1||p.localRules.width!==10||p.localRules.height!==7||p.localRules.manualClaims!==true)throw new Error("无效的原扫雷公开投影。");
   if(!(p.localRules.rewards is Array)||p.localRules.rewards.length!=3)throw new Error("本地规则缺少三档材料奖励。");if(p.started===false)return;if(p.started!==true||p.width!==10||p.height!==7||!(p.cells is Array)||p.cells.length!=70||!(p.claims is Array)||p.claims.length!=3)throw new Error("原棋盘必须为10×7和三档领奖。");
   if(p.currentIndex!==null&&(!integer(p.currentIndex,0,69)))throw new Error("当前位置无效。");if(!integer(p.hp,0,3)||!integer(p.openCount,0,60))throw new Error("生命或进度无效。");
   for(var i:int=0;i<70;i++){var c:Object=p.cells[i];if(!c||c.index!==i||typeof c.opened!=="boolean"||typeof c.marked!=="boolean"||typeof c.probed!=="boolean")throw new Error("格子公开信息无效。");if(!c.opened&&!c.probed&&(c.hasOwnProperty("mine")||c.hasOwnProperty("aroundMineCount")))throw new Error("隐藏格泄露雷位或雷数。");if(c.opened&&c.mine!==true&&!integer(c.aroundMineCount,0,8))throw new Error("已开安全格缺少雷数。");}
   for(i=0;i<3;i++){var tier:Object=p.claims[i];if(tier.tier!==i+1||!integer(tier.requiredOpenCount,1,60)||!(tier.rewards is Array)||!tier.rewards.length)throw new Error("奖励档位无效。");}
  }
  private function integer(v:*,lo:int,hi:int):Boolean{return typeof v=="number"&&isFinite(v)&&v==Math.floor(v)&&v>=lo&&v<=hi;}
  public function acceptSnapshot(envelope:Object):Object {
   try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}
   return statusNative();
  }
  private function applySnapshot(envelope:Object):Object {
   if(phase=="failed")throw new Error("原扫雷已失败，拒绝迟到响应。");role();if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");
   var value:Object=envelope.snapshot;if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("动作UUID不符。");validate(value.nativeMines);
   var action:Object=pendingAction,fresh:Boolean=Boolean(action&&!value.replayed&&value.nativeMinesAction&&value.nativeMinesAction.requestId===pendingId),effects:Array=fresh?value.nativeMinesAction.effects as Array:null;
   response=value;projection=value.nativeMines;lastRevision=value.revision;pending=false;pendingAction=null;pendingId="";
   if(!sceneRoot&&!action&&wantedOpen)constructWindow();
   if(sceneRoot){bindModel();game.updateHp();if(fresh&&action.type=="walk"&&pendingPath&&control.bogu){walkResult=null;for each(var effect:Object in effects)if(effect.type=="walked"||effect.type=="mine")walkResult=effect;if(!walkResult)throw new Error("开格响应缺少可验证结果。");animating=true;game._changeView.boguWalk(pendingPath);pendingPath=null;}
    else if(fresh&&action.type=="probe"&&control.bogu){var index:int=-1;for each(effect in effects)if(effect.type=="probed")index=int(effect.index);if(index>=0){game._fineMineTimesText.text=String(projection.findMineTimes);game._map.getCellByIndex(index).info.state=3;animating=true;control.isMove=true;game._map.mouseClickClose();game.updateCell(index,3,1,true);}else refresh();}
    else refresh();
   }else pendingPath=null;
   message=value.message?String(value.message):"已读取本地70格进度。";lock();report();return statusNative();
  }
  public function rejectRequest(envelope:Object):Object {
   role();if(phase=="failed"||!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)return statusNative();if(pendingAction&&String(envelope.requestId)!==pendingId)return statusNative();
   if(envelope.definitive===true){pending=false;pendingAction=null;pendingId="";pendingPath=null;if(sceneRoot){bindModel();refresh();}}say(String(envelope.message||"请求结果未知，请使用页面重试原请求。"));return statusNative();
  }
  private function constructWindow():void {
   role();sceneRoot=new Sprite();sceneRoot.addChild(cls("com.pickgliss.ui.ComponentFactory").Instance.creat("boguAdventure.stateView.Bg"));
   control=create("activity.boguAdventure.BoguAdventureControl");bindModel();game=create("activity.boguAdventure.view.BoguAdventureGameView",control,true);sceneRoot.addChild(game as DisplayObject);
   notice=text(12,7,780,32);sceneRoot.addChild(notice);sceneRoot.addChild(button("关闭扫雷",875,8,function():void{closeNative();}));startButton=button("开始本局",430,270,function():void{request({type:"start"});});sceneRoot.addChild(startButton);
   cls("com.pickgliss.toplevel.StageReferance").stage.addChild(sceneRoot);cls("com.pickgliss.toplevel.StageReferance").stage.focus=sceneRoot;sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);
   lock();
  }
  private function stopBubble(e:Event):void{e.stopPropagation();}
  private function onKey(e:KeyboardEvent):void {if(e.keyCode==27){closeNative();e.stopImmediatePropagation();return;}if(e.keyCode==70&&game&&!pending&&!animating){control.changeMouse=!control.changeMouse;say(control.changeMouse?"标记模式：点击一格标记或取消。":"已退出标记模式。");}e.stopPropagation();}
  private function tick(e:Event):void {if(!sceneRoot)return;try{role();if(game)game.updateView();if(animating&&control&&!control.isMove&&!walkResult){animating=false;lock();}}catch(error:Error){fail(error.message);}}
  private function bindModel():void {
   if(!control)return;var m:Object=control.model,p:Object=projection,r:Object=projection.localRules;
   control.currentIndex=p.started&&p.currentIndex!==null?int(p.currentIndex):-1;control._hp=p.started?int(p.hp):int(r.lives);
   m.openCount=p.started?p.openCount:0;m.freeResetCount=p.started?p.freeResetCount:1;m.resetCount=0;m.findMinePrice=r.probePointCost;m.revivePrice=r.revivePointCost;m.resetPrice=r.resetPointCost;m.findMineTimes=p.started?p.findMineTimes:0;
   m.awardCount=[];m.awardGoodsTip=[];m.rankList=[];m.selfRank=0;m.selfScore=response?response.points:0;
   for(var i:int=0;i<3;i++){var reward:Object=r.rewards[i];m.awardCount.push(reward.requiredOpenCount);var item:Object=cls("ddt.manager.ItemManager").Instance.getTemplateById(reward.templateId);if(!item)throw new Error("本地奖励模板未安装。");m.awardGoodsTip.push(String(item.Name)+" × "+reward.count+"\n手动领取后进入邮件");m["isAcquireAward"+(i+1)]=p.started?p.claims[i].claimed:false;}
   // Original Map cells retain CellInfo references. Update those same objects so
   // an acknowledged walk can animate without rebuilding/resetting the actor.
   var cells:Array=m.mapInfoList as Array;if(!cells||cells.length!=70)cells=[];
   for(i=0;i<70;i++){var info:Object=cells[i]||create("activity.boguAdventure.model.BoguAdventureCellInfo"),c:Object=p.started?p.cells[i]:null;info.index=i;info.state=c&&(c.opened||c.probed)?2:c&&c.marked?1:3;info.result=c&&c.mine===true?1:0;info.aroundMineCount=c&&c.opened&&c.mine!==true?int(c.aroundMineCount):0;cells[i]=info;}m.mapInfoList=cells;
  }
  private function refresh():void {if(game&&control.bogu)game.updateMap();if(control)control.dispatchEvent(create("activity.boguAdventure.event.BoguAdventureEvent","boguadventureeventupdatereward",true));lock();}
  private function lock():void {if(!sceneRoot)return;if(notice)notice.text=message;startButton.visible=projection.started!==true;startButton.mouseEnabled=!pending;startButton.mouseChildren=!pending;game.mouseEnabled=game.mouseChildren=Boolean(projection.started&&!pending&&!animating);if(game._reviveBtn)game._reviveBtn.enable=Boolean(projection.started&&projection.canRevive);if(game._findMineBtn)game._findMineBtn.enable=Boolean(projection.started&&projection.canProbe);}
  private function text(x:Number,y:Number,width:Number,height:Number):TextField{var t:TextField=new TextField();t.defaultTextFormat=new TextFormat("Microsoft YaHei",14,0xffefbe);t.x=x;t.y=y;t.width=width;t.height=height;t.selectable=false;t.wordWrap=true;t.background=true;t.backgroundColor=0x392c1b;return t;}
  private function button(label:String,x:Number,y:Number,action:Function):Sprite {var b:Sprite=new Sprite();b.x=x;b.y=y;b.graphics.beginFill(0x6c481f);b.graphics.lineStyle(2,0xe9c56e);b.graphics.drawRoundRect(0,0,110,32,8);b.graphics.endFill();var t:TextField=text(4,4,102,24);t.background=false;t.text=label;t.mouseEnabled=false;b.addChild(t);b.buttonMode=true;b.addEventListener(MouseEvent.CLICK,function(e:MouseEvent):void{e.stopImmediatePropagation();action();});return b;}
  private function confirm(action:Object,cost:int):void {if(pending||animating||!sceneRoot)return;if(confirmation&&confirmation.parent)confirmation.parent.removeChild(confirmation);confirmation=new Sprite();confirmation.graphics.beginFill(0x241a10,0.96);confirmation.graphics.drawRoundRect(0,0,440,145,12);confirmation.graphics.endFill();confirmation.x=280;confirmation.y=220;var label:TextField=text(18,14,404,65);label.text="确认消耗 "+cost+" 活动积分执行本次操作？\n仅操作本地活动积分；不会自动兑换或重复提交。";confirmation.addChild(label);confirmation.addChild(button("确认",65,96,function():void{clearConfirm();request(action);}));confirmation.addChild(button("取消",255,96,clearConfirm));sceneRoot.addChild(confirmation);}
  private function clearConfirm():void {if(confirmation&&confirmation.parent)confirmation.parent.removeChild(confirmation);confirmation=null;}
  private function showModal(view:Object):void {if(!sceneRoot){view.dispose();return;}modals.push(view);sceneRoot.addChild(view as DisplayObject);view.x=Math.max(0,(1000-view.width)/2);view.y=Math.max(35,(600-view.height)/2);}
  private function bind(owner:Object,target:Object,type:String,fn:Function,capture:Boolean=false):void {if(!bindings[owner])bindings[owner]=[];target.addEventListener(type,fn,capture);bindings[owner].push([target,type,fn,capture]);}
  private function unbind(owner:Object):void {var list:Array=bindings[owner] as Array;if(list)for each(var b:Array in list)b[0].removeEventListener(b[1],b[2],b[3]);delete bindings[owner];}
  public function closeNative():Object {
   wantedOpen=false;clearConfirm();var cleanupError:String="";
   for each(var modal:Object in modals)if(modal&&modal.parent){try{modal.dispose();}catch(modalError:Error){cleanupError=modalError.message;}}modals=[];
   if(sceneRoot){
    sceneRoot.removeEventListener(Event.ENTER_FRAME,tick);sceneRoot.removeEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.removeEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.removeEventListener(MouseEvent.MOUSE_DOWN,stopBubble);
    if(game){try{if(!game.parent)sceneRoot.addChild(game as DisplayObject);game.dispose();}catch(gameError:Error){unbind(game);cleanupError=gameError.message;}game=null;}
    if(control){try{control.dispose();}catch(controlError:Error){cleanupError=controlError.message;}control=null;}
    if(sceneRoot.parent)sceneRoot.parent.removeChild(sceneRoot);sceneRoot=null;
   }
   notice=null;startButton=null;animating=false;pendingPath=null;walkResult=null;
   if(cleanupError){phase="failed";message="原扫雷关闭未完整清理，请重新进入游戏："+cleanupError;}
   report();return statusNative();
  }
  public function abortNative(reason:String):void{closeNative();fail(reason);}
  private function fail(s:String):void{if(phase=="failed")return;phase="failed";wantedOpen=false;message=s;closeNative();report();}
  private function say(s:String):void{message=s;lock();report();}
  private function report():void{try{ExternalInterface.call("workshopMinesReport",statusNative());}catch(e:Error){}}
  public function statusNative():Object{return {phase:phase,characterId:expectedId,generation:generation,sequence:sequence,open:sceneRoot!=null,pending:pending,requestId:pendingId,revision:lastRevision,animating:animating,message:message,experimental:true};}

  public function get boguAdventureFreeResetTimes():int{return 0;}
  public function get boguAdventureBeginTime():String{return "本地";}
  public function get boguAdventureEndTime():String{return "常驻";}
  public function get boguAdventureAward():Array {var result:Array=[];if(projection)for each(var r:Object in projection.localRules.rewards)result.push(r.requiredOpenCount+"-"+r.requiredOpenCount+","+r.templateId);return result;}
  public function getActivityIsOpen(id:int):Boolean{return id==102&&phase=="ready";}
  public static function solveBoguAdventurePath():String {if(!active)throw new Error("扫雷未初始化。");return active.base+"bogu-player-game.png";}
  public static function fillByID(id:int):Object {if(!active)throw new Error("扫雷未初始化。");var item:Object=active.create("ddt.data.goods.InventoryItemInfo");item.TemplateID=id;active.cls("ddt.manager.ItemManager").fill(item);return item;}
  public static function GetTranslation(key:String,...args):String {
   var labels:Object={"boguAdventure.view.activityDate":"本地70格 · 积分玩法 · 三档手动邮件领奖","boguAdventure.view.freeFineMine":"已探雷","boguAdventure.view.limitRevive":"免费重置","boguAdventure.view.reviveBtnTip":"消耗本地活动积分复活","boguAdventure.view.resetBtnTip":"重置前请领取已达成奖励","boguAdventure.view.signBtnTip":"标记模式：点击格子标记或取消","boguAdventure.view.findMineBtnTip":"探明附近一颗地雷，不移除地雷","boguAdventure.view.walkTip":"此格已爆炸，不能再次进入。","boguAdventure.view.isSign":"请先取消此格标记。","boguAdventure.view.activityOver":"当前活动未就绪。","boguAdventure.view.gameOver":"本局已完成，请领取奖励。","boguAdventure.view.hpNotEnough":"生命不足，请手动选择复活。","boguAdventure.view.successfulWalkCount":"安全格达到 "+(args.length?args[0]:"")+" 格","ddt.dragonBoat.rankNoPlace":"未提供排行"};
   if(labels.hasOwnProperty(key))return String(labels[key]);return active?String(active.cls("ddt.manager.LanguageMgr").GetTranslation.apply(null,[key].concat(args))):key;
  }
  public static function dispatch(owner:String,name:String,o:Object,args:Array):* {if(!active)throw new Error("原扫雷桥接未初始化。");return active.handle(owner,name,o,args);}
  private function handle(owner:String,name:String,o:Object,args:Array):* {
   if(owner=="activity/boguAdventure/BoguAdventureControl"){
    if(name.indexOf("__")==0)throw new Error("原140回包通道已禁用。");
    if(name=="checkGameOver")return !projection||projection.started!==true||pending||animating||projection.status=="lost"||projection.status=="won";
    if(name=="walk"){if(pending||animating)return;pendingPath=args[0] as Array;var destination:int=o.currentIndex;o.currentIndex=projection.currentIndex===null?-1:int(projection.currentIndex);request({type:"walk",index:destination});return;}
    if(name=="dispose"){o._bogu=null;if(o._model)o._model.dispose();o._model=null;o.signFocus=o.mineFocus=o.mineNumFocus=null;return;}
   }
   if(owner=="activity/boguAdventure/view/BoguAdventureGameView")return gameAction(name,o,args);
   if(owner=="activity/boguAdventure/view/BoguAdventureAwardFrame"){
    if(name=="show"){showModal(o);return;}if(name=="sendAwardAlter"){request({type:"claim",tier:int(o._level)+1});return;}
   }
   if(owner=="activity/boguAdventure/view/BoguAdventureRewardFrame"){
    if(name=="__onHelpClick"){showModal(create("activity.boguAdventure.view.BoguAdventureHelpView"));return;}
    if(name=="__onRankClick"){var tween:Object=cls("com.greensock.TweenLite");tween.killTweensOf(o._view);tween.to(o._view,0.3,{y:o._flag?33:-400});o._flag=!o._flag;return;}
   }
   if(owner=="activity/boguAdventure/view/BoguAdventureRewardView"&&name=="initialize"){
    var H:Class=cls("morn.core.handlers.Handler") as Class;o.viewTab.selectedIndex=1;o.viewTab.getChildByName("item0").disabled=true;o.viewTab.selectHandler=new H(function(i:int):void{o.rankList.visible=false;o.rewardList.visible=true;});
    o.rankList.visible=false;o.rewardList.visible=true;o.rankList.array=[];o.selfScoreLabel.text=response?String(response.points):"0";o.selfRankLabel.text="未提供";
    o.rewardList.renderHandler=new H(function(cell:Object,index:int):void{var rewards:Array=projection.localRules.rewards as Array;cell.visible=index<rewards.length;if(cell.visible){var r:Object=rewards[index];cell.info=r.requiredOpenCount+"-"+r.requiredOpenCount+","+r.templateId;cell.rankLabel.text=r.requiredOpenCount+"格 · ×"+r.count;}});o.rewardList.array=boguAdventureAward;return;
   }
   throw new Error("未实现的原扫雷适配："+owner+"."+name);
  }
  private function gameAction(name:String,o:Object,args:Array):* {
   if(name=="initEvent"){
    bind(o,o._reviveBtn,MouseEvent.CLICK,function(e:Event):void{gameAction("__onReviveClick",o,[]);});bind(o,o._awardBtn,MouseEvent.CLICK,function(e:Event):void{gameAction("__onAwardClick",o,[]);});
    bind(o,o._resetBtn,MouseEvent.CLICK,function(e:Event):void{gameAction("__onResetClick",o,[]);});bind(o,o._freeResetBtn,MouseEvent.CLICK,function(e:Event):void{gameAction("__onResetClick",o,[]);});
    bind(o,o._findMineBtn,MouseEvent.CLICK,function(e:Event):void{gameAction("__onFindMineClick",o,[]);});bind(o,o._signBtn,MouseEvent.CLICK,function(e:Event):void{gameAction("__onSignClick",o,[]);});
    bind(o,o._control,"boguadventureeventevent",function(e:Event):void{gameAction("__onAllEvent",o,[e]);});
    bind(o,o,MouseEvent.CLICK,function(e:MouseEvent):void{if(!control.changeMouse)return;var Cell:Class=cls("activity.boguAdventure.cell.BoguAdventureCell") as Class;if(e.target is Cell){gameAction("signCell",o,[e.target]);e.stopImmediatePropagation();}},true);return;
   }
   if(name=="removeEvent"){unbind(o);return;}
   if(name=="__onAllEvent"){
    var event:Object=args[0],data:Object=event.data;switch(event.eventType){
     case "boguadventureeventwalk":throw new Error("移动必须先由本地API确认。");
     case "boguadventureeventstop":if(walkResult){var result:Object=walkResult;walkResult=null;o.updateCell(result.index,4,result.type=="mine"?1:0,true);if(result.type!="mine"){animating=false;lock();}}return;
     case "boguadventureeventactioncomplete":o.playActionComplete(data);animating=false;lock();return;
     case "boguadventureeventchangehp":o.updateHp();return;
     case "boguadventureeventupdatemap":o.updateMap();lock();return;
     case "boguadventureeventupdatereset":o.updateReset();return;
     case "boguadventureeventupdatecell":throw new Error("原回包格子更新已禁用。");
    }return;
   }
   if(name=="updateReset"){var free:Boolean=Boolean(projection&&projection.started&&projection.freeResetCount>0);o._freeResetBtn.visible=free;o._resetBtn.visible=!free;o._freeResetBtn.enable=Boolean(projection&&projection.canFreeReset);o._resetBtn.enable=Boolean(projection&&projection.canPointsReset);o._limitResetText.visible=o._resetNumText.visible=free;o._resetNumText.text=free?String(projection.freeResetCount):"0";return;}
   if(name=="updateHp"){var hp:Object=o._hpBox;cls("com.pickgliss.utils.ObjectUtils").disposeAllChildren(hp);for(var i:int=0;i<o._control.hp;i++)hp.addChild(cls("com.pickgliss.ui.ComponentFactory").Instance.creat("boguAdventure.stateView.hp"));o._reviveBtn.enable=Boolean(projection&&projection.canRevive);return;}
   if(name=="__onReviveClick"){if(projection.canRevive)confirm({type:"revive"},projection.prices.revive);return;}
   if(name=="__onAwardClick"){o.clearEffect();showModal(create("activity.boguAdventure.view.BoguAdventureAwardFrame",control,true));return;}
   if(name=="__onResetClick"){if(projection.canFreeReset)request({type:"reset",choice:"free"});else if(projection.canPointsReset)confirm({type:"reset",choice:"points"},projection.prices.reset);else say("请先领取已达成奖励，或今日已无重置次数。");return;}
   if(name=="__onFindMineClick"){if(projection.canProbe)confirm({type:"probe"},projection.prices.probe);else say("当前位置附近没有可探明地雷，或当前不可探雷。");return;}
   if(name=="__onSignClick"){if(!pending&&!animating){control.changeMouse=!control.changeMouse;say(control.changeMouse?"标记模式：点击一格标记或取消。":"已退出标记模式。");}return;}
   if(name=="changeMouseStyle"){o._control.changeMouse=Boolean(args[0]);o._mouseStyle.visible=false;return;}
   if(name=="signCell"){var c:Object=args[0].info;control.changeMouse=false;request({type:"mark",index:int(c.index),marked:c.state!=1});return;}
   // Old global key/cursor hooks and pay-confirm callbacks are deliberately unreachable.
   // Rejecting them makes accidental reattachment visible instead of silently spending.
   throw new Error("旧扫雷全局或付费回调已禁用："+name);
  }
 }
}
