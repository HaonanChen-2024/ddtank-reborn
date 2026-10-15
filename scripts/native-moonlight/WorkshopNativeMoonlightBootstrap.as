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
 /** Original Morn windows and movie timelines; the page owns HTTP and UUID receipts. */
 public final class WorkshopNativeMoonlightBootstrap extends Sprite {
  private static var active:WorkshopNativeMoonlightBootstrap;
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
  private var wantedOpen:Boolean=false;
  private var animating:Boolean=false;
  private var projection:Object;
  private var sceneRoot:Sprite;
  private var main:Object;
  private var bag:Object;
  private var popup:Object;
  private var confirmation:Object;
  private var notice:TextField;
  private var message:String="尚未读取本地月光宝盒。";
  private var loaders:Array=[];
  private var bindings:Dictionary=new Dictionary(true);
  private var settledRewards:Array;
  public function WorkshopNativeMoonlightBootstrap(){super();}
  private function cls(name:String):Object {if(!domain.hasDefinition(name))throw new Error("缺少原类："+name);return domain.getDefinition(name);}
  private function manager():Object {return cls("activity.moonLightTeasure.MoonLightTreasureManager").ins;}
  private function model():Object {return manager().model;}
  private function role():void {
   var c:LoaderContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(!c||(hostContext&&c!==hostContext)||!c.applicationDomain.hasDefinition("WorkshopNativeMoonlightBootstrap")||c.applicationDomain.getDefinition("WorkshopNativeMoonlightBootstrap")!==WorkshopNativeMoonlightBootstrap)throw new Error("月光宝盒共享加载域已改变。");
   if(hostContext)for each(var n:String in ["App","Config","morn.core.components.View"])if(!c.applicationDomain.hasDefinition(n)||c.applicationDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享组件身份已改变。");
   if(cls("ddt.manager.StateManager").currentStateType!=="main"||int(cls("ddt.manager.PlayerManager").Instance.Self.ID)!==expectedId)throw new Error("请返回原角色的大厅。");
  }
  public function startNative(options:Object):void {
   if(active||phase!=="new")throw new Error("月光宝盒不能重复初始化。");
   if(!options||int(options.expectedUserId)<=0||!options.generation||!options.baseUrl||options.sharedOwnerReady!==true)throw new Error("缺少真实角色、代次或共享 owner。");
   expectedId=int(options.expectedUserId);generation=String(options.generation);base=String(options.baseUrl);if(base.charAt(base.length-1)!=="/")throw new Error("资源路径缺少斜线。");
   role();hostContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(options.sharedContext!==hostContext||!(options.sharedDomain is ApplicationDomain))throw new Error("共享上下文不一致。");domain=hostContext.applicationDomain;
   for each(var n:String in ["App","Config","morn.core.components.View"])if(!options.sharedDomain.hasDefinition(n)||options.sharedDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享类不一致。");
   if(!ExternalInterface.available)throw new Error("当前页面没有本地宝盒桥接。");active=this;phase="loading";
   ExternalInterface.addCallback("workshopMoonlightAcceptSnapshot",acceptSnapshot);ExternalInterface.addCallback("workshopMoonlightRejectRequest",rejectRequest);
   ExternalInterface.addCallback("workshopMoonlightOpenNative",openNative);ExternalInterface.addCallback("workshopMoonlightCloseNative",closeNative);ExternalInterface.addCallback("workshopMoonlightStatusNative",statusNative);
   loadSwf("moonlight-original-library.swf",function():void{loadSwf("moonlighttreasure_v3_6_1_u1.swf",loadLayouts);});
  }
  private function loadSwf(file:String,next:Function):void {
   if(phase==="failed")return;role();var loader:Loader=new Loader();loaders.push(loader);
   loader.contentLoaderInfo.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();next();}catch(error:Error){fail(error.message);}});
   loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("资源读取失败："+file);});loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("资源访问失败："+file);});
   loader.contentLoaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,function(e:UncaughtErrorEvent):void{fail(String(e.error));});
   var c:LoaderContext=new LoaderContext(false,domain);c.allowCodeImport=true;loader.load(new URLRequest(base+file),c);
  }
  private function loadLayouts():void {
   role();var loader:URLLoader=new URLLoader();loaders.push(loader);loader.dataFormat=URLLoaderDataFormat.BINARY;
   loader.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("原宝盒布局读取失败。");});loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("原宝盒布局访问失败。");});
   loader.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{
    role();var b:ByteArray=loader.data as ByteArray;b.uncompress();b.position=0;var layouts:Object=b.readObject();if(b.bytesAvailable)throw new Error("原布局含多余字节。");
    var required:Array=["MoonlightTreasureMain.xml","MoonlightTreasureDraw.xml","MoonlightBag.xml","item/MoonlightBagItem.xml","MoonlightHelp.xml","MoonlightRewardItem.xml","MoonlightRewardsShow.xml","MoonlightShow.xml","item/MoonlightShowItem.xml","MoonlightExchange.xml"];
    for each(var key:String in required){if(!(layouts[key] is XML))throw new Error("缺少原布局："+key);var xml:XML=layouts[key];
     for each(var node:XML in xml.descendants()){
      var kind:String=String(node.name());if(["Label","LabelEx","TextInput"].indexOf(kind)>=0)node.@font="Microsoft YaHei";if(kind==="Button"||kind==="TabButtonEx")node.@labelFont="Microsoft YaHei";
      if(String(node.@stroke)==="0x1es3a8")node.@stroke="0x153b9b,1,4,4,30";
     }
     if(key==="MoonlightTreasureDraw.xml"){
      for each(node in xml.descendants())if(String(node.@text)==="月光钥匙:")node.@text="活动积分:";
      // Original redDot is invisible and no selected original body references it.
      for(var d:int=xml.Image.length()-1;d>=0;d--)if(String(xml.Image[d].attribute("var"))==="redDot")delete xml.Image[d];
     }
     if(key==="MoonlightHelp.xml"){
      var lines:Array=["1.本地常驻活动：三档开1／3／5盒，每盒20活动积分。","2.四种普通材料以本地接口规则抽取，第10盒保底强化石2级×2。","3.奖品暂存共用临时包，最多30抽取记录；勾选数量寄邮件。","4.选中材料每单位回收2活动积分，剩余数量保留。","5.本地进度10／20／30，各领强化石1级×2／4／6。","6.每10碎片兑换强化石2级×2，不接真实付款或钥匙购买。","7.原全服排行与未知兑换商店尚未移植；关闭不自动消费。"];
      var i:int=0;for each(node in xml.LabelEx){node.@text=lines[i];node.@x=22;node.@y=56+i*42;node.@size=14;node.@width=462;node.@height=40;node.@multiline=true;node.@wordWrap=true;node.@leading=3;i++;}if(i!==7)throw new Error("帮助原布局条数不符。");
     }
     if(key==="MoonlightBag.xml")for each(node in xml.LabelEx)if(String(node.@text)==="拆分可得：")node.@text="回收积分：";
     cls("morn.core.components.View").uiMap[key]=xml;
    }
    cls("App").stage=cls("com.pickgliss.toplevel.StageReferance").stage;cls("App").asset.setDomain(domain);
    phase="ready";message="原宝盒窗口已准备；打开只读取存档。";report();
   }catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+"moonlighttreasure_v3_6_1_u1.ui"));
  }
  public function openNative():Object {role();if(phase!=="ready")return statusNative();if(pending&&pendingAction===null){wantedOpen=true;return statusNative();}if(pending||animating){say("已有操作或动画尚未结束。");return statusNative();}if(sceneRoot)return statusNative();wantedOpen=true;read();return statusNative();}
  private function read():void {role();pending=true;pendingId="";pendingAction=null;sequence++;lock();try{var result:Object=ExternalInterface.call("workshopMoonlightRead",expectedId,generation,sequence);if(!result||result.accepted!==true){pending=false;throw new Error("页面未接受读取。");}}catch(error:Error){pending=false;say(error.message);}}
  private function request(action:Object):void {
   role();if(pending||animating||!projection)return;if(cls("ddt.manager.PlayerManager").Instance.Self.bagLocked){say("请先解除背包锁定。");return;}
   pending=true;pendingId="";pendingAction=action;sequence++;lock();try{var result:Object=ExternalInterface.call("workshopMoonlightRequest",expectedId,generation,sequence,action);if(!result||result.accepted!==true||!result.requestId){pending=false;pendingAction=null;throw new Error("页面未接受操作，未提交积分请求。");}pendingId=String(result.requestId);}catch(error:Error){say(error.message);}report();
  }
  private function integer(v:*,lo:int,hi:int):Boolean {return typeof v==="number"&&isFinite(v)&&v===Math.floor(v)&&v>=lo&&v<=hi;}
  private function material(v:*):Boolean {return [11019,11001,11021,11002].indexOf(v)>=0;}
  private function validate(p:Object):void {
   if(!p||p.version!==1||p.kind!=="moonlight-native"||typeof p.started!=="boolean"||!integer(p.score,0,2147483647)||p.drawCost!==20||p.bagCapacity!==30||!integer(p.bagSlotsUsed,0,30)||!integer(p.draws,0,1000000000)||!integer(p.progressScore,0,1000000000)||!integer(p.fragments,0,1000000000)||!integer(p.pityRemaining,1,10))throw new Error("宝盒公开投影无效。");
   if(typeof p.day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(p.day)||typeof p.bagToken!=="string"||!new RegExp("^"+p.day+":[A-Za-z0-9_-]{43}$").test(p.bagToken)||!p.localRules||p.localRules.version!==1||typeof p.localRules.description!=="string")throw new Error("宝盒包版本或本地规则无效。");
   for each(var f:String in ["canDraw","canTake","canRecycle"])if(typeof p[f]!=="boolean")throw new Error("宝盒资格无效。");
   if(!(p.drawChoices is Array)||p.drawChoices.length!==3)throw new Error("开盒三档缺失。");for(var i:int=0;i<3;i++){var c:Object=p.drawChoices[i];if(c.count!==[1,3,5][i]||c.cost!==c.count*20||typeof c.canDraw!=="boolean")throw new Error("开盒档位无效。");}if(p.canDraw!==p.drawChoices[0].canDraw)throw new Error("开盒资格不符。");
   if(!(p.bag is Array)||p.bag.length>4||!(p.previewTemplateIds is Array)||p.previewTemplateIds.join(",")!=="11019,11001,11021,11002")throw new Error("材料目录无效。");var seen:Array=[];var total:int=0;for(i=0;i<p.bag.length;i++){var o:Object=p.bag[i];if(o.index!==i||!material(o.templateId)||seen.indexOf(o.templateId)>=0||!integer(o.itemCount,1,60)||o.recycleUnitPoints!==2)throw new Error("临时包材料无效。");seen.push(o.templateId);total+=o.itemCount;}if(total>60||(p.bagSlotsUsed===0)!==(p.bag.length===0)||p.canTake!==(p.bag.length>0)||(p.canRecycle&&p.bag.length===0))throw new Error("临时包总量无效。");
   if(!p.exchange||p.exchange.fragmentCost!==10||p.exchange.templateId!==11021||p.exchange.itemCount!==2||p.exchange.maxCount!==10||p.exchange.affordableCount!==Math.min(10,Math.floor(p.fragments/10))||p.exchange.canExchange!==(p.fragments>=10)||!(p.progress is Array)||p.progress.length!==3)throw new Error("奖励配置无效。");
   for(i=0;i<3;i++){o=p.progress[i];if(o.tier!==i+1||o.target!==(i+1)*10||o.templateId!==11019||o.itemCount!==(i+1)*2||typeof o.claimed!=="boolean"||typeof o.canClaim!=="boolean"||(o.claimed&&o.canClaim))throw new Error("进度奖励无效。");}
  }
  private function effects(value:Object,action:Object):Object {
   var envelope:Object=value.nativeMoonlightAction;if(!envelope||envelope.requestId!==pendingId||!(envelope.effects is Array)||envelope.effects.length!==1)throw new Error("宝盒动作效果缺失。");var e:Object=envelope.effects[0],p:Object=value.nativeMoonlight;
   if(action.type==="draw"){
    if(e.type!=="drawn"||e.count!==action.count||e.cost!==action.count*20||e.score!==p.score||e.draws!==p.draws||!(e.rewards is Array)||e.rewards.length<1||e.rewards.length>4)throw new Error("开盒效果不符。");var total:int=0;var ids:Array=[];for each(var reward:Object in e.rewards){if(!material(reward.templateId)||ids.indexOf(reward.templateId)>=0||!integer(reward.itemCount,1,10))throw new Error("开盒材料效果无效。");ids.push(reward.templateId);total+=reward.itemCount;}if(total<action.count||total>action.count*2)throw new Error("开盒数量不符。");
   }else if(action.type==="take"||action.type==="recycle"){
    if(e.type!==(action.type==="take"?"taken":"recycled")||!(e.items is Array)||e.items.length!==action.items.length)throw new Error("临时包结算效果不符。");var awarded:int=0;for each(var choice:Object in action.items){var match:Object=null;for each(var item:Object in e.items)if(item.index===choice.index)match=item;var old:Object=projection.bag[choice.index];if(!match||match.templateId!==old.templateId||match.itemCount!==choice.count)throw new Error("结算材料数量不符。");awarded+=choice.count;}if(action.type==="recycle"&&(e.pointsAwarded!==awarded*2||e.score!==p.score))throw new Error("回收积分不符。");if(action.type==="take"&&e.itemCount!==awarded)throw new Error("取出总量不符。");
   }else if(action.type==="exchange"){var count:int=action.count===undefined?1:action.count;if(!integer(count,1,10)||e.type!=="exchanged"||e.count!==count||e.fragmentsSpent!==count*10||e.fragments!==p.fragments||e.templateId!==11021||e.itemCount!==count*2)throw new Error("兑换效果不符。");}
   else if(action.type==="progress"){if(e.type!=="progress-claimed"||e.tier!==action.tier||e.templateId!==11019||e.itemCount!==action.tier*2||!p.progress[action.tier-1].claimed)throw new Error("进度领奖效果不符。");}else throw new Error("未知宝盒动作。");return e;
  }
  public function acceptSnapshot(envelope:Object):Object {try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}return statusNative();}
  private function applySnapshot(envelope:Object):Object {
   if(phase==="failed")throw new Error("已失败，拒绝迟到响应。");role();if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");
   var value:Object=envelope.snapshot;if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("动作 UUID 不符。");validate(value.nativeMoonlight);
   var action:Object=pendingAction,e:Object=null,fresh:Boolean=Boolean(action&&!value.replayed);if(fresh)e=effects(value,action);
   projection=value.nativeMoonlight;lastRevision=value.revision;pending=false;pendingId="";pendingAction=null;syncModel();
   if(!sceneRoot&&!action&&wantedOpen)constructWindow();if(main)renderStatic();if(action&&action.type==="exchange"&&popup)refreshExchange(popup,1);message=value.message?String(value.message):"已读取本地宝盒。";
   if(main&&wantedOpen&&fresh&&action.type==="draw"){
    closeBag();closePopup();settledRewards=[];for each(var reward:Object in e.rewards)settledRewards.push({id:reward.templateId,count:reward.itemCount});animating=true;lock();
    var E:Object=cls("activity.ActivityNormalEvent");manager().dispatchEvent(new E("drawInfo",{type:[1,3,5].indexOf(action.count)+1,rewards:settledRewards}));
   }
   lock();report();return statusNative();
  }
  public function rejectRequest(envelope:Object):Object {role();if(phase==="failed"||!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)return statusNative();if(pendingAction&&String(envelope.requestId)!==pendingId)return statusNative();if(envelope.definitive===true){pending=false;pendingAction=null;pendingId="";if(main)renderStatic();}say(String(envelope.message||"请求结果未知，请从页面重试原请求。"));return statusNative();}
  private function syncModel():void {
   var m:Object=model();m.keyCount=projection.score;m.chipCount=projection.fragments;m.openCount=projection.progressScore;m.bagArr=[];for each(var row:Object in projection.bag)m.bagArr.push({itemID:row.templateId,count:row.itemCount});m.rewardState=new Dictionary();for each(row in projection.progress)if(row.claimed)m.rewardState[row.target]=true;
   var C:Object=cls("activity.moonLightTeasure.MoonlightShowTemp");m.showTempArr=[];m.bigShowTempArr=[];m.normalShwoTempArr=[];
   for(var i:int=0;i<4;i++){var temp:Object=new C();temp.ItemId=projection.previewTemplateIds[i];temp.Number=1;temp.ConvertNum=0;for each(row in projection.bag)if(row.templateId===temp.ItemId)temp.ConvertNum=row.recycleUnitPoints;temp.Probability="本地材料 · 保底见说明";temp.IsShow=2;temp.SortId=i+1;m.showTempArr.push(temp);m.bigShowTempArr.push(temp);m.normalShwoTempArr.push(temp);}
   // Dates only satisfy the original formatting ABI; its visible text is explicitly local and permanent.
   var parts:Array=projection.day.split("-");m.startDate=new Date(int(parts[0]),int(parts[1])-1,int(parts[2]));m.endDate=m.startDate;m.showDate=m.startDate;
  }
  private function renderStatic():void {
   if(!main)return;manager().dispatchEvent(new Event("playerInfo"));manager().dispatchEvent(new Event("bagInfo"));var draw:Object=main.drawView;draw.keyCountTxt.text=String(projection.score);draw.keyCountTxt.x=98;draw.keyCountTxt.width=98;draw.keyCountTxt.size=13;draw.addKeyBtn.visible=false;draw.pageSelecte.totle=4;
   for(var i:int=0;i<3;i++){var box:Object=draw.getChildByName("openBox"+i);box.getChildByName("needKeyCount").text=projection.drawChoices[i].cost+"积分";var b:Object=box.getChildByName("drawBtn");b.label="开启"+projection.drawChoices[i].count+"盒";b.labelSize=18;b.disabled=pending||animating||!projection.drawChoices[i].canDraw;var reward:Object=draw.getChildByName("rewardItem"+i);reward.desTxt.text=projection.progress[i].target+"进度";}
   main.timeTxt.text="本地常驻 · 每盒20积分 · 第10盒保底";main.timeTxt.x=565;main.timeTxt.width=370;main.timeTxt.size=13;
   if(notice)notice.text="本地1／3／5盒：20／60／100积分；临时包记录 "+projection.bagSlotsUsed+"／30；每单位回收2积分。";
  }
  private function constructWindow():void {
   role();sceneRoot=new Sprite();sceneRoot.graphics.beginFill(0x000000,0.7);sceneRoot.graphics.drawRect(0,0,1000,600);sceneRoot.graphics.endFill();var C:Object=cls("activity.moonlightbox.MoonlightTreasureMain");main=new C();main.x=12;main.y=66;sceneRoot.addChild(main as DisplayObject);main.viewTab.cells[2].disabled=true;main.viewTab.cells[2].label="排行待移植";main.viewTab.cells[1].label="本地碎片兑换";
   notice=text(24,578,956,21,"",0xe9f5ff);sceneRoot.addChild(notice);var host:Object=cls("com.pickgliss.ui.LayerManager").Instance;host.addToLayer(sceneRoot,3,true,1);
   sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);cls("com.pickgliss.toplevel.StageReferance").stage.focus=sceneRoot;
  }
  private function text(x:int,y:int,w:int,h:int,value:String,color:uint):TextField {var t:TextField=new TextField();t.x=x;t.y=y;t.width=w;t.height=h;t.defaultTextFormat=new TextFormat("Microsoft YaHei",13,color);t.text=value;t.mouseEnabled=false;return t;}
  private function lock():void {
   var blocked:Boolean=pending||animating||confirmation!==null||popup!==null||bag!==null;
   if(main){main.drawView.mouseChildren=!blocked;main.drawView.mouseEnabled=!blocked;main.viewTab.mouseChildren=!blocked;main.viewTab.mouseEnabled=!blocked;main.helpBtn.disabled=pending||animating;}
   if(bag){bag.list.mouseChildren=!pending;bag.checkBtn.disabled=pending;bag.getBtn.disabled=pending||!projection.canTake;bag.backBtn.disabled=pending||!projection.canRecycle;}
   if(popup){popup.mouseChildren=!pending&&!confirmation;popup.mouseEnabled=!pending&&!confirmation;}if(notice&&message)notice.text=message;
  }
  private function confirm(value:String,action:Object):void {
   if(pending||animating||confirmation||!main)return;var info:Object=cls("com.pickgliss.ui.vo.AlertInfo"),frame:Object=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("SimpleAlert");confirmation=frame;frame.info=new info("月光宝盒 · 本地确认","确认","取消",true,true,value,false,false,false,true);frame.moveEnable=false;
   bind(frame,frame,"response",function(e:Object):void{var accepted:Boolean=e.responseCode===2||e.responseCode===3;clearConfirm();if(accepted&&main&&wantedOpen)request(action);});cls("com.pickgliss.ui.LayerManager").Instance.addToLayer(frame,3,true,1);lock();
  }
  private function clearConfirm():void {if(confirmation){var frame:Object=confirmation;confirmation=null;unbind(frame);frame.dispose();}lock();}
  private function openBag():void {if(pending||animating||!main)return;closePopup();closeBag();var C:Object=cls("activity.moonlightbox.view.MoonlightBagView");bag=new C();bag.closeBtn.clickHandler=handler(closeBag);place(bag);manager().dispatchEvent(new Event("bagInfo"));lock();}
  private function closeBag():void {if(bag){var view:Object=bag;bag=null;view.dispose();}lock();}
  private function place(view:Object):void {view.x=(1000-view.width)/2;view.y=(600-view.height)/2;sceneRoot.addChild(view as DisplayObject);}
  private function closePopup():void {if(popup){var view:Object=popup;popup=null;unbind(view);view.dispose();}lock();}
  private function openPopup(name:String):Object {if(!main||pending||animating)return null;closeBag();closePopup();var C:Object=cls(name);popup=new C();place(popup);lock();return popup;}
  private function openHelp():void {var v:Object=openPopup("activity.moonlightbox.mornui.MoonlightHelpUI");if(!v)return;v.closeBtn.clickHandler=handler(closePopup);v.okBtn.clickHandler=handler(closePopup);}
  private function handler(fn:Function,args:Array=null):Object {var C:Object=cls("morn.core.handlers.Handler");return new C(fn,args);}
  private function openShow():void {var v:Object=openPopup("activity.moonlightbox.view.MoonlightShowView");if(v)v.closeBtn.clickHandler=handler(closePopup);}
  private function openExchange():void {var v:Object=openPopup("activity.moonlightbox.view.MoonlightExchangeView");if(!v)return;v.setData(11021,0,10);v.setLimit(projection.exchange.affordableCount);v.leftBtn.visible=true;v.rightBtn.visible=true;v.pageTxt.editable=true;v.pageTxt.textField.maxChars=2;v.limitTxt.x=112;v.limitTxt.width=280;v.closeBtn.clickHandler=handler(closePopup);}
  private function exchangeCount(value:String,max:int):int {var n:Number=Number(value);return /^[1-9][0-9]?$/.test(value)&&integer(n,1,max)?int(n):0;}
  private function refreshExchange(view:Object,value:Number):void {
   if(view!==popup||!projection)return;var max:int=projection.exchange.affordableCount,count:int=Math.max(1,Math.min(Math.max(1,max),isFinite(value)?Math.floor(value):1));
   view._max=max;view.pageTxt.text=String(count);view._totle=count*10;view.needTxt.text=(count*10)+"碎片";view.limitTxt.text="每次最多10包，当前可兑"+max+"包";
   view.leftBtn.disabled=count<=1;view.rightBtn.disabled=count>=max;view.okBtn.disabled=max===0;
  }
  private function draw(index:int):void {if(!projection||pending||animating||index<0||index>2)return;var option:Object=projection.drawChoices[index];if(!option.canDraw){say("积分不足、临时包已满或今日开盒已达上限。");return;}confirm("开启"+option.count+"盒，消耗"+option.cost+"活动积分；奖品先存临时包。",{type:"draw",count:option.count,choice:projection.bagToken});}
  private function useBag(view:Object,type:int):void {
   if(pending||animating||view!==bag)return;var items:Array=[],total:int=0;for each(var row:Object in projection.bag){var state:Object=view.selectDic[row.templateId];if(state&&state.isSelect){var count:Number=Number(state.count);if(!integer(count,1,row.itemCount))throw new Error("选中数量无效。");items.push({index:row.index,count:count});total+=count;}}
   if(items.length===0){say("请勾选材料与数量。");return;}if(type===2&&!projection.canRecycle){say("当前积分不能回收，未提交请求。");return;}confirm(type===1?"将选中的"+total+"单位材料寄入邮箱，剩余数量保留。":"回收选中的"+total+"单位材料，获得"+(total*2)+"活动积分。",{type:type===1?"take":"recycle",choice:projection.bagToken,items:items});
  }
  private function showDrawResult(view:Object):void {
   if(!main||view!==main.drawView||!wantedOpen||!animating)return;var rewards:Array=settledRewards;settledRewards=null;animating=false;var C:Object=cls("activity.moonlightbox.view.MoonlightRewardsShowView");closePopup();popup=new C();place(popup);popup.setRewards(rewards);popup.okBtn.clickHandler=handler(closePopup);lock();report();
  }
  private function startMovie(view:Object,event:Object):void {
   if(!main||view!==main.drawView||!wantedOpen||!animating)return;var data:Object=event.data;view._drawRewards=data.rewards;
   if(view.skipBtn.selected){showDrawResult(view);return;}view.creatMovie(int(data.type));view._movie.addEventListener("standBComplate",view.__standBComplate);view._movie.gotoAndPlay("open");
  }
  private function endMovie(view:Object,event:Object):void {
   if(!main||view!==main.drawView||!wantedOpen||!animating||event.currentTarget!==view._movie)return;role();view._movie.removeEventListener("standBComplate",view.__standBComplate);view._movie.gotoAndStop("standA");showDrawResult(view);
  }
  private function bind(owner:Object,target:Object,type:String,fn:Function):void {if(!bindings[owner])bindings[owner]=[];target.addEventListener(type,fn);bindings[owner].push([target,type,fn]);}
  private function unbind(owner:Object):void {var rows:Array=bindings[owner] as Array;if(rows)for each(var r:Array in rows)r[0].removeEventListener(r[1],r[2]);delete bindings[owner];}
  private function stopBubble(e:Event):void {e.stopPropagation();}
  private function onKey(e:KeyboardEvent):void {if(e.keyCode===27)closeNative();e.stopPropagation();}
  private function tick(e:Event):void {try{role();}catch(error:Error){fail(error.message);}}
  public function closeNative():Object {
   wantedOpen=false;animating=false;settledRewards=null;var failed:String="";
   try{clearConfirm();closeBag();closePopup();if(main){var view:Object=main;main=null;if(view.drawView._movie)view.drawView._movie.stop();if(view.drawView._autoShowTimer)view.drawView._autoShowTimer.stop();view.dispose();}}catch(error:Error){failed=error.message;}
   if(sceneRoot){sceneRoot.removeEventListener(Event.ENTER_FRAME,tick);sceneRoot.removeEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.removeEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.removeEventListener(MouseEvent.MOUSE_DOWN,stopBubble);if(sceneRoot.parent)sceneRoot.parent.removeChild(sceneRoot);sceneRoot=null;}notice=null;if(failed){phase="failed";message="原宝盒关闭未完成："+failed;}report();return statusNative();
  }
  public function abortNative(reason:String):void {closeNative();fail(reason);}
  private function fail(reason:String):void {if(phase==="failed")return;phase="failed";message=reason;closeNative();report();}
  private function say(value:String):void {message=value;lock();report();}
  private function report():void {try{ExternalInterface.call("workshopMoonlightReport",statusNative());}catch(error:Error){}}
  public function statusNative():Object {return {phase:phase,characterId:expectedId,generation:generation,sequence:sequence,revision:lastRevision,open:sceneRoot!==null,pending:pending,requestId:pendingId,animating:animating,message:message,experimental:true};}
  public static function get Instance():WorkshopNativeMoonlightBootstrap {if(!active)throw new Error("原宝盒未初始化。");return active;}
  public static function get instance():WorkshopNativeMoonlightBootstrap {return Instance;}
  public function get moonlightDrawCountConfig():Array {return [1,3,5];}
  public function get moonlightCountRewards():Array {return ["10,11019,2","20,11019,4","30,11019,6"];}
  // dateFormat6 is absent in the legacy host; preserve the actual original formatting call with a local formatter.
  public static function dateFormat6(value:Date):String {var month:int=value.month+1,day:int=value.date;return value.fullYear+"-"+(month<10?"0":"")+month+"-"+(day<10?"0":"")+day;}
  public static function GetTranslation(key:String,...args):String {
   if(key==="tank.moonlightTreasure.txt1")return "开启"+args[0]+"盒";if(key==="ddt.condiscount.view.time")return "本地常驻活动";if(key==="tank.moonlightTreasure.txt4")return "碎片";if(key==="ddt.vip.PrivilegeViewItem.Times")return "进度";
   return active?String(active.cls("ddt.manager.LanguageMgr").GetTranslation.apply(null,[key].concat(args))):key;
  }
  public static function dispatch(owner:String,name:String,o:Object,args:Array):* {if(!active)throw new Error("原宝盒桥未初始化。");return active.handle(owner,name,o,args);}
  private function handle(owner:String,name:String,o:Object,args:Array):* {
   if(owner==="activity/moonLightTeasure/MoonLightTreasureManager"){
    if(name==="show"||name==="showFrame"){openNative();return;}if(name==="addEvent"||name==="removeEvent")return;if(name==="checkOpen")return phase==="ready";throw new Error("原服socket／付款／排行通道已关闭："+name);
   }
   if(owner==="activity/moonlightbox/MoonlightTreasureMain"){
    if(name==="__closeHandler"){closeNative();return;}if(name==="__showHelp"){openHelp();return;}if(name==="__helpDispose"){closePopup();return;}
    if(name==="updateTab"){o.drawView.visible=true;if(o.viewTab.selectedIndex!==0){var tab:int=o.viewTab.selectedIndex;o.viewTab.selectedIndex=0;if(tab===1)openExchange();else say("原全服排行尚未移植。");}return;}
   }
   if(owner==="activity/moonlightbox/view/MoonlightTreasureDraw"){
    if(name==="__drawClick"){draw(int(args[0]));return;}if(name==="__addKeyHandler"){openHelp();return;}if(name==="__showBagHandler"){openBag();return;}if(name==="__showAllRewards"){openShow();return;}if(name==="showDrawResult"){showDrawResult(o);return;}if(name==="__drawHandler"){startMovie(o,args[0]);return;}if(name==="__standBComplate"){endMovie(o,args[0]);return;}
   }
   if(owner==="activity/moonlightbox/view/MoonlightBagView"){if(name==="__useBagHandler"){useBag(o,int(args[0]));return;}throw new Error("原服临时包网络确认已关闭。");}
   if(owner==="activity/moonlightbox/view/MoonlightRewardItem"&&name==="__getReward"){var tier:int=int(o._type)/10;if(tier>=1&&tier<=3&&projection.progress[tier-1].canClaim)confirm("领取本地"+(tier*10)+"进度奖励：强化石1级×"+(tier*2)+"，寄入邮箱。",{type:"progress",tier:tier,choice:projection.bagToken});return;}
   if(owner==="activity/moonlightbox/view/MoonlightExchangeView"){
    if(o!==popup||!projection)return;if(name==="setLimit"||name==="refreshNumText"){refreshExchange(o,Number(o.pageTxt.text));return;}
    if(pending||animating||confirmation)return;
    if(name==="__okHandler"){var count:int=exchangeCount(String(o.pageTxt.text),projection.exchange.affordableCount);if(count>0)confirm("消耗"+(count*10)+"本地碎片，兑换"+count+"包强化石2级（共"+(count*2)+"个）寄入邮箱。",{type:"exchange",count:count,choice:projection.bagToken});else say("请选择可兑换数量；每包需要10本地碎片，每次最多10包。");return;}
    if(name==="__inputChange"){refreshExchange(o,Number(o.pageTxt.text));return;}
    if(name==="__leftHandler"||name==="__rightHandler"){refreshExchange(o,Number(o.pageTxt.text)+(name==="__leftHandler"?-1:1));return;}
   }
   throw new Error("未实现的原宝盒适配："+owner+"."+name);
  }
 }
}
