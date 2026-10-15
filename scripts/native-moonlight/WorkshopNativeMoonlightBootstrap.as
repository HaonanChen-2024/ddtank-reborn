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
  private var rankView:Object;
  private var shopView:Object;
  private var shopRows:Array=[];
  private var shopPageNumber:int=1;
  private var shopRefreshQueued:Boolean=false;
  private var shopPurchaseIndex:int=-1;
  private var rankingRefreshQueued:Boolean=false;
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
    var required:Array=["MoonlightTreasureMain.xml","MoonlightTreasureDraw.xml","MoonlightBag.xml","item/MoonlightBagItem.xml","MoonlightHelp.xml","MoonlightRewardItem.xml","MoonlightRewardsShow.xml","MoonlightShow.xml","item/MoonlightShowItem.xml","MoonlightExchange.xml","MoonlightRank.xml","MoonlightShop.xml","item/MoonlightShopItem.xml"];
    for each(var key:String in required){if(!(layouts[key] is XML))throw new Error("缺少原布局："+key);var xml:XML=layouts[key];
     for each(var node:XML in xml.descendants()){
      var kind:String=String(node.name());if(["Label","LabelEx","TextInput"].indexOf(kind)>=0)node.@font="Microsoft YaHei";if(kind==="Button"||kind==="TabButtonEx")node.@labelFont="Microsoft YaHei";
      if(String(node.@stroke)==="0x1es3a8")node.@stroke="0x153b9b,1,4,4,30";
      if(key==="MoonlightShop.xml"&&String(node.@stroke)==="0x333eab,30")node.@stroke="0x333eab,1,4,4,30";
      if(key==="MoonlightShop.xml"&&String(node.@stroke)==="0x151b69,30")node.@stroke="0x151b69,1,4,4,30";
     }
     if(key==="MoonlightTreasureDraw.xml"){
      for each(node in xml.descendants())if(String(node.@text)==="月光钥匙:")node.@text="活动积分:";
      // Original redDot is invisible and no selected original body references it.
      for(var d:int=xml.Image.length()-1;d>=0;d--)if(String(xml.Image[d].attribute("var"))==="redDot")delete xml.Image[d];
     }
     if(key==="MoonlightHelp.xml"){
      var lines:Array=["1.本地常驻活动：三档开1／3／5盒，每盒20活动积分。","2.四种普通材料以本地接口规则抽取，第10盒保底强化石2级×2。","3.奖品暂存共用临时包，最多30抽取记录；勾选数量寄邮件。","4.选中材料每单位回收2活动积分，剩余数量保留。","5.本地进度10／20／30，各领强化石1级×2／4／6。","6.本地商店：10碎片兑强化石2级×2，5碎片兑属性修炼药水2级×1。","7.药水在修炼系统使用，等级／VIP／日次数遵循原规则；榜单无奖励。"];
      var i:int=0;for each(node in xml.LabelEx){node.@text=lines[i];node.@x=22;node.@y=56+i*42;node.@size=14;node.@width=462;node.@height=40;node.@multiline=true;node.@wordWrap=true;node.@leading=3;i++;}if(i!==7)throw new Error("帮助原布局条数不符。");
     }
     if(key==="MoonlightExchange.xml")for each(node in xml.LabelEx)if(String(node.@text)==="本期还可购买：")node.@text="本次最多：";
     if(key==="MoonlightBag.xml")for each(node in xml.LabelEx)if(String(node.@text)==="拆分可得：")node.@text="回收积分：";
     if(key==="MoonlightRank.xml"){
      for each(node in xml.descendants())if(String(node.@text)==="个人积分")node.@text="累计寻宝";else if(String(node.@text)==="我的积分：")node.@text="我的次数：";
      for each(node in xml.LabelEx)if(String(node.attribute("var"))==="rankDesTxt"){node.@text="本地真实角色 · 累计寻宝榜";node.@x=498;node.@y=-18;node.@width=360;node.@height=24;node.@size=14;node.@color="0x8dddff";}
     }
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
  private function validateRanking(r:Object,score:int):void {
   if(r==null)return; // Old receipt snapshots may predate the optional read-only board.
   if(!r||r.version!==1||r.kind!=="moonlight-native-ranking"||r.scope!=="local"||r.metric!=="cumulative-box-draws"||r.personalScore!==score||!(r.entries is Array)||r.entries.length>10)throw new Error("本地寻宝榜投影无效。");
   if(score===0?r.personalRank!==null:!integer(r.personalRank,1,2147483647))throw new Error("本地寻宝榜本人名次无效。");
   var previous:Object=null,seen:Object={},own:Object=null,above:int=0,sameScore:Boolean=false;
   for(var i:int=0;i<r.entries.length;i++){var row:Object=r.entries[i];if(!row||!integer(row.rank,1,10)||!integer(row.characterId,1,2147483647)||typeof row.nickName!=="string"||!row.nickName.replace(/\s/g,"")||row.nickName.length>200||!integer(row.score,1,1000000000)||seen[row.characterId])throw new Error("本地寻宝榜角色行无效。");
    if(previous&&(previous.score<row.score||(previous.score===row.score&&previous.characterId>=row.characterId)))throw new Error("本地寻宝榜顺序无效。");if(row.rank!==(previous&&previous.score===row.score?previous.rank:i+1))throw new Error("本地寻宝榜同分名次无效。");
    if(row.score>score)above++;if(row.score===score)sameScore=true;if(row.characterId===expectedId)own=row;seen[row.characterId]=true;previous=row;
   }
   if(own&&(own.score!==score||own.rank!==r.personalRank))throw new Error("本地寻宝榜本人数据不符。");
   if(score>0){if(!previous)throw new Error("本地寻宝榜缺少已参与角色。");if(r.entries.length<10||score>=previous.score){if(!sameScore||r.personalRank!==above+1)throw new Error("本地寻宝榜本人同分位置无效。");if(!own&&(r.entries.length<10||score>previous.score||expectedId<=previous.characterId))throw new Error("本地寻宝榜遗漏当前角色。");}else if(r.personalRank<=10||own)throw new Error("本地寻宝榜榜外名次无效。");}
  }
  private function validate(p:Object):void {
   if(!p||p.version!==1||p.kind!=="moonlight-native"||typeof p.started!=="boolean"||!integer(p.score,0,2147483647)||p.drawCost!==20||p.bagCapacity!==30||!integer(p.bagSlotsUsed,0,30)||!integer(p.draws,0,1000000000)||!integer(p.progressScore,0,1000000000)||!integer(p.fragments,0,1000000000)||!integer(p.pityRemaining,1,10))throw new Error("宝盒公开投影无效。");
   if(typeof p.day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(p.day)||typeof p.bagToken!=="string"||!new RegExp("^"+p.day+":[A-Za-z0-9_-]{43}$").test(p.bagToken)||!p.localRules||p.localRules.version!==1||typeof p.localRules.description!=="string")throw new Error("宝盒包版本或本地规则无效。");
   for each(var f:String in ["canDraw","canTake","canRecycle"])if(typeof p[f]!=="boolean")throw new Error("宝盒资格无效。");
   if(!(p.drawChoices is Array)||p.drawChoices.length!==3)throw new Error("开盒三档缺失。");for(var i:int=0;i<3;i++){var c:Object=p.drawChoices[i];if(c.count!==[1,3,5][i]||c.cost!==c.count*20||typeof c.canDraw!=="boolean")throw new Error("开盒档位无效。");}if(p.canDraw!==p.drawChoices[0].canDraw)throw new Error("开盒资格不符。");
   if(!(p.bag is Array)||p.bag.length>4||!(p.previewTemplateIds is Array)||p.previewTemplateIds.join(",")!=="11019,11001,11021,11002")throw new Error("材料目录无效。");var seen:Array=[];var total:int=0;for(i=0;i<p.bag.length;i++){var o:Object=p.bag[i];if(o.index!==i||!material(o.templateId)||seen.indexOf(o.templateId)>=0||!integer(o.itemCount,1,60)||o.recycleUnitPoints!==2)throw new Error("临时包材料无效。");seen.push(o.templateId);total+=o.itemCount;}if(total>60||(p.bagSlotsUsed===0)!==(p.bag.length===0)||p.canTake!==(p.bag.length>0)||(p.canRecycle&&p.bag.length===0))throw new Error("临时包总量无效。");
   if(!p.exchange||p.exchange.fragmentCost!==10||p.exchange.templateId!==11021||p.exchange.itemCount!==2||p.exchange.maxCount!==10||p.exchange.affordableCount!==Math.min(10,Math.floor(p.fragments/10))||p.exchange.canExchange!==(p.fragments>=10)||!(p.progress is Array)||p.progress.length!==3)throw new Error("奖励配置无效。");
   for(i=0;i<3;i++){o=p.progress[i];if(o.tier!==i+1||o.target!==(i+1)*10||o.templateId!==11019||o.itemCount!==(i+1)*2||typeof o.claimed!=="boolean"||typeof o.canClaim!=="boolean"||(o.claimed&&o.canClaim))throw new Error("进度奖励无效。");}
   validateRanking(p.ranking,p.draws);validateShop(p.shop,p.fragments,p.day);
  }
  private function validateShop(shop:Object,fragments:int,day:String):void {
   if(!shop||shop.version!==1||shop.kind!=="moonlight-native-shop"||shop.currency!=="local-fragments"||shop.maxCount!==10||typeof shop.token!=="string"||!new RegExp("^"+day+":[A-Za-z0-9_-]{43}$").test(shop.token)||!(shop.entries is Array)||shop.entries.length!==2)throw new Error("本地碎片商店配置无效，请刷新本地活动。");
   for(var i:int=0;i<2;i++){var entry:Object=shop.entries[i],price:int=i===0?10:5;if(!entry||entry.index!==i||entry.templateId!==[11021,40002][i]||entry.itemCount!==[2,1][i]||entry.fragmentCost!==price||entry.sourceGoodsId!==[0,160000024][i]||entry.affordableCount!==Math.min(10,Math.floor(fragments/price))||typeof entry.canBuy!=="boolean"||(entry.canBuy&&entry.affordableCount===0))throw new Error("本地碎片商店商品无效。");}
  }
  private function purchaseEffect(e:Object,action:Object,p:Object):void {
   if(!integer(action.index,0,1)||!integer(action.count,1,10)||action.choice!==projection.shop.token)throw new Error("购买请求商品无效。");var entry:Object=projection.shop.entries[action.index],spent:int=action.count*entry.fragmentCost;
   if(!entry.canBuy||action.count>entry.affordableCount||e.type!=="purchased"||e.index!==action.index||e.count!==action.count||e.templateId!==entry.templateId||e.itemCount!==action.count*entry.itemCount||e.fragmentsSpent!==spent||e.fragments!==p.fragments||p.fragments!==projection.fragments-spent)throw new Error("商店购买效果或碎片差额不符。");
  }
  private function effects(value:Object,action:Object):Object {
   var envelope:Object=value.nativeMoonlightAction;if(!envelope||envelope.requestId!==pendingId||!(envelope.effects is Array)||envelope.effects.length!==1)throw new Error("宝盒动作效果缺失。");var e:Object=envelope.effects[0],p:Object=value.nativeMoonlight;
   if(action.type==="draw"){
    if(e.type!=="drawn"||e.count!==action.count||e.cost!==action.count*20||e.score!==p.score||e.draws!==p.draws||!(e.rewards is Array)||e.rewards.length<1||e.rewards.length>4)throw new Error("开盒效果不符。");var total:int=0;var ids:Array=[];for each(var reward:Object in e.rewards){if(!material(reward.templateId)||ids.indexOf(reward.templateId)>=0||!integer(reward.itemCount,1,10))throw new Error("开盒材料效果无效。");ids.push(reward.templateId);total+=reward.itemCount;}if(total<action.count||total>action.count*2)throw new Error("开盒数量不符。");
   }else if(action.type==="take"||action.type==="recycle"){
    if(e.type!==(action.type==="take"?"taken":"recycled")||!(e.items is Array)||e.items.length!==action.items.length)throw new Error("临时包结算效果不符。");var awarded:int=0;for each(var choice:Object in action.items){var match:Object=null;for each(var item:Object in e.items)if(item.index===choice.index)match=item;var old:Object=projection.bag[choice.index];if(!match||match.templateId!==old.templateId||match.itemCount!==choice.count)throw new Error("结算材料数量不符。");awarded+=choice.count;}if(action.type==="recycle"&&(e.pointsAwarded!==awarded*2||e.score!==p.score))throw new Error("回收积分不符。");if(action.type==="take"&&e.itemCount!==awarded)throw new Error("取出总量不符。");
   }else if(action.type==="exchange"){var count:int=action.count===undefined?1:action.count;if(!integer(count,1,10)||e.type!=="exchanged"||e.count!==count||e.fragmentsSpent!==count*10||e.fragments!==p.fragments||e.templateId!==11021||e.itemCount!==count*2)throw new Error("兑换效果不符。");}
   else if(action.type==="buy"){purchaseEffect(e,action,p);}
   else if(action.type==="progress"){if(e.type!=="progress-claimed"||e.tier!==action.tier||e.templateId!==11019||e.itemCount!==action.tier*2||!p.progress[action.tier-1].claimed)throw new Error("进度领奖效果不符。");}else throw new Error("未知宝盒动作。");return e;
  }
  public function acceptSnapshot(envelope:Object):Object {try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}return statusNative();}
  private function applySnapshot(envelope:Object):Object {
   if(phase==="failed")throw new Error("已失败，拒绝迟到响应。");role();if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");
   var value:Object=envelope.snapshot;if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("动作 UUID 不符。");validate(value.nativeMoonlight);
   var action:Object=pendingAction,e:Object=null,fresh:Boolean=Boolean(action&&!value.replayed);if(fresh)e=effects(value,action);
   projection=value.nativeMoonlight;lastRevision=value.revision;pending=false;pendingId="";pendingAction=null;syncModel();
   if(!sceneRoot&&!action&&wantedOpen)constructWindow();if(main)renderStatic();if(action&&(action.type==="exchange"||action.type==="buy")&&popup)refreshExchange(popup,1);message=value.message?String(value.message):"已读取本地宝盒。";
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
   renderRanking();renderShop();
  }
  private function showRanking():void {
   if(!main||!projection)return;
   if(!rankView){var C:Object=cls("activity.moonlightbox.mornui.MoonlightRankUI");rankView=new C();rankView.x=39;rankView.y=104;main.addChild(rankView as DisplayObject);rankView.viewTab.visible=false;rankView.rewardBox.visible=false;rankView.rankBox.visible=true;rankView.playerBox.visible=false;rankView.rankClip.visible=false;rankView.bgClip.index=0;rankView.rankList.renderHandler=handler(renderRankRow);
    var explanation:TextField=text(44,104,360,150,"本地累计寻宝榜\n按真实累计开启盒数排序，同分同名次。\n同分角色按角色编号排序展示。\n只展示本地角色，不发放排行奖励。\n原私服积分、跨服和排行奖尚未复刻。",0xe9f5ff);explanation.multiline=true;explanation.wordWrap=true;rankView.addChild(explanation);
    var button:Sprite=new Sprite();button.x=80;button.y=270;button.graphics.lineStyle(1,0x8dddff);button.graphics.beginFill(0x293c7a);button.graphics.drawRoundRect(0,0,220,40,10,10);button.graphics.endFill();button.buttonMode=true;var caption:TextField=text(0,9,220,25,"刷新本地累计榜",0xffffff);var format:TextFormat=caption.defaultTextFormat;format.align="center";caption.setTextFormat(format);button.addChild(caption);rankView.addChild(button);bind(rankView,button,MouseEvent.CLICK,function(e:Event):void{queueRankingRefresh();});
   }
   rankView.visible=true;renderRanking();queueRankingRefresh();
  }
  private function queueRankingRefresh():void {if(main&&wantedOpen&&rankView&&rankView.visible&&!pending&&!animating)rankingRefreshQueued=true;}
  private function renderRanking():void {
   if(!rankView||!projection)return;var r:Object=projection.ranking;rankView.rankList.array=r?r.entries:[];rankView.myRankTxt.text=r&&r.personalRank!==null?String(r.personalRank):"暂无";rankView.myScoreTxt.text=String(projection.draws);rankView.myScoreTxt.width=100;rankView.myScoreTxt.size=14;rankView.rankDesTxt.text=r?"本地真实角色 · 累计寻宝榜":"本地累计榜待刷新，未展示旧榜单";
  }
  private function renderRankRow(row:Object,index:int):void {
   if(!rankView)return;var data:Array=rankView.rankList.array;if(index<0||index>=data.length){row.visible=false;return;}var entry:Object=data[index];row.visible=true;row.getChildByName("nickNameTxt").text=entry.nickName.length>9?entry.nickName.substr(0,8)+"…":entry.nickName;row.getChildByName("scoreTxt").text=String(entry.score);row.getChildByName("rankTxt").text=String(entry.rank);row.getChildByName("rankTxt").visible=entry.rank>3;row.getChildByName("rankClip").visible=entry.rank<=3;if(entry.rank<=3)row.getChildByName("rankClip").index=entry.rank-1;row.tipStyle="ddt.view.tips.OneLineTip";row.tipData=entry.nickName;
  }
  private function showShop():void {
   if(!main||!projection)return;
   if(!shopView){var C:Object=cls("activity.moonlightbox.mornui.MoonlightShopUI");shopView=new C();shopView.x=39;shopView.y=104;main.addChild(shopView as DisplayObject);shopPageNumber=1;shopView.list.renderHandler=handler(renderShopRow);shopView.leftBtn.clickHandler=handler(changeShopPage,[-1]);shopView.rightBtn.clickHandler=handler(changeShopPage,[1]);
    var explanation:TextField=text(10,-24,480,25,"本地碎片商店 · 奖品邮件领取 · 每次最多10份",0xe9f5ff);shopView.addChild(explanation);
    var button:Sprite=new Sprite();button.x=525;button.y=-28;button.graphics.lineStyle(1,0x8dddff);button.graphics.beginFill(0x293c7a);button.graphics.drawRoundRect(0,0,170,27,7,7);button.graphics.endFill();button.buttonMode=true;button.addChild(text(15,3,145,22,"刷新本地碎片",0xffffff));shopView.addChild(button);bind(shopView,button,MouseEvent.CLICK,function(e:Event):void{queueShopRefresh();});
    var empty:TextField=text(180,130,540,60,"当前没有可用的本地配方。",0xe9f5ff);empty.name="localShopEmpty";shopView.addChild(empty);
   }
   shopView.visible=true;renderShop();queueShopRefresh();
  }
  private function localShopRows():Array {
   if(!projection||!projection.shop)return [];var rows:Array=[];for(var i:int=0;i<projection.shop.entries.length;i++){var entry:Object=projection.shop.entries[i];rows.push({index:entry.index,templateId:entry.templateId,sourceGoodsId:entry.sourceGoodsId,fragmentCost:entry.fragmentCost,itemCount:entry.itemCount,affordableCount:entry.affordableCount,canBuy:entry.canBuy,info:null});}return rows;
  }
  private function renderShop():void {
   if(!shopView||!projection)return;shopRows=localShopRows();var pages:int=Math.ceil(shopRows.length/9);shopPageNumber=pages===0?0:Math.max(1,Math.min(pages,shopPageNumber));shopView.chipCountTxt.text=String(projection.fragments);shopView.chipCountTxt.size=14;shopView.chipCountTxt.width=75;shopView.pageTxt.text=shopPageNumber+"/"+pages;shopView.pageTxt.size=14;
   shopView.list.array=shopRows.slice(Math.max(0,(shopPageNumber-1)*9),shopPageNumber*9);shopView.leftBtn.disabled=pages===0||shopPageNumber<=1;shopView.rightBtn.disabled=pages===0||shopPageNumber>=pages;shopView.getChildByName("localShopEmpty").visible=shopRows.length===0;
  }
  private function changeShopPage(delta:int):void {
   if(!main||!wantedOpen||!shopView||!shopView.visible||pending||animating||popup||bag||confirmation)return;var pages:int=Math.ceil(shopRows.length/9);shopPageNumber=pages===0?0:Math.max(1,Math.min(pages,shopPageNumber+delta));renderShop();
  }
  private function renderShopRow(view:Object,index:int):void {
   if(!shopView)return;var rows:Array=shopView.list.array;if(index<0||index>=rows.length){view.visible=false;return;}var entry:Object=rows[index];view.visible=true;var C:Object=cls("ddt.data.goods.ShopItemInfo"),info:Object=new C();info.TemplateID=entry.templateId;info.GoodsID=entry.sourceGoodsId;info.AValue1=entry.fragmentCost;entry.info=info;view.info=info;
   var label:String=(entry.templateId===40002?"属性修炼药水2级":String(cls("ddt.manager.ItemManager").Instance.getTemplateById(entry.templateId).Name))+"×"+entry.itemCount;view.nickNameTxt.text=label.length>12?label.substr(0,11)+"…":label;view.nickNameTxt.width=178;view.nickNameTxt.height=25;view.nickNameTxt.size=14;view.nickNameTxt.tipStyle="ddt.view.tips.OneLineTip";view.nickNameTxt.tipData=label;view.countTxt.text=entry.fragmentCost+" /包";view.countTxt.width=115;shopItemState(view);
  }
  private function shopEntry(view:Object):Object {
   if(!shopView||!view||!view.visible||shopView.list.cells.indexOf(view)<0)return null;
   for(var i:int=0;i<shopRows.length;i++)if(shopRows[i].info&&shopRows[i].info===view._info)return shopRows[i];return null;
  }
  private function shopItemState(view:Object):void {
   var entry:Object=shopEntry(view);view.buyBtn.disabled=!entry||pending||animating||!entry.canBuy;view.limitTxt.visible=true;view.limitTxt.text=entry?"可兑"+entry.affordableCount+"包":"本地配方";view.limitTxt.width=96;
  }
  private function shopBuy(view:Object):void {
   if(!main||!wantedOpen||!shopView||!shopView.visible||pending||animating||confirmation||popup||bag)return;var entry:Object=shopEntry(view);if(!entry)return;if(!entry.canBuy){say("当前不能购买；每份需要"+entry.fragmentCost+"本地碎片，请检查余额和今日次数。");return;}openShopPurchase(entry.index);
  }
  private function queueShopRefresh():void {if(main&&wantedOpen&&shopView&&shopView.visible&&!pending&&!animating&&!popup&&!bag&&!confirmation)shopRefreshQueued=true;}
  private function closeShop():void {
   shopRefreshQueued=false;shopRows=[];shopPageNumber=1;if(shopView){var board:Object=shopView;shopView=null;unbind(board);board.leftBtn.clickHandler=null;board.rightBtn.clickHandler=null;board.list.renderHandler=null;board.list.dispose();board.dispose();}
  }
  private function constructWindow():void {
   role();sceneRoot=new Sprite();sceneRoot.graphics.beginFill(0x000000,0.7);sceneRoot.graphics.drawRect(0,0,1000,600);sceneRoot.graphics.endFill();var C:Object=cls("activity.moonlightbox.MoonlightTreasureMain");main=new C();main.x=12;main.y=66;sceneRoot.addChild(main as DisplayObject);main.viewTab.cells[2].label="本地累计榜";main.viewTab.cells[1].label="本地碎片商店";
   notice=text(24,578,956,21,"",0xe9f5ff);sceneRoot.addChild(notice);var host:Object=cls("com.pickgliss.ui.LayerManager").Instance;host.addToLayer(sceneRoot,3,true,1);
   sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);cls("com.pickgliss.toplevel.StageReferance").stage.focus=sceneRoot;
  }
  private function text(x:int,y:int,w:int,h:int,value:String,color:uint):TextField {var t:TextField=new TextField();t.x=x;t.y=y;t.width=w;t.height=h;t.defaultTextFormat=new TextFormat("Microsoft YaHei",13,color);t.text=value;t.mouseEnabled=false;return t;}
  private function lock():void {
   var blocked:Boolean=pending||animating||confirmation!==null||popup!==null||bag!==null;
   if(main){main.drawView.mouseChildren=!blocked;main.drawView.mouseEnabled=!blocked;main.viewTab.mouseChildren=!blocked;main.viewTab.mouseEnabled=!blocked;main.helpBtn.disabled=pending||animating;}
   if(rankView){rankView.mouseChildren=!blocked;rankView.mouseEnabled=!blocked;}
   if(shopView){shopView.mouseChildren=!blocked;shopView.mouseEnabled=!blocked;for(var i:int=0;i<shopView.list.cells.length;i++)shopItemState(shopView.list.cells[i]);}
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
  private function closePopup():void {if(popup){var view:Object=popup;popup=null;shopPurchaseIndex=-1;unbind(view);view.dispose();}lock();}
  private function openPopup(name:String):Object {if(!main||pending||animating)return null;closeBag();closePopup();var C:Object=cls(name);popup=new C();place(popup);lock();return popup;}
  private function openHelp():void {var v:Object=openPopup("activity.moonlightbox.mornui.MoonlightHelpUI");if(!v)return;v.closeBtn.clickHandler=handler(closePopup);v.okBtn.clickHandler=handler(closePopup);}
  private function handler(fn:Function,args:Array=null):Object {var C:Object=cls("morn.core.handlers.Handler");return new C(fn,args);}
  private function openShow():void {var v:Object=openPopup("activity.moonlightbox.view.MoonlightShowView");if(v)v.closeBtn.clickHandler=handler(closePopup);}
  private function openExchange():void {var v:Object=openPopup("activity.moonlightbox.view.MoonlightExchangeView");if(!v)return;v.setData(11021,0,10);v.setLimit(projection.exchange.affordableCount);v.leftBtn.visible=true;v.rightBtn.visible=true;v.pageTxt.editable=true;v.pageTxt.textField.maxChars=2;v.limitTxt.x=215;v.limitTxt.width=175;v.closeBtn.clickHandler=handler(closePopup);}
  private function openShopPurchase(index:int):void {
   if(!projection||!integer(index,0,1))return;var entry:Object=projection.shop.entries[index];if(!entry.canBuy)return;var v:Object=openPopup("activity.moonlightbox.view.MoonlightExchangeView");if(!v)return;shopPurchaseIndex=index;v.setData(entry.templateId,entry.sourceGoodsId,entry.fragmentCost);v.setLimit(entry.affordableCount);v.leftBtn.visible=true;v.rightBtn.visible=true;v.pageTxt.editable=true;v.pageTxt.textField.maxChars=2;v.limitTxt.x=215;v.limitTxt.width=175;v.limitTxt.height=24;v.limitTxt.size=12;v.closeBtn.clickHandler=handler(closePopup);
   var title:TextField=text(121,43,265,32,"",0xe9f5ff);title.name="localPurchaseTitle";title.defaultTextFormat=new TextFormat("Microsoft YaHei",12,0xe9f5ff);title.multiline=true;v.addChild(title);var rules:TextField=text(24,244,354,35,index===1?"属性修炼药水在修炼系统使用；等级／VIP／日次数遵循原规则。":"本地材料配方；每份2个，奖励通过邮件领取。",0xe9f5ff);rules.defaultTextFormat=new TextFormat("Microsoft YaHei",11,0xe9f5ff);rules.setTextFormat(rules.defaultTextFormat);rules.multiline=true;rules.wordWrap=true;v.addChild(rules);refreshExchange(v,1);
  }
  private function exchangeOffer():Object {
   if(shopPurchaseIndex>=0)return projection.shop.entries[shopPurchaseIndex];return {templateId:projection.exchange.templateId,itemCount:projection.exchange.itemCount,fragmentCost:projection.exchange.fragmentCost,affordableCount:projection.exchange.affordableCount,canBuy:projection.exchange.canExchange};
  }
  private function exchangeCount(value:String,max:int):int {var n:Number=Number(value);return /^[1-9][0-9]?$/.test(value)&&integer(n,1,max)?int(n):0;}
  private function refreshExchange(view:Object,value:Number):void {
   if(view!==popup||!projection)return;var offer:Object=exchangeOffer(),max:int=offer.affordableCount,count:int=Math.max(1,Math.min(Math.max(1,max),isFinite(value)?Math.floor(value):1));
   view._max=max;view.pageTxt.text=String(count);view._totle=count*offer.fragmentCost;view.needTxt.text=view._totle+"碎片";view.limitTxt.text="10份，当前可购"+max+"份";var title:Object=view.getChildByName("localPurchaseTitle");if(title)title.text=(offer.templateId===40002?"属性修炼药水2级":"强化石2级")+"\n"+count+"份，共"+(count*offer.itemCount)+"个";
   view.leftBtn.disabled=count<=1;view.rightBtn.disabled=count>=max;view.okBtn.disabled=max===0||!offer.canBuy;
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
  private function tick(e:Event):void {try{role();if(rankingRefreshQueued&&main&&wantedOpen&&rankView&&rankView.visible&&!pending&&!animating){rankingRefreshQueued=false;read();}else if(shopRefreshQueued&&main&&wantedOpen&&shopView&&shopView.visible&&!pending&&!animating&&!popup&&!bag&&!confirmation){shopRefreshQueued=false;read();}}catch(error:Error){fail(error.message);}}
  public function closeNative():Object {
   wantedOpen=false;animating=false;settledRewards=null;var failed:String="";
   rankingRefreshQueued=false;try{clearConfirm();closeBag();closePopup();closeShop();if(rankView){var board:Object=rankView;rankView=null;unbind(board);board.rankList.renderHandler=null;board.rankList.dispose();board.dispose();}if(main){var view:Object=main;main=null;if(view.drawView._movie)view.drawView._movie.stop();if(view.drawView._autoShowTimer)view.drawView._autoShowTimer.stop();view.dispose();}}catch(error:Error){failed=error.message;}
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
    if(name==="updateTab"){var tab:int=o.viewTab.selectedIndex;o.drawView.visible=tab===0;o.bgClip.index=tab===2?1:0;o.timeTxt.visible=tab!==1;if(rankView)rankView.visible=tab===2;if(shopView)shopView.visible=tab===1;if(tab===2)showRanking();else rankingRefreshQueued=false;if(tab===1)showShop();else shopRefreshQueued=false;return;}
   }
   if(owner==="activity/moonlightbox/view/MoonlightTreasureDraw"){
    if(name==="__drawClick"){draw(int(args[0]));return;}if(name==="__addKeyHandler"){openHelp();return;}if(name==="__showBagHandler"){openBag();return;}if(name==="__showAllRewards"){openShow();return;}if(name==="showDrawResult"){showDrawResult(o);return;}if(name==="__drawHandler"){startMovie(o,args[0]);return;}if(name==="__standBComplate"){endMovie(o,args[0]);return;}
   }
   if(owner==="activity/moonlightbox/view/MoonlightBagView"){if(name==="__useBagHandler"){useBag(o,int(args[0]));return;}throw new Error("原服临时包网络确认已关闭。");}
   if(owner==="activity/moonlightbox/view/MoonlightRewardItem"&&name==="__getReward"){var tier:int=int(o._type)/10;if(tier>=1&&tier<=3&&projection.progress[tier-1].canClaim)confirm("领取本地"+(tier*10)+"进度奖励：强化石1级×"+(tier*2)+"，寄入邮箱。",{type:"progress",tier:tier,choice:projection.bagToken});return;}
   if(owner==="activity/moonlightbox/view/MoonlightShopItem"){if(name==="updateLimit"){shopItemState(o);return;}if(name==="__buyHandler"){shopBuy(o);return;}}
   if(owner==="activity/moonlightbox/view/MoonlightExchangeView"){
    if(o!==popup||!projection)return;if(name==="setLimit"||name==="refreshNumText"){refreshExchange(o,Number(o.pageTxt.text));return;}
    if(pending||animating||confirmation)return;
    if(name==="__okHandler"){var offer:Object=exchangeOffer(),count:int=exchangeCount(String(o.pageTxt.text),offer.affordableCount);if(count>0&&offer.canBuy){if(shopPurchaseIndex>=0)confirm("消耗"+(count*offer.fragmentCost)+"本地碎片，购买"+(shopPurchaseIndex===1?"属性修炼药水2级":"强化石2级")+"×"+(count*offer.itemCount)+"，寄入邮箱。"+(shopPurchaseIndex===1?"药水在修炼系统使用，等级／VIP／日次数遵循原规则。":""),{type:"buy",index:shopPurchaseIndex,count:count,choice:projection.shop.token});else confirm("消耗"+(count*10)+"本地碎片，兑换"+count+"包强化石2级（共"+(count*2)+"个）寄入邮箱。",{type:"exchange",count:count,choice:projection.bagToken});}else say("请选择可购买数量；每次最多10份，请确认碎片和今日次数。");return;}
    if(name==="__inputChange"){refreshExchange(o,Number(o.pageTxt.text));return;}
    if(name==="__leftHandler"||name==="__rightHandler"){refreshExchange(o,Number(o.pageTxt.text)+(name==="__leftHandler"?-1:1));return;}
   }
   throw new Error("未实现的原宝盒适配："+owner+"."+name);
  }
 }
}
