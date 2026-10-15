package {
 import flash.display.Sprite;
 import flash.display.Loader;
 import flash.display.DisplayObject;
 import flash.display.MovieClip;
 import flash.events.Event;
 import flash.events.MouseEvent;
 import flash.events.KeyboardEvent;
 import flash.events.TimerEvent;
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
 import flash.utils.Timer;
 /** Original window and real frame/Tween completion; HTTP and UUIDs belong to the page. */
 public final class WorkshopNativeTreasureBootstrap extends Sprite {
  private static var active:WorkshopNativeTreasureBootstrap;
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
  private var popup:Object;
  private var confirmation:Object;
  private var notice:TextField;
  private var recordsBox:Object;
  private var categoryCells:Array=[];
  private var categoryLabels:Array=[];
  private var previewRows:Dictionary=new Dictionary(true);
  private var localButtons:Array=[];
  private var rewardQueue:Array=[];
  private var message:String="尚未读取本地迷宫寻宝。";
  private var loaders:Array=[];
  private var bindings:Dictionary=new Dictionary(true);
  public function WorkshopNativeTreasureBootstrap(){super();}
  private function cls(name:String):Object {if(!domain.hasDefinition(name))throw new Error("缺少原类："+name);return domain.getDefinition(name);}
  private function manager():Object{return cls("treasureHunting.TreasureManager").instance;}
  private function control():Object{return cls("treasureHunting.TreasureControl").instance;}
  private function role():void {
   var c:LoaderContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(!c||(hostContext&&c!==hostContext)||!c.applicationDomain.hasDefinition("WorkshopNativeTreasureBootstrap")||c.applicationDomain.getDefinition("WorkshopNativeTreasureBootstrap")!==WorkshopNativeTreasureBootstrap)throw new Error("迷宫寻宝共享加载域已改变。");
   if(hostContext)for each(var n:String in ["App","Config","morn.core.components.View"])if(!c.applicationDomain.hasDefinition(n)||c.applicationDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享组件身份已改变。");
   if(cls("ddt.manager.StateManager").currentStateType!=="main"||int(cls("ddt.manager.PlayerManager").Instance.Self.ID)!==expectedId)throw new Error("请返回原角色的大厅。");
  }
  public function startNative(options:Object):void {
   if(active||phase!=="new")throw new Error("迷宫寻宝不能重复初始化。");
   if(!options||int(options.expectedUserId)<=0||!options.generation||!options.baseUrl||options.sharedOwnerReady!==true)throw new Error("缺少真实角色、代次或共享 owner。");
   expectedId=int(options.expectedUserId);generation=String(options.generation);base=String(options.baseUrl);if(base.charAt(base.length-1)!=="/")throw new Error("资源路径缺少斜线。");
   role();hostContext=cls("com.pickgliss.loader.DisplayLoader").Context as LoaderContext;
   if(options.sharedContext!==hostContext||!(options.sharedDomain is ApplicationDomain))throw new Error("共享上下文不一致。");domain=hostContext.applicationDomain;
   for each(var n:String in ["App","Config","morn.core.components.View"])if(!options.sharedDomain.hasDefinition(n)||options.sharedDomain.getDefinition(n)!==domain.getDefinition(n))throw new Error("共享类不一致。");
   if(!ExternalInterface.available)throw new Error("当前页面没有本地寻宝桥接。");active=this;phase="loading";
   ExternalInterface.addCallback("workshopTreasureAcceptSnapshot",acceptSnapshot);ExternalInterface.addCallback("workshopTreasureRejectRequest",rejectRequest);
   ExternalInterface.addCallback("workshopTreasureOpenNative",openNative);ExternalInterface.addCallback("workshopTreasureCloseNative",closeNative);ExternalInterface.addCallback("workshopTreasureStatusNative",statusNative);
   loadSwf("treasure-original-library.swf",function():void{loadSwf("treasurehunting_v3_6_1_u1.swf",loadStyles);});
  }
  private function loadSwf(file:String,next:Function):void {
   if(phase==="failed")return;role();var loader:Loader=new Loader();loaders.push(loader);
   loader.contentLoaderInfo.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();next();}catch(error:Error){fail(error.message);}});
   loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("资源读取失败："+file);});loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("资源访问失败："+file);});
   loader.contentLoaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,function(e:UncaughtErrorEvent):void{fail(String(e.error));});
   var c:LoaderContext=new LoaderContext(false,domain);c.allowCodeImport=true;loader.load(new URLRequest(base+file),c);
  }
  private function loadStyles():void {
   var loader:URLLoader=new URLLoader();loaders.push(loader);loader.dataFormat=URLLoaderDataFormat.BINARY;
   loader.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("原寻宝样式读取失败。");});loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("原寻宝样式访问失败。");});
   loader.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();var b:ByteArray=loader.data as ByteArray;cls("com.pickgliss.ui.ComponentFactory").Instance.setup(new XML(b.readUTFBytes(b.length)));loadLayouts();}catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+"treasure-styles.xml"));
  }
  private function loadLayouts():void {
   var loader:URLLoader=new URLLoader();loaders.push(loader);loader.dataFormat=URLLoaderDataFormat.BINARY;
   loader.addEventListener(IOErrorEvent.IO_ERROR,function(e:Event):void{fail("原寻宝布局读取失败。");});loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:Event):void{fail("原寻宝布局访问失败。");});
   loader.addEventListener(Event.COMPLETE,function(e:Event):void{if(phase==="failed")return;try{role();var b:ByteArray=loader.data as ByteArray;b.uncompress();b.position=0;var layouts:Object=b.readObject();if(b.bytesAvailable)throw new Error("原布局含多余字节。");
    for each(var key:String in ["TreasureHuntingMain.xml","View/TreasureBagView.xml","View/TreasureRecordView.xml","View/TreasureAwardPreview.xml","Item/TreasureHuntAwardListItem.xml","Item/TreasureHuntAwardCell.xml"]){if(!(layouts[key] is XML))throw new Error("缺少原布局："+key);var xml:XML=layouts[key];
     for each(var node:XML in xml.descendants()){var kind:String=String(node.name());if(["Label","LabelEx","TextInput"].indexOf(kind)>=0)node.@font="Microsoft YaHei";if(kind==="Button"||kind==="TabButtonEx")node.@labelFont="Microsoft YaHei";}
     if(key==="TreasureHuntingMain.xml"){
      delete xml.TreasureRankView;delete xml.TreasureRecordView;
      for each(node in xml.descendants()){var field:String=String(node.attribute("var"));if(field==="exTreasureCb")node.@label="高级60积分";if(field==="lxTreasureCb")node.@label="本地5次批次";
       if(["exTicketImg1","exTicketImg2","ticketImg","exTicketMC"].indexOf(field)>=0)node.@visible=false;
       if(String(node.@text)==="我的积分：")node.@text="活动积分：";if(String(node.@text)==="我的护身符：")node.@text="本地费用：";
      }
     }
     if(key==="View/TreasureAwardPreview.xml")for each(node in xml.LabelEx){if(String(node.@text)==="迷宫类型")node.@text="本地材料";if(String(node.@text)==="几率获得")node.@text="本地奖池";}
     cls("morn.core.components.View").uiMap[key]=xml;
    }
    cls("App").stage=cls("com.pickgliss.toplevel.StageReferance").stage;cls("App").asset.setDomain(domain);phase="ready";message="原寻宝窗口已准备；打开只读取，不抽取。";report();
   }catch(error:Error){fail(error.message);}});loader.load(new URLRequest(base+"treasurehunting_v3_6_1_u1.ui"));
  }
  public function openNative():Object {role();if(phase!=="ready")return statusNative();if(pending&&pendingAction===null){wantedOpen=true;return statusNative();}if(pending||animating){say("已有操作或动画尚未完成。");return statusNative();}if(main)return statusNative();wantedOpen=true;read();return statusNative();}
  private function read():void {role();pending=true;pendingId="";pendingAction=null;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopTreasureRead",expectedId,generation,sequence);if(!r||r.accepted!==true){pending=false;throw new Error("页面未接受寻宝读取。");}}catch(error:Error){say(error.message);}}
  private function request(action:Object):void {role();if(pending||animating||!projection||!wantedOpen)return;if(cls("ddt.manager.PlayerManager").Instance.Self.bagLocked){say("请先解除背包锁定。");return;}
   pending=true;pendingId="";pendingAction=action;sequence++;lock();try{var r:Object=ExternalInterface.call("workshopTreasureRequest",expectedId,generation,sequence,action);if(!r||r.accepted!==true||!r.requestId){pending=false;pendingAction=null;throw new Error("页面未接受操作，未提交扣分请求。");}pendingId=String(r.requestId);}catch(error:Error){say(error.message);}report();
  }
  private function integer(v:*,lo:int,hi:int):Boolean{return typeof v==="number"&&isFinite(v)&&v===Math.floor(v)&&v>=lo&&v<=hi;}
  private function validate(p:Object):void {
   if(!p||p.version!==1||p.kind!=="treasure-native"||typeof p.started!=="boolean"||!integer(p.score,0,2147483647)||p.normalCost!==30||p.advancedCost!==60||p.bagCapacity!==30||!integer(p.bagSlotsUsed,0,30))throw new Error("无效的寻宝公开投影。");
   if(typeof p.day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(p.day)||typeof p.bagToken!=="string"||p.bagToken.length!==54||p.bagToken.indexOf(p.day+":")!==0||!p.localRules||p.localRules.version!==1||typeof p.localRules.description!=="string")throw new Error("寻宝日期、完整包令牌或规则无效。");
   for each(var n:String in ["draws","progressScore","fragments"])if(!integer(p[n],0,1000000000))throw new Error("寻宝计数无效。");if(!integer(p.pityRemaining,1,10))throw new Error("保底计数无效。");
   for each(n in ["canDraw","canTake","canRecycle"])if(typeof p[n]!=="boolean")throw new Error("寻宝动作门槛无效。");
   if(!(p.previewTemplateIds is Array)||p.previewTemplateIds.join(",")!=="11019,11001,11021,11002"||!(p.categories is Array)||p.categories.length!==4||!(p.drawChoices is Array)||p.drawChoices.length!==10)throw new Error("本地分类或批次数无效。");
   for(var i:int=0;i<4;i++){var c:Object=p.categories[i];if(!c||c.index!==i||c.sourceOriginalIndex!==i+1||c.templateId!==p.previewTemplateIds[i]||typeof c.name!=="string"||typeof c.selected!=="boolean")throw new Error("四材料分类映射无效。");}
   for(i=0;i<10;i++){c=p.drawChoices[i];if(!c||c.mode!==(i<5?"normal":"advanced")||c.count!==i%5+1||c.cost!==(i%5+1)*(i<5?30:60)||typeof c.canDraw!=="boolean")throw new Error("寻宝批次费用无效。");}
   if(p.canDraw!==p.drawChoices[0].canDraw||!(p.bag is Array)||p.bag.length!==p.bagSlotsUsed)throw new Error("临时包数量或单次抽取门槛无效。");for(i=0;i<p.bag.length;i++){c=p.bag[i];if(!c||c.index!==i||p.previewTemplateIds.indexOf(c.templateId)<0||(c.templateId===11021?[1,2,4]:[1,2]).indexOf(c.itemCount)<0||c.recycleUnitPoints!==2)throw new Error("临时包整格材料无效。");}
   if(!(p.records is Array)||p.records.length>20)throw new Error("本角色记录无效。");for each(var row:* in p.records)if(typeof row!=="string")throw new Error("记录文本无效。");
   c=p.exchange;if(!c||c.fragmentCost!==10||c.templateId!==11021||c.itemCount!==2||typeof c.canExchange!=="boolean"||!(p.progress is Array)||p.progress.length!==3)throw new Error("本地进度或碎片规则无效。");for(i=0;i<3;i++){c=p.progress[i];if(c.tier!==i+1||c.target!==(i+1)*10||c.templateId!==11019||c.itemCount!==(i+1)*2||typeof c.claimed!=="boolean"||typeof c.canClaim!=="boolean")throw new Error("本地进度奖励无效。");}
  }
  public function acceptSnapshot(envelope:Object):Object {try{return applySnapshot(envelope);}catch(error:Error){fail(error.message);throw error;}return statusNative();}
  private function applySnapshot(envelope:Object):Object {
   if(phase==="failed")throw new Error("原寻宝已失败，拒绝迟到响应。");role();if(!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)throw new Error("响应代次不符。");var value:Object=envelope.snapshot;
   if(!value||value.characterId!==expectedId||!integer(value.revision,0,2147483647)||value.revision<lastRevision)throw new Error("响应角色或版本不符。");if(pendingAction&&(!pendingId||String(envelope.requestId)!==pendingId))throw new Error("动作 UUID 不符。");validate(value.nativeTreasure);
   var action:Object=pendingAction,fresh:Boolean=Boolean(action&&!value.replayed&&value.nativeTreasureAction&&value.nativeTreasureAction.requestId===pendingId),result:Object=null;
   if(fresh){var effects:Array=value.nativeTreasureAction.effects as Array;if(!effects||effects.length!==1)throw new Error("动作缺少唯一确认效果。");result=effects[0];var type:String=action.type==="draw"?"drawn":action.type==="choose"?"chosen":action.type==="take"?"taken":action.type==="recycle"?"recycled":action.type==="exchange"?"exchanged":"progress-claimed";if(result.type!==type)throw new Error("寻宝效果类型不符。");
    if(type==="drawn"){if(result.mode!==action.mode||result.count!==action.count||result.cost!==action.count*(action.mode==="advanced"?60:30)||result.score!==value.nativeTreasure.score||result.draws!==value.nativeTreasure.draws||!(result.rewards is Array)||result.rewards.length!==action.count)throw new Error("抽取确认效果不符。");
     for(var ri:int=0;ri<result.rewards.length;ri++){var reward:Object=result.rewards[ri];var item:Object=value.nativeTreasure.bag[reward.index];if(reward.index!==value.nativeTreasure.bag.length-result.count+ri||!item||item.templateId!==reward.templateId||item.itemCount!==reward.itemCount||reward.sourceOriginalIndex!==value.nativeTreasure.previewTemplateIds.indexOf(reward.templateId)+1)throw new Error("抽取格与最终临时包不符。");}
    }else if(type==="chosen"){if(result.index!==action.index||result.selected!==action.marked||value.nativeTreasure.categories[action.index].selected!==action.marked)throw new Error("分类保存效果不符。");}
    else if(type==="taken"||type==="recycled"){if(!(result.items is Array)||!result.items.length)throw new Error("整格结算效果缺失。");if(action.index!==undefined&&(result.items.length!==1||result.items[0].index!==action.index))throw new Error("单格结算目标不符。");if(type==="recycled"&&result.score!==value.nativeTreasure.score)throw new Error("回收余额不符。");}
    else if(type==="exchanged"){if(result.fragmentsSpent!==10||result.fragments!==value.nativeTreasure.fragments||result.templateId!==11021||result.itemCount!==2)throw new Error("碎片兑换效果不符。");}
    else if(result.tier!==action.tier||result.templateId!==11019||result.itemCount!==action.tier*2)throw new Error("进度奖励效果不符。");
   }
   projection=value.nativeTreasure;lastRevision=value.revision;pending=false;pendingId="";pendingAction=null;
   if(!main&&!action&&wantedOpen)constructWindow();
   if(main&&wantedOpen&&fresh&&action.type==="draw"){animating=true;rewardQueue=result.rewards.concat();control().isMovieComplete=false;renderStatic();startNextReward();}else if(main)renderStatic();
   message=value.message?String(value.message):"已读取本地寻宝进度。";lock();report();return statusNative();
  }
  public function rejectRequest(envelope:Object):Object {role();if(phase==="failed"||!pending||!envelope||envelope.generation!==generation||envelope.sequence!==sequence)return statusNative();if(pendingAction&&String(envelope.requestId)!==pendingId)return statusNative();if(envelope.definitive===true){pending=false;pendingAction=null;pendingId="";if(main)renderStatic();}say(String(envelope.message||"请求结果未知，请从页面重试原请求。"));return statusNative();}
  private function syncModel():void {var m:Object=manager();m.isActivityOpen=true;m.startStr="本地常驻";m.endStr="四材料";m.needMoney=30;m.isLxTreasure=false;m._drawCount=10-projection.pityRemaining;m._pointCount=projection.score;m._normalTicketNum=30;m._exTicketNum=60;m._exSelectArr=[];for each(var c:Object in projection.categories)if(c.selected)m._exSelectArr.push(c.sourceOriginalIndex);}
  private function constructWindow():void {
   role();syncModel();control().isMovieComplete=true;sceneRoot=new Sprite();sceneRoot.graphics.beginFill(0x000000,0.65);sceneRoot.graphics.drawRect(0,0,1000,650);sceneRoot.graphics.endFill();var C:Object=cls("treasureHunting.views.TreasureHuntingFrame");main=new C();sceneRoot.addChild(main as DisplayObject);main.x=0;main.y=0;
   C=cls("treasureHunting.views.mornui.View.TreasureRecordViewUI");main.recordView=new C();main.recordView.x=679;main.recordView.y=145;main.addChild(main.recordView as DisplayObject);recordsBox=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("treasureHunting.recordVBox");main.recordView.recordPanel.addChild(recordsBox as DisplayObject);selectPanel(main,int(main.menuTab.selectedIndex));
   for(var i:int=0;i<15;i++){var slot:Object=main._itemArr[i];slot.itemIcon.visible=false;var label:TextField=text(1,65,88,26,i<4?projection.categories[i].name:"暂未提供",0xfff0bc);slot.addChild(label);categoryLabels.push(label);if(i<4){C=cls("bagAndInfo.cell.BagCell");var cell:Object=new C(i,fillByID(projection.previewTemplateIds[i]),false,null,false);cell.x=16;cell.y=10;cell.setContentSize(58,58);cell.mouseEnabled=false;cell.mouseChildren=false;slot.addChild(cell as DisplayObject);categoryCells.push(cell);}else{slot.mouseEnabled=slot.mouseChildren=false;slot.setGray(true);}}
   notice=text(45,590,585,54,"",0xffefbe);sceneRoot.addChild(notice);addLocalButton(683,575,128,"10碎片换材料",function():void{if(projection.exchange.canExchange)confirm("10本地碎片兑换强化石2级×2，成功后发往邮件。",{type:"exchange",choice:projection.bagToken});});
   for(i=0;i<3;i++)addProgressButton(i);
   cls("com.pickgliss.toplevel.StageReferance").stage.addChild(sceneRoot);sceneRoot.addEventListener(Event.ENTER_FRAME,tick);sceneRoot.addEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.addEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.addEventListener(MouseEvent.MOUSE_DOWN,stopBubble);renderStatic();lock();
  }
  private function addLocalButton(x:Number,y:Number,w:Number,label:String,fn:Function):void {var t:TextField=text(x,y,w,25,label,0xffe2a2);t.background=true;t.backgroundColor=0x6b411e;t.mouseEnabled=true;t.border=true;t.borderColor=0xb18845;sceneRoot.addChild(t);localButtons.push(t);bind(t,t,MouseEvent.CLICK,function(e:Event):void{e.stopPropagation();if(!pending&&!animating&&!confirmation&&!popup)fn();});}
  private function addProgressButton(index:int):void {addLocalButton(683+index*88,607,84,(index+1)*10+"进度奖",function():void{var p:Object=projection.progress[index];if(p.canClaim)confirm("领取本地进度奖励：强化石1级×"+p.itemCount+"，成功后发往邮件。",{type:"progress",tier:p.tier,choice:projection.bagToken});else say(p.claimed?"该进度奖已领取。":"本地进度尚未达到条件。");});}
  private function renderStatic():void {if(!main)return;syncModel();main.totalScore=projection.score;main.scoretTxt.text=String(projection.score);main.normalTicketLab.text="普通30";main.exTicketLab.text="高级60";main.progressImg.scaleX=(10-projection.pityRemaining)/10;main._gameTime.text="迷宫寻宝 · 本地常驻 · 四种材料";
   for(var i:int=0;i<15;i++){var slot:Object=main._itemArr[i];if(i<4){slot.setGray(!projection.categories[i].selected);slot.selectedLight.visible=projection.categories[i].selected;categoryLabels[i].text=projection.categories[i].name;}else slot.selectedLight.visible=false;}
   var changes:Dictionary=new Dictionary();for(i=0;i<30;i++)changes[String(i)]=true;main.bagView.updateData(changes);renderRecords();lock();
  }
  private function renderRecords():void {if(!recordsBox)return;recordsBox.disposeAllChildren();for each(var row:String in projection.records)recordsBox.addChild(text(0,0,235,48,row,0xffe0b6));main.recordView.recordPanel.scrollTo(0,0);}
  private function renderBag(view:Object):void {if(!projection||!view._baglist)return;for(var i:int=0;i<30;i++){var info:Object=null;if(i<projection.bag.length){info=fillByID(projection.bag[i].templateId);info.Count=projection.bag[i].itemCount;info.Place=i;info.BagType=5;info.IsBinds=true;}view._baglist.setCellInfo(i,info);}}
  private function initBag(view:Object):void {var C:Object=cls("treasureHunting.views.TreasureBagListView");view._baglist=new C(0,4,30);view._baglist.vSpace=4;view._baglist.hSpace=1;view._baglist.x=5;view.scrollPanel.addChild(view._baglist as DisplayObject);view.scrollPanel.scrollTo(0,0);view.initEvent();renderBag(view);}
  private function initFrame(view:Object):void {control().setFrame(view);view._glintTimer=new Timer(300,10);bind(view,view._glintTimer,TimerEvent.TIMER,view.onTimer);bind(view,view._glintTimer,TimerEvent.TIMER_COMPLETE,function(e:TimerEvent):void{if(!main||view!==main||!animating||!wantedOpen)return;view.onTimerComplete(e);var movie:MovieClip=view._glint as MovieClip;if(!movie)throw new Error("原闪光电影缺失。");movie.removeEventListener(Event.ENTER_FRAME,view.onEnterFrame);
    bind(movie,movie,Event.ENTER_FRAME,function(frameEvent:Event):void{if(main!==view||view._glint!==movie||!animating||!wantedOpen){unbind(movie);return;}view.onEnterFrame(frameEvent);if(view._glint!==movie)unbind(movie);lock();});
    // Original frame56 loops to15; stop this instance on its actual last frame so the original ENTER_FRAME test can finish.
    movie.addFrameScript(55,function():void{movie.stop();});lock();
   });view._rankTimer=null;view._timeLineArr=[];view.isHunting=false;view.exHuntBg.visible=false;view.normalHuntBg.visible=true;}
  private function initFrameEvents(view:Object):void {view.closeBtn.clickHandler=handler(closeNative);view.huntBtn.clickHandler=handler(function():void{draw(view,false);});view.exchangeBtn.clickHandler=handler(function():void{draw(view,true);});view.showPrizeBtn.clickHandler=handler(openPreview);view.buyCardBoxBtn.disabled=true;view.buyCardBoxBtn.toolTip="原付费购券尚未移植";
   view.menuTab.selectHandler=handler(function(index:int):void{selectPanel(view,index);});var button:Object=view.menuTab.getChildByName("item0");if(button){button.disabled=true;button.toolTip="原本服排行待移植";}button=view.menuTab.getChildByName("item1");if(button){button.disabled=true;button.toolTip="原跨服排行待移植";}view.menuTab.selectedIndex=2;
   bind(view,view.exTreasureCb,"select",function(e:Event):void{manager().isExTreasure=view.exTreasureCb.selected;view.exHuntBg.visible=view.exTreasureCb.selected;view.normalHuntBg.visible=!view.exTreasureCb.selected;});
   bind(view,view.lxTreasureCb,"select",function(e:Event):void{manager().isLxTreasure=false;});
  }
  private function selectPanel(view:Object,index:int):void {if(view.bagView)view.bagView.visible=index!==3;if(view.recordView)view.recordView.visible=index===3;if(view.myScoreBox)view.myScoreBox.visible=true;if(index===0||index===1){say("原全服／跨服排行待移植，未读取参考服账号。");view.menuTab.selectedIndex=2;}}
  private function draw(view:Object,byPoints:Boolean):void {if(view!==main||pending||animating||confirmation||popup)return;var mode:String=byPoints?"normal":view.exTreasureCb.selected?"advanced":"normal",count:int=view.lxTreasureCb.selected?5:1;var c:Object=projection.drawChoices[(mode==="advanced"?5:0)+count-1];if(!c.canDraw){say(mode==="advanced"?"高级需要四种本地分类全选、足够积分与包空间。":"积分、包空间或本地抽取条件不足。");return;}confirm("本地"+(mode==="advanced"?"高级":"普通")+"寻宝"+count+"次，合计"+c.cost+"活动积分。一次提交并结算；关闭只停止动画，不追加抽取。",{type:"draw",mode:mode,count:count,choice:projection.bagToken});}
  private function choose(slot:Object):void {if(!main||pending||animating||confirmation||popup)return;var index:int=int(slot._index)-1;if(index<0||index>=4){say("本地仅提供前四种普通材料分类。");return;}request({type:"choose",index:index,marked:!projection.categories[index].selected,choice:projection.bagToken});}
  private function take(index:int=-1):void {if(!main||pending||animating||confirmation||popup||!projection.canTake)return;var action:Object={type:"take",choice:projection.bagToken};var detail:String="将临时包全部材料寄入永久绑定邮件。";if(index>=0){if(index>=projection.bag.length)return;action.index=index;detail="将第"+(index+1)+"格全部"+projection.bag[index].itemCount+"单位材料寄入邮件，保留其它格。";}confirm(detail,action);}
  private function recycle():void {if(!main||pending||animating||confirmation||popup||!projection.canRecycle)return;var count:int=0;for each(var row:Object in projection.bag)count+=row.itemCount;confirm("回收临时包全部材料，每单位2本地积分，共"+(count*2)+"积分。",{type:"recycle",choice:projection.bagToken});}
  private function startNextReward():void {if(!main||!wantedOpen||!animating)return;if(!rewardQueue.length){animating=false;control().isMovieComplete=true;main.isHunting=false;var E:Object=cls("treasureHunting.event.TreasureEvent");control().dispatchEvent(new E("movieComplete"));renderStatic();lock();report();return;}
   var reward:Object=rewardQueue.shift();control().lightIndexArr=[reward.sourceOriginalIndex-1];control().msgStr="";control().countMsg="";control().isMovieComplete=false;main.isHunting=true;if(main.moveCell){main.moveCell.dispose();main.moveCell=null;}main.creatMoveCell(reward.templateId);main.moveCell.info.Count=reward.itemCount;main.startTimer();lock();
  }
  private function frameComplete(view:Object,aux:Boolean):void {if(!main||view!==main||!wantedOpen||!animating)return;if(aux)return;for each(var timeline:Object in view._timeLineArr){if(timeline){timeline.vars.onComplete=null;timeline.vars.onCompleteParams=null;}}view._timeLineArr=[];startNextReward();}
  private function cycleLight(view:Object):void {if(main!==view||!wantedOpen||!animating)return;view.removeAllItemLight();var index:int=int(view._glintTimer.currentCount)%4;view._itemArr[index].selectedLight.visible=true;}
  private function openPreview():void {if(!main||pending||animating||confirmation||popup)return;var C:Object=cls("treasureHunting.views.TreasureAwardPreview");popup=new C();popup.x=191;popup.y=60;sceneRoot.addChild(popup as DisplayObject);lock();}
  private function closePopup():void {clearPreviewCategories();if(popup){var view:Object=popup;popup=null;unbind(view);view.dispose();}lock();}
  private function clearPreviewCategory(o:Object):void {var row:Object=previewRows[o];if(!row)return;delete previewRows[o];if(row.cell){if(row.cell.parent)row.cell.parent.removeChild(row.cell);row.cell.dispose();}if(row.label&&row.label.parent)row.label.parent.removeChild(row.label);}
  private function clearPreviewCategories():void {var owners:Array=[];for(var o:Object in previewRows)owners.push(o);for each(o in owners)clearPreviewCategory(o);}
  private function renderPreviewCategory(o:Object,index:int,items:Array):void {
   clearPreviewCategory(o);o.typeIcon.skin=null;o.typeIcon.visible=false;
   var valid:Boolean=projection&&index>=0&&index<projection.categories.length&&index<projection.previewTemplateIds.length;
   o.itemList.array=valid?items:[];if(!valid)return;
   var C:Object=cls("bagAndInfo.cell.BagCell"),cell:Object=new C(index,fillByID(projection.previewTemplateIds[index]),false,null,false);
   var label:TextField=text(8,77,134,28,projection.categories[index].name,0xfff0bc);
   cell.x=50;cell.y=10;cell.setContentSize(58,58);cell.mouseEnabled=false;cell.mouseChildren=false;
   previewRows[o]={cell:cell,label:label};o.addChild(cell as DisplayObject);o.addChild(label);
  }
  private function preview():Array {var rows:Array=[];for each(var id:int in projection.previewTemplateIds)rows.push([{template:id,count:1}]);return rows;}
  private function confirm(detail:String,action:Object):void {if(!main||pending||animating||confirmation||popup)return;role();var c:Object=cls("com.pickgliss.ui.ComponentFactory").Instance.creatComponentByStylename("SimpleAlert"),I:Object=cls("com.pickgliss.ui.vo.AlertInfo");confirmation=c;c.info=new I("本地寻宝确认","确认","取消",true,true,detail+"\n原券、点券与付款通道未接入。",false,false,false,true);c.x=295;c.y=170;sceneRoot.addChild(c as DisplayObject);bind(c,c,"response",function(e:Object):void{var yes:Boolean=e.responseCode===2||e.responseCode===3;clearConfirm();if(yes)request(action);else lock();});lock();}
  private function clearConfirm():void {if(confirmation){var c:Object=confirmation;confirmation=null;unbind(c);c.dispose();}}
  private function handler(fn:Function,args:Array=null):Object {var C:Object=cls("morn.core.handlers.Handler");return new C(fn,args);}
  private function text(x:Number,y:Number,w:Number,h:Number,label:String,color:uint):TextField {var t:TextField=new TextField();t.defaultTextFormat=new TextFormat("Microsoft YaHei",12,color);t.x=x;t.y=y;t.width=w;t.height=h;t.text=label;t.multiline=true;t.wordWrap=true;t.selectable=false;t.mouseEnabled=false;return t;}
  private function lock():void {if(notice&&projection)notice.text=message+"\n本地普通30／高级60积分；五次批次仅一次结算。第"+projection.pityRemaining+"抽保底，可越过所选分类。临时包"+projection.bagSlotsUsed+"／30。";
   if(main){var busy:Boolean=pending||animating||confirmation!==null||popup!==null;main.huntBtn.disabled=busy;main.exTreasureCb.disabled=busy;main.lxTreasureCb.disabled=busy;main.exchangeBtn.disabled=busy;main.showPrizeBtn.disabled=busy;main.bagView.mouseEnabled=main.bagView.mouseChildren=!busy;for each(var slot:Object in main._itemArr)if(int(slot._index)<=4)slot.mouseEnabled=slot.mouseChildren=!busy;for each(var t:TextField in localButtons)t.mouseEnabled=!busy;}}
  private function bind(owner:Object,target:Object,type:String,fn:Function):void {if(!bindings[owner])bindings[owner]=[];target.addEventListener(type,fn);bindings[owner].push([target,type,fn]);}
  private function unbind(owner:Object):void {if(!bindings[owner])return;for each(var row:Array in bindings[owner])row[0].removeEventListener(row[1],row[2]);delete bindings[owner];}
  private function stopBubble(e:Event):void{e.stopPropagation();}
  private function onKey(e:KeyboardEvent):void{if(e.keyCode===27){e.stopPropagation();closeNative();}}
  private function tick(e:Event):void{try{role();}catch(error:Error){fail(error.message);}}
  public function closeNative():Object {wantedOpen=false;animating=false;rewardQueue=[];clearConfirm();closePopup();if(main){var view:Object=main;main=null;unbind(view);if(view._glintTimer)view._glintTimer.stop();if(view._rankTimer)view._rankTimer.stop();if(view._glint){unbind(view._glint);view._glint.stop();view._glint.addFrameScript(55,null);view._glint.removeEventListener(Event.ENTER_FRAME,view.onEnterFrame);}for each(var timeline:Object in view._timeLineArr){if(timeline){var args:Array=timeline.vars.onCompleteParams as Array;timeline.vars.onComplete=null;timeline.vars.onCompleteParams=null;timeline.kill();timeline.clear();if(args){if(args[1])try{args[1].destroy();}catch(proxyError:Error){}if(args[2]){if(args[2].parent)args[2].parent.removeChild(args[2]);if(args[2].bitmapData)try{args[2].bitmapData.dispose();}catch(bitmapError:Error){}}}}}
    if(view.bagView)view.bagView.removeEvents();if(recordsBox){recordsBox.disposeAllChildren();recordsBox=null;}for each(var cell:Object in categoryCells)if(cell)cell.dispose();categoryCells=[];categoryLabels=[];for each(var t:TextField in localButtons)unbind(t);localButtons=[];view.dispose();}
   if(domain.hasDefinition("treasureHunting.TreasureControl"))control().isMovieComplete=true;if(sceneRoot){sceneRoot.removeEventListener(Event.ENTER_FRAME,tick);sceneRoot.removeEventListener(KeyboardEvent.KEY_DOWN,onKey);sceneRoot.removeEventListener(MouseEvent.CLICK,stopBubble);sceneRoot.removeEventListener(MouseEvent.MOUSE_DOWN,stopBubble);if(sceneRoot.parent)sceneRoot.parent.removeChild(sceneRoot);sceneRoot=null;}notice=null;report();return statusNative();}
  public function abortNative(reason:String):void {closeNative();fail(reason);}
  private function fail(reason:String):void {if(phase==="failed")return;phase="failed";message=reason;if(sceneRoot)closeNative();report();}
  private function say(reason:String):void {message=reason;lock();report();}
  private function report():void {if(ExternalInterface.available)try{ExternalInterface.call("workshopTreasureReport",statusNative());}catch(error:Error){}}
  public function statusNative():Object {return {phase:phase,characterId:expectedId,generation:generation,sequence:sequence,revision:lastRevision,open:sceneRoot!==null,pending:pending,requestId:pendingId,animating:animating,message:message,experimental:true};}
  public static function fillByID(id:int):Object {var C:Object=active.cls("ddt.data.goods.InventoryItemInfo"),info:Object=new C();info.TemplateID=id;return active.cls("ddt.manager.ItemManager").fill(info);}
  public static function GetTranslation(key:String,...args):String {if(key==="tank.calendar.GoodsExchangeView.actTimeText")return "";return active.cls("ddt.manager.LanguageMgr").GetTranslation.apply(null,[key].concat(args));}
  public static function dispatch(owner:String,name:String,o:Object,args:Array):* {if(!active)throw new Error("原寻宝桥未初始化。");return active.handle(owner,name,o,args);}
  private function handle(owner:String,name:String,o:Object,args:Array):* {
   if(owner==="treasureHunting/TreasureControl"){
    if(["onOpenView","addTreasureFrame","loadComplete","loadTreasureHuntingModule"].indexOf(name)>=0)return openNative();if(name==="checkBag")return projection&&projection.bag.length>0;if(name==="openShowPrize"||name==="lookTrophy"){openPreview();return null;}
    if(["addMask","__onRemoveMask","removeMask","removeEvent","dispose","setup"].indexOf(name)>=0){if(name==="dispose"||name==="removeMask")o.isMovieComplete=!animating;return null;}
   }
   if(owner==="treasureHunting/TreasureManager"){if(name==="getAwardPreviewInfo")return preview();if(name==="start")return openNative();if(name==="setup")return null;}
   if(owner==="treasureHunting/items/TreasureItem"&&name==="__onClickItem"){choose(o);return null;}
   if(owner==="treasureHunting/views/TreasureHuntingFrame"){
    if(name==="initData"){initFrame(o);return null;}if(name==="initEvent"){initFrameEvents(o);return null;}if(name==="removeEvents"){unbind(o);return null;}if(name==="updateView"){selectPanel(o,int(args[0]));return null;}if(name==="checkInActTime"||name==="checkTicketEnough")return true;
    if(name==="__clickCloseHandler"){closeNative();return null;}if(name==="onHuntingBtnClick"){draw(o,false);return null;}if(name==="onExchangeBtnClick"){draw(o,true);return null;}if(name==="onTimer"){cycleLight(o);return null;}if(name==="movieComplete"){frameComplete(o,Boolean(args[0]));return null;}
    if(name==="updateHuntTimesTxt"||name==="__onUpdateHuntInfo"){if(main)renderStatic();return null;}if(name==="__onExTreasureCbClick"||name==="__onLxTreasureCbClick"){manager().isLxTreasure=false;return null;}
    if(name==="checkDoNext")return null;
   }
   if(owner==="treasureHunting/views/TreasureBagView"){
    if(name==="initialize"){initBag(o);return null;}if(name==="initData")return null;if(name==="updateBagFrame"){renderBag(o);return null;}if(name==="onItemClick"){take(int(args[0].data.place));return null;}if(name==="onGetAllBtnClick"){take();return null;}if(name==="onConvertBtnClick"){recycle();return null;}
   }
   if(owner==="treasureHunting/views/TreasureAwardPreview"){if(name==="show"){openPreview();return null;}if(name==="__onCloseBtn"){if(popup===o)closePopup();return null;}}
   if(owner==="treasureHunting/items/TreasureHuntAwardListCell"){if(name==="setInfo"){renderPreviewCategory(o,int(args[0]),args[1] as Array);return null;}if(name==="dispose"){clearPreviewCategory(o);return null;}}
   throw new Error("原寻宝未启用的网络／付款／排行分支："+owner+"."+name);
  }
 }
}
