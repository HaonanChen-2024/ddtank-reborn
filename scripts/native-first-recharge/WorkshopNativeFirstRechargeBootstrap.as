package {
 import flash.display.Sprite;
 import flash.display.Loader;
 import flash.display.DisplayObject;
 import flash.display.MovieClip;
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
 import flash.geom.Rectangle;
 import flash.utils.ByteArray;
 import flash.utils.Dictionary;
 import flash.utils.clearTimeout;
 /** Original pointer / terminal frames own presentation. HTTP and UUIDs belong to the page. */
 public final class WorkshopNativeFirstRechargeBootstrap extends Sprite {
  private static var active:WorkshopNativeFirstRechargeBootstrap;
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
  private var windowSerial:int=0;
  private var projection:Object;
  private var sceneRoot:Sprite;
  private var windowRoot:Sprite;
  private var main:Object;
  private var buyView:Object;
  private var cardPanel:Sprite;
  private var cardView:Object;
  private var confirmation:Object;
  private var inputMode:String="";
  private var inputCardId:String="";
  private var notice:TextField;
  private var cardButton:Object;
  private var loaders:Array=[];
  private var bindings:Dictionary=new Dictionary(true);
  private var viewOwners:Dictionary=new Dictionary(true);
  private var message:String="尚未读取本地任务礼包。";
  public function WorkshopNativeFirstRechargeBootstrap(){super();}
  private function cls(name:String):Object {if(!domain.hasDefinition(name))throw new Error("缺少原类："+name);return domain.getDefinition(name);}
  private function manager():Object{return cls("firstRecharge.WorkshopFirstRechargeManager").ins;}
  private function role():void {
   var c:LoaderContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(!c||(hostContext&&c!==hostContext)||!c.applicationDomain.hasDefinition("WorkshopNativeFirstRechargeBootstrap")||c.applicationDomain.getDefinition("WorkshopNativeFirstRechargeBootstrap")!==WorkshopNativeFirstRechargeBootstrap)throw new Error("首充任务共享加载域已改变。");
   if(hostContext)for each(var n:String in ["App","Config","morn.core.components.View"])if(!c.applicationDomain.hasDefinition(n)||c.applicationDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享组件身份已改变。");
   if(cls("ddt.manager.StateManager").currentStateType!=="main"||int(cls("ddt.manager.PlayerManager").Instance.Self.ID)!==expectedId)throw new Error("请返回原角色的大厅。");
  }
  public function startNative(options:Object):void {
   if(active||phase!=="new")throw new Error("首充任务窗口不能重复初始化。");
   if(!options||int(options.expectedUserId)<=0||!options.generation||!options.baseUrl||options.sharedOwnerReady!==true)throw new Error("缺少真实角色、代次或共享 owner。");
   expectedId=int(options.expectedUserId);generation=String(options.generation);base=String(options.baseUrl);if(base.charAt(base.length-1)!=="/")throw new Error("资源路径缺少斜线。");
   role();hostContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(options.sharedContext!==hostContext||!(options.sharedDomain is ApplicationDomain))throw new Error("共享上下文不一致。");domain=hostContext.applicationDomain;
   for each(var n:String in ["App","Config","morn.core.components.View"])if(!options.sharedDomain.hasDefinition(n)||options.sharedDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享类不一致。");
   if(!ExternalInterface.available)throw new Error("当前页面没有本地首充任务桥接。");active=this;phase="loading";
   ExternalInterface.addCallback("workshopFirstRechargeAcceptSnapshot",acceptSnapshot);ExternalInterface.addCallback("workshopFirstRechargeRejectRequest",rejectRequest);
   ExternalInterface.addCallback("workshopFirstRechargeOpenNative",openNative);ExternalInterface.addCallback("workshopFirstRechargeCloseNative",closeNative);ExternalInterface.addCallback("workshopFirstRechargeStatusNative",statusNative);
   loadSwf("first-recharge-original-library.swf",function():void{loadSwf("firstrecharge_v3_6_1_u1.swf",loadLayouts);});
  }
  private function loadSwf(file:String,next:Function):void {
   if(phase==="failed")return;role();var loader:Loader=new Loader();loaders.push(loader);
   loader.contentLoaderInfo.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();next();}catch(error:Error){fail(error.message);}});
   loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("资源读取失败："+file);});loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("资源访问失败："+file);});
   loader.contentLoaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,function(e:UncaughtErrorEvent):void{fail(String(e.error));});
   var c:LoaderContext=new LoaderContext(false,domain);c.allowCodeImport=true;loader.load(new URLRequest(base+file),c);
  }
  private function loadLayouts():void {
   var loader:URLLoader=new URLLoader();loaders.push(loader);loader.dataFormat=URLLoaderDataFormat.BINARY;
   loader.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("原首充布局读取失败。");});loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("原首充布局访问失败。");});
   loader.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();var b:ByteArray=loader.data as ByteArray;b.uncompress();b.position=0;var layouts:Object=b.readObject();if(b.bytesAvailable)throw new Error("原布局含多余字节。");
    var aliases:Object={"asset.ui.frame.bg2":"Skin93","asset.ui.btn_close1":"Skin105","asset.ddtstore.ShortcutTextBg":"Skin94","asset.ui.btn_yellow1":"Skin56","asset.ui.scale.bg4":"Skin188","asset.ui.pageNavBtn.pre2":"Skin64","asset.ui.pageNavBtn.next2":"Skin58","asset.uigeneral.awardGained":"Skin153"};
    for each(var key:String in ["FirstRechargeBuy.xml","FirstRechargeMain.xml","FirstRechargeRewardView.xml","FirstRechargeShop.xml","FirstRechargeShopItem.xml","FirstRechargeTypeItem.xml","View/FirstRechargeShowAlert.xml"]){if(!(layouts[key] is XML))throw new Error("缺少原布局："+key);var xml:XML=layouts[key];
     for each(var node:XML in xml.descendants()){var kind:String=String(node.name()),field:String=String(node.attribute("var")),skin:String=String(node.attribute("skin"));if(aliases[skin])node.@skin="workshop.firstrecharge.skin."+aliases[skin];
      if(["Label","LabelEx","TextInput"].indexOf(kind)>=0)node.@font="Microsoft YaHei";if(kind==="Button"||kind==="TabButtonEx")node.@labelFont="Microsoft YaHei";
      if(kind==="LabelEx"||kind==="Label"){var label:String=String(node.@text);if(label==="充值")node.@text="任务";if(label==="点券")node.@text="目标";if(label==="金豆")node.@text="活动积分";if(label==="抢购数量")node.@text="今日剩余";}
      if(key==="FirstRechargeTypeItem.xml"){if(field==="typeClip")node.@visible=false;if(field==="rechargeBtn"){node.@skin="workshop.firstrecharge.skin.Skin56";node.@width=138;node.@height=42;node.@label="任务凭证";node.@labelSize=14;}}
      if(key==="FirstRechargeRewardView.xml"&&(field==="needRechargeTxt"||field==="dexTxt")){node.@text="";node.@width=610;node.@size=12;}
      if(key==="FirstRechargeShop.xml"&&field==="goldMoneyTxt")node.@text="";
      if(key==="FirstRechargeBuy.xml"&&field==="limitTxt")node.@text="";
      if(key==="View/FirstRechargeShowAlert.xml"){if(field==="buyCountInput"){node.@maxChars=64;node.@x=168;node.@y=166;node.@width=270;node.@align="left";}if(kind==="Label"&&String(node.@text)==="请输入激活码")node.@text="";}
     }cls("morn.core.components.View").uiMap[key]=xml;
    }cls("App").stage=cls("com.pickgliss.toplevel.StageReferance").stage;cls("App").asset.setDomain(domain);phase="ready";message="原首充主窗已准备，打开只读取本地任务资格。";report();
   }catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+"firstrecharge_v3_6_1_u1.ui"));
  }
  public function openNative():Object {role();if(phase!=="ready")return statusNative();if(pending&&pendingAction===null){wantedOpen=true;return statusNative();}if(pending){say("已有操作或演出尚未完成。");return statusNative();}if(main)return statusNative();wantedOpen=true;read();return statusNative();}
  private function read():void {role();pending=true;pendingId="";pendingAction=null;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopFirstRechargeRead",expectedId,generation,sequence);if(!r||r.accepted!==true){pending=false;throw new Error("页面未接受读取。");}}catch(error:Error){say(error.message);}}
  private function request(action:Object):void {role();if(pending||!projection||!wantedOpen)return;if(cls("ddt.manager.PlayerManager").Instance.Self.bagLocked){say("请先解除背包锁定。");return;}
   pending=true;pendingId="";pendingAction=action;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopFirstRechargeRequest",expectedId,generation,sequence,action);if(!r||r.accepted!==true||!r.requestId){pending=false;pendingAction=null;throw new Error("页面未接受操作，未提交扣分请求。");}pendingId=String(r.requestId);}catch(error:Error){say(error.message);}report();
  }
  private function integer(v:*,lo:int,hi:int):Boolean{return typeof v==="number"&&isFinite(v)&&v===Math.floor(v)&&v>=lo&&v<=hi;}
  private function validateReward(r:Object):void {if(!r||[11019,11001,11021,11002].indexOf(r.templateId)<0||!integer(r.count,1,10000)||r.validDays!==0||r.bound!==true)throw new Error("本地永久绑定材料预览无效。");}
  private function validate(p:Object):void {
   if(!p||p.version!==1||p.kind!=="first-recharge-native"||p.rulesVersion!==1||p.currency!=="local-task-points"||typeof p.day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(p.day)||typeof p.stateToken!=="string"||!/^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(p.stateToken)||p.stateToken.indexOf(p.day+".")!==0||!integer(p.points,0,2147483647)||!integer(p.taskEarned,0,2147483647))throw new Error("本地首充任务投影或完整令牌无效。");
   if(!(p.tiers is Array)||p.tiers.length!==3||!p.shop||p.shop.availability!=="local-defined"||!(p.shop.rows is Array)||p.shop.rows.length!==4||!p.cards||p.cards.availability!=="local-defined"||p.cards.policyVersion!==1||!(p.cards.definitions is Array)||p.cards.definitions.length!==3||!(p.cards.cards is Array)||p.cards.cards.length>3||!p.capabilities||!p.rules||p.rules.source!=="explicit-local-rules"||!(p.rules.description is Array)||!(p.unavailable is Array))throw new Error("本地三档、商城或卡能力目录无效。");
   var ids:Array=[11019,11001,11021,11002],costs:Array=[15,20,25,30],counts:Array=[3,3,1,1];
   for(var i:int=0;i<3;i++){var t:Object=p.tiers[i];if(!t||t.tier!==i+1||typeof t.title!=="string"||typeof t.reason!=="string"||typeof t.claimed!=="boolean"||typeof t.canClaim!=="boolean"||["locked","ready","reserved","active","claimed","gifted"].indexOf(t.entitlementStatus)<0||!t.qualification||typeof t.qualification.met!=="boolean"||!integer(t.qualification.current,0,2147483647)||!integer(t.qualification.target,1,2147483647)||!(t.rewards is Array)||t.rewards.length!==6)throw new Error("三档任务资格无效。");for each(var reward:Object in t.rewards)if(reward!==null)validateReward(reward);var d:Object=p.cards.definitions[i];if(!d||d.kind!==i+1||d.associatedTier!==i+1||d.validity!=="permanent"||d.unitPoints!==0||d.entitlement!=="canonical-tier-claim")throw new Error("本地永久凭证定义无效。");}
   for(i=0;i<4;i++){var row:Object=p.shop.rows[i];if(!row||row.index!==i||row.kind!=="material"||row.quantityEditable!==false||row.maxPerRequest!==1||row.unitPoints!==costs[i]||row.reward.templateId!==ids[i]||row.reward.count!==counts[i]||row.period!=="utc-day"||row.limit!==10||!integer(row.bought,0,10)||row.remaining!==10-row.bought||!integer(row.canBuy,0,10))throw new Error("本地固定材料包或每日限购无效。");validateReward(row.reward);}
   var seen:Object={};for each(var card:Object in p.cards.cards){if(!card||typeof card.cardId!=="string"||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(card.cardId)||!integer(card.kind,1,3)||card.associatedTier!==card.kind||seen[card.kind]||["owned","active","used","gifted"].indexOf(card.status)<0||card.expiresAt!==null||typeof card.canValidate!=="boolean"||typeof card.canUse!=="boolean"||typeof card.canGift!=="boolean"||typeof card.reason!=="string")throw new Error("本地凭证状态无效。");seen[card.kind]=true;}
   for each(var name:String in ["reward","materialShop","validateCard","useCard","giftCard"])if(typeof p.capabilities[name]!=="boolean")throw new Error("本地能力开关无效。");
  }
  public function acceptSnapshot(envelope:Object):Object {try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}return statusNative();}
  private function applySnapshot(envelope:Object):Object {
   if(phase==="failed")throw new Error("原首充任务窗口已失败，拒绝迟到响应。");role();if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");var value:Object=envelope.snapshot;
   if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("动作 UUID 不符。");validate(value.nativeFirstRecharge);
   var action:Object=pendingAction,p:Object=value.nativeFirstRecharge,fresh:Boolean=Boolean(action&&!value.replayed&&value.nativeFirstRechargeAction&&value.nativeFirstRechargeAction.requestId===pendingId);
   if(fresh){var effects:Array=value.nativeFirstRechargeAction.effects as Array;if(!effects||effects.length!==1)throw new Error("本地首充动作效果必须唯一。");var effect:Object=effects[0],expected:Object={claim:"claimed",buy:"bought","issue-card":"card-issued","validate-card":"card-validated","use-card":"card-used","gift-card":"card-gifted"};if(!effect||effect.type!==expected[action.type])throw new Error("本地动作效果类型不符。");if(action.tier&&effect.tier!==action.tier&&effect.reservedTier!==action.tier)throw new Error("凭证或礼包档位不符。");if(action.cardId&&effect.cardId!==action.cardId)throw new Error("凭证 UUID 不符。");if(action.type==="buy"&&(effect.index!==action.index||effect.count!==1||effect.cost!==p.shop.rows[action.index].unitPoints||effect.points!==p.points))throw new Error("材料包结算不符。");if(effect.rewards)for each(var reward:Object in effect.rewards)validateReward(reward);}
   projection=p;lastRevision=value.revision;pending=false;pendingId="";pendingAction=null;message=value.message?String(value.message):"已同步本地三档任务、商城和凭证。";
   if(!main&&!action&&wantedOpen)constructWindow();if(main){if(action){clearConfirm();closeInput();closeBuy();closeCards();}renderStatic();}lock();report();return statusNative();
  }
  public function rejectRequest(envelope:Object):Object {role();if(phase==="failed"||!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)return statusNative();if(pendingAction&&String(envelope.requestId)!==pendingId)return statusNative();if(envelope.definitive===true){pending=false;pendingAction=null;pendingId="";if(main)renderStatic();}say(String(envelope.message||"请求结果未知，请从页面重试原请求。"));return statusNative();}
  private function syncModel():void {if(!projection)return;var m:Object=manager(),I:Object=cls("firstRecharge.data.FirstRechargeInfo"),S:Object=cls("firstRecharge.data.FirstRechargeShopInfo");m.goldMoney=projection.points;m.rechargeInfoArr=[];m.isUseCard=false;m.cardEndDate=null;m.sendName="";m.shopDic=new Dictionary();m.canBuyDic=new Dictionary();m.shopTempDic=new Dictionary();m.model.Params1Str="1,200,600";m.model.Params2Str="0,0,0";m.model.Params3Str="1,200,600";m.model.Params4Str="";m.model.Params5Str="";m.model.endDateStr="本地任务常驻";
   for each(var tier:Object in projection.tiers){var t:Object=new I();t.rechargeMoney=tier.qualification.current;t.rewardID=0;t.isComplate=tier.canClaim;t.isGetReward=tier.claimed;m.rechargeInfoArr.push(t);}
   for each(var row:Object in projection.shop.rows){var s:Object=new S();s.TemplateId=row.index+1;s.MstType=2;s.SonType=row.index;s.ItemTempId=row.reward.templateId;s.ItemTempCount=row.reward.count;s.RefershRandom=0;s.LimitBuyCount=10;s.NeedGoldBeans=row.unitPoints;s.count=row.remaining;m.shopDic[s.TemplateId]=row.remaining;m.canBuyDic[s.TemplateId]=row.canBuy;m.shopTempDic[s.TemplateId]=s;}
  }
  private function constructWindow():void {role();windowSerial++;syncModel();sceneRoot=new Sprite();var stage:Object=cls("com.pickgliss.toplevel.StageReferance").stage;sceneRoot.graphics.beginFill(0x000000,0.65);sceneRoot.graphics.drawRect(0,0,stage.stageWidth,stage.stageHeight);sceneRoot.graphics.endFill();windowRoot=new Sprite();sceneRoot.addChild(windowRoot);var C:Object=cls("firstRecharge.view.FirstRechargeMain");main=new C();viewOwners[main]=true;windowRoot.addChild(main as DisplayObject);main.closeBtn.clickHandler=handler(closeNative);notice=text(85,57,650,32,"",0xffedbb);windowRoot.addChild(notice);cardButton=button("本地任务凭证",580,590,function():void{openCards();});windowRoot.addChild(cardButton as DisplayObject);stage.addChild(sceneRoot);sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);renderStatic();fitWindow();lock();}
  private function fitWindow():void {if(!windowRoot)return;var stage:Object=cls("com.pickgliss.toplevel.StageReferance").stage,r:Rectangle=windowRoot.getBounds(windowRoot),s:Number=Math.min(1,(stage.stageWidth-20)/r.width,(stage.stageHeight-20)/r.height);windowRoot.scaleX=windowRoot.scaleY=s;windowRoot.x=(stage.stageWidth-r.width*s)/2-r.x*s;windowRoot.y=(stage.stageHeight-r.height*s)/2-r.y*s;}
  private function rewardInfo(r:Object):Object {var C:Object=cls("ddt.data.goods.InventoryItemInfo"),v:Object=new C(),template:Object=cls("ddt.manager.ItemManager").Instance.getTemplateById(r.templateId);if(!template)throw new Error("本地材料模板缺失。");cls("com.pickgliss.utils.ObjectUtils").copyProperties(v,template);v.Count=r.count;v.ValidDate=0;v.IsBinds=true;v.StrengthenLevel=0;return v;}
  private function initReward(o:Object):void {viewOwners[o]=true;o.initCells();o.list.renderHandler=handler(function(cell:Object,index:int):void{if(!viewOwners[o]||!wantedOpen||phase==="failed")return;cell.visible=index<3;if(cell.visible){cell.type=index;renderType(cell);}});o.list.array=[0,1,2];o.list.selectHandler=handler(function(index:int):void{if(!viewOwners[o]||!wantedOpen||index<0||index>2)return;o._listIndex=index;renderReward(o);});o.list.selectedIndex=0;o._listIndex=0;o.getRewardBtn.clickHandler=handler(function():void{claim(o);});renderReward(o);}
  private function renderReward(o:Object):void {if(!projection||!viewOwners[o])return;var index:int=o._listIndex,t:Object=projection.tiers[index];o.rechargeTypeImg.index=index;o.getRewardBtn.visible=!t.claimed;o.getRewardBtn.disabled=pending||confirmation!==null||cardPanel!==null||cardView!==null||buyView!==null||!t.canClaim;o.hasGetImg.visible=t.claimed;o.needRechargeTxt.text=t.title+"："+t.reason;o.dexTxt.text="本地任务礼包，各档永久一次；材料永久绑定，发邮件。";for(var i:int=0;i<6;i++){var r:Object=t.rewards[i],cell:Object=o._cells[i];cell.info=r===null?null:rewardInfo(r);if(r!==null)cell.setCount(r.count);}for each(var c:Object in o.list.cells)if(c)renderType(c);}
  private function renderType(o:Object):void {if(!projection||!integer(o._type,0,2))return;var t:Object=projection.tiers[o._type];o.hasRechargeImg.visible=t.claimed;o.rechargeBtn.visible=!t.claimed;o.rechargeBtn.disabled=pending||confirmation!==null||cardPanel!==null||cardView!==null||buyView!==null;o.rechargeMoney.text=String(t.qualification.target);if(!viewOwners[o]){viewOwners[o]=true;o.addChild(text(45,3,150,24,"任务第"+(o._type+1)+"档",0xffefbe));}}
  private function initShop(o:Object):void {viewOwners[o]=true;o.list.renderHandler=handler(function(cell:Object,index:int):void{if(!viewOwners[o]||!wantedOpen||phase==="failed")return;cell.visible=index<o.list.array.length;if(cell.visible){var s:Object=o.list.array[index];cell.update(s,s.count);cell.buyBtn.label=String(s.NeedGoldBeans);cell.buyBtn.disabled=pending||confirmation!==null||cardPanel!==null||cardView!==null||buyView!==null||projection.shop.rows[s.TemplateId-1].canBuy<1;}});}
  private function renderStatic():void {if(!main)return;syncModel();renderReward(main.rewardView);var E:Object=cls("firstRecharge.event.FirstRechageEvent");main.shopView.__shopInfoChange(new E("firstRechargeShop"));main.shopView.goldMoneyTxt.text=String(projection.points);if(buyView)updateBuy(buyView);lock();}
  private function selectedTier():int {return main?Math.max(1,Math.min(3,int(main.rewardView._listIndex)+1)):1;}
  private function claim(o:Object):void {if(!main||o!==main.rewardView||pending||confirmation||cardPanel||buyView)return;var tier:int=int(o._listIndex)+1,t:Object=projection.tiers[tier-1];if(!t.canClaim){say(t.reason);return;}confirm(t.title+"只可领取一次。普通材料发往永久绑定邮件；第1档与旧首充大礼共用领取记录。",{type:"claim",tier:tier,choice:projection.stateToken});}
  private function openBuy(o:Object):void {if(!main||pending||confirmation||cardPanel||buyView||!main.shopView.contains(o as DisplayObject)||!o._info)return;var index:int=int(o._info.TemplateId)-1,p:Object=projection.shop.rows[index];if(!p||p.canBuy<1){say("活动积分、今日限购或消费次数不足。");return;}var C:Object=cls("firstRecharge.view.FirstRechargeBuy");buyView=new C(manager().shopTempDic[index+1],p.remaining);viewOwners[buyView]=true;buyView.closeBtn.clickHandler=handler(closeBuy);placePopup(buyView);updateBuy(buyView);lock();}
  private function updateBuy(o:Object):void {var index:int=int(o._info.TemplateId)-1,p:Object=projection.shop.rows[index];o.numInput.text="1";o.numInput.mouseEnabled=o.numInput.mouseChildren=false;o.leftBtn.disabled=o.rightBtn.disabled=true;o.needMoneyTxt.text=String(p.unitPoints)+"积分";o.limitTxt.text="今日剩余"+p.remaining+"包；每次固定一包";o.buyBtn.disabled=pending||confirmation!==null||p.canBuy<1;}
  private function buy(o:Object):void {if(buyView!==o||!viewOwners[o]||pending||confirmation)return;var index:int=int(o._info.TemplateId)-1,p:Object=projection.shop.rows[index];if(p.canBuy<1){say("本地积分或今日剩余份数不足。");return;}confirm("购买"+p.name+"一包，消耗"+p.unitPoints+"活动积分。今日剩余"+p.remaining+"包，永久绑定材料已结算后发送邮件。",{type:"buy",index:index,count:1,choice:projection.stateToken});}
  private function closeBuy():void {if(buyView){var o:Object=buyView;buyView=null;delete viewOwners[o];o.numInput.removeEventListener("change",o.__inputChange);o.numInput.changeHandler=null;o.buyBtn.clickHandler=null;o.dispose();if(o.parent)o.parent.removeChild(o);}lock();}
  private function currentCard(tier:int):Object {for each(var c:Object in projection.cards.cards)if(c.associatedTier===tier)return c;return null;}
  private function openCards():void {if(!main||pending||confirmation||buyView||cardPanel||cardView)return;var tier:int=selectedTier(),t:Object=projection.tiers[tier-1],card:Object=currentCard(tier);cardPanel=new Sprite();cardPanel.graphics.beginFill(0x35221c,0.98);cardPanel.graphics.drawRect(0,0,620,420);cardPanel.graphics.endFill();cardPanel.addChild(text(22,18,570,75,"本地任务凭证 · "+t.title+"\n永久有效；保留同一档奖励资格，发行/使用/赠送不产生第二包。",0xffedbb));var status:String=card?"状态："+card.status+"\n凭证 UUID："+card.cardId+"\n发送者："+(card.senderName||"本人任务资格")+"\n"+card.reason:t.reason;var info:TextField=text(22,102,570,160,status,0xffffff);info.selectable=true;info.mouseEnabled=true;cardPanel.addChild(info);var o:Sprite=cardPanel;
   var issue:Object=button("发行凭证",22,280,function():void{closeCards();confirm("零费用保留第"+tier+"档任务奖励权利。发行后须使用凭证再领奖，或赠送一次给本地好友；旧首充入口也不能绕过保留状态。",{type:"issue-card",tier:tier,choice:projection.stateToken});});issue.disabled=card!==null||!t.qualification.met||t.claimed||t.entitlementStatus!=="ready";o.addChild(issue as DisplayObject);
   var check:Object=button("校验凭证",168,280,function():void{openInput("validate-card",card);});check.disabled=!card||!card.canValidate;o.addChild(check as DisplayObject);
   var useButton:Object=button("使用凭证",314,280,function():void{closeCards();confirm("使用永久任务凭证，激活第"+tier+"档资格；材料仍需回奖励页领取一次。",{type:"use-card",cardId:card.cardId,choice:projection.stateToken});});useButton.disabled=!card||!card.canUse;o.addChild(useButton as DisplayObject);
   var gift:Object=button("赠送凭证",460,280,function():void{openInput("gift-card",card);});gift.disabled=!card||!card.canGift;o.addChild(gift as DisplayObject);o.addChild(text(22,335,570,55,"仅本人发行的未激活凭证可赠送一次；受赠不可再转送。赠送后本人该档不能再领取。原付费卡/vipCoupons窗口尚未复原。",0xffd59b));o.addChild(button("关闭",460,375,closeCards) as DisplayObject);placePopup(o);lock();}
  private function closeCards():void {if(cardPanel){var o:Sprite=cardPanel;cardPanel=null;unbind(o);while(o.numChildren){var child:Object=o.removeChildAt(0);if(child.hasOwnProperty("clickHandler"))child.clickHandler=null;if(child.hasOwnProperty("dispose"))child.dispose();}if(o.parent)o.parent.removeChild(o);}lock();}
  private function openInput(mode:String,card:Object):void {if(!main||pending||confirmation||cardView||!card)return;closeCards();inputMode=mode;inputCardId=card.cardId;var C:Object=cls("firstRecharge.view.FirstRechargeShowAlert");cardView=new C();viewOwners[cardView]=true;cardView.buyCountInput.text=mode==="validate-card"?card.cardId:"";cardView.buyCountInput.maxChars=mode==="validate-card"?36:64;cardView.tipMsgLab.text=mode==="validate-card"?"校验本人的任务凭证 UUID":"赠给本地角色：输入准确昵称";cardView.tipMsgLab.font="Microsoft YaHei";cardView.tipMsgLab.size=12;cardView.tipMsgLab.width=285;placePopup(cardView);lock();}
  private function sendInput(o:Object):void {if(cardView!==o||!viewOwners[o]||pending||confirmation)return;var value:String=String(o.buyCountInput.text).replace(/^\s+|\s+$/g,"");if(inputMode==="validate-card"){if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)){say("请输入已有本地任务凭证 UUID。");return;}request({type:"validate-card",cardId:value,choice:projection.stateToken});}else{if(value.length<1||value.length>64||/[\x00-\x1f\x7f]/.test(value)){say("请输入1–64字符的本地角色昵称。");return;}var id:String=inputCardId;closeInput();confirm("将未激活的任务凭证赠给本地角色「"+value+"」。此权利只转移一次，本人该档将不能领奖；不会改变双方累计任务积分。",{type:"gift-card",cardId:id,recipientName:value,choice:projection.stateToken});}}
  private function closeInput():void {if(cardView){var o:Object=cardView;cardView=null;delete viewOwners[o];o.confirmBtn.clickHandler=o.cancelBtn.clickHandler=o.closeBtn.clickHandler=null;o.dispose();if(o.parent)o.parent.removeChild(o);}inputMode="";inputCardId="";lock();}
  private function confirm(detail:String,action:Object):void {if(!main||pending||confirmation||cardPanel||cardView)return;role();var c:Object=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("SimpleAlert"),I:Object=cls("com.pickgliss.ui.vo.AlertInfo");confirmation=c;c.info=new I("本地任务确认","确认","取消",true,true,detail,false,false,false,true);placePopup(c);bind(c,c,"response",function(e:Object):void{if(confirmation!==c||!wantedOpen||phase==="failed")return;var yes:Boolean=e.responseCode===2||e.responseCode===3;clearConfirm();if(yes)request(action);else lock();});lock();}
  private function clearConfirm():void {if(confirmation){var o:Object=confirmation;confirmation=null;unbind(o);o.dispose();if(o.parent)o.parent.removeChild(o);}}
  private function placePopup(o:Object):void {windowRoot.addChild(o as DisplayObject);var r:Rectangle=o.getBounds(o);o.x=410-r.x-r.width/2;o.y=310-r.y-r.height/2;fitWindow();}
  private function handler(fn:Function,args:Array=null):Object {var C:Object=cls("morn.core.handlers.Handler");return new C(fn,args);}
  private function button(label:String,x:int,y:int,fn:Function):Object {var C:Object=cls("morn.core.components.Button"),b:Object=new C();b.skin="workshop.firstrecharge.skin.Skin56";b.stateNum=1;b.width=130;b.height=34;b.x=x;b.y=y;b.label=label;b.labelFont="Microsoft YaHei";b.labelSize=12;b.labelColors="0xffefbf";var serial:int=windowSerial;b.clickHandler=handler(function():void{if(serial!==windowSerial||!wantedOpen||!b.parent||phase!=="ready")return;fn();});return b;}
  private function text(x:Number,y:Number,w:Number,h:Number,label:String,color:uint):TextField {var t:TextField=new TextField();t.defaultTextFormat=new TextFormat("Microsoft YaHei",12,color);t.x=x;t.y=y;t.width=w;t.height=h;t.text=label;t.multiline=true;t.wordWrap=true;t.selectable=false;t.mouseEnabled=false;return t;}
  private function lock():void {if(notice)notice.text=message;if(!main||!projection)return;var busy:Boolean=pending||confirmation!==null||cardPanel!==null||cardView!==null||buyView!==null;main.tab.mouseEnabled=main.tab.mouseChildren=!busy;if(cardButton)cardButton.disabled=busy;renderReward(main.rewardView);for each(var c:Object in main.shopView.list.cells)if(c&&c._info)c.buyBtn.disabled=busy||projection.shop.rows[int(c._info.TemplateId)-1].canBuy<1;if(buyView)updateBuy(buyView);if(cardView)cardView.confirmBtn.disabled=pending;}
  private function bind(owner:Object,target:Object,type:String,fn:Function):void {if(!bindings[owner])bindings[owner]=[];target.addEventListener(type,fn);bindings[owner].push([target,type,fn]);}
  private function unbind(owner:Object):void {if(!bindings[owner])return;for each(var row:Array in bindings[owner])row[0].removeEventListener(row[1],row[2]);delete bindings[owner];}
  private function stopBubble(e:Event):void{e.stopPropagation();}
  private function onKey(e:KeyboardEvent):void{if(e.keyCode===27){e.stopPropagation();closeNative();}}
  private function tick(e:Event):void{try{role();}catch(error:Error){fail(error.message);}}
  public function closeNative():Object {wantedOpen=false;windowSerial++;try{clearConfirm();closeInput();closeBuy();closeCards();if(main){var o:Object=main;main=null;delete viewOwners[o];delete viewOwners[o.rewardView];delete viewOwners[o.shopView];o.tab.removeEventListener("change",o.__tabChange);o.rewardView.list.renderHandler=o.rewardView.list.selectHandler=null;o.shopView.list.renderHandler=null;o.dispose();}}finally{if(sceneRoot){sceneRoot.removeEventListener(Event.ENTER_FRAME,tick);sceneRoot.removeEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.removeEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.removeEventListener(MouseEvent.MOUSE_DOWN,stopBubble);if(sceneRoot.parent)sceneRoot.parent.removeChild(sceneRoot);sceneRoot=null;}windowRoot=null;notice=null;cardButton=null;report();}return statusNative();}
  public function abortNative(reason:String):void {closeNative();fail(reason);}
  private function fail(reason:String):void {if(phase==="failed")return;phase="failed";message=reason;if(sceneRoot)closeNative();report();}
  private function say(reason:String):void {message=reason;lock();report();}
  private function report():void {if(ExternalInterface.available)try{ExternalInterface.call("workshopFirstRechargeReport",statusNative());}catch(error:Error){}}
  public function statusNative():Object {return {phase:phase,characterId:expectedId,generation:generation,sequence:sequence,revision:lastRevision,open:sceneRoot!==null,pending:pending,requestId:pendingId,animating:false,message:message,experimental:true};}
  public static function GetTranslation(key:String,...args):String {if(key==="tank.firstrecharge.txt3")return "今日剩余"+args[0]+"包；每次固定一包";return active.cls("ddt.manager.LanguageMgr").GetTranslation.apply(null,[key].concat(args));}
  public static function dispatch(owner:String,name:String,o:Object,args:Array):* {if(!active)throw new Error("原首充任务桥未初始化。");return active.handle(owner,name,o,args);}
  private function handle(owner:String,name:String,o:Object,args:Array):* {
   if(owner==="firstRecharge/FirstRechargeManager"){if(name==="setup"){syncModel();return null;}if(name==="loadRes"||name==="showFrame")return openNative();if(name==="isHasRecharge")return projection?projection.tiers[0].canClaim:false;if(name==="openSendView"||name==="showSendFrame"||name==="useCard"){openCards();return null;}throw new Error("原首充 Socket、参考配置或付款卡通道已停止："+name);}
   if(owner==="firstRecharge/view/FirstRechargeMain"&&name==="__close"){closeNative();return null;}
   if(owner==="firstRecharge/view/FirstRechargeRewardView"){if(name==="initialize"){initReward(o);return null;}if(name==="update"||name==="__infoChange"){renderReward(o);return null;}if(name==="__getReward"){claim(o);return null;}}
   if(owner==="firstRecharge/view/FirstRechargeShop"&&name==="initialize"){initShop(o);return null;}
   if(owner==="firstRecharge/view/FirstRechargeShopItem"&&name==="__buyClick"){openBuy(o);return null;}
   if(owner==="firstRecharge/view/FirstRechargeBuy"){if(name==="__buyClick"){buy(o);return null;}if(name==="__closeClick"){if(buyView===o)closeBuy();return null;}if(name==="__inputChange"){if(buyView===o)updateBuy(o);return null;}throw new Error("旧全局付款确认已关闭。");}
   if(owner==="firstRecharge/view/FirstRechargeTypeItem"){if(name==="updateState"){renderType(o);return null;}if(name==="__recharge"){if(main&&!pending){main.rewardView.list.selectedIndex=o._type;main.rewardView._listIndex=o._type;openCards();}return null;}}
   if(owner==="firstRecharge/view/FirstRechargeShowAlert"){if(name==="initialize"){o.buyCountInput.text="";o.tipMsgLab.text="本地任务凭证";o.confirmBtn.clickHandler=handler(function():void{sendInput(o);});o.closeBtn.clickHandler=o.cancelBtn.clickHandler=handler(function():void{if(cardView===o)closeInput();});return null;}if(name==="__onConfirmBtn"){sendInput(o);return null;}if(name==="__onClickCancleOrCloseBtn"){if(cardView===o)closeInput();return null;}if(name==="show"){if(cardView!==o)throw new Error("非owned凭证窗口不能进入全局层。");return null;}}
   throw new Error("未实现的原首充适配："+owner+"."+name);
  }
 }
}