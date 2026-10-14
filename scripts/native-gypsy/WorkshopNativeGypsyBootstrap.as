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
 /** Original eight-cell shop; the page owns authentication, HTTP and UUIDs. */
 public final class WorkshopNativeGypsyBootstrap extends Sprite {
  private static var active:WorkshopNativeGypsyBootstrap;
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
  private var help:Object;
  private var confirmation:Object;
  private var notice:TextField;
  private var refreshLabel:TextField;
  private var message:String="尚未读取本地吉普赛商人。";
  private var loaders:Array=[];
  private var bindings:Dictionary=new Dictionary(true);
  public function WorkshopNativeGypsyBootstrap(){super();}
  private function cls(name:String):Object {if(!domain.hasDefinition(name))throw new Error("缺少原类："+name);return domain.getDefinition(name);}
  private function model():Object{return cls("gypsyShop.model.GypsyShopModel").getInstance();}
  private function role():void {
   var c:LoaderContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(!c||(hostContext&&c!==hostContext)||!c.applicationDomain.hasDefinition("WorkshopNativeGypsyBootstrap")||c.applicationDomain.getDefinition("WorkshopNativeGypsyBootstrap")!==WorkshopNativeGypsyBootstrap)throw new Error("原商人共享加载域已改变。");
   if(hostContext)for each(var n:String in ["App","Config","morn.core.components.View"])if(!c.applicationDomain.hasDefinition(n)||c.applicationDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享组件身份已改变。");
   if(cls("ddt.manager.StateManager").currentStateType!=="main"||int(cls("ddt.manager.PlayerManager").Instance.Self.ID)!==expectedId)throw new Error("请返回原角色的大厅。");
  }
  public function startNative(options:Object):void {
   if(active||phase!=="new")throw new Error("原商人不能重复初始化。");
   if(!options||int(options.expectedUserId)<=0||!options.generation||!options.baseUrl||options.sharedOwnerReady!==true)throw new Error("缺少真实角色、代次或唯一共享 owner。");
   expectedId=int(options.expectedUserId);generation=String(options.generation);base=String(options.baseUrl);if(base.charAt(base.length-1)!=="/")throw new Error("资源路径缺少结尾斜线。");
   role();hostContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(options.sharedContext!==hostContext||!(options.sharedDomain is ApplicationDomain))throw new Error("共享 owner 上下文不一致。");domain=hostContext.applicationDomain;
   for each(var n:String in ["App","Config","morn.core.components.View"])if(!options.sharedDomain.hasDefinition(n)||options.sharedDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享类不一致。");
   if(!ExternalInterface.available)throw new Error("当前页面没有本地商人桥接。");active=this;phase="loading";
   ExternalInterface.addCallback("workshopGypsyAcceptSnapshot",acceptSnapshot);ExternalInterface.addCallback("workshopGypsyRejectRequest",rejectRequest);
   ExternalInterface.addCallback("workshopGypsyOpenNative",openNative);ExternalInterface.addCallback("workshopGypsyCloseNative",closeNative);ExternalInterface.addCallback("workshopGypsyStatusNative",statusNative);
   loadSwf("gypsy-original-library.swf",function():void{loadSwf("gypsyshop_v3_6_1_u1.swf",loadStyles);});
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
   loader.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("原商人样式读取失败。");});loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("原商人样式访问失败。");});
   loader.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();var b:ByteArray=loader.data as ByteArray;cls("com.pickgliss.ui.ComponentFactory").Instance.setup(new XML(b.readUTFBytes(b.length)));phase="ready";message="原商人窗口已准备；打开只读取，不刷新或购买。";report();}catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+"gypsy-styles.xml"));
  }
  public function openNative():Object {role();if(phase!=="ready")return statusNative();if(pending&&pendingAction===null){wantedOpen=true;return statusNative();}if(pending){say("已有操作尚未确认，请处理原请求。");return statusNative();}if(sceneRoot)return statusNative();wantedOpen=true;read();return statusNative();}
  private function read():void {role();pending=true;pendingId="";pendingAction=null;sequence++;lock();try{var result:Object=ExternalInterface.call("workshopGypsyRead",expectedId,generation,sequence);if(!result||result.accepted!==true){pending=false;throw new Error("页面未接受商人读取。");}}catch(error:Error){say(error.message);}}
  private function request(action:Object):void {
   role();if(pending||!projection)return;if(cls("ddt.manager.PlayerManager").Instance.Self.bagLocked){say("请先解除背包锁定。");return;}
   pending=true;pendingId="";pendingAction=action;sequence++;lock();try{var result:Object=ExternalInterface.call("workshopGypsyRequest",expectedId,generation,sequence,action);if(!result||result.accepted!==true||!result.requestId){pending=false;pendingAction=null;throw new Error("页面未接受操作；未提交积分请求。");}pendingId=String(result.requestId);}catch(error:Error){say(error.message);}report();
  }
  private function integer(v:*,lo:int,hi:int):Boolean{return typeof v==="number"&&isFinite(v)&&v===Math.floor(v)&&v>=lo&&v<=hi;}
  private function validate(p:Object):void {
   if(!p||p.version!==1||p.kind!=="gypsy-native"||typeof p.started!=="boolean"||!integer(p.score,0,2147483647)||!integer(p.refreshes,0,1000000000)||p.slots!==8||typeof p.freeRefresh!=="boolean"||typeof p.canRefresh!=="boolean"||p.refreshCost!==(p.freeRefresh?0:5))throw new Error("无效的商人公开投影。");
   if(typeof p.day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(p.day)||!p.localRules||p.localRules.version!==1||typeof p.localRules.description!=="string")throw new Error("本地商人日期或规则缺失。");
   if(!(p.offers is Array)||[0,3,8].indexOf(p.offers.length)<0||!(p.previewTemplateIds is Array)||p.previewTemplateIds.join(",")!=="11019,11001,11021,11002")throw new Error("商人货架或普通材料预览无效。");
   if(p.started){if(typeof p.shelfDay!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(p.shelfDay)||p.shelfKey!==p.shelfDay+":"+p.refreshes||p.offers.length===0)throw new Error("货架版本无效。");}else if(p.shelfKey!==null||p.shelfDay!==null||p.offers.length!==0)throw new Error("未开始货架包含商品。");
   for(var i:int=0;i<p.offers.length;i++){var o:Object=p.offers[i];if(!o||o.index!==i||[11019,11001,11021,11002].indexOf(o.templateId)<0||!integer(o.itemCount,1,999)||!integer(o.price,1,2147483647)||typeof o.sold!=="boolean"||typeof o.canBuy!=="boolean"||(o.sold&&o.canBuy))throw new Error("商品报价无效。");}
  }
  public function acceptSnapshot(envelope:Object):Object {try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}return statusNative();}
  private function applySnapshot(envelope:Object):Object {
   if(phase==="failed")throw new Error("原商人已失败，拒绝迟到响应。");role();if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");
   var value:Object=envelope.snapshot;if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("动作 UUID 不符。");validate(value.nativeGypsy);
   var action:Object=pendingAction,fresh:Boolean=Boolean(action&&!value.replayed&&value.nativeGypsyAction&&value.nativeGypsyAction.requestId===pendingId);
   if(fresh){var effects:Array=value.nativeGypsyAction.effects as Array,result:Object=null;if(!effects)throw new Error("动作缺少确认效果。");for each(var e:Object in effects)if(e.type===(action.type==="refresh"?"refreshed":"bought"))result=e;
    if(!result||result.score!==value.nativeGypsy.score||result.shelfKey!==value.nativeGypsy.shelfKey)throw new Error("商人效果与最终状态不符。");
    if(action.type==="refresh"){if(result.offerCount!==8||result.cost!==(action.choice==="free"?0:5)||result.free!==(action.choice==="free")||value.nativeGypsy.offers.length!==8)throw new Error("刷新确认效果不符。");}
    else{var o:Object=value.nativeGypsy.offers[action.index];if(!o||!o.sold||result.index!==action.index||result.templateId!==o.templateId||result.itemCount!==o.itemCount||result.cost!==o.price||result.shelfKey!==action.choice)throw new Error("购买确认效果不符。");}
   }
   projection=value.nativeGypsy;lastRevision=value.revision;pending=false;pendingId="";pendingAction=null;
   if(!sceneRoot&&!action&&wantedOpen)constructWindow();if(main)renderStatic();message=value.message?String(value.message):"已读取本地商人进度。";lock();report();return statusNative();
  }
  public function rejectRequest(envelope:Object):Object {role();if(phase==="failed"||!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)return statusNative();if(pendingAction&&String(envelope.requestId)!==pendingId)return statusNative();if(envelope.definitive===true){pending=false;pendingAction=null;pendingId="";if(main)renderStatic();}say(String(envelope.message||"请求结果未知，请从页面重试原请求。"));return statusNative();}
  private function vector(name:String):Object {var V:Object=domain.getDefinition("__AS3__.vec::Vector.<"+name.replace(/\.([^.]+)$/,"::$1")+">");return new V();}
  private function renderStatic():void {
   if(!main)return;var m:Object=model(),items:Object=vector("gypsyShop.model.GypsyItemData"),C:Object=cls("gypsyShop.model.GypsyItemData");
   for each(var o:Object in projection.offers){if(!cls("ddt.manager.ItemManager").Instance.getTemplateById(o.templateId))throw new Error("本地物品模板缺失："+o.templateId);items.push(new C(o.index,1,o.price,0,o.templateId,o.itemCount,o.canBuy?1:0,0));}
   m.itemDataList=items;m.itemCount=items.length;m.curRefreshedTimes=projection.refreshes;main.updateNewItemList();
   for(var i:int=0;i<main._itemList.length;i++){var cell:Object=main._itemList[i];cell._priceUnitIcon.visible=false;cell._priceTxt.width=116;cell._priceTxt.text=i<projection.offers.length?projection.offers[i].price+" 积分／包":"";
    if(i<projection.offers.length){o=projection.offers[i];cell._curNameTxt.width=120;cell._curNameTxt.text=String(cell._bagCell.info.Name)+"×"+o.itemCount;cell._buyBtn.enable=o.canBuy&&!pending;cell._buyBtn.visible=true;}else{cell._buyBtn.visible=false;cell._collectText.visible=false;}}
   main._rmbTicketsText.text=String(projection.score);if(refreshLabel)refreshLabel.text=projection.freeRefresh?"免费刷新8件":"5积分刷新8件";
  }
  private function constructWindow():void {
   role();sceneRoot=new Sprite();sceneRoot.graphics.beginFill(0x000000,0.7);sceneRoot.graphics.drawRect(0,0,1000,600);sceneRoot.graphics.endFill();
   main=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("gypsy.mainframe");main.setModel(model());sceneRoot.addChild(main as DisplayObject);main.x=260;main.y=2;main.titleText="吉普赛商人 · 本地活动";
   main._rareTitle.visible=false;main.addChild(text(165,60,154,24,"普通材料预览",0x3b2919));main._rmbTicketsIcon.visible=false;main._ticketsBG.visible=false;main._rmbTicketsText.x=111;main._rmbTicketsText.width=94;main.addChild(text(24,495,83,24,"活动积分",0x31534a));
   refreshLabel=text(158,527,162,24,"",0x6b451d);main.addChild(refreshLabel);
   var ids:Vector.<int>=new Vector.<int>();for each(var id:int in projection.previewTemplateIds){if(!cls("ddt.manager.ItemManager").Instance.getTemplateById(id))throw new Error("预览物品模板缺失："+id);ids.push(id);}model().listRareItemTempleteIDs=ids;main.updateRareItemsList();
   notice=text(16,180,225,250,"",0x2b2119);sceneRoot.addChild(notice);cls("com.pickgliss.toplevel.StageReferance").stage.addChild(sceneRoot);cls("com.pickgliss.toplevel.StageReferance").stage.focus=sceneRoot;
   sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);renderStatic();lock();
  }
  private function text(x:Number,y:Number,w:Number,h:Number,label:String,color:uint):TextField {var t:TextField=new TextField();t.defaultTextFormat=new TextFormat("Microsoft YaHei",12,0xffefbe,false,null,null,null,null,"center");t.x=x;t.y=y;t.width=w;t.height=h;t.text=label;t.background=true;t.backgroundColor=color;t.wordWrap=true;t.selectable=false;t.mouseEnabled=false;return t;}
  private function lock():void {if(notice)notice.text=message+"\n\n本地规则：每天首次刷新免费，之后每次5活动积分。\n每个报价包只能购买一次，材料发往邮件。\n\n"+(!projection.started?"货架尚未刷新；点击刷新按钮生成8个报价。":projection.offers.length===3?"保留旧货架3件；明确刷新后生成8件。":"当前货架8件。")+"\n\n原服稀有掉落和付款数值未导入。";
   if(main){main.mouseEnabled=main.mouseChildren=!pending&&!confirmation&&!help;main._refreshRmbBtn.enable=Boolean(projection.canRefresh&&!pending);for(var i:int=0;i<main._itemList.length;i++)main._itemList[i]._buyBtn.enable=Boolean(i<projection.offers.length&&projection.offers[i].canBuy&&!pending);}}
  private function confirm(action:Object,cost:int,detail:String):void {if(pending||!sceneRoot)return;clearConfirm();confirmation=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("SimpleAlert");var I:Object=cls("com.pickgliss.ui.vo.AlertInfo");confirmation.info=new I("本地活动积分确认","确认","取消",true,true,"确认消耗 "+cost+" 本地活动积分？\n"+detail+"\n原服点券与付款通道已关闭。",false,false,false,true);confirmation.x=295;confirmation.y=170;sceneRoot.addChild(confirmation as DisplayObject);
   var frame:Object=confirmation;bind(frame,frame,"response",function(e:Object):void{var yes:Boolean=e.responseCode===2||e.responseCode===3;clearConfirm();if(yes)request(action);else lock();});lock();}
  private function clearConfirm():void {if(confirmation){var frame:Object=confirmation;confirmation=null;unbind(frame);frame.dispose();}}
  private function offer(index:int):Object {if(!projection||index<0||index>=projection.offers.length)return null;return projection.offers[index];}
  private function buy(index:int):void {if(pending||confirmation||help)return;role();var o:Object=offer(index);if(!o||!o.canBuy){say("商品已售出、积分不足或货架已过期，请重新读取。");return;}confirm({type:"buy",index:index,choice:projection.shelfKey},o.price,"购买模板"+o.templateId+" × "+o.itemCount+" 的整包普通材料，成功后发往邮件。");}
  private function refresh():void {if(pending||confirmation||help)return;role();if(!projection.canRefresh){say("本地积分不足或今日操作已达上限。");return;}confirm({type:"refresh",choice:projection.freeRefresh?"free":"points"},projection.refreshCost,"刷新8个普通材料报价；当前未购买报价将被替换。");}
  private function openHelp():void {if(pending||help||confirmation||!sceneRoot)return;help=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("gypsy.local.helpFrame");help.x=305;help.y=60;sceneRoot.addChild(help as DisplayObject);
   // The original help artwork is retained beneath a module-local rules panel.
   help.addChild(text(22,58,352,324,"吉普赛商人 · 本地玩法\n\n8个商品格，按整包普通材料报价购买；商品数量显示在名称旁。\n\n每日首次刷新免费，后续每次5活动积分。刷新与购买都需确认。\n\n每个报价只能买一次，成功后以绑定永久邮件发放。\n\n顶部仅为普通材料预览，原服稀有装备/概率未知，未冒用。\n\n关闭或重读不会自动刷新、购买或扣分。",0x3b2919));var frame:Object=help;bind(frame,frame,"response",function(e:Object):void{closeHelp();});lock();}
  private function closeHelp():void {if(help){var frame:Object=help;help=null;unbind(frame);frame.dispose();}lock();}
  public function simpleHelpButton(frame:Object,style:String,unused:*,title:String,asset:String,w:int,h:int,flag:Boolean):Object {var b:Object=cls("com.pickgliss.ui.ComponentFactory").Instance.creat(style);frame.addToContent(b);bind(frame,b,MouseEvent.CLICK,function(e:Event):void{openHelp();});return b;}
  private function bind(owner:Object,target:Object,type:String,fn:Function):void {if(!bindings[owner])bindings[owner]=[];target.addEventListener(type,fn);bindings[owner].push([target,type,fn]);}
  private function unbind(owner:Object):void {var rows:Array=bindings[owner] as Array;if(rows)for each(var r:Array in rows)r[0].removeEventListener(r[1],r[2]);delete bindings[owner];}
  private function stopBubble(e:Event):void{e.stopPropagation();}
  private function onKey(e:KeyboardEvent):void {if(e.keyCode===27)closeNative();e.stopPropagation();}
  private function tick(e:Event):void {try{role();}catch(error:Error){fail(error.message);}}
  private function killMain(o:Object):void {unbind(o);for each(var item:Object in o._itemList)item.dispose();for each(var cell:Object in o._rareList)cls("com.pickgliss.utils.ObjectUtils").disposeObject(cell);for each(var glow:Object in o._coolShiningMCList){glow.stop();cls("com.pickgliss.utils.ObjectUtils").disposeObject(glow);}o._itemList.length=0;o._rareList.length=0;o._coolShiningMCList.length=0;for each(var f:String in ["_bg","_rareTitle","_rmbTicketsIcon","_ticketsBG","_rmbTicketsText","_refreshRmbBtn","_helpBtn"])if(o[f]){cls("com.pickgliss.utils.ObjectUtils").disposeObject(o[f]);o[f]=null;}o._model=null;}
  public function closeNative():Object {wantedOpen=false;var failed:String="";try{clearConfirm();closeHelp();if(main){var view:Object=main;main=null;view.dispose();}}catch(error:Error){failed=error.message;}if(sceneRoot){sceneRoot.removeEventListener(Event.ENTER_FRAME,tick);sceneRoot.removeEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.removeEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.removeEventListener(MouseEvent.MOUSE_DOWN,stopBubble);if(sceneRoot.parent)sceneRoot.parent.removeChild(sceneRoot);sceneRoot=null;}notice=null;refreshLabel=null;if(failed){phase="failed";message="原商人关闭未完成："+failed;}report();return statusNative();}
  public function abortNative(reason:String):void {closeNative();fail(reason);}
  private function fail(reason:String):void {if(phase==="failed")return;phase="failed";message=reason;closeNative();report();}
  private function say(value:String):void {message=value;lock();report();}
  private function report():void {try{ExternalInterface.call("workshopGypsyReport",statusNative());}catch(error:Error){}}
  public function statusNative():Object {return{phase:phase,characterId:expectedId,generation:generation,sequence:sequence,revision:lastRevision,open:sceneRoot!==null,pending:pending,requestId:pendingId,animating:false,message:message,experimental:true};}
  public static function get Instance():WorkshopNativeGypsyBootstrap {if(!active)throw new Error("原商人尚未初始化。");return active;}
  public static function get instance():WorkshopNativeGypsyBootstrap{return Instance;}
  public function isCollectionGoodsByTemplateID(id:int):Boolean{return false;}
  public static function GetTranslation(key:String,...args):String {if(key==="tank.game.GameView.gypsyHelpTitle")return "吉普赛商人 · 本地规则";if(key==="ddt.gypsy.collect")return "";return active?String(active.cls("ddt.manager.LanguageMgr").GetTranslation.apply(null,[key].concat(args))):key;}
  public static function dispatch(owner:String,name:String,o:Object,args:Array):* {if(!active)throw new Error("原商人桥未初始化。");return active.handle(owner,name,o,args);}
  private function handle(owner:String,name:String,o:Object,args:Array):* {
   if(owner==="gypsyShop/ctrl/GypsyShopManager"){if(name==="itemBuyBtnClicked"){buy(int(args[0]));return;}if(name==="refreshWithRmbBtnClicked"||name==="refreshBtnClicked"){refresh();return;}if(name==="start"||name==="showMainFrame"){openNative();return;}if(name==="isAvatarActivated")return false;if(name==="dispose"||name==="setup")return;throw new Error("原商人网络、付款或加载通道已关闭："+name);}
   if(owner==="gypsyShop/model/GypsyShopModel")throw new Error("原商人 sendGypsy 网络通道已关闭："+name);
   if(owner==="gypsyShop/view/GypsyShopMainFrame"){
    if(name==="addEvent")return;
    if(name==="_response"){if(args[0].responseCode===0||args[0].responseCode===1)closeNative();return;}
    if(name==="removeEvent"){unbind(o);return;}if(name==="updateWealth"){o._rmbTicketsText.text=projection?String(projection.score):"0";return;}if(name==="onClick"){refresh();return;}if(name==="dispose"){killMain(o);return;}throw new Error("原商人付款确认/回包已关闭："+name);
   }
   if(owner==="gypsyShop/ui/GypsyItemCell"&&name==="onClick"){buy(o.id);return;}
   throw new Error("未实现的原商人适配："+owner+"."+name);
  }
 }
}
