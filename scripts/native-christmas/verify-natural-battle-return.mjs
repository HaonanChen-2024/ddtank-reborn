// Execute mechanically extracted AS lifecycle owners with bounded host/event doubles; not AVM2.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const sha=text=>createHash('sha256').update(text).digest('hex');
function extract(source,name){
 const match=new RegExp('(?:private|public) function '+name+'\\(([^)]*)\\):[\\w*]+\\s*\\{').exec(source);assert(match,'actual AS method '+name);
 let depth=1,quote='',line=false,block=false,end=match.index+match[0].length;
 for(;end<source.length&&depth;end++){
  const c=source[end],n=source[end+1];
  if(line){if(c==='\n')line=false;continue;}if(block){if(c==='*'&&n==='/'){block=false;end++;}continue;}
  if(quote){if(c==='\\'){end++;continue;}if(c===quote)quote='';continue;}
  if(c==='/'&&n==='/'){line=true;end++;continue;}if(c==='/'&&n==='*'){block=true;end++;continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='{')depth++;else if(c==='}')depth--;
 }
 assert.equal(depth,0,name+' closes');const body=source.slice(match.index+match[0].length,end-1);
 const translate=text=>text.replace(/for each\(var (\w+):\w+ in ([^)]+)\)/g,'for(var $1 of $2)').replace(/\b([A-Za-z_$]\w*):(?:Object|int|uint|Boolean|Number|String|Function|Event|TimerEvent|Error|DisplayObject|Sprite|Array|LoaderContext|\*)(?=\s*(?:[=,;)]|$))/g,'$1').replace(/\)\s*:(?:void|Object|Boolean|int|Number|String|\*)\s*\{/g,'){').replace(/\s+as (?:DisplayObject|Sprite|Array|LoaderContext)\b/g,'').replace(/\bis (DisplayObject|Sprite|Array)\b/g,'instanceof $1').replace(/\bint\(/g,'Math.trunc(');
 const javascript=translate(body),args=translate(match[1]),factory=new Function('context',`return function(${args}){with(context){${javascript}}}`);
 return{name,sourceSha256:sha(body),javascriptSha256:sha(javascript),factory};
}

class Dispatcher{
 constructor(name){this.name=name;this.listeners=[];this.history=[];this.stage=null;}
 addEventListener(type,fn,capture=false,priority=0){assert.equal(capture,false);assert.equal(typeof fn,'function');const row={type,fn,priority,order:this.history.length};this.history.push(row);this.listeners.push(row);}
 removeEventListener(type,fn){this.listeners=this.listeners.filter(r=>r.type!==type||r.fn!==fn);}
 dispatch(type,event={}){const e={type,target:this,currentTarget:this,...event};for(const row of this.listeners.filter(r=>r.type===type).sort((a,b)=>b.priority-a.priority||a.order-b.order)){if(this.listeners.includes(row))row.fn(e);}}
}

function fixture(methods,index=0){
 const sent=[],bridge=[],trace=[],messages=[],view=new Dispatcher('HallView'),socket=new Dispatcher('SocketManager');let readAccepted=true,readThrows=false,sendFailure='',nextOwner=0;
 const room={ID:201,type:40,mapId:164001+index},game={roomType:40,mapIndex:1201,missionInfo:{id:164001+index}},rooms={current:room},games={Current:game},self={ID:7,ZoneID:2,bagLocked:false};
 const hall={getView:()=>view},states={currentStateType:'playing',getState:type=>type==='main'?hall:null};
 const bootstrap={},definitions=new Map([['WorkshopNativeChristmasBootstrap',bootstrap],...['App','Config','morn.core.components.View'].map(n=>[n,{}])]);
 const domain={hasDefinition:n=>definitions.has(n),getDefinition:n=>definitions.get(n)},loaderContext={applicationDomain:domain};
 const packetEvent='GamePlayerExit',finalEvent='GameAllMissionOver',classes={
  'room.RoomManager':{Instance:rooms},'game.GameManager':{Instance:games},'ddt.manager.PlayerManager':{Instance:{Self:self}},
  'ddt.manager.StateManager':states,'ddt.states.StateType':{MAIN:'main'},'com.pickgliss.loader.DisplayLoader':{Context:loaderContext},
  'ddt.manager.SocketManager':{Instance:socket},'ddt.events.CrazyTankSocketEvent':{GAME_PLAYER_EXIT:packetEvent,GAME_ALL_MISSION_OVER:finalEvent},
  'ddt.manager.GameInSocketOut':{sendMissionTryAgain:(...args)=>send('119',args),sendGamePlayerExit:(...args)=>send('94',args)},
 };
 function send(name,args){sent.push({name,args});trace.push('send-'+name);if(sendFailure===name)throw Error('fixture send '+name+' rejected');}
 const context={Math,Error,Number,String,Boolean,isFinite,Array,DisplayObject:Dispatcher,Sprite:Dispatcher,WorkshopNativeChristmasBootstrap:bootstrap,
  Event:{ADDED_TO_STAGE:'added',ENTER_FRAME:'enterFrame'},KeyboardEvent:{KEY_DOWN:'keyDown'},MouseEvent:{CLICK:'click',MOUSE_DOWN:'mouseDown'},
  expectedId:7,generation:'fixture-generation',phase:'ready',hostContext:loaderContext,domain,
  battleReturn:null,returnToSnowfield:false,sequence:10,lastRevision:3,pending:false,pendingId:'',pendingAction:null,wantedOpen:false,sceneRoot:null,main:null,
  busy:false,quantity:null,help:null,sceneLoading:false,displayArmed:false,challengeNeedsRefresh:false,snowman:null,windowSerial:1,balanceText:null,notice:null,message:'',
  bindings:Object.create(null),projection:{validated:true,available:true,stateToken:'old-projection-token'},
  snowfield:{validated:true,available:true,stateToken:'old-snowfield-token',scene:{state:'inside',canResume:false},entry:{available:true,reason:'entry unavailable'},attempt:{canResume:false,type:index}},
  cls(name){assert(classes[name],'bounded host class '+name);return classes[name];},
  ExternalInterface:{available:true,call(name,...args){bridge.push({name,args});trace.push(name);if(name==='workshopChristmasRead'){if(readThrows)throw Error('fixture read transport');return{accepted:readAccepted};}if(name==='workshopChristmasRequest')return{accepted:true,requestId:'fixture-uuid'};return null;}},
  // UI/data-validator doubles are deliberate; lifecycle, ownership, role, receipt and business guards below execute actual AS.
  validate:p=>assert.equal(p.validated,true,'snowman projection validator'),validateSnowfield:p=>assert.equal(p.validated,true,'snowfield projection validator'),validateEffect(){throw Error('no new economic effects expected');},
  syncModel(){trace.push('syncModel');},constructWindow(){trace.push('constructWindow');context.sceneRoot=new Dispatcher('sceneRoot');context.main={dispose(){trace.push('disposeMain');}};},renderStatic(){trace.push('renderStatic');},
  stopMovie(){},closeScene(){},clearQuantity(){},clearHelp(){},tick(){},keyDown(){},stopBubble(){},lock(){},say(value){messages.push(value);},
  enterScene(...args){sent.push({name:'enterScene',args});},handoffChallenge(...args){sent.push({name:'challenge',args});},animateCraft(){throw Error('unexpected automatic economic animation');},
 };
 for(const method of methods)context[method.name]=method.factory(context);
 const realBind=context.bind;context.bind=(owner,...args)=>{if(!Object.hasOwn(owner,Symbol.toPrimitive)){const key='return-owner-'+(++nextOwner);Object.defineProperty(owner,Symbol.toPrimitive,{value:()=>key});}return realBind(owner,...args);};
 const original=e=>{trace.push('original-94');if(e.pkg){trace.push('original-zone-'+e.pkg.readInt());}if(e.original) e.original();};socket.addEventListener(packetEvent,original,false,0);
 const originalFinal=e=>{trace.push('original-115');if(e.original)e.original();};socket.addEventListener(finalEvent,originalFinal,false,0);
 const count=name=>sent.filter(r=>r.name===name).length,reads=()=>bridge.filter(r=>r.name==='workshopChristmasRead').length,business=()=>bridge.filter(r=>r.name==='workshopChristmasRequest').length;
 const final=(options={})=>socket.dispatch(finalEvent,options);
 const arm=(finalize=true)=>{context.armBattleReturn(room,room.ID,game,index);if(finalize)final();return context.battleReturn;};
 const route=(target='dungeonRoom')=>context.naturalBattleReturn(target,room,game);
 const arrive=(options={})=>{states.currentStateType='main';rooms.current=null;view.stage={};view.dispatch('added',options);};
 const packet=(id=7,zone=2)=>({position:12,clientId:id,readInt(){const value=zone;this.position+=4;return value;}});
 const ack=(options={})=>{const pkg=options.pkg??packet(options.id??7,options.zone??2),event={pkg,...options};socket.dispatch(packetEvent,event);return pkg;};
 const snapshot=(extra={})=>({generation:context.generation,sequence:context.sequence,snapshot:{characterId:7,revision:4,nativeChristmas:{validated:true,available:true,stateToken:'fresh-projection-token'},nativeChristmasSnowfield:{...context.snowfield,stateToken:'fresh-snowfield-token'}},...extra});
 const owned=()=>[...view.listeners,...socket.listeners.filter(r=>r.fn!==original&&r.fn!==originalFinal)];
 return{context,classes,domain,definitions,loaderContext,self,room,game,rooms,games,hall,states,view,socket,sent,bridge,trace,messages,packetEvent,finalEvent,arm,final,route,arrive,packet,ack,snapshot,count,reads,business,owned,setReadAccepted:value=>{readAccepted=value;},setReadThrows:value=>{readThrows=value;},setSendFailure:value=>{sendFailure=value;}};
}

export function verifyNaturalBattleReturn(source){
 const names=['armBattleReturn','markBattleReturnFinal','cancelBattleReturn','battleReturnAlive','sameBattleReturnRoom','battleReturnAtHall','naturalBattleReturn','battleReturnHall','captureBattleReturnExit','finishBattleReturnExit','retryBattleReturn','completeBattleReturnRead','read','applySnapshot','acceptSnapshot','rejectRequest','request','chooseScene','openNative','closeNative','abortNative','fail','statusNative','report','integer','inHall','role','bind','unbind'];
 const methods=names.map(name=>extract(source,name)),rows=[],run=(label,fn)=>{fn();rows.push(label);};
 const ready=(index=0)=>{const f=fixture(methods,index);f.arm();assert.equal(f.route(),'main');assert.equal(f.context.battleReturn.stage,'hall');assert.equal(f.count('119'),1);assert.equal(f.count('94'),0);assert.equal(f.reads(),0);assert.equal(f.business(),0);return f;};
 const exit=()=>{const f=ready();f.arrive();assert.equal(f.context.battleReturn.stage,'exit');assert.equal(f.count('94'),1);assert.equal(f.reads(),0);return f;};
 const reading=()=>{const f=exit();f.ack();assert.equal(f.context.battleReturn.stage,'reading');assert.equal(f.reads(),1);assert.equal(f.context.pending,true);return f;};
 const inert=f=>{assert.equal(f.count('119'),0);assert.equal(f.count('94'),0);assert.equal(f.reads(),0);assert.equal(f.business(),0);assert(f.owned().every(row=>row.type===f.finalEvent),'only original final-result observer may remain before route acceptance');};
 run('without an owned battle intent the dungeon target stays unchanged and performs no work',()=>{const f=fixture(methods);assert.equal(f.route(),'dungeonRoom');inert(f);});
 for(const target of ['main','farm','christmasRoom','',null])run('unrelated target '+String(target)+' is not consumed',()=>{const f=fixture(methods);f.arm();assert.equal(f.route(target),target);inert(f);});
 for(const which of ['room','game'])run('same-value '+which+' hook argument cannot impersonate captured object',()=>{const f=fixture(methods);f.arm();assert.equal(f.context.naturalBattleReturn('dungeonRoom',which==='room'?{...f.room}:f.room,which==='game'?{...f.game}:f.game),'dungeonRoom');inert(f);});
 run('missing115 never consumes original target or sends119/94; late115 alone performs no route/read',()=>{const f=fixture(methods),r=f.arm(false);assert.equal(r.finalSeen,false);assert.equal(f.route(),'dungeonRoom');inert(f);f.final();assert.equal(r.finalSeen,true);inert(f);assert.equal(f.route(),'main');assert.equal(f.count('119'),1);});
 run('actual115 observer runs after original consumer, is idempotent and unbinds on accepted route',()=>{const f=fixture(methods),r=f.arm(false);assert.deepEqual(f.socket.history.filter(v=>v.type===f.finalEvent).map(v=>v.priority),[0,-1]);f.final();assert.equal(f.trace[0],'original-115');assert.equal(r.finalSeen,true);f.final();assert.equal(f.count('119'),0);assert.equal(f.route(),'main');assert.equal(f.owned().filter(v=>v.type===f.finalEvent).length,0);f.final();assert.equal(f.count('119'),1);});
 for(const [label,event]of [['foreign currentTarget',{currentTarget:{}}],['foreign event type',{type:'other'}]])run(label+'115 cannot mark final',()=>{const f=fixture(methods),r=f.arm(false);f.final(event);assert.equal(r.finalSeen,false);assert.equal(f.route(),'dungeonRoom');inert(f);});
 run('missing115 event and original consumer replacing GameInfo cannot mark final',()=>{const f=fixture(methods),r=f.arm(false);f.context.markBattleReturnFinal(r,null);assert.equal(r.finalSeen,false);f.final({original:()=>{f.games.Current={...f.game};}});assert.equal(r.finalSeen,false);assert.equal(f.route(),'dungeonRoom');inert(f);});
 for(let index=0;index<3;index++)run('captured tier '+index+' consumes once, sends original 119(0,true), waits for Hall, then original94 and one read',()=>{
  const f=ready(index),r=f.context.battleReturn;assert.deepEqual(f.sent,[{name:'119',args:[0,true]}]);assert.equal(f.route(),'dungeonRoom');assert.equal(f.count('119'),1);assert.equal(f.view.history[0].type,'added');
  f.arrive();assert.equal(r.stage,'exit');assert.deepEqual(f.socket.history.filter(v=>v.type===f.packetEvent&&v.priority!==0).map(v=>v.priority),[1,-1]);
  const pkg=f.ack();assert.equal(pkg.position,16,'owned pre-consumer restores packet cursor; only original consumer advances it');assert.equal(r.stage,'reading');assert.equal(r.readSequence,11);assert.equal(f.reads(),1);assert.equal(f.context.pending,true);assert.equal(f.owned().length,0);f.ack();assert.equal(f.reads(),1);assert.equal(f.business(),0);
 });
 const drifts=[
  ['same-ID room replacement',f=>{f.rooms.current={...f.room};}],['room ID',f=>{f.room.ID++;}],['room type',f=>{f.room.type=1;}],['room map',f=>{f.room.mapId++;}],
  ['same-value GameInfo replacement',f=>{f.games.Current={...f.game};}],['game roomType',f=>{f.game.roomType=1;}],['game mapIndex',f=>{f.game.mapIndex++;}],['mission absent',f=>{f.game.missionInfo=null;}],['mission tier',f=>{f.game.missionInfo.id++;}],
  ['role ID',f=>{f.self.ID++;}],['role zone',f=>{f.self.ZoneID++;}],['same-ID/zone Self replacement',f=>{f.classes['ddt.manager.PlayerManager'].Instance.Self={...f.self};}],['generation',f=>{f.context.generation='new-generation';}],['phase',f=>{f.context.phase='failed';}],['pending request',f=>{f.context.pending=true;}],['wanted window',f=>{f.context.wantedOpen=true;}],['open scene',f=>{f.context.sceneRoot={};}],
  ['loader context replaced',f=>{f.classes['com.pickgliss.loader.DisplayLoader'].Context={...f.loaderContext};}],['bootstrap domain identity replaced',f=>{f.definitions.set('WorkshopNativeChristmasBootstrap',{});}],
 ];
 for(const [label,change]of drifts.filter(([label])=>!['pending request','wanted window','open scene'].includes(label)))run(label+' at115 cannot mark another battle final',()=>{const f=fixture(methods),r=f.arm(false);change(f);f.final();assert.equal(r.finalSeen,false);assert.equal(f.route(),'dungeonRoom');inert(f);});
 for(const [label,change]of drifts)run(label+' drift refuses natural route without sends/read/open',()=>{const f=fixture(methods);f.arm();change(f);assert.equal(f.route(),'dungeonRoom');inert(f);});
 for(const [label,args]of [['missing room',[null,201,null,0]],['bad tier',[{},201,{},3]],['invalid room ID',[{},0,{},0]]])run('arming rejects '+label,()=>{const f=fixture(methods);assert.throws(()=>f.context.armBattleReturn(...args));assert.equal(f.context.battleReturn,null);inert(f);});
 run('arming rejects mismatched objects and does not retain a prior intent',()=>{const f=fixture(methods);f.arm();assert.throws(()=>f.context.armBattleReturn({...f.room},201,f.game,0));assert.equal(f.context.battleReturn,null);inert(f);});
 run('Hall target bubbling from another view is ignored without losing intent',()=>{const f=ready(),r=f.context.battleReturn;f.arrive({target:new Dispatcher('other')});assert.equal(f.context.battleReturn,r);assert.equal(r.stage,'hall');assert.equal(f.count('94'),0);});
 for(const [label,change]of [
  ['not main',f=>{f.states.currentStateType='playing';}],['different Hall',f=>{f.states.getState=()=>({getView:()=>f.view});}],['different Hall view',f=>{f.hall.getView=()=>new Dispatcher('other');}],['view not attached',f=>{f.view.stage=null;}],['new room entered',f=>{f.rooms.current={ID:9};}],['role ID changed',f=>{f.self.ID++;}],['zone changed',f=>{f.self.ZoneID++;}],['same-ID/zone Self replaced',f=>{f.classes['ddt.manager.PlayerManager'].Instance.Self={...f.self};}],
 ])run(label+' on Hall attachment cancels owned return without94 or read',()=>{const f=ready();f.states.currentStateType='main';f.rooms.current=null;f.view.stage={};change(f);f.view.dispatch('added');assert.equal(f.context.battleReturn,null);assert.equal(f.count('94'),0);assert.equal(f.reads(),0);assert.equal(f.owned().length,0);});
 run('119 transport failure cancels listener and returns original target',()=>{const f=fixture(methods);f.arm();f.setSendFailure('119');assert.equal(f.route(),'dungeonRoom');assert.equal(f.context.battleReturn,null);assert.equal(f.owned().length,0);assert.equal(f.reads(),0);});
 run('94 transport failure cancels return without issuing a read',()=>{const f=ready();f.setSendFailure('94');f.arrive();assert.equal(f.context.battleReturn,null);assert.equal(f.owned().length,0);assert.equal(f.reads(),0);});
 for(const [label,options]of [['another user',{id:8}],['another zone',{zone:3}]])run(label+'94 does not consume owned exit; later self94 does',()=>{const f=exit();f.ack(options);assert.equal(f.reads(),0);assert.equal(f.context.battleReturn.stage,'exit');f.ack();assert.equal(f.reads(),1);});
 run('missing/truncated94 never authorizes read and restores cursor on failure',()=>{const f=exit();const p=f.packet();p.readInt=()=>{p.position++;throw Error('truncated');};const owner=f.context.battleReturn;f.context.captureBattleReturnExit(owner,{pkg:p});assert.equal(p.position,12);assert.equal(owner.ack,null);f.socket.dispatch(f.packetEvent,{pkg:null});assert.equal(f.reads(),0);f.ack();assert.equal(f.reads(),1);});
 run('post-consumer must see the exact captured event and packet',()=>{const f=exit(),r=f.context.battleReturn,p=f.packet(),e={pkg:p};f.context.captureBattleReturnExit(r,e);f.context.finishBattleReturnExit(r,{pkg:p});assert.equal(f.reads(),0);f.context.finishBattleReturnExit(r,{...e,pkg:f.packet()});assert.equal(f.reads(),0);f.ack();assert.equal(f.reads(),1);});
 run('original94 consumer changing Hall/room invalidates captured ACK before the read',()=>{const f=exit();f.ack({original:()=>{f.rooms.current={ID:99};}});assert.equal(f.reads(),0);assert.equal(f.context.battleReturn,null);assert.equal(f.owned().length,0);});
 run('old Hall/ACK closures cannot mutate a newly armed intent or remove its listeners',()=>{
  const f=ready(),oldHall=f.view.history[0].fn;f.arrive();const old=f.socket.history.filter(v=>v.priority!==0).map(v=>v.fn);f.context.cancelBattleReturn();f.rooms.current=f.room;f.states.currentStateType='playing';f.view.stage=null;f.arm();assert.equal(f.route(),'main');const current=f.context.battleReturn,before=f.owned().length;
  oldHall({target:f.view,currentTarget:f.view});for(const fn of old)fn({pkg:f.packet()});assert.equal(f.context.battleReturn,current);assert.equal(current.stage,'hall');assert.equal(f.owned().length,before);assert.equal(f.count('94'),1);assert.equal(f.reads(),0);f.arrive();f.ack();assert.equal(f.reads(),1);
 });
 for(const stage of ['battle','hall','reading'])run('explicit close at '+stage+' cancels intent and late callbacks never reopen',()=>{
  const f=stage==='reading'?reading():stage==='hall'?ready():fixture(methods);if(stage==='battle')f.arm();const callbacks=[...f.view.history,...f.socket.history.filter(v=>v.priority!==0)].map(v=>v.fn);f.context.closeNative();assert.equal(f.context.battleReturn,null);assert.equal(f.context.returnToSnowfield,false);assert.equal(f.owned().length,0);const reads=f.reads();for(const fn of callbacks)fn({target:f.view,currentTarget:f.view,pkg:f.packet()});assert.equal(f.reads(),reads);assert.equal(f.context.sceneRoot,null);assert.equal(f.context.main,null);
 });
 run('close while waiting94 retains only that ACK ownership; late ACK clears intent with no read/window',()=>{const f=exit(),r=f.context.battleReturn;f.context.closeNative();assert.equal(f.context.battleReturn,r);assert.equal(r.wantOpen,false);assert.equal(f.owned().length,2);f.ack();assert.equal(f.context.battleReturn,null);assert.equal(f.owned().length,0);assert.equal(f.reads(),0);assert.equal(f.context.sceneRoot,null);});
 run('waiting94 explicit reopen exposes retry; chooseScene retries only94 and blocks all economic requests',()=>{
  const f=exit(),r=f.context.battleReturn;f.context.closeNative();f.context.openNative();assert.equal(f.context.battleReturn,r);assert.equal(r.wantOpen,true);assert(f.context.main);assert.equal(f.reads(),0);f.context.chooseScene();assert.equal(f.count('94'),2);assert.equal(f.reads(),0);
  for(const type of ['enter','challenge','npc-claim','craft','claim'])f.context.request({type,index:0});assert.equal(f.business(),0);assert.equal(f.count('enterScene'),0);assert.equal(f.count('challenge'),0);f.ack();assert.equal(f.reads(),1);f.context.acceptSnapshot(f.snapshot());assert.equal(f.context.battleReturn,null);assert.equal(f.context.returnToSnowfield,true);
 });
 run('abort clears an exit intent instead of retaining its late ACK listeners',()=>{const f=exit();f.context.abortNative('fixture');assert.equal(f.context.phase,'failed');assert.equal(f.context.battleReturn,null);assert.equal(f.owned().length,0);f.ack();assert.equal(f.reads(),0);});
 run('refused one-time read closes recovery intent and exposes ordinary later explicit open',()=>{const f=exit();f.setReadAccepted(false);f.ack();assert.equal(f.reads(),1);assert.equal(f.context.battleReturn,null);assert.equal(f.context.pending,false);assert.equal(f.context.wantedOpen,false);assert.equal(f.context.main,null);f.setReadAccepted(true);f.context.openNative();assert.equal(f.reads(),2);assert.equal(f.business(),0);});
 run('read transport exception releases pending and closes intent without economic retry',()=>{const f=exit();f.setReadThrows(true);f.ack();assert.equal(f.reads(),1);assert.equal(f.context.pending,false);assert.equal(f.context.battleReturn,null);assert.equal(f.context.wantedOpen,false);assert.equal(f.context.main,null);assert.equal(f.business(),0);});
 run('valid one-time snapshot syncs before intent completion and only offers explicit return; click uses fresh enter token',()=>{
  const f=reading();const envelope=f.snapshot(),receipt=f.context.acceptSnapshot(envelope);assert.equal(receipt.pending,false);assert.equal(receipt.sequence,11);assert.equal(receipt.revision,4);assert.equal(f.context.battleReturn,null);assert.equal(f.context.returnToSnowfield,true);assert(f.context.main);assert(f.trace.indexOf('syncModel')<f.trace.indexOf('constructWindow'));assert.equal(f.reads(),1);assert.equal(f.business(),0);assert.equal(f.count('enterScene'),0);
  f.context.chooseScene();assert.equal(f.business(),1);const request=f.bridge.find(r=>r.name==='workshopChristmasRequest');assert.deepEqual(request.args.slice(0,3),[7,'fixture-generation',12]);assert.deepEqual(request.args[3],{type:'enter',choice:'fresh-snowfield-token'});assert.equal(f.count('enterScene'),0);assert.equal(f.count('challenge'),0);assert.equal(f.count('94'),1);
 });
 for(const [label,mutate]of [
  ['old generation',e=>{e.generation='old';}],['old sequence',e=>{e.sequence--;}],['wrong role',e=>{e.snapshot.characterId++;}],['revision regression',e=>{e.snapshot.revision=2;}],['invalid snowman',e=>{e.snapshot.nativeChristmas.validated=false;}],['invalid snowfield',e=>{e.snapshot.nativeChristmasSnowfield.validated=false;}],
 ])run(label+' snapshot cannot complete/reopen natural return',()=>{const f=reading(),e=f.snapshot();mutate(e);assert.throws(()=>f.context.acceptSnapshot(e));assert.equal(f.context.phase,'failed');assert.equal(f.context.battleReturn,null);assert.equal(f.context.returnToSnowfield,false);assert.equal(f.context.main,null);assert.equal(f.context.sceneRoot,null);assert.equal(f.business(),0);});
 run('complete callback alone cannot consume another sequence/generation or non-reading intent',()=>{const f=exit(),r=f.context.battleReturn;assert.equal(f.context.completeBattleReturnRead({generation:r.generation,sequence:11}),false);f.ack();assert.equal(f.context.completeBattleReturnRead({generation:r.generation,sequence:10}),false);assert.equal(f.context.completeBattleReturnRead({generation:'old',sequence:11}),false);assert.equal(f.context.battleReturn,r);assert.equal(f.context.returnToSnowfield,false);});
 run('identity drift at completed read clears intent without reopening any window',()=>{const f=reading();f.self.ID++;assert.throws(()=>f.context.acceptSnapshot(f.snapshot()));assert.equal(f.context.battleReturn,null);assert.equal(f.context.main,null);assert.equal(f.business(),0);});
 run('same-ID/zone replacement Self at completed read cannot reopen old return intent',()=>{const f=reading();f.classes['ddt.manager.PlayerManager'].Instance.Self={...f.self};f.context.acceptSnapshot(f.snapshot());assert.equal(f.context.battleReturn,null);assert.equal(f.context.returnToSnowfield,false);assert.equal(f.context.wantedOpen,false);assert.equal(f.context.main,null);assert.equal(f.context.sceneRoot,null);assert.equal(f.business(),0);});
 run('definitive rejected read cancels; uncertain and old rejection preserve current pending intent',()=>{const f=reading(),r=f.context.battleReturn;f.context.rejectRequest({generation:'old',sequence:11,definitive:true});assert.equal(f.context.battleReturn,r);f.context.rejectRequest({generation:r.generation,sequence:11,definitive:false});assert.equal(f.context.battleReturn,r);assert.equal(f.context.pending,true);f.context.rejectRequest({generation:r.generation,sequence:11,definitive:true});assert.equal(f.context.battleReturn,null);assert.equal(f.context.pending,false);assert.equal(f.context.main,null);});
 for(const [label,mutate]of [['expired entry',s=>{s.entry.available=false;}],['outside scene',s=>{s.scene.state='outside';}],['existing challenge resume',s=>{s.attempt.canResume=true;}]])run(label+' refreshed state never falsely promises returnToSnowfield',()=>{const f=reading(),e=f.snapshot();mutate(e.snapshot.nativeChristmasSnowfield);f.context.acceptSnapshot(e);assert.equal(f.context.returnToSnowfield,false);assert.equal(f.business(),0);assert.equal(f.count('enterScene'),0);});
 const handoff=extract(source,'handoffChallenge');assert(String(handoff.factory).includes('clearChallengeBindings();closeNative();armBattleReturn(admittedRoom,admittedRoomId,game,index);'),'handoff closes old UI before arming captured objects');
 assert(source.includes('returnToSnowfield&&snowfield&&snowfield.entry.available?"返回雪场"'),'actual original enter button exposes explicit return');
 return{method:'Mechanically extracted actual AS lifecycle/role/receipt/business-guard methods with priority-aware host event and Dictionary identity doubles; UI creation and projection validators are bounded doubles; not SWF/AVM2 execution',sourceSha256:sha(source),extracted:methods.map(({factory,...entry})=>entry),count:rows.length,rows,hostIntegrationVerified:false,installed:false,runtimeValidated:false};
}
export function verifyNaturalBattleReturnRefusals(source){
 const mutations=[
  ['unrelated target guard removed','if(target!=="dungeonRoom")return target;',''],
  ['actual115 final proof guard removed','r.finalSeen!==true||',''],
  ['captured room identity guard removed','r.room!==room||',''],
  ['role zone guard bypassed','&&self.ZoneID===r.zoneId',''],
  ['Self object identity guard removed','self===r.self&&',''],
  ['stale ACK owner guard removed','if(battleReturn!==r||r.stage!=="exit")return;r.ack=null;','if(r.stage!=="exit")return;r.ack=null;'],
  ['ACK event identity guard removed','r.ack.event!==e||r.ack.pkg!==e.pkg','false'],
  ['packet cursor restore removed','finally{packet.position=position;}','finally{}'],
  ['close revives waiting ACK intent','battleReturn.wantOpen=false;','battleReturn.wantOpen=true;'],
  ['return intent economic guard removed','if(battleReturn||pending||busy||quantity||help||!projection','if(pending||busy||quantity||help||!projection'],
  ['read completion sequence guard removed','e.sequence!==r.readSequence||',''],
  ['revision regression check removed','||value.revision<lastRevision',''],
 ];
 const rows=[];for(const[label,before,after]of mutations){assert.equal(source.split(before).length,2,'one mutation site: '+label);const mutated=source.replace(before,after);assert.throws(()=>verifyNaturalBattleReturn(mutated),undefined,'actual source mutation must be detected: '+label);rows.push({label,sourceSha256:sha(mutated),rejected:true});}
 return{method:'Counterfactual mutations of the actual AS source are each rejected by the mechanical lifecycle fixtures; not AVM2',count:rows.length,rows};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(verifyNaturalBattleReturn(readFileSync(resolve(process.argv[2]??'scripts/native-christmas/WorkshopNativeChristmasBootstrap.as'),'utf8')),null,2));
