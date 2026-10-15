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
  private var localText:TextField;
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
      if(key==="CarnivalMain.xml"){if(["trunDesTxt","trunDesTxt1","poolCountTxt","myRankTxt","myScoreTxt","remainCountTxt","itemCountTxt","activeTimeTxt"].indexOf(field)>=0)node.@text="";if(["turnBox1","turnBox2","poolBox","rankBox","rateBox","viewTab"].indexOf(field)>=0)node.@visible=false;if(field==="checkBtn"){node.@disabled=true;node.@label="大奖直播待移植";}if(field==="rechargeBtn"){node.@label="本地规则";node.@labelSize=13;}if(field==="continueBtn"){node.@label="本地5次批次";node.@labelSize=13;}if(field==="stopBtn"){node.@label="停止演出";node.@labelSize=13;}if(field==="startBtn")node.@label="单抽10积分";}
      if(key==="CarnivalBuyView.xml"&&field==="input")node.@text="1";
     }
     cls("morn.core.components.View").uiMap[key]=xml;
    }
    cls("App").stage=cls("com.pickgliss.toplevel.StageReferance").stage;cls("App").asset.setDomain(domain);phase="ready";message="原狂欢窗口已准备；打开只读取，不扣积分。";report();
   }catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+"carnival_v3_6_1_u1.ui"));
  }
  public function openNative():Object {role();if(phase!=="ready")return statusNative();if(pending&&pendingAction===null){wantedOpen=true;return statusNative();}if(pending||animating){say("已有操作或演出尚未完成。");return statusNative();}if(main)return statusNative();wantedOpen=true;read();return statusNative();}
  private function read():void {role();pending=true;pendingId="";pendingAction=null;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopCarnivalRead",expectedId,generation,sequence);if(!r||r.accepted!==true){pending=false;throw new Error("页面未接受读取。");}}catch(error:Error){say(error.message);}}
  private function request(action:Object):void {role();if(pending||animating||!projection||!wantedOpen)return;if(cls("ddt.manager.PlayerManager").Instance.Self.bagLocked){say("请先解除背包锁定。");return;}
   pending=true;pendingId="";pendingAction=action;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopCarnivalRequest",expectedId,generation,sequence,action);if(!r||r.accepted!==true||!r.requestId){pending=false;pendingAction=null;displayArmed=false;throw new Error("页面未接受操作，未提交扣分请求。");}pendingId=String(r.requestId);}catch(error:Error){say(error.message);}report();
  }
  private function integer(v:*,lo:int,hi:int):Boolean{return typeof v==="number"&&isFinite(v)&&v===Math.floor(v)&&v>=lo&&v<=hi;}
  private function validate(p:Object):void {
   if(!p||p.version!==1||p.kind!=="carnival-native"||typeof p.started!=="boolean"||typeof p.day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(p.day)||typeof p.stateToken!=="string"||!/^\d{4}-\d{2}-\d{2}:[A-Za-z0-9_-]{43}$/.test(p.stateToken)||p.stateToken.indexOf(p.day+":")!==0||p.activityState!==1)throw new Error("无效的狂欢投影或完整令牌。");
   if(!integer(p.score,0,2147483647)||!integer(p.personalScore,0,100000000)||!integer(p.redPackageCount,0,300000000)||!integer(p.remainDrawCount,0,500)||!integer(p.maxBatchCount,0,5)||p.maxBatchCount!==Math.min(5,p.remainDrawCount)||p.canDraw!==(p.remainDrawCount>0)||typeof p.startDate!=="string"||typeof p.endDate!=="string")throw new Error("本地狂欢计数无效。");
   if(!(p.prizes is Array)||p.prizes.length!==12||!(p.exchange is Array)||p.exchange.length!==7||!(p.records is Array)||p.records.length>20||!(p.unavailable is Array)||!p.rules||p.rules.version!==1||p.rules.drawCost!==10||p.rules.maxBatchCount!==5||p.rules.exchangeMaxCount!==10||p.rules.probabilityNumerator!==1||p.rules.probabilityDenominator!==12||typeof p.rules.description!=="string")throw new Error("本地狂欢目录或规则无效。");
   var ids:Array=[11019,11001,11021,11002],recipes:Array=[[11019,5,10],[11001,5,10],[11021,2,10],[11002,2,10],[11019,10,20],[11001,10,20],[11021,5,20]];
   for(var i:int=0;i<12;i++){var c:Object=p.prizes[i],n:int=int(i/4)+1;if(!c||c.id!==i+1||c.index!==i||c.templateId!==ids[i%4]||c.itemCount!==n||c.redPackets!==n||typeof c.name!=="string")throw new Error("原12格本地奖品映射无效。");}
   for(i=0;i<7;i++){c=p.exchange[i];if(!c||c.id!==i+1||c.index!==i||c.templateId!==recipes[i][0]||c.itemCount!==recipes[i][1]||c.redPacketsCost!==recipes[i][2]||c.canExchange!==(p.redPackageCount>=c.redPacketsCost)||typeof c.name!=="string")throw new Error("本地红包配方无效。");}
   var previous:int=p.personalScore+1;for each(c in p.records){if(!c||!integer(c.drawId,1,p.personalScore)||c.drawId>=previous||!integer(c.prizeId,1,12)||typeof c.day!=="string")throw new Error("当前角色开奖记录无效。");var prize:Object=p.prizes[c.prizeId-1];if(c.templateId!==prize.templateId||c.itemCount!==prize.itemCount||c.redPackets!==prize.redPackets)throw new Error("开奖记录材料不符。");previous=c.drawId;}
  }
  public function acceptSnapshot(envelope:Object):Object {try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}return statusNative();}
  private function applySnapshot(envelope:Object):Object {
   if(phase==="failed")throw new Error("狂欢窗口已失败，拒绝迟到响应。");role();if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");var value:Object=envelope.snapshot;
   if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("动作 UUID 不符。");validate(value.nativeCarnival);
   var action:Object=pendingAction,p:Object=value.nativeCarnival,fresh:Boolean=Boolean(action&&!value.replayed&&value.nativeCarnivalAction&&value.nativeCarnivalAction.requestId===pendingId),effects:Array=null;
   if(fresh){effects=value.nativeCarnivalAction.effects as Array;if(!effects)throw new Error("动作缺少确认效果。");if(action.type==="draw"){if(effects.length!==action.count)throw new Error("批次效果数量不符。");var previous:Object=null;for(var i:int=0;i<effects.length;i++){var e:Object=effects[i];if(!e||e.type!=="drawn"||!integer(e.prizeId,1,12)||e.index!==e.prizeId-1||e.drawId!==p.personalScore-effects.length+i+1||e.batchIndex!==i||e.batchCount!==action.count||e.cost!==10||!integer(e.score,0,2147483647)||!integer(e.redPackageCount,0,300000000))throw new Error("开奖顺序或本地费用不符。");var prize:Object=p.prizes[e.prizeId-1];if(e.templateId!==prize.templateId||e.itemCount!==prize.itemCount||e.redPackets!==prize.redPackets||(previous&&(e.score!==previous.score-10||e.redPackageCount!==previous.redPackageCount+e.redPackets)))throw new Error("开奖材料或结算不符。");previous=e;}if(previous.score!==p.score||previous.redPackageCount!==p.redPackageCount)throw new Error("最后开奖余额不符。");}
    else{if(effects.length!==1)throw new Error("兑换效果必须唯一。");e=effects[0];var recipe:Object=p.exchange[action.index];if(e.type!=="exchanged"||e.index!==action.index||e.catalogId!==recipe.id||e.count!==action.count||e.templateId!==recipe.templateId||e.itemCount!==recipe.itemCount*action.count||e.redPacketsSpent!==recipe.redPacketsCost*action.count||e.redPackageCount!==p.redPackageCount)throw new Error("红包兑换效果不符。");}
   }
   projection=p;lastRevision=value.revision;pending=false;pendingId="";pendingAction=null;if(!main&&!action&&wantedOpen)constructWindow();message=value.message?String(value.message):"已同步本地狂欢。";
   if(main&&wantedOpen&&displayArmed&&fresh&&action.type==="draw"){queue=effects.concat();animating=true;nextResult();}else{displayArmed=false;if(main)renderStatic();}lock();report();return statusNative();
  }
  public function rejectRequest(envelope:Object):Object {role();if(phase==="failed"||!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)return statusNative();if(pendingAction&&String(envelope.requestId)!==pendingId)return statusNative();if(envelope.definitive===true){pending=false;pendingAction=null;pendingId="";displayArmed=false;if(main)renderStatic();}say(String(envelope.message||"请求结果未知，请从页面重试原请求。"));return statusNative();}
  private function syncModel():void {var m:Object=manager(),parts:Array=projection.day.split("-");m.state=1;m.startDate=new Date(Date.UTC(int(parts[0]),int(parts[1])-1,int(parts[2])));m.endDate=new Date(m.startDate.time+86400000);m.redPackageCount=projection.redPackageCount;m.remainDrawCount=projection.remainDrawCount;m.myScore=projection.personalScore;m.myRank=0;m.rankArr=[];m.recordArr=projection.records;m.isSuccess=true;m.isAutoPlayMovie=false;
   if(!m.itemArr||m.itemArr.length!==12){m.itemArr=[];for each(var prize:Object in projection.prizes){var C:Object=cls("activity.carnival.CarnivalItemInfo"),row:Object=new C();row.ID=prize.id;row.TemplateID=prize.templateId;row.Count=prize.itemCount;row.IsBind=true;row.ValidDate=0;row.StrengthLevel=0;m.itemArr.push(row);}}
   localConfig.CarnivalStartDate=projection.startDate;localConfig.CarnivalEndDate=projection.endDate;var lines:Array=[];for each(var recipe:Object in projection.exchange)lines.push(recipe.id+","+recipe.templateId+"-"+recipe.itemCount+","+recipe.redPacketsCost);localConfig.CarnivalConvertItem=lines;
  }
  private function constructWindow():void {role();syncModel();sceneRoot=new Sprite();var stage:Object=cls("com.pickgliss.toplevel.StageReferance").stage;sceneRoot.graphics.beginFill(0x000000,0.65);sceneRoot.graphics.drawRect(0,0,stage.stageWidth,stage.stageHeight);sceneRoot.graphics.endFill();windowRoot=new Sprite();sceneRoot.addChild(windowRoot);var C:Object=cls("activity.carnival.view.CarnivalMain");main=new C();viewOwners[main]=true;windowRoot.addChild(main as DisplayObject);
   main._freshTimer.stop();main._freshTimer.removeEventListener("timer",main.__timerHandler);main.closeBtn.clickHandler=handler(closeNative);main.rankBox.visible=false;main.rateBox.visible=false;main.viewTab.visible=false;main.turnBox1.visible=false;main.turnBox2.visible=false;main.poolBox.visible=false;main.checkBtn.disabled=true;main.checkBtn.selected=false;
   notice=text(325,66,400,60,"",0xffedbb);windowRoot.addChild(notice);localText=text(720,147,253,315,"",0xffefbe);windowRoot.addChild(localText);stage.addChild(sceneRoot);sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);renderStatic();fitWindow();lock();
  }
  private function fitWindow():void {if(!windowRoot)return;var stage:Object=cls("com.pickgliss.toplevel.StageReferance").stage,r:Rectangle=windowRoot.getBounds(windowRoot);var s:Number=Math.min(1,(stage.stageWidth-20)/r.width,(stage.stageHeight-20)/r.height);windowRoot.scaleX=windowRoot.scaleY=s;windowRoot.x=(stage.stageWidth-r.width*s)/2-r.x*s;windowRoot.y=(stage.stageHeight-r.height*s)/2-r.y*s;}
  private function renderStatic():void {if(!main)return;syncModel();main.remainCountTxt.text=String(projection.remainDrawCount);main.itemCountTxt.text="×"+projection.redPackageCount;main.myScoreTxt.text=String(projection.personalScore);main.myRankTxt.text="排行待移植";main.trunDesTxt.text="本角色累计 "+projection.personalScore+" 抽";main.trunDesTxt1.text="普通材料已发邮件";main.poolCountTxt.text="本地无全服奖池";main.activeTimeTxt.text="本地常驻 · 单抽10活动积分";
   var rows:Array=[];for each(var r:Object in projection.records)rows.push(r);main.recordList.array=rows;if(localText)localText.text="本地奖池：12格等概率，每格1/12。\n四种普通材料×1／2／3；同时获1／2／3红包。\n\n活动积分："+projection.score+"\n本角色累计："+projection.personalScore+"抽\n红包："+projection.redPackageCount+"\n\n一次5抽先原子结算全部邮件；停止只停演出，不撤销已提交奖励。\n\n原全服／跨服排行、轮次大奖、大奖直播、Super窗口与真实付款待移植。";
   if(exchangeView)exchangeView.__updatePlayerInfo(new Event("playerInfo"));if(buyView)updateBuy(buyView);lock();
  }
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
  private function openHelp():void {if(!main||pending||animating||exchangeView||buyView||help)return;help=new Sprite();help.graphics.beginFill(0x34251d,0.98);help.graphics.drawRect(0,0,510,370);help.graphics.endFill();help.addChild(text(18,15,472,326,projection.rules.description+"\n\n本地单抽10活动积分；一次5抽50积分、单 UUID 原子结算。普通单抽保留原旋转与52／20帧演出；连续批次保留原直接落点、500毫秒展示节奏。停止／关闭只停止演出，已提交奖励永久绑定邮件保留。\n\n红包为本地活动计数，7种普通材料配方，每次兑换1–10份。\n原私服赔率、全服／跨服排行、轮次大奖、大奖直播、Super资源和付款尚未移植。点击此说明关闭。",0xffefbe));var o:Object=help;bind(o,o,MouseEvent.CLICK,function(e:Event):void{closeHelp();});placePopup(help);lock();}
  private function closeHelp():void {if(help){var o:Object=help;help=null;unbind(o);if(o.parent)o.parent.removeChild(o);}lock();}
  private function placePopup(o:Object):void {windowRoot.addChild(o as DisplayObject);var r:Rectangle=o.getBounds(o);o.x=500-r.x-r.width/2;o.y=315-r.y-r.height/2;}
  private function handler(fn:Function,args:Array=null):Object {var C:Object=cls("morn.core.handlers.Handler");return new C(fn,args);}
  private function text(x:Number,y:Number,w:Number,h:Number,label:String,color:uint):TextField {var t:TextField=new TextField();t.defaultTextFormat=new TextFormat("Microsoft YaHei",12,color);t.x=x;t.y=y;t.width=w;t.height=h;t.text=label;t.multiline=true;t.wordWrap=true;t.selectable=false;t.mouseEnabled=false;return t;}
  private function lock():void {if(notice)notice.text=message;if(!main||!projection)return;var busy:Boolean=pending||animating||exchangeView!==null||buyView!==null||help!==null;main._isPlay=pending||animating;main.startBtn.disabled=busy||!projection.canDraw;main.continueBtn.disabled=busy||projection.maxBatchCount<5;main.startBtn.visible=!displayArmed;main.continueBtn.visible=!displayArmed;main.stopBtn.visible=displayArmed;main.stopBtn.disabled=!displayArmed;main.exchangeBtn.disabled=busy;main.rechargeBtn.disabled=busy;main.checkBtn.disabled=true;if(buyView)updateBuy(buyView);}
  private function bind(owner:Object,target:Object,type:String,fn:Function):void {if(!bindings[owner])bindings[owner]=[];target.addEventListener(type,fn);bindings[owner].push([target,type,fn]);}
  private function unbind(owner:Object):void {if(!bindings[owner])return;for each(var row:Array in bindings[owner])row[0].removeEventListener(row[1],row[2]);delete bindings[owner];}
  private function stopBubble(e:Event):void{e.stopPropagation();}
  private function onKey(e:KeyboardEvent):void{if(e.keyCode===27){e.stopPropagation();closeNative();}}
  private function tick(e:Event):void{try{role();}catch(error:Error){fail(error.message);}}
  public function closeNative():Object {wantedOpen=false;displayRun++;displayArmed=false;animating=false;queue=[];currentResult=null;closeHelp();closeExchange();if(main){var o:Object=main;main=null;delete viewOwners[o];resetMovies(o);if(o._freshTimer){o._freshTimer.stop();o._freshTimer.removeEventListener("timer",o.__timerHandler);}o.dispose();o._shineMovie2=null;}if(sceneRoot){sceneRoot.removeEventListener(Event.ENTER_FRAME,tick);sceneRoot.removeEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.removeEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.removeEventListener(MouseEvent.MOUSE_DOWN,stopBubble);if(sceneRoot.parent)sceneRoot.parent.removeChild(sceneRoot);sceneRoot=null;}windowRoot=null;notice=null;localText=null;report();return statusNative();}
  public function abortNative(reason:String):void {closeNative();fail(reason);}
  private function fail(reason:String):void {if(phase==="failed")return;phase="failed";message=reason;if(sceneRoot)closeNative();report();}
  private function say(reason:String):void {message=reason;lock();report();}
  private function report():void {if(ExternalInterface.available)try{ExternalInterface.call("workshopCarnivalReport",statusNative());}catch(error:Error){}}
  public function statusNative():Object {return {phase:phase,characterId:expectedId,generation:generation,sequence:sequence,revision:lastRevision,open:sceneRoot!==null,pending:pending,requestId:pendingId,animating:animating,message:message,experimental:true};}
  public static function get instance():Object {return active.localConfig;}
  public static function GetTranslation(key:String,...args):String {if(key==="tank.carnival.tet10")return "本地普通材料已结算邮件："+args[0];if(key==="tank.carnival.tip5")return "本地常驻 · 单抽10活动积分";return active.cls("ddt.manager.LanguageMgr").GetTranslation.apply(null,[key].concat(args));}
  public static function dispatch(owner:String,name:String,o:Object,args:Array):* {if(!active)throw new Error("原狂欢桥未初始化。");return active.handle(owner,name,o,args);}
  private function handle(owner:String,name:String,o:Object,args:Array):* {
   if(owner==="activity/carnival/CarnivalManager"){if(name==="initTestData"){o.rankArr=[];o.recordArr=[];o.itemArr=[];return null;}if(name==="checkOpen")return true;if(name==="loadRes"||name==="showFrame")return openNative();if(name==="getRateByCount")throw new Error("原后台概率未移植。");if(name==="showSuperLuckerView"||name==="showSuperLuckerFrame"){say("原大奖直播／Super资源待移植。");return null;}if(name==="refreshData"){if(!pending&&!animating)read();return null;}if(name==="initEvent"||name.indexOf("__")===0)return null;}
   if(owner==="activity/carnival/view/CarnivalMain"){if(name==="__rollHandler"){draw(1);return null;}if(name==="__continueHandler"){draw(5);return null;}if(name==="__stopHandler"){stopPresentation();return null;}if(name==="continueDraw"){continuePresentation(o);return null;}if(name==="__timerHandler")return null;if(name==="__exchengeHandler"){openExchange();return null;}if(name==="__rechargeHandler"){openHelp();return null;}if(name==="__showBigDraw"||name==="__checkStateChange"){say("原大奖直播待移植。");return null;}if(name==="__recordListHandler"){var box:Object=args[0],index:int=int(args[1]);if(main!==o||!viewOwners[o]||!wantedOpen)return null;box.visible=index<projection.records.length;if(box.visible){var r:Object=projection.records[index];box.getChildByName("txt").text="本角色第"+r.drawId+"抽 "+projection.prizes[r.prizeId-1].name+"×"+r.itemCount+" +"+r.redPackets+"红包";}return null;}if(name==="__rankListHandler"||name==="__rateListHandler"){args[0].visible=false;return null;}}
   if(owner==="activity/carnival/view/CarnivalExchangeItem"&&name==="__exchangeHandler"){openBuy(o);return null;}
   if(owner==="activity/carnival/view/CarnivalBuyView"){if(name==="update"){updateBuy(o);return null;}if(name==="__buyHandler"){buy(o);return null;}}
   throw new Error("原狂欢未启用的网络／付款／排行分支："+owner+"."+name);
  }
 }
}
