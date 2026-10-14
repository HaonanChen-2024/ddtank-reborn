import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scan,sha,q} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';
const classes=a=>a.p.traitBlocks.filter(t=>t.owner!=null).map(t=>q(a.p,t.owner));
const qops=new Set([4,5,0x45,0x46,0x4a,0x4c,0x4e,0x4f,0x5d,0x5e,0x5f,0x60,0x61,0x66,0x68,0x6a,0x80,0x86,0xb2]);
function names(p,i){const n=p.names[i];if(!n)return[];if(n.ns)return[q(p,i)];if(!n.name)return[];return p.namespaces.filter(Boolean).map(ns=>(p.strings[ns.name]??'')+'::'+p.strings[n.name]);}
export function auditDDPlay({outputDir,projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..'),sharedPath,write=true}){
 const out=resolve(outputDir),m=JSON.parse(readFileSync(resolve(out,'manifest.json'),'utf8')),original=scan(readFileSync(resolve(projectRoot,'runtime/reference-activities-completion-20261014/reference-core/2_v3_6_1_u9.png'))),known=new Set(original.abcs.flatMap(classes));
 const lib=scan(readFileSync(resolve(out,'flash/workshop-native/ddplay/ddplay-original-library.swf'))),boot=scan(readFileSync(resolve(out,'flash/workshop-native/ddplay/WorkshopNativeDDPlayBootstrap.swf'))),shared=scan(readFileSync(sharedPath??resolve(projectRoot,'runtime/reference-activities-completion-20261014/native-unified-candidate-20261015/flash/workshop-native/shared/native-shared-library.swf')));
 const host=['runtime/client-overlay/2.png','source/ddtank-reborn/apps/api/assets/flash/3.png','source/ddtank-reborn/apps/api/assets/flash/DDT_Loading.swf'].map(file=>{const path=resolve(projectRoot,file),b=readFileSync(path);return{path,sha256:sha(b),swf:scan(b)};});
 const hostClasses=new Set(host.flatMap(h=>h.swf.abcs.flatMap(classes))),own=new Set([...lib.abcs,...boot.abcs,...shared.abcs].flatMap(classes));assert.equal(lib.abcs.length,7);assert.equal(shared.abcs.length,82);assert.equal(lib.abcs.filter(a=>a.name.startsWith('DDPlay/')).length,5);
 const dependencies=new Map(),dispatches=[],hooks=[],unchanged=[],forbidden=[];
 for(const a of lib.abcs.filter(a=>a.name.startsWith('DDPlay/'))){const source=original.abcs.find(s=>s.name===a.name),entry=m.library.owners.find(o=>o.owner===a.name);assert(source&&entry);assert.equal(sha(a.abc),entry.abcSha256);
  const register=(name,method)=>{if(!known.has(name)||own.has(name)||name.startsWith('flash.'))return;const d=dependencies.get(name)??{class:name,presentInHost:hostClasses.has(name),usedBy:[]};d.usedBy.push({owner:a.name,method});dependencies.set(name,d);};
  for(const method of a.p.methods)for(const i of [method.returnType,...method.params])for(const n of names(a.p,i))register(n,'signature');
  for(const b of a.p.bodies){const ops=decode(b.code),change=entry.changes.find(c=>c.method===b.method);assert(b.maxScope>=b.initialScope&&b.maxStack>0);
   for(const op of ops.filter(o=>qops.has(o.op))){const simple=a.p.strings[a.p.names[op.args[0]]?.name];if(['SocketManager','UIModuleLoader','UIModuleSmallLoading','LeavePageManager','ShopManager','BaglockedManager','DDPlayQuickBuy','DDPlayEnter','DDPlayStart','DDPlayExchange','sendBuyGoods'].includes(simple))forbidden.push({owner:a.name,method:b.method,name:simple});for(const n of names(a.p,op.args[0]))register(n,b.method);}
   if(change?.kind==='dispatch'){const calls=ops.filter(o=>o.op===0x46);assert.equal(calls.length,1);assert.equal(q(a.p,calls[0].args[0]),'::dispatch');assert.equal(calls[0].args[1],4);dispatches.push({owner:a.name,method:b.method,name:change.name});}
   else if(change?.kind==='original-animation-complete-hook'){const before=source.p.bodies.find(s=>s.method===b.method).code;assert.deepEqual(b.code.subarray(0,before.length-1),before.subarray(0,-1));assert.equal(b.code.at(-1),0x47);hooks.push({owner:a.name,method:change.name,originalPrefixUnchanged:true});}
   else {assert.deepEqual(b.code,source.p.bodies.find(s=>s.method===b.method).code);unchanged.push({owner:a.name,method:b.method});}
   const starts=new Set([...ops.map(o=>o.offset),b.code.length]);for(const op of ops)if(op.op>=12&&op.op<=26)assert(starts.has(op.end+op.args[0]),'branch not at instruction boundary');
  }
 }
 assert.deepEqual(forbidden,[]);assert.equal(hooks.length,1);
 const manager=lib.abcs.find(a=>a.name==='DDPlay/DDPlayManaer'),originalManager=original.abcs.find(a=>a.name===manager.name);
 const privateSingleton=classes(originalManager).find(n=>n.endsWith('::DDPlayInstance'));assert(privateSingleton);assert(classes(manager).includes(privateSingleton),'private singleton class identity retained');assert(!classes(manager).includes('::DDPlayInstance'));
 const view=lib.abcs.find(a=>a.name==='DDPlay/DDPlayView'),source=original.abcs.find(a=>a.name===view.name);
 const originalAnimation=['startLottery','reSetBogu','_sixBogu1Com','_sixBogu2Com','_sixBogu3Com'].map(name=>{const t=view.p.methodTraits.find(t=>view.p.strings[view.p.names[t.name]?.name]===name),b=view.p.bodies.find(b=>b.method===t.method);assert.deepEqual(b.code,source.p.bodies.find(s=>s.method===b.method).code);return{name,sha256:sha(b.code)};});
 const bitmap=lib.tags.find(t=>[6,20,21,35,36,90].includes(t.code)&&lib.body.readUInt16LE(t.bodyStart)===m.library.bitmap.id);assert(bitmap);assert.equal(sha(bitmap.raw),m.library.bitmap.tagSha256);
 const back=lib.abcs.find(a=>a.name==='com/greensock/easing/Back'),originalBack=original.abcs.find(a=>a.name===back.name);assert.deepEqual(back.abc,originalBack.abc);
 const report={at:new Date().toISOString(),status:'offline structural verification only',businessOwners:5,libraryAbcCount:7,sharedOwners:82,dispatchCount:dispatches.length,dispatches,originalAnimation,completionHooks:hooks,privateSingleton,originalBackUnchanged:true,requiredHostClasses:[...dependencies.values()],missingHostClasses:[...dependencies.values()].filter(d=>!d.presentInHost),forbiddenCalls:forbidden,bitmapPayloadUnchanged:true,host:host.map(({path,sha256})=>({path,sha256})),unverified:['AVM2/Ruffle runtime verification','Original reel animation, image label cover alignment and exchange whole-cycle rendering','Close during request/reels, late completion, role drift, same-page ordering','Real UI to local API exchange mail and exact UUID replay'],installed:false};
 if(write)writeFileSync(resolve(out,'offline-audit.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=auditDDPlay({outputDir:process.argv[2]});console.log(JSON.stringify({businessOwners:r.businessOwners,dispatchCount:r.dispatchCount,missingHostClasses:r.missingHostClasses,forbiddenCalls:r.forbiddenCalls,installed:false},null,2));}
