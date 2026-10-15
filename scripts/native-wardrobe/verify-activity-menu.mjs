// Actual AS source extraction with host doubles. This is not an AVM2, pixel, or installation test.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const sha=s=>createHash('sha256').update(s).digest('hex');
function method(source,name){
 const prefix=new RegExp('(?:private|public) static function '+name+'\\(([^)]*)\\):\\w+\\s*\\{','g'),match=prefix.exec(source);assert(match,name);
 let depth=1,end=prefix.lastIndex;for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
 assert.equal(depth,0);return `function ${name}(${match[1]}){${source.slice(prefix.lastIndex,end-1)}}`;
}
function translate(code){return code
 .replace(/for each\(var (\w+):\w+ in ([^\n]*?)\)/g,'for(var $1 of $2)')
 .replace(/(\w+):(?:Object|Array|String|Boolean|Class|Sprite|TextField|TextFormat|DisplayObject|BitmapData|Bitmap|Event|KeyboardEvent|MouseEvent|IOErrorEvent|SecurityErrorEvent|UncaughtErrorEvent|TimerEvent|ApplicationDomain|Loader|LoaderContext|Timer|int|Number|Function|Error)(?=[,)=;\s])/g,'$1')
 .replace(/\):void/g,')').replace(/new type\(0,0\) as BitmapData/g,'asBitmapData(new type(0,0))')
 .replace(/\bas (?:DisplayObject|Class|LoaderContext)\b/g,'').replace(/\bis DisplayObject\b/g,'instanceof DisplayObject');}
export function verifyActivityMenu(source){
 const names=['verifyRole','menuAlive','menuKind','menuLabel','menuButton','menuBind','menuBitmap','menuIcon','menuBackground','renderMenuArt','menuArtFail','ensureMenuArt','disposeMenu','openActivityMenu','statusActivityMenu','closeActivityMenu','activityMenuResult','ensureRoot'];
 const original=names.map(name=>method(source,name)).join('\n'),code=translate(original),items=JSON.parse(source.match(/MENU_ITEMS:Array\s*=\s*(\[[\s\S]*?\n  \]);/)[1]);
 const artSpecText=readFileSync(new URL('../native-menu/source-spec.json',import.meta.url),'utf8'),artSpec=JSON.parse(artSpecText);
 assert.equal(items.length,16);assert.equal(new Set(items.map(x=>x[0])).size,16);assert.equal(artSpec.rows.length,18);
 assert.equal(new Set(artSpec.rows.map(x=>x.exportClass)).size,18);
 for(const item of items)assert(artSpec.rows.some(row=>row.kind===item[0]&&row.exportClass==='workshop.menu.art.'+item[2]),'exact owned art export: '+item[0]);
 assert(!/fetch\(|\.request\(|\.read\(|sendBuy|sendEnter/.test(original),'menu must not send an economic or gameplay request');
 assert.equal((original.match(/new URLRequest\(/g)||[]).length,1,'only the owned art SWF can be loaded');
 assert(original.includes('new URLRequest(root+"menu/hall-activity-original-art.swf")'));
 assert(original.includes('var full:String="workshop.menu.art."+name;'),'host same-name classes cannot satisfy the owned namespace');
 const run=new Function('context','with(context){'+code+';return {openActivityMenu,statusActivityMenu,closeActivityMenu,activityMenuResult,menuAlive};}'),rows=[];
 function fixture({cold=false}={}){
  const calls=[],createdBitmaps=[],loaders=[],timers=[],domains=[];
  class Emitter{
   constructor(){this.listeners=new Map();}
   addEventListener(type,listener){assert.equal(typeof listener,'function');const list=this.listeners.get(type)||[];list.push(listener);this.listeners.set(type,list);}
   removeEventListener(type,listener){assert.equal(typeof listener,'function');const list=this.listeners.get(type)||[],i=list.indexOf(listener);if(i>=0)list.splice(i,1);}
   emit(type,event={}){for(const listener of [...(this.listeners.get(type)||[])])listener(event);}
  }
  const stage=Object.assign(new Emitter(),{stageWidth:1000,stageHeight:600});
  class DisplayObject extends Emitter{constructor(){super();this.parent=null;this.stage=null;this.visible=true;this.x=0;this.y=0;this.scaleX=1;this.scaleY=1;this.transform={colorTransform:null};}}
  function setStage(view,next){view.stage=next;for(const child of view.children||[])setStage(child,next);}
  class Sprite extends DisplayObject{
   constructor(){super();this.children=[];this.graphics={commands:[],beginFill(...a){this.commands.push(['fill',...a]);},lineStyle(...a){this.commands.push(['line',...a]);},drawRect(...a){this.commands.push(['rect',...a]);},drawRoundRect(...a){this.commands.push(['round',...a]);},endFill(){}};}
   get numChildren(){return this.children.length;}
   addChild(child){return this.addChildAt(child,this.children.length);}
   addChildAt(child,index){if(child.parent)child.parent.removeChild(child);this.children.splice(index,0,child);child.parent=this;setStage(child,this.stage);return child;}
   removeChild(child){const i=this.children.indexOf(child);assert(i>=0,'remove only an owned child');this.children.splice(i,1);child.parent=null;setStage(child,null);return child;}
  }
  class BitmapData{
   constructor(width,height,transparent=true,fill=0){this.width=width;this.height=height;this.transparent=transparent;this.fill=fill;this.disposed=false;this.draws=[];createdBitmaps.push(this);}
   draw(source,matrix,color,blend,clip,smoothing){assert(!this.disposed&&!source.disposed);this.draws.push({source,matrix,clip,smoothing});}
   dispose(){assert(!this.disposed,'BitmapData must be disposed once');this.disposed=true;}
  }
  class Bitmap extends DisplayObject{
   constructor(pixels){super();assert(pixels instanceof BitmapData);this.bitmapData=pixels;this.sizeWrites=[];}
   get width(){return this.bitmapData.width*this.scaleX;}set width(value){this.sizeWrites.push(['width',value]);this.scaleX=value/this.bitmapData.width;}
   get height(){return this.bitmapData.height*this.scaleY;}set height(value){this.sizeWrites.push(['height',value]);this.scaleY=value/this.bitmapData.height;}
  }
  class TextField extends DisplayObject{}
  const hostDomain={name:'host-domain',hasDefinition:()=>false};
  class ApplicationDomain{
   static currentDomain=hostDomain;
   constructor(parent){this.parentDomain=parent;this.definitions=new Map();domains.push(this);}
   hasDefinition(name){return this.definitions.has(name);}
   getDefinition(name){assert(this.definitions.has(name),'missing owned definition '+name);return this.definitions.get(name);}
  }
  const definitions=new Map(artSpec.rows.map(row=>[row.exportClass,class extends BitmapData{constructor(w,h){assert.deepEqual([w,h],[0,0]);super(row.width,row.height);this.sourceSymbol=row.sourceSymbol;}}]));
  const populate=domain=>{for(const [name,type]of definitions)domain.definitions.set(name,type);};
  class Loader extends DisplayObject{
   constructor(){super();this.contentLoaderInfo=new Emitter();this.contentLoaderInfo.uncaughtErrorEvents=new Emitter();loaders.push(this);}
   load(request,loadContext){assert.equal(request.url,'http://127.0.0.1:19080/flash/workshop-native/menu/hall-activity-original-art.swf');assert.equal(loadContext.checkPolicyFile,false);assert.equal(loadContext.allowCodeImport,true);this.request=request;this.context=loadContext;}
  }
  class Timer extends Emitter{constructor(delay,count){super();assert.deepEqual([delay,count],[30000,1]);this.delay=delay;this.repeatCount=count;this.running=false;timers.push(this);}start(){this.running=true;}stop(){this.running=false;}}
  const layer=new Sprite();layer.stage=stage;
  const self={ID:40,ZoneID:2},sharedDomain={name:'shared-domain'},classes={
   'ddt.manager.PlayerManager':{Instance:{Self:self}},'ddt.manager.StateManager':{currentStateType:'main'},
   'ddt.manager.PathManager':{FLASHSITE:'http://127.0.0.1:19080/flash/'},'com.pickgliss.loader.DisplayLoader':{Context:{applicationDomain:sharedDomain}},
   'com.pickgliss.ui.LayerManager':{Instance:{addToLayer(panel,...args){assert.deepEqual(args,[3,false,0]);layer.addChild(panel);}}}
  };
  let artDomain=null;if(!cold){artDomain=new ApplicationDomain(hostDomain);populate(artDomain);}
  const context={activityMenu:null,menuMessage:'',menuArtDomain:artDomain,menuArtLoader:null,menuArtTimer:null,menuArtPhase:cold?'idle':'ready',menuArtError:'',actual:0,expected:0,domain:null,hostContext:null,root:null,
   displayDomain(){return sharedDomain;},clientClass(name){assert(Object.hasOwn(classes,name),name);return classes[name];},MENU_ITEMS:items,
   Sprite,DisplayObject,BitmapData,Bitmap,TextField,TextFormat:class{},ApplicationDomain,Loader,Timer,
   LoaderContext:class{constructor(checkPolicyFile,applicationDomain){this.checkPolicyFile=checkPolicyFile;this.applicationDomain=applicationDomain;}},URLRequest:class{constructor(url){this.url=url;}},
   Rectangle:class{constructor(x,y,width,height){Object.assign(this,{x,y,width,height});}},Matrix:class{constructor(a,b,c,d,tx,ty){Object.assign(this,{a,b,c,d,tx,ty});}},ColorTransform:class{constructor(...values){this.values=values;}},
   asBitmapData:value=>value instanceof BitmapData?value:null,int:Math.trunc,Event:{ENTER_FRAME:'frame',COMPLETE:'complete'},MouseEvent:{CLICK:'click',ROLL_OVER:'over',ROLL_OUT:'out'},KeyboardEvent:{KEY_DOWN:'keydown'},IOErrorEvent:{IO_ERROR:'io-error'},SecurityErrorEvent:{SECURITY_ERROR:'security-error'},UncaughtErrorEvent:{UNCAUGHT_ERROR:'uncaught-error'},TimerEvent:{TIMER_COMPLETE:'timeout'},
   ExternalInterface:{available:true,call(...args){calls.push(args);return true;}}
  };
  for(const kind of ['wardrobe','pair','mines','ddplay','gypsy','moonlight','treasure','purr','carnival','firstRecharge','charge','forthright','exchange','devil','caveloot','christmas'])context[kind]={phase:'registered',wantOpen:false,module:null};
  const api=run(context);return{api,context,classes,self,calls,layer,stage,sharedDomain,hostDomain,createdBitmaps,loaders,timers,domains,definitions,Bitmap,TextField,
   click(kind){const m=context.activityMenu,c=m.controls.find(x=>x.kind===kind);assert(c,kind);c.view.emit('click',{stopImmediatePropagation(){}});},
   complete(){assert(loaders.length);populate(context.menuArtDomain);loaders.at(-1).contentLoaderInfo.emit('complete');},
   timeout(){assert(timers.length);timers.at(-1).running=false;timers.at(-1).emit('timeout');}
  };
 }
 const check=(name,test,options)=>{test(fixture(options));rows.push(name);},token='8b4dfe8d-1aa7-4b51-af92-3622a8743a45',next=token.replace('8b4d','ab4d');
 const icons=m=>m.controls.filter(c=>!['more','activation','close'].includes(c.kind));
 const selected=f=>f.calls.filter(c=>c[0]==='workshopSelectNativeActivity');
 const closed=f=>f.calls.filter(c=>c[0]==='workshopActivityMenuClosed');
 const allDisposed=f=>assert(f.createdBitmaps.every(bitmap=>bitmap.disposed));
 check('warm art renders 17 original Bitmap icons without caption overlays or scaling, plus 3 auxiliary controls',f=>{
  assert(f.api.openActivityMenu(40,token));const m=f.context.activityMenu,entries=icons(m);assert.equal(m.controls.length,20);assert.equal(entries.length,17);assert.equal(m.bitmaps.length,18);assert.deepEqual([m.background.width,m.background.height],[330,450]);
  assert.equal(m.extra.visible,false);assert.equal(m.extraCaption.visible,false);assert.deepEqual(entries.slice(0,4).map(c=>c.view.x),[5,85,165,245]);assert.equal(entries[4].view.y,85);assert.equal(entries.at(-1).view.y,325);
  for(const entry of entries){assert.equal(entry.caption,null);assert.equal(entry.view.children.length,1);const art=entry.view.children[0];assert(art instanceof f.Bitmap);assert.deepEqual([art.scaleX,art.scaleY],[1,1]);assert.deepEqual(art.sizeWrites,[]);assert.deepEqual([art.x,art.y],[Math.trunc((80-art.width)/2),Math.trunc((80-art.height)/2)]);assert.equal(entry.view.mouseChildren,false);}
  assert.equal(m.panel.children.filter(child=>child instanceof f.TextField).length,4);assert.equal(f.loaders.length,0);assert.equal(f.calls.length,0);assert.equal(f.api.statusActivityMenu().artReady,true);
 });
 check('background uses the actual 34/30/34/30 nine-slice with unchanged corners and 330 by 450 destination',f=>{
  f.api.openActivityMenu(40,token);const background=f.context.activityMenu.background.bitmapData;assert.equal(background.draws.length,9);
  assert.deepEqual(background.draws.map(({clip:c})=>[c.x,c.y,c.width,c.height]),[[0,0,34,30],[34,0,262,30],[296,0,34,30],[0,30,34,390],[34,30,262,390],[296,30,34,390],[0,420,34,30],[34,420,262,30],[296,420,34,30]]);
  assert(background.draws.every(draw=>draw.smoothing===true));assert.equal(background.draws[4].matrix.a,131);assert.equal(background.draws[4].matrix.d,390);assert.equal(background.draws[0].source.disposed,true);
 });
 for(const [label,mutate]of [['role',f=>f.self.ID=41],['same-ID Self replacement',f=>f.classes['ddt.manager.PlayerManager'].Instance.Self={...f.self}],['zone',f=>f.self.ZoneID=3],['non-hall state',f=>f.classes['ddt.manager.StateManager'].currentStateType='dungeonRoom'],['bound role',f=>f.context.expected=41],['removed panel',f=>f.layer.removeChild(f.context.activityMenu.root)],['stage replacement',f=>f.context.activityMenu.root.stage={}]])check(label+' refuses late result and disposes the menu',f=>{f.api.openActivityMenu(40,token);f.click('carnival');mutate(f);assert.equal(f.api.activityMenuResult(40,token,'carnival',true,''),false);assert.equal(f.api.statusActivityMenu().open,false);assert.equal(closed(f).length,1);allDisposed(f);});
 for(const value of ['', 'old', 'a'.repeat(161)])check('invalid nonce '+value.slice(0,8)+' refuses without constructing UI or pixels',f=>{assert.equal(f.api.openActivityMenu(40,value),false);assert.equal(f.layer.children.length,0);assert.equal(f.createdBitmaps.length,0);});
 for(const kind of ['unknown','__proto__'])check('unknown selection '+kind+' refuses',f=>{f.api.openActivityMenu(40,token);assert.equal(f.api.activityMenuResult(40,token,kind,true,''),false);assert(f.api.statusActivityMenu().open);});
 check('pending selection is single, failure supports explicit retry, success only closes menu',f=>{f.api.openActivityMenu(40,token);f.click('carnival');f.click('moonlight');assert.deepEqual(selected(f),[['workshopSelectNativeActivity',40,token,'carnival']]);assert.equal(f.api.activityMenuResult(40,'old','carnival',true,''),false);assert.equal(f.api.activityMenuResult(41,token,'carnival',true,''),false);assert.equal(f.api.activityMenuResult(40,token,'moonlight',true,''),false);assert(f.api.activityMenuResult(40,token,'carnival',false,'请重试'));assert.equal(f.context.activityMenu.message.text,'请重试');f.click('carnival');assert(f.api.activityMenuResult(40,token,'carnival',true,''));assert.equal(f.api.statusActivityMenu().open,false);assert.equal(closed(f).length,0);allDisposed(f);});
 check('closing pending exact nonce cancels once; stale close cannot touch reopened menu',f=>{f.api.openActivityMenu(40,token);f.click('carnival');assert.equal(f.api.closeActivityMenu('old'),false);assert(f.api.closeActivityMenu(token));assert.equal(f.api.closeActivityMenu(token),false);assert.equal(closed(f).length,1);assert(f.api.openActivityMenu(40,next));assert.equal(f.api.activityMenuResult(40,token,'carnival',true,''),false);assert.equal(f.api.closeActivityMenu(token),false);assert(f.api.statusActivityMenu().open);});
 for(const state of [{pending:true},{animating:true},{open:true},{visible:true},null])check('existing activity '+JSON.stringify(state)+' is never cancelled',f=>{let closes=0;f.context.carnival.module={statusNative:()=>state,closeNative:()=>closes++};assert.equal(f.api.openActivityMenu(40,token),false);assert.equal(closes,0);assert.equal(f.layer.children.length,0);assert.equal(f.createdBitmaps.length,0);});
 for(const phase of ['waiting-shared','loading'])check('existing '+phase+' module is never cancelled',f=>{f.context.carnival.phase=phase;assert.equal(f.api.openActivityMenu(40,token),false);assert.equal(f.layer.children.length,0);});
 for(const [label,mutate]of [['missing native layer',f=>delete f.classes['com.pickgliss.ui.LayerManager']],['unattached native layer',f=>f.classes['com.pickgliss.ui.LayerManager'].Instance.addToLayer=()=>{}]])check(label+' cleans partial UI without unbound listener removal',f=>{mutate(f);assert.equal(f.api.openActivityMenu(40,token),false);assert.equal(f.layer.children.length,0);assert.equal(f.api.statusActivityMenu().open,false);assert.equal(f.createdBitmaps.length,0);});
 check('unavailable EI clears pending without opening anything',f=>{f.api.openActivityMenu(40,token);f.context.ExternalInterface.available=false;f.click('carnival');assert.equal(f.api.statusActivityMenu().pending,false);assert.equal(selected(f).length,0);});
 check('more toggles only activation view and caption without selecting or loading',f=>{f.api.openActivityMenu(40,token);f.click('more');assert.equal(f.context.activityMenu.extra.visible,true);assert.equal(f.context.activityMenu.extraCaption.visible,true);f.click('more');assert.equal(f.context.activityMenu.extra.visible,false);assert.equal(f.context.activityMenu.extraCaption.visible,false);assert.equal(f.calls.length,0);assert.equal(f.loaders.length,0);});
 check('cold loader is cancellable and uses one child art domain; auxiliary controls bind before completion',f=>{
  assert(f.api.openActivityMenu(40,token));const m=f.context.activityMenu;assert.equal(m.controls.length,3);assert.equal(m.bitmaps.length,0);assert.equal(f.api.statusActivityMenu().artReady,false);assert.equal(f.api.statusActivityMenu().artPhase,'loading');assert.equal(f.loaders.length,1);assert.equal(f.timers.length,1);assert(f.timers[0].running);
  assert.notEqual(f.context.menuArtDomain,f.sharedDomain);assert.equal(f.context.menuArtDomain.parentDomain,f.hostDomain);f.click('more');assert.equal(m.extra.visible,true);assert.equal(m.extraCaption.visible,true);assert.equal(selected(f).length,0);
  assert(f.api.openActivityMenu(40,token));assert.equal(f.loaders.length,1);f.complete();assert.equal(f.context.activityMenu,m);assert.equal(m.controls.length,20);assert.equal(icons(m).length,17);assert.equal(f.api.statusActivityMenu().artReady,true);assert.equal(f.context.menuArtPhase,'ready');assert.equal(f.timers[0].running,false);
 },{cold:true});
 check('close before complete only warms the cache and never resurrects the old panel',f=>{f.api.openActivityMenu(40,token);const old=f.context.activityMenu;assert(f.api.closeActivityMenu(token));f.complete();assert.equal(f.context.activityMenu,null);assert.equal(old.controls.length,3);assert.equal(old.artReady,false);assert.equal(f.layer.children.length,0);assert.equal(closed(f).length,1);assert.equal(selected(f).length,0);assert.equal(f.context.menuArtPhase,'ready');allDisposed(f);},{cold:true});
 check('reopen while loading renders only the current nonce and duplicate complete cannot render twice',f=>{f.api.openActivityMenu(40,token);const old=f.context.activityMenu;f.api.closeActivityMenu(token);assert(f.api.openActivityMenu(40,next));const current=f.context.activityMenu;assert.equal(f.loaders.length,1);f.complete();assert.equal(old.controls.length,3);assert.equal(old.artReady,false);assert.equal(current.controls.length,20);const count=f.createdBitmaps.length;f.complete();assert.equal(f.createdBitmaps.length,count);assert.equal(f.api.closeActivityMenu(token),false);assert(f.api.closeActivityMenu(next));allDisposed(f);},{cold:true});
 check('reopen after a closed load completes explicitly reuses ready art without another loader',f=>{f.api.openActivityMenu(40,token);f.api.closeActivityMenu(token);f.complete();assert(f.api.openActivityMenu(40,next));assert.equal(f.context.activityMenu.controls.length,20);assert.equal(f.loaders.length,1);assert.equal(selected(f).length,0);},{cold:true});
 check('timeout rejects late completion and reopening does not silently retry failed art',f=>{f.api.openActivityMenu(40,token);f.timeout();assert.equal(f.context.menuArtPhase,'failed');assert.equal(f.context.activityMenu.controls.length,3);assert.match(f.context.activityMenu.message.text,/重新进入游戏/);f.complete();assert.equal(f.createdBitmaps.length,0);assert.equal(f.api.statusActivityMenu().artReady,false);f.api.closeActivityMenu(token);assert(f.api.openActivityMenu(40,next));assert.equal(f.context.menuArtPhase,'failed');assert.equal(f.context.activityMenu.controls.length,3);assert.equal(f.loaders.length,1);assert.equal(selected(f).length,0);},{cold:true});
 check('a missing owned art class fails validation without rendering fallback activity buttons',f=>{f.api.openActivityMenu(40,token);f.definitions.delete('workshop.menu.art.cavelootBtn');f.complete();assert.equal(f.context.menuArtPhase,'failed');assert.equal(f.context.activityMenu.controls.length,3);assert.equal(f.context.activityMenu.artReady,false);assert.equal(selected(f).length,0);allDisposed(f);},{cold:true});
 for(const [label,mutate]of [['role',f=>f.self.ID=41],['same-ID Self replacement',f=>f.classes['ddt.manager.PlayerManager'].Instance.Self={...f.self}],['zone',f=>f.self.ZoneID=3],['non-hall state',f=>f.classes['ddt.manager.StateManager'].currentStateType='dungeonRoom']])check('cold '+label+' change cannot render late art or open an activity',f=>{f.api.openActivityMenu(40,token);const old=f.context.activityMenu;mutate(f);f.complete();assert.equal(old.controls.length,3);assert.equal(old.artReady,false);old.root.emit('frame');assert.equal(f.api.statusActivityMenu().open,false);assert.equal(f.layer.children.length,0);assert.equal(closed(f).length,1);assert.equal(selected(f).length,0);allDisposed(f);},{cold:true});
 for(const type of ['io-error','security-error','uncaught-error'])check(type+' fails explicitly and ignores a later complete event',f=>{f.api.openActivityMenu(40,token);const info=f.loaders[0].contentLoaderInfo;(type==='uncaught-error'?info.uncaughtErrorEvents:info).emit(type,{text:'test failure',error:Error('test failure')});assert.equal(f.context.menuArtPhase,'failed');assert.equal(f.timers[0].running,false);f.complete();assert.equal(f.createdBitmaps.length,0);assert.equal(f.context.activityMenu.controls.length,3);assert.equal(selected(f).length,0);},{cold:true});
 return{sourceSha256:sha(source),artSpecSha256:sha(artSpecText),extractedMethods:names,methodBodiesSha256:sha(original),method:'Mechanically extracted AS3 methods with BitmapData, display-domain, loader, timer and event doubles; not AVM2, pixels or installation',count:rows.length,rows,runtimeVerified:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(verifyActivityMenu(readFileSync(resolve(process.argv[2]??'scripts/native-wardrobe/WorkshopNativeWardrobeBridge.as'),'utf8')),null,2));
