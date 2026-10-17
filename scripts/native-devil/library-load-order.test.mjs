import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import test,{after} from 'node:test';
import {scan,sha} from '../native-pair/build-library.mjs';
import {buildDevilLibrary} from './build-library.mjs';
import {inspectDevilAssets} from './extract-resources.mjs';
import {verifyLibraryLoadOrder} from './audit-candidate.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),project=resolve(repo,'../..');
const prior=resolve(project,'runtime/devil-shop-host-20261016/candidate');
const oldBytes=readFileSync(resolve(prior,'flash/workshop-native/devil/devil-original-library.swf'));
assert.equal(sha(oldBytes),'6ffad9ef68458a9ede5c0283f481e661803da5654079d21847cf3120a3275468');
const old=scan(oldBytes),temp=mkdtempSync(resolve(tmpdir(),'ddt-devil-order-'));
after(()=>{
 const owned=realpathSync(temp);assert.equal(dirname(owned),realpathSync(tmpdir()));assert(basename(owned).startsWith('ddt-devil-order-'));
 rmSync(owned,{recursive:true});
});
const built=buildDevilLibrary({projectRoot:project,out:temp,skinGlue:resolve(prior,'devil-skins.glue.swf'),skins:inspectDevilAssets({projectRoot:project}).skins});
const candidate=scan(readFileSync(resolve(temp,built.file)));
function preserved(lib){
 assert.equal(lib.abcs.length,old.abcs.length);
 assert.deepEqual(lib.abcs.map(a=>a.name).sort(),old.abcs.map(a=>a.name).sort());
 for(const a of lib.abcs){const before=old.abcs.find(x=>x.name===a.name);assert.deepEqual(Buffer.concat([a.prefix,a.abc]),Buffer.concat([before.prefix,before.abc]),a.name);}
 assert.deepEqual(lib.headerPrefix,old.headerPrefix);
 assert.deepEqual(lib.tags.filter(t=>t.code!==82).map(t=>t.raw),old.tags.filter(t=>t.code!==82).map(t=>t.raw));
}

test('load-order gate rejects the frozen purchase popup before its actual support parent',()=>{
 assert.throws(()=>verifyLibraryLoadOrder(old),/DevilTurnShopBuyView must load after .*QuickBuyAlertBase: ABC 37 before 42/);
});

test('actual builder emits every same-library parent before its child',()=>{
 const graph=verifyLibraryLoadOrder(candidate);
 assert.equal(graph.abcCount,43);assert.equal(graph.classCount,57);assert.equal(graph.internalInheritanceEdges.length,12);
 const shop=graph.internalInheritanceEdges.find(e=>e.child.endsWith('::DevilTurnShopBuyView'));assert(shop);
 assert.equal(shop.parent,'workshop.devil.original.host::QuickBuyAlertBase');assert(shop.parentAbc<shop.childAbc);
});

test('reordering preserves every complete ABC payload, non-ABC tag and movie header',()=>{preserved(candidate);});

test('fully compiled candidate preserves its host except the compiler timestamp, and all art',{skip:!process.env.DEVIL_ORDER_CANDIDATE},()=>{
 const area=resolve(process.env.DEVIL_ORDER_CANDIDATE,'flash/workshop-native/devil');
 const full=scan(readFileSync(resolve(area,'devil-original-library.swf')));preserved(full);verifyLibraryLoadOrder(full);
 const host=scan(readFileSync(resolve(area,'WorkshopNativeDevilBootstrap.swf'))),before=scan(readFileSync(resolve(prior,'flash/workshop-native/devil/WorkshopNativeDevilBootstrap.swf')));
 assert.equal(host.sig,before.sig);assert.equal(host.version,before.version);assert.deepEqual(host.headerPrefix,before.headerPrefix);
 assert.deepEqual(host.tags.map(t=>t.code),before.tags.map(t=>t.code));
 for(const [i,tag]of host.tags.entries()){
  const priorTag=before.tags[i];assert.equal(tag.raw.length,priorTag.raw.length);
  // ProductInfo ends in the compiler's 64-bit build date; every other byte is fixed.
  const end=tag.raw.length-(tag.code===41?8:0);assert.equal(sha(tag.raw.subarray(0,end)),sha(priorTag.raw.subarray(0,end)),'host tag '+tag.code);
 }
 for(const file of ['devilturn_v3_6_1_u1.swf','devilturn.ui'])assert.equal(sha(readFileSync(resolve(area,file))),sha(readFileSync(resolve(prior,'flash/workshop-native/devil',file))),file);
});
