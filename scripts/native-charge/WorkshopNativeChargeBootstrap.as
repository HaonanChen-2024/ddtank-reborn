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
 import flash.geom.Rectangle;
 import flash.utils.ByteArray;
 import flash.utils.Dictionary;
 /** The original four-page window presents explicit local task rules. The page owns HTTP/UUIDs. */
 public final class WorkshopNativeChargeBootstrap extends Sprite {
  private static var active:WorkshopNativeChargeBootstrap;
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
  private var confirmation:Object;
  private var notice:TextField;
  private var loaders:Array=[];
  private var bindings:Dictionary=new Dictionary(true);
  private var viewOwners:Dictionary=new Dictionary(true);
  private var cellOwners:Dictionary=new Dictionary(true);
  private var captions:Dictionary=new Dictionary(true);
  private var message:String="尚未读取本地任务活动。";
  public function WorkshopNativeChargeBootstrap(){super();}
  private function cls(name:String):Object {if(!domain.hasDefinition(name))throw new Error("缺少原类："+name);return domain.getDefinition(name);}
  private function controller():Object{return cls("chargeActivity.ChargeActivityController").instance;}
  private function role():void {
   var c:LoaderContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(!c||(hostContext&&c!==hostContext)||!c.applicationDomain.hasDefinition("WorkshopNativeChargeBootstrap")||c.applicationDomain.getDefinition("WorkshopNativeChargeBootstrap")!==WorkshopNativeChargeBootstrap)throw new Error("任务赠送共享加载域已改变。");
   if(hostContext)for each(var n:String in ["App","Config","morn.core.components.View"])if(!c.applicationDomain.hasDefinition(n)||c.applicationDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享组件身份已改变。");
   if(cls("ddt.manager.StateManager").currentStateType!=="main"||int(cls("ddt.manager.PlayerManager").Instance.Self.ID)!==expectedId)throw new Error("请返回原角色的大厅。");
  }
  public function startNative(options:Object):void {
   if(active||phase!=="new")throw new Error("任务赠送窗口不能重复初始化。");
   if(!options||int(options.expectedUserId)<=0||!options.generation||!options.baseUrl||options.sharedOwnerReady!==true)throw new Error("缺少真实角色、代次或共享 owner。");
   expectedId=int(options.expectedUserId);generation=String(options.generation);base=String(options.baseUrl);if(base.charAt(base.length-1)!=="/")throw new Error("资源路径缺少斜线。");
   role();hostContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(options.sharedContext!==hostContext||!(options.sharedDomain is ApplicationDomain))throw new Error("共享上下文不一致。");domain=hostContext.applicationDomain;
   for each(var n:String in ["App","Config","morn.core.components.View"])if(!options.sharedDomain.hasDefinition(n)||options.sharedDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享类不一致。");
   if(!ExternalInterface.available)throw new Error("当前页面没有本地任务赠送桥接。");active=this;phase="loading";
   ExternalInterface.addCallback("workshopChargeAcceptSnapshot",acceptSnapshot);ExternalInterface.addCallback("workshopChargeRejectRequest",rejectRequest);
   ExternalInterface.addCallback("workshopChargeOpenNative",openNative);ExternalInterface.addCallback("workshopChargeCloseNative",closeNative);ExternalInterface.addCallback("workshopChargeStatusNative",statusNative);
   loadSwf("charge-original-library.swf",function():void{loadSwf("chargeactivity_v3_6_1_u1.swf",loadLayouts);});
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
   loader.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("原任务赠送布局读取失败。");});loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("原任务赠送布局访问失败。");});
   loader.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();var b:ByteArray=loader.data as ByteArray;b.uncompress();b.position=0;var layouts:Object=b.readObject();if(b.bytesAvailable)throw new Error("原布局含多余字节。");
    for each(var key:String in ["ChargeActivityMainView.xml","ChargeActivityTaskCell.xml","ChargeActivityGiftCell.xml","ChargeActivityExchangeCell.xml"]){if(!(layouts[key] is XML))throw new Error("缺少原布局："+key);var xml:XML=layouts[key];
     for each(var node:XML in xml.descendants()){var kind:String=String(node.name()),field:String=String(node.attribute("var"));
      if(String(node.@vScrollBarSkin)==="asset.ui.scroll1.vscroll")node.@vScrollBarSkin="workshop.charge.skin.Scroll";
      if(["Label","LabelEx","TextInput"].indexOf(kind)>=0)node.@font="Microsoft YaHei";if(kind==="Button"||kind==="TabButtonEx")node.@labelFont="Microsoft YaHei";
      if(key==="ChargeActivityMainView.xml"&&field==="tipsImg")node.@visible=false;
      if(key==="ChargeActivityMainView.xml"&&field==="timeLabel"){node.@text="";node.@size=12;node.@width=650;node.@x=60;node.@right=55;}
     }cls("morn.core.components.View").uiMap[key]=xml;
    }cls("App").stage=cls("com.pickgliss.toplevel.StageReferance").stage;cls("App").asset.setDomain(domain);phase="ready";message="原四页任务赠送已准备，打开只读取本地资格。";report();
   }catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+"chargeactivity_v3_6_1_u1.ui"));
  }
  public function openNative():Object {role();if(phase!=="ready")return statusNative();if(pending&&pendingAction===null){wantedOpen=true;return statusNative();}if(pending){say("已有操作尚未确认，请使用页面原 UUID 重试。");return statusNative();}if(main)return statusNative();wantedOpen=true;read();return statusNative();}
  private function read():void {role();pending=true;pendingId="";pendingAction=null;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopChargeRead",expectedId,generation,sequence);if(!r||r.accepted!==true){pending=false;throw new Error("页面未接受读取。");}}catch(error:Error){say(error.message);}}
  private function request(action:Object):void {role();if(pending||!projection||!wantedOpen)return;if(cls("ddt.manager.PlayerManager").Instance.Self.bagLocked){say("请先解除背包锁定。");return;}
   pending=true;pendingId="";pendingAction=action;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopChargeRequest",expectedId,generation,sequence,action);if(!r||r.accepted!==true||!r.requestId){pending=false;pendingAction=null;throw new Error("页面未接受操作，未提交扣分请求。");}pendingId=String(r.requestId);}catch(error:Error){say(error.message);}report();
  }
  private function integer(v:*,lo:int,hi:int):Boolean{return typeof v==="number"&&isFinite(v)&&v===Math.floor(v)&&v>=lo&&v<=hi;}
  private function validateReward(r:Object):void {if(!r||[11019,11001,11021,11002].indexOf(r.templateId)<0||!integer(r.count,1,10000)||r.validDays!==0||r.bound!==true)throw new Error("本地永久绑定材料预览无效。");}
  private function validate(p:Object):void {
   if(!p||p.version!==1||p.kind!=="charge-native"||p.rulesVersion!==1||p.currency!=="local-task-points"||typeof p.day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(p.day)||typeof p.stateToken!=="string"||!/^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{43}$/.test(p.stateToken)||p.stateToken.indexOf(p.day+".")!==0)throw new Error("本地任务活动投影或完整令牌无效。");
   for each(var field:String in ["points","taskEarned","todayClaimedTaskPoints","grossSpent"])if(!integer(p[field],0,2147483647))throw new Error("本地任务计数无效。");
   if(typeof p.grossCapped!=="boolean"||(p.trackingStartedAt!==null&&typeof p.trackingStartedAt!=="string")||!(p.pages is Array)||p.pages.length!==3||!p.exchange||p.exchange.catalogVersion!=="charge-material-v1"||!(p.exchange.rows is Array)||p.exchange.rows.length!==7||!p.rules||p.rules.source!=="explicit-local-rules"||p.rules.grossLimit!==2147483647||!(p.rules.description is Array)||!(p.unavailable is Array))throw new Error("三页资格或七行兑换目录无效。");
   var rates:Array=[1,2,4],metrics:Array=["today-claimed-task-points","lifetime-task-earned","gross-spent-since-tracking"],targets:Array=[[40,100,200],[100,300,600],[100,300,600]],currents:Array=[p.todayClaimedTaskPoints,p.taskEarned,p.grossSpent];
   for(var i:int=0;i<3;i++){var page:Object=p.pages[i];if(!page||page.index!==i||page.originalRate!==rates[i]||page.metric!==metrics[i]||page.period!==(i===0?"utc-day":"permanent")||page.current!==currents[i]||typeof page.title!=="string"||typeof page.description!=="string"||!(page.tiers is Array)||page.tiers.length!==3)throw new Error("本地三页任务语义不符。");
    for(var j:int=0;j<3;j++){var t:Object=page.tiers[j],available:int=0;if(!t||t.tier!==j+1||t.target!==targets[i][j]||t.current!==page.current||typeof t.title!=="string"||typeof t.claimKey!=="string"||typeof t.reason!=="string"||typeof t.claimed!=="boolean"||typeof t.canClaim!=="boolean"||!(t.rewards is Array)||t.rewards.length!==4||(t.canClaim&&(t.claimed||t.current<t.target)))throw new Error("本地任务档位无效。");for each(var reward:Object in t.rewards)if(reward!==null){validateReward(reward);available++;}if(available===0)throw new Error("原任务行至少需要一项真实奖励。");}
   }
   var ids:Array=[11019,11001,11021,11002,11019,11021,11002],counts:Array=[3,3,1,1,6,2,2],fees:Array=[15,20,25,30,35,40,50],quals:Array=[0,0,100,100,300,300,600],limits:Array=[1,2,3,3,3,3,3];
   for(i=0;i<7;i++){var row:Object=p.exchange.rows[i];if(!row||row.index!==i||row.catalogId!=="charge-exchange:"+(i+1)||row.count!==1||typeof row.name!=="string"||typeof row.reason!=="string"||row.reason.length===0||row.unitPoints!==fees[i]||!row.reward||row.reward.templateId!==ids[i]||row.reward.count!==counts[i]||row.period!=="utc-day"||row.limit!==limits[i]||!integer(row.bought,0,row.limit)||row.remaining!==row.limit-row.bought||typeof row.canExchange!=="boolean"||row.confirmRequired!==true||!row.qualification||row.qualification.metric!=="lifetime-task-earned"||row.qualification.current!==p.taskEarned||row.qualification.target!==quals[i]||row.qualification.met!==(p.taskEarned>=quals[i])||(row.canExchange&&(!row.qualification.met||row.remaining<1||p.points<row.unitPoints)))throw new Error("本地单份兑换条件不符。");validateReward(row.reward);}
  }
  public function acceptSnapshot(envelope:Object):Object {try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}return statusNative();}
  private function applySnapshot(envelope:Object):Object {
   if(phase==="failed")throw new Error("任务赠送窗口已失败，拒绝迟到响应。");role();if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");var value:Object=envelope.snapshot;
   if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("动作 UUID 不符。");validate(value.nativeCharge);
   var action:Object=pendingAction,p:Object=value.nativeCharge,fresh:Boolean=Boolean(action&&!value.replayed&&value.nativeChargeAction&&value.nativeChargeAction.requestId===pendingId);
   if(fresh){var effects:Array=value.nativeChargeAction.effects as Array;if(!effects||effects.length!==1)throw new Error("任务动作效果必须唯一。");var effect:Object=effects[0];if(!effect||effect.index!==action.index||effect.type!==(action.type==="claim"?"claimed":"exchanged"))throw new Error("本地动作效果类型不符。");if(action.type==="claim"&&(effect.tier!==action.tier||effect.claimKey!==p.pages[action.index].tiers[action.tier-1].claimKey))throw new Error("任务领取档位不符。");if(action.type==="exchange"&&(effect.catalogId!==p.exchange.rows[action.index].catalogId||effect.count!==1||effect.cost!==p.exchange.rows[action.index].unitPoints||effect.points!==p.points))throw new Error("单份兑换结算不符。");if(!(effect.rewards is Array)||effect.rewards.length<1)throw new Error("缺少真实材料奖励。");for each(var r:Object in effect.rewards)validateReward(r);}
   projection=p;lastRevision=value.revision;pending=false;pendingId="";pendingAction=null;message=value.message?String(value.message):"已同步本地三页任务及七行积分兑换。";
   if(!main&&!action&&wantedOpen)constructWindow();if(main){if(action)clearConfirm();renderStatic();}lock();report();return statusNative();
  }
  public function rejectRequest(envelope:Object):Object {role();if(phase==="failed"||!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)return statusNative();if(pendingAction&&String(envelope.requestId)!==pendingId)return statusNative();if(envelope.definitive===true){pending=false;pendingAction=null;pendingId="";if(main)renderStatic();}say(String(envelope.message||"请求结果未知，请从页面重试原请求。"));return statusNative();}
  private function syncModel():void {if(!projection)return;var c:Object=controller(),m:Object=c.model,T:Object=cls("chargeActivity.vo.ChargeActivityTaskCnfVo"),E:Object=cls("chargeActivity.vo.ChargeActivityExchangeVO"),parts:Array=String(projection.day).split("-");
   m.dailyChargeNum=projection.todayClaimedTaskPoints;m.totalChargeNum=projection.taskEarned;m.totalXFMoney=projection.grossSpent;m.isOpen=true;m.state=1;m.beginTime=new Date(Date.UTC(int(parts[0]),int(parts[1])-1,int(parts[2])));m.endTime=new Date(m.beginTime.time+86400000);m.taskCnfDic=new Dictionary();m.taskTypeArrDic=new Dictionary();
   var claimed:Array=[];for each(var page:Object in projection.pages){var grouped:Object={},marks:Array=[];for each(var t:Object in page.tiers){var rewards:Array=[];if(t.claimed)marks.push(String(t.target));for each(var r:Object in t.rewards)if(r!==null){var v:Object=new T();v.ActivityType=0;v.Quality=t.target;v.Rate=page.originalRate;v.TemplateID=r.templateId;v.Count=r.count;v.IsBind=true;v.ValidDate=0;v.StrengthLevel=0;v.Probability=0;rewards.push(v);}grouped[t.target]=rewards;}m.taskCnfDic[page.originalRate]=grouped;claimed.push(marks.join(","));}
   m.dailyChargeAward=claimed[0];m.totalChargeAward=claimed[1];m.totalXFAward=claimed[2];c._exchangeData=[];c.exchangeInfoArr=new Dictionary();
   for each(var row:Object in projection.exchange.rows){var e:Object=new E();e.ID=row.index+1;e.TemplateID1=e.Count1=e.TemplateID2=e.Count2=0;e.GiveTemplateID=row.reward.templateId;e.GiveItemCount=row.reward.count;e.GiveIsBind=true;e.GiveVilidDate=0;e.ChangeCount=row.limit;c._exchangeData.push(e);c.exchangeInfoArr[e.ID]=row.bought;}
  }
  private function constructWindow():void {role();windowSerial++;syncModel();sceneRoot=new Sprite();var stage:Object=cls("com.pickgliss.toplevel.StageReferance").stage;sceneRoot.graphics.beginFill(0x000000,0.65);sceneRoot.graphics.drawRect(0,0,stage.stageWidth,stage.stageHeight);sceneRoot.graphics.endFill();windowRoot=new Sprite();sceneRoot.addChild(windowRoot);var C:Object=cls("chargeActivity.view.ChargeActivityMainView");main=new C();windowRoot.addChild(main as DisplayObject);notice=text(60,508,670,45,"",0xffedbb);windowRoot.addChild(notice);stage.addChild(sceneRoot);sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);renderStatic();fitWindow();lock();}
  private function initMain(o:Object):void {viewOwners[o]=true;o.closeBtn.clickHandler=handler(closeNative);o.enableEscKey=true;o.escKeyHandler=handler(closeNative);o.taskList.renderHandler=handler(function(cell:Object,index:int):void{renderTask(o,cell,index);});o.exchangeList.renderHandler=handler(function(cell:Object,index:int):void{renderExchange(o,cell,index);});o.selectGrop.selectHandler=handler(function(index:int):void{selectPage(o,index);});o.exchangeList.array=controller().exchangeData;
   var titles:Array=["每日任务","累计任务","接入后消费","积分兑换"];for(var i:int=0;i<4;i++){var tab:Object=o.selectGrop.getChildByName("item"+i),label:TextField=text(9,12,114,26,titles[i],0xffe8a8);label.background=true;label.backgroundColor=0x472b1a;tab.addChild(label);tab.disabled=false;}o.tipsImg.visible=false;o.selectGrop.selectedIndex=0;selectPage(o,0);
  }
  private function selectPage(o:Object,index:int):void {if(!viewOwners[o]||!wantedOpen||!projection||index<0||index>3)return;o.updateView();o.tipsImg.visible=false;o.timeLabel.text=index===0?"本地每日任务 · UTC "+projection.day:index===1?"累计任务积分 · 与旧积分礼包共用领取记录":index===2?"仅累计接入后的实际积分消费；不回填历史":"本地积分费用 + 累计任务资格 · 每日限次";}
  private function renderStatic():void {if(!main)return;syncModel();var selected:int=int(main.selectGrop.selectedIndex);main.exchangeList.array=controller().exchangeData;selectPage(main,selected);lock();}
  private function renderTask(o:Object,cell:Object,index:int):void {if(!viewOwners[o]||!wantedOpen||phase!=="ready"||!projection)return;cell.visible=index<o.taskList.array.length;if(!cell.visible){delete cellOwners[cell];return;}var pageIndex:int=int(o.selectGrop.selectedIndex);if(pageIndex<0||pageIndex>2)return;var t:Object=projection.pages[pageIndex].tiers[index];cell.setInfo(o.taskList.array[index],index);cellOwners[cell]={owner:o,kind:"task",index:pageIndex,tier:t.tier};cell.msgImg.visible=false;cell.desTxt.visible=true;cell.desTxt1.visible=false;cell.desTxt.font="Microsoft YaHei";cell.desTxt.size=13;cell.desTxt.width=490;cell.desTxt.text=t.title+" · 目标 "+t.target+" 本地积分";cell.numLabl.text=t.current+"/"+t.target;cell.getBtn.disabled=pending||confirmation!==null||!t.canClaim;}
  private function renderExchange(o:Object,cell:Object,index:int):void {if(!viewOwners[o]||!wantedOpen||phase!=="ready"||!projection)return;cell.visible=index<o.exchangeList.array.length;if(!cell.visible){delete cellOwners[cell];return;}var row:Object=projection.exchange.rows[index];cell.setInfo(o.exchangeList.array[index],index);cellOwners[cell]={owner:o,kind:"exchange",index:index};cell.rewardList.visible=false;cell.desClip.visible=false;var label:TextField=captions[cell] as TextField;if(!label){label=text(44,10,250,94,"",0xffe8c0);cell.addChild(label);captions[cell]=label;}label.text=row.name+"\n费用："+row.unitPoints+" 活动积分\n资格：累计任务 "+row.qualification.current+"/"+row.qualification.target+"\n"+row.reason;cell.numLabl.text=row.bought+"/"+row.limit;cell.getBtn.disabled=pending||confirmation!==null||!row.canExchange;}
  private function ownedCell(o:Object,kind:String):Object {var record:Object=cellOwners[o];if(!main||!record||record.owner!==main||record.kind!==kind||!wantedOpen||!main.contains(o as DisplayObject)||pending||confirmation)return null;return record;}
  private function claim(o:Object):void {var r:Object=ownedCell(o,"task");if(!r)return;claimTier(r.index,r.tier);}
  private function claimTier(index:int,tier:int):void {if(!main||pending||confirmation||index<0||index>2||tier<1||tier>3)return;var t:Object=projection.pages[index].tiers[tier-1];if(!t.canClaim){say(t.reason);return;}confirm(t.title+"："+t.reason+"。材料永久绑定并寄邮件。"+(index===1?"本页与旧积分礼包共用一次领取记录。":""),{type:"claim",index:index,tier:tier,choice:projection.stateToken});}
  private function exchange(o:Object):void {var r:Object=ownedCell(o,"exchange");if(!r)return;var row:Object=projection.exchange.rows[r.index];if(!row.canExchange){say(row.reason);return;}confirm("兑换「"+row.name+"」一份，消耗 "+row.unitPoints+" 活动积分；累计任务资格只检查、不扣除。今日剩余 "+row.remaining+" 次。永久绑定材料寄邮件。",{type:"exchange",index:r.index,count:1,choice:projection.stateToken});}
  private function confirm(detail:String,action:Object):void {if(!main||pending||confirmation)return;role();var c:Object=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("SimpleAlert"),I:Object=cls("com.pickgliss.ui.vo.AlertInfo");confirmation=c;c.info=new I("本地任务确认","确认","取消",true,true,detail,false,false,false,true);windowRoot.addChild(c as DisplayObject);var rect:Rectangle=c.getBounds(c);c.x=397-rect.x-rect.width/2;c.y=280-rect.y-rect.height/2;var serial:int=windowSerial;bind(c,c,"response",function(e:Object):void{if(confirmation!==c||serial!==windowSerial||!wantedOpen||phase!=="ready")return;var yes:Boolean=e.responseCode===2||e.responseCode===3;clearConfirm();if(yes)request(action);else lock();});lock();fitWindow();}
  private function clearConfirm():void {if(confirmation){var o:Object=confirmation;confirmation=null;unbind(o);o.dispose();if(o.parent)o.parent.removeChild(o);}}
  private function handler(fn:Function,args:Array=null):Object {var C:Object=cls("morn.core.handlers.Handler");return new C(fn,args);}
  private function text(x:Number,y:Number,w:Number,h:Number,label:String,color:uint):TextField {var t:TextField=new TextField();t.defaultTextFormat=new TextFormat("Microsoft YaHei",12,color);t.x=x;t.y=y;t.width=w;t.height=h;t.text=label;t.multiline=true;t.wordWrap=true;t.selectable=false;t.mouseEnabled=false;return t;}
  private function fitWindow():void {if(!windowRoot)return;var stage:Object=cls("com.pickgliss.toplevel.StageReferance").stage,r:Rectangle=windowRoot.getBounds(windowRoot),s:Number=Math.min(1,(stage.stageWidth-20)/r.width,(stage.stageHeight-20)/r.height);windowRoot.scaleX=windowRoot.scaleY=s;windowRoot.x=(stage.stageWidth-r.width*s)/2-r.x*s;windowRoot.y=(stage.stageHeight-r.height*s)/2-r.y*s;}
  private function lock():void {if(notice)notice.text=message;if(!main||!projection)return;var busy:Boolean=pending||confirmation!==null;main.selectGrop.mouseEnabled=main.selectGrop.mouseChildren=!busy;for each(var cell:Object in main.taskList.cells){var r:Object=cellOwners[cell];if(r&&r.owner===main&&r.kind==="task")cell.getBtn.disabled=busy||!projection.pages[r.index].tiers[r.tier-1].canClaim;}for each(cell in main.exchangeList.cells){r=cellOwners[cell];if(r&&r.owner===main&&r.kind==="exchange")cell.getBtn.disabled=busy||!projection.exchange.rows[r.index].canExchange;}}
  private function bind(owner:Object,target:Object,type:String,fn:Function):void {if(!bindings[owner])bindings[owner]=[];target.addEventListener(type,fn);bindings[owner].push([target,type,fn]);}
  private function unbind(owner:Object):void {if(!bindings[owner])return;for each(var row:Array in bindings[owner])row[0].removeEventListener(row[1],row[2]);delete bindings[owner];}
  private function stopBubble(e:Event):void{e.stopPropagation();}
  private function onKey(e:KeyboardEvent):void{if(e.keyCode===27){e.stopPropagation();closeNative();}}
  private function tick(e:Event):void{try{role();}catch(error:Error){fail(error.message);}}
  public function closeNative():Object {wantedOpen=false;windowSerial++;try{clearConfirm();if(main){var o:Object=main;main=null;delete viewOwners[o];o.taskList.renderHandler=o.exchangeList.renderHandler=null;o.selectGrop.selectHandler=null;o.closeBtn.clickHandler=o.escKeyHandler=null;o.dispose();}}finally{cellOwners=new Dictionary(true);captions=new Dictionary(true);if(sceneRoot){sceneRoot.removeEventListener(Event.ENTER_FRAME,tick);sceneRoot.removeEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.removeEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.removeEventListener(MouseEvent.MOUSE_DOWN,stopBubble);if(sceneRoot.parent)sceneRoot.parent.removeChild(sceneRoot);sceneRoot=null;}windowRoot=null;notice=null;report();}return statusNative();}
  public function abortNative(reason:String):void {closeNative();fail(reason);}
  private function fail(reason:String):void {if(phase==="failed")return;phase="failed";message=reason;if(sceneRoot)closeNative();report();}
  private function say(reason:String):void {message=reason;lock();report();}
  private function report():void {if(ExternalInterface.available)try{ExternalInterface.call("workshopChargeReport",statusNative());}catch(error:Error){}}
  public function statusNative():Object {return {phase:phase,characterId:expectedId,generation:generation,sequence:sequence,revision:lastRevision,open:sceneRoot!==null,pending:pending,requestId:pendingId,animating:false,message:message,experimental:true};}
  public static function fillByID(id:int):Object {if(!active||[11019,11001,11021,11002].indexOf(id)<0)throw new Error("不支持的本地材料模板。");var C:Object=active.cls("ddt.data.goods.InventoryItemInfo"),v:Object=new C(),template:Object=active.cls("ddt.manager.ItemManager").Instance.getTemplateById(id);if(!template)throw new Error("本地材料模板缺失。");active.cls("com.pickgliss.utils.ObjectUtils").copyProperties(v,template);v.Count=1;v.ValidDate=0;v.IsBinds=true;v.StrengthenLevel=0;return v;}
  public static function fillNoBindInfoByID(id:int):Object {return fillByID(id);}
  public static function dateFormat6(date:Date):String {if(!date||isNaN(date.time))throw new Error("本地活动日期无效。");return date.fullYearUTC+"-"+(date.monthUTC+1)+"-"+date.dateUTC;}
  public static function GetTranslation(key:String,...args):String {if(key==="ddt.chargeActivity.timeTxt")return "本地任务活动 · UTC日 "+(active&&active.projection?active.projection.day:args[0]);if(key==="ddt.chargeActivity.tip4")return "接入后实际消费达到 "+args[0]+" 活动积分";return active.cls("ddt.manager.LanguageMgr").GetTranslation.apply(null,[key].concat(args));}
  public static function dispatch(owner:String,name:String,o:Object,args:Array):* {if(!active)throw new Error("原任务赠送桥未初始化。");return active.handle(owner,name,o,args);}
  private function handle(owner:String,name:String,o:Object,args:Array):* {
   if(owner==="chargeActivity/ChargeActivityController"){if(name==="setup"){syncModel();return null;}if(name==="onOpenView"||name==="showFrame")return openNative();if(name==="getDailyChargeTaskReward"||name==="getTotalChargeTaskReward"){var page:int=name==="getDailyChargeTaskReward"?0:(args.length>1&&args[1]===2?2:1);if(projection)for each(var t:Object in projection.pages[page].tiers)if(t.target===args[0]){claimTier(page,t.tier);return null;}throw new Error("本地任务档位不存在。");}throw new Error("原充值 Socket、配置加载及付款确认通道已停止："+name);}
   if(owner==="chargeActivity/view/ChargeActivityMainView"){if(name==="initialize"){initMain(o);return null;}if(name==="__onSelectChange"){selectPage(o,int(args[0]));return null;}if(name==="__taskListRender"){renderTask(o,args[0],int(args[1]));return null;}if(name==="__exchangeListRender"){renderExchange(o,args[0],int(args[1]));return null;}if(name==="__onClickClose"){closeNative();return null;}}
   if(owner==="chargeActivity/view/cell/ChargeActivityTaskCell"&&name==="__onClickGetBtn"){claim(o);return null;}
   if(owner==="chargeActivity/view/cell/ChargeActivityExchangeCell"&&name==="__exchangeHandler"){exchange(o);return null;}
   throw new Error("未实现的原任务赠送适配："+owner+"."+name);
  }
 }
}
