import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {ByteReader} from '../../tools/i18n/abc-strings/lib.mjs';
import {scan,q,sha} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';
import {adaptCaveLoot,caveLootOwners} from './build-library.mjs';
import {parseActivityAbc} from '../../tools/i18n/abc-strings/activity-response.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const source=readFileSync(resolve(repo,'scripts/native-caveloot/WorkshopNativeCaveLootBootstrap.as'),'utf8');
const host=scan(readFileSync(resolve(repo,'../../runtime/client-overlay/2.png'))).abcs.find(a=>a.name==='ddt/data/goods/ShopItemInfo');
assert(host,'actual installed host ShopItemInfo');
const constructor=host.p.methods.findIndex(m=>host.p.strings[m.name]==='ddt.data.goods:ShopItemInfo/ShopItemInfo');
const slots=[];
for(const block of host.p.traitBlocks.filter(b=>b.owner!==null)){
 const r=new ByteReader(host.abc);r.pos=block.dataOffset;
 for(let n=block.count;n;n--){const name=r.u30(),kind=r.bytes(1)[0],type=kind&15;
  if(type===0||type===6){r.u30();const slotType=r.u30();if(r.u30())r.bytes(1);slots.push({name:q(host.p,name),type:q(host.p,slotType)});}
  else{r.u30();r.u30();}if(kind&64)for(let k=r.u30();k;k--)r.u30();
 }
}
function method(name){const start=source.indexOf('function '+name+'('),open=source.indexOf('{',start);assert(start>=0,name);let depth=1,end=open+1;for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}return source.slice(open+1,end-1);}
function syncModel(ctx){const code=method('syncModel').replace(/for each\((var )?(\w+)(?::(?:Object|String|\*))? in ([^\n]*?)\)/g,'for($1$2 of $3)').replace(/:(?:Boolean|Object|String|Array|int|Number)\b|:\*/g,'');return new Function('with(this){'+code+'}').call(ctx);}

test('installed ShopItemInfo requires GoodsID and TemplateID integer constructor arguments',()=>{
 assert.equal(sha(host.abc),'f36ff2216315dc712660371a7a9e9833e0c511be0d30d6df566e0e75b98f7972');
 const m=host.p.methods[constructor];assert.deepEqual(m.params.map(n=>q(host.p,n)),['::int','::int']);assert.equal(m.flags&8,0);
 const ops=decode(host.p.bodies.find(b=>b.method===constructor).code).filter(o=>![0xf0,0xf1,0xef].includes(o.op));
 assert.deepEqual(ops.filter(o=>o.op===0x68).map(o=>q(host.p,o.args[0])),['::GoodsID','::TemplateID']);
 assert.deepEqual(ops.slice(-7).map(o=>o.op),[0xd0,0xd1,0x68,0xd0,0xd2,0x68,0x47]);
 for(const name of ['GoodsID','TemplateID','BuyType','AUnit'])assert(slots.some(s=>s.name==='::'+name&&s.type==='::int'));
 assert(!slots.some(s=>s.name==='::personalBuyCnt'));
});

test('normal syncModel builds all eight shop entries using the sealed actual host contract',()=>{
 const calls=[],allowed=new Set(slots.filter(s=>s.name.startsWith('::')).map(s=>s.name.slice(2)));
 const ShopItemInfo=new Proxy(class {},{construct(_,args){assert.equal(args.length,2,'ShopItemInfo expected 2 arguments');args.forEach(n=>assert(Number.isInteger(n)));calls.push(args);const row=Object.fromEntries([...allowed].map(n=>[n,0]));row.GoodsID=args[0];row.TemplateID=args[1];Object.seal(row);return new Proxy(row,{set(target,key,value){assert(allowed.has(key),'unknown sealed host field '+String(key));target[key]=value;return true;}});}});
 const model={},rows=Array.from({length:8},(_,i)=>({tier:Math.floor(i/4)+1,index:i%4,reward:{templateId:11001+i,itemCount:i%2+1},remaining:5-i%4,maxCount:5-i%4,canBuy:true}));
 const projection={available:true,day:'2026-10-16',freeRemaining:3,progressScore:0,personalProgressPercent:0,types:[{coins:0,newDraws:0,rows:[],tier:1},{coins:0,newDraws:0,rows:[],tier:2}],pool:[],progress:[],shop:rows};
 const before=structuredClone(projection),ctx={projection,shopInfos:[],model:()=>model,original:()=>class {},dictionary:()=>({add(key,value){this[key]=value;}}),cls(name){assert.equal(name,'ddt.data.goods.ShopItemInfo');return ShopItemInfo;}};
 syncModel(ctx);
 assert.equal(calls.length,8);assert.deepEqual(ctx.shopInfos.map(x=>x.length),[4,4]);
 rows.forEach(r=>{const info=ctx.shopInfos[r.tier-1][r.index];assert.equal(info.GoodsID,r.tier*10+r.index);assert.equal(info.TemplateID,r.reward.templateId);assert.equal(info.BuyType,1);assert.equal(info.AUnit,r.reward.itemCount);});
 assert.deepEqual(projection,before,'shop limits remain owned by the public projection');
 assert.match(source,/row\.remaining\+"\/5"/);assert.match(source,/o\._max=row\.maxCount/);assert.match(source,/o\.buyBtn\.disabled=!row\.canBuy\|\|pending\|\|busy/);
});

test('compiled syncModel supplies two arguments and never writes the absent personalBuyCnt field',{skip:!process.env.CAVELOOT_CANDIDATE},()=>{
 const a=scan(readFileSync(resolve(process.env.CAVELOOT_CANDIDATE,'flash/workshop-native/caveloot/WorkshopNativeCaveLootBootstrap.swf'))).abcs[0];
 const t=a.p.methodTraits.find(t=>a.p.strings[a.p.names[t.name]?.name]==='syncModel'),ops=decode(a.p.bodies.find(b=>b.method===t.method).code);
 assert.equal(ops.filter(o=>o.op===0x42).at(-1).args[0],2);
 assert(!ops.some(o=>[0x61,0x68].includes(o.op)&&q(a.p,o.args[0])==='::personalBuyCnt'));
});

test('original protected Morn override hooks retain the actual shared Component ABI',()=>{
 const original=scan(readFileSync(resolve(repo,'../../runtime/reference-activities-completion-20261014/reference-core/2_v3_6_1_u9.png')));
 const journal=JSON.parse(readFileSync(resolve(repo,'../../runtime/client-overlay-literals.json')));
 const shared=scan(readFileSync(journal.nativeWardrobe.assets.find(x=>x.target.replaceAll('\\','/').endsWith('/shared/native-shared-library.swf')).target));
 const component=shared.abcs.find(a=>a.name==='morn/core/components/Component');assert(component);
 const protectedHooks=new Set(component.p.methodTraits.filter(t=>component.p.namespaces[component.p.names[t.name].ns]?.kind===24).map(t=>component.p.strings[component.p.names[t.name].name]));
 const compiled=process.env.CAVELOOT_CANDIDATE?scan(readFileSync(resolve(process.env.CAVELOOT_CANDIDATE,'flash/workshop-native/caveloot/caveloot-original-library.swf'))):null;
 for(const name of ['createChildren','initialize'])assert(protectedHooks.has(name));
 let checked=0;
 for(const a of original.abcs.filter(a=>caveLootOwners.includes(a.name))){const p=parseActivityAbc(adaptCaveLoot(a).bytes);
  for(const trait of a.p.methodTraits.filter(t=>(t.kind&32)&&a.p.namespaces[a.p.names[t.name].ns]?.kind===24)){
   const name=a.p.strings[a.p.names[trait.name].name];assert(protectedHooks.has(name),'actual Component inherited hook '+name);
   const adapted=p.methodTraits.find(t=>t.method===trait.method);assert.equal(adapted.kind,trait.kind);
   assert.equal(p.namespaces[p.names[adapted.name].ns].kind,24,a.name+'.'+name+' must stay protected');
   assert.equal(q(p,adapted.name),q(a.p,trait.name).replace(/^caveloot/,'workshop.caveloot.original'));checked++;
   if(compiled){const actual=compiled.abcs.find(x=>x.name===a.name),t=actual.p.methodTraits.find(t=>t.method===trait.method);assert.equal(t.kind,trait.kind);assert.equal(actual.p.namespaces[actual.p.names[t.name].ns].kind,24);assert.equal(q(actual.p,t.name),q(p,adapted.name));}
  }
 }
 assert.equal(checked,32);
});

test('all normal original class lookups match actual compiled library instance and script exports',{skip:!process.env.CAVELOOT_CANDIDATE},()=>{
 const lib=scan(readFileSync(resolve(process.env.CAVELOOT_CANDIDATE,'flash/workshop-native/caveloot/caveloot-original-library.swf'))),names=new Set(lib.abcs.flatMap(a=>a.p.traitBlocks.filter(t=>t.owner!==null).map(t=>q(a.p,t.owner).replace('::','.'))));
 const lookups=[...new Set([...source.matchAll(/original\("([^"]+)"\)/g)].map(m=>m[1]))];
 for(const name of ['CaveLootMineView','CaveLootShopView','CaveLootProgressView','CaveLootRankView'])lookups.push('view.'+name);
 for(const name of lookups)assert(names.has('workshop.caveloot.original.'+name),'original lookup '+name);
 assert.match(method('constructWindow'),/original\("view\.CaveLootMainView"\)/);
 for(const a of lib.abcs.filter(a=>caveLootOwners.includes(a.name))){const exported=a.p.traitBlocks.filter(b=>b.owner===null&&b.count===1).map(block=>{const r=new ByteReader(a.abc);r.pos=block.dataOffset;return {name:r.u30(),kind:r.bytes(1)[0]};}).find(t=>(t.kind&15)===4);assert(exported,'script class trait '+a.name);assert(names.has(q(a.p,exported.name).replace('::','.')),'actual public class export '+a.name);assert.equal(a.p.namespaces[a.p.names[exported.name].ns].kind,22);}
});
