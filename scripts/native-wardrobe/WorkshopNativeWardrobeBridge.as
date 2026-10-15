package {
 import flash.display.Loader;
 import flash.display.DisplayObject;
 import flash.display.Sprite;
 import flash.events.Event;
 import flash.events.IOErrorEvent;
 import flash.events.SecurityErrorEvent;
 import flash.events.UncaughtErrorEvent;
 import flash.events.TimerEvent;
 import flash.events.KeyboardEvent;
 import flash.events.MouseEvent;
 import flash.external.ExternalInterface;
 import flash.net.URLRequest;
 import flash.system.ApplicationDomain;
 import flash.system.LoaderContext;
 import flash.utils.Timer;
 import flash.text.TextField;
 import flash.text.TextFormat;
 /** Existing injection ABI; a single shared import for all activity modules. */
 public final class WorkshopNativeWardrobeBridge extends Sprite {
  private static var registered:Boolean=false;
  private static var expected:int=0;
  private static var actual:int=0;
  private static var domain:ApplicationDomain;
  private static var hostContext:LoaderContext;
  private static var root:String;
  private static var sharedPhase:String="idle";
  private static var sharedError:String="";
  private static var sharedLoader:Loader;
  private static var sharedTimer:Timer;
  private static var sharedImports:int=0;
  private static var activityMenu:Object;
  private static var menuMessage:String="";
  private static const MENU_ITEMS:Array=[
   ["mines","迷宫寻宝"],["ddplay","弹弹扫雷"],["gypsy","吉普赛商人"],["treasure","惊喜宝箱"],
   ["exchange","兑换活动"],["wardrobe","魔法衣橱"],["moonlight","月光宝盒"],["purr","弹弹乐"],
   ["charge","充值大赠送"],["pair","啵咕大转盘"],["carnival","节日狂欢"],["first-recharge","首充大礼"],
   ["forthright","至尊豪礼"],["devil","恶魔宝藏"],["christmas","快乐圣诞"],["caveloot","矿洞寻宝"]
  ];
  private static var wardrobe:Object=record("wardrobe");
  private static var pair:Object=record("pair");
  private static var mines:Object=record("mines");
  private static var ddplay:Object=record("ddplay");
  private static var gypsy:Object=record("gypsy");
  private static var moonlight:Object=record("moonlight");
  private static var treasure:Object=record("treasure");
  private static var purr:Object=record("purr");
  private static var carnival:Object=record("carnival");
  private static var firstRecharge:Object=record("first-recharge");
  private static var charge:Object=record("charge");
  private static var forthright:Object=record("forthright");
  private static var exchange:Object=record("exchange");
  private static var devil:Object=record("devil");
  private static var caveloot:Object=record("caveloot");
  private static var christmas:Object=record("christmas");
  // Exact public names from the pinned 82 ABC inventory; private helper classes are not probed.
  private static const SHARED_CLASSES:Array=["App","Config","morn.editor.core::IComponent","morn.core.components::Component","morn.editor.core::IBox","morn.core.components::Box","morn.core.components::View","com.pickgliss.events::LoaderResourceEvent","com.pickgliss.loader::LoadInterfaceEvent","com.pickgliss.loader::LoadInterfaceManager","com.pickgliss.loader::LoadResourceManager","morn.core.components::AutoBitmap","morn.core.components::ISelect","morn.core.components::Button","morn.core.components::CheckBox","morn.editor.core::IClip","morn.core.components::Clip","morn.core.components::ColorPicker","morn.core.components::ComboBox","morn.core.components::Container","morn.core.components::Dialog","morn.core.components::FrameClip","morn.core.components::IItem","morn.core.components::Group","morn.core.components::LayoutBox","morn.core.components::HBox","morn.core.components::ScrollBar","morn.core.components::HScrollBar","morn.core.components::Slider","morn.core.components::HSlider","morn.core.components::Image","morn.core.components::Label","morn.core.components::LinkButton","morn.editor.core::IRender","morn.core.components::List","morn.editor.core::IContent","morn.core.components::Panel","morn.core.components::ProgressBar","morn.core.components::ProxyItem","morn.core.components::RadioButton","morn.core.components::RadioGroup","morn.core.components::Styles","morn.core.components::Tab","morn.core.components::TextInput","morn.core.components::TextArea","morn.core.components::Tree","morn.core.components::VBox","morn.core.components::VScrollBar","morn.core.components::VSlider","morn.core.components::ViewStack","morn.core.events::DragEvent","morn.core.events::UIEvent","morn.core.ex::ButtonEx","morn.core.ex::GroupEx","morn.core.ex::HBoxEx","morn.core.ex::LabelEx","morn.core.ex::LevelIconEx","morn.core.ex::NameTextEx","morn.core.ex::NumberImageEx","morn.core.ex::NumericStepper","morn.core.ex::PageNavigaterEx","morn.core.ex::ProgressBarEx","morn.core.ex::ScaleLeftRightImageEx","morn.core.ex::SelectButtonEx","morn.core.ex::SelectPageEx","morn.core.ex::TabButtonEx","morn.core.ex::TabEx","morn.core.ex::TabListEx","morn.core.handlers::Handler","morn.core.managers::AssetManager","morn.core.managers::DialogManager","morn.core.managers::DragManager","morn.core.managers::LangManager","morn.core.managers::LogManager","morn.core.managers::RenderManager","morn.core.managers::TimerManager","morn.core.utils::BitmapUtils","morn.core.utils::ObjectUtils","morn.core.utils::StringUtils","morn.editor::Builder","morn.editor::BuilderResManager","morn.editor::Sys"];
  public function WorkshopNativeWardrobeBridge(){super();}
  private static function record(kind:String):Object {
   return {kind:kind,phase:"registered",notice:"请从活动菜单打开原活动。",expected:0,generation:"",wantOpen:false,loader:null,module:null,timer:null,errors:[]};
  }
  public static function init():void {
   if(registered||!ExternalInterface.available)return;
   ExternalInterface.addCallback("workshopOpenWardrobe",openWardrobe);
   ExternalInterface.addCallback("workshopStatusWardrobe",statusWardrobe);
   ExternalInterface.addCallback("workshopCloseWardrobe",closeWardrobe);
   ExternalInterface.addCallback("workshopOpenPair",openPair);
   ExternalInterface.addCallback("workshopStatusPair",statusPair);
   ExternalInterface.addCallback("workshopClosePair",closePair);
   ExternalInterface.addCallback("workshopOpenMines",openMines);
   ExternalInterface.addCallback("workshopStatusMines",statusMines);
   ExternalInterface.addCallback("workshopCloseMines",closeMines);
   ExternalInterface.addCallback("workshopOpenDDPlay",openDDPlay);
   ExternalInterface.addCallback("workshopStatusDDPlay",statusDDPlay);
   ExternalInterface.addCallback("workshopCloseDDPlay",closeDDPlay);
   ExternalInterface.addCallback("workshopOpenGypsy",openGypsy);
   ExternalInterface.addCallback("workshopStatusGypsy",statusGypsy);
   ExternalInterface.addCallback("workshopCloseGypsy",closeGypsy);
   ExternalInterface.addCallback("workshopOpenMoonlight",openMoonlight);
   ExternalInterface.addCallback("workshopStatusMoonlight",statusMoonlight);
   ExternalInterface.addCallback("workshopCloseMoonlight",closeMoonlight);
   ExternalInterface.addCallback("workshopOpenTreasure",openTreasure);
   ExternalInterface.addCallback("workshopStatusTreasure",statusTreasure);
   ExternalInterface.addCallback("workshopCloseTreasure",closeTreasure);
   ExternalInterface.addCallback("workshopOpenPurr",openPurr);
   ExternalInterface.addCallback("workshopStatusPurr",statusPurr);
   ExternalInterface.addCallback("workshopClosePurr",closePurr);
   ExternalInterface.addCallback("workshopOpenCarnival",openCarnival);
   ExternalInterface.addCallback("workshopStatusCarnival",statusCarnival);
   ExternalInterface.addCallback("workshopCloseCarnival",closeCarnival);
   ExternalInterface.addCallback("workshopOpenFirstRecharge",openFirstRecharge);
   ExternalInterface.addCallback("workshopStatusFirstRecharge",statusFirstRecharge);
   ExternalInterface.addCallback("workshopCloseFirstRecharge",closeFirstRecharge);
   ExternalInterface.addCallback("workshopOpenCharge",openCharge);
   ExternalInterface.addCallback("workshopStatusCharge",statusCharge);
   ExternalInterface.addCallback("workshopCloseCharge",closeCharge);
   ExternalInterface.addCallback("workshopOpenForthright",openForthright);
   ExternalInterface.addCallback("workshopStatusForthright",statusForthright);
   ExternalInterface.addCallback("workshopCloseForthright",closeForthright);
   ExternalInterface.addCallback("workshopOpenExchange",openExchange);
   ExternalInterface.addCallback("workshopStatusExchange",statusExchange);
   ExternalInterface.addCallback("workshopCloseExchange",closeExchange);
   ExternalInterface.addCallback("workshopOpenDevil",openDevil);
   ExternalInterface.addCallback("workshopStatusDevil",statusDevil);
   ExternalInterface.addCallback("workshopCloseDevil",closeDevil);
   ExternalInterface.addCallback("workshopOpenCaveLoot",openCaveLoot);
   ExternalInterface.addCallback("workshopStatusCaveLoot",statusCaveLoot);
   ExternalInterface.addCallback("workshopCloseCaveLoot",closeCaveLoot);
   ExternalInterface.addCallback("workshopOpenChristmas",openChristmas);
   ExternalInterface.addCallback("workshopStatusChristmas",statusChristmas);
   ExternalInterface.addCallback("workshopCloseChristmas",closeChristmas);
   ExternalInterface.addCallback("workshopOpenActivityMenu",openActivityMenu);
   ExternalInterface.addCallback("workshopStatusActivityMenu",statusActivityMenu);
   ExternalInterface.addCallback("workshopCloseActivityMenu",closeActivityMenu);
   ExternalInterface.addCallback("workshopActivityMenuResult",activityMenuResult);
   registered=true;
  }
  private static function clientClass(name:String):Class {
   var current:ApplicationDomain=ApplicationDomain.currentDomain;
   if(!current.hasDefinition(name))throw new Error("当前客户端缺少类："+name);
   return current.getDefinition(name) as Class;
  }
  private static function displayDomain():ApplicationDomain {
   var Display:Class=clientClass("com.pickgliss.loader.DisplayLoader");
   var context:LoaderContext=Display["Context"] as LoaderContext;
   if(!context||(hostContext&&context!==hostContext))throw new Error("当前游戏共享 LoaderContext 已改变。");
   var current:ApplicationDomain=context.applicationDomain;
   if(!current||!current.hasDefinition("ddt.manager.PlayerManager")||current.getDefinition("ddt.manager.PlayerManager")!==clientClass("ddt.manager.PlayerManager"))throw new Error("当前游戏共享加载域不匹配。");
   // ApplicationDomain.currentDomain may return a different wrapper for the same VM domain.
   // Verify concrete class identity, never wrapper object equality.
   if(sharedPhase=="ready")for each(var name:String in ["App","Config","morn.core.components.View"]){if(!current.hasDefinition(name)||current.getDefinition(name)!==domain.getDefinition(name))throw new Error("已载入共享类的身份改变。");}
   return current;
  }
  private static function verifyRole(id:Number):void {
   if(!isFinite(id)||id<=0||id!=int(id))throw new Error("请先选择当前游戏角色。");
   var State:Class=clientClass("ddt.manager.StateManager");
   if(State["currentStateType"]!="main")throw new Error("请返回游戏大厅后打开活动。");
   var Player:Class=clientClass("ddt.manager.PlayerManager"),self:Object=Player["Instance"]["Self"];
   actual=self?int(self["ID"]):0;
   if(actual<=0||actual!=id)throw new Error("网页角色与游戏内角色不一致。");
   if(expected>0&&expected!=actual)throw new Error("游戏角色已切换，请重新进入游戏后打开原活动。");
   if(domain)displayDomain();
  }
  private static function menuAlive(m:Object):Boolean {
   if(!m||activityMenu!==m||!m.root||!m.root.parent||!m.root.stage||m.root.stage!==m.stage)return false;
   try {
    var self:Object=clientClass("ddt.manager.PlayerManager")["Instance"]["Self"];
    return self===m.self&&int(self["ID"])===m.id&&self["ZoneID"]===m.zone&&
     clientClass("ddt.manager.StateManager")["currentStateType"]==="main"&&(expected===0||expected===m.id);
   }catch(ignored:Error){return false;}
   return false;
  }
  private static function menuKind(kind:String):Boolean {
   if(kind==="sign"||kind==="activation")return true;
   for each(var item:Array in MENU_ITEMS)if(item[0]===kind)return true;
   return false;
  }
  private static function menuLabel(parent:Sprite,text:String,x:int,y:int,width:int,height:int,size:int=14):TextField {
   var field:TextField=new TextField(),format:TextFormat=new TextFormat("宋体",size,0xFFE7A6,true);
   format.align="center";format.leading=3;field.defaultTextFormat=format;
   field.x=x;field.y=y;field.width=width;field.height=height;field.multiline=true;field.wordWrap=true;
   field.selectable=false;field.mouseEnabled=false;field.text=text;parent.addChild(field);return field;
  }
  private static function menuButton(m:Object,kind:String,label:String,x:int,y:int,height:int=62):Object {
   var factory:Object=clientClass("com.pickgliss.ui.ComponentFactory")["Instance"];
   var button:Object=factory["creatComponentByStylename"]("copyFile.btn");
   if(!(button is DisplayObject))throw new Error("客户端原生按钮皮肤未就绪。");
   button["text"]="";button["x"]=x;button["y"]=y;button["width"]=74;button["height"]=height;
   var caption:TextField=menuLabel(m.panel,label,x+3,y+(height>40?12:5),68,height>40?44:25,height>40?14:12);
   m.panel.addChildAt(button as DisplayObject,m.panel.numChildren-1);
   var click:Function=function(e:MouseEvent):void{
    e.stopImmediatePropagation();if(!menuAlive(m))return;
    if(kind==="close"){disposeMenu(m,true);return;}
    if(m.pendingKind)return;
    if(kind==="more"){m.extra.visible=!m.extra.visible;m.extraCaption.visible=m.extra.visible;return;}
    if(!menuKind(kind))return;
    m.pendingKind=kind;m.message.text="正在打开活动，请稍候……";
    try{if(!ExternalInterface.available||ExternalInterface.call("workshopSelectNativeActivity",m.id,m.token,kind)!==true){m.pendingKind="";m.message.text="活动入口未就绪，请关闭后重试。";}}
    catch(error:Error){m.pendingKind="";m.message.text="活动入口未就绪，请关闭后重试。";}
   };
   button.addEventListener(MouseEvent.CLICK,click);m.controls.push({view:button,listener:click,caption:caption,kind:kind});
   return {view:button,caption:caption};
  }
  private static function disposeMenu(m:Object,notify:Boolean):void {
   if(!m||activityMenu!==m)return;
   activityMenu=null;
   if(m.root&&m.tick)m.root.removeEventListener(Event.ENTER_FRAME,m.tick);
   if(m.stage&&m.key)m.stage.removeEventListener(KeyboardEvent.KEY_DOWN,m.key);
   if(m.root&&m.root.parent)m.root.parent.removeChild(m.root);
   for each(var control:Object in m.controls){control.view.removeEventListener(MouseEvent.CLICK,control.listener);try{control.view.dispose();}catch(ignored:Error){}}
   if(m.background){try{m.background.dispose();}catch(backgroundError:Error){}}
   if(notify&&ExternalInterface.available){try{ExternalInterface.call("workshopActivityMenuClosed",m.id,m.token);}catch(notifyError:Error){}}
  }
  public static function openActivityMenu(id:Number,token:String):Boolean {
   try {
    verifyRole(id);
    if(!token||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(token))throw new Error("活动菜单代次无效。");
    if(activityMenu){if(activityMenu.id===id&&activityMenu.token===token&&menuAlive(activityMenu))return true;throw new Error("请先关闭当前活动菜单。");}
    // Never cancel a module, its pending UUID, or an unconfirmed economic request to clear the screen.
    for each(var r:Object in [wardrobe,pair,mines,ddplay,gypsy,moonlight,treasure,purr,carnival,firstRecharge,charge,forthright,exchange,devil,caveloot,christmas]){
     if(r.wantOpen||r.phase==="waiting-shared"||r.phase==="loading")throw new Error("活动正在打开，请稍候。");
     if(r.module){var s:Object=r.module.statusNative();if(!s||s.pending===true||s.animating===true||s.visible===true||s.open===true)throw new Error("请先完成操作并关闭当前活动窗口。");}
    }
    var self:Object=clientClass("ddt.manager.PlayerManager")["Instance"]["Self"];
    var m:Object={id:int(id),token:token,self:self,zone:self["ZoneID"],root:new Sprite(),panel:new Sprite(),controls:[],pendingKind:""};
    activityMenu=m;menuMessage="";
    var Layer:Class=clientClass("com.pickgliss.ui.LayerManager");
    // Own the backdrop explicitly: removing this Sprite removes every modal hit area as well.
    Layer["Instance"]["addToLayer"](m.root,3,false,0);
    if(!m.root.stage)throw new Error("游戏原生显示层未就绪。");
    m.stage=m.root.stage;var w:int=m.stage.stageWidth,h:int=m.stage.stageHeight;
    m.root.graphics.beginFill(0x000000,0.4);m.root.graphics.drawRect(0,0,w,h);m.root.graphics.endFill();
    m.panel.x=Math.max(8,int((w-330)/2));m.panel.y=Math.max(8,int((h-466)/2));m.root.addChild(m.panel);
    m.background=clientClass("com.pickgliss.ui.ComponentFactory")["Instance"]["creatComponentByStylename"]("SimpleFrameBackgound");
    if(!(m.background is DisplayObject))throw new Error("客户端原生窗口皮肤未就绪。");
    m.background.width=330;m.background.height=466;m.panel.addChild(m.background);
    menuLabel(m.panel,"活动",10,10,310,29,18);
    for(var i:int=0;i<MENU_ITEMS.length;i++){
     var label:String=MENU_ITEMS[i][1];if(label.length>4)label=label.substr(0,2)+"\n"+label.substr(2);
     menuButton(m,MENU_ITEMS[i][0],label,10+80*(i%4),44+80*int(i/4));
    }
    menuButton(m,"sign","签到",10,369,34);menuButton(m,"more","更多",90,369,34);
    var extra:Object=menuButton(m,"activation","激活",170,369,34);m.extra=extra.view;m.extraCaption=extra.caption;m.extra.visible=false;m.extraCaption.visible=false;
    menuButton(m,"close","关闭",250,369,34);
    m.message=menuLabel(m.panel,"点击活动打开原窗口\n奖励以活动内规则为准",10,414,310,44,12);
    m.tick=function(e:Event):void{if(!menuAlive(m))disposeMenu(m,true);};
    m.key=function(e:KeyboardEvent):void{if(e.keyCode===27&&activityMenu===m){e.stopImmediatePropagation();disposeMenu(m,true);}};
    m.root.addEventListener(Event.ENTER_FRAME,m.tick);m.stage.addEventListener(KeyboardEvent.KEY_DOWN,m.key,false,1000);
    return menuAlive(m);
   }catch(error:Error){menuMessage=error.message;if(activityMenu)disposeMenu(activityMenu,true);return false;}
   return false;
  }
  public static function statusActivityMenu():Object {
   var id:int=0;try{var self:Object=clientClass("ddt.manager.PlayerManager")["Instance"]["Self"];id=self?int(self["ID"]):0;}catch(ignored:Error){}
   if(activityMenu&&!menuAlive(activityMenu))disposeMenu(activityMenu,true);
   var m:Object=activityMenu;
   return {version:1,open:Boolean(m),actualUserId:id,characterId:m?m.id:0,token:m?m.token:"",pending:Boolean(m&&m.pendingKind),message:menuMessage};
  }
  public static function closeActivityMenu(token:String):Boolean {
   var m:Object=activityMenu;if(!m||m.token!==token)return false;disposeMenu(m,true);return true;
  }
  public static function activityMenuResult(id:Number,token:String,kind:String,opened:Boolean,message:String):Boolean {
   var m:Object=activityMenu;
   if(!menuAlive(m)||m.id!==id||m.token!==token||m.pendingKind!==kind||!menuKind(kind))return false;
   if(opened){disposeMenu(m,false);return true;}
   m.pendingKind="";m.message.text=message?message:"活动窗口未能打开，请重试。";return true;
  }
  public static function openWardrobe(id:Number):Boolean{return open(wardrobe,id,"wardrobe:"+id);}
  public static function openPair(id:Number,generation:String):Boolean{return open(pair,id,generation);}
  public static function openMines(id:Number,generation:String):Boolean{return open(mines,id,generation);}
  public static function openDDPlay(id:Number,generation:String):Boolean{return open(ddplay,id,generation);}
  public static function openGypsy(id:Number,generation:String):Boolean{return open(gypsy,id,generation);}
  public static function openMoonlight(id:Number,generation:String):Boolean{return open(moonlight,id,generation);}
  public static function openTreasure(id:Number,generation:String):Boolean{return open(treasure,id,generation);}
  public static function openPurr(id:Number,generation:String):Boolean{return open(purr,id,generation);}
  public static function openCarnival(id:Number,generation:String):Boolean{return open(carnival,id,generation);}
  public static function openFirstRecharge(id:Number,generation:String):Boolean{return open(firstRecharge,id,generation);}
  public static function openCharge(id:Number,generation:String):Boolean{return open(charge,id,generation);}
  public static function openForthright(id:Number,generation:String):Boolean{return open(forthright,id,generation);}
  public static function openExchange(id:Number,generation:String):Boolean{return open(exchange,id,generation);}
  public static function openDevil(id:Number,generation:String):Boolean{return open(devil,id,generation);}
  public static function openCaveLoot(id:Number,generation:String):Boolean{return open(caveloot,id,generation);}
  public static function openChristmas(id:Number,generation:String):Boolean{return open(christmas,id,generation);}
  public static function routeChristmasNaturalReturn(target:String,room:Object,game:Object):String {
   if(target!=="dungeonRoom"||sharedPhase!=="ready"||christmas.phase!=="ready"||!domain||!christmas.module||expected<=0||christmas.expected!==expected||!christmas.generation)return target;
   try {
    displayDomain();
    var self:Object=clientClass("ddt.manager.PlayerManager")["Instance"]["Self"];
    if(!self||int(self["ID"])!==expected||!room||!game||clientClass("room.RoomManager")["Instance"]["current"]!==room||clientClass("game.GameManager")["Instance"]["Current"]!==game)return target;
    var s:Object=christmas.module.statusNative();
    if(!s||s.phase!=="ready"||s.ready!==true||s.expectedUserId!==expected||s.characterId!==expected||s.generation!==christmas.generation)return target;
    var result:*=christmas.module.naturalBattleReturn(target,room,game);
    return result is String&&(result===target||result==="main")?String(result):target;
   }catch(ignored:Error){return target;}
   return target;
  }
  private static function open(r:Object,id:Number,generation:String):Boolean {
   try {
    verifyRole(id);
    if(sharedPhase=="failed")throw new Error(sharedError);
    if(r.phase=="failed")throw new Error("活动加载失败，请重新进入游戏："+r.notice);
    if(!generation||generation.length>160)throw new Error("缺少有效活动宿主代次。");
    if(r.generation&&r.generation!==generation)throw new Error("活动宿主代次已绑定，请复用原宿主或重新进入游戏。");
    expected=int(id);r.expected=expected;r.generation=generation;r.wantOpen=true;
    if(r.module&&moduleReady(r,r.module.statusNative())){openReady(r);return r.phase!="failed";}
    if(r.loader)return true;
    r.phase="waiting-shared";r.notice="正在准备原活动的共享组件。";
    ensureShared();if(sharedPhase=="ready")loadModule(r);report(r);
    return r.phase!="failed"&&sharedPhase!="failed";
   }catch(error:Error){r.notice=error.message;report(r);return false;}
   return false;
  }
  private static function ensureRoot():void {
   if(domain)return;
   var Path:Class=clientClass("ddt.manager.PathManager"),base:String=String(Path["FLASHSITE"]);
   if(!base||base=="null")throw new Error("当前 Flash 资源路径未就绪。");
   if(base.charAt(base.length-1)!="/")base+="/";
   if(base.toLowerCase().lastIndexOf("/flash/")!=base.length-7)throw new Error("当前 Flash 资源根不是正常 /flash/ 路径。");
   domain=displayDomain();hostContext=clientClass("com.pickgliss.loader.DisplayLoader")["Context"] as LoaderContext;root=base+"workshop-native/";
  }
  private static function sharedCount():int {var n:int=0;for each(var name:String in SHARED_CLASSES)if(domain.hasDefinition(name))n++;return n;}
  private static function context():LoaderContext {var c:LoaderContext=new LoaderContext(false,domain);c.allowCodeImport=true;return c;}
  private static function ensureShared():void {
   if(sharedPhase=="ready"||sharedPhase=="loading")return;
   if(sharedPhase=="failed")throw new Error(sharedError);
   try {
    ensureRoot();verifyRole(expected);var count:int=sharedCount();
    // Even a complete pre-existing list has no provenance from this owner.
    // A legacy 92-class wardrobe session must reload into the unified owner first.
    if(count!=0)throw new Error("共享类已存在但不属于本次唯一加载器，请重新进入游戏。");
    if(sharedLoader||sharedImports!=0)throw new Error("共享库已经尝试加载，不会重复导入。");
    sharedPhase="loading";sharedLoader=new Loader();sharedImports++;
    sharedLoader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,function(e:IOErrorEvent):void{sharedFail("shared-io",e.text);});
    sharedLoader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:SecurityErrorEvent):void{sharedFail("shared-security",e.text);});
    sharedLoader.contentLoaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,function(e:UncaughtErrorEvent):void{sharedFail("shared-uncaught",String(e.error));});
    sharedLoader.contentLoaderInfo.addEventListener(Event.COMPLETE,function(e:Event):void {
     if(sharedPhase!="loading")return;
     try{verifyRole(expected);if(sharedCount()!=SHARED_CLASSES.length)throw new Error("共享库载入后类清单不完整。");sharedPhase="ready";stopSharedTimer();if(wardrobe.wantOpen)loadModule(wardrobe);if(pair.wantOpen)loadModule(pair);if(mines.wantOpen)loadModule(mines);if(ddplay.wantOpen)loadModule(ddplay);if(gypsy.wantOpen)loadModule(gypsy);if(moonlight.wantOpen)loadModule(moonlight);if(treasure.wantOpen)loadModule(treasure);if(purr.wantOpen)loadModule(purr);if(carnival.wantOpen)loadModule(carnival);if(firstRecharge.wantOpen)loadModule(firstRecharge);if(charge.wantOpen)loadModule(charge);if(forthright.wantOpen)loadModule(forthright);if(exchange.wantOpen)loadModule(exchange);if(devil.wantOpen)loadModule(devil);if(caveloot.wantOpen)loadModule(caveloot);if(christmas.wantOpen)loadModule(christmas);}
     catch(error:Error){sharedFail("shared-complete",error.message);}
    });
    sharedTimer=new Timer(60000,1);sharedTimer.addEventListener(TimerEvent.TIMER_COMPLETE,function(e:TimerEvent):void{sharedFail("shared-timeout","共享组件加载超时。");});sharedTimer.start();
    sharedLoader.load(new URLRequest(root+"shared/native-shared-library.swf"),context());
   }catch(error:Error){sharedFail("shared",error.message);}
  }
  private static function stopSharedTimer():void {if(sharedTimer)sharedTimer.stop();}
  private static function sharedFail(at:String,text:String):void {
   if(sharedPhase=="failed")return;stopSharedTimer();sharedPhase="failed";sharedError="共享组件加载失败，请重新进入游戏："+text;
   fail(wardrobe,at,sharedError);fail(pair,at,sharedError);fail(mines,at,sharedError);fail(ddplay,at,sharedError);fail(gypsy,at,sharedError);fail(moonlight,at,sharedError);fail(treasure,at,sharedError);fail(purr,at,sharedError);fail(carnival,at,sharedError);fail(firstRecharge,at,sharedError);fail(charge,at,sharedError);fail(forthright,at,sharedError);fail(exchange,at,sharedError);fail(devil,at,sharedError);fail(caveloot,at,sharedError);fail(christmas,at,sharedError);
  }
  private static function loadModule(r:Object):void {
   if(!r.wantOpen||r.loader||r.module||r.phase=="failed"||sharedPhase!="ready")return;
   try {
    verifyRole(r.expected);var base:String=root+r.kind+"/",file:String=r.kind=="wardrobe"?"WorkshopNativeWardrobeBootstrap.swf":r.kind=="pair"?"WorkshopNativePairBootstrap.swf":r.kind=="mines"?"WorkshopNativeMinesBootstrap.swf":r.kind=="ddplay"?"WorkshopNativeDDPlayBootstrap.swf":r.kind=="gypsy"?"WorkshopNativeGypsyBootstrap.swf":r.kind=="moonlight"?"WorkshopNativeMoonlightBootstrap.swf":r.kind=="treasure"?"WorkshopNativeTreasureBootstrap.swf":r.kind=="purr"?"WorkshopNativePurrBootstrap.swf":r.kind=="carnival"?"WorkshopNativeCarnivalBootstrap.swf":r.kind=="first-recharge"?"WorkshopNativeFirstRechargeBootstrap.swf":r.kind=="charge"?"WorkshopNativeChargeBootstrap.swf":r.kind=="forthright"?"WorkshopNativeForthrightBootstrap.swf":r.kind=="exchange"?"WorkshopNativeExchangeBootstrap.swf":r.kind=="devil"?"WorkshopNativeDevilBootstrap.swf":r.kind=="caveloot"?"WorkshopNativeCaveLootBootstrap.swf":r.kind=="christmas"?"WorkshopNativeChristmasBootstrap.swf":null;if(!file)throw new Error("未知原活动类型。");
    r.phase="loading-bootstrap";r.notice="正在加载原活动窗口。";r.loader=new Loader();var loader:Loader=r.loader as Loader;
    loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,function(e:IOErrorEvent):void{fail(r,"bootstrap-io",e.text);});
    loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(e:SecurityErrorEvent):void{fail(r,"bootstrap-security",e.text);});
    loader.contentLoaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,function(e:UncaughtErrorEvent):void{fail(r,"bootstrap-uncaught",String(e.error));});
    loader.contentLoaderInfo.addEventListener(Event.COMPLETE,function(e:Event):void {
     if(r.phase=="failed"||sharedPhase!="ready")return;
     try {verifyRole(r.expected);r.module=loader.content;r.module.startNative({baseUrl:base,expectedUserId:r.expected,generation:r.generation,sharedOwnerReady:true,sharedDomain:domain,sharedContext:hostContext,autoOpen:false});pollModule(r);}
     catch(error:Error){fail(r,"bootstrap",error.message);}
    });
    r.timer=new Timer(200,300);r.timer.addEventListener(TimerEvent.TIMER,function(e:TimerEvent):void{pollModule(r);});r.timer.addEventListener(TimerEvent.TIMER_COMPLETE,function(e:TimerEvent):void{fail(r,"module-timeout","活动资源加载超时。");});r.timer.start();
    loader.load(new URLRequest(base+file),context());report(r);
   }catch(error:Error){fail(r,"module-load",error.message);}
  }
  private static function moduleReady(r:Object,s:Object):Boolean{return r.kind=="wardrobe"?s.ready===true:s.phase=="ready";}
  private static function moduleError(s:Object):String{var errors:Array=s.errors as Array;return errors&&errors.length?String(errors[errors.length-1].message):String(s.message||"原活动窗口未能打开。");}
  private static function pollModule(r:Object):void {
   if(r.phase=="failed"||!r.module||sharedPhase!="ready")return;
   try {verifyRole(r.expected);var s:Object=r.module.statusNative();if(s.phase=="error"||s.phase=="failed"){fail(r,"module",moduleError(s));return;}
    r.phase=String(s.phase);if(!moduleReady(r,s))return;if(r.timer)r.timer.stop();if(r.wantOpen)openReady(r);else report(r);
   }catch(error:Error){fail(r,"module",error.message);}
  }
  private static function openReady(r:Object):void {
   if(!r.wantOpen||r.phase=="failed"||sharedPhase!="ready")return;
   try {verifyRole(r.expected);var s:Object=r.module.openNative();r.wantOpen=false;
    if(s.phase=="error"||s.phase=="failed"){fail(r,"open",moduleError(s));return;}
    r.phase=String(s.phase);r.notice=String(s.catalogNotice||s.message||"原活动已就绪。");report(r);
   }catch(error:Error){fail(r,"open",error.message);}
  }
  private static function close(r:Object):void {
   r.wantOpen=false;
   if(r.module){try{var s:Object=r.module.closeNative();if(r.phase!="failed")r.phase=String(s.phase);}catch(error:Error){fail(r,"close",error.message);return;}}
   report(r);
  }
  public static function closeWardrobe():void{close(wardrobe);}
  public static function closePair():void{close(pair);}
  public static function closeMines():void{close(mines);}
  public static function statusMines():Object{return status(mines);}
  public static function closeDDPlay():void{close(ddplay);}
  public static function statusDDPlay():Object{return status(ddplay);}
  public static function closeGypsy():void{close(gypsy);}
  public static function statusGypsy():Object{return status(gypsy);}
  public static function closeMoonlight():void{close(moonlight);}
  public static function statusMoonlight():Object{return status(moonlight);}
  public static function closeTreasure():void{close(treasure);}
  public static function statusTreasure():Object{return status(treasure);}
  public static function closePurr():void{close(purr);}
  public static function statusPurr():Object{return status(purr);}
  public static function closeCarnival():void{close(carnival);}
  public static function statusCarnival():Object{return status(carnival);}
  public static function closeFirstRecharge():void{close(firstRecharge);}
  public static function statusFirstRecharge():Object{return status(firstRecharge);}
  public static function closeCharge():void{close(charge);}
  public static function statusCharge():Object{return status(charge);}
  public static function closeForthright():void{close(forthright);}
  public static function statusForthright():Object{return status(forthright);}
  public static function closeExchange():void{close(exchange);}
  public static function statusExchange():Object{return status(exchange);}
  public static function closeDevil():void{close(devil);}
  public static function statusDevil():Object{return status(devil);}
  public static function closeCaveLoot():void{close(caveloot);}
  public static function statusCaveLoot():Object{return status(caveloot);}
  public static function closeChristmas():void{close(christmas);}
  public static function statusChristmas():Object{return status(christmas);}
  public static function statusWardrobe():Object{return status(wardrobe);}
  public static function statusPair():Object{return status(pair);}
  private static function status(r:Object):Object {
   // Read-only identity refresh also works outside main; accepting a response still rechecks main.
   try{var Player:Class=clientClass("ddt.manager.PlayerManager"),self:Object=Player["Instance"]["Self"];actual=self?int(self["ID"]):0;}catch(identityError:Error){actual=0;}
   var s:Object=null;if(r.module){try{s=r.module.statusNative();}catch(error:Error){s={phase:"error",errors:[{message:error.message}]};}}
   var result:Object={phase:r.phase=="failed"||sharedPhase=="failed"?"failed":s?s.phase:r.phase,
    ready:Boolean(s&&moduleReady(r,s)&&r.phase!="failed"&&sharedPhase=="ready"),visible:Boolean(s&&(s.visible===true||s.open===true)),
    registered:registered,actualUserId:actual,expectedUserId:r.expected,characterId:r.expected,generation:r.generation,
    sharedPhase:sharedPhase,sharedImports:sharedImports,sharedClassCount:SHARED_CLASSES.length,wantOpen:r.wantOpen,
    notice:r.notice,message:String(s&&s.message?s.message:r.notice),errors:r.errors.concat(s&&s.errors?s.errors:[]),
    originalSetCount:s?s.originalSetCount:0,readySetCount:s?s.readySetCount:0,missingSets:s?s.missingSets:[],viewState:s?s.viewState:null};
   if(r.kind=="pair"||r.kind=="mines"||r.kind=="ddplay"||r.kind=="gypsy"||r.kind=="moonlight"||r.kind=="treasure"||r.kind=="purr"||r.kind=="carnival"||r.kind=="first-recharge"||r.kind=="charge"||r.kind=="forthright"||r.kind=="exchange"||r.kind=="devil"||r.kind=="caveloot"||r.kind=="christmas"){result.open=Boolean(s&&s.open);result.pending=Boolean(s&&s.pending);result.requestId=s?s.requestId:"";result.sequence=s?s.sequence:0;result.revision=s?s.revision:-1;result.animating=Boolean(s&&s.animating);result.experimental=true;}
   return result;
  }
  private static function fail(r:Object,at:String,text:String):void {
   if(r.phase=="failed")return;if(r.timer)r.timer.stop();r.wantOpen=false;r.phase="failed";r.notice=text;r.errors.push({at:at,message:text});
   // Keep the imported definitions and terminal state; never retry in another domain.
   if(r.module){try{r.module.abortNative(text);}catch(ignored:Error){}}
   report(r);
  }
  private static function report(r:Object):void{if(ExternalInterface.available){try{var callback:String=r.kind=="wardrobe"?"workshopWardrobeReport":r.kind=="pair"?"workshopPairReport":r.kind=="mines"?"workshopMinesReport":r.kind=="ddplay"?"workshopDDPlayReport":r.kind=="gypsy"?"workshopGypsyReport":r.kind=="moonlight"?"workshopMoonlightReport":r.kind=="treasure"?"workshopTreasureReport":r.kind=="purr"?"workshopPurrReport":r.kind=="carnival"?"workshopCarnivalReport":r.kind=="first-recharge"?"workshopFirstRechargeReport":r.kind=="charge"?"workshopChargeReport":r.kind=="forthright"?"workshopForthrightReport":r.kind=="exchange"?"workshopExchangeReport":r.kind=="devil"?"workshopDevilReport":r.kind=="caveloot"?"workshopCaveLootReport":r.kind=="christmas"?"workshopChristmasReport":null;if(!callback)return;ExternalInterface.call(callback,status(r));}catch(ignored:Error){}}}
 }
}
