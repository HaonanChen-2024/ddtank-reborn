package {
  import flash.display.Sprite;
  import flash.display.Loader;
  import flash.display.DisplayObject;
  import flash.display.DisplayObjectContainer;
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.events.MouseEvent;
  import flash.events.IOErrorEvent;
  import flash.events.SecurityErrorEvent;
  import flash.external.ExternalInterface;
  import flash.net.URLLoader;
  import flash.net.URLLoaderDataFormat;
  import flash.net.URLRequest;
  import flash.system.ApplicationDomain;
  import flash.system.LoaderContext;
  import flash.utils.ByteArray;
  import flash.utils.Dictionary;

  /** Experimental module controller. Only the host page owns authentication and action UUIDs. */
  public class WorkshopNativePairBootstrap extends Sprite {
    private static var active:WorkshopNativePairBootstrap;
    private var domain:ApplicationDomain = ApplicationDomain.currentDomain;
    private var phase:String = "new";
    private var base:String;
    private var expectedId:int;
    private var generation:String;
    private var sequence:int = 0;
    private var pending:Boolean = false;
    private var pendingId:String = "";
    private var pendingAction:Object;
    private var animating:Boolean = false;
    private var lastRevision:Number = -1;
    private var response:Object;
    private var projection:Object;
    private var main:Object;
    private var wantedOpen:Boolean = false;
    private var cardView:Object;
    private var shopView:Object;
    private var modal:Object;
    private var resetMovie:MovieClip;
    private var resetListener:Function;
    private var loaders:Array = [];
    private var local:Object = new Dictionary(true);
    private var message:String = "尚未读取本地活动。";

    public function WorkshopNativePairBootstrap() { }
    private function cls(name:String):Object {
      if (!domain.hasDefinition(name)) throw new Error("缺少原类：" + name);
      return domain.getDefinition(name);
    }
    private function instance(name:String):Object { var C:Class = cls(name) as Class; return new C(); }
    private function manager():Object { return cls("pairBox.PairBoxManager").instance; }
    private function model():Object { return manager().model; }
    private function role():void {
      if (cls("ddt.manager.StateManager").currentStateType != "main") throw new Error("请先返回大厅。");
      if (int(cls("ddt.manager.PlayerManager").Instance.Self.ID) != expectedId) throw new Error("当前角色已改变。");
    }
    public function startNative(options:Object):void {
      if (phase != "new" || active) throw new Error("配对候选已经初始化。");
      if (!options || !(int(options.expectedUserId) > 0) || !options.generation || !options.baseUrl) throw new Error("缺少角色、代次或本地资源路径。");
      expectedId = int(options.expectedUserId); generation = String(options.generation); base = String(options.baseUrl);
      if (base.charAt(base.length - 1) != "/") throw new Error("baseUrl 必须以 / 结束。");
      role();
      if (!ExternalInterface.available) throw new Error("需要同一游戏页面的本地 API 桥接。");
      if (options.sharedOwnerReady !== true) throw new Error("请先由唯一共享载入器准备 App/Morn。");
      for each (var required:String in ["App", "Config", "morn.core.components.View", "morn.editor.core.IComponent", "morn.editor.core.IBox", "morn.editor.core.IClip", "morn.editor.core.IContent"]) cls(required);
      active = this; phase = "loading";
      ExternalInterface.addCallback("workshopPairAcceptSnapshot", acceptSnapshot);
      ExternalInterface.addCallback("workshopPairRejectRequest", rejectRequest);
      ExternalInterface.addCallback("workshopPairOpenNative", openNative);
      ExternalInterface.addCallback("workshopPairCloseNative", closeNative);
      ExternalInterface.addCallback("workshopPairStatusNative", statusNative);
      // The host's single shared loader must finish before either wardrobe or pair starts.
      // This module deliberately never loads App/Morn itself, including a first-open race.
      loadPair();
    }
    private function loadPair():void { loadSwf("pair-original-library.swf", function():void { loadSkin(0); }); }
    private function loadSkin(index:int):void {
      var skins:Array=[[88,"asset.ddtshop.PayTypeLabelTicket"],[94,"asset.ddtstore.ShortcutTextBg"],[188,"asset.ui.scale.bg4"],[105,"asset.ui.btn_close1"],[93,"asset.ui.frame.bg2"],[57,"asest.ui.btn_check7"],[56,"asset.ui.btn_yellow1"]];
      if(index==skins.length){loadSwf("pairbox_v3_6_1_u1.swf",loadLayout);return;}
      if(domain.hasDefinition(skins[index][1]))loadSkin(index+1);
      else loadSwf("pair-shared-art-"+skins[index][0]+".swf",function():void{loadSkin(index+1);});
    }
    private function loadSwf(file:String, next:Function):void {
      var loader:Loader = new Loader(); loaders.push(loader);
      loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void { try { next(); } catch (error:Error) { fail(error.message); } });
      loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e:Event):void { fail("资源载入失败：" + file); });
      loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR, function(e:Event):void { fail("资源访问被拒绝：" + file); });
      var context:LoaderContext = new LoaderContext(false, domain); context.allowCodeImport = true;
      loader.load(new URLRequest(base + file), context);
    }
    private function loadLayout():void {
      var loader:URLLoader = new URLLoader(); loaders.push(loader); loader.dataFormat = URLLoaderDataFormat.BINARY;
      loader.addEventListener(IOErrorEvent.IO_ERROR, function(e:Event):void { fail("原布局读取失败。"); });
      loader.addEventListener(Event.COMPLETE, function(e:Event):void {
        try {
          var bytes:ByteArray = loader.data as ByteArray; bytes.uncompress(); bytes.position = 0;
          var layouts:Object = bytes.readObject(); var App:Object = cls("App");
          if(bytes.bytesAvailable!=0)throw new Error("原布局含未读取数据。");
          App.stage = cls("com.pickgliss.toplevel.StageReferance").stage; App.asset.setDomain(domain);
          var View:Object = cls("morn.core.components.View");
          var count:int=0;for (var key:String in layouts) {if(!(layouts[key] is XML))throw new Error("原布局不是 XML。");View.uiMap[key]=layouts[key];count++;}if(count!=10)throw new Error("原布局数量不匹配。");
          phase = "ready"; message = "已准备原窗口；打开只读取存档，不创建牌局。"; report();
        } catch (error:Error) { fail(error.message); }
      });
      loader.load(new URLRequest(base + "pairbox_v3_6_1_u1.ui"));
    }
    public function openNative():Object {
      role(); if (phase != "ready") return statusNative();
      if (pending || animating) { message = "当前操作尚未确认，请在页面处理原请求。"; report(); return statusNative(); }
      if (main) return statusNative(); wantedOpen = true;
      read(); return statusNative();
    }
    private function read():void {
      role(); pending = true; pendingAction = null; pendingId = ""; sequence++; lock();
      try {
        var accepted:Object = ExternalInterface.call("workshopPairRead", expectedId, generation, sequence);
        if (!accepted || accepted.accepted !== true) { pending = false; throw new Error("页面尚未接入配对只读桥接。"); }
      } catch (error:Error) { message = error.message; lock(); report(); }
    }
    private function request(action:Object):void {
      role(); if (pending || animating || !projection) return;
      if (cls("ddt.manager.PlayerManager").Instance.Self.bagLocked) { say("请先解除背包锁定。"); return; }
      pending = true; pendingId = ""; pendingAction = action; sequence++; lock();
      try {
        var accepted:Object = ExternalInterface.call("workshopPairRequest", expectedId, generation, sequence, action);
        if (!accepted || accepted.accepted !== true || !accepted.requestId) {
          pending = false; pendingAction = null; throw new Error("页面未接受操作；没有提交新的付费请求。");
        }
        pendingId = String(accepted.requestId);
      } catch (error:Error) { message = error.message; lock(); report(); }
    }
    /** Host must deliver asynchronously after its synchronous accepted/UUID acknowledgement. */
    public function acceptSnapshot(envelope:Object):Object {
      role();
      if (!pending || !envelope || envelope.generation !== generation || envelope.sequence !== sequence) throw new Error("丢弃旧代次响应。");
      var value:Object = envelope.snapshot;
      if (!value || value.characterId !== expectedId || !isFinite(Number(value.revision)) || Number(value.revision)<0 || Number(value.revision)!=Math.floor(Number(value.revision)) || Number(value.revision) < lastRevision) throw new Error("响应身份或版本不匹配。");
      if (pendingAction && (!pendingId || String(envelope.requestId) != pendingId)) throw new Error("动作 UUID 不匹配。");
      validate(value.nativePair);
      var action:Object = pendingAction; var fresh:Boolean = Boolean(action && !value.replayed && value.nativePairAction && value.nativePairAction.requestId === pendingId);
      var effects:Array = fresh ? value.nativePairAction.effects as Array : null;
      response = value; projection = value.nativePair; lastRevision = Number(value.revision); pending = false; pendingAction = null; pendingId = "";
      bindModel();
      // A closed window receives state only. Explicit read opens a new window.
      var existed:Boolean = main != null;
      if (!main && !action && wantedOpen) { main = instance("pairBox.view.PairBoxMainView"); show(main); }
      if (main) {
        if (fresh && existed && action.type === "flip" && effects) animateSingle(effects);
        else if (fresh && existed && action.type === "reset") { render(); animateReset(); }
        else { render(); if (fresh && action.type === "flip-all" && effects) showRewards(effects); }
      }
      message = value.message ? String(value.message) : "已读取本地进度；奖励通过游戏邮件交付。"; lock(); report(); return statusNative();
    }
    private function validate(p:Object):void {
      if (!p || p.hasOwnProperty("hiddenDeck") || p.hasOwnProperty("state") || !p.localRules || p.localRules.version !== 1 || p.localRules.slots !== 32) throw new Error("无效公开投影。");
      if (!(p.localRules.prizes is Array) || p.localRules.prizes.length != 4) throw new Error("奖池合同不匹配。");
      var ids:Array = [11019, 11001, 11021, 11002];
      for (var n:int = 0; n < 4; n++) if (p.localRules.prizes[n].id !== n + 1 || p.localRules.prizes[n].templateId !== ids[n]) throw new Error("未知本地奖池。");
      if (p.started !== true) { if (p.started !== false) throw new Error("缺少 started。"); return; }
      if (!(p.cards is Array) || p.cards.length != 32 || int(p.columns) != 8) throw new Error("牌面必须为 8 × 4。");
      for (var i:int = 0; i < 32; i++) {
        var c:Object = p.cards[i]; if (!c || c.pos !== i + 1 || !(c.ID === -1 || (c.ID === int(c.ID) && c.ID >= 1 && c.ID <= 4))) throw new Error("非法公开牌面。");
        if (c.ID === -1 && (c.isGet || c.otherPos)) throw new Error("背面泄露配对关系。");
        if (c.isGet && (!(int(c.otherPos) >= 1 && int(c.otherPos) <= 32) || p.cards[int(c.otherPos)-1].ID != c.ID || p.cards[int(c.otherPos)-1].otherPos != c.pos)) throw new Error("配对关系不完整。");
      }
    }
    public function rejectRequest(envelope:Object):Object {
      if (!pending || !envelope || envelope.generation !== generation || int(envelope.sequence) != sequence) return statusNative();
      if (pendingAction && String(envelope.requestId) != pendingId) return statusNative();
      // A timeout is not a rejection. Keep the request locked for same-UUID page retry.
      if (envelope.definitive === true) { pending = false; pendingAction = null; pendingId = ""; }
      say(String(envelope.message || "请求状态尚未确认，请在网页重试同一个请求。")); lock(); return statusNative();
    }
    private function bindModel():void {
      var m:Object = model(), dict:Object = instance("road7th.data.DictionaryData"), info:Object;
      for each (var prize:Object in projection.localRules.prizes) {
        if (!cls("ddt.manager.ItemManager").Instance.getTemplateById(int(prize.templateId))) throw new Error("本地缺少奖品模板：" + prize.templateId);
        info = instance("pairBox.data.PairBoxCardItemCnfInfo"); info.ID=prize.id; info.TemplateID=prize.templateId; info.Count=prize.count; info.Type=1; info.IsBind=true; info.IsArea=1; dict.add(info.ID,info);
      }
      m.carCnfDic=dict; dict=instance("road7th.data.DictionaryData");
      for(var i:int=1;i<=32;i++) { info=instance("pairBox.data.PairBoxCardItemInfo"); var c:Object=projection.started?projection.cards[i-1]:{ID:-1,isGet:false,otherPos:0}; info.pos=i;info.ID=c.ID;info.isGet=c.isGet;info.otherPos=c.otherPos;dict.add(i,info); }
      m.cardDic=dict;m.state=projection.started?1:0;
      for each(var field:String in ["freeReelCount","reelCount","markCount","freeResetCount","todayBuyCount"]) m[field]=projection.started?projection[field]:0;
      m.isAllOpen=Boolean(projection.isAllOpen);
    }
    private function handler(fn:Function):Object { var C:Class=cls("morn.core.handlers.Handler") as Class;return new C(fn); }
    private function button(o:Object, fn:Function):void { o.clickHandler=handler(fn); }
    private function show(o:Object):void { cls("com.pickgliss.ui.LayerManager").Instance.addToLayer(o,3,true,1); }
    private function say(s:String):void { message=s;try { cls("ddt.manager.MessageTipManager").getInstance().show(s); } catch(e:Error) {} report(); }
    private function report():void { try { ExternalInterface.call("workshopPairReport", statusNative()); } catch(e:Error) {} }
    private function fail(s:String):void { phase="failed";message=s;report(); }
    public function statusNative():Object { return {phase:phase,characterId:expectedId,generation:generation,sequence:sequence,open:main!=null,pending:pending,requestId:pendingId,animating:animating,revision:lastRevision,message:message,experimental:true}; }
    public function closeNative():Object { wantedOpen=false;closeModal();var old:Object=main;main=null;cardView=null;shopView=null;animating=false;if(resetMovie&&resetListener)resetMovie.removeEventListener(Event.ENTER_FRAME,resetListener);resetListener=null;if(old)old.dispose();resetMovie=null;report();return statusNative(); }
    private function closeModal():void { var old:Object=modal;modal=null;if(old)old.dispose(); }
    private function renderPool(list:Object, data:Array):void {
      list.renderHandler=handler(function(cell:Object,index:int):void { cell.visible=index<data.length;if(cell.visible)cell.setInfo(data[index]); }); list.array=data;
    }
    private function rewardRows():Array { var rows:Array=[];for each(var p:Object in projection.localRules.prizes)rows.push(model().carCnfDic[p.id]);return rows; }
    private function render():void {
      if(!cardView)return;var rows:Array=[];for(var i:int=1;i<=32;i++)rows.push(model().cardDic[i]);cardView.cardList.array=rows;
      renderPool(cardView.poolList,rewardRows());counts();renderShop();
    }
    private function counts():void {
      if(!cardView)return;var p:Object=projection;
      cardView.timeLab.text=p.started?"本地常驻 · 第 "+p.round+" 局 · 今日剩余 "+p.flipsRemaining+" 次揭牌":"本地常驻 · 点击开始创建牌局";
      cardView.reelDescLab1.text="每日免费券";cardView.reelNumTxt1.text=": "+(p.started?p.freeReelCount:0);cardView.reelNumTxt2.text=": "+(p.started?p.reelCount:0);
      cardView.shopMoneyLab.text="印记: "+(p.started?p.markCount:0);cardView.quickBuyLab.text="积分补足须确认";cardView.quickBuySelect.selected=false;cardView.quickBuySelect.disabled=true;
      cardView.oneKeyMoneyImg.visible=false;cardView.oneKeyNeedLab.text="";
      cardView.resetBtn.label=p.started?"重置":"开始";cardView.resetBtn.labelSize=14;cardView.resetBtn.labelColors="0xffffff";
      if(shopView) { shopView.scoreLab.text="印记: "+(p.started?p.markCount:0);shopView.timeLab.text="本地材料兑换 · 奖励发到邮件"; }
      lock();
    }
    private function lock():void {
      if(!cardView)return;var busy:Boolean=pending||animating;
      cardView.cardList.mouseChildren=!busy&&Boolean(projection&&projection.started);
      cardView.oneKeyBtn.disabled=busy||!projection||!projection.started||projection.isAllOpen;
      cardView.buyReel2Btn.disabled=busy||!projection||!projection.started||int(projection.buyRemaining)<=0;
      cardView.resetBtn.disabled=busy||!projection||(projection.started&&!projection.canFreeReset&&!projection.canPointsReset);
      if(shopView)shopView.shopList.mouseChildren=!busy&&Boolean(projection&&projection.started);
      if(modal)modal.mouseChildren=!busy;
    }
    private function flip(pos:int):void {
      if(pending||animating||!projection.started||projection.cards[pos-1].ID!=-1)return;
      if(int(projection.freeReelCount)+int(projection.reelCount)>0)request({type:"flip",index:pos,choice:"tickets"});
      else confirmAction({type:"flip",index:pos,choice:"points"},"揭开此牌需要 "+projection.localRules.flipPointCost+" 活动积分。",false);
    }
    private function confirmAction(action:Object,text:String,quantity:Boolean):void {
      closeModal();modal=instance("pairBox.view.PairBoxShopAlert");local[modal]={action:action,quantity:quantity};modal.tipMsgLab.text=text;modal.buyCountInput.text="1";modal.buyCountInput.visible=quantity;show(modal);
    }
    private function reset():void {
      if(!projection.started){request({type:"start"});return;}
      if(projection.canFreeReset)confirmAction({type:"reset",choice:"free"},"已揭完全部卡牌。使用一次免费重置？",false);
      else if(projection.canPointsReset)confirmAction({type:"reset",choice:"points"},"重置需要 "+projection.localRules.resetPointCost+" 活动积分。",false);
    }
    private function animateSingle(effects:Array):void {
      var reveal:Object=null;for each(var e:Object in effects)if(e.type=="revealed")reveal=e;
      if(!reveal){render();return;}var pos:int=int(reveal.pos), c:Object=projection.cards[pos-1], cell:Object=cardView.cardList.getCell(pos-1);
      if(!cell||!cell.mcEnable){render();return;}
      if(c.isGet) { var partner:Object=cardView.cardList.getCell(int(c.otherPos)-1);if(partner)partner.setInfo(model().cardDic[c.otherPos],true); }
      animating=true;counts();
      var done:Function=function(e:Event):void { cell.removeEventListener(Event.COMPLETE,done);animating=false;if(main)render();report(); };
      cell.addEventListener(Event.COMPLETE,done);cell.play(int(c.ID),Boolean(c.isGet));
    }
    private function animateReset():void {
      if(!resetMovie)return;animating=true;resetMovie.visible=true;resetMovie.gotoAndPlay(1);lock();
      resetListener=function(e:Event):void { if(resetMovie&&resetMovie.currentFrame==resetMovie.totalFrames){resetMovie.removeEventListener(Event.ENTER_FRAME,resetListener);resetListener=null;resetMovie.stop();resetMovie.visible=false;animating=false;lock();report();} };
      resetMovie.addEventListener(Event.ENTER_FRAME,resetListener);
    }
    private function showRewards(effects:Array):void {
      var counts:Object={},rows:Array=[];for each(var e:Object in effects)if(e.type=="matched")counts[e.ID]=int(counts[e.ID])+1;
      for(var key:String in counts){var original:Object=model().carCnfDic[int(key)],row:Object=instance("pairBox.data.PairBoxCardItemCnfInfo");row.ID=original.ID;row.TemplateID=original.TemplateID;row.Count=counts[key];row.Type=1;row.IsBind=true;row.IsArea=1;rows.push(row);}
      if(!rows.length)return;closeModal();modal=instance("pairBox.view.PairBoxOneKeyRewardView");renderPool(modal.poolList,rows);show(modal);
    }
    private function renderShop():void {
      if(!shopView)return;var items:Array=projection.localRules.prizes;
      shopView.shopList.renderHandler=handler(function(cell:Object,index:int):void {
        cell.visible=index<items.length;if(!cell.visible)return;var prize:Object=items[index];if(!local[cell])local[cell]={};local[cell].prize=prize;
        cell.nameLabel.text=prize.name;cell.coinLabel.text=prize.markCost;cell.markName.text="印记";
        var data:Object=local[cell];if(!data.bag){var C:Class=cls("bagAndInfo.cell.BagCell") as Class;data.bag=new C(0);data.bag.setContentSize(58,58);cell.cellBox.addChild(data.bag);}
        data.bag.info=fillInventory(int(prize.templateId));
        button(cell.exchangeBtn,function():void {confirmAction({type:"exchange",choice:String(prize.templateId),count:1},prize.name+"：每件 "+prize.markCost+" 印记，最多 10 件。",true);});
      });shopView.shopList.array=items;shopView.selectPage.visible=false;
    }
    private function init(owner:String,o:Object):void {
      if(owner=="PairBoxMainView") { button(o.closeBtn,function():void{closeNative();});o.viewTab.selectHandler=handler(function(index:int):void{o.cardView.visible=index==0;o.shopView.visible=index==1;});o.viewTab.selectedIndex=0;o.shopView.visible=false;button(o.helpBtn,function():void{say(projection.localRules.description+" 配对奖品发到邮件；每日免费券 "+projection.localRules.freeReelsPerDay+" 张。积分操作每次确认。");}); }
      else if(owner=="PairBoxCardView") {
        cardView=o;o.cardList.renderHandler=handler(function(cell:Object,index:int):void {var row:Object=model().cardDic[index+1];cell.setInfo(row,false);cell.removeEventListener(MouseEvent.CLICK,cardClick);cell.addEventListener(MouseEvent.CLICK,cardClick);});
        button(o.oneKeyBtn,function():void{closeModal();modal=instance("pairBox.view.PairBoxOneKeyAlert");show(modal);});button(o.resetBtn,reset);button(o.buyReel2Btn,function():void{closeModal();modal=instance("pairBox.view.PairBoxReelBuyView");show(modal);});
        var C:Class=cls("asset.pairBox.resetMove") as Class;resetMovie=new C() as MovieClip;resetMovie.x=-217;resetMovie.y=-194;resetMovie.stop();resetMovie.visible=false;o.mcBox.addChild(resetMovie);
        o.reelImg1.tipStyle="";o.reelImg2.tipStyle="";o.markImg.tipStyle="";
      } else if(owner=="PairBoxShopView")shopView=o;
      else if(owner=="PairBoxShopAlert") {
        o.buyCountInput.text="1";button(o.closeBtn,closeModal);button(o.cancelBtn,closeModal);
        button(o.confirmBtn,function():void {var data:Object=local[o];if(!data)return;var a:Object=data.action;if(data.quantity){var count:int=int(o.buyCountInput.text);if(count<1||count>10){say("每次兑换 1 至 10 件。");return;}a.count=count;}closeModal();request(a);});
      } else if(owner=="PairBoxOneKeyAlert") {
        o.quickBuySelect.visible=false;o.descLab.visible=false;o.moneyImg.visible=false;o.conditionGroup.selectedIndex=0;
        var tickets:int=int(projection.freeReelCount)+int(projection.reelCount),remaining:int=int(projection.hiddenRemaining),cost:int=Math.max(0,remaining-tickets)*int(projection.localRules.flipPointCost);
        o.descLab1.text="仅使用免费券和卷轴";o.descLab2.text="最多揭开 "+Math.min(tickets,remaining)+" 张";o.descLab3.text="积分补足：最多 "+cost+" 积分";o.descLab4.text="揭开全部剩余卡牌";
        button(o.closeBtn,closeModal);button(o.confirmBtn,function():void {var choice:String=int(o.conditionGroup.selectedIndex)==0?"tickets":"points";closeModal();request({type:"flip-all",choice:choice});});
      } else if(owner=="PairBoxOneKeyRewardView") {o.quickBuySelect.visible=false;o.descLab.text="奖励已发至邮件";button(o.affirmBtn,closeModal);button(o.closeBtn,closeModal);}
      else if(owner=="PairBoxReelBuyView") {
        o.numInputText.text="1";o.conditionGroup.visible=false;o.moneyName.text="活动积分";o.limitLab.text="今日还可购 "+projection.buyRemaining+" 张";
        var update:Function=function(e:Event=null):void {o.moneyLabel.text=String(int(o.numInputText.text)*int(projection.localRules.reelPointCost));};
        button(o.addBtn,function():void{o.numInputText.text=String(Math.min(int(projection.buyRemaining),64,int(o.numInputText.text)+1));update();});button(o.subtractBtn,function():void{o.numInputText.text=String(Math.max(1,int(o.numInputText.text)-1));update();});o.numInputText.addEventListener(Event.CHANGE,update);
        button(o.closeBtn,closeModal);button(o.affirmBtn,function():void{var count:int=int(o.numInputText.text);if(count<1||count>64||count>int(projection.buyRemaining)){say("购买数量超过本地限额。");return;}closeModal();request({type:"buy-reels",count:count});});update();
      }
      replaceLabels(o);
    }
    private function cardClick(e:MouseEvent):void { flip(int(Object(e.currentTarget).pos)); }
    private function replaceLabels(o:Object):void {
      if(o.hasOwnProperty("text")) {var t:String=String(o.text);if(t=="点券可无限购买")o.text="每张消耗 2 活动积分";else if(t=="注：不限量购买")o.text="本地兑换，每次最多 10 件";else if(t=="购买提示")o.text="本地操作确认";else if(t=="大奖池中所有的奖励可能出现在牌堆中")o.text="本地材料奖池\n配对奖励发到邮件";}
      var container:DisplayObjectContainer=o as DisplayObjectContainer;if(container)for(var i:int=0;i<container.numChildren;i++)replaceLabels(container.getChildAt(i));
    }
    private function invoke(owner:String,method:String,self:Object,args:Array):* {
      var name:String=owner.substr(owner.lastIndexOf("/")+1);
      if(method=="initialize"){init(name,self);return null;}
      if(method=="dispose") {if(self===resetMovie)resetMovie=null;if(self is DisplayObject&&DisplayObject(self).parent)DisplayObject(self).parent.removeChild(DisplayObject(self));delete local[self];return null;}
      if(method=="manager"||method=="_manager")return manager();
      if(name=="PairBoxManager") {
        if(method=="getRemainCardNum")return projection&&projection.started?int(projection.hiddenRemaining):32;
        if(method=="getBigRewardPoolArr")return projection?rewardRows():[];
        if(method=="poolCompare")return 0;
        if(method=="openView"||method=="sendGetAllPairBoxInfo")openNative();
        // All legacy protocol handlers, pay helpers and automatic reset methods are inert.
        return null;
      }
      // Original handlers are replaced with local closures during initialize; they cannot send legacy packets.
      return null;
    }
    public static function dispatch(owner:String,method:String,self:Object,args:Array):* {
      if(!active)throw new Error("配对本地桥接未初始化。");return active.invoke(owner,method,self,args);
    }
    public static function fillInventory(templateId:int):Object {
      if(!active)throw new Error("配对本地桥接未初始化。");
      var info:Object=active.instance("ddt.data.goods.InventoryItemInfo");info.TemplateID=templateId;
      active.cls("ddt.manager.ItemManager").fill(info);return info;
    }
  }
}
