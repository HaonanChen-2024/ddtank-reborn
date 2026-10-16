import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {scan,q} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';
import {adaptTreasure,treasureForbidden,treasureOwners} from './build-library.mjs';
import {activeLayouts,readLayouts,treasureTicketSkins} from './extract-resources.mjs';
import {parseActivityAbc} from '../../tools/i18n/abc-strings/activity-response.mjs';

const here=dirname(fileURLToPath(import.meta.url)),project=resolve(here,'../../../..');
const source=readFileSync(resolve(here,'WorkshopNativeTreasureBootstrap.as'),'utf8');
function method(name){const start=source.indexOf('function '+name+'(');assert(start>=0,name);const open=source.indexOf('{',start);let depth=1,end=open+1;for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}return source.slice(open+1,end-1);}
function run(name,params,args,c){const code=method(name).replace(/for each\((var )?(\w+)(?::(?:Object|String|Array|TextField|\*))? in ([^\n]*?)\)/g,'for($1$2 of $3)').replace(/:(?:Boolean|Object|String|Array|int|Number|Error|TextField)\b|:\*/g,'').replace(/([\w.]+) is Array/g,'Array.isArray($1)').replace(/ as (?:Array|DisplayObject)/g,'');return new Function(...params,'with(this){'+code+'}').call(c,...args);}
const int=v=>Math.trunc(Number(v)||0);
function shop(){const view={buyCountInput:{text:'1'},tipMsgLab:{},confirmBtn:{},closeBtn:{},cancelBtn:{}},c={int,pending:false,animating:false,confirmation:null,popup:view,ticketQuote:{mode:'advanced',unitCost:60,maxCount:20,canBuy:true,choice:'frozen-token',poolVersion:'a'.repeat(64)},projection:{readiness:{status:'ready',description:'完整池'}},requests:[],locks:0,say(){},role(){},lock(){this.locks++;},request(action){this.requests.push(action);this.pending=true;},closePopup(){this.popup=null;this.ticketQuote=null;}};c.ticketCount=value=>run('ticketCount',['value'],[value],c);c.updateTicketShop=view=>run('updateTicketShop',['view'],[view],c);c.ticketPurchaseAction=count=>run('ticketPurchaseAction',['count'],[count],c);return {c,view};}
function effect(){const c={projection:{score:600,tickets:{normal:2,advanced:3}}},action={type:'buy-tickets',mode:'advanced',count:4},p={score:360,tickets:{normal:2,advanced:7}},result={type:'tickets-bought',mode:'advanced',count:4,cost:240,score:360,tickets:{...p.tickets}};return {c,action,p,result,check(){return run('validTicketEffect',['result','action','p'],[this.result,this.action,this.p],this.c);}};}

test('original buy-card owners keep original disposal but disconnect every payment and socket body',()=>{
 const original=scan(readFileSync(resolve(project,'runtime/reference-activities-completion-20261014/reference-core/2_v3_6_1_u9.png'))),a=original.abcs.find(a=>a.name==='treasureHunting/views/TreasureHuntBuyCardAlertView'),adapted=adaptTreasure(a),p=parseActivityAbc(adapted.bytes),body=(p,name)=>{const t=p.methodTraits.find(t=>p.strings[p.names[t.name]?.name]===name);assert(t,name);return p.bodies.find(b=>b.method===t.method);};
 assert.equal(treasureOwners.length,19);assert(treasureOwners.includes('treasureHunting/views/mornui/View/TreasureBuyCardAlertUI'));assert(treasureForbidden.includes('sendHuntingBuyCardBox'));
 assert.deepEqual(body(p,'dispose').code,body(a.p,'dispose').code);
 for(const name of ['initialize','__onChange','__onConfirmBtn','show','__onClickCancleOrCloseBtn']){const ops=decode(body(p,name).code);assert.equal(ops.filter(o=>o.op===0x46&&q(p,o.args[0])==='::dispatch').length,1);if(name==='initialize')assert(ops.some(o=>o.op===0x45&&q(p,o.args[0])==='morn.core.components:Component::initialize'));}
 for(const b of p.bodies)for(const op of decode(b.code).filter(o=>[0x60,0x5d,0x46,0x4f,0x4a,0x66].includes(o.op)))assert(!treasureForbidden.includes(p.strings[p.names[op.args[0]]?.name]),'legacy payment reachable');
});
test('seventh original AMF layout closes its five shared skin dependencies against pinned original bitmaps',()=>{
 const layouts=readLayouts(readFileSync(resolve(project,'runtime/reference-activities-completion-20261014/native-maze-analysis-20261015/treasurehunting_v3_6_1_u1.ui'))),buy=layouts.find(l=>l.name==='View/TreasureBuyCardAlert.xml'),skins=treasureTicketSkins(project);
 assert.equal(activeLayouts.length,7);assert(activeLayouts.includes(buy.name));assert.equal(skins.length,5);
 for(const [,name]of buy.xml.matchAll(/skin="([^"]+)"/g))assert(skins.some(s=>s.name===name));
 assert(skins.every(s=>s.externalCandidateDependency===true&&s.file.startsWith('../pair/pair-shared-art-')&&/^[a-f0-9]{64}$/.test(s.bitmapTagSha256)));
 assert.match(method('loadTicketSkin'),/domain\.hasDefinition/);assert.match(method('loadTicketSkin'),/\.\.\/pair\/pair-shared-art-/);
});
test('original quantity input clamps to one through99 and fixed quote disables over-capacity or blocked purchases',()=>{
 const {c,view}=shop();for(const [value,want]of [['',1],['0',1],['-1',1],['1',1],['20',20],['99',99],['100',99]]){assert.equal(c.ticketCount(value),want);view.buyCountInput.text=value;c.updateTicketShop(view);assert.equal(view.buyCountInput.text,String(want));assert.equal(view.confirmBtn.disabled,want>20);}
 view.buyCountInput.text='4';c.updateTicketShop(view);assert.match(view.tipMsgLab.text,/高级券 ×4（每张60积分）\n合计240本地任务积分/);
 c.pending=true;c.updateTicketShop(view);assert.equal(view.confirmBtn.disabled,true);c.pending=false;c.ticketQuote.canBuy=false;c.projection.readiness.status='blocked';c.updateTicketShop(view);assert.equal(view.confirmBtn.disabled,true);assert.equal(view.confirmBtn.toolTip,'完整池');
});
test('modal freezes mode, local price, token and pool at open even if the live projection changes',()=>{
 const {c,view}=shop();c.popup=null;c.main={};c.advancedMode=false;c.projection={bagToken:'open-token',poolVersion:'b'.repeat(64),ticketShop:{offers:[{mode:'normal',unitCost:30,maxCount:5,canBuy:true},{mode:'advanced',unitCost:60,maxCount:2,canBuy:true}]}};let added;
 c.cls=name=>{assert.equal(name,'treasureHunting.views.TreasureHuntBuyCardAlertView');return function(){return view;};};c.sceneRoot={addChild(v){added=v;}};c.updateTicketShop=()=>{};
 run('openTicketShop',[],[],c);assert.equal(added,view);assert.equal(view.x,220);assert.equal(view.y,120);
 c.advancedMode=true;c.projection.bagToken='changed';c.projection.poolVersion='c'.repeat(64);c.projection.ticketShop.offers[0].unitCost=999;
 assert.deepEqual(c.ticketPurchaseAction(3),{type:'buy-tickets',choice:'open-token',mode:'normal',count:3,poolVersion:'b'.repeat(64)});assert.equal(c.ticketQuote.unitCost,30);
});
test('confirm submits one frozen buy action, never payment or auto-draw; cancellation and blocked pool submit none',()=>{
 const {c,view}=shop();view.buyCountInput.text='4';run('buyTickets',['view'],[view],c);run('buyTickets',['view'],[view],c);assert.deepEqual(c.requests,[{type:'buy-tickets',choice:'frozen-token',mode:'advanced',count:4,poolVersion:'a'.repeat(64)}]);assert.equal(c.popup,null);
 for(const mutate of [c=>c.ticketQuote.canBuy=false,c=>c.ticketQuote.maxCount=0,c=>c.projection.readiness.status='blocked',c=>c.pending=true,c=>c.animating=true]){const f=shop();mutate(f.c);run('buyTickets',['view'],[f.view],f.c);assert.deepEqual(f.c.requests,[]);}
 const f=shop();f.c.closePopup();assert.deepEqual(f.c.requests,[]);assert.doesNotMatch(method('buyTickets'),/checkMoney|sendHunting|drawAction/);
});
test('ticket purchase confirms exact two balances and one points charge; cross-mode or counterfeit balances fail',()=>{
 const f=effect();assert(f.check());for(const mutate of [f=>f.result.cost=0,f=>f.result.mode='normal',f=>f.result.count=3,f=>f.result.score++,f=>f.result.tickets.advanced++,f=>f.p.tickets.normal++,f=>f.p.score++,f=>f.c.projection.tickets.advanced=0]){const g=effect();mutate(g);assert(!g.check());}
});
test('an unrelated task credit after opening does not falsify committed wallet confirmation',()=>{const f=effect();f.p.score=420;f.result.score=420;assert(f.check());assert.equal(f.result.cost,240);f.result.score=360;assert(!f.check());});
test('ticket draw costs zero points and spends only the matching mode ticket, while old draw fields remain unchanged',()=>{
 const f=effect();f.action={type:'draw',mode:'advanced',count:2,funding:'tickets'};f.p={score:600,tickets:{normal:2,advanced:1}};f.result={type:'drawn',mode:'advanced',count:2,funding:'tickets',ticketsSpent:2,cost:0,score:600,tickets:{...f.p.tickets}};assert(f.check());f.result.ticketsSpent=1;assert(!f.check());f.result.ticketsSpent=2;f.p.score=480;assert(!f.check());f.result.score=480;assert(f.check());
 const c={selection:[14,2,9,1],projection:{bagToken:'token',poolVersion:'d'.repeat(64)}};
 const old=run('drawAction',['mode','count','byTickets'],['advanced',5,false],c),ticket=run('drawAction',['mode','count','byTickets'],['advanced',5,true],c);
 assert.deepEqual(old,{type:'draw',mode:'advanced',count:5,choice:'token',selection:[14,2,9,1],poolVersion:'d'.repeat(64)});assert.deepEqual(ticket,{...old,funding:'tickets'});c.selection.length=0;assert.equal(ticket.selection.length,4);
});
test('original hunt uses ticket choices; separate old points entrance never injects default funding',()=>{
 const c={main:{lxTreasureCb:{selected:false}},pending:false,animating:false,confirmation:null,popup:null,advancedMode:true,selection:[14,2,9,1],projection:{bagToken:'token',poolVersion:'a'.repeat(64),readiness:{status:'ready'},drawChoices:Array.from({length:10},(_,i)=>({canDraw:true,cost:(i%5+1)*(i<5?30:60)})),ticketDrawChoices:Array.from({length:10},(_,i)=>({canDraw:i<5,ticketsRequired:i%5+1}))},messages:[],confirmations:[],say(s){this.messages.push(s);},confirm(text,action){this.confirmations.push({text,action});},setMode(v){this.advancedMode=v;this.selection=[];}};
 c.drawAction=(mode,count,byTickets)=>run('drawAction',['mode','count','byTickets'],[mode,count,byTickets],c);
 run('draw',['view','byPoints'],[c.main,false],c);assert.equal(c.confirmations.length,0);assert.match(c.messages[0],/对应寻宝券/);
 run('draw',['view','byPoints'],[c.main,true],c);assert.equal(c.confirmations.length,1);assert.equal(c.confirmations[0].action.mode,'normal');assert(!('funding'in c.confirmations[0].action));assert.match(c.confirmations[0].text,/30活动积分/);
 c.projection.ticketDrawChoices[0].canDraw=true;run('draw',['view','byPoints'],[c.main,false],c);assert.equal(c.confirmations[1].action.funding,'tickets');assert.match(c.confirmations[1].text,/不再扣积分/);
});
function snapshot({purchase=false,replay=false,closed=false}={}){
 const before={score:600,tickets:{normal:2,advanced:3}},action=purchase?{type:'buy-tickets',mode:'normal',count:2}:{type:'draw',funding:'tickets',mode:'advanced',count:1,selection:[14,2,9,1],poolVersion:'a'.repeat(64)},p={score:purchase?540:600,tickets:{normal:purchase?4:2,advanced:purchase?3:2},draws:1,bag:[{index:0,templateId:9000,itemCount:1,origin:'original-catalog',entryKey:'entry',sourceOriginalIndex:2,poolVersion:'a'.repeat(64)}]},reward={index:0,templateId:9000,itemCount:1,entryKey:'entry',sourceOriginalIndex:2},effect=purchase?{type:'tickets-bought',mode:'normal',count:2,cost:60,score:540,tickets:{...p.tickets}}:{type:'drawn',mode:'advanced',count:1,cost:0,score:600,draws:1,funding:'tickets',ticketsSpent:1,tickets:{...p.tickets},rewards:[reward]},c={phase:'ready',expectedId:55,generation:'g',sequence:3,lastRevision:0,pending:true,pendingId:'uuid',pendingAction:action,projection:before,wantedOpen:!closed,main:closed?null:{},animating:false,starts:0,role(){},integer:Number.isSafeInteger,validate(){},validDrawReward(){return true;},lock(){},report(){},statusNative(){return this;},renderStatic(){},startNextReward(){this.starts++;},control(){return {};}};
 c.validTicketEffect=(result,action,p)=>run('validTicketEffect',['result','action','p'],[result,action,p],c);
 return {c,p,envelope:{generation:'g',sequence:3,requestId:'uuid',snapshot:{characterId:55,revision:1,replayed:replay,nativeTreasure:p,...replay?{}:{nativeTreasureAction:{requestId:'uuid',effects:[effect]}}}}};
}
test('fresh ticket draw animates only confirmed rewards; purchase, replay and late closed responses never animate',()=>{
 for(const options of [{},{purchase:true},{replay:true},{closed:true}]){const f=snapshot(options);run('applySnapshot',['envelope'],[f.envelope],f.c);assert.equal(f.c.starts,options.purchase||options.replay||options.closed?0:1);assert.equal(f.c.pending,false);assert.equal(f.c.pendingId,'');assert.equal(f.c.projection,f.p);}
 for(const mutate of [f=>f.envelope.requestId='wrong',f=>f.envelope.sequence=2,f=>f.envelope.snapshot.nativeTreasureAction.effects[0].ticketsSpent=2,f=>f.envelope.snapshot.nativeTreasureAction.effects[0].tickets.advanced=99]){const f=snapshot();mutate(f);assert.throws(()=>run('applySnapshot',['envelope'],[f.envelope],f.c));assert.equal(f.c.pendingId,'uuid');assert.equal(f.c.pending,true);assert.equal(f.c.starts,0);}
});
test('closing pending purchase preserves page-owned UUID and action; no read or new purchase on reopening uncertainty',()=>{
 const action={type:'buy-tickets',mode:'normal',count:2},c={wantedOpen:true,animating:false,rewardQueue:[],animationSelection:[],selection:[],advancedMode:true,ticketQuote:{},pending:true,pendingId:'original-uuid',pendingAction:action,main:null,sceneRoot:null,notice:null,phase:'ready',domain:{hasDefinition(){return false;}},role(){},report(){},statusNative(){return this;},clearConfirm(){},closePopup(){this.ticketQuote=null;},say(){},read(){throw Error('uncertain action must not create a read');}};
 run('closeNative',[],[],c);assert.equal(c.pendingId,'original-uuid');assert.equal(c.pendingAction,action);assert.equal(c.pending,true);run('openNative',[],[],c);assert.equal(c.wantedOpen,false);assert.equal(c.pendingId,'original-uuid');
});
test('real compiled candidate carries buy owner and original dispose plus ticket confirmation and real balances',{skip:!process.env.TREASURE_PREVIEW_CANDIDATE},()=>{
 const dir=resolve(process.env.TREASURE_PREVIEW_CANDIDATE,'flash/workshop-native/treasure'),boot=scan(readFileSync(resolve(dir,'WorkshopNativeTreasureBootstrap.swf'))).abcs[0],lib=scan(readFileSync(resolve(dir,'treasure-original-library.swf'))),calls=name=>{const t=boot.p.methodTraits.find(t=>boot.p.strings[boot.p.names[t.name]?.name]===name);assert(t,name);return decode(boot.p.bodies.find(b=>b.method===t.method).code).filter(o=>[0x46,0x4f].includes(o.op)).map(o=>q(boot.p,o.args[0]));};
 assert.equal(lib.abcs.length,19);assert(calls('buyTickets').some(n=>n.endsWith('::request')));assert(calls('buyTickets').some(n=>n.endsWith('::closePopup')));assert(calls('applySnapshot').some(n=>n.endsWith('::validTicketEffect')));assert(calls('loadTicketSkin').some(n=>n.endsWith('::hasDefinition')));
 for(const name of ['tickets-bought','funding','ticketsSpent','ticketShop','ticketDrawChoices','local-task-points'])assert(boot.p.strings.includes(name));
 assert.doesNotMatch(method('closeNative'),/pendingId\s*=|pendingAction\s*=/);assert.match(method('syncModel'),/_normalTicketNum=projection\.tickets\.normal;m\._exTicketNum=projection\.tickets\.advanced/);
});
