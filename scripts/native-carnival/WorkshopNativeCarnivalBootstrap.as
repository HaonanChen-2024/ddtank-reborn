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
 public final class WorkshopNativeCarnivalBootstrap extends Sprite {
  private static var active:WorkshopNativeCarnivalBootstrap;
  private var domain:ApplicationDomain=ApplicationDomain.currentDomain;
  private var hostContext:LoaderContext;
  private var expectedId:int;
  private var generation:String;
  private var base:String;
  private var phase:String="new";
  private var sequence:int=0;
  private var lastRevision:Number=-1;
  private var lastGlobalRevision:Number=-1;
  private var lastGlobalMode:String="";
  private var lastGlobal:Object;
  private var worldRecords:Boolean=false;
  private var recordToggle:Sprite;
  private var pending:Boolean=false;
  private var pendingId:String="";
  private var pendingAction:Object;
  private var wantedOpen:Boolean=false;
  private var animating:Boolean=false;
  private var displayArmed:Boolean=false;
  private var displayContinuous:Boolean=false;
  private var displayRun:int=0;
  private var queue:Array=[];
  private var currentResult:Object;
  private var projection:Object;
  private var localConfig:Object={};
  private var sceneRoot:Sprite;
  private var windowRoot:Sprite;
  private var main:Object;
  private var exchangeView:Object;
  private var buyView:Object;
  private var help:Object;
  private var notice:TextField;
  private var rankTitle:TextField;
  private var rankRefresh:Sprite;
  private var rankingRefreshNeeded:Boolean=false;
  private var loaders:Array=[];
  private var bindings:Dictionary=new Dictionary(true);
  private var viewOwners:Dictionary=new Dictionary(true);
  private var message:String="尚未读取本地节日狂欢。";
  public function WorkshopNativeCarnivalBootstrap(){super();}
  private function cls(name:String):Object {if(!domain.hasDefinition(name))throw new Error("缺少原类："+name);return domain.getDefinition(name);}
  private function manager():Object{return cls("activity.carnival.CarnivalManager").ins;}
  private function role():void {
   var c:LoaderContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(!c||(hostContext&&c!==hostContext)||!c.applicationDomain.hasDefinition("WorkshopNativeCarnivalBootstrap")||c.applicationDomain.getDefinition("WorkshopNativeCarnivalBootstrap")!==WorkshopNativeCarnivalBootstrap)throw new Error("狂欢共享加载域已改变。");
   if(hostContext)for each(var n:String in ["App","Config","morn.core.components.View"])if(!c.applicationDomain.hasDefinition(n)||c.applicationDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享组件身份已改变。");
   if(cls("ddt.manager.StateManager").currentStateType!=="main"||int(cls("ddt.manager.PlayerManager").Instance.Self.ID)!==expectedId)throw new Error("请返回原角色的大厅。");
  }
  public function startNative(options:Object):void {
   if(active||phase!=="new")throw new Error("狂欢窗口不能重复初始化。");
   if(!options||int(options.expectedUserId)<=0||!options.generation||!options.baseUrl||options.sharedOwnerReady!==true)throw new Error("缺少真实角色、代次或共享 owner。");
   expectedId=int(options.expectedUserId);generation=String(options.generation);base=String(options.baseUrl);if(base.charAt(base.length-1)!=="/")throw new Error("资源路径缺少斜线。");
   role();hostContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(options.sharedContext!==hostContext||!(options.sharedDomain is ApplicationDomain))throw new Error("共享上下文不一致。");domain=hostContext.applicationDomain;
   for each(var n:String in ["App","Config","morn.core.components.View"])if(!options.sharedDomain.hasDefinition(n)||options.sharedDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享类不一致。");
   if(!ExternalInterface.available)throw new Error("当前页面没有本地狂欢桥接。");active=this;phase="loading";
   ExternalInterface.addCallback("workshopCarnivalAcceptSnapshot",acceptSnapshot);ExternalInterface.addCallback("workshopCarnivalRejectRequest",rejectRequest);
   ExternalInterface.addCallback("workshopCarnivalOpenNative",openNative);ExternalInterface.addCallback("workshopCarnivalCloseNative",closeNative);ExternalInterface.addCallback("workshopCarnivalStatusNative",statusNative);
   loadSwf("carnival-original-library.swf",function():void{loadSwf("carnival_v3_6_1_u1.swf",loadLayouts);});
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
   loader.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("原狂欢布局读取失败。");});loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("原狂欢布局访问失败。");});
   loader.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();var b:ByteArray=loader.data as ByteArray;b.uncompress();b.position=0;var layouts:Object=b.readObject();if(b.bytesAvailable)throw new Error("原布局含多余字节。");
    for each(var key:String in ["CarnivalMain.xml","CarnivalExchangeView.xml","CarnivalExchangeItem.xml","CarnivalBuyView.xml"]){if(!(layouts[key] is XML))throw new Error("缺少原布局："+key);var xml:XML=layouts[key];
     for each(var node:XML in xml.descendants()){var kind:String=String(node.name()),field:String=String(node.attribute("var"));if(["Label","LabelEx","TextInput"].indexOf(kind)>=0)node.@font="Microsoft YaHei";if(kind==="Button"||kind==="TabButtonEx")node.@labelFont="Microsoft YaHei";
      if(key==="CarnivalMain.xml"){if(["trunDesTxt","trunDesTxt1","poolCountTxt","myRankTxt","myScoreTxt","remainCountTxt","itemCountTxt","activeTimeTxt"].indexOf(field)>=0)node.@text="";if(["rateBox","viewTab"].indexOf(field)>=0)node.@visible=false;if(field==="checkBtn"){node.@disabled=true;node.@visible=false;}if(field==="rechargeBtn"){node.@label="本地规则";node.@labelSize=13;}if(field==="continueBtn"){node.@label="本地5次批次";node.@labelSize=13;}if(field==="stopBtn"){node.@label="停止演出";node.@labelSize=13;}if(field==="startBtn")node.@label="单抽10积分";}
      if(key==="CarnivalMain.xml"){if(String(node.@text)==="本次抽奖次数："){node.@text="累计：";node.@width=44;}if(String(node.@text)==="注：大奖概率会随着参与人数和您的投资次数，排名等变化"){node.@text="本地累计榜；同分同名次。\n不发排名奖，不代表原服概率。";node.@leading=1;node.@height=37;}if(String(node.@text)==="接受幸运大奖直播"){node.@text="Super原资源待补";node.@width=140;}if(String(node.@text)==="每充值1000点券可送一次抽奖次数")node.@text="仅本地积分；无真实付款";}
      if(key==="CarnivalMain.xml"){if(field==="myScoreTxt"){node.@x=765;node.@width=85;node.@align="right";}if(field==="myRankTxt"){node.@width=62;node.@size=10;}if(field==="poolCountTxt"){node.@width=132;node.@size=14;}if(field==="trunDesTxt"){node.@y=230;node.@height=30;node.@size=12;node.@multiline=true;node.@wordWrap=true;}if(field==="trunDesTxt1"){node.@height=30;node.@multiline=true;node.@wordWrap=true;node.@leading=1;}if(String(node.@name)==="nameTxt"){node.@size=11;node.@wordWrap=false;}if(String(node.@name)==="txt"){node.@height=40;node.@size=11;node.@leading=1;}}
      if(key==="CarnivalBuyView.xml"&&field==="input")node.@text="1";
     }
     cls("morn.core.components.View").uiMap[key]=xml;
    }
    cls("App").stage=cls("com.pickgliss.toplevel.StageReferance").stage;cls("App").asset.setDomain(domain);phase="ready";message="原狂欢窗口已准备；打开只读取，不扣积分。";report();
   }catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+"carnival_v3_6_1_u1.ui"));
  }
  public function openNative():Object {role();if(phase!=="ready")return statusNative();if(pending&&pendingAction===null){wantedOpen=true;return statusNative();}if(pending||animating){say("已有操作或演出尚未完成。");return statusNative();}if(main)return statusNative();wantedOpen=true;read();return statusNative();}
  private function read():void {role();pending=true;pendingId="";pendingAction=null;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopCarnivalRead",expectedId,generation,sequence);if(!r||r.accepted!==true)throw new Error("页面未接受读取。");}catch(error:Error){pending=false;say(error.message);}}
  private function request(action:Object):void {role();if(pending||animating||!projection||!wantedOpen)return;if(cls("ddt.manager.PlayerManager").Instance.Self.bagLocked){say("请先解除背包锁定。");return;}
   pending=true;pendingId="";pendingAction=action;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopCarnivalRequest",expectedId,generation,sequence,action);if(!r||r.accepted!==true||!r.requestId){pending=false;pendingAction=null;displayArmed=false;throw new Error("页面未接受操作，未提交扣分请求。");}pendingId=String(r.requestId);}catch(error:Error){say(error.message);}report();
  }
  private function integer(v:*,lo:int,hi:int):Boolean{return typeof v==="number"&&isFinite(v)&&v===Math.floor(v)&&v>=lo&&v<=hi;}
  private function validateRanking(r:Object,score:int):void {
   if(r===null)return;
   if(!r||r.version!==1||r.kind!=="carnival-native-ranking"||r.scope!=="local"||r.metric!=="cumulative-native-draws"||r.personalScore!==score||!(r.entries is Array)||r.entries.length>10)throw new Error("本地累计榜投影无效。");
   if(score===0?r.personalRank!==null:!integer(r.personalRank,1,2147483647))throw new Error("本地累计榜本人名次无效。");
   var previous:Object=null,seen:Object={},own:Object=null,above:int=0,sameScore:Boolean=false;
   for(var i:int=0;i<r.entries.length;i++){var row:Object=r.entries[i];if(!row||!integer(row.rank,1,10)||!integer(row.characterId,1,2147483647)||typeof row.nickName!=="string"||!row.nickName.replace(/\s/g,"")||row.nickName.length>200||!integer(row.score,1,100000000)||seen[row.characterId])throw new Error("本地累计榜角色行无效。");
    if(previous&&(previous.score<row.score||(previous.score===row.score&&previous.characterId>=row.characterId)))throw new Error("本地累计榜顺序无效。");if(row.rank!==(previous&&previous.score===row.score?previous.rank:i+1))throw new Error("本地累计榜同分名次无效。");
    if(row.score>score)above++;if(row.score===score)sameScore=true;if(row.characterId===expectedId)own=row;seen[row.characterId]=true;previous=row;
   }
   if(own&&(own.score!==score||own.rank!==r.personalRank))throw new Error("本地累计榜本人数据不符。");
   if(score>0){if(!previous)throw new Error("本地累计榜缺少已参与角色。");if(r.entries.length<10||score>=previous.score){if(!sameScore||r.personalRank!==above+1)throw new Error("本地累计榜本人同分位置无效。");if(!own&&(r.entries.length<10||score>previous.score||expectedId<=previous.characterId))throw new Error("本地累计榜遗漏当前角色。");}else if(r.personalRank<=10||own)throw new Error("本地累计榜榜外名次无效。");}
  }
  private function exactFields(value:Object,fields:Array):Boolean {if(!value)return false;var count:int=0;for(var key:String in value){if(fields.indexOf(key)<0)return false;count++;}if(count!==fields.length)return false;for each(key in fields)if(!value.hasOwnProperty(key))return false;return true;}
  private function validName(value:*):Boolean {return typeof value==="string"&&Boolean(value.replace(/\s/g,""))&&value.length<=200;}
  private function validateRound(result:Object):void {
   if(!exactFields(result,["type","roundId","globalRevision","settledAt","participantCount","awards"])||result.type!=="round-completed"||!integer(result.roundId,1,21474836)||result.globalRevision!==result.roundId*100||!integer(result.participantCount,1,100)||!(result.awards is Array)||result.awards.length!==3||typeof result.settledAt!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result.settledAt))throw new Error("全服轮次结果无效。");
   var stamp:Array=result.settledAt.split(/[-T:.Z]/),date:Date=new Date(Date.UTC(int(stamp[0]),int(stamp[1])-1,int(stamp[2]),int(stamp[3]),int(stamp[4]),int(stamp[5]),int(stamp[6])));
   if(date.getUTCFullYear()!==int(stamp[0])||date.getUTCMonth()!==int(stamp[1])-1||date.getUTCDate()!==int(stamp[2])||date.getUTCHours()!==int(stamp[3])||date.getUTCMinutes()!==int(stamp[4])||date.getUTCSeconds()!==int(stamp[5])||date.getUTCMilliseconds()!==int(stamp[6]))throw new Error("轮次结算时间无效。");
   var templates:Array=[11019,11021,11002],counts:Array=[100,2,2];for(var i:int=0;i<3;i++){var award:Object=result.awards[i];if(!exactFields(award,["slot","characterId","nickName","templateId","itemCount"])||award.slot!==i||!integer(award.characterId,1,2147483647)||!validName(award.nickName)||award.templateId!==templates[i]||award.itemCount!==counts[i])throw new Error("全服三项材料奖无效。");}
  }
  private function sameRound(a:Object,b:Object):Boolean {if(a.type!==b.type||a.roundId!==b.roundId||a.globalRevision!==b.globalRevision||a.settledAt!==b.settledAt||a.participantCount!==b.participantCount)return false;for(var i:int=0;i<3;i++){var x:Object=a.awards[i],y:Object=b.awards[i];if(x.slot!==y.slot||x.characterId!==y.characterId||x.nickName!==y.nickName||x.templateId!==y.templateId||x.itemCount!==y.itemCount)return false;}return true;}
  private function validateGlobal(g:Object,revision:Number,personalScore:int):void {
   if(g===null)return;
   if(!exactFields(g,["version","kind","scope","revision","actorRevision","roundId","roundDraws","roundTarget","totalDraws","participantCount","myRoundDraws","pool","roundRewards","recentRounds"])||g.version!==1||g.kind!=="carnival-native-global"||g.scope!=="local-server"||!integer(g.totalDraws,0,2147483647)||g.revision!==g.totalDraws||g.actorRevision!==revision||g.roundId!==Math.floor(g.totalDraws/100)+1||g.roundDraws!==g.totalDraws%100||g.roundTarget!==100||!integer(g.participantCount,0,g.roundDraws)||!integer(g.myRoundDraws,0,Math.min(g.roundDraws,personalScore))||(g.roundDraws===0?g.participantCount!==0:g.participantCount===0)||!exactFields(g.pool,["templateId","itemCount","contributionPerDraw"])||g.pool.templateId!==11019||g.pool.itemCount!==g.roundDraws||g.pool.contributionPerDraw!==1||!(g.roundRewards is Array)||g.roundRewards.length!==2||!(g.recentRounds is Array)||g.recentRounds.length!==Math.min(10,Math.floor(g.totalDraws/100)))throw new Error("全服进度或材料目录无效。");
   for(var i:int=0;i<2;i++){var reward:Object=g.roundRewards[i];if(!exactFields(reward,["slot","templateId","itemCount"])||reward.slot!==i+1||reward.templateId!==[11021,11002][i]||reward.itemCount!==2)throw new Error("轮次奖励目录无效。");}
   if(g.revision<lastGlobalRevision)throw new Error("全服进度版本倒退。");if(lastGlobal&&g.revision===lastGlobalRevision&&(g.participantCount!==lastGlobal.participantCount||g.myRoundDraws!==lastGlobal.myRoundDraws))throw new Error("同一全服版本的贡献被改写。");
   for(i=0;i<g.recentRounds.length;i++){var result:Object=g.recentRounds[i];validateRound(result);if(result.roundId!==g.roundId-1-i||result.globalRevision>g.revision)throw new Error("全服历史轮次不连续。");if(i>0&&g.recentRounds[i-1].settledAt<result.settledAt)throw new Error("全服历史结算时间倒退。");if(lastGlobal)for each(var old:Object in lastGlobal.recentRounds)if(old.roundId===result.roundId&&!sameRound(old,result))throw new Error("已结算轮次被改写。");}
  }
  private function validateFresh(action:Object,value:Object,p:Object):Array {
   var result:Object=value.nativeCarnivalAction,effects:Array=result.effects as Array,world:Array=result.worldEffects as Array,before:Object=projection;
   if(!before||!effects||!world||world.length>1||(p.globalMode!=="personal-only"&&p.globalMode!=="local-server")||(p.globalMode==="personal-only"?(p.global!==null||world.length!==0):!p.global))throw new Error("动作缺少普通效果或真实全服结果。");
   var i:int,e:Object,previousScore:Number=before.score,previousPackets:Number=before.redPackageCount;
   if(action.type==="draw"){
    if(!integer(action.count,1,5)||effects.length!==action.count||p.personalScore!==before.personalScore+action.count||(p.globalMode==="local-server"&&p.global.revision<Math.max(0,lastGlobalRevision)+action.count))throw new Error("批次效果或全服贡献数量不符。");
    for(i=0;i<effects.length;i++){e=effects[i];if(!e||e.type!=="drawn"||!integer(e.prizeId,1,12)||e.index!==e.prizeId-1||e.drawId!==before.personalScore+i+1||e.batchIndex!==i||e.batchCount!==action.count||e.cost!==10||!integer(e.score,0,2147483647)||!integer(e.redPackageCount,0,300000000))throw new Error("开奖顺序或本地费用不符。");var prize:Object=p.prizes[e.prizeId-1];if(e.templateId!==prize.templateId||e.itemCount!==prize.itemCount||e.redPackets!==prize.redPackets||e.score!==previousScore-10||e.redPackageCount!==previousPackets+e.redPackets)throw new Error("开奖材料或前态结算差额不符。");previousScore=e.score;previousPackets=e.redPackageCount;}
    if(previousScore!==p.score||previousPackets!==p.redPackageCount)throw new Error("最后开奖余额不符。");
    var crossed:Boolean=p.globalMode==="local-server"&&Math.floor(p.global.totalDraws/100)>Math.floor((p.global.totalDraws-action.count)/100);if(world.length!==(crossed?1:0))throw new Error("本次跨轮结果数量不符。");if(crossed){validateRound(world[0]);if(world[0].roundId!==Math.floor(p.global.totalDraws/100)||!sameRound(world[0],p.global.recentRounds[0]))throw new Error("本次轮次结果未载入全服历史。");}
   }else if(action.type==="exchange"){
    if(!integer(action.index,0,6)||!integer(action.count,1,10)||effects.length!==1||world.length!==0)throw new Error("兑换效果必须唯一且不开奖。");e=effects[0];var recipe:Object=p.exchange[action.index];if(e.type!=="exchanged"||e.index!==action.index||e.catalogId!==recipe.id||e.count!==action.count||e.templateId!==recipe.templateId||e.itemCount!==recipe.itemCount*action.count||e.redPacketsSpent!==recipe.redPacketsCost*action.count||e.redPackageCount!==p.redPackageCount||p.redPackageCount!==before.redPackageCount-e.redPacketsSpent||p.score!==before.score||p.personalScore!==before.personalScore)throw new Error("红包兑换前态差额不符。");
   }else throw new Error("未知本地狂欢动作。");return effects;
  }
  private function validate(p:Object):void {
   if(!p||p.version!==1||p.kind!=="carnival-native"||typeof p.started!=="boolean"||typeof p.day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(p.day)||typeof p.stateToken!=="string"||!/^\d{4}-\d{2}-\d{2}:[A-Za-z0-9_-]{43}$/.test(p.stateToken)||p.stateToken.indexOf(p.day+":")!==0||p.activityState!==1)throw new Error("无效的狂欢投影或完整令牌。");
   if(!integer(p.score,0,2147483647)||!integer(p.personalScore,0,100000000)||!integer(p.redPackageCount,0,300000000)||!integer(p.remainDrawCount,0,500)||!integer(p.maxBatchCount,0,5)||p.maxBatchCount!==Math.min(5,p.remainDrawCount)||p.canDraw!==(p.remainDrawCount>0)||typeof p.startDate!=="string"||typeof p.endDate!=="string")throw new Error("本地狂欢计数无效。");
   if(!(p.prizes is Array)||p.prizes.length!==12||!(p.exchange is Array)||p.exchange.length!==7||!(p.records is Array)||p.records.length>20||!(p.unavailable is Array)||!p.rules||p.rules.version!==1||p.rules.drawCost!==10||p.rules.maxBatchCount!==5||p.rules.exchangeMaxCount!==10||p.rules.probabilityNumerator!==1||p.rules.probabilityDenominator!==12||typeof p.rules.description!=="string")throw new Error("本地狂欢目录或规则无效。");
   if((p.globalMode!=="personal-only"&&p.globalMode!=="local-server")||(p.globalMode==="personal-only"&&p.global!==null)||(lastGlobalMode==="local-server"&&p.globalMode!=="local-server"))throw new Error("共享轮次启用状态无效。");
   var ids:Array=[11019,11001,11021,11002],recipes:Array=[[11019,5,10],[11001,5,10],[11021,2,10],[11002,2,10],[11019,10,20],[11001,10,20],[11021,5,20]];
   for(var i:int=0;i<12;i++){var c:Object=p.prizes[i],n:int=int(i/4)+1;if(!c||c.id!==i+1||c.index!==i||c.templateId!==ids[i%4]||c.itemCount!==n||c.redPackets!==n||typeof c.name!=="string")throw new Error("原12格本地奖品映射无效。");}
   for(i=0;i<7;i++){c=p.exchange[i];if(!c||c.id!==i+1||c.index!==i||c.templateId!==recipes[i][0]||c.itemCount!==recipes[i][1]||c.redPacketsCost!==recipes[i][2]||c.canExchange!==(p.redPackageCount>=c.redPacketsCost)||typeof c.name!=="string")throw new Error("本地红包配方无效。");}
   var previous:int=p.personalScore+1;for each(c in p.records){if(!c||!integer(c.drawId,1,p.personalScore)||c.drawId>=previous||!integer(c.prizeId,1,12)||typeof c.day!=="string")throw new Error("当前角色开奖记录无效。");var prize:Object=p.prizes[c.prizeId-1];if(c.templateId!==prize.templateId||c.itemCount!==prize.itemCount||c.redPackets!==prize.redPackets)throw new Error("开奖记录材料不符。");previous=c.drawId;}validateRanking(p.ranking,p.personalScore);
  }
  public function acceptSnapshot(envelope:Object):Object {try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}return statusNative();}
  private function applySnapshot(envelope:Object):Object {
   if(phase==="failed")throw new Error("狂欢窗口已失败，拒绝迟到响应。");role();if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");var value:Object=envelope.snapshot;
   if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("动作 UUID 不符。");validate(value.nativeCarnival);
   var action:Object=pendingAction,p:Object=value.nativeCarnival,fresh:Boolean=Boolean(action&&!value.replayed&&value.nativeCarnivalAction&&value.nativeCarnivalAction.requestId===pendingId),effects:Array=null;
   validateGlobal(p.global,value.revision,p.personalScore);
   if(action&&!value.replayed&&!fresh)throw new Error("缺少匹配 UUID 的新动作回执。");
   if(fresh){effects=validateFresh(action,value,p);if(value.nativeCarnivalAction.worldEffects.length>0)worldRecords=true;}
   if(p.global){lastGlobalRevision=p.global.revision;lastGlobal=p.global;}
   projection=p;lastRevision=value.revision;lastGlobalMode=p.globalMode;pending=false;pendingId="";pendingAction=null;if(!main&&!action&&wantedOpen)constructWindow();message=value.message?String(value.message):"已同步本地狂欢。";
   if(action&&main&&wantedOpen&&(p.ranking===null||p.global===null))rankingRefreshNeeded=true;
   if(main&&wantedOpen&&displayArmed&&fresh&&action.type==="draw"){queue=effects.concat();animating=true;nextResult();}else{displayArmed=false;if(main)renderStatic();}lock();report();return statusNative();
  }
  public function rejectRequest(envelope:Object):Object {role();if(phase==="failed"||!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)return statusNative();if(pendingAction&&String(envelope.requestId)!==pendingId)return statusNative();if(envelope.definitive===true){pending=false;pendingAction=null;pendingId="";displayArmed=false;if(main)renderStatic();}say(String(envelope.message||"请求结果未知，请从页面重试原请求。"));return statusNative();}
  private function syncModel():void {var m:Object=manager(),parts:Array=projection.day.split("-");m.state=1;m.startDate=new Date(Date.UTC(int(parts[0]),int(parts[1])-1,int(parts[2])));m.endDate=new Date(m.startDate.time+86400000);m.redPackageCount=projection.redPackageCount;m.remainDrawCount=projection.remainDrawCount;m.myScore=projection.personalScore;m.myRank=projection.ranking&&projection.ranking.personalRank!==null?projection.ranking.personalRank:0;m.rankArr=projection.ranking?projection.ranking.entries:[];m.recordArr=projection.records;m.isSuccess=true;m.isAutoPlayMovie=false;
   if(!m.itemArr||m.itemArr.length!==12){m.itemArr=[];for each(var prize:Object in projection.prizes){var C:Object=cls("activity.carnival.CarnivalItemInfo"),row:Object=new C();row.ID=prize.id;row.TemplateID=prize.templateId;row.Count=prize.itemCount;row.IsBind=true;row.ValidDate=0;row.StrengthLevel=0;m.itemArr.push(row);}}
   localConfig.CarnivalStartDate=projection.startDate;localConfig.CarnivalEndDate=projection.endDate;var lines:Array=[];for each(var recipe:Object in projection.exchange)lines.push(recipe.id+","+recipe.templateId+"-"+recipe.itemCount+","+recipe.redPacketsCost);localConfig.CarnivalConvertItem=lines;
  }
  private function constructWindow():void {role();syncModel();sceneRoot=new Sprite();var stage:Object=cls("com.pickgliss.toplevel.StageReferance").stage;sceneRoot.graphics.beginFill(0x000000,0.65);sceneRoot.graphics.drawRect(0,0,stage.stageWidth,stage.stageHeight);sceneRoot.graphics.endFill();windowRoot=new Sprite();sceneRoot.addChild(windowRoot);var C:Object=cls("activity.carnival.view.CarnivalMain");main=new C();viewOwners[main]=true;windowRoot.addChild(main as DisplayObject);
   main._freshTimer.stop();main._freshTimer.removeEventListener("timer",main.__timerHandler);main.closeBtn.clickHandler=handler(closeNative);main.rankBox.visible=true;main.rateBox.visible=false;main.viewTab.visible=false;main.turnBox1.visible=true;main.turnBox2.visible=true;main.poolBox.visible=true;main.checkBtn.disabled=true;main.checkBtn.selected=false;
   notice=text(325,66,390,60,"",0xffedbb);windowRoot.addChild(notice);rankTitle=text(720,113,150,26,"本地累计榜",0xffefbe);windowRoot.addChild(rankTitle);rankRefresh=new Sprite();rankRefresh.x=878;rankRefresh.y=112;rankRefresh.graphics.beginFill(0x6e4222);rankRefresh.graphics.drawRoundRect(0,0,84,27,6);rankRefresh.graphics.endFill();rankRefresh.addChild(text(12,4,72,21,"刷新数据",0xffefbe));rankRefresh.buttonMode=true;windowRoot.addChild(rankRefresh);bind(rankRefresh,rankRefresh,MouseEvent.CLICK,refreshRanking);recordToggle=new Sprite();recordToggle.x=64;recordToggle.y=357;recordToggle.graphics.beginFill(0x6e4222);recordToggle.graphics.drawRoundRect(0,0,217,26,6);recordToggle.graphics.endFill();recordToggle.addChild(text(8,3,204,22,"",0xffefbe));recordToggle.buttonMode=true;windowRoot.addChild(recordToggle);bind(recordToggle,recordToggle,MouseEvent.CLICK,toggleRecords);stage.addChild(sceneRoot);sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);renderStatic();fitWindow();lock();
  }
  private function fitWindow():void {if(!windowRoot)return;var stage:Object=cls("com.pickgliss.toplevel.StageReferance").stage,r:Rectangle=windowRoot.getBounds(windowRoot);var s:Number=Math.min(1,(stage.stageWidth-20)/r.width,(stage.stageHeight-20)/r.height);windowRoot.scaleX=windowRoot.scaleY=s;windowRoot.x=(stage.stageWidth-r.width*s)/2-r.x*s;windowRoot.y=(stage.stageHeight-r.height*s)/2-r.y*s;}
  private function renderStatic():void {if(!main)return;syncModel();main.remainCountTxt.text=String(projection.remainDrawCount);main.itemCountTxt.text="×"+projection.redPackageCount;main.myScoreTxt.text=String(projection.personalScore);main.myScoreTxt.toolTip="本人累计抽奖："+projection.personalScore;main.myRankTxt.text=projection.ranking?(projection.ranking.personalRank===null?"未上榜":String(projection.ranking.personalRank)):"待读取";main.myRankTxt.toolTip="本地累计名次："+main.myRankTxt.text;main.rankList.array=manager().rankArr;renderGlobal();main.activeTimeTxt.text="本地常驻";
   renderRecords();if(rankTitle)rankTitle.text=projection.ranking?"本地累计榜 · 无排名奖":"本地累计榜 · 待读取";
   if(exchangeView)exchangeView.__updatePlayerInfo(new Event("playerInfo"));if(buyView)updateBuy(buyView);lock();
  }
  private function shortName(name:String):String {return name.length>7?name.substr(0,6)+"…":name;}
  private function renderGlobal():void {
   var g:Object=projection.global;main.turnBox1.visible=main.turnBox2.visible=main.poolBox.visible=g!==null;main._turnCell1.info=null;main._turnCell2.info=null;main._poolCell.info=null;
   if(!g){if(projection.globalMode==="personal-only"){main.trunDesTxt.text="共享轮次未启用";main.trunDesTxt1.text="个人抽奖／红包兑换照常可用";main.poolCountTxt.text="";return;}main.trunDesTxt.text="全服轮次待读取";main.trunDesTxt1.text="请刷新数据，暂不显示估算奖池";main.poolCountTxt.text="待读取";return;}
   var items:Object=cls("ddt.manager.ItemManager").Instance;main._turnCell1.info=items.getTemplateById(11021);main._turnCell2.info=items.getTemplateById(11002);main._poolCell.info=items.getTemplateById(11019);
   if(!main._turnCell1.info||!main._turnCell2.info||!main._poolCell.info)throw new Error("原宿主缺少全服材料模板。");
   main.trunDesTxt.text="本地全服第"+g.roundId+"轮 · "+g.roundDraws+"/100抽\n参与"+g.participantCount+"人 · 我的贡献"+g.myRoundDraws;
   main.trunDesTxt1.text="两项轮次材料奖：各×2\n再抽"+(100-g.roundDraws)+"次结算三奖";
   main.poolCountTxt.text="×"+g.pool.itemCount+" / 100";main.poolCountTxt.toolTip="每抽投入强化材料×1，满100抽将11019×100发给真实参与者；本轮不回填历史累计。";
   main.turnBox1.toolTip="轮次奖：11021×2；真实参与者按本轮贡献抽取。";main.turnBox2.toolTip="轮次奖：11002×2；优先不同获奖者，不足时可重复。";
  }
  private function renderRecords():void {if(!main)return;var rows:Array=[];if(worldRecords){if(projection.global)for each(var round:Object in projection.global.recentRounds)for each(var award:Object in round.awards)rows.push({world:true,roundId:round.roundId,settledAt:round.settledAt,award:award});}else rows=projection.records.concat();main.recordList.array=rows;if(recordToggle)TextField(recordToggle.getChildAt(0)).text=worldRecords?"全服三奖记录 · 点击看本人":"本人开奖记录 · 点击看全服";}
  private function toggleRecords(e:Event):void {if(!main||!wantedOpen||pending||animating||displayArmed||exchangeView||buyView||help)return;worldRecords=!worldRecords;renderRecords();}
  private function renderRecordRow(o:Object,box:Object,index:int):void {if(main!==o||!viewOwners[o]||!wantedOpen)return;var rows:Array=main.recordList.array;box.visible=index>=0&&index<rows.length;if(!box.visible)return;var r:Object=rows[index],label:Object=box.getChildByName("txt");if(r.world){var a:Object=r.award,kind:String=a.slot===0?"奖池":("轮次奖"+a.slot);label.text="第"+r.roundId+"轮·"+kind+"\n"+shortName(a.nickName)+"："+a.templateId+"×"+a.itemCount;label.toolTip="第"+r.roundId+"轮 "+r.settledAt+"\n"+a.nickName+"（角色"+a.characterId+"）\n"+kind+"：材料"+a.templateId+"×"+a.itemCount+"，永久绑定邮件";}else{label.text="本人第"+r.drawId+"抽\n"+projection.prizes[r.prizeId-1].name+"×"+r.itemCount+" +"+r.redPackets+"红包";label.toolTip=label.text;}}
  private function renderRankRow(o:Object,cell:Object,index:int):void {if(main!==o||!viewOwners[o]||!wantedOpen||!projection)return;var entries:Array=projection.ranking?projection.ranking.entries:[];cell.visible=index>=0&&index<entries.length;if(!cell.visible)return;var row:Object=entries[index],clip:Object=cell.getChildByName("rankClip"),rank:Object=cell.getChildByName("rankTxt");clip.visible=row.rank<=3;rank.visible=row.rank>3;if(clip.visible)clip.index=row.rank-1;rank.text=String(row.rank);cell.getChildByName("nameTxt").text=shortName(row.nickName);cell.getChildByName("nameTxt").toolTip=row.nickName;cell.getChildByName("countTxt").text=String(row.score);}
  private function refreshRanking(e:Event):void {if(!main||!wantedOpen||pending||animating||displayArmed||exchangeView||buyView||help)return;rankingRefreshNeeded=false;read();}
  private function draw(count:int):void {if(!main||pending||animating||exchangeView||buyView||help||count<1||count>projection.maxBatchCount){say("本次积分或可抽次数不足，尚未提交。");return;}displayRun++;displayArmed=true;displayContinuous=count>1;message="本地一次提交"+count+"抽，共"+(count*10)+"积分；奖励已结算后，停止只停演出。";request({type:"draw",count:count,choice:projection.stateToken});}
  private function resetMovies(o:Object):void {if(!o)return;unbind(o);o.removeEventListener(Event.ENTER_FRAME,o.__startroll);clearTimeout(o._continueIndex);o._continueIndex=0;o._isContinue=false;o._isPlay=false;
   if(o._shineMovie1){o._shineMovie1.removeEventListener(Event.ENTER_FRAME,o.__disposeMovie);o._shineMovie1.gotoAndStop(1);o._shineMovie1.visible=false;}if(o._shineMovie2){o._shineMovie2.gotoAndStop(1);o._shineMovie2.visible=false;}if(o._drawMovie)o._drawMovie.stop();
  }
  private function nextResult():void {if(!main||!wantedOpen||!displayArmed||!animating)return;var o:Object=main;resetMovies(o);if(queue.length===0){displayArmed=false;animating=false;currentResult=null;renderStatic();report();return;}currentResult=queue.shift();var found:Boolean=false;for each(var row:Object in o._drawArr)if(row.ID===currentResult.prizeId)found=true;if(!found)throw new Error("开奖 ID 不在原打乱转盘中。");manager().curRollID=currentResult.prizeId;manager().isSuccess=true;o._isContinue=displayContinuous;o._isPlay=true;
   o.__rollItem(new Event("rollItem"));if(displayContinuous){lock();return;}o.removeEventListener(Event.ENTER_FRAME,o.__startroll);var run:int=displayRun,result:Object=currentResult;
   bind(o,o,Event.ENTER_FRAME,function(e:Event):void{if(main!==o||!wantedOpen||!displayArmed||!animating||displayRun!==run||currentResult!==result){unbind(o);return;}var wasVisible:Boolean=Boolean(o._shineMovie1&&o._shineMovie1.visible);o.__startroll(e);if(!wasVisible&&o._shineMovie1&&o._shineMovie1.visible){unbind(o);o._shineMovie1.removeEventListener(Event.ENTER_FRAME,o.__disposeMovie);var movie:MovieClip=o._shineMovie1 as MovieClip;
     bind(o,movie,Event.ENTER_FRAME,function(event:Event):void{if(main!==o||!wantedOpen||!displayArmed||!animating||displayRun!==run||currentResult!==result||event.currentTarget!==movie||o._shineMovie1!==movie){unbind(o);return;}var terminal:Boolean=movie.currentFrame===movie.totalFrames;o.__disposeMovie(event);if(terminal){unbind(o);nextResult();}else lock();});
    }lock();});lock();
  }
  private function continuePresentation(o:Object):void {clearTimeout(o._continueIndex);o._continueIndex=0;if(main!==o||!wantedOpen||!displayArmed||!displayContinuous||!animating)return;nextResult();}
  private function stopPresentation():void {displayRun++;displayArmed=false;animating=false;queue=[];currentResult=null;if(main)resetMovies(main);message=pending?"已停止本次演出；已提交请求仍由页面保留，迟到结果只同步，不重新播放。":"已停止演出；本次已提交的奖励仍保留在邮件。";if(main)renderStatic();report();}
  private function openExchange():void {if(!main||pending||animating||exchangeView||buyView||help)return;syncModel();var C:Object=cls("activity.carnival.view.CarnivalExchangeView");exchangeView=new C();viewOwners[exchangeView]=true;exchangeView.closeBtn.clickHandler=handler(closeExchange);var view:Object=exchangeView;view.list.renderHandler=handler(function(cell:Object,index:int):void{if(exchangeView!==view||!viewOwners[view]||!wantedOpen)return;cell.visible=index<view.list.array.length;if(cell.visible)cell.setInfoStr(view.list.array[index]);});placePopup(exchangeView);lock();}
  private function openBuy(o:Object):void {if(!main||!exchangeView||!exchangeView.contains(o as DisplayObject)||pending||animating||buyView||!projection)return;var index:int=int(o._id)-1;if(index<0||index>=7||!projection.exchange[index].canExchange){say("本地红包不足。");return;}var p:Object=projection.exchange[index],C:Object=cls("activity.carnival.view.CarnivalBuyView");buyView=new C(p.id,p.templateId,p.itemCount,p.redPacketsCost);viewOwners[buyView]=true;buyView.closeBtn.clickHandler=handler(closeBuy);buyView.input.maxChars=2;placePopup(buyView);updateBuy(buyView);lock();}
  private function updateBuy(o:Object):void {if(!projection)return;var index:int=int(o._id)-1;if(index<0||index>=projection.exchange.length)return;var p:Object=projection.exchange[index],limit:int=Math.min(10,Math.floor(projection.redPackageCount/p.redPacketsCost)),count:int=int(o.input.text);count=Math.max(1,Math.min(Math.max(1,limit),count));o.input.text=String(count);o._totalNeedCount=count*p.redPacketsCost;o.needTxt.text=String(o._totalNeedCount);o.buyBtn.disabled=pending||animating||limit<1;o.rightBtn.disabled=pending||animating||count>=limit;o.leftBtn.disabled=pending||animating||count<=1;o.input.mouseEnabled=o.input.mouseChildren=!pending&&!animating;}
  private function buy(o:Object):void {if(buyView!==o||!viewOwners[o]||pending||animating||!projection)return;var value:String=o.input.text,index:int=int(o._id)-1;if(!/^[1-9][0-9]?$/.test(value)||index<0||index>=7){say("兑换数量必须为1–10。");return;}var count:int=int(value),p:Object=projection.exchange[index];if(count>10||count*p.redPacketsCost>projection.redPackageCount){say("兑换数量超过本地红包余额。");return;}request({type:"exchange",index:index,count:count,choice:projection.stateToken});}
  private function closeBuy():void {if(buyView){var o:Object=buyView;buyView=null;delete viewOwners[o];o.input.changeHandler=null;o.dispose();}lock();}
  private function closeExchange():void {closeBuy();if(exchangeView){var o:Object=exchangeView;exchangeView=null;delete viewOwners[o];o.list.renderHandler=null;o.dispose();}lock();}
  private function openHelp():void {if(!main||pending||animating||exchangeView||buyView||help)return;help=new Sprite();help.graphics.beginFill(0x34251d,0.98);help.graphics.drawRect(0,0,590,440);help.graphics.endFill();help.addChild(text(18,15,554,410,projection.rules.description+"\n\n本地单抽10活动积分；一次5抽50积分、单 UUID 原子结算。普通单抽保留原旋转与52／20帧演出；连续批次保留原直接落点、500毫秒展示节奏。停止／关闭只停止演出，已提交奖励永久绑定邮件保留。\n\n红包为本地活动计数，7种普通材料配方，每次兑换1–10份。本地榜按真实累计次数排序，同分同名次，只读且无排名奖励。\n共享轮次启用时，每100抽结算一轮：奖池11019×100、轮次11021×2及11002×2。由服务端按真实本轮贡献抽取，优先不同获奖者；无人伪造，邮件与普通抽奖一起原子结算。左下可切换本人记录与最近10轮全服三奖。\n原私服赔率、私服及跨服排名奖、大奖直播／Super原资源和付款尚未移植。点击此说明关闭。",0xffefbe));var o:Object=help;bind(o,o,MouseEvent.CLICK,function(e:Event):void{closeHelp();});placePopup(help);lock();}
  private function closeHelp():void {if(help){var o:Object=help;help=null;unbind(o);if(o.parent)o.parent.removeChild(o);}lock();}
  private function placePopup(o:Object):void {windowRoot.addChild(o as DisplayObject);var r:Rectangle=o.getBounds(o);o.x=500-r.x-r.width/2;o.y=315-r.y-r.height/2;}
  private function handler(fn:Function,args:Array=null):Object {var C:Object=cls("morn.core.handlers.Handler");return new C(fn,args);}
  private function text(x:Number,y:Number,w:Number,h:Number,label:String,color:uint):TextField {var t:TextField=new TextField();t.defaultTextFormat=new TextFormat("Microsoft YaHei",12,color);t.x=x;t.y=y;t.width=w;t.height=h;t.text=label;t.multiline=true;t.wordWrap=true;t.selectable=false;t.mouseEnabled=false;return t;}
  private function lock():void {if(notice)notice.text=message;if(!main||!projection)return;var busy:Boolean=pending||animating||exchangeView!==null||buyView!==null||help!==null;main._isPlay=pending||animating;main.startBtn.disabled=busy||!projection.canDraw;main.continueBtn.disabled=busy||projection.maxBatchCount<5;main.startBtn.visible=!displayArmed;main.continueBtn.visible=!displayArmed;main.stopBtn.visible=displayArmed;main.stopBtn.disabled=!displayArmed;main.exchangeBtn.disabled=busy;main.rechargeBtn.disabled=busy;main.checkBtn.disabled=true;if(recordToggle){recordToggle.mouseEnabled=!busy&&!displayArmed;recordToggle.alpha=busy||displayArmed?0.5:1;}if(rankRefresh){rankRefresh.mouseEnabled=!busy&&!displayArmed;rankRefresh.alpha=busy||displayArmed?0.5:1;}if(buyView)updateBuy(buyView);}
  private function bind(owner:Object,target:Object,type:String,fn:Function):void {if(!bindings[owner])bindings[owner]=[];target.addEventListener(type,fn);bindings[owner].push([target,type,fn]);}
  private function unbind(owner:Object):void {if(!bindings[owner])return;for each(var row:Array in bindings[owner])row[0].removeEventListener(row[1],row[2]);delete bindings[owner];}
  private function stopBubble(e:Event):void{e.stopPropagation();}
  private function onKey(e:KeyboardEvent):void{if(e.keyCode===27){e.stopPropagation();closeNative();}}
  private function tick(e:Event):void{try{role();if(rankingRefreshNeeded&&main&&wantedOpen&&!pending&&!animating&&!displayArmed){rankingRefreshNeeded=false;read();}}catch(error:Error){fail(error.message);}}
  public function closeNative():Object {wantedOpen=false;rankingRefreshNeeded=false;displayRun++;displayArmed=false;animating=false;queue=[];currentResult=null;closeHelp();closeExchange();if(recordToggle){unbind(recordToggle);recordToggle=null;}if(rankRefresh){unbind(rankRefresh);rankRefresh=null;}if(main){var o:Object=main;main=null;delete viewOwners[o];resetMovies(o);if(o._freshTimer){o._freshTimer.stop();o._freshTimer.removeEventListener("timer",o.__timerHandler);}o.dispose();o._shineMovie2=null;}if(sceneRoot){sceneRoot.removeEventListener(Event.ENTER_FRAME,tick);sceneRoot.removeEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.removeEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.removeEventListener(MouseEvent.MOUSE_DOWN,stopBubble);if(sceneRoot.parent)sceneRoot.parent.removeChild(sceneRoot);sceneRoot=null;}windowRoot=null;notice=null;rankTitle=null;report();return statusNative();}
  public function abortNative(reason:String):void {closeNative();fail(reason);}
  private function fail(reason:String):void {if(phase==="failed")return;phase="failed";message=reason;if(sceneRoot)closeNative();report();}
  private function say(reason:String):void {message=reason;lock();report();}
  private function report():void {if(ExternalInterface.available)try{ExternalInterface.call("workshopCarnivalReport",statusNative());}catch(error:Error){}}
  public function statusNative():Object {return {phase:phase,characterId:expectedId,generation:generation,sequence:sequence,revision:lastRevision,globalRevision:lastGlobalRevision,open:sceneRoot!==null,pending:pending,requestId:pendingId,animating:animating,message:message,experimental:true};}
  public static function get instance():Object {return active.localConfig;}
  public static function GetTranslation(key:String,...args):String {if(key==="tank.carnival.tet10")return "本地普通材料已结算邮件："+args[0];if(key==="tank.carnival.tip5")return "本地常驻 · 单抽10活动积分";return active.cls("ddt.manager.LanguageMgr").GetTranslation.apply(null,[key].concat(args));}
  public static function dispatch(owner:String,name:String,o:Object,args:Array):* {if(!active)throw new Error("原狂欢桥未初始化。");return active.handle(owner,name,o,args);}
  private function handle(owner:String,name:String,o:Object,args:Array):* {
   if(owner==="activity/carnival/CarnivalManager"){if(name==="initTestData"){o.rankArr=[];o.recordArr=[];o.itemArr=[];return null;}if(name==="checkOpen")return true;if(name==="loadRes"||name==="showFrame")return openNative();if(name==="getRateByCount")throw new Error("原后台概率未移植。");if(name==="showSuperLuckerView"||name==="showSuperLuckerFrame"){say("原大奖直播／Super资源待移植。");return null;}if(name==="refreshData"){if(!pending&&!animating)read();return null;}if(name==="initEvent"||name.indexOf("__")===0)return null;}
   if(owner==="activity/carnival/view/CarnivalMain"){if(name==="__rollHandler"){draw(1);return null;}if(name==="__continueHandler"){draw(5);return null;}if(name==="__stopHandler"){stopPresentation();return null;}if(name==="continueDraw"){continuePresentation(o);return null;}if(name==="__timerHandler")return null;if(name==="__exchengeHandler"){openExchange();return null;}if(name==="__rechargeHandler"){openHelp();return null;}if(name==="__showBigDraw"||name==="__checkStateChange"){say("原大奖直播待移植。");return null;}if(name==="__recordListHandler"){renderRecordRow(o,args[0],int(args[1]));return null;}if(name==="__rankListHandler"){renderRankRow(o,args[0],int(args[1]));return null;}if(name==="__rateListHandler"){args[0].visible=false;return null;}}
   if(owner==="activity/carnival/view/CarnivalExchangeItem"&&name==="__exchangeHandler"){openBuy(o);return null;}
   if(owner==="activity/carnival/view/CarnivalBuyView"){if(name==="update"){updateBuy(o);return null;}if(name==="__buyHandler"){buy(o);return null;}}
   throw new Error("原狂欢未启用的网络／付款／排行分支："+owner+"."+name);
  }
 }
}
