import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {ByteReader,buildTag,compressSwf,decompressSwf,encodeU30,parseTags} from '../../tools/i18n/abc-strings/lib.mjs';
import {parseActivityAbc} from '../../tools/i18n/abc-strings/activity-response.mjs';
import {adaptPageNavigaterDisposal} from '../native-shared/build-library.mjs';

export const sha=b=>createHash('sha256').update(b).digest('hex');
export const q=(p,i)=>{const n=p.names[i];return n?`${p.strings[p.namespaces[n.ns]?.name]??''}::${p.strings[n.name]??''}`:'';};
export function scan(bytes){const swf=decompressSwf(bytes);assert.equal(swf.error,null);const parsed=parseTags(swf.body);assert.equal(parsed.trailing.length,0);return {...swf,...parsed,abcs:parsed.tags.filter(t=>t.code===82).map(t=>{const r=new ByteReader(swf.body.subarray(t.bodyStart,t.bodyEnd));r.u32();const name=r.cstring(),prefix=r.buf.subarray(0,r.pos),abc=r.buf.subarray(r.pos);return{name,prefix,abc,p:parseActivityAbc(abc)};})};}
export function pinned(path,hash){const b=readFileSync(path);assert.equal(sha(b),hash,`input changed: ${path}`);return b;}
const business=new Set(['pairBox/PairBoxManager','pairBox/item/PairBoxShopItem','pairBox/view/PairBoxCardView','pairBox/view/PairBoxMainView','pairBox/view/PairBoxOneKeyAlert','pairBox/view/PairBoxOneKeyRewardView','pairBox/view/PairBoxReelBuyView','pairBox/view/PairBoxShopAlert','pairBox/view/PairBoxShopView']);

// Whole method replacement: no byte-search edits, no branches into the old paid/socket path.
export function adapt(a){
  if(a.name==='pairBox/item/PairBoxRewardPoolItem'){
    const replacements=new Map([['ItemManager','WorkshopNativePairBootstrap'],['ddt.manager',''],['fillByID','fillInventory']]);
    const managerNs=a.p.namespaces.findIndex(n=>n&&a.p.strings[n.name]==='ddt.manager');assert(managerNs>0);
    assert.deepEqual(a.p.names.filter(n=>n&&n.ns===managerNs).map(n=>a.p.strings[n.name]),['ItemManager'],'shared namespace must belong only to this lookup');
    const strings=a.p.strings.map(s=>replacements.get(s)??s);
    for(const from of replacements.keys())assert.equal(a.p.strings.filter(s=>s===from).length,1);
    const bytes=Buffer.concat([a.abc.subarray(0,a.p.stringDataOffset),...strings.slice(1).flatMap(s=>{const b=Buffer.from(s);return[encodeU30(b.length),b];}),a.abc.subarray(a.p.stringPoolEnd)]);
    const checked=parseActivityAbc(bytes);for(const b of a.p.bodies)assert.deepEqual(checked.bodies.find(x=>x.method===b.method).code,b.code);
    return {bytes,changes:[{kind:'module-only ItemManager.fillByID to WorkshopNativePairBootstrap.fillInventory',allMethodBodiesUnchanged:true}]};
  }
  if(!business.has(a.name))return {bytes:a.abc,changes:[]};
  let p=a.p;const strings=[...p.strings],added=[];
  const str=s=>{let i=strings.indexOf(s);if(i<0){i=strings.length;strings.push(s);added.push(s);}return i;};
  const helper=str('WorkshopNativePairBootstrap'),dispatch=str('dispatch'),owner=str(a.name);
  const targets=p.methodTraits.filter(t=>t.owner!=null && !(a.name==='pairBox/PairBoxManager'&&['instance','model'].includes(p.strings[p.names[t.name].name])));
  for(const t of targets)str(p.strings[p.names[t.name].name]);
  const pub=p.namespaces.findIndex(ns=>ns?.kind===0x16 && p.strings[ns.name]==='');assert(pub>0,'public namespace');
  const helperQ=p.names.length,dispatchQ=helperQ+1;
  const pools=Buffer.concat([a.abc.subarray(0,p.stringCountOffset),encodeU30(strings.length),...strings.slice(1).flatMap(s=>{const b=Buffer.from(s);return[encodeU30(b.length),b];}),a.abc.subarray(p.stringPoolEnd,p.nameCountOffset),encodeU30(p.names.length+2),a.abc.subarray(p.nameDataOffset,p.namePoolEnd),Buffer.from([7]),encodeU30(pub),encodeU30(helper),Buffer.from([7]),encodeU30(pub),encodeU30(dispatch),a.abc.subarray(p.namePoolEnd)]);
  p=parseActivityAbc(pools);const changes=[],replacements=[];
  for(const t of targets){
    const b=p.bodies.find(b=>b.method===t.method);assert(b);const m=p.methods[t.method],name=p.strings[p.names[t.name].name],code=[];
    const op=(v,...args)=>code.push(Buffer.from([v]),...args.map(encodeU30));
    op(0xd0);op(0x30);op(0x60,helperQ);op(0x2c,owner);op(0x2c,str(name));op(0xd0);
    for(let i=1;i<=m.params.length;i++)op(0x62,i);op(0x56,m.params.length);op(0x46,dispatchQ,4);
    if(q(p,m.returnType)==='::void'){
      op(0x29);
      // Morn owns recursive disposal. Run its existing superclass method exactly once.
      if(name==='dispose'){
        const superQ=p.names.findIndex((n,i)=>q(p,i)==='morn.core.components:Component::dispose');
        const publicDispose=p.names.findIndex((n,i)=>q(p,i)==='::dispose');
        assert(superQ>0||publicDispose>0);op(0xd0);op(0x45,superQ>0?superQ:publicDispose,0);op(0x29);
      }
      op(0x47);
    }else{if(m.returnType)op(0x80,m.returnType);op(0x48);}
    const bytes=Buffer.concat(code),body=Buffer.concat([encodeU30(b.method),encodeU30(Math.max(6,4+m.params.length)),encodeU30(Math.max(1+m.params.length,b.localCount)),encodeU30(b.initialScope),encodeU30(b.initialScope+1),encodeU30(bytes.length),bytes,encodeU30(0),encodeU30(0)]);
    replacements.push({start:b.start,end:b.end,bytes:body});changes.push({method:t.method,name,oldCodeSha256:sha(b.code),newCodeSha256:sha(bytes),oldExceptions:b.exceptions,newExceptions:0,dispatch:true});
  }
  replacements.sort((a,b)=>a.start-b.start);let at=0;const out=[];for(const r of replacements){out.push(pools.subarray(at,r.start),r.bytes);at=r.end;}out.push(pools.subarray(at));const bytes=Buffer.concat(out),check=parseActivityAbc(bytes);
  assert.equal(check.methods.length,a.p.methods.length);assert.equal(check.bodies.length,a.p.bodies.length);
  for(const old of a.p.bodies)if(!changes.some(c=>c.method===old.method))assert.deepEqual(check.bodies.find(b=>b.method===old.method).code,old.code,'unselected method changed');
  return {bytes,changes};
}

export function buildLibraries({projectRoot,out}){
  const A=resolve(projectRoot,'runtime/reference-activities-completion-20261014');
  const original=pinned(resolve(A,'reference-core/2_v3_6_1_u9.png'),'af361678887e2413efe54e6cd86d37426cc6724ea964080178eea4816a785ae4');
  const core=scan(original),contract=JSON.parse(readFileSync(resolve(A,'pairbox-native-analysis/migration-contract.json'),'utf8'));
  const existing=pinned(resolve(A,'magicwardrobe-native-candidate/magicwardrobe-original-library.swf'),'ad3151811f44d99570ae10b13a219c290aa97ed42d131df2c1ec5bf2b3cf8bc5');
  const shared=scan(existing).abcs.filter(a=>!a.name.startsWith('magicWardrobe/'));assert.equal(shared.length,82);
  const pair=contract.originalActivityClasses.map(c=>{const a=core.abcs.find(a=>a.name===c.abc);assert(a);assert.equal(sha(a.abc),c.abcSha256);return a;});assert.equal(pair.length,26);
  // Original UI shell classes precede their subclasses; all other pair references are lazy.
  pair.sort((a,b)=>Number(!a.name.includes('/morn/'))-Number(!b.name.includes('/morn/')));
  const attr=core.tags.find(t=>t.code===69).raw,header=Buffer.from(core.headerPrefix);header.writeUInt16LE(1,header.length-2);
  const result=[];
  for(const [file,owners,patch] of [['pair-shared-library.swf',shared,false],['pair-original-library.swf',pair,true]]){
    const entries=owners.map(a=>{const r=patch?adapt(a):adaptPageNavigaterDisposal({...a,owner:a.name});return{...a,bytes:r.bytes,changes:r.changes};});
    const bytes=compressSwf('CWS',15,Buffer.concat([header,attr,...entries.map(a=>buildTag(82,Buffer.concat([a.prefix,a.bytes]))),buildTag(1,Buffer.alloc(0)),buildTag(0,Buffer.alloc(0))]));
    assert.equal(scan(bytes).abcs.length,owners.length);writeFileSync(resolve(out,file),bytes,{flag:'wx'});
    result.push({file,bytes:bytes.length,sha256:sha(bytes),owners:entries.map(a=>({owner:a.name,originalAbcSha256:sha(a.abc),abcSha256:sha(a.bytes),changes:a.changes}))});
  }
  return result;
}
