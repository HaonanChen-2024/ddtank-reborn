import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {scan,q,sha} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';
import {verifyShopHostConstructor} from './audit-candidate.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),project=resolve(repo,'../..');
const source=readFileSync(resolve(repo,'scripts/native-devil/WorkshopNativeDevilBootstrap.as'),'utf8');
const host=scan(readFileSync(resolve(project,'runtime/client-overlay/2.png')));
const installed=resolve(project,'runtime/client-overlay/workshop-native/devil/WorkshopNativeDevilBootstrap.swf');

// Only these actual source helpers run with bridge/model/window doubles; this is not AVM2.
function helper(name){
 const m=new RegExp('(?:private|public) function '+name+'\\(([^)]*)\\):[\\w*]+\\s*\\{').exec(source);assert(m,name);
 let at=m.index+m[0].length,depth=1,quote='';
 for(;at<source.length&&depth;at++){const c=source[at];if(quote){if(c==='\\'){at++;continue;}if(c===quote)quote='';continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='{')depth++;if(c==='}')depth--;}
 assert.equal(depth,0);const translate=s=>s.replace(/\b([A-Za-z_$]\w*):(?:Object|int|Boolean|Number|Array|String|Error|\*)(?=\s*(?:[=,;)]|$))/g,'$1').replace(/\bis Array\b/g,'instanceof Array');
 return new Function('context',`return function(${translate(m[1])}){with(context){${translate(source.slice(m.index+m[0].length,at-1))}}}`);
}
function fixture(available=true){
 const trace=[],calls=[],model={clearBoxInfoList(){},addBoxInfo(){}},manager={};
 const projection={available,slots:Array.from({length:8},()=>({originalRenderType:1,grant:{kind:'marks'}})),beads:[0,0,0,0,0],
  boxes:Array.from({length:3},()=>({beadCosts:[1,1,1,0,0],count:0})),milestones:Array.from({length:9},(_,i)=>({drawsRequired:i+1,reward:{templateId:11019,count:1},claimed:false})),
  shop:[11019,11001,11021,11002].map((templateId,i)=>({index:i,reward:{templateId,count:[3,3,1,1][i]},unitMarks:[15,20,25,30][i],maxCount:10,canBuy:true})),draws:0,marks:0,turns:0,freeAvailable:true};
 class ShopItemInfo{constructor(goodsId,templateId){assert.equal(arguments.length,2,'actual ShopItemInfo requires GoodsID and TemplateID');assert(Number.isInteger(goodsId)&&Number.isInteger(templateId));calls.push([goodsId,templateId]);this.GoodsID=goodsId;this.TemplateID=templateId;Object.seal(this);}}
 const ctx={phase:'ready',pending:false,pendingAction:null,pendingId:'',main:null,wantedOpen:false,busy:false,sequence:0,generation:3,expectedId:40,lastRevision:-1,message:'',projection:null,shopInfos:[],
  role(){},statusNative(){return{phase:ctx.phase};},lock(){},report(){},say(m){throw Error(m);},model:()=>model,manager:()=>manager,original:()=>class {},
  cls(name){if(name==='ddt.data.goods.ShopItemInfo')return ShopItemInfo;if(name==='__AS3__.vec::Vector.<workshop.devil.original.model::DevilTurnGoodsItem>')return Array;throw Error(name);},
  ExternalInterface:{call(name,...args){assert.equal(name,'workshopDevilRead');assert.deepEqual(args,[40,3,1]);trace.push('GET');return{accepted:true};}},
  validate(p){assert.equal(p,projection);trace.push('validate');},constructWindow(){trace.push('window');ctx.main={};},renderStatic(){trace.push('render');}};
 for(const name of ['integer','openNative','read','applySnapshot','syncModel'])ctx[name]=helper(name)(ctx);
 return{ctx,projection,calls,trace};
}

test('actual installed ShopItemInfo requires GoodsID then TemplateID with no defaults',()=>{
 const contract=verifyShopHostConstructor([{swf:host}]);
 assert.equal(contract.abcSha256,'f36ff2216315dc712660371a7a9e9833e0c511be0d30d6df566e0e75b98f7972');
 assert.deepEqual(contract.constructor,{method:1,parameters:['::int','::int'],optional:false,identityOrder:['GoodsID','TemplateID']});
});

test('ordinary open and snapshot sync construct all four actual product identities before the window',()=>{
 const{ctx,projection,calls,trace}=fixture(),before=structuredClone(projection);
 ctx.openNative();assert.equal(ctx.pending,true);assert.equal(ctx.wantedOpen,true);assert.deepEqual(trace,['GET']);
 ctx.applySnapshot({generation:3,sequence:1,snapshot:{characterId:40,revision:1,nativeDevil:projection}});
 assert.deepEqual(calls,[[1,11019],[2,11001],[3,11021],[4,11002]]);
 assert.deepEqual(ctx.shopInfos.map(i=>[i.GoodsID,i.TemplateID]),calls);assert.deepEqual(trace,['GET','validate','window','render']);
 assert.equal(ctx.pending,false);assert.equal(ctx.lastRevision,1);assert.deepEqual(projection,before,'server product counts/costs remain unchanged');
});

test('unavailable snapshot never constructs a ShopItemInfo',()=>{
 const{ctx,projection,calls}=fixture(false);ctx.openNative();ctx.applySnapshot({generation:3,sequence:1,snapshot:{characterId:40,revision:1,nativeDevil:projection}});
 assert.equal(calls.length,0);assert.equal(ctx.shopInfos.length,0);
});

test('compiled candidate supplies two identities and preserves every non-target bootstrap method',{skip:!process.env.DEVIL_CANDIDATE},()=>{
 const candidate=scan(readFileSync(resolve(process.env.DEVIL_CANDIDATE,'flash/workshop-native/devil/WorkshopNativeDevilBootstrap.swf'))).abcs[0],old=scan(readFileSync(installed)).abcs[0];
 const trait=candidate.p.methodTraits.find(t=>candidate.p.strings[candidate.p.names[t.name]?.name]==='syncModel');assert(trait);
 const ops=decode(candidate.p.bodies.find(b=>b.method===trait.method).code),start=ops.findIndex(o=>o.op===0x2c&&candidate.p.strings[o.args[0]]==='ddt.data.goods.ShopItemInfo');assert(start>=0);
 const construct=ops.slice(start).find(o=>o.op===0x42);assert.equal(construct.args[0],2);
 assert.deepEqual(ops.filter(o=>[0x61,0x68].includes(o.op)&&['::GoodsID','::TemplateID'].includes(q(candidate.p,o.args[0]))).slice(-2).map(o=>q(candidate.p,o.args[0])),['::GoodsID','::TemplateID']);
 assert.equal(candidate.p.bodies.length,old.p.bodies.length);let unchanged=0;
 for(const body of old.p.bodies){if(body.method===trait.method)continue;assert.equal(sha(candidate.p.bodies.find(b=>b.method===body.method).code),sha(body.code),'untouched method '+body.method);unchanged++;}
 assert(unchanged>0);
});
