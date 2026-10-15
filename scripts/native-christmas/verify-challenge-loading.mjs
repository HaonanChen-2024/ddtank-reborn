// Mechanically extracted ActionScript closures with event/timer test doubles; not AVM2 execution.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function extract(source,name){
 const match=new RegExp('(?:private|public) function '+name+'\\(([^)]*)\\):[\\w*]+\\s*\\{').exec(source);assert(match,`AS method ${name}`);
 let depth=1,quote='',lineComment=false,blockComment=false,end=match.index+match[0].length;
 for(;end<source.length&&depth;end++){
  const char=source[end],next=source[end+1];
  if(lineComment){if(char==='\n')lineComment=false;continue;}
  if(blockComment){if(char==='*'&&next==='/'){blockComment=false;end++;}continue;}
  if(quote){if(char==='\\'){end++;continue;}if(char===quote)quote='';continue;}
  if(char==='/'&&next==='/'){lineComment=true;end++;continue;}
  if(char==='/'&&next==='*'){blockComment=true;end++;continue;}
  if(char==='"'||char==="'"){quote=char;continue;}
  if(char==='{')depth++;else if(char==='}')depth--;
 }
 assert.equal(depth,0,`${name} body terminates`);
 const body=source.slice(match.index+match[0].length,end-1);
 const translate=text=>text
  .replace(/for each\(var (\w+):\w+ in ([^)]+)\)/g,'for(var $1 of $2)')
  .replace(/\b([A-Za-z_$]\w*):(?:Object|int|Boolean|Number|Point|Array|String|Function|Event|TimerEvent|Error|DisplayObject|\*)(?=\s*(?:[=,;)]|$))/g,'$1')
  .replace(/\)\s*:(?:void|Object|Boolean|int|Number|String|\*)\s*\{/g,'){')
  .replace(/\s+as (?:Array|DisplayObject)\b/g,'')
  .replace(/\bis Array\b/g,'instanceof Array')
  .replace(/\bint\(/g,'Math.trunc(');
 const args=translate(match[1]),javascript=translate(body);
 const factory=new Function('context',`return function(${args}){with(context){${javascript}}}`);
 return{name,sourceSha256:sha(body),javascriptSha256:sha(javascript),factory};
}

class Dispatcher{
 constructor(name){this.name=name;this.listeners=[];this.history=[];}
 addEventListener(type,fn,capture=false,priority=0){assert.equal(capture,false);assert.equal(typeof fn,'function');this.listeners.push({type,fn,priority,order:this.history.length});this.history.push({type,fn,priority});}
 removeEventListener(type,fn){this.listeners=this.listeners.filter(row=>row.type!==type||row.fn!==fn);}
 dispatch(type,event={}){for(const row of this.listeners.filter(r=>r.type===type).sort((a,b)=>b.priority-a.priority||a.order-b.order)){if(this.listeners.includes(row))row.fn(event);}}
}

function fixture(methods,index){
 const events={GAME_ROOM_CREATE:'roomCreate',GAME_CREATE:'gameCreate',GAME_LOAD:'gameLoad'},socket=new Dispatcher('SocketManager'),games=new Dispatcher('GameManager'),rooms=new Dispatcher('RoomManager');
 const sent=[],states=[],messages=[],timers=[],trace=[],bridge=[],originalListeners=new Set();let nextOwner=0,roleValid=true,packetReads=0;
 class Timer extends Dispatcher{
  constructor(delay,repeatCount){super('ownedTimer');this.delay=delay;this.repeatCount=repeatCount;this.running=false;this.starts=0;this.stops=0;timers.push(this);}
  start(){this.running=true;this.starts++;}
  stop(){this.running=false;this.stops++;}
  fire(){if(this.running){this.running=false;this.dispatch('timerComplete',{});}}
 }
 const beforeGame={roomType:40,mapIndex:1201,missionInfo:{id:164001+index}},beforeRoom={ID:100,type:40,mapId:164001+index};games.Current=beforeGame;rooms.current=beforeRoom;
 const G={Instance:games,START_LOAD:'startLoad'},classes={
  'ddt.events.CrazyTankSocketEvent':events,'ddt.manager.SocketManager':{Instance:socket},'room.RoomManager':{Instance:rooms},'game.GameManager':G,
  'ddt.manager.GameInSocketOut':{sendGameRoomSetUp:(...args)=>sent.push({name:'setup',args}),sendGameStart:(...args)=>sent.push({name:'start',args}),sendGamePlayerExit:(...args)=>sent.push({name:'playerExit',args})},
  'ddt.manager.StateManager':{currentStateType:'main',setState:(...args)=>states.push(args)},'ddt.states.StateType':{ROOM_LOADING:'roomLoading'},
 };
 const context={Timer,TimerEvent:{TIMER_COMPLETE:'timerComplete'},Event:{ENTER_FRAME:'enterFrame'},KeyboardEvent:{KEY_DOWN:'keyDown'},MouseEvent:{CLICK:'click',MOUSE_DOWN:'mouseDown'},Math,Error,Number,String,Boolean,
  wantedOpen:true,sceneActive:true,sceneLoading:false,sceneSerial:7,sceneRoot:new Dispatcher('sceneRoot'),roomController:{dispose(){trace.push('disposeController');}},roomView:{},sceneMap:{},main:null,
  sceneMovePending:null,sceneMoveCorrection:false,sceneSelfSnapshot:true,sceneMembersReady:true,sceneButtons:null,socketOwner:null,
  roomCreateOwner:null,gameLoadOwner:null,challengeIndex:-1,resumeChallengeIndex:-1,challengeRoomCreated:false,challengeTimer:null,challengeNeedsRefresh:false,sceneChallengeRoom:null,
  pending:false,pendingId:'',pendingAction:null,busy:false,phase:'ready',generation:'fixture-generation',expectedId:7,sequence:0,lastRevision:-1,displayArmed:false,snowman:null,quantity:null,help:null,movieOwner:null,movieHandler:null,windowSerial:1,balanceText:null,notice:null,message:'',
  bindings:Object.create(null),snowfield:{attempt:{canResume:true,type:index},challenges:[0,1,2].map(i=>({monsterId:300+i,canChallenge:true}))},
  cls(name){assert(classes[name],`fixture host ${name}`);return classes[name];},role(){assert(roleValid,'fixture role changed');},
  out:()=>({sendStartFightWithMonster:(...args)=>{assert.equal(timers.filter(t=>t.running).length,1);assert(timers.at(-1).running,'owned timeout starts before the first send');sent.push({name:'monster',args});},sendLeaveChristmasRoom:(...args)=>sent.push({name:'leave',args})}),say:value=>messages.push(value),lock(){},request:(...args)=>sent.push({name:'business',args}),
  tick(){},keyDown(){},stopBubble(){},report(){},domain:{hasDefinition:()=>false},ExternalInterface:{available:false,call:(...args)=>{bridge.push(args);return{accepted:true};}},
  validate:p=>assert.equal(p.validated,true),validateSnowfield:p=>assert.equal(p.validated,true),validateEffect(){},syncModel(){},constructWindow(){context.sceneRoot??=new Dispatcher('sceneRoot');context.main={dispose(){trace.push('disposeMain');}};},renderStatic(){},
 };
 context.snowfield.validated=true;
 for(const method of methods)context[method.name]=method.factory(context);
 // A stable primitive key is only a Dictionary identity test double. Execute the actual AS bind/unbind bodies.
 const actualBind=context.bind;context.bind=(owner,...args)=>{if(!Object.hasOwn(owner,Symbol.toPrimitive)){const key=`fixture-owner-${++nextOwner}`;Object.defineProperty(owner,Symbol.toPrimitive,{value:()=>key});}return actualBind(owner,...args);};
 const original=(target,type,fn)=>{originalListeners.add(fn);target.addEventListener(type,fn);};
 original(socket,events.GAME_ROOM_CREATE,e=>{trace.push('original-room');if(e.room!==undefined)rooms.current=e.room;});
 original(socket,events.GAME_CREATE,e=>{trace.push('original-game');if(e.game!==undefined)games.Current=e.game;});
 original(socket,events.GAME_LOAD,e=>{trace.push('original-load');if(e.mapIndex!==undefined)games.Current.mapIndex=e.mapIndex;if(e.dispatchStart!==false)games.dispatch(G.START_LOAD,{});});
 const packet=()=>({pkg:new Proxy({},{get(){packetReads++;throw new Error('owned observer must not read the packet cursor');}})});
 const send=(type,values={})=>socket.dispatch(events[type],{...packet(),...values});
 const createRoom=(room={ID:201,type:40,mapId:164001+index})=>{send('GAME_ROOM_CREATE',{room});return room;};
 const createGame=(game={roomType:40,mapIndex:0,missionInfo:null})=>{send('GAME_CREATE',{game});return game;};
 const mission=(id=164001+index)=>{games.Current.missionInfo={id};games.dispatch(G.START_LOAD,{});};
 const load=(mapIndex=1201)=>send('GAME_LOAD',{mapIndex});
 const count=name=>sent.filter(row=>row.name===name).length;
 const owned=()=>[...socket.listeners,...games.listeners,...rooms.listeners].filter(row=>!originalListeners.has(row.fn));
 const assertClean=()=>{assert.equal(owned().length,0,'all owned host listeners are removed');assert(timers.every(t=>!t.running&&t.listeners.length===0),'owned timers stopped and unbound');};
 const snapshot=(extra={})=>({generation:context.generation,sequence:context.sequence,snapshot:{characterId:7,revision:1,nativeChristmas:{validated:true},nativeChristmasSnowfield:context.snowfield},...extra});
 return{context,events,socket,games,rooms,G,beforeGame,beforeRoom,sent,states,messages,timers,trace,bridge,send,createRoom,createGame,mission,load,count,owned,assertClean,snapshot,packetReads:()=>packetReads,changeRole:()=>{roleValid=false;}};
}

export function verifyChallengeLoading(source){
 const methods=['handoffChallenge','cancelChallengeHandoff','clearChallengeBindings','bind','unbind','canUseScene','sceneAction','resetSceneMovement','closeScene','userExitScene','closeNative','stopMovie','clearQuantity','clearHelp','fail','read','applySnapshot','acceptSnapshot','integer','statusNative','report','openNative','inHall'].map(name=>extract(source,name)),rows=[];
 const run=(label,fn)=>{fn();rows.push(label);};
 const begin=(index=0)=>{const f=fixture(methods,index);f.context.handoffChallenge(index);assert.equal(f.count('monster'),1);assert.equal(f.count('business'),0);assert.equal(f.bridge.length,0);assert.equal(f.timers.length,1);assert.equal(f.timers[0].delay,20000);assert.equal(f.timers[0].repeatCount,1);assert.equal(f.timers[0].starts,1);assert(f.timers[0].running);return f;};
 const ready=(f,index=0)=>{f.createRoom();const game=f.createGame();f.mission(164001+index);return game;};
 const noRetry=f=>{assert.equal(f.count('monster'),1);assert.equal(f.count('business'),0);assert.equal(f.count('leave'),0);assert.equal(f.count('playerExit'),0);assert.equal(f.bridge.length,0);assert.equal(f.packetReads(),0);};
 const cancelled=f=>{f.assertClean();assert.equal(f.states.length,0);assert.equal(f.context.sceneLoading,false);assert.equal(f.context.challengeNeedsRefresh,true);noRetry(f);};
 const ownedFunctions=f=>[...f.owned().map(r=>r.fn),...f.timers.flatMap(t=>t.listeners.map(r=>r.fn))];
 run('real SocketManager targets, CREATE after consumers, LOAD before consumer and one started owned timer',()=>{
  const f=begin(),rows=f.socket.history.filter(r=>!f.socket.listeners.some(l=>l.fn===r.fn&&l.priority===0));
  assert.deepEqual(rows.map(r=>[r.type,r.priority]),[['roomCreate',-1],['gameCreate',-1],['gameLoad',1]]);assert.equal(f.rooms.history.length,0);assert.equal(f.games.history.at(-1).type,'startLoad');
  f.createRoom();assert.deepEqual(f.sent.map(s=>s.name),['monster','setup','start']);assert.deepEqual(f.sent[1].args,[164001,40,false,'','',3,0,0,false,40001]);f.createGame();f.mission();assert.equal(f.states.length,0);f.load();assert.equal(f.states.length,1);assert.equal(f.packetReads(),0);f.assertClean();
 });
 for(let index=0;index<3;index++)run(`tier ${index}: 91,101,113,103 enters exactly once with captured GameInfo`,()=>{
  const f=begin(index),callbacks=ownedFunctions(f),game=ready(f,index);assert.equal(f.states.length,0);assert(f.owned().length>0,'113 early START_LOAD keeps listeners');f.context.sceneAction(index);assert.equal(f.count('monster'),1);f.load();assert.deepEqual(f.states,[['roomLoading',game]]);f.assertClean();
  for(const fn of callbacks)fn({});f.load();assert.equal(f.states.length,1);assert.equal(f.count('setup'),1);assert.equal(f.count('start'),1);noRetry(f);
 });
 run('old Current and pre-create LOAD cannot authorize an early START_LOAD',()=>{
  const f=begin();f.send('GAME_LOAD',{mapIndex:1201});f.games.dispatch('startLoad',{});assert.equal(f.states.length,0);f.createRoom();const game=f.createGame();f.mission();assert.equal(f.states.length,0);assert(f.owned().length>0);f.load();assert.deepEqual(f.states,[['roomLoading',game]]);f.assertClean();noRetry(f);
 });
 run('GAME_CREATE retaining pre-handoff Current fails without new game authority',()=>{const f=begin();f.createRoom();f.createGame(f.beforeGame);cancelled(f);});
 run('GAME_CREATE before owned room confirmation is ignored then valid ordered sequence works',()=>{const f=begin();f.createGame();f.games.dispatch('startLoad',{});assert.equal(f.states.length,0);ready(f);f.load();assert.equal(f.states.length,1);f.assertClean();noRetry(f);});
 run('duplicate GAME_CREATE never rebinds the captured game or duplicates setup/start',()=>{const f=begin();ready(f);f.createGame();cancelled(f);assert.equal(f.count('setup'),1);assert.equal(f.count('start'),1);});
 for(const [label,mutate] of [
  ['room object replaced with same ID',f=>{f.rooms.current={...f.rooms.current};}],
  ['room ID mutated on same object',f=>{f.rooms.current.ID++;}],
  ['room map changed on same object',f=>{f.rooms.current.mapId++;}],
  ['room type changed on same object',f=>{f.rooms.current.type=1;}],
  ['GameInfo replaced with matching fields',f=>{f.games.Current={...f.games.Current};}],
  ['captured game roomType changed',f=>{f.games.Current.roomType=1;}],
  ['physical map mismatched',f=>{f.games.Current.mapIndex=1202;}],
  ['mission missing',f=>{f.games.Current.missionInfo=null;}],
  ['mission from wrong tier',f=>{f.games.Current.missionInfo.id++;}],
 ])run(`${label} rejects loading without resending or consuming`,()=>{const f=begin();ready(f);mutate(f);f.load(f.games.Current.mapIndex===1202?1202:1201);cancelled(f);});
 for(const [label,room] of [['wrong room type',{ID:201,type:1,mapId:164001}],['wrong room map',{ID:201,type:40,mapId:164002}]])run(`${label} rejects before setup/start`,()=>{const f=begin();f.createRoom(room);cancelled(f);assert.equal(f.count('setup'),0);assert.equal(f.count('start'),0);});
 for(let stage=0;stage<4;stage++)run(`owned timeout at stage ${stage} removes all listeners and requires refresh`,()=>{const f=begin();if(stage>0)f.createRoom();if(stage>1)f.createGame();if(stage>2)f.mission();f.timers[0].fire();cancelled(f);f.context.sceneAction(0);f.context.handoffChallenge(0);noRetry(f);});
 run('failure recovery requires accepted fresh snapshot and another explicit user action; old same-tier callbacks stay inert',()=>{
  const f=begin(),old=ownedFunctions(f);ready(f);f.timers[0].fire();cancelled(f);f.context.sceneAction(0);f.context.handoffChallenge(0);noRetry(f);
  f.context.read();assert.equal(f.context.challengeNeedsRefresh,true);assert.equal(f.count('monster'),1);assert.deepEqual(f.bridge.map(r=>r[0]),['workshopChristmasRead']);assert.throws(()=>f.context.applySnapshot(f.snapshot({generation:'old-generation'})));assert.equal(f.context.challengeNeedsRefresh,true);
  const bad=f.snapshot();bad.snapshot.revision=-1;assert.throws(()=>f.context.applySnapshot(bad));assert.equal(f.context.challengeNeedsRefresh,true);
  const invalid=f.snapshot();invalid.snapshot.nativeChristmas.validated=false;assert.throws(()=>f.context.applySnapshot(invalid));assert.equal(f.context.challengeNeedsRefresh,true);
  f.context.applySnapshot(f.snapshot());assert.equal(f.context.challengeNeedsRefresh,false);assert.equal(f.count('monster'),1);assert.equal(f.context.pending,false);f.context.sceneAction(0);assert.equal(f.count('monster'),2);assert(f.context.sceneLoading);const owner=f.context.gameLoadOwner,remaining=f.owned().length;
  for(const fn of old)fn({});assert.equal(f.context.gameLoadOwner,owner);assert.equal(f.owned().length,remaining);assert(f.context.sceneLoading);assert.equal(f.count('setup'),1);assert.equal(f.count('start'),1);assert.equal(f.states.length,0);assert.equal(f.count('business'),0);assert.equal(f.bridge.length,1);
  ready(f);f.load();assert.equal(f.states.length,1);f.assertClean();assert.equal(f.count('monster'),2);assert.equal(f.count('setup'),2);assert.equal(f.count('start'),2);assert.equal(f.packetReads(),0);
 });
 for(const close of ['closeScene','closeNative'])run(`${close} invalidates serial, stops timer and ignores late event callbacks without exit sends`,()=>{
  const f=begin(),old=ownedFunctions(f),serial=f.context.sceneSerial;ready(f);f.context[close]();assert(f.context.sceneSerial>serial);f.assertClean();assert.equal(f.context.sceneLoading,false);assert.equal(f.context.sceneActive,false);for(const fn of old)fn({});assert.equal(f.states.length,0);noRetry(f);
 });
 run('role identity failure closes owned scene without automatic business/exit requests',()=>{const f=begin();f.changeRole();f.createRoom();f.assertClean();assert.equal(f.context.phase,'failed');assert.equal(f.context.sceneLoading,false);assert.equal(f.states.length,0);noRetry(f);});
 for(const [label,change] of [
  ['matching room',()=>{}],['unrelated room object',f=>{f.rooms.current={...f.rooms.current};}],['room ID changed',f=>{f.rooms.current.ID++;}],['room map changed',f=>{f.rooms.current.mapId++;}],['room type changed',f=>{f.rooms.current.type=1;}],
 ])run(`explicit exit from ${label} uses only its applicable original exit`,()=>{const f=begin();f.createRoom();change(f);f.context.userExitScene();f.assertClean();assert.equal(f.count('playerExit'),label==='matching room'?1:0);assert.equal(f.count('leave'),label==='matching room'?0:1);assert.equal(f.count('business'),0);assert.equal(f.states.length,0);assert.equal(f.context.sceneLoading,false);const count=f.sent.length;f.context.userExitScene();assert.equal(f.sent.length,count);});
 const loadingCount=rows.length;
 // Mirror the receipt predicate in native-activity-host.ts, exercising the actual extracted AS return object.
 const acknowledged=(receipt,envelope)=>Boolean(receipt)&&typeof receipt==='object'&&!Array.isArray(receipt)
  &&receipt.characterId===envelope.snapshot.characterId&&receipt.generation===envelope.generation&&receipt.sequence===envelope.sequence
  &&receipt.pending===false&&Number.isSafeInteger(receipt.revision)&&receipt.revision>=envelope.snapshot.revision;
 const expectIdentity=(receipt,f)=>{assert.equal(receipt.characterId,f.context.expectedId);assert.equal(receipt.expectedUserId,f.context.expectedId);assert.equal(receipt.generation,f.context.generation);assert.equal(receipt.sequence,f.context.sequence);assert.equal(receipt.revision,f.context.lastRevision);};
 run('actual status receipt is not an acknowledgement before a pending read is confirmed',()=>{
  const f=fixture(methods,0);expectIdentity(f.context.statusNative(),f);assert.equal(acknowledged(f.context.statusNative(),f.snapshot()),false);
  f.context.read();const receipt=f.context.statusNative();expectIdentity(receipt,f);assert.equal(receipt.pending,true);assert.equal(acknowledged(receipt,f.snapshot()),false);assert.equal(f.bridge.length,1);
 });
 run('actual acceptSnapshot GET returns the complete role-generation-sequence-revision receipt',()=>{
  const f=fixture(methods,0);f.context.read();const envelope=f.snapshot(),receipt=f.context.acceptSnapshot(envelope);expectIdentity(receipt,f);assert(acknowledged(receipt,envelope));assert.equal(receipt.pending,false);assert.equal(receipt.revision,1);assert.equal(f.count('business'),0);assert.equal(f.count('monster'),0);
 });
 run('fresh challenged callback acknowledges its UUID before entering the original loading handoff',()=>{
  const f=fixture(methods,0);f.context.main={dispose(){}};f.context.sequence=3;f.context.pending=true;f.context.pendingId='owned-challenge';f.context.pendingAction={type:'challenge',index:0};f.context.displayArmed=true;
  const envelope=f.snapshot({requestId:'owned-challenge'});envelope.snapshot.nativeChristmasAction={requestId:'owned-challenge',effects:[{type:'challenged',index:0}]};
  const receipt=f.context.acceptSnapshot(envelope);expectIdentity(receipt,f);assert(acknowledged(receipt,envelope));assert.equal(receipt.requestId,'');assert.equal(f.context.sceneLoading,true);assert.equal(f.count('monster'),1);assert.equal(f.count('business'),0);assert.equal(f.states.length,0);f.context.closeNative();f.assertClean();
 });
 run('actual report passes one status object and stays silent when ExternalInterface is unavailable',()=>{
  const f=fixture(methods,0);f.context.report();assert.equal(f.bridge.length,0);f.context.ExternalInterface.available=true;f.context.report();assert.equal(f.bridge.length,1);
  const [name,...args]=f.bridge[0];assert.equal(name,'workshopChristmasReport');assert.equal(args.length,1);expectIdentity(args[0],f);assert.deepEqual(args[0],f.context.statusNative());
 });
 run('closing while a UUID is pending reports closed state without losing its operation ownership',()=>{
  const f=fixture(methods,0);f.context.ExternalInterface.available=true;f.context.pending=true;f.context.sequence=4;f.context.pendingId='pending-on-close';f.context.pendingAction={type:'challenge',index:0};const generation=f.context.generation;
  const receipt=f.context.closeNative();expectIdentity(receipt,f);assert.equal(receipt.open,false);assert.equal(receipt.pending,true);assert.equal(receipt.requestId,'pending-on-close');assert.equal(receipt.generation,generation);assert.equal(f.bridge.length,1);assert.deepEqual(f.bridge[0],['workshopChristmasReport',receipt]);assert.equal(f.count('leave'),0);assert.equal(f.count('playerExit'),0);assert.equal(f.count('business'),0);assert.equal(f.count('monster'),0);
 });
 run('a matching late callback after close acknowledges state without reopening or handing off',()=>{
  const f=fixture(methods,0);f.context.pending=true;f.context.sequence=4;f.context.pendingId='closed-challenge';f.context.pendingAction={type:'challenge',index:0};f.context.displayArmed=true;f.context.closeNative();
  const envelope=f.snapshot({requestId:'closed-challenge'});envelope.snapshot.nativeChristmasAction={requestId:'closed-challenge',effects:[{type:'challenged',index:0}]};
  const receipt=f.context.acceptSnapshot(envelope);expectIdentity(receipt,f);assert(acknowledged(receipt,envelope));assert.equal(receipt.open,false);assert.equal(f.context.main,null);assert.equal(f.context.wantedOpen,false);assert.equal(f.count('monster'),0);assert.equal(f.count('business'),0);assert.equal(f.states.length,0);
 });
 run('after loading close only an explicit same-generation hall reopen reads and reconstructs the entry',()=>{
  const f=begin(),generation=f.context.generation;ready(f);f.load();const sends=f.sent.length;assert.equal(f.context.sceneRoot,null);assert.equal(f.context.wantedOpen,false);
  const state=f.context.cls('ddt.manager.StateManager');state.currentStateType='fighting';assert.throws(()=>f.context.openNative());assert.equal(f.bridge.length,0);
  state.currentStateType='main';const waiting=f.context.openNative();expectIdentity(waiting,f);assert.equal(waiting.generation,generation);assert.equal(waiting.sequence,1);assert.equal(waiting.pending,true);assert.equal(waiting.open,false);assert.deepEqual(f.bridge.map(r=>r[0]),['workshopChristmasRead']);
  const envelope=f.snapshot(),receipt=f.context.acceptSnapshot(envelope);assert(acknowledged(receipt,envelope));assert.equal(receipt.open,true);assert.equal(receipt.generation,generation);assert.equal(f.sent.length,sends);assert.equal(f.states.length,1);assert.equal(f.count('business'),0);
 });
 run('a replay receipt synchronizes the same UUID without rearming a challenge effect',()=>{
  const f=fixture(methods,0);f.context.main={dispose(){}};f.context.pending=true;f.context.sequence=2;f.context.pendingId='replayed-challenge';f.context.pendingAction={type:'challenge',index:0};f.context.displayArmed=true;
  const envelope=f.snapshot({requestId:'replayed-challenge'});envelope.snapshot.replayed=true;envelope.snapshot.nativeChristmasAction={requestId:'replayed-challenge',effects:[{type:'challenged',index:0}]};
  const receipt=f.context.acceptSnapshot(envelope);assert(acknowledged(receipt,envelope));assert.equal(f.count('monster'),0);assert.equal(f.count('business'),0);assert.equal(f.states.length,0);assert.equal(f.context.displayArmed,false);
 });
 for(const [label,change] of [
  ['old sequence',(f,e)=>{e.sequence--;}],['foreign generation',(f,e)=>{e.generation='foreign-generation';}],['foreign character',(f,e)=>{e.snapshot.characterId++;}],
  ['older revision',(f,e)=>{f.context.lastRevision=2;}],['malformed public',(f,e)=>{e.snapshot.nativeChristmas.validated=false;}],['changed live role',(f)=>{f.changeRole();}],
  ['already failed phase',(f)=>{f.context.phase='failed';}],['foreign action UUID',(f,e)=>{f.context.pendingId='owned';f.context.pendingAction={type:'challenge',index:0};e.requestId='foreign';}],
 ])run(`actual acceptSnapshot rejects ${label} without returning a successful acknowledgement`,()=>{
  const f=fixture(methods,0);f.context.read();const envelope=f.snapshot();change(f,envelope);const previousRevision=f.context.lastRevision;
  assert.throws(()=>f.context.acceptSnapshot(envelope));assert.equal(f.context.phase,'failed');assert.equal(f.context.lastRevision,previousRevision);assert.equal(acknowledged(f.context.statusNative(),envelope),false);assert.equal(f.count('monster'),0);assert.equal(f.count('business'),0);assert.equal(f.states.length,0);
 });
 return{method:'Mechanically extracted AS method closures with priority-aware host event, Dictionary identity, Timer and ExternalInterface test doubles; actual AS receipt objects checked against the web acknowledgement predicate; not SWF/AVM2 execution',sourceSha256:sha(source),extracted:methods.map(({factory,...entry})=>entry),count:rows.length,loadingCount,receiptCount:rows.length-loadingCount,rows};
}
