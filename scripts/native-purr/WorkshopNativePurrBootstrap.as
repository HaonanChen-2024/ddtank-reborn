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
 import flash.text.TextFieldType;
 import flash.text.TextFormat;
 import flash.geom.Rectangle;
 import flash.utils.ByteArray;
 import flash.utils.Dictionary;
 /** The original two-wheel completion owns animation; the page owns HTTP and UUIDs. */
 public final class WorkshopNativePurrBootstrap extends Sprite {
  private static var active:WorkshopNativePurrBootstrap;
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
  private var windowRoot:Sprite;
  private var main:Object;
  private var popup:Object;
  private var confirmation:Object;
  private var notice:TextField;
  private var wheelText:TextField;
  private var exchangeCells:Array=[];
  private var choiceCells:Array=[];
  private var loaders:Array=[];
  private var bindings:Dictionary=new Dictionary(true);
  private var viewOwners:Dictionary=new Dictionary(true);
  private var message:String="尚未读取本地啵咕转盘。";
  public function WorkshopNativePurrBootstrap(){super();}
  private function cls(name:String):Object {if(!domain.hasDefinition(name))throw new Error("缺少原类："+name);return domain.getDefinition(name);}
  private function manager():Object{return cls("activity.purrturntable.PurrTurntableManager").ins;}
  private function model():Object{return manager().model;}
  private function role():void {
   var c:LoaderContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(!c||(hostContext&&c!==hostContext)||!c.applicationDomain.hasDefinition("WorkshopNativePurrBootstrap")||c.applicationDomain.getDefinition("WorkshopNativePurrBootstrap")!==WorkshopNativePurrBootstrap)throw new Error("转盘共享加载域已改变。");
   if(hostContext)for each(var n:String in ["App","Config","morn.core.components.View"])if(!c.applicationDomain.hasDefinition(n)||c.applicationDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享组件身份已改变。");
   if(cls("ddt.manager.StateManager").currentStateType!=="main"||int(cls("ddt.manager.PlayerManager").Instance.Self.ID)!==expectedId)throw new Error("请返回原角色的大厅。");
  }
  public function startNative(options:Object):void {
   if(active||phase!=="new")throw new Error("啵咕转盘不能重复初始化。");
   if(!options||int(options.expectedUserId)<=0||!options.generation||!options.baseUrl||options.sharedOwnerReady!==true)throw new Error("缺少真实角色、代次或共享 owner。");
   expectedId=int(options.expectedUserId);generation=String(options.generation);base=String(options.baseUrl);if(base.charAt(base.length-1)!=="/")throw new Error("资源路径缺少斜线。");
   role();hostContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(options.sharedContext!==hostContext||!(options.sharedDomain is ApplicationDomain))throw new Error("共享上下文不一致。");domain=hostContext.applicationDomain;
   for each(var n:String in ["App","Config","morn.core.components.View"])if(!options.sharedDomain.hasDefinition(n)||options.sharedDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享类不一致。");
   if(!ExternalInterface.available)throw new Error("当前页面没有本地转盘桥接。");active=this;phase="loading";
   ExternalInterface.addCallback("workshopPurrAcceptSnapshot",acceptSnapshot);ExternalInterface.addCallback("workshopPurrRejectRequest",rejectRequest);
   ExternalInterface.addCallback("workshopPurrOpenNative",openNative);ExternalInterface.addCallback("workshopPurrCloseNative",closeNative);ExternalInterface.addCallback("workshopPurrStatusNative",statusNative);
   loadSwf("purr-original-library.swf",function():void{loadSwf("purrturntable_v3_6_1_u1.swf",loadLayouts);});
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
   loader.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("原转盘布局读取失败。");});loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("原转盘布局访问失败。");});
   loader.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();var b:ByteArray=loader.data as ByteArray;b.uncompress();b.position=0;var layouts:Object=b.readObject();if(b.bytesAvailable)throw new Error("原布局含多余字节。");
    for each(var key:String in ["PurrExchangeView.xml","PurrGoodsShowView.xml","PurrHelp.xml","PurrturntableMainView.xml","PurrZhuanpanView.xml","item/PurrChooseGoodsView.xml","item/PurrGoodsItem.xml","item/PurrGoodsShowItem.xml"]){if(!(layouts[key] is XML))throw new Error("缺少原布局："+key);var xml:XML=layouts[key];
     for each(var node:XML in xml.descendants()){var kind:String=String(node.name()),field:String=String(node.attribute("var"));if(["Label","LabelEx","TextInput"].indexOf(kind)>=0)node.@font="Microsoft YaHei";if(kind==="Button"||kind==="TabButtonEx")node.@labelFont="Microsoft YaHei";
      if(key==="PurrZhuanpanView.xml"){if(field==="startbtn"||field==="protectAdd"){node.@labelMargin="0,0,0,0";node.@labelSize=16;node.@label=field==="startbtn"?"20积分":"保护20积分";}if(field==="freeAdd")node.@label="普通10积分";if(["starfreeL","starfree","freeaddicon"].indexOf(field)>=0)node.@visible=false;if(String(node.@name)==="Star6")node.@index=0;}
      if(key==="PurrturntableMainView.xml"){if(field==="PurrMoneytTxt"||field==="ChipCountText")node.@text="0";if(field==="activetime")node.@text="本地常驻 · 活动积分 · 普通材料";if(field==="Rankbtn"){node.@disabled=true;node.@label="排行待移植";}if(field==="Shopbtn")node.@label="碎片兑换";if(field==="addPurrmonetBtn")node.@visible=false;}
     }
     // The old help bitmap embeds unknown prices and payment rules. Keep its original frame and close control.
     if(key==="PurrHelp.xml")delete xml.FrameClip;
     cls("morn.core.components.View").uiMap[key]=xml;
    }
    cls("App").stage=cls("com.pickgliss.toplevel.StageReferance").stage;cls("App").asset.setDomain(domain);phase="ready";message="原双轮窗口已准备；打开只读取，不扣积分。";report();
   }catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+"purrturntable_v3_6_1_u1.ui"));
  }
  public function openNative():Object {role();if(phase!=="ready")return statusNative();if(pending&&pendingAction===null){wantedOpen=true;return statusNative();}if(pending||animating){say("已有操作或动画尚未完成。");return statusNative();}if(main)return statusNative();wantedOpen=true;read();return statusNative();}
  private function read():void {role();pending=true;pendingId="";pendingAction=null;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopPurrRead",expectedId,generation,sequence);if(!r||r.accepted!==true){pending=false;throw new Error("页面未接受转盘读取。");}}catch(error:Error){say(error.message);}}
  private function request(action:Object):void {role();if(pending||animating||!projection||!wantedOpen)return;if(cls("ddt.manager.PlayerManager").Instance.Self.bagLocked){say("请先解除背包锁定。");return;}
   pending=true;pendingId="";pendingAction=action;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopPurrRequest",expectedId,generation,sequence,action);if(!r||r.accepted!==true||!r.requestId){pending=false;pendingAction=null;throw new Error("页面未接受操作，未提交扣分请求。");}pendingId=String(r.requestId);}catch(error:Error){say(error.message);}report();
  }
  private function integer(v:*,lo:int,hi:int):Boolean{return typeof v==="number"&&isFinite(v)&&v===Math.floor(v)&&v>=lo&&v<=hi;}
  private function validPending(p:Object,level:int,id:int):Boolean {return Boolean(p&&p.chipAmount===20*Math.max(1,level)&&(level>1?p.item&&p.item.templateId===id&&p.item.itemCount===level:p.item===null));}
  private function validate(p:Object):void {
   if(!p||p.version!==1||p.kind!=="wheel-native"||typeof p.started!=="boolean"||typeof p.day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(p.day)||typeof p.roundToken!=="string"||!/^\d{4}-\d{2}-\d{2}:[A-Za-z0-9_-]{43}$/.test(p.roundToken)||p.roundToken.indexOf(p.day+":")!==0)throw new Error("无效的转盘投影或完整令牌。");
   if(!integer(p.round,0,1000000000)||!integer(p.spinCount,0,1000000000)||!integer(p.level,0,7)||!integer(p.category,0,5)||!integer(p.score,0,2147483647)||!integer(p.fragments,0,1000000000)||["idle","active","failed","settled"].indexOf(p.phase)<0||p.startCost!==20||p.normalCost!==10||p.protectCost!==20||p.maxLevel!==7)throw new Error("本地转盘计数或费用无效。");
   for each(var n:String in ["canStart","canContinue","canProtect","canTakeChip","canTakeItem"])if(typeof p[n]!=="boolean")throw new Error("转盘动作门槛无效。");
   var ids:Array=[11019,11001,11021,11002];if(!(p.categories is Array)||p.categories.length!==5||!(p.exchange is Array)||p.exchange.length!==4||!p.localRules||p.localRules.version!==1||typeof p.localRules.description!=="string")throw new Error("转盘材料或规则无效。");
   for(var i:int=0;i<5;i++){var c:Object=p.categories[i];if(!c||c.sourceOriginalIndex!==i+1||typeof c.name!=="string"||!(c.templateIds is Array)||c.templateIds.join(",")!==(i<4?String(ids[i]):ids.join(",")))throw new Error("原五类材料映射无效。");}
   for(i=0;i<4;i++){c=p.exchange[i];if(!c||c.index!==i||c.templateId!==ids[i]||c.chipCost!==20||c.itemCount!==1||c.maxCount!==10||c.affordableCount!==Math.min(10,Math.floor(p.fragments/20))||c.canExchange!==(p.fragments>=20))throw new Error("本地碎片配方无效。");}
   if(p.phase==="idle"){if(p.category!==0||p.level!==0||p.pending!==null||p.roundMaterial!==null)throw new Error("空闲转盘数据无效。");}
   else {if(!p.roundMaterial||ids.indexOf(p.roundMaterial.templateId)<0||typeof p.roundMaterial.name!=="string"||p.category<1||(p.category<5&&p.roundMaterial.templateId!==ids[p.category-1]))throw new Error("本轮固定材料无效。");
    if(p.phase==="settled"){if(p.pending!==null)throw new Error("已结算轮次仍有权益。");}else if(!validPending(p.pending,p.level,p.roundMaterial.templateId))throw new Error("本轮二选一权益无效。");if(p.phase==="active"&&p.level<1)throw new Error("有效轮次级数无效。");if(p.phase==="failed"&&p.level>5)throw new Error("普通失败级数无效。");
   }
  }
  public function acceptSnapshot(envelope:Object):Object {try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}return statusNative();}
  private function applySnapshot(envelope:Object):Object {
   if(phase==="failed")throw new Error("原转盘已失败，拒绝迟到响应。");role();if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");var value:Object=envelope.snapshot;
   if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("动作 UUID 不符。");validate(value.nativeWheel);
   var action:Object=pendingAction,fresh:Boolean=Boolean(action&&!value.replayed&&value.nativeWheelAction&&value.nativeWheelAction.requestId===pendingId),effect:Object=null,p:Object=value.nativeWheel;
   if(fresh){var effects:Array=value.nativeWheelAction.effects as Array;if(!effects||effects.length!==1)throw new Error("动作缺少唯一确认效果。");effect=effects[0];var type:String=["start","continue","protect"].indexOf(action.type)>=0?"rotated":action.type==="take-chip"?"chip-taken":action.type==="take-item"?"item-taken":"exchanged";if(effect.type!==type)throw new Error("转盘效果类型不符。");
    if(type==="rotated"){if(effect.action!==action.type||effect.round!==p.round||effect.spinCount!==p.spinCount||effect.toLevel!==p.level||effect.category!==p.category||effect.templateId!==p.roundMaterial.templateId||effect.phase!==p.phase||effect.cost!==(action.type==="start"?20:action.type==="continue"?10:20)||effect.score!==p.score||typeof effect.success!=="boolean"||typeof effect.protectedFailure!=="boolean"||!integer(effect.fromLevel,0,7)||!validPending(effect.pending,p.level,p.roundMaterial.templateId))throw new Error("双轮确认落点不符。");}
    else if(type==="chip-taken"){if(effect.round!==p.round||!integer(effect.chipAmount,20,140)||effect.chipAmount!==20*Math.max(p.level,1)||effect.fragments!==p.fragments||p.phase!=="settled"||p.pending!==null)throw new Error("碎片结算效果不符。");}
    else if(type==="item-taken"){if(effect.round!==p.round||effect.templateId!==p.roundMaterial.templateId||effect.itemCount!==p.level||p.level<=1||p.phase!=="settled"||p.pending!==null)throw new Error("实物邮件效果不符。");}
    else if(effect.index!==action.index||effect.count!==action.count||effect.chipsSpent!==20*action.count||effect.fragments!==p.fragments||effect.templateId!==p.exchange[action.index].templateId||effect.itemCount!==action.count)throw new Error("碎片兑换效果不符。");
   }
   projection=p;lastRevision=value.revision;pending=false;pendingId="";pendingAction=null;if(!main&&!action&&wantedOpen)constructWindow();
   message=value.message?String(value.message):"已同步本地转盘。";if(main&&wantedOpen&&fresh&&effect.type==="rotated")startRotation();else if(main)renderStatic();lock();report();return statusNative();
  }
  public function rejectRequest(envelope:Object):Object {role();if(phase==="failed"||!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)return statusNative();if(pendingAction&&String(envelope.requestId)!==pendingId)return statusNative();if(envelope.definitive===true){pending=false;pendingAction=null;pendingId="";if(main)renderStatic();}say(String(envelope.message||"请求结果未知，请从页面重试原请求。"));return statusNative();}
  private function syncModel():void {var m:Object=model();manager()._state=1;m.purrmoneyCountInt=projection.score;m.chipCountInt=projection.fragments;m.Params5Str="20积分";m.startDateStr="本地常驻";m.endDateStr="活动积分";m.showDateStr="普通材料";m.isdrawBool=false;m.playinfoTypeInt=projection.category;m.playinfoLevelInt=projection.level;m.romandTypeInt=projection.category;m.romandLevelInt=projection.level;m.playinfoSubscriptInt=1;m.playinfoFreeCoinInt=0;
   if(!m.showTempDic){var C:Object=cls("road7th.data.DictionaryData");m.showTempDic=new C();m.playinfoClaimedDic=new C();m.DataTypeArr=[1,2,3,4,5];for(var category:int=1;category<=5;category++){var rows:Array=[];for(var level:int=2;level<=7;level++)for each(var id:int in projection.categories[category-1].templateIds){C=cls("activity.purrturntable.PurrTurntableShowTemp");var row:Object=new C();row.ID=category*100000+level*10000+id;row.Type=category;row.Level=level;row.ItemID=id;row.Count=level;row.IsBind=true;row.ValidDay=0;rows.push(row);}m.showTempDic.add(String(category),rows);}}
  }
  private function constructWindow():void {role();syncModel();sceneRoot=new Sprite();var stage:Object=cls("com.pickgliss.toplevel.StageReferance").stage;sceneRoot.graphics.beginFill(0x000000,0.65);sceneRoot.graphics.drawRect(0,0,stage.stageWidth,stage.stageHeight);sceneRoot.graphics.endFill();windowRoot=new Sprite();sceneRoot.addChild(windowRoot);var C:Object=cls("activity.purrturntable.view.PurrturntableMainView");main=new C();windowRoot.addChild(main as DisplayObject);notice=text(58,58,835,60,"",0xffedbb);windowRoot.addChild(notice);wheelText=text(0,314,340,40,"",0xffffff);main._turntableView.addChild(wheelText);stage.addChild(sceneRoot);sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);renderStatic();fitWindow();lock();}
  private function fitWindow():void {if(!windowRoot)return;var stage:Object=cls("com.pickgliss.toplevel.StageReferance").stage,r:Rectangle=windowRoot.getBounds(windowRoot);var s:Number=Math.min(1,(stage.stageWidth-20)/r.width,(stage.stageHeight-20)/r.height);windowRoot.scaleX=windowRoot.scaleY=s;windowRoot.x=(stage.stageWidth-r.width*s)/2-r.x*s;windowRoot.y=(stage.stageHeight-r.height*s)/2-r.y*s;}
  private function initMain(o:Object):void {var C:Object=cls("activity.purrturntable.view.PurrZhuanpanView");o._turntableView=new C();o.ViewBox.addChild(o._turntableView as DisplayObject);C=cls("activity.purrturntable.view.PurrExchangeView");o._shopView=new C();o._shopView.x=70;o._shopView.y=-54;o.ViewBox.addChild(o._shopView as DisplayObject);o._shopView.visible=false;o._rankView=null;
   o.closeBtn.clickHandler=handler(closeNative);o.helpBtn.clickHandler=handler(openHelp);o.Turntablebtn.clickHandler=handler(function():void{selectTab(o,0);});o.Shopbtn.clickHandler=handler(function():void{selectTab(o,1);});o.Rankbtn.disabled=true;o.Rankbtn.toolTip="原排行与排行奖励待移植";o.addPurrmonetBtn.visible=false;o.addChipbtn.visible=false;o.activetime.visible=true;o.activetime.text="本地常驻 · 活动积分 · 普通材料";o.initEvent();selectTab(o,0);
  }
  private function selectTab(o:Object,index:int):void {if(pending||animating||confirmation||popup)return;if(index===2){say("原排行榜待移植。");return;}o._turntableView.visible=index===0;o._shopView.visible=index===1;o.Tableft.visible=index===0;o.Tabmid.visible=index===1;o.Tabright.visible=false;o.ViewShow.index=index;o.activetime.text="本地常驻 · 活动积分 · 普通材料";}
  private function renderStatic():void {if(!main)return;syncModel();main.PurrMoneytTxt.text=String(projection.score);main.ChipCountText.text=String(projection.fragments);renderWheel(main._turntableView);main._shopView.listExchange.array=projection.exchange;lock();}
  private function renderWheel(o:Object):void {if(!projection)return;o.startbtn.label="20积分";o.freeAdd.label="普通10积分";o.protectAdd.label="保护20积分";o.starfree.visible=false;o.starfreeL.visible=false;o.freeaddicon.visible=false;o.startbox.visible=projection.canStart||projection.phase==="idle"||projection.phase==="settled";o.freebox.visible=projection.phase==="active"&&projection.level<7;o.protectbox.visible=o.freebox.visible;o.ShowReward.visible=projection.pending!==null;o.RewardShow.visible=false;o.showType.visible=false;
   if(!animating){o.LevelTurnTable.rotation=projection.level===0?0:o.LevelAngleArr[projection.level-1];o.TypeTurnTable.rotation=projection.category===0?0:o.TypeAngleArr[projection.category-1];}
   for(var i:int=1;i<=7;i++)o.StarBox.getChildByName("Star"+i).index=i<=projection.level?1:0;if(wheelText)wheelText.text="本轮："+(projection.roundMaterial?projection.roundMaterial.name:"尚未开局")+" · "+projection.level+"级"+(projection.category===5?"（随机类开局固定材料）":"")+(projection.phase==="failed"?" · 普通追加失败":"");lock();
  }
  private function startRotation():void {if(!main||!wantedOpen)return;var view:Object=main._turntableView;syncModel();animating=true;renderWheel(view);lock();if(!view.isPlayBool){animating=false;renderStatic();report();return;}
   view.RotateTurntable1();view.LevelTurnTable.removeEventListener(Event.ENTER_FRAME,view.RotationLevel);bind(view,view.LevelTurnTable,Event.ENTER_FRAME,function(e:Event):void{if(!main||main._turntableView!==view||!wantedOpen||!animating){unbind(view);return;}view.RotationLevel(e);if(!view.isAnimPlay){unbind(view);animating=false;renderStatic();report();}else lock();});
  }
  private function spin(type:String):void {if(!main||pending||animating||confirmation||popup)return;var allowed:Boolean=type==="start"?projection.canStart:type==="continue"?projection.canContinue:projection.canProtect;if(!allowed){say("积分、级数或本轮状态不满足该操作。");return;}var cost:int=type==="start"?20:type==="continue"?10:20;confirm("本地"+(type==="start"?"开局":type==="continue"?"普通追加":"保护追加")+"消耗"+cost+"活动积分。追加成功率60%；普通失败降1–2级并停止，保护失败保留级数。",{type:type,choice:projection.roundToken});}
  private function initExchange(o:Object):void {viewOwners[o]=true;o.listExchange.renderHandler=handler(function(cell:Object,index:int):void{if(!viewOwners[o]||!wantedOpen||!projection||phase==="failed")return;if(index<projection.exchange.length){cell.visible=true;cell.info=projection.exchange[index];}else cell.visible=false;});o.listExchange.array=projection.exchange;}
  private function initGoods(o:Object):void {var C:Object=cls("bagAndInfo.cell.BagCell");o._cell=new C(0);o._cell.y=2;o._cell.setBgVisible(false);o._cell.setContentSize(70,70);o.cellBox.addChild(o._cell as DisplayObject);o.buyBtn.clickHandler=handler(function():void{exchange(o);});exchangeCells.push(o);}
  private function renderGoods(o:Object,p:Object=null):void {if(p)o._info=p;if(!o._info)return;p=o._info;o._cell.info=fillByID(p.templateId);o._cell.setCount(1);o.nickNameTxt.text=o._cell.info.Name;o.countTxt.text="20";o.limitTxt.text="可兑"+p.affordableCount+"份";o.limitTxt.visible=true;o.buyBtn.disabled=pending||animating||confirmation!==null||popup!==null||!p.canExchange;}
  private function exchange(o:Object):void {if(!main||pending||animating||confirmation||popup||!o._info)return;var p:Object=projection.exchange[o._info.index];if(!p.canExchange){say("本地碎片不足20。");return;}confirm("20本地碎片兑换1份"+fillByID(p.templateId).Name+"。请输入1–"+p.affordableCount+"份；永久绑定材料发往邮件。",{type:"exchange",index:p.index,choice:projection.roundToken},p.affordableCount);}
  private function openChoices():void {if(!main||pending||animating||confirmation||popup||!projection.pending)return;var C:Object=cls("activity.purrturntable.view.item.PurrChooseGoodsView");popup=new C();placePopup(popup);lock();}
  private function initChoices(o:Object):void {viewOwners[o]=true;o.getBtn.clickHandler=handler(function():void{takeSelected(o);});o.closeBtn.clickHandler=handler(closePopup);o.rewardlist.renderHandler=handler(function(cell:Object,index:int):void{renderChoice(o,cell,index);});o.rewardlist.selectHandler=handler(function(index:*):void{});var rows:Array=[{type:"take-chip",count:projection.pending.chipAmount}];if(projection.pending.item)rows.push({type:"take-item",templateId:projection.pending.item.templateId,count:projection.pending.item.itemCount});else o.rewardlist.x=258;o.rewardlist.selectedIndex=-1;o.rewardlist.array=rows;}
  private function renderChoice(o:Object,box:Object,index:int):void {if(!viewOwners[o]||!wantedOpen||phase==="failed")return;box.visible=index<o.rewardlist.array.length;if(!box.visible)return;var data:Object=o.rewardlist.array[index],cellBox:Object=box.getChildByName("cellbox");while(cellBox.numChildren){var previous:Object=cellBox.removeChildAt(0),oldIndex:int=choiceCells.indexOf(previous);if(oldIndex>=0)choiceCells.splice(oldIndex,1);cls("com.pickgliss.utils.ObjectUtils").disposeObject(previous);}if(data.type==="take-chip"){var I:Object=cls("morn.core.components.Image"),icon:Object=new I("asset.purrturntable.icon12");icon.x=25;icon.y=15;cellBox.addChild(icon as DisplayObject);cellBox.addChild(text(-15,54,105,42,"本地碎片×"+data.count,0xffdd85));}else{var C:Object=cls("bagAndInfo.cell.BagCell"),cell:Object=new C(0);cell.setBgVisible(false);cell.setContentSize(70,70);cell.info=fillByID(data.templateId);cell.setCount(data.count);cellBox.addChild(cell as DisplayObject);choiceCells.push(cell);}}
  private function takeSelected(o:Object):void {if(popup!==o||!projection.pending)return;var index:int=int(o.rewardlist.selectedIndex);if(index<0||index>=o.rewardlist.array.length){say("先明确选择碎片或实物；两项只能领取一项。");return;}var data:Object=o.rewardlist.array[index],action:Object={type:data.type,choice:projection.roundToken},detail:String=data.type==="take-chip"?"领取"+data.count+"本地碎片，只记录活动计数，放弃本轮实物。":"领取"+fillByID(data.templateId).Name+"×"+data.count+"至永久绑定邮件，放弃本轮碎片。";closePopup();confirm(detail,action);}
  private function openPreview():void {if(!main||pending||animating||confirmation||popup)return;var C:Object=cls("activity.purrturntable.view.PurrGoodsShowView");popup=new C();var view:Object=popup;viewOwners[view]=true;view.closeBtn.clickHandler=handler(closePopup);view.listshow.renderHandler=handler(function(cell:Object,index:int):void{if(popup!==view||!viewOwners[view]||!wantedOpen||phase==="failed")return;cell.visible=index<view.listshow.array.length;if(cell.visible){var row:Object=view.listshow.array[index];cell.info=row;cell._cell.setCount(row.Count);cell.Claimed.visible=false;}});for(var i:int=0;i<5;i++)view.viewTab.cells[i].label=projection.categories[i].name;view.listshow.array=model().showTempDic[1];placePopup(view);lock();}
  private function openHelp():void {if(!main||pending||animating||confirmation||popup)return;var C:Object=cls("activity.purrturntable.view.PurrHelp");popup=new C();popup.closeBtn.clickHandler=handler(closePopup);popup.addChild(text(65,70,465,410,projection.localRules.description+"\n\n本地开局20积分；普通追加10，保护追加20；最高7级。追加成功率60%。普通失败降1–2级并停止，保护失败留级。\n\n0／1级可选20碎片；2–7级可选20×级数碎片或本轮固定材料×级数，二选一。碎片仅为本地活动计数，20碎片兑换1份普通材料，每次最多10份，实物发邮件。\n\n原五轮扇区映射四普通材料和随机材料，随机类只在开局选一次整轮固定。原装备、充值、排行榜与排行奖励尚未移植。",0xfff1bf));placePopup(popup);lock();}
  private function placePopup(o:Object):void {windowRoot.addChild(o as DisplayObject);var r:Rectangle=o.getBounds(o);o.x=450-r.x-r.width/2;o.y=330-r.y-r.height/2;}
  private function closePopup():void {if(popup){var o:Object=popup;popup=null;delete viewOwners[o];unbind(o);for each(var cell:Object in choiceCells)if(cell){if(cell.parent)cell.parent.removeChild(cell);cell.dispose();}choiceCells=[];o.dispose();}lock();}
  private function confirm(detail:String,action:Object,maxCount:int=0):void {if(!main||pending||animating||confirmation||popup)return;role();var c:Object=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("SimpleAlert"),I:Object=cls("com.pickgliss.ui.vo.AlertInfo");confirmation=c;c.info=new I("本地转盘确认","确认","取消",true,true,detail+"\n不接原币种、点券或付款通道。",false,false,false,true);c.x=295;c.y=200;windowRoot.addChild(c as DisplayObject);var input:TextField=null;
   if(maxCount>0){input=text(45,146,170,25,"1",0xffffff);input.type=TextFieldType.INPUT;input.selectable=true;input.multiline=false;input.wordWrap=false;input.restrict="0-9";input.maxChars=2;input.background=true;input.backgroundColor=0x382d24;input.border=true;input.mouseEnabled=true;c.addChild(input);}
   bind(c,c,"response",function(e:Object):void{var yes:Boolean=e.responseCode===2||e.responseCode===3;if(yes&&maxCount>0){var value:String=input.text;if(!/^[1-9][0-9]?$/.test(value)||int(value)>maxCount){say("数量必须为1–"+maxCount+"，尚未提交。");return;}action.count=int(value);}clearConfirm();if(yes)request(action);else lock();});lock();
  }
  private function clearConfirm():void {if(confirmation){var c:Object=confirmation;confirmation=null;unbind(c);c.dispose();}}
  private function handler(fn:Function,args:Array=null):Object {var C:Object=cls("morn.core.handlers.Handler");return new C(fn,args);}
  private function text(x:Number,y:Number,w:Number,h:Number,label:String,color:uint):TextField {var t:TextField=new TextField();t.defaultTextFormat=new TextFormat("Microsoft YaHei",12,color);t.x=x;t.y=y;t.width=w;t.height=h;t.text=label;t.multiline=true;t.wordWrap=true;t.selectable=false;t.mouseEnabled=false;return t;}
  private function lock():void {if(notice&&projection)notice.text=message+"\n本地开局20／普通追加10／保护追加20积分；追加60%；0–7级。碎片或实物二选一，20碎片兑1份材料。原充值／排行待移植。";
   if(main){var busy:Boolean=pending||animating||confirmation!==null||popup!==null,view:Object=main._turntableView;view.startbtn.disabled=busy||!projection.canStart;view.freeAdd.disabled=busy||!projection.canContinue;view.protectAdd.disabled=busy||!projection.canProtect;view.ShowReward.disabled=busy||!projection.pending;view.ShowAllGoods.disabled=busy;view.AnimSwitch.mouseEnabled=view.AnimSwitch.mouseChildren=!busy;main.Turntablebtn.disabled=main.Shopbtn.disabled=busy;main.helpBtn.disabled=busy;for each(var cell:Object in exchangeCells)if(cell&&cell._info)renderGoods(cell);}}
  private function bind(owner:Object,target:Object,type:String,fn:Function):void {if(!bindings[owner])bindings[owner]=[];target.addEventListener(type,fn);bindings[owner].push([target,type,fn]);}
  private function unbind(owner:Object):void {if(!bindings[owner])return;for each(var row:Array in bindings[owner])row[0].removeEventListener(row[1],row[2]);delete bindings[owner];}
  private function stopBubble(e:Event):void{e.stopPropagation();}
  private function onKey(e:KeyboardEvent):void{if(e.keyCode===27){e.stopPropagation();closeNative();}}
  private function tick(e:Event):void{try{role();}catch(error:Error){fail(error.message);}}
  private function stopWheel(view:Object):void {if(!view)return;unbind(view);view.LevelTurnTable.removeEventListener(Event.ENTER_FRAME,view.RotationLevel);view.TypeTurnTable.removeEventListener(Event.ENTER_FRAME,view.RotationLevel);view.animstateL=view.animstateT=0;view.isAnimPlay=false;if(view._movie){view._movie.stop();cls("com.pickgliss.utils.ObjectUtils").disposeObject(view._movie);view._movie=null;}view.removeEvent();}
  private function disposeMain(o:Object):void {o.removeEvent();stopWheel(o._turntableView);if(o._turntableView){o._turntableView.dispose();o._turntableView=null;}if(o._shopView){o._shopView.dispose();o._shopView=null;}o._rankView=null;model().isdrawBool=false;}
  public function closeNative():Object {wantedOpen=false;animating=false;clearConfirm();closePopup();if(main){var o:Object=main;main=null;unbind(o);o.dispose();}exchangeCells=[];if(sceneRoot){sceneRoot.removeEventListener(Event.ENTER_FRAME,tick);sceneRoot.removeEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.removeEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.removeEventListener(MouseEvent.MOUSE_DOWN,stopBubble);if(sceneRoot.parent)sceneRoot.parent.removeChild(sceneRoot);sceneRoot=null;}windowRoot=null;notice=null;wheelText=null;report();return statusNative();}
  public function abortNative(reason:String):void {closeNative();fail(reason);}
  private function fail(reason:String):void {if(phase==="failed")return;phase="failed";message=reason;if(sceneRoot)closeNative();report();}
  private function say(reason:String):void {message=reason;lock();report();}
  private function report():void {if(ExternalInterface.available)try{ExternalInterface.call("workshopPurrReport",statusNative());}catch(error:Error){}}
  public function statusNative():Object {return {phase:phase,characterId:expectedId,generation:generation,sequence:sequence,revision:lastRevision,open:sceneRoot!==null,pending:pending,requestId:pendingId,animating:animating,message:message,experimental:true};}
  public static function fillByID(id:int):Object {var C:Object=active.cls("ddt.data.goods.InventoryItemInfo"),info:Object=new C();info.TemplateID=id;return active.cls("ddt.manager.ItemManager").fill(info);}
  public static function GetTranslation(key:String,...args):String {return active.cls("ddt.manager.LanguageMgr").GetTranslation.apply(null,[key].concat(args));}
  public static function dispatch(owner:String,name:String,o:Object,args:Array):* {if(!active)throw new Error("原转盘桥未初始化。");return active.handle(owner,name,o,args);}
  private function handle(owner:String,name:String,o:Object,args:Array):* {
   if(owner==="activity/purrturntable/PurrTurntableManager"){if(name==="show"||name==="showFrame")return openNative();if(name==="checkOpen")return true;if(name==="State")return 1;if(["addEvent","removeEvent","__onActiveInfo","__playerInfo","__getDrawResult","__rankInfo","loadActivityXmlComplete","loadTypeXmlComplete","loadXmlComplete"].indexOf(name)>=0)return null;}
   if(owner==="activity/purrturntable/view/PurrturntableMainView"){if(name==="initialize"){initMain(o);return null;}if(name==="dispose"){disposeMain(o);return null;}if(name==="__closeHandler"){closeNative();return null;}if(name==="__showHelp"){openHelp();return null;}if(name==="__helpDispose"){closePopup();return null;}if(name==="updateTab"){selectTab(o,int(args[0]));return null;}if(name==="__ShowRankView"||name==="_addPurrHandler"){say("原排行／充值入口待移植。");return null;}}
   if(owner==="activity/purrturntable/view/PurrZhuanpanView"){if(name==="StartRandomBtn"){spin("start");return null;}if(name==="FreeAddBtn"){spin("continue");return null;}if(name==="ProtectAddBtn"){spin("protect");return null;}if(name==="RandomThingBtn"||name==="__ShowReward"){openChoices();return null;}if(name==="OpenGoodsShowView"){openPreview();return null;}if(name==="UpdateView"||name==="updateview"){renderWheel(o);return null;}if(["__onResponse","__onAlertActivate","creatorPurrMoneyTips"].indexOf(name)>=0)return null;}
   if(owner==="activity/purrturntable/view/PurrExchangeView"){if(name==="initialize"){initExchange(o);return null;}if(name==="dispose"){delete viewOwners[o];o.listExchange.renderHandler=null;return null;}if(name==="__onUpdateShop")return null;if(name==="__listHandler"){if(viewOwners[o]&&wantedOpen)args[0].info=projection.exchange[int(args[1])];return null;}}
   if(owner==="activity/purrturntable/view/item/PurrGoodsItem"){if(name==="initialize"){initGoods(o);return null;}if(name==="dispose"){if(o._cell)o._cell.dispose();o._cell=null;o._info=null;return null;}if(name==="info"){renderGoods(o,args[0]);return null;}if(name==="__buyHandler"){exchange(o);return null;}if(["updateShop","Buycomplete","updateLimit"].indexOf(name)>=0){renderGoods(o);return null;}}
   if(owner==="activity/purrturntable/view/item/PurrChooseGoodsView"){if(name==="initialize"){initChoices(o);return null;}if(name==="__rewardlistHandler"){renderChoice(o,args[0],int(args[1]));return null;}if(name==="__clickgetBtn"){takeSelected(o);return null;}if(name==="__closeHandler"){closePopup();return null;}}
   throw new Error("原转盘未启用的网络／付款／排行分支："+owner+"."+name);
  }
 }
}
