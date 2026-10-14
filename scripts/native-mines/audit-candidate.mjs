import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scan,sha,q} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';
const classes=a=>a.p.traitBlocks.filter(t=>t.owner!=null).map(t=>q(a.p,t.owner));
const qops=new Set([4,5,0x45,0x46,0x4a,0x4c,0x4e,0x4f,0x5d,0x5e,0x5f,0x60,0x61,0x66,0x68,0x6a,0x80,0x86,0xb2]);
function names(p,i){const n=p.names[i];if(!n)return[];if(n.ns)return[q(p,i)];if(!n.name)return[];return p.namespaces.filter(Boolean).map(ns=>`${p.strings[ns.name]}::${p.strings[n.name]}`);}
export function auditMines({outputDir,projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..'),sharedPath,write=true}){
  const out=resolve(outputDir),manifest=JSON.parse(readFileSync(resolve(out,'manifest.json'),'utf8'));
  const original=scan(readFileSync(resolve(projectRoot,'runtime/reference-activities-completion-20261014/reference-core/2_v3_6_1_u9.png'))),known=new Set(original.abcs.flatMap(classes));
  const lib=scan(readFileSync(resolve(out,'flash/workshop-native/mines/mines-original-library.swf')));
  const shared=scan(readFileSync(sharedPath??resolve(projectRoot,'runtime/reference-activities-completion-20261014/native-unified-candidate-20261015/flash/workshop-native/shared/native-shared-library.swf')));
  const hostPaths=['runtime/client-overlay/2.png','source/ddtank-reborn/apps/api/assets/flash/3.png','source/ddtank-reborn/apps/api/assets/flash/DDT_Loading.swf'];
  const host=hostPaths.map(file=>{const path=resolve(projectRoot,file),bytes=readFileSync(path);return {path,sha256:sha(bytes),swf:scan(bytes)};});
  const hostClasses=new Set(host.flatMap(h=>h.swf.abcs.flatMap(classes))),own=new Set([...shared.abcs,...lib.abcs].flatMap(classes));own.add('::WorkshopNativeMinesBootstrap');
  const deps=new Map(),dispatches=[],guards=[],forbidden=[];
  assert.equal(lib.abcs.length,20);assert.equal(shared.abcs.length,82);assert(!lib.abcs.some(a=>a.name.endsWith('/BoguAdventureStateView')));
  for(const a of lib.abcs){
    const entry=manifest.library.owners.find(o=>o.owner===a.name),source=original.abcs.find(o=>o.name===a.name);assert(entry&&source);assert.equal(sha(a.abc),entry.abcSha256);
    const register=(name,method)=>{if(!known.has(name)||own.has(name)||name.startsWith('flash.'))return;const d=deps.get(name)??{class:name,presentInHost:hostClasses.has(name),usedBy:[]};if(!d.usedBy.some(u=>u.owner===a.name&&u.method===method))d.usedBy.push({owner:a.name,method});deps.set(name,d);};
    for(const m of a.p.methods)for(const i of [m.returnType,...m.params])for(const n of names(a.p,i))register(n,'signature');
    for(const b of a.p.bodies){
      const ops=decode(b.code),change=entry.changes.find(c=>c.method===b.method);
      for(const op of ops.filter(o=>qops.has(o.op))){const simple=a.p.strings[a.p.names[op.args[0]]?.name];if(['SocketManager','CheckMoneyUtils','ActivityTimeManager','ServerConfigManager','PathManager','KeyboardManager','StageReferance','Mouse','SimpleReturnBar'].includes(simple))forbidden.push({owner:a.name,method:b.method,name:simple});for(const n of names(a.p,op.args[0]))register(n,b.method);}
      if(change?.kind==='dispatch'){const calls=ops.filter(o=>o.op===0x46);assert.equal(calls.length,1);assert.equal(q(a.p,calls[0].args[0]),'::dispatch');assert.equal(calls[0].args[1],4);dispatches.push({owner:a.name,method:b.method,name:change.name});}
      else if(change?.kind==='disposed-late-completion-guard'){
        const before=source.p.bodies.find(s=>s.method===b.method).code,cut=change.insertOffset,added=b.code.length-before.length;assert(added>0);assert.deepEqual(b.code.subarray(0,cut),before.subarray(0,cut));assert.deepEqual(b.code.subarray(cut+added),before.subarray(cut));guards.push({owner:a.name,method:change.name,addedBytes:added});
      }else if(change?.kind==='constructor-no-socket'){assert.equal(a.name,'activity/boguAdventure/BoguAdventureControl');assert.equal(ops.filter(o=>o.op===0x49).length,1);}
      else assert.deepEqual(b.code,source.p.bodies.find(s=>s.method===b.method).code,'untouched animation/map body changed');
      // Validate all explicit branch destinations, including inserted disposal guards.
      const starts=new Set([...ops.map(o=>o.offset),b.code.length]);for(const op of ops)if(op.op>=12&&op.op<=26)assert(starts.has(op.end+op.args[0]),'branch not at instruction boundary');
    }
  }
  assert.deepEqual(forbidden,[]);assert.equal(guards.length,2);
  const missing=[...deps.values()].filter(d=>!d.presentInHost);
  const report={at:new Date().toISOString(),status:'offline structural verification only',owners:20,sharedOwners:82,dispatchCount:dispatches.length,dispatches,disposedCompletionGuards:guards,host:host.map(({path,sha256})=>({path,sha256})),requiredHostClasses:[...deps.values()],missingHostClasses:missing,forbiddenCalls:forbidden,originalCellAndMapBodiesUnchanged:true,unverified:['AVM2/Ruffle runtime verifier and UI cycles','Original movement/explosion/probe, close while loading, reopen, role drift','All three first-open orders and same-page concurrency','Actual API UUID replay and manual reward mail from original window'],installed:false};
  if(write)writeFileSync(resolve(out,'offline-audit.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=auditMines({outputDir:process.argv[2]});console.log(JSON.stringify({owners:r.owners,dispatchCount:r.dispatchCount,missingHostClasses:r.missingHostClasses,forbiddenCalls:r.forbiddenCalls,runtimeValidated:false},null,2));}
