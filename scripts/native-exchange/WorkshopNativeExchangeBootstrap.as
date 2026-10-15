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
 /** Original ExchangeAct cells/layout; the game alone owns bag counts and atomic consumption. */
 public final class WorkshopNativeExchangeBootstrap extends Sprite {
  private static var active:WorkshopNativeExchangeBootstrap;
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
  private var projection:Object;
  private var sceneRoot:Sprite;
  private var main:Object;
  private var activity:Object;
  private var notice:TextField;
  private var closeButton:Sprite;
  private var loaders:Array=[];
  private var message:String="尚未读取兑换材料。";
  public function WorkshopNativeExchangeBootstrap(){super();}
  private function cls(name:String):Object {if(!domain.hasDefinition(name))throw new Error("缺少原类："+name);return domain.getDefinition(name);}
  private function role():void {
   var c:LoaderContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(!c||(hostContext&&c!==hostContext)||!c.applicationDomain.hasDefinition("WorkshopNativeExchangeBootstrap")||c.applicationDomain.getDefinition("WorkshopNativeExchangeBootstrap")!==WorkshopNativeExchangeBootstrap)throw new Error("兑换共享加载域已改变。");
   if(hostContext)for each(var n:String in ["App","Config","morn.core.components.View"])if(!c.applicationDomain.hasDefinition(n)||c.applicationDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享组件身份已改变。");
   if(cls("ddt.manager.StateManager").currentStateType!=="main"||int(cls("ddt.manager.PlayerManager").Instance.Self.ID)!==expectedId)throw new Error("请返回原角色的大厅。");
  }
  public function startNative(options:Object):void {
   if(active||phase!=="new")throw new Error("兑换窗口不能重复初始化。");
   if(!options||int(options.expectedUserId)<=0||!options.generation||!options.baseUrl||options.sharedOwnerReady!==true)throw new Error("缺少真实角色、代次或共享 owner。");
   expectedId=int(options.expectedUserId);generation=String(options.generation);base=String(options.baseUrl);if(base.charAt(base.length-1)!=="/")throw new Error("资源路径缺少斜线。");
   role();hostContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;if(options.sharedContext!==hostContext||!(options.sharedDomain is ApplicationDomain))throw new Error("共享上下文不一致。");domain=hostContext.applicationDomain;
   for each(var n:String in ["App","Config","morn.core.components.View"])if(!options.sharedDomain.hasDefinition(n)||options.sharedDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享类不一致。");
   if(!ExternalInterface.available)throw new Error("当前页面没有本地兑换桥接。");active=this;phase="loading";
   ExternalInterface.addCallback("workshopExchangeAcceptSnapshot",acceptSnapshot);ExternalInterface.addCallback("workshopExchangeRejectRequest",rejectRequest);ExternalInterface.addCallback("workshopExchangeOpenNative",openNative);ExternalInterface.addCallback("workshopExchangeCloseNative",closeNative);ExternalInterface.addCallback("workshopExchangeStatusNative",statusNative);
   loadSwf("exchange-original-library.swf",function():void{loadSwf("exchange-original-art.swf",loadStyles);});
  }
  private function loadSwf(file:String,next:Function):void {role();var loader:Loader=new Loader();loaders.push(loader);loader.contentLoaderInfo.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();next();}catch(error:Error){fail(error.message);}});loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("资源读取失败："+file);});loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("资源访问失败："+file);});loader.contentLoaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,function(e:UncaughtErrorEvent):void{fail(String(e.error));});var context:LoaderContext=new LoaderContext(false,domain);context.allowCodeImport=true;loader.load(new URLRequest(base+file),context);}
  private function loadStyles():void {var loader:URLLoader=new URLLoader();loaders.push(loader);loader.dataFormat=URLLoaderDataFormat.BINARY;loader.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("原兑换样式读取失败。");});loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("原兑换样式访问失败。");});loader.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();var b:ByteArray=loader.data as ByteArray;cls("com.pickgliss.ui.ComponentFactory").Instance.setup(new XML(b.readUTFBytes(b.length)));phase="ready";message="原兑换窗口已准备，打开只读取材料。";report();}catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+"exchange-styles.xml"));}
  public function openNative():Object {role();if(phase!=="ready")return statusNative();if(pending&&pendingAction===null){wantedOpen=true;return statusNative();}if(pending){say("已有兑换尚未确认，请使用页面原 UUID 重试。");return statusNative();}if(main)return statusNative();wantedOpen=true;read();return statusNative();}
  private function read():void {pending=true;pendingId="";pendingAction=null;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopExchangeRead",expectedId,generation,sequence);if(!r||r.accepted!==true){pending=false;throw new Error("页面未接受读取。");}}catch(error:Error){say(error.message);}}
  private function request(action:Object):void {role();if(pending||!projection||!projection.available||!wantedOpen)return;if(cls("ddt.manager.PlayerManager").Instance.Self.bagLocked){say("请先解除背包锁定。");return;}pending=true;pendingId="";pendingAction=action;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopExchangeRequest",expectedId,generation,sequence,action);if(!r||r.accepted!==true||!r.requestId){pending=false;pendingAction=null;throw new Error("页面未接受兑换，未提交扣料请求。");}pendingId=String(r.requestId);}catch(error:Error){say(error.message);}report();}
  private function integer(v:*,lo:int,hi:int):Boolean{return typeof v==="number"&&isFinite(v)&&v===Math.floor(v)&&v>=lo&&v<=hi;}
  private function validate(p:Object,revision:Number):void {
   if(!p||p.version!==1||p.catalogVersion!=="exchange-native-v1-local-4"||p.revision!==revision||typeof p.day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(p.day)||["online","offline","unavailable"].indexOf(p.authority)<0||typeof p.available!=="boolean"||typeof p.reason!=="string"||p.materialSource!=="prop-bag"||!p.category||p.category.id!=="local-materials"||typeof p.category.title!=="string"||!(p.materials is Array)||!(p.recipes is Array)||!(p.rules is Array)||!(p.unavailable is Array))throw new Error("兑换公开投影无效。");
   if(p.available){if(p.authority!=="online"||typeof p.stateToken!=="string"||!/^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(p.stateToken)||p.stateToken.indexOf(p.day+".")!==0)throw new Error("权威兑换令牌无效。");}else if(p.stateToken!==null)throw new Error("不可用兑换不能持有操作令牌。");
   if(p.authority==="unavailable"){if(p.available||p.materials.length!==0||p.recipes.length!==0)throw new Error("服务不可用时目录必须成对空白。");return;}
   if(p.materials.length!==4||p.recipes.length!==4)throw new Error("本地四材料目录不完整。");var ids:Array=[11019,11001,11021,11002],names:Array=["local-strengthen-up","local-zhuque-up","local-strengthen-down","local-zhuque-down"],inputs:Array=[11019,11001,11021,11002],outputs:Array=[11021,11002,11019,11001],ins:Array=[4,4,2,2],outs:Array=[1,1,3,3];
   for(var i:int=0;i<4;i++){var m:Object=p.materials[i],r:Object=p.recipes[i];if(!m||m.templateId!==ids[i]||typeof m.name!=="string"||(p.authority==="online"?!integer(m.eligibleCount,0,2147483647):m.eligibleCount!==null))throw new Error("可用材料数量必须来自权威道具背包。");if(!r||r.index!==i||r.catalogId!==names[i]||typeof r.title!=="string"||typeof r.reason!=="string"||r.dailyLimit!==10||!integer(r.exchanged,0,10)||r.remaining!==10-r.exchanged||!integer(r.maxCount,0,10)||r.maxCount>r.remaining||typeof r.canExchange!=="boolean"||!(r.inputs is Array)||r.inputs.length!==1||!(r.outputs is Array)||r.outputs.length!==1)throw new Error("兑换配方无效。");var a:Object=r.inputs[0],b:Object=r.outputs[0];if(a.templateId!==inputs[i]||a.count!==ins[i]||b.templateId!==outputs[i]||b.count!==outs[i]||b.bound!==true||b.validDays!==0)throw new Error("本地配方或永久绑定奖励不符。");if(!p.available&&(r.maxCount!==0||r.canExchange))throw new Error("不可用配方不能兑换。");if(r.canExchange&&r.maxCount<1)throw new Error("兑换数量上限无效。");}
  }
  private function sameItems(actual:Array,rows:Array,count:int,reward:Boolean):Boolean {if(!actual||actual.length!==rows.length)return false;for(var i:int=0;i<rows.length;i++)if(!actual[i]||actual[i].templateId!==rows[i].templateId||actual[i].count!==rows[i].count*count||(reward&&(actual[i].bound!==true||actual[i].validDays!==0)))return false;return true;}
  public function acceptSnapshot(envelope:Object):Object {try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}return statusNative();}
  private function applySnapshot(envelope:Object):Object {if(phase==="failed")throw new Error("兑换窗口已失败，拒绝迟到响应。");role();if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");var value:Object=envelope.snapshot;if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("兑换 UUID 不符。");validate(value.nativeExchange,value.revision);var action:Object=pendingAction;
   if(action&&!value.replayed){var a:Object=value.nativeExchangeAction,rows:Array=a?a.effects as Array:null,recipe:Object=projection.recipes[action.index];if(!a||a.requestId!==pendingId||!rows||rows.length!==1)throw new Error("兑换确认效果无效。");var e:Object=rows[0];if(!e||e.type!=="exchanged"||e.index!==action.index||e.count!==action.count||!integer(e.committedRevision,1,value.revision)||!sameItems(e.consumed as Array,recipe.inputs,action.count,false)||!sameItems(e.rewards as Array,recipe.outputs,action.count,true))throw new Error("兑换结算与权威配方不符。");}
   projection=value.nativeExchange;lastRevision=value.revision;pending=false;pendingId="";pendingAction=null;seedActivity();if(!main&&!action&&wantedOpen)constructWindow();if(main)renderStatic();message=value.message?String(value.message):"已读取权威兑换进度。";lock();report();return statusNative();}
  public function rejectRequest(envelope:Object):Object {role();if(phase==="failed"||!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)return statusNative();if(pendingAction&&String(envelope.requestId)!==pendingId)return statusNative();if(envelope.definitive===true){pending=false;pendingAction=null;pendingId="";if(main)renderStatic();}say(String(envelope.message||"请求结果未知，请从页面重试原请求。"));return statusNative();}
  private function vector(name:String):Object {var V:Object=domain.getDefinition("__AS3__.vec::Vector.<"+name.replace(/\.([^.]+)$/, "::$1")+">");return new V();}
  private function seedActivity():void {var G:Object=cls("wonderfulActivity.data.GmActivityInfo"),B:Object=cls("wonderfulActivity.data.GiftBagInfo"),W:Object=cls("wonderfulActivity.data.GiftRewardInfo");activity=new G();activity.activityId="local-materials";activity.activityName=projection.category.title;activity.activityType=2;activity.activityChildType=0;activity.beginTime=projection.day;activity.endTime=projection.day;activity.giftbagArray=[];
   for each(var r:Object in projection.recipes){var bag:Object=new B();bag.activityId=activity.activityId;bag.giftbagId=r.catalogId;bag.giftbagOrder=r.index;bag.giftConditionArr=vector("wonderfulActivity.data.GiftConditionInfo");bag.giftRewardArr=vector("wonderfulActivity.data.GiftRewardInfo");for(var side:int=0;side<2;side++)for each(var item:Object in side===0?r.inputs:r.outputs){var row:Object=new W();row.templateId=item.templateId;row.count=item.count;row.rewardType=side;row.property="0,0,0,0,0";row.isBind=true;row.validDate=0;bag.giftRewardArr.push(row);}activity.giftbagArray.push(bag);}}
  private function constructWindow():void {role();sceneRoot=new Sprite();sceneRoot.graphics.beginFill(0x000000,0.76);sceneRoot.graphics.drawRect(0,0,1000,600);sceneRoot.graphics.endFill();var C:Object=cls("wonderfulActivity.newActivity.ExchangeAct.ExchangeActView");main=new C("local-materials");sceneRoot.addChild(main as DisplayObject);main.x=-184;main.y=8;main.init();main._goodsExchange._haveGoodsExplain.width=80;main._goodsExchange._haveGoodsExplain.text="需消耗材料";main._goodsExchange._exchangGoodsExplain.text="兑换所得";main._goodsExchange._exchangGoodsCountText.text="兑换份数";main._goodsExchange._actTimeText.text="每日限额";main._goodsExchange._actTime.width=270;main._goodsExchange._actTime.text="UTC每日每配方10份";
   closeButton=new Sprite();closeButton.buttonMode=true;closeButton.graphics.beginFill(0x8c351b);closeButton.graphics.drawRoundRect(0,0,66,28,8);closeButton.graphics.endFill();closeButton.addChild(text(0,3,66,24,"关闭",0xffffff));closeButton.x=530;closeButton.y=20;closeButton.addEventListener(MouseEvent.CLICK,onClose);sceneRoot.addChild(closeButton);notice=text(625,55,340,475,"",0xffefbe);notice.wordWrap=true;sceneRoot.addChild(notice);sceneRoot.addChild(text(50,12,440,24,"兑换活动 · 本地材料",0xffefbe));cls("com.pickgliss.toplevel.StageReferance").stage.addChild(sceneRoot);sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);renderStatic();}
  private function renderStatic():void {if(!main)return;var g:Object=main._goodsExchange,index:int=int(g.selectedIndex),count:int=int(g.count);main._activityInfo=activity;main._titleField.text=projection.category.title;g._goodsExchangeDic=new Dictionary();g.setData(activity);g._awardBtnGroup.selectIndex=index;g._count=boundedCount(index,count);g._exchangGoodsCount.text=String(g._count);g.updateGoodsBox(index);g._actTime.text="UTC每日每配方10份";lock();}
  private function boundedCount(index:int,count:int):int {var r:Object=recipeAt(index),max:int=r?int(r.maxCount):0;return Math.max(1,Math.min(count,Math.max(1,max),10));}
  private function recipeAt(index:int):Object {return projection&&index>=0&&index<projection.recipes.length?projection.recipes[index]:null;}
  private function materialCount(template:int):* {for each(var m:Object in projection.materials)if(m.templateId===template)return m.eligibleCount;return null;}
  private function updateGoods(o:Object,index:int):void {o._selectedIndex=index;o._ifNoneGoods=false;o._cellVector=vector("wonderfulActivity.newActivity.ExchangeAct.ExchangeGoodsCell");o._haveGoodsBox.disposeAllChildren();o._exchangGoodsBox.disposeAllChildren();o._count=boundedCount(index,int(o._count));o._exchangGoodsCount.text=String(o._count);var C:Object=cls("wonderfulActivity.newActivity.ExchangeAct.ExchangeGoodsCell"),items:Object=o._goodsExchangeDic[index],left:int=0,right:int=0;
   if(items)for each(var row:Object in items){var cell:Object=new C(row,-1,row.rewardType===0,-1,o._count);if(row.rewardType===0){o._haveGoodsBox.addChild(cell);o._cellVector.push(cell);left++;}else{o._exchangGoodsBox.addChild(cell);right++;}}while(left++<8)o._haveGoodsBox.addChild(new C(null));while(right++<6)o._exchangGoodsBox.addChild(new C(null));var r:Object=recipeAt(index);o._haveGoodsCount=r?r.maxCount:0;updateButton(o);}
  private function updateButton(o:Object):void {var r:Object=recipeAt(int(o.selectedIndex)),yes:Boolean=Boolean(!pending&&projection.available&&r&&r.canExchange&&int(o.count)>=1&&int(o.count)<=r.maxCount),E:Object=cls("wonderfulActivity.newActivity.ExchangeAct.ExchangeGoodsEvent");o.dispatchEvent(new E(E.ExchangeGoodsChange,yes));}
  private function exchangeNow():void {if(pending||!main)return;var g:Object=main._goodsExchange,r:Object=recipeAt(int(g.selectedIndex)),count:int=int(g.count);if(!projection.available||!r||!r.canExchange||count<1||count>r.maxCount){say(r?String(r.reason):String(projection.reason));return;}request({type:"exchange",index:int(r.index),count:count,choice:projection.stateToken});}
  private function lock():void {if(notice){var r:Object=main?recipeAt(int(main._goodsExchange.selectedIndex)):null;notice.text=message+"\n\n"+projection.reason+"\n\n"+(r?r.title+"\n今日已兑换 "+r.exchanged+"／10；可兑换 "+r.maxCount+" 份\n"+r.reason:"当前服务未提供配方，不能兑换。")+"\n\n"+projection.rules.join("\n\n")+"\n\n本地4配方，兑换不消耗积分。\n消耗服务器确认的道具背包材料，所得绑定永久材料发往邮件。\n\n原服14分类及未知装备目录尚未移植。";}if(main){var g:Object=main._goodsExchange;g._exchangGoodsCount.mouseEnabled=!pending;for(var i:int=1;i<=4;i++)g["_awardBtn"+i].enable=Boolean(!pending&&projection.recipes.length===4);updateButton(g);}}
  private function text(x:Number,y:Number,w:Number,h:Number,label:String,color:uint):TextField {var t:TextField=new TextField();t.defaultTextFormat=new TextFormat("Microsoft YaHei",12,color,false,null,null,null,null,"left");t.x=x;t.y=y;t.width=w;t.height=h;t.text=label;t.selectable=false;t.mouseEnabled=false;return t;}
  public static function cellBackground():Object{return active.cls("com.pickgliss.ui.ComponentFactory").Instance.creatBitmap("workshop.exchange.skin.Skin47");}
  public static function cellInfo(row:Object,input:Boolean):Object {if(!row)return null;var T:Object=active.cls("ddt.manager.ItemManager").Instance.getTemplateById(row.templateId);if(!T)throw new Error("本地材料模板缺失："+row.templateId);var C:Object=active.cls("ddt.data.goods.InventoryItemInfo"),info:Object=new C();info.TemplateID=row.templateId;active.cls("ddt.manager.ItemManager").fill(info);info.StrengthenLevel=0;info.AttackCompose=0;info.DefendCompose=0;info.AgilityCompose=0;info.LuckCompose=0;info.IsBinds=true;info.ValidDate=0;info.isShowBind=!input;return info;}
  private function initializeCell(o:Object,args:Array):void {o._gooodsExchangeInfo=args[0];o._type=Boolean(args[2]);o._id=int(args[3]);o._num=int(args[4]);o._countText=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("workshop.exchange.style.S16");o.addChild(o._countText);refreshCell(o);}
  private function refreshCell(o:Object):void {var r:Object=o._gooodsExchangeInfo;if(!r){o._countText.text="";return;}var n:*=materialCount(r.templateId);o._haveCount=n===null?0:int(n);o._haveCountTemp=o._haveCount;o._countText.text=o._type?(n===null?"?":String(n))+"/"+String(r.count*o._num):String(r.count*o._num);}
  public static function dispatch(owner:String,name:String,o:Object,args:Array):* {if(!active)throw new Error("原兑换桥尚未初始化。");return active.handle(owner,name,o,args);}
  private function handle(owner:String,name:String,o:Object,args:Array):* {var short:String=owner.split("/").pop();if(short==="ExchangeActView"){if(name==="$constructor"){o._actId=String(args[0]);return;}if(name==="initData"){o._activityInfo=activity;return;}if(name==="__exchange"){if(o===main)exchangeNow();return;}if(name==="dispose"){o.removeEvent();if(o._goodsExchange){o._goodsExchange.dispose();cls("com.pickgliss.utils.ObjectUtils").disposeObject(o._goodsExchange._exchangGoodsCount);o._goodsExchange=null;}for each(var key:String in ["_back","_titleField","_buttonBack","_exchangeButton","_container"])if(o[key]){cls("com.pickgliss.utils.ObjectUtils").disposeObject(o[key]);o[key]=null;}return;}}
   if(short==="ExchangeGoodsView"){if(name==="updateGoodsBox"){updateGoods(o,int(args[0]));return;}if(name==="checkBtn"){updateButton(o);return;}if(name==="__countChangeHandler"){if(pending||!main||o!==main._goodsExchange)return;o._count=boundedCount(int(o.selectedIndex),int(o._exchangGoodsCount.text));o._exchangGoodsCount.text=String(o._count);o.updateGoodsBox(int(o.selectedIndex));lock();return;}}
   if(short==="ExchangeGoodsCell"){if(name==="$constructor"){initializeCell(o,args);return;}if(name==="intEvent")return;/* Explicit projection-only count updates: no old Bag/PropBag listeners. */if(name==="__updateCount"){refreshCell(o);return;}if(name==="itemInfo")return o.info;}
   throw new Error("未实现的原兑换适配："+owner+"."+name);}
  private function stopBubble(e:Event):void{e.stopPropagation();}
  private function onKey(e:KeyboardEvent):void{if(e.keyCode===27)closeNative();e.stopPropagation();}
  private function onClose(e:MouseEvent):void{closeNative();e.stopPropagation();}
  private function tick(e:Event):void{try{role();}catch(error:Error){fail(error.message);}}
  public function closeNative():Object {wantedOpen=false;var errorText:String="";try{if(main){var old:Object=main;main=null;old.dispose();}}catch(error:Error){errorText=error.message;}finally{if(closeButton)closeButton.removeEventListener(MouseEvent.CLICK,onClose);closeButton=null;if(sceneRoot){sceneRoot.removeEventListener(Event.ENTER_FRAME,tick);sceneRoot.removeEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.removeEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.removeEventListener(MouseEvent.MOUSE_DOWN,stopBubble);if(sceneRoot.parent)sceneRoot.parent.removeChild(sceneRoot);sceneRoot=null;}notice=null;}if(errorText){phase="failed";message="原兑换窗口关闭未完成："+errorText;}report();return statusNative();}
  public function abortNative(reason:String):void{closeNative();fail(reason);}
  private function fail(reason:String):void{if(phase==="failed")return;phase="failed";message=reason;closeNative();report();}
  private function say(value:String):void{message=value;lock();report();}
  private function report():void{try{ExternalInterface.call("workshopExchangeReport",statusNative());}catch(error:Error){}}
  public function statusNative():Object{return{phase:phase,characterId:expectedId,generation:generation,sequence:sequence,revision:lastRevision,open:sceneRoot!==null,pending:pending,requestId:pendingId,animating:false,message:message,experimental:true};}
 }
}
