import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ByteReader} from '../../tools/i18n/abc-strings/lib.mjs';
import {scan,sha,q} from './build-library.mjs';
// Bounded AVM2 operand reader, reused from the existing loader-trace decoder.
const one=new Set([4,5,6,8,0x25,0x2c,0x2d,0x2e,0x2f,0x31,0x40,0x41,0x42,0x49,0x53,0x55,0x56,0x58,0x59,0x5a,0x5d,0x5e,0x5f,0x60,0x61,0x62,0x63,0x66,0x67,0x68,0x6a,0x6c,0x6d,0x6e,0x6f,0x80,0x86,0x92,0x94,0xb2,0xc2,0xc3,0xf0,0xf1,0xf2]);
const two=new Set([0x32,0x43,0x44,0x45,0x46,0x4a,0x4c,0x4e,0x4f]);
const none=new Set([1,2,3,7,9,0x1c,0x1d,0x1e,0x1f,0x20,0x21,0x23,0x26,0x27,0x28,0x29,0x2a,0x2b,0x30,0x35,0x36,0x37,0x38,0x39,0x3a,0x3b,0x3c,0x3d,0x3e,0x47,0x48,0x50,0x51,0x52,0x57,0x64,0x69,0x6b,0x70,0x71,0x72,0x73,0x74,0x75,0x76,0x77,0x78,0x81,0x82,0x83,0x84,0x85,0x87,0x88,0x89,0x90,0x91,0x93,0x95,0x96,0x97,0xa0,0xa1,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8,0xa9,0xaa,0xab,0xac,0xad,0xae,0xaf,0xb0,0xb1,0xb3,0xb4,0xc0,0xc1,0xc4,0xc5,0xc6,0xc7,0xd0,0xd1,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7]);
export function decode(code){const r=new ByteReader(code),out=[];while(r.pos<code.length){const offset=r.pos,op=r.bytes(1)[0],args=[];if(op>=12&&op<=26)args.push(r.bytes(3).readIntLE(0,3));else if(op===0x1b){args.push(r.bytes(3).readIntLE(0,3));const n=r.u30();args.push(n);for(let i=0;i<=n;i++)args.push(r.bytes(3).readIntLE(0,3));}else if(one.has(op))args.push(r.u30());else if(two.has(op))args.push(r.u30(),r.u30());else if(op===0x24||op===0x65)args.push(r.bytes(1)[0]);else if(op===0xef)args.push(r.bytes(1)[0],r.u30(),r.bytes(1)[0],r.u30());else assert(none.has(op),`unknown opcode ${op} at ${offset}`);assert(r.pos<=code.length);out.push({op,args,offset,end:r.pos});}return out;}
const qops=new Set([4,5,0x45,0x46,0x4a,0x4c,0x4e,0x4f,0x5d,0x5e,0x5f,0x60,0x61,0x66,0x68,0x6a,0x80,0x86,0xb2]);
function names(p,index){const n=p.names[index];if(!n)return[];if(n.ns)return[q(p,index)];if(!n.name)return[];return p.namespaces.filter(Boolean).map(ns=>`${p.strings[ns.name]}::${p.strings[n.name]}`);}
const classes=a=>a.p.traitBlocks.filter(t=>t.owner!=null).map(t=>q(a.p,t.owner));
export function auditCandidate({outputDir,projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..'),write=true}){
  const out=resolve(outputDir),manifest=JSON.parse(readFileSync(resolve(out,'manifest.json'),'utf8')),asset=resolve(out,'flash/workshop-native/pair');
  const original=scan(readFileSync(resolve(projectRoot,'runtime/reference-activities-completion-20261014/reference-core/2_v3_6_1_u9.png')));
  const pair=scan(readFileSync(resolve(asset,'pair-original-library.swf'))),shared=scan(readFileSync(resolve(asset,'pair-shared-library.swf')));
  const hostPath=resolve(projectRoot,'runtime/client-overlay/2.png'),hostBytes=readFileSync(hostPath),host=scan(hostBytes);
  const known=new Set(original.abcs.flatMap(classes)),hostClasses=new Set(host.abcs.flatMap(classes)),own=new Set([...pair.abcs,...shared.abcs].flatMap(classes));own.add('::WorkshopNativePairBootstrap');
  const dependencies=new Map(),forbidden=[],dispatches=[];
  for(const a of pair.abcs){
    const source=original.abcs.find(o=>o.name===a.name);assert(source);
    const entry=manifest.libraries[1].owners.find(o=>o.owner===a.name);assert.equal(sha(a.abc),entry.abcSha256);
    if(!entry.changes.length)assert.deepEqual(a.abc,source.abc);
    const register=(name,method)=>{if(!known.has(name)||own.has(name)||name.startsWith('flash.'))return;const d=dependencies.get(name)??{class:name,presentInHost:hostClasses.has(name),usedBy:[]};if(!d.usedBy.some(u=>u.owner===a.name&&u.method===method))d.usedBy.push({owner:a.name,method});dependencies.set(name,d);};
    for(const m of a.p.methods)for(const i of [m.returnType,...m.params])for(const name of names(a.p,i))register(name,'signature');
    for(const b of a.p.bodies){
      const ops=decode(b.code);
      for(const op of ops.filter(i=>qops.has(i.op))){const simple=a.p.strings[a.p.names[op.args[0]]?.name];if(['SocketManager','CheckMoneyUtils','GameSocketOut','sendBuyGoods','sendBuyReel','getValidGoodsArrayByType','PairBoxPriceConfig','fillByID'].includes(simple))forbidden.push({owner:a.name,method:b.method,offset:op.offset,name:simple});for(const name of names(a.p,op.args[0]))register(name,b.method);}
      const patch=entry.changes.find(c=>c.dispatch&&c.method===b.method);
      if(patch){
        const calls=ops.filter(o=>o.op===0x46);assert.equal(calls.length,1);assert.equal(q(a.p,calls[0].args[0]),'::dispatch');assert.equal(calls[0].args[1],4);assert.equal(b.exceptions,0);
        assert(ops.every(o=>[0xd0,0x30,0x60,0x2c,0x62,0x56,0x46,0x29,0x45,0x47,0x80,0x48].includes(o.op)));
        dispatches.push({owner:a.name,method:b.method,name:patch.name});
      }else assert.deepEqual(b.code,source.p.bodies.find(s=>s.method===b.method).code,'non-dispatched body changed');
    }
  }
  assert.deepEqual(forbidden,[],'legacy payment/network call survived');
  assert.equal(pair.abcs.length,26);assert.equal(shared.abcs.length,82);assert(shared.abcs.every(a=>!a.name.startsWith('magicWardrobe/')&&!a.name.startsWith('pairBox/')));
  assert.equal(new Set([...pair.abcs,...shared.abcs].flatMap(classes)).size,[...pair.abcs,...shared.abcs].flatMap(classes).length,'duplicate classes');
  const missing=[...dependencies.values()].filter(d=>!d.presentInHost);
  const report={at:new Date().toISOString(),status:'offline structural verification only',source:manifest.source,host:{path:hostPath,sha256:sha(hostBytes),mutated:false},pairOwners:manifest.libraries[1].owners,sharedOwners:manifest.libraries[0].owners,dispatchCount:dispatches.length,dispatches,forbiddenCalls:forbidden,requiredHostClasses:[...dependencies.values()].sort((a,b)=>a.class.localeCompare(b.class)),missingHostClasses:missing,sharedArt:manifest.art.symbols,unverified:['AVM2 verifier/runtime','shared owner ordering in both directions','original window/animation whole-cycle visuals','HTTP UUID effects callbacks and current role identity','current host members and asset dimensions beyond the explicit static lookup adapter'],installed:false};
  if(write)writeFileSync(resolve(out,'offline-audit.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=auditCandidate({outputDir:process.argv[2]});console.log(JSON.stringify({dispatchCount:r.dispatchCount,forbiddenCalls:r.forbiddenCalls,requiredHostClasses:r.requiredHostClasses.length,missingHostClasses:r.missingHostClasses,runtimeValidated:false},null,2));}
